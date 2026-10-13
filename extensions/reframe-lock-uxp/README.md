# Reframe Lock (UXP)

Adobe Premiere Pro UXP-Plugin. Es friert den Bildausschnitt ein, den **Auto
Reframe** gewählt hat, und entfernt dabei die Restbewegung, die auf
Stativaufnahmen als „Wackeln" sichtbar wird.

**Erfordert Premiere Pro 25.6 oder neuer** (UXP-Unterstützung).

## Das Problem

Eine statisch gefilmte 16:9-Aufnahme wird mit Auto Reframe auf 1:1 oder 9:16
gebracht. Auto Reframe erkennt das Motiv richtig, verschiebt den Ausschnitt
dann aber permanent ein wenig mit — der Hintergrund driftet, obwohl die Kamera
nie bewegt wurde. Gewünscht ist: derselbe Ausschnitt, aber so still wie das
16:9-Original.

## Der Ansatz

Das Plugin schreibt **keinen einzigen Auto-Reframe-Parameter**. Stattdessen:

| Schritt | Was passiert |
|---|---|
| **1. Messen** | Die angewandte Transformation des Effekts wird über die Clipdauer abgetastet. Ergebnis: die Drift in Zahlen. |
| **2. Kalibrieren** | Das Koordinatensystem des Effekts wird *gemessen*, nicht angenommen (siehe unten). Ist es unbestimmbar, wird nichts geschrieben. |
| **3. Wählen** | Ein Frame-Wert wird ausgewählt — standardmäßig der Abtastpunkt, der dem Median des gesamten Pfads am nächsten liegt. |
| **4. Einbacken** | Dieser Wert wird als statische Transformation in den **Motion**-Effekt des Clips geschrieben, und Auto Reframe verlässt die Effektkette. |
| **5. Nachprüfen** | Alles wird neu gelesen und gegen den Plan verglichen. |

Danach gibt es keinen Effekt mehr, der etwas animieren könnte. Das Ergebnis ist
genau das Gewünschte: der von Auto Reframe gewählte Ausschnitt, gehalten von
einer gewöhnlichen statischen Transformation.

### Warum nicht der bekannte Weg?

Der verbreitete manuelle Trick — „Erzeugten Pfad überschreiben" aktivieren und
den Positionsparameter auf einen einzigen Keyframe reduzieren — funktioniert
über die UXP-API nicht. Die Keyframe-Übertragung, auf der er beruht, ist ein
**Seiteneffekt des Klicks auf die Checkbox**, nicht des Parameterwerts. Setzt
man den Wert programmatisch, bleibt der bearbeitbare Parameter leer, der Effekt
rechnet seine Ausgabe weiter und überschreibt jeden hineingeschriebenen Wert
kurz darauf wieder. Dagegen anzurennen führt zu Wiederholungsschleifen, die mit
dem Host um Zeit rennen und trotzdem kein Ergebnis garantieren können.

Daraus folgt der Entwurf oben: nicht gegen den Effekt arbeiten, sondern seine
Entscheidung auslesen und ihn danach aus dem Weg nehmen.

### Vorteile

- **Kein Wettlauf mit dem Host.** Nichts, was zurückgeschrieben werden könnte.
- **Ein Undo-Schritt** für den gesamten Lauf, egal wie viele Clips.
- **Deterministisch** — keine Wartezeiten, keine Wiederholungsdurchläufe.
- **Schnellere Wiedergabe**, weil der KI-Effekt vom Clip verschwindet.
- **Nachvollziehbar**: Das Ergebnis steht als lesbarer Zahlenwert in den
  Effektoptionen unter „Bewegung".

## Kein Format ist fest eingebaut

Beide Rechtecke werden zur Laufzeit **gemessen**:

- **Sequenzformat** aus `SequenceSettings.getVideoFrameRect()`.
- **Quellformat** je Clip aus den Medien-Metadaten
  (`Column.Intrinsic.VideoInfo`), inklusive **Pixel-Seitenverhältnis** aus der
  Footage-Interpretation — sonst würde anamorphes Material falsch eingeordnet.

