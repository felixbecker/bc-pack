# Smooth Auto Frame (UXP)

Adobe Premiere Pro **UXP-Plugin**, das unerwünschte Kamerabewegung entfernt,
die Premieres **Auto Reframe**-Effekt erzeugt — störend vor allem bei Clips,
die eigentlich von einem Stativ gefilmt wurden.

**Erfordert Premiere Pro 25.6 oder neuer.** Ältere Versionen unterstützen UXP
nicht und bräuchten eine CEP/ExtendScript-Umsetzung — die ist hier bewusst
nicht enthalten, da Adobe CEP für Premiere abgekündigt hat und es aus
Programmversionen nach Dezember 2029 entfernt.

## Das Problem

Auto Reframe erkennt das Motiv und erzeugt Position-/Scale-/Rotation-Keyframes,
die ihm folgen. Bei statischer Kamera entsteht dadurch künstlicher Drift:
der Hintergrund „wackelt", obwohl das Original unbewegt ist. Die erkannte
Bildausschnitt-Wahl will man aber behalten — nur die Bewegung soll weg.

Der manuelle Weg in Premiere pro Clip:

1. Auto-Reframe-Effekt in den Effect Controls öffnen.
2. „Override Generated Pan" aktivieren.
3. Zum gewünschten Referenz-Frame navigieren.
4. Keyframing (Stoppuhr) ausschalten → alle Keyframes weg, Wert bleibt konstant.

Dieses Plugin macht das für **alle ausgewählten Clips** auf einmal.

## Funktionsweise

Pro ausgewähltem Clip:

1. **Guard:** Hat der Clip überhaupt einen Auto-Reframe-Effekt? Wenn nicht →
   überspringen und im Log vermerken (kein Fehler, keine Änderung).
2. „Override Generated Pan" aktivieren, damit der generierte Pfad editierbar wird.
3. Referenzwert für Position (optional Scale/Rotation) bestimmen, je nach
   gewählter Option:
   - **Anfang / Mitte / Ende des Clips**
   - **Aktuelle Abspielposition** (in die Clip-Zeit umgerechnet und auf den
     Clipbereich geklemmt)
   - **Mittelwert aller Keyframes**
4. Wert validieren (`isFinite`, Punktkomponenten) — ein ungültiger Wert wird
   **nie** geschrieben, der Clip wird stattdessen übersprungen.
5. Keyframing abschalten und den Wert als **echten konstanten Wert** schreiben.
   Ein Parameter ohne Keyframes ist per Definition konstant — das direkte
   Äquivalent zum Ausschalten der Stoppuhr.

Alles läuft in **einer einzigen `executeTransaction`**: der komplette Lauf über
beliebig viele Clips ist **ein einzelner Undo-Schritt** (Cmd/Ctrl+Z).

### Referenzzeit-Bestimmung

Für Anfang/Mitte/Ende nutzt das Plugin bevorzugt Zeiten aus der **eigenen
Keyframe-Liste des Parameters** (`getKeyframeListAsTickTimes()`). Damit entfällt
jede Unsicherheit darüber, ob Effekt-Keyframes in clip- oder sequenzrelativer
Zeit adressiert werden — eine Zeit aus der Liste des Parameters ist für diesen
Parameter garantiert gültig. Erst wenn keine Keyframes existieren, werden
In-/Out-Point des Clips als Fallback verwendet.

### Zwei Schreibmodi

| Modus | Verhalten |
|---|---|
| **Standard** (empfohlen) | `createSetTimeVaryingAction(false)` + `createSetValueAction(...)` → konstanter Wert, keine Keyframes. |
| **Keyframe-Modus** (Checkbox, Fallback) | Keyframes im Clipbereich entfernen, dann zwei identische Keyframes mit **Hold**-Interpolation an In-/Out-Point. |

Der Keyframe-Modus existiert, weil in Tutorials berichtet wird, Premiere wolle
auf dieser Property mindestens einen Keyframe sehen. Ob das bei aktivem
„Override Generated Pan" tatsächlich zutrifft, ließ sich ohne laufende
Premiere-Instanz nicht entscheiden — daher sind beide Wege verfügbar.

## Installation

Die vollständige Anleitung von `git clone` bis zur Nutzung — inklusive
`.ccx`-Paketierung und Verteilung auf Client-Rechner — steht in
**[INSTALL.md](INSTALL.md)**.

Kurzfassung für die Entwicklung:

1. [UXP Developer Tool (UDT)](https://developer.adobe.com/photoshop/uxp/guides/devtool/)
   über Creative Cloud Desktop installieren.
2. In Premiere **Einstellungen → Plug-ins → „Enable developer mode"** aktivieren
   und Premiere neu starten.
3. In UDT **Add Plugin** wählen, die `manifest.json` dieses Ordners laden,
   dann **Load** klicken.
4. Panel öffnen: **Fenster → UXP-Plug-ins → Smooth Auto Frame**

Für die Weitergabe an Dritte wird das Plugin in UDT als `.ccx` paketiert. Eine
digitale Signatur ist bei UXP **nicht** erforderlich, ein
Marketplace-Listing ebenfalls nicht — Details in [INSTALL.md](INSTALL.md).

## Nutzung

1. Clips mit Auto-Reframe-Effekt in der Timeline auswählen.
2. Referenz-Frame wählen.
3. Optional Scale und/oder Rotation mit einfrieren.
4. **Dry-Run** ist standardmäßig aktiv — zeigt alle geplanten Änderungen inkl.
   Zielwerten und Keyframe-Anzahl, ohne etwas zu schreiben. Zum echten
   Schreiben Dry-Run abwählen.
5. „Ausführen". Das Log zeigt pro Clip verarbeitet / übersprungen (mit Grund) /
   Fehler.

## Entwicklung & Qualitätssicherung

```bash
npm install
npm run check     # = npm run lint && npm run test
```

### Tests

`test/core.test.js` mockt das `premierepro`-Modul (TickTime, PointF,
Project/Sequence/TrackItem/Component-Chain) und protokolliert **jede Action**,
die der Algorithmus einreiht. Damit ist die eigentliche Entscheidungslogik
testbar, ohne Premiere zu starten — 14 Tests decken ab:

- Dry-Run erzeugt **keine** Action
- Standardmodus schreibt `setTimeVarying(false)` + `setValue` in **genau einer**
  Transaktion mit Undo-String, umschlossen von `lockedAccess`
- Position wird als `PointF` rekonstruiert
- Referenz `start` / `end` / `average` / `playhead` liefern die richtigen Werte
  (inkl. Umrechnung Sequenzzeit → Clipzeit beim Playhead)
- **Rotation `0` wird geschrieben** statt als Lesefehler verworfen
  (Regressionsschutz: diese Verwechslung machte eine frühere Fassung unbrauchbar)
- Keyframe-Modus löscht/schreibt in der Keyframe-Domäne mit Hold-Interpolation
- Clip ohne Auto Reframe wird übersprungen, ohne etwas zu schreiben
- Unbekannte Timing-Option fällt auf `start` zurück
- Die Component-Chain wird vor dem Schreiben erneut geholt

### Linting

Das Lint-Setup nutzt **Adobes eigenes** `@adobe/eslint-plugin-premierepro`.
Dessen Regeln prüfen genau die Premiere-Fallstricke, die sonst erst zur Laufzeit
auffallen:

- `create*Action()` nur innerhalb `lockedAccess()` / `executeTransaction()`
- `addAction()` nur innerhalb `executeTransaction()`
- kein `async`/`await` in diesen Callbacks
- keine Action-Objekte, die den Lock-Scope verlassen

Deshalb ist der Schreibcode **absichtlich inline** in der
`executeTransaction`-Callback geschrieben und nicht in eine Hilfsfunktion
ausgelagert: die syntaktischen Regeln prüfen lexikalische Verschachtelung und
können Indirektion über Hilfsfunktionen nicht zuverlässig verfolgen.

Das Plugin trennt daher strikt:

- **Phase 1 (async):** alle Lesezugriffe, Wertberechnung, Planaufbau.
- **Phase 1b (async):** unmittelbar vor dem Schreiben werden alle
  Component-Chains **neu geholt**. Premiere 26.3 invalidiert Script-Objekte,
  die async-Grenzen überschreiten („The script object is no longer valid") —
  das hält das Zeitfenster so klein wie möglich.
- **Phase 2 (synchron):** eine Transaktion, in der nur noch Actions erzeugt und
  eingereiht werden. Components/Params werden darin **frisch** über
  `getComponentAtIndex()` / `getParam()` aus der aktualisierten Chain geholt.
  Aus dem Callback wird nichts geworfen: Probleme werden gesammelt und nach der
  Transaktion gemeldet, damit Premiere Transaktion und Lock regulär abräumt.

### Zeitdomänen-Konsistenz

Im Keyframe-Modus werden die Schreibpositionen **und** der zu löschende Bereich
aus der Keyframe-Liste *desselben* Parameters abgeleitet (`writeStart` /
`writeEnd`), nicht aus den In-/Out-Points des Clips. Damit liegen gelöschte und
neu geschriebene Keyframes garantiert in derselben Zeitdomäne wie die von Auto
Reframe erzeugten. Nur wenn ein Parameter gar keine Keyframes hat, dienen die
In-/Out-Points als Fallback.

### Minimale Rechte

Die `manifest.json` deklariert bewusst nur zwei, eng gefasste Berechtigungen —
beide ausschließlich für den Log-Export:

| Berechtigung | Wofür | Umfang |
|---|---|---|
| `clipboard: "readAndWrite"` | Button „Log kopieren" | UXP kennt keine Schreib-only-Stufe; gelesen wird nie. |
| `localFileSystem: "request"` | Button „Log speichern…" | Nur Dateien, die der Nutzer im Speicherdialog selbst auswählt. Kein stiller Zugriff, kein `fullAccess`. |

**Nicht** angefordert: Netzwerk, `fullAccess`, Prozessstart,
`allowCodeGenerationFromStrings`, Webview, IPC. Der Kernalgorithmus selbst
braucht keine Berechtigung — ohne die Export-Buttons wäre das Manifest
berechtigungsfrei.

## Bekannte Einschränkungen

- Der interne `matchName` von Auto Reframe ist von Adobe **nicht öffentlich
  dokumentiert** (die Component-API fehlt im Object Model Viewer). Das Plugin
  sucht daher zuerst über matchName-Fragmente, dann über lokalisierte
  Anzeigenamen. Greift keine Variante, wird der Clip sicher übersprungen; in
  `src/core.js` lassen sich weitere Namen in
  `AUTO_REFRAME_DISPLAY_NAMES` / `*_PARAM_NAMES` ergänzen.
- **Mittelwert-Modus:** Bei einem echten Schwenk ergibt das arithmetische Mittel
  eine Position, die in keinem einzelnen Frame gut gerahmt ist. Sinnvoll vor
  allem bei Stativ-Aufnahmen mit leichtem Jitter.
- **Gesperrte Spuren** werden nicht eigens geprüft. Das Plugin verlässt sich
  darauf, dass `Sequence.getSelection()` keine Items auf gesperrten Spuren
  liefert. Falls doch, schlägt die Transaktion fehl — folgenlos, weil sie
  atomar ist.
- Die Statuszeile zeigt nach jedem Lauf die **tatsächlich angewandte**
  Referenz-Option. Das ist Absicht: `sp-picker.value` verhält sich über
  UXP-Versionen hinweg nicht einheitlich, daher liest das Panel zusätzlich das
  selektierte `sp-menu-item` aus und macht das Ergebnis sichtbar, statt
  stillschweigend auf den Default zurückzufallen.
- **Nicht gegen eine laufende Premiere-Instanz getestet** — in dieser
  Entwicklungsumgebung war keine verfügbar. Verifiziert wurden:
  `npm run check` (ESLint inkl. Adobes Premiere-Regeln: 0 Probleme; 14
  Funktionstests gegen eine gemockte Premiere-API: alle bestanden),
  `node --check` auf allen JS-Dateien, JSON-Schema-Konformität der
  `manifest.json`, Existenz aller im Manifest referenzierten Dateien,
  Übereinstimmung der Entrypoint-ID zwischen Manifest und
  `entrypoints.setup()`, Gleichheit der Timing-Werte zwischen UI und
  Kernmodul, Abwesenheit von `await`/`throw` im Transaktionsblock, und
  Abgleich jedes API-Aufrufs mit der offiziellen UXP-Referenz.
  Die Mock-Tests belegen die **Entscheidungslogik**, nicht das Verhalten der
  echten Premiere-API.
- Statisch **nicht** entscheidbar bleibt: ob Auto-Reframe-Keyframes clip- oder
  sequenzrelativ adressiert werden (deshalb die Ableitung aus der
  Keyframe-Liste), ob `setTimeVarying(false)` allein für einen konstanten Wert
  genügt (deshalb der Keyframe-Fallback), und ob die lokalisierten
  Effekt-/Parameternamen in jeder Sprachversion treffen.

## Projektstruktur

```
smooth-auto-frame-uxp/
├── manifest.json        # UXP-Manifest (v5, host premierepro >= 25.6.0)
├── INSTALL.md           # Installation & Verteilung (clone -> .ccx -> Client)
├── index.html           # Panel-UI (Spectrum UXP Widgets, built-in)
├── main.js              # Entrypoint-Registrierung + UI-Logik
├── style.css
├── src/
│   └── core.js          # Kernalgorithmus (Phase 1 async / Phase 2 Transaktion)
├── test/
│   └── core.test.js     # 14 Regressionstests gegen gemockte Premiere-API
├── icons/
├── eslint.config.mjs    # inkl. @adobe/eslint-plugin-premierepro
└── package.json
```
