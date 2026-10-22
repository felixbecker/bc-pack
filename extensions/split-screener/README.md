# Split Screener

UXP-Plugin für Adobe Premiere Pro (ab 25.6). Macht aus zwei deckungsgleichen
Clips auf verschiedenen Videospuren einen 50/50-Splitscreen — nebeneinander
oder übereinander — und entfernt ihn verlustfrei wieder.

Wie die Umsetzung im Detail funktioniert, inklusive Ablaufdiagramm,
Design-Entscheidungen und Sonderfällen: [IMPLEMENTATION.md](IMPLEMENTATION.md).

## Installation

```bash
npm install
```

Zum Entwickeln den Ordner im **UXP Developer Tool** als Plugin hinzufügen
(`manifest.json` auswählen) und laden. Premiere muss laufen.

```bash
npm run lint   # ESLint inkl. Adobes Premiere-Regeln
npm test       # Unit-Tests der Geometrie- und Regel-Logik
```

## Nutzung

1. Zwei Clips auf verschiedenen Videospuren übereinander legen, sodass sie
   **exakt** gleich beginnen und enden.
2. Beide Clips in der Timeline auswählen. Mehrere Paare gleichzeitig sind
   erlaubt — jedes Paar wird einzeln verarbeitet.
3. Anordnung wählen, optional „Clips tauschen", und **Splitscreen erstellen**.

Der Clip auf der niedrigeren Spur kommt nach links bzw. oben. „Clips tauschen"
kehrt das um.

„Dry-Run" ist standardmäßig aktiv und zeigt alle Werte, die geschrieben würden,
ohne das Projekt anzufassen. Für die echte Ausführung abwählen.

Nach jedem Lauf lässt sich das Ergebnis über „Log kopieren" oder „Log
speichern…" exportieren — siehe Diagnose und Log-Export.

## Wie es funktioniert

Pro Clip werden zwei Standard-Effekte **hinter alle vorhandenen Effekte**
gehängt:

```
[ Nutzer-Effekte: Auto Reframe, Lumetri, eigener Beschnitt … ]
   → Transformieren   (verschiebt das Bild in seine Hälfte)
   → Zuschneiden      (schneidet die Hälfte heraus)
```

Das ist die **Render-Reihenfolge**. In der Component-Chain der API stehen die
beiden Effekte umgekehrt und am Anfang des Standard-Blocks, weil die Chain
gegenläufig zur Render-Reihenfolge läuft — Details in
[IMPLEMENTATION.md](IMPLEMENTATION.md).

Weil beide Effekte hinter allem sitzen, ist egal, was davor passiert: Auto
Reframe, Farbkorrektur oder ein von Hand gesetzter Beschnitt sind für uns
einfach „der aktuelle Look", von dem die Mitte genommen wird. **Auto-reframte
Clips brauchen deshalb keinen eigenen Codepfad.**

Bei unangetasteter Bewegung ergibt das:

| Zelle | Zuschneiden | Transformieren · Position |
|---|---|---|
| links | Rechts 50 % | (0,25·B; 0,50·H) |
| rechts | Links 50 % | (0,75·B; 0,50·H) |
| oben | Unten 50 % | (0,50·B; 0,25·H) |
| unten | Oben 50 % | (0,50·B; 0,75·H) |

Hat ein Clip bereits eigene Bewegungs-Werte — etwa einen Punch-In auf 120 % —
bleiben diese erhalten und werden herausgerechnet, damit die Hälfte trotzdem
sitzt:

```
Transform-Position = Framemitte + Standardversatz / Skalierung
Crop-Fenster       = Framemitte + (Zielzelle − Bewegungsposition) / Skalierung
```

Die Bewegungsposition fällt beim Transform-Versatz heraus und wirkt nur auf das
Crop-Fenster. Beide Achsen werden getrennt gerechnet, „Gleichmäßig skalieren"
darf also aus sein.

## Entfernen

**Splitscreen entfernen** löscht ausschließlich die beiden von diesem Plugin
eingefügten Effekte von den selektierten Clips. Der Zustand davor wird exakt
wiederhergestellt — im Normalfall also 100 %, mittig, Clips übereinander. Ein
vorhandener Punch-In, Auto Reframe oder ein eigener Beschnitt bleiben erhalten,
weil sie nie verändert wurden.

