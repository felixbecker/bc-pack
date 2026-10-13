# Smooth Auto Frame — Tutorial-Fix (UXP)

Fixiert den von Auto Reframe gewählten Bildausschnitt auf statisch gefilmten
Clips. **Auto Reframe bleibt auf dem Clip.** Die übrigen Effekte, Skalierung und
Drehung werden nicht verändert.

**Build 1.1.0 · Diagnose d10 · Premiere Pro ab 25.6.**

## Nutzung

1. Auto Reframe fertig analysieren lassen.
2. Einen Clip auswählen und den Playhead auf den gewünschten Ausschnitt stellen.
3. Im Plugin **Aktuelle Abspielposition** wählen (Voreinstellung).
4. **Dry-Run** prüft Parameter und Zeitbereich ohne Änderungen. Solange Override
   aus ist, bestätigt er noch keinen verwendbaren Referenzwert.
5. Dry-Run abwählen und **Ausführen**.
6. Am Referenzframe den Ausschnitt vergleichen und anschließend abspielen.

Für mehrere Clips gibt es auch **Anfang**, **Mitte** und **letzter sichtbarer
Frame**. Diese Zeiten beziehen sich auf den tatsächlich sichtbaren, getrimmten
Clip. Der Playhead muss innerhalb jedes damit zu bearbeitenden Clips liegen;
andernfalls wird der betreffende Clip mit einer Fehlermeldung ausgelassen.

## Der Ablauf

Quelle: Mathias Möhl, [Pr Pro: Auto Reframe Sequence without Tracking](https://www.youtube.com/watch?v=Fq0ogPX4ZMk).
Die originale Automation-Blocks-XML wurde mit dem Transkript abgeglichen;
Quellen und genaue Zuordnung stehen in [docs/tutorial-workflow.md](docs/tutorial-workflow.md).

Pro Clip werden nur zwei Parameter geschrieben:

1. **Erzeugten Pfad überschreiben** aktivieren, falls noch nicht aktiv.
2. Den bearbeitbaren Pfad von **Position anpassen** abwarten und den Wert am
   Referenzframe lesen.
3. Dessen **Stoppuhr ausschalten**.
4. Den gemerkten Wert **statisch setzen**.
5. **Stoppuhr einschalten** und **genau einen Keyframe** mit diesem Wert am
   Referenzzeitpunkt anlegen.

Jeder Schreibschritt ist eine eigene, abgeschlossene UXP-Transaktion. Das
Setzen eines statischen Wertes erfolgt erst nach dem bestätigten Ausschalten
der Stoppuhr. Das Hinzufügen des Keyframes erst nach deren bestätigtem
Einschalten. Legt Premiere dabei selbst bereits genau den gewünschten Keyframe
an, wird kein zusätzlicher angelegt.

`Position` (die zusammengeführte Ausgabe) wird ausschließlich zur Nachprüfung
gelesen. `Generated Keyframes` wird nicht verändert und nicht als Ersatzquelle
für einen fehlenden bearbeitbaren Pfad benutzt.

### Wenn etwas nicht übernommen wird

Der Report nennt den genauen Schritt und seine bereits abgeschlossenen
Vorgänger. Auf den bearbeitbaren Pfad wird maximal etwa eine Sekunde **lesend**
gewartet. Es gibt keine wiederholten Override- oder Positions-Schreibversuche.

Bleibt der Pfad leer, wird kein Positionswert ersetzt. Zur Diagnose Override
einmal manuell in Premiere aktivieren, prüfen ob „Position anpassen“ Keyframes
bekommt und danach den Lauf wiederholen. Ein bereits aktiviertes Override wird
vom Plugin nicht erneut gesetzt.

Ändert schon das Aktivieren von Override die gelesene Ausgabe am Referenzframe,
bricht der Lauf vor dem Löschen der Positions-Keyframes ab. Das Log enthält die
Vorher-/Nachher-Werte; es wird keine Offset-Korrektur geraten.

## Rückgängig

Ein normaler Lauf erzeugt **bis zu fünf Undo-Schritte pro Clip**, bei bereits
aktivem Override bis zu vier. Die tatsächlich abgeschlossenen Transaktionen
werden pro Clip und für den gesamten Lauf gezählt.

Auch bei einem Fehler können vorherige Schritte schon übernommen worden sein.
Der Report weist darauf hin. Zum vollständigen Zurücknehmen unmittelbar nach
dem Lauf entsprechend oft **Cmd/Ctrl+Z** ausführen. Eine automatische
Wiederherstellung oder dauerhafte Sicherung ist in diesem Fix nicht enthalten.

## Was die Nachprüfung aussagt

Geprüft werden Override, Stoppuhr, genau ein Keyframe an der richtigen Zeit und
der tatsächlich geschriebene Positionswert. An Anfang, Viertel, Mitte,
Dreiviertel, Ende und Referenzframe werden „Position anpassen“ und die
zusammengeführte Ausgabe gelesen. Die Ausgabe muss dort der ursprünglichen
Position am Referenzframe entsprechen. Die Prüfung wird nach 300 ms wiederholt,
um kurzfristiges Nachbefüllen zu erkennen.

Das ist eine **Parameterprüfung an Stichproben**, kein Vergleich gerenderter
Bilder und keine Garantie gegen spätere Neuberechnungen des Hosts. Der
entscheidende Test ist [der Echt-Test in Premiere](docs/premiere-test.md).

## Unterstützter Umfang

- Ausgewählte Videoclips mit genau einem Auto-Reframe-Effekt.
- Vorwärts laufende Clips mit **100 % Geschwindigkeit**, auch getrimmt.
- Englische und deutsche Parameternamen; für die namenlose Override-Checkbox
  zusätzlich das im Repo dokumentierte 26.3.2-Layout mit Prüfung der Nachbarfelder.
- Audio und Clips ohne Auto Reframe werden übersprungen.

Retiming, mehrere Auto-Reframe-Effekte pro Clip und animiertes Override werden
vor dem Schreiben abgelehnt. Der Fix hält den Positionspfad fest; eine separate
Zoom-/Rotationsanimation oder Bewegung im aufgenommenen Bild wird nicht geglättet.

Die früheren Optionen „Scale/Rotation zusätzlich einfrieren“, Mittelwert und
„Konstanter Wert ohne Keyframes“ wurden entfernt. Alte Aufrufe mit diesen
Optionen werden als veraltet gemeldet, statt still etwas anderes auszuführen.

## Entwicklung und Installation

```sh
npm ci
npm run check
```

`check` führt ESLint einschließlich Adobes UXP-Regeln und die Tests aus. Der Mock
erzwingt getrennt committete Stoppuhr-Zustände und modelliert die Ausgabe als
abgeleiteten Wert. Er prüft auch verworfene Actions, fehlende Pfadübertragung,
verzögerte Rückkehr von Keyframes und getrimmte Zeitbereiche. Er ersetzt keinen
Test der echten Premiere-Implementierung.

Zum Laden im UXP Developer Tool diese `manifest.json` auswählen. Das Panel muss
**Build 1.1.0 · Diagnose d10** zeigen. Die ausführliche Installationsanleitung
steht in [INSTALL.md](INSTALL.md).

**Validierungsstand:** automatisierte Tests und Lint lokal ausführbar;
visuelle Abnahme in einer laufenden Premiere-Instanz noch ausstehend.