Quadratisch, Hochformat, 4:3, 2.39:1, anamorph oder eine Hochkant-Quelle in
einer Breitbild-Sequenz laufen alle durch denselben Code. Es gibt keine
16:9-Konstante, keinen 1:1-Zweig und keinen 9:16-Zweig.

### Wie die Kalibrierung ohne Annahme funktioniert

Auto Reframe meldet seine Position in einer Einheit, die Adobe nicht
dokumentiert. Motion erwartet normierte 0–1-Werte mit (0,5 / 0,5) als
Bildmitte. Raten würde einen stillschweigend falschen Ausschnitt bedeuten —
also wird gemessen, über eine Eigenschaft, die für **jedes** Formatpaar gilt:

> Ein formatfüllender Ausschnitt hat Spielraum auf **genau einer** Achse. Die
> andere Dimension passt exakt, dort ist der Ausschnitt zwangsläufig
> mittig — und welcher Wert dort gemeldet wird, verrät die Einheit.

Welche Achse das ist, folgt aus den beiden gemessenen Seitenverhältnissen:

```
Quelle breiter als Sequenz  ->  vertikal liegt fest
Quelle höher  als Sequenz   ->  horizontal liegt fest
gleiches Seitenverhältnis   ->  beide liegen fest
```

Und auf der festliegenden Achse gilt:

```
gemeldet ~0,5        ->  gleiche Normierung wie Motion   (1:1 übernehmen)
gemeldet ~0          ->  Versatz zur Bildmitte           (+0,5)
gemeldet ~Länge/2    ->  absolute Pixel                  (teilen)
etwas anderes        ->  unbestimmt, es wird nichts geschrieben
```

Drei weitere **unabhängige Prüfungen** stimmen darüber ab:

1. **Ankerpunkt** des Effekts — liegt per Definition in der Mitte, und zwar
   ohne jedes Formatwissen.
2. **Füllskalierung** — die aus den beiden gemessenen Rechtecken berechnete
   Skalierung wird mit der gemeldeten verglichen. Stimmen sie, rechnet der
   Effekt in denselben Einheiten wie Motion.
3. **Bereichs-Falsifikation** — jede Konvention, unter der der Ausschnitt
   teilweise außerhalb des Quellbildes läge, ist widerlegt. Diese Prüfung kann
   eine Hypothese *ausschließen*, nicht nur bewerten, und sticht daher die
   Abstimmung.

Übereinstimmung erhöht das Vertrauen (`gegengeprüft`), Widerspruch senkt es
(`mehrdeutig`, `schwach`), keine Prüfung bedeutet `unbestimmt`. **Unterhalb von
„gemessen" wird standardmäßig nichts geschrieben** — eine um eine halbe
Bildbreite verschobene Framing-Entscheidung würde sonst erst beim Durchscrubben
jedes Clips auffallen.

## Nutzung

1. Clips in der Timeline auswählen.
2. **Bearbeiten:** Auswahl · ganze Spur der Auswahl · alle Videospuren.
3. **Welcher Bildausschnitt bleibt:**
   - **Median (Voreinstellung)** — robuster Mittelpunkt des Zitterns. Bei einem
     Ausreißer-Frame zieht der arithmetische Mittelwert mit, der Median nicht.
     Geschrieben wird immer ein **echter Abtastpunkt**, also ein Ausschnitt, den
     Auto Reframe selbst gewählt hat — niemals ein interpolierter Wert.
   - Anfang · zeitliche Mitte · Ende · Abspielposition · Mittelwert.
4. **Dry-Run ist voreingestellt.** Er misst alles und zeigt den vollständigen
   Plan, ohne zu schreiben.
5. Dry-Run abwählen und „Ausführen".

### Optionen

| Option | Bedeutung |
|---|---|
| Auto Reframe danach entfernen | Standard. Alternative: nur deaktivieren, Effektdaten bleiben erhalten. |
| Skalierung mit einfrieren | Übernimmt zusätzlich die Skalierung des Effekts. |
| Drehung mit einfrieren | Für Material, bei dem Auto Reframe auch dreht. |
| Ausführliches Log | Parameter-Dumps und die gemessene Bewegungskurve. |
| Vorhandene Motion-Werte überschreiben | Nötig, wenn der Clip schon eine eigene Transformation hat. |
| Unsichere Kalibrierung zulassen | Hebt die Sperre bei schwachem Messergebnis auf. |

