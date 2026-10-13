# Echt-Test: Tutorial-Fix 1.1.0 / d10

Automatisierte Tests können Premières Auto-Reframe-Interna nicht bestätigen.
Dieser kurze Ablauf prüft die noch offene Host-Annahme.

## Erster Clip

1. Das neue Manifest im UXP Developer Tool laden. Im Panel **1.1.0 / d10** prüfen.
2. Eine Auto-Reframe-Sequenz mit einer statischen Kamera öffnen. Analyse abwarten.
3. Einen Clip bei 100 % Geschwindigkeit auswählen. Playhead innerhalb des Clips
   auf einen gut erkennbaren Ausschnitt stellen. Vorher-Bild merken oder Screenshot machen.
4. „Aktuelle Abspielposition“ wählen. Erst Dry-Run, dann echter Lauf.
5. Prüfen: Auto Reframe vorhanden, Override aktiv, „Position anpassen“ hat genau
   einen Keyframe am Referenzframe. Der Ausschnitt an diesem Frame bleibt erhalten.
6. Den ganzen Clip abspielen: Der vorher unbewegte Hintergrund soll jetzt stehen.
7. Log speichern. Es enthält Premiere-Version, UI-Sprache, Referenzzeit,
   Parameterwerte und den letzten erfolgreich ausgeführten Schritt.
8. Die im Report gezählten Undo-Schritte zurücknehmen. Originalzustand prüfen.

## Wenn es beim bearbeitbaren Pfad scheitert

1. Zum Ausgangszustand zurückkehren.
2. „Erzeugten Pfad überschreiben“ direkt in Premiere aktivieren.
3. Kontrollieren, ob „Position anpassen“ jetzt die Tracking-Keyframes zeigt.
4. Den Plugin-Lauf wiederholen. Vorhandenes Override wird nicht erneut gesetzt.

Damit wird unterschieden zwischen **Pfadfreigabe durch UXP** und dem
anschließenden **Stoppuhr-/Keyframe-Ablauf**. Falls schon das manuelle Aktivieren
den Ausschnitt verschiebt, insbesondere den Reframe-Offset im Vorher/Nachher
vergleichen; der Fix kompensiert solche Änderungen nicht automatisch.

## Anschließend

- Getrimmter Clip mit deutlich von null abweichendem Quell-In-Punkt:
  Anfang, Mitte und letzter sichtbarer Frame erhalten den jeweiligen Ausschnitt.
- Rein vertikaler Drift wird genauso angehalten wie horizontaler Drift.
- Zweiter Lauf auf einem bereits fixierten Clip: weiterhin genau ein Keyframe.
- Mehrere Clips und verlinktes Audio: nur Videoclips mit Auto Reframe werden geändert.
- Ein Clip mit manueller Reframe-Offset-Korrektur: Referenzausschnitt vergleichen.
- Projekt speichern, erneut öffnen und abspielen: Fixierung bleibt bestehen.

## Abnahmestand

Diese Bild-/Host-Prüfungen sind noch **nicht durchgeführt**. Ein `ok` im Report
bezeichnet bestandene Parameter-Stichproben, keine bereits erfolgte visuelle Abnahme.
