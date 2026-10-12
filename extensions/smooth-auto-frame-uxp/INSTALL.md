# Installation — Smooth Auto Frame

Vollständiger Weg von `git clone` bis zur Nutzung in Premiere Pro, inklusive
Verteilung auf einen Client-Rechner.

**Voraussetzung:** Premiere Pro **25.6 oder neuer** (Premiere 2026 = 26.x erfüllt das).

**Keine Signierung nötig.** UXP-Pakete brauchen im Gegensatz zu den alten
CEP/ZXP-Extensions keine digitale Signatur und keinen Timestamp — kein
`ZXPSignCmd`, kein Zertifikat, keine `.p12`. Ein `.ccx`-Paket wird unsigniert
installiert; es erscheint lediglich ein Hinweis, dass es nicht aus dem
Creative Cloud Marketplace kommt.

**Kein Marketplace, kein Developer-Account.** Es braucht kein
Marketplace-Listing, kein Adobe-Review und keine Plugin-ID aus dem
Developer-Distribution-Portal. Die einzige unvermeidbare Abhängigkeit ist die
**Creative Cloud Desktop App** auf dem Zielrechner — sie liefert den Installer
(UPIA). Da Premiere ohnehin Creative-Cloud-Lizenzierung braucht, ist das in der
Praxis keine zusätzliche Hürde. Eine Account- oder Kaufprüfung für das Plugin
findet **nicht** statt; die greift nur bei Plugins, die im Marketplace gelistet
sind.

---

## Teil A — Vorbereiten

### 1. Repository klonen

```bash
git clone https://github.com/felixbecker/bc-pack.git
cd bc-pack/extensions/smooth-auto-frame-uxp
ls
```

Es müssen `manifest.json`, `main.js`, `index.html` und `src/core.js` vorhanden sein.

### 2. Premiere Pro einmal starten

Version prüfen über **Hilfe → Über Premiere Pro** (nötig: ≥ 25.6).

Premiere mindestens einmal gestartet zu haben ist wichtig — andernfalls kann die
Plugin-Installation später fehlschlagen (dokumentierter Adobe-Hinweis).

### 3. UXP Developer Tool (UDT) installieren

Creative Cloud Desktop öffnen → nach **„UXP Developer Tool"** suchen → installieren.

UDT ist auch dann nötig, wenn du nicht im Developer-Modus arbeiten willst: es ist
das Werkzeug, das das `.ccx`-Paket erzeugt.

### 4. Developer-Modus in Premiere aktivieren

Premiere → **Einstellungen → Plug-ins** → **„Enable developer mode"** ankreuzen →
**Premiere neu starten**.

Nötig, damit UDT das Plugin registrieren und paketieren kann.

---

## Teil B — Paket bauen

### 5. Plugin in UDT registrieren

UDT starten (Premiere muss laufen) → **Add Plugin…** → auswählen:

```
bc-pack/extensions/smooth-auto-frame-uxp/manifest.json
```

Das Plugin erscheint in der Liste. Es muss dafür nicht geladen sein.

### 6. `.ccx` paketieren

In der Plugin-Zeile **•••** → **Package** → Zielordner wählen.

Ergebnis: eine Datei, benannt nach der Plugin-ID, z. B.
`com.smoothautoframe.uxp_premierepro.ccx`.

> **Plugin-ID stabil halten.** In `manifest.json` steht
> `"id": "com.smoothautoframe.uxp"`. Ändere sie nicht — die ID entscheidet, ob
> ein neues Paket als Update erkannt wird oder als zweite Installation daneben
> landet.

*Alternative ohne UDT:* Eine `.ccx` ist laut Adobe „a regular ZIP file under the
hood". Du könntest den Plugin-Ordner zippen und die Endung ändern, müsstest dann
aber `node_modules/`, `test/`, `eslint.config.mjs`, `package*.json` und
`.gitignore` manuell ausschließen. Adobe empfiehlt das ausdrücklich nicht — nimm
UDT, wenn verfügbar.

---

## Teil C — Installieren und nutzen

### 7. Paket übertragen

Die `.ccx` auf den Zielrechner bringen (USB, Netzlaufwerk, Download). Eine
einzelne Datei, mehr ist es nicht.

### 8. Installieren

**Weg A — Doppelklick** (Einzelplatz):

1. Doppelklick auf die `.ccx`. Creative Cloud Desktop startet.
2. Warnhinweis „kommt nicht aus dem Creative Cloud Marketplace" → **Install**.

**Weg B — UPIA per Kommandozeile** (mehrere Rechner, skriptbar, ohne GUI):

macOS:
```bash
cd "/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/macOS"
./UnifiedPluginInstallerAgent --install "/Pfad/zu/com.smoothautoframe.uxp_premierepro.ccx"
```

Windows:
```cmd
cd "C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent"
UnifiedPluginInstallerAgent.exe /install "C:\Pfad\com.smoothautoframe.uxp_premierepro.ccx"
```

Admin-Rechte können nötig sein. CCX-Unterstützung in UPIA gibt es ab Creative
Cloud Desktop 5.7.