### Schutzmechanismen

Das Plugin verweigert die Arbeit, statt zu raten, wenn:

- das Koordinatensystem unbestimmbar ist,
- die Kalibrierung nur schwach oder mehrdeutig belegt ist,
- der Motion-Effekt des Clips nicht auf Standardwerten steht oder eigene
  Keyframes hat,
- ein Parameter Keyframes meldet, über die Zeit aber immer denselben Wert
  liefert (dann gibt die API den Pfad nicht heraus — etwas anderes als „kein
  Wackeln"),
- die Nachprüfung nach dem Schreiben nicht aufgeht.

Clips ohne messbare Bewegung werden übersprungen und bleiben unangetastet.

## Debugging auf einem fremden Rechner

Dafür ist der Report gebaut. **Log kopieren** oder **Log speichern…** liefert
eine in sich geschlossene JSON-Datei mit:

- Zeitstempel, Plugin-Version, Report-Schema, Laufdauer,
- Host-Infos: Premiere-Version, UXP-Version, **UI-Sprache** (entscheidend, weil
  Parameternamen lokalisiert sind),
- allen verwendeten Optionen,
- Sequenzformat und je Clip das gemessene Quellformat samt Herkunft der Angabe,
- je Clip: Drift in Pixeln und Prozent, Kalibrierungsergebnis mit allen
  Prüfungen und Stimmen, gewählter Referenz-Frame, Schreibplan,
  Nachprüfungsergebnis,
- bei „Ausführliches Log" zusätzlich den vollständigen Parameter-Dump beider
  Effekte und die abgetastete Bewegungskurve.

Empfohlener Ablauf beim Kunden: **Dry-Run mit ausführlichem Log**, Log
speichern, Datei schicken. Darin steht alles, was zur Diagnose nötig ist — es
wurde dabei nichts verändert.

Die Build-Nummer steht unten im Panel. Weicht sie von der erwarteten ab, läuft
noch alter Code: UXP cached geladene Module, ein „Reload" im Developer Tool
genügt dann nicht.

## Entwicklung

```bash
npm install
npm run check     # eslint + alle Tests
```

### Teststruktur

| Datei | Was belegt wird | Abhängigkeit |
|---|---|---|
| `test/geometry.test.js` | 63 Tests: Formatgeometrie, Kalibrierungslogik, Referenzwahl, Metadaten-Parsing | **keine** — reine Arithmetik |
| `test/core.test.js` | 43 Tests gegen eine gemockte Premiere-API | Mock |
| `test/consistency.test.js` | dateiübergreifende Konsistenz: Manifest ↔ Entrypoint, HTML-IDs ↔ Verdrahtung, Picker-Werte ↔ Whitelists, kein `await`/`throw` in der Transaktion, Reinheit der mockfreien Module | statisch |

Die Trennung ist Absicht. Mock-Tests können nur belegen, „der Algorithmus
entscheidet X, wenn der gefälschte Host Y meldet". Die reinen Tests belegen die
Mathematik selbst — und das ist die Hälfte, die sonst allein auf sorgfältigem
Lesen beruhen würde. Deshalb liegen Geometrie, Kalibrierung und Parsing in
Modulen, die Premiere nicht importieren; `test/consistency.test.js` erzwingt
das.

Der Mock ist ein **Zustandsautomat**: Actions werden beim Commit wirklich
angewandt, ein entfernter Effekt verschwindet wirklich aus der Kette, und ein
Parameter kann einen Schreibvorgang verwerfen. Dadurch lässt sich der
Endzustand prüfen und nicht bloß die Absicht — der einzige Weg, den Fehlerfall
„meldet Erfolg, hat aber nichts geändert" zu erwischen. Er modelliert außerdem
den Parameter, dessen Wert sich über die Zeit ändert, obwohl
`isTimeVarying()` false meldet und keine Keyframes existieren: genau der
Zustand, in dem ein keyframe-orientierter Ansatz nichts findet.

### Aufbau

```
reframe-lock-uxp/
├── manifest.json        # UXP-Manifest (v5, premierepro >= 25.6.0)
├── index.html           # Panel-UI (Spectrum UXP Widgets)
├── main.js              # nur Panel-Verdrahtung, kein Algorithmus
├── style.css
├── src/
│   ├── core.js          # Ablauf: messen -> planen -> eine Transaktion -> prüfen
│   ├── geometry.js      # Formatgeometrie + Kalibrierung       (ohne Premiere)
│   ├── mediainfo.js     # Quellformat aus Metadaten            (ohne Premiere)
│   ├── premiere.js      # Leseschicht; erzeugt niemals Actions
│   ├── logger.js        # strukturiertes Log                   (ohne Premiere)
│   └── report.js        # Darstellung + JSON-Export            (ohne Premiere)
└── test/
```

### Architekturregeln

Erzwungen von Adobes `@adobe/eslint-plugin-premierepro`:

- `create*Action()` nur in `lockedAccess()` / `executeTransaction()`
- `addAction()` nur in `executeTransaction()`
- kein `async`/`await` in diesen Callbacks
- Action-Objekte dürfen den Lock-Scope nicht verlassen

Daraus folgt die strikte Phasentrennung: alles Asynchrone passiert vor der
Transaktion, die Transaktion selbst ist synchron und **inline** geschrieben
(die Regeln prüfen lexikalische Verschachtelung und können Indirektion über
Hilfsfunktionen nicht verfolgen), und aus ihr wird nichts geworfen — Probleme
werden gesammelt und nach dem Lock gemeldet, damit Premiere Transaktion und
Lock regulär abräumt. Innerhalb der Transaktion werden Komponenten und
Parameter frisch aus einer unmittelbar vorher neu geholten Effektkette
gelesen, weil Premiere 26.3 Script-Objekte invalidiert, die
Async-Grenzen überschreiten.

### Minimale Rechte

| Berechtigung | Wofür |
|---|---|
| `clipboard: readAndWrite` | Button „Log kopieren". UXP kennt keine Schreib-only-Stufe; gelesen wird nie. |
| `localFileSystem: request` | Button „Log speichern…" — nur die Datei, die der Nutzer im Dialog wählt. |

Nicht angefordert: Netzwerk, `fullAccess`, Prozessstart, Webview, IPC. Der
Kernalgorithmus braucht keine Berechtigung.

## Stand und offene Punkte

**Nicht gegen eine laufende Premiere-Instanz getestet** — in dieser Umgebung
war keine verfügbar. Verifiziert sind: ESLint inklusive Adobes
Premiere-Regeln (0 Probleme), 106 Tests, `node --check` auf allen Dateien,
Manifest-Konsistenz, und jeder API-Aufruf gegen die TypeScript-Definitionen
aus `@adobe/premierepro` 26.5.0.

Was die Tests belegen, ist die Entscheidungs- und Rechenlogik. Was sie **nicht**
belegen können:

- **Die Koordinatenkonvention von Auto Reframe.** Genau deshalb wird sie zur
  Laufzeit gemessen statt angenommen, mit Verweigerung im Zweifelsfall. Der
  erste Dry-Run auf echtem Material ist der entscheidende Test; das
  Kalibrierungsergebnis steht im Report.
- **Das Serialisierungsformat von `getProjectColumnsMetadata()`.** Es ist nicht
  dokumentiert. Der Parser kommt mit XML, JSON und Rohtext zurecht und meldet,
  wie er zu seinem Ergebnis kam; schlägt er fehl, fällt die Kalibrierung auf
  ihre formatfreien Prüfungen zurück.
- **Die Parameter-Indizes als Rückfallebene.** Namen werden zuerst versucht,
  Indizes nur danach, und das Ergebnis wird immer typgeprüft. Ein verändertes
  Layout erzeugt damit einen klaren Fehler statt eines falschen Schreibvorgangs.
- **Ob Motion und Auto Reframe exakt dieselbe Bildgeometrie erzeugen.** Die
  Füllskalierungs-Prüfung ist das stärkste verfügbare Indiz dafür und steht im
  Report.
