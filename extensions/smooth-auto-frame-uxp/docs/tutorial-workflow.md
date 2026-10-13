# Quelle und Umsetzung des Tutorial-Ablaufs

- Autor: Mathias Möhl (mamoworld), Januar 2024.
- [Video](https://www.youtube.com/watch?v=Fq0ogPX4ZMk)
- [Forumsbeitrag des Autors, einschließlich Korrektur zur Stoppuhr](https://community.adobe.com/questions-729/auto-reframe-without-tracking-it-s-possible-1404517)
- [Originale Automation-Blocks-XML](https://www.dropbox.com/scl/fi/bnwi1nt1r605vcutvfb5z/Selected-Clips-Remove-Auto-Reframe-Track.xml?rlkey=9n1mrt63yqh2qr5iz7zdtzr7c&dl=1)

Die XML wurde bei der Überarbeitung gelesen. Sie enthält drei aufeinanderfolgende
Schreibblöcke:

| Block | Parameter | Operation |
|---|---|---|
| `pr_component_parameter_set_value` | `Auto Reframe\Overwrite generated path` | `TRUE`, `UPDATEUI=TRUE` |
| `pr_component_parameter_set_value` | `Auto Reframe\Adjust Position` | Wert desselben Parameters am gewählten Zeitpunkt, `IF_KEYS=DELETE` |
| `pr_component_parameter_set_value_at_time` | `Auto Reframe\Adjust Position` | `MODIFIER=OLD_VALUE`: einen Keyframe mit dem gesetzten Wert hinzufügen |

Wichtig: „Position anpassen“ ist der editierbare Parameter. Die XML schreibt
weder auf `Position` noch auf `Generated Keyframes` und entfernt Auto Reframe nicht.

Der Autor beschreibt manuell das Ausschalten und erneute Einschalten der
Stoppuhr. Der UXP-Fix macht diese Zustandswechsel explizit, mit je einer
Transaktion für Ausschalten, Wertsetzen, Einschalten und gegebenenfalls Hinzufügen.
Das interne JavaScript des Automation-Blocks-Blocks ist in der XML nicht
enthalten; die genaue Implementierung von `IF_KEYS=DELETE` wird daraus nicht behauptet.

## Unterschiede der APIs

[Automation Blocks verwendet die Premiere-Scripting-API/ExtendScript](https://docs.mamoworld.com/automation-blocks/block-reference/prOther/).
Die frühere Erklärung im Repo, das Tool funktioniere durch simulierte UI-Klicks,
ist nicht durch die Herstellerdokumentation gedeckt.

UXP stellt die grundlegenden Operationen über
[`ComponentParam`](https://developer.adobe.com/premiere-pro/uxp/ppro_reference/classes/componentparam/)
bereit. Allerdings ist `createSetValueAction(keyframe, true)` ein Aufruf mit
`safeForPlayback=true`, nicht das `updateUI=true` der älteren API.

Dass das programmatische Setzen von Override in jeder UXP-Version dieselben
effektinternen Änderungen wie ExtendScript auslöst, ist **nicht belegt**.
Deshalb kontrolliert der Fix ausdrücklich die Verfügbarkeit des editierbaren
Pfads. Fehlende Übertragung wird gemeldet, nicht durch Schreiben in interne
Ausgabeparameter umgangen.

## Zeitbasis

In der Original-XML liest der Referenzblock relativ zum In-Punkt (`IN_POINT`),
der letzte Keyframe-Block verwendet dagegen `CLIP`. Bei einem einzigen konstanten
Keyframe kann auch eine andere Platzierung zeitlich denselben Wert ergeben.
Der Fix verwendet für Lesen, Schreiben und Nachprüfung konsistent die Quellzeit
des gewählten sichtbaren Frames. „Ende“ ist der letzte sichtbare Frame und nicht
der exklusive Out-Punkt. Diese Abbildung ist zunächst auf 100%-Clips beschränkt.

Das vorhandene vollständige Transkript bleibt eine lokale, ignorierte Datei;
hier werden nur Ablauf und Quellen dokumentiert.