Erkennung: unsere beiden Effekte sind ein **direkt benachbartes Paar**
Transformieren → Zuschneiden unter den Standard-Effekten; gibt es mehrere, wird
das letzte angesprochen. Absichtlich nicht „die letzten zwei der Kette":
„Splitscreen bauen, danach Lumetri drauf" ist Alltag, und würde das Plugin sein
eigenes Paar dann nicht mehr erkennen, hängte der nächste Lauf ein zweites an —
das Bild würde zweimal verschoben und zweimal halbiert, und das lässt sich mit
dem Plugin nicht mehr reparieren. Der Preis ist der umgekehrte Fall: wer von
Hand ein Transformieren direkt gefolgt von einem Zuschneiden anlegt, bekommt es
als Splitscreen erkannt. Das ist die bewusst gewählte, weniger zerstörerische
Seite des Tauschs.

Lesefehler beim Entfernen betreffen nur den jeweiligen Clip und werden im
Report gemeldet; die übrigen Clips werden trotzdem aufgeräumt. Anders als beim
Erstellen gibt es hier also keine all-or-nothing-Vorprüfung — es gibt auch
nichts zu validieren.

## Vorprüfung

Erst wird alles geprüft, dann geschrieben. Schlägt eine Regel an, wird **nichts**
geändert, und der Report listet alle Gründe auf:

- weniger als zwei Video-Clips ausgewählt
- ein Clip ohne deckungsgleichen Partner (Start und Ende müssen tick-genau
  übereinstimmen, keine Toleranz)
- Start- oder Endzeit eines Clips nicht lesbar
- drei oder mehr deckungsgleiche Clips an einer Stelle
- zwei deckungsgleiche Clips auf derselben Spur
- gedrehter Clip oder verschobener Ankerpunkt (ein gerader Beschnitt kann ein
  gedrehtes Bild nicht korrekt halbieren)
- Keyframes auf Position, Skalierung, Drehung oder Ankerpunkt. Drehung und
  Ankerpunkt werden auch auf Keyframes geprüft, nicht nur auf ihren Wert — ein
  Clip, der im abgetasteten Frame zufällig bei 0° steht und wegdreht, würde die
  reine Wertprüfung sonst passieren.
- ein Parameter des Bewegungs-Effekts nicht gefunden oder nicht lesbar — die
  Meldung nennt ihn. Hier wird absichtlich nicht auf einen Standardwert
  ausgewichen: eine unerkannte „Drehung" würde als 0° gelesen und damit genau
  die Prüfung aushebeln, die gedrehte Clips abfangen soll.
- Effektkette eines Clips nicht lesbar. Das ist ausdrücklich *nicht* dasselbe
  wie „kein Video-Clip": wir konnten nicht hinsehen, also darf der Clip nicht
  still übergangen werden.
- Clip auf 25 % oder weniger skaliert, sodass er nicht in seine Hälfte
  verschoben werden kann (siehe Grenzen)

Audio-Clips in der Auswahl werden ignoriert, Audio bleibt vollständig
unangetastet.

## Grenzen

- **Genau zwei Clips pro Splitscreen**, immer 50/50.
- **Verkleinerte Clips** liefern zu wenig Bild für ihre Hälfte; es bleibt ein
  schwarzer Rand. Der Report weist darauf hin. Bei 25 % Skalierung oder weniger
  bricht der Lauf ab, weil unser Transformieren vor der Bewegung sitzt und das
  Bild um ¼ Frame ÷ Skalierung verschieben müsste — das schiebt es komplett aus
  dem Frame, wo es verworfen wird, bevor die Bewegung es zurückskalieren könnte.
- Keine Trennlinien, Rahmen, Animation, ungleiche Aufteilung, kein 2×2-Grid,
  kein Nesting.

## Rückgängig