Dieses Plugin fordert zwei eng gefasste Berechtigungen an, beide nur für den
Log-Export: `clipboard` (Button „Log kopieren") und `localFileSystem: "request"`
(Button „Log speichern…" — gewährt Zugriff ausschließlich auf Dateien, die du
selbst im Speicherdialog auswählst). Bei der Installation kann dafür eine
Rechtebestätigung erscheinen. Netzwerkzugriff, `fullAccess` oder Prozessstart
werden **nicht** angefordert. Und da keine native `.uxpaddon`-Bibliothek
enthalten ist, braucht es **keine Apple-Developer-ID und keine Notarisierung**.

### 9. UDT-Version entladen

Falls das Plugin in UDT noch auf „Loaded" steht: **Unload** klicken. Sonst läuft
dieselbe Plugin-ID doppelt — als Entwicklungs- und als installierte Fassung.

### 10. Premiere neu starten

### 11. Panel öffnen

**Fenster → UXP-Plug-ins → Smooth Auto Frame**

### 12. Installation prüfen (optional)

```bash
./UnifiedPluginInstallerAgent --list all
```

---

## Teil D — Erster Test

### 13. Testmaterial vorbereiten

Sequenz mit einem Clip von statischer Kamera (Stativ). Rechtsklick auf die
Sequenz im Projektfenster → **„Auto-Neuformatierung für Sequenz…"** → Zielformat
wählen (z. B. 9:16) → erstellen. Premiere analysiert im Hintergrund — abwarten.

### 14. Ausgangszustand ansehen

Clip anklicken → **Effektoptionen** → *Auto-Neuformatierung* aufklappen. Du
solltest viele Positions-Keyframes sehen. Das ist der Drift, der entfernt werden
soll.

### 15. Clips auswählen

In der Timeline die zu bereinigenden Clips markieren — mehrere gleichzeitig.

### 16. Dry-Run

Referenz-Frame wählen (zunächst *Anfang des Clips*), **Dry-Run angehakt lassen**,
**Ausführen**.

Schreibt garantiert nichts. Das Log zeigt pro Clip die gefundenen Parameter, den
Zielwert und die Anzahl vorhandener Keyframes.

### 17. Echter Lauf

Dry-Run abwählen → **Ausführen**. Danach in den Effektoptionen prüfen: Keyframes
weg, „Override Generated Pan" aktiv, Wert konstant.

### 18. Ergebnis beurteilen

Abspielen — der Hintergrund sollte stehen.

### 19. Undo-Test

Einmal **Cmd/Ctrl+Z**. Der gesamte Lauf über alle Clips muss in **einem** Schritt
zurückgehen. Damit ist die Transaktion verifiziert.

---

## Updaten und Deinstallieren

**Update:** neue `.ccx` mit **gleicher ID** und höherer `version` in
`manifest.json` installieren.

**Deinstallieren:** Creative Cloud Desktop → *Plugins verwalten* → **•••** →
*Uninstall*. Oder per UPIA:
```bash
./UnifiedPluginInstallerAgent --remove "com.smoothautoframe.uxp"
```

---

## Fehlerbehebung

**Plugin erscheint nicht unter Fenster → UXP-Plug-ins**
Lass den Developer-Modus aus Schritt 4 aktiviert und starte Premiere neu. Adobes
Dokumentation bindet den Developer-Modus an das Laden von Plugins *im
Entwicklungszustand* über UDT („required for you to load plugins in development",
„before you can *connect to* a UXP plugin"); auf der allgemeinen
Installationsseite wird er für installierte Plugins nicht erwähnt. Eindeutig
bestätigt oder ausgeschlossen ist für Premiere 26 aber nicht, ob der Schalter
auch für `.ccx`-Installationen verlangt wird. Im Zweifel: aktiviert lassen.

**Log zeigt „Kein Auto-Reframe-Effekt gefunden"**
Die Namenserkennung trifft deine Sprachversion nicht. Den exakten Effektnamen aus
den Effektoptionen ablesen und in `src/core.js` bei
`AUTO_REFRAME_DISPLAY_NAMES` bzw. den `*_PARAM_NAMES` ergänzen.

**Bewegung bleibt nach dem echten Lauf drin**
Checkbox **„Keyframe-Modus (Fallback)"** aktivieren und erneut ausführen. Dann
werden statt eines konstanten Werts zwei Hold-Keyframes geschrieben.

**Creative Cloud Desktop startet beim Doppelklick nicht**
Die Dateizuordnung für `.ccx` fehlt oder es liegt ein Rechteproblem vor — dann
Weg B (UPIA) nutzen. Fehlt oder ist UPIA defekt, hilft eine Neuinstallation der
Creative Cloud Desktop App.

**Konsole für Fehlermeldungen (nur Entwicklungsmodus)**
In UDT in der Plugin-Zeile **•••** → **Debug** öffnet Chrome DevTools. Dort
landen `console.error`-Ausgaben.

---

## Abkürzung für schnelles Testen

Statt Teil B und C: in UDT direkt **Load** klicken. Das Plugin erscheint sofort
in Premiere, ohne Paket und ohne Installation. Nach Codeänderungen **Reload**.
Das ist der Entwicklungsweg — für den Produktiveinsatz auf einem Client die
`.ccx` verwenden.

## Optional: Lint und Tests

```bash
npm install
npm run check     # Lint + 14 Tests
```

Nur nötig, wenn du am Code arbeitest. Für den Betrieb des Plugins irrelevant —
zur Laufzeit hat es keine Abhängigkeiten.