Erstes Anwenden auf frische Clips sind zwei Undo-Schritte („Effekte einfügen",
„Splitscreen anwenden"). Erneutes Anwenden und Entfernen sind jeweils ein
Schritt.

Das ist keine Vorsichtsmaßnahme, sondern notwendig. Effekte müssen asynchron
erzeugt werden, können also nicht innerhalb der Transaktion entstehen — und der
Zwischenzustand einer Compound-Action ist für die folgenden Actions derselben
Transaktion noch nicht sichtbar. Im Schwester-Plugin `smooth-auto-frame-uxp`
ist genau das belegt: die Override-Checkbox des Auto-Reframe-Effekts muss dort
in einer eigenen, vorangehenden Transaktion committed werden, sonst meldet der
Lauf Erfolg und Premiere hat nichts geändert. Einen Effekt einfügen und ihn im
selben Schritt beschreiben funktioniert aus demselben Grund nicht.

Scheitert der zweite Schritt — oder lassen sich die eingefügten Effekte danach
nicht wiederfinden —, entfernt das Plugin die eingefügten Effekte automatisch
wieder, und zwar über die Komponenten-Referenzen aus dem Einfügeschritt statt
über Ketten-Indizes; genau im häufigsten Fehlerfall („Paar nicht wiedergefunden")
wären die Indizes nämlich nicht verfügbar. Ob das Aufräumen geklappt hat, sagt
der Report; wenn nicht, hilft Cmd/Ctrl+Z.

## Diagnose und Log-Export

Der Diagnose-Button gibt für die selektierten Clips die komplette Effektkette
mit matchNames, Indizes und allen Parametern samt Werten, Werttypen und
Keyframe-Status aus, dazu Host-Version und UI-Sprache, die vom Host gemeldeten
matchNames, den berechneten Einfügeindex und das Ergebnis der
Einheiten-Erkennung.

„Log kopieren" legt das Ergebnis in die Zwischenablage, „Log speichern…"
schreibt es in eine Datei, die du im Dialog auswählst. Jeder Report trägt einen
Meta-Block mit Zeitstempel, Plugin-Version, den **tatsächlich angewendeten**
Optionen und den Host-Infos — ein falsch gelesenes Bedienelement fällt dadurch
im Log auf statt still zu bleiben. Fehlerhafte Parameter-Auflösungen hängen
zusätzlich den vollständigen Parameter-Dump des Effekts an.

Das ist nicht nur Support-Werkzeug, sondern Kalibrierung: folgende Details sind
in Adobes Dokumentation nicht belegt und werden daher zur Laufzeit erkannt statt
fest kodiert.

Stand 13.10.2026 sind die wichtigsten davon in **Premiere 26.3.2 / de_DE**
durch einen Diagnose-Lauf bestätigt:

| Bestätigt | Wert |
|---|---|
| matchName Transformieren | `AE.ADBE Geometry2` |
| matchName Zuschneiden | `AE.ADBE AECrop` — **nicht** `AE.ADBE Crop` |
| Position | normalisiert (0‥1) |
| Prozentwerte | 0‥100 |
| Intrinsische Komponenten | am Anfang der Kette (Deckkraft, Bewegung), Nutzer-Effekte danach |
| Bewegungs-Skalierung | heißt `"Skalieren"`, nicht `"Skalierung"` |
| Chain-Reihenfolge | **gegenläufig zur Render-Reihenfolge** — höherer Index rendert früher |
| Bewegung bei Auto Reframe | von Premiere **abgeschaltet**, Werte wirkungslos |
| Koordinatenraum der Effekte | der **Quellclip** (hier 1920×1080), nicht die Sequenz (1080×1080) |
| Prozentwerte beim Zuschneiden | 0‥100 (eine geschriebene 50 erscheint als „50,0 %") |
| `Zoom` beim Zuschneiden | **namenlos**, wird strukturell erkannt |
| „Gleichmäßig skalieren" | hat **keinen Namen** (ein Leerzeichen) und wird strukturell erkannt |

Der Host bietet außerdem einen Fremdeffekt `AE.Impact_Crop_FX`, der ebenfalls
„crop" enthält — deshalb steht `AE.ADBE AECrop` jetzt als exakter Kandidat in
der Liste und wird nicht über die Fragmentsuche gefunden.

| Unbekannt | Umgang |
|---|---|
| matchName von Transformieren / Zuschneiden | zur Laufzeit über `VideoFilterFactory.getMatchNames()` aufgelöst |
| **Parameter haben keinen matchName** | Es gibt nur den lokalisierten `displayName` — in manchen Effekten ist er sogar leer. Jeder Parameter wird deshalb in bis zu vier Stufen aufgelöst: exakter Name in Prioritätsreihenfolge, Teilstring-Fragment, Positions-Fallback dort wo die Parameterreihenfolge stabil ist, und als letzte Instanz eine strukturelle Probe über die Wertform. Scheitert alles, wird der Clip abgelehnt — mit Nennung des Parameters und vollständigem Dump. |
| Form der Rückgabewerte | `getValueAtTime` liefert je nach Version und Parametertyp einen nackten Wert, ein `{value: …}`-Paket, ein doppeltes Paket, ein zweielementiges Array oder numerische Strings. `src/values.js` normalisiert alle diese Formen; `getStartValue` wird zuerst versucht, dann die Zeit des Clips, dann Null. Schalter werden zusätzlich tolerant gelesen (`true`/`false` oder `1`/`0`), weil die älteren APIs Checkboxen numerisch geführt haben — eine strenge Boolean-Prüfung würde in so einem Host jeden Clip ablehnen. |
| Einheit der Position (0‥1 oder Pixel) | am Transformieren-Parameter erkannt. Beim ersten Anwenden ist das der unveränderte Standardwert (Framemitte), die Erkennung läuft also auf unberührten Daten. Ein erneuter Lauf erbt die Interpretation des ersten. |
| ~~Skala der Prozentwerte~~ | **Nicht mehr offen:** gemessen 0‥100, eine geschriebene 50 erscheint als „50,0 %". Früher aus dem Bewegungs-Skalierungswert abgeleitet, also die Konvention eines fremden Effekts als Beleg für diesen. Jetzt eine dokumentierte Konstante; weicht eine künftige Version ab, wird die 50 geklemmt und die Nachkontrolle meldet die Abweichung. |
| Lage der intrinsischen Komponenten in der Kette | Einfügeindex wird aus der Kette berechnet; beide Anordnungen werden behandelt. Besteht die Kette nur aus Intrinsics, ist die Anordnung nicht unterscheidbar und es wird angehängt. |
| Zeitbasis von `getValueAtTime` | der Clip-In-Punkt wird verwendet. Praktisch irrelevant, weil Keyframes auf den gelesenen Parametern ohnehin zum Abbruch führen, der Wert also zeitlich konstant ist. |

Jeder Schreibvorgang wird anschließend zurückgelesen und mit dem Soll
verglichen; Abweichungen erscheinen als Fehler im Report. Was das zuverlässig
findet: abgelehnte, geklemmte oder nicht angekommene Werte — also auch den Fall,
dass Premiere die Transaktion annimmt und die Werte trotzdem verwirft.

Was es **nicht** finden kann, weil Schreiben und Zurücklesen durch dieselbe
Auflösung gehen und ein konsistenter Irrtum sich selbst bestätigt:

- eine falsch erkannte Einheit
- einen Parameter, der nur *aussieht* wie der richtige

Gegen den zweiten Fall steht die Meldung „Parameter-Auflösung" im Report: sie
erscheint, sobald ein Parameter **nicht** über seinen Namen gefunden wurde,
sondern über die Position oder die Wertform. Steht da `struktur` oder `index`,
wo `name` stehen sollte, gehören die Namenslisten in `src/constants.js`
korrigiert — mit dem Diagnose-Dump als Vorlage.

## Aufbau

| Datei | Inhalt |
|---|---|
| `main.js` | Panel-Verdrahtung, Report-Darstellung, Log-Export |
| `src/core.js` | Premiere-I/O, Transaktionen, Parameter-Auflösung, Erstellen und Entfernen |
| `src/geometry.js` | Platzierungsmathematik, rein, ohne Premiere |
| `src/values.js` | Normalisierung der Host-Rückgabewerte und Diagnose-Serialisierung, rein |
| `src/pairing.js` | Paarbildung und Vorprüfung, rein |
| `src/chain.js` | Effektketten-Logik (Einfügeindex, Paar-Erkennung), rein |
| `src/diagnostics.js` | Ketten- und Parameter-Dump |
| `src/constants.js` | matchNames, Parameternamen und -fragmente, Enums |
| `test/mock-premiere.js` | Premiere-Mock als Zustandsmaschine (keine Testdatei) |
| `test/*.test.js` | Tests der reinen Module und von `core.js` |

Die Geometrie-Tests simulieren die Render-Pipeline (Transformieren →
Zuschneiden → Bewegung inklusive Frame-Clipping) unabhängig von der
Implementierung und prüfen sowohl den sichtbaren Bereich als auch den
gezeigten Bildausschnitt.

Die `core.js`-Tests laufen gegen einen gemockten Premiere-Host. Der Mock ist
eine **Zustandsmaschine**: eingereihte Actions werden beim Commit wirklich
angewendet, Einfügen und Entfernen verändern die Effektkette tatsächlich.
Dadurch prüfen die Tests das Ergebnis und nicht die Absicht — inklusive der
Fälle, die sich in Premiere schlecht herstellen lassen: Premiere verwirft
Schreibvorgänge stillschweigend, eine Transaktion wird abgelehnt, eine
eingefügte Komponente ist danach nicht wiederzufinden, Parameter heißen anders
oder haben keinen Namen, oder der Host verpackt seine Rückgabewerte.
