# Split Screener — wie der Splitscreen entsteht

Beschreibt den Ist-Stand von Version 1.1.0: welchen Weg ein Klick auf
„Splitscreen erstellen" nimmt, welche Werte dabei berechnet werden, und warum
die Umsetzung so aussieht und nicht anders. Die Nutzungsanleitung steht im
[README](README.md); dieses Dokument richtet sich an jemanden, der den Code
ändern oder einen Fehlerbericht einordnen will.

## Inhalt

1. [Die Grundidee in fünf Sätzen](#1-die-grundidee-in-fünf-sätzen)
2. [Warum Transform und Crop und nicht „Bewegung"](#2-warum-transform-und-crop-und-nicht-bewegung)
3. [Die Mathematik](#3-die-mathematik)
4. [Ablauf](#4-ablauf)
5. [Die vier Phasen im Detail](#5-die-vier-phasen-im-detail)
6. [Parameter finden](#6-parameter-finden)
7. [Entfernen und Idempotenz](#7-entfernen-und-idempotenz)
8. [Design-Entscheidungen und ihre Begründung](#8-design-entscheidungen-und-ihre-begründung)
9. [Ausnahmen, Grenzen und Sonderfälle](#9-ausnahmen-grenzen-und-sonderfälle)
10. [Wo welcher Code steht](#10-wo-welcher-code-steht)

## 1. Die Grundidee in fünf Sätzen

Premiere rendert einen Clip als Kette: zuerst die Standard-Effekte in ihrer
Reihenfolge, danach die intrinsischen Effekte „Bewegung" und „Deckkraft".

Das Plugin hängt pro Clip **zwei eigene Standard-Effekte ans Ende** dieser
Kette: ein **Transformieren**, das das Bild in seine Hälfte schiebt, und ein
**Zuschneiden**, das diese Hälfte herausschneidet.

Weil beide Effekte hinter allem sitzen, was der Nutzer angelegt hat, ist alles
Vorherige für das Plugin einfach „der aktuelle Look". Auto Reframe, Lumetri
oder ein von Hand gesetzter Beschnitt brauchen deshalb keine Sonderbehandlung.

Nur die intrinsische Bewegung läuft **danach** und verschiebt unsere Hälfte
wieder — deshalb wird sie gelesen und aus den Werten herausgerechnet.

## 2. Warum Transform und Crop und nicht „Bewegung"

Die Platzierung ließe sich auch direkt in die Bewegung des Clips schreiben.
Dagegen sprach eine abgenommene Anforderung: **„Splitscreen entfernen" muss
verlustfrei sein.**

| Ansatz | Entfernen | Preis |
|---|---|---|
| In „Bewegung" schreiben | Wir müssten wissen, worauf zurücksetzen. Ein vorhandener Punch-In wäre überschrieben und unwiederbringlich — es sei denn, wir sichern die Vorher-Werte in einer plugin-eigenen Datei, die bricht, sobald der Clip verschoben wird. | kein Zusatz-Effekt |
| **Eigene Effekte anhängen** | Beide Komponenten löschen. Der Zustand davor ist per Definition wiederhergestellt, ohne externen Zustand. | zwei Effekte pro Clip |

Die zweite Variante wurde gewählt. Die Konsequenz zieht sich durch das ganze
Design: unsere Effekte sitzen **vor** der Bewegung, also müssen wir deren
Wirkung kompensieren — und bezahlen dafür mit der Einschränkung aus
[Abschnitt 9](#stark-verkleinerte-clips).

## 3. Die Mathematik

### Modell

Die Bewegung ist eine affine Abbildung: Skalierung um die Framemitte, dann
Verschiebung auf die Bewegungs-Position.

```
M(v) = m · (v − c) + p        c = Framemitte, m = Skalierung, p = Position
```

Gewünscht ist: der aktuelle Look, um `d` verschoben, wobei `d` eine
Viertel-Framebreite (bzw. -höhe) ist. Unser Transformieren `T` sitzt vor der
Bewegung, das Ergebnis ist also `M(T(v))`. Verlangt ist

```
M ∘ T = Translate(d) ∘ M
```

Das löst sich zu `T = Translate(d / m)` — die Bewegungs-**Position** fällt
heraus, nur die Skalierung bleibt. Das Crop-Fenster dagegen muss durch `M`
zurückgebildet werden, dort erscheint die Position:

```
W = c + (Zielzelle − p) / m
```

### Was im Code steht

`geometry.computePlacement()` rechnet genau das, getrennt pro Achse:

```js
transformPosition.x = centreX + offset.dx / scaleX
transformPosition.y = centreY + offset.dy / scaleY

windowXMin = centreX + (rect.x0 − position.x) / scaleX
windowXMax = centreX + (rect.x1 − position.x) / scaleX
// analog für Y

crop.left   = clamp(windowXMin / width · 100,        0, 100)
crop.right  = clamp((1 − windowXMax / width) · 100,  0, 100)
// analog für oben/unten
```

`rect` ist die Zielzelle, `offset` der Standardversatz:

| Zelle | `rect` | `offset` |
|---|---|---|
| links | x ∈ [0, B/2], y ∈ [0, H] | (−B/4, 0) |
| rechts | x ∈ [B/2, B], y ∈ [0, H] | (+B/4, 0) |
| oben | x ∈ [0, B], y ∈ [0, H/2] | (0, −H/4) |
| unten | x ∈ [0, B], y ∈ [H/2, H] | (0, +H/4) |

### Der Normalfall

Bei unangetasteter Bewegung (`m = 1`, `p` = Framemitte) fällt alles zusammen:

| Zelle | Zuschneiden | Transformieren · Position |
|---|---|---|
| links | Rechts 50 % | (0,25·B; 0,50·H) |
| rechts | Links 50 % | (0,75·B; 0,50·H) |
| oben | Unten 50 % | (0,50·B; 0,25·H) |
| unten | Oben 50 % | (0,50·B; 0,75·H) |

### Mit Punch-In

Clip auf 120 %, linke Zelle, 1920×1080:

```
Transformieren x = 960 + (−480 / 1,2) = 560 px
Crop links  = (960 + (0   − 960)/1,2) / 1920 · 100 =  8,33 %
Crop rechts = (1 − (960 + (960 − 960)/1,2) / 1920) · 100 = 50 %
Crop oben/unten = je 8,33 %
```

Der vertikale Beschnitt ist hier nicht kosmetisch: bei 120 % ragt das Bild über
den Frame hinaus, und ohne ihn würde Überstand in die Nachbarzelle laufen,
sobald die Bewegungs-Position nicht zentriert ist.

### Was sichtbar wird

`computePlacement` berechnet zusätzlich, was am Ende wirklich zu sehen ist, und
zwar als eigenständige Rechnung: Bildausdehnung nach dem Transformieren
(begrenzt auf den Frame), geschnitten mit dem Crop-Fenster, abgebildet durch
`M`. Weicht das Ergebnis von der Zielzelle ab, gibt es eine Warnung:

- `CELL_NOT_FILLED` — die Hälfte bleibt teilweise schwarz
- `CELL_EMPTY` — es wäre gar nichts zu sehen; der Lauf bricht ab

Diese Vorhersage ist nicht Zierde, sondern der Grund, warum die Einschränkung
bei stark verkleinerten Clips überhaupt gefunden wurde: die Testsimulation der
Render-Pipeline hat sie aufgedeckt.

## 4. Ablauf

```
                     ┌─────────────────────────┐
                     │ „Splitscreen erstellen" │
                     └────────────┬────────────┘
                                  │
         ╔════════════════════════▼════════════════════════╗
         ║ PHASE 1 — lesen und planen  (asynchron)         ║
         ╚════════════════════════╤════════════════════════╝
                                  │
                   Projekt, Sequenz, Framegröße,
                   Auswahl, Effekt-matchNames
                                  │
                      ┌───────────▼───────────┐
                      │ fehlt etwas davon?    │──ja──▶ ABBRUCH, nichts geändert
                      └───────────┬───────────┘
                                  │ nein
                   pro Clip: Zeitbasis, Effektkette,
                   Spurindex, Start/Ende,
                   Bewegungs-Zustand
                                  │
                      ┌───────────▼───────────┐
                      │ Clip nicht lesbar?    │──ja──▶ ABBRUCH, nichts geändert
                      └───────────┬───────────┘
                                  │ nein
         ╔════════════════════════▼════════════════════════╗
         ║ VORPRÜFUNG — alles oder nichts                  ║
         ╚════════════════════════╤════════════════════════╝
                                  │
            Paare bilden (identische Start- UND Endzeit)
            + alle Regeln prüfen (siehe Abschnitt 5)
                                  │
                      ┌───────────▼───────────┐
                      │ irgendeine verletzt?  │──ja──▶ ABBRUCH, ALLE Gründe
                      └───────────┬───────────┘         im Report, nichts geändert
                                  │ nein
                   Platzierung je Clip berechnen
                                  │
                      ┌───────────▼───────────┐
                      │ nicht berechenbar?    │──ja──▶ ABBRUCH
                      │ (Framegröße, m ≤ 0)   │
                      └───────────┬───────────┘
                                  │ nein
                      ┌───────────▼───────────┐
                      │ Zelle bliebe leer?    │──ja──▶ ABBRUCH
                      └───────────┬───────────┘
                                  │ nein
                      ┌───────────▼───────────┐
                      │ Dry-Run?              │──ja──▶ Werte anzeigen, ENDE
                      └───────────┬───────────┘         nichts geschrieben
                                  │ nein
                   fehlende Effekte erzeugen
                   (createComponent ist async!)
                                  │
                      ┌───────────▼───────────┐
                      │ Erzeugung abgelehnt?  │──ja──▶ ABBRUCH, nichts eingefügt
                      └───────────┬───────────┘
                                  │ nein
         ╔════════════════════════▼════════════════════════╗
         ║ PHASE 2 — Transaktion 1: einfügen  (synchron)   ║
         ╚════════════════════════╤════════════════════════╝
                                  │
                      ┌───────────▼───────────┐
                      │ fehlgeschlagen?       │──ja──▶ ABBRUCH, nichts eingefügt
                      └───────────┬───────────┘
                                  │ nein
                   Ketten NEU lesen, eigenes Paar
                   suchen, Parameter auflösen
                                  │
                      ┌───────────▼───────────┐
                      │ Paar/Parameter nicht  │──ja──▶ ROLLBACK: eingefügte
                      │ auflösbar?            │        Effekte wieder entfernen
                      └───────────┬───────────┘
                                  │ nein
         ╔════════════════════════▼════════════════════════╗
         ║ PHASE 3 — Transaktion 2: Werte  (synchron)      ║
         ╚════════════════════════╤════════════════════════╝
                                  │
                   Keyframing aus, Position setzen,
                   4 Crop-Werte setzen, Zoom aus
                                  │
                      ┌───────────▼───────────┐
                      │ fehlgeschlagen?       │──ja──▶ ROLLBACK
                      └───────────┬───────────┘
                                  │ nein
         ╔════════════════════════▼════════════════════════╗
         ║ PHASE 4 — Nachkontrolle  (asynchron)            ║
         ╚════════════════════════╤════════════════════════╝
                                  │
                   Werte zurücklesen und mit dem
                   Soll vergleichen
                                  │
                      ┌───────────▼───────────┐
                      │ Abweichung?           │──ja──▶ als FEHLER melden,
                      └───────────┬───────────┘        nicht als Erfolg
                                  │ nein
                            Report: fertig
```

## 5. Die vier Phasen im Detail

### Phase 1 — lesen und planen

Alles asynchron, nichts wird verändert. Pro selektiertem Clip entsteht ein
Datensatz mit zwei Hälften: die Premiere-Handles (Effektkette, TrackItem) und
ein **reiner Deskriptor** aus einfachen Werten, mit dem die Vorprüfung
arbeitet. Die Trennung ist der Grund, warum die Regel-Logik ohne Premiere
testbar ist.

Gelesen wird: Name, Spurindex, Start- und Endzeit, die **Zeitbasis des Clips**
(der In-Punkt — jede Parameter-Lesung bezieht sich darauf; ist er nicht lesbar,
wird der Clip abgelehnt), die Effektkette mit matchName und Anzeigename jeder
Komponente, der Einfügeindex, ein eventuell schon vorhandenes eigenes Paar, und
der Zustand der intrinsischen Bewegung: Position, Skalierung, Drehung,
Ankerpunkt, „Gleichmäßig skalieren" und für jeden davon der Keyframe-Status.
Die Skalierungsbreite wird nur belegt, damit sie keine andere Suche stört —
gelesen wird sie ausschließlich, wenn „Gleichmäßig skalieren" aus ist.

**Video oder Audio** wird daran erkannt, dass die Kette eine nur bei Video
vorkommende intrinsische Komponente enthält — Bewegung, Deckkraft oder
Time Remapping. Eine Audio-Kette führt Lautstärke und Panner und fällt damit
durch. „Deckkraft" ist absichtlich mit in der Liste: ein Video-Clip, dessen
Bewegungs-Effekt wir nicht erkennen, soll trotzdem als Video gelten und einen
klaren Fehler erzeugen, statt stillschweigend als „kein Video-Clip" zu
verschwinden.

### Vorprüfung — alles oder nichts

Die Clips werden nach **identischer Start- und Endzeit** (tick-genau, keine
Toleranz) gruppiert. Jede Gruppe aus genau zwei Clips auf verschiedenen Spuren
ist ein Paar; der niedrigere Spurindex bekommt links bzw. oben, die Checkbox
„Clips tauschen" kehrt das um.

Abbruchregeln, alle gemeinsam gemeldet statt einzeln:

| Regel | Grund |
|---|---|
| weniger als zwei Video-Clips | nichts zu paaren |
| Effektkette nicht lesbar | wir konnten nicht hinsehen — nicht dasselbe wie „kein Video-Clip" |
| Start- oder Endzeit nicht lesbar | Deckungsgleichheit nicht prüfbar; zwei solche Clips würden sonst denselben unbekannten Zeitschlüssel tragen und als deckungsgleich gelten |
| kein deckungsgleicher Partner | Anforderung |
| drei oder mehr deckungsgleiche Clips | nur Paare werden unterstützt |
| beide auf derselben Spur | können sich nicht überlagern |
| Drehung ≠ 0 oder verschobener Ankerpunkt — **oder Keyframes darauf** | ein achsenparalleler Beschnitt kann ein gekipptes Bild nicht korrekt halbieren. Die Keyframes zählen mit, weil ein Clip, der im abgetasteten Frame zufällig bei 0° steht und wegdreht, die reine Wertprüfung sonst passieren würde |
| Keyframes auf Position, Skalierung, Skalierungsbreite oder „Gleichmäßig skalieren" | unsere Werte sind statisch, eine animierte Transformation ließe sich nicht kompensieren |
| ein Bewegungs-Parameter nicht gefunden, nicht lesbar, oder sein Keyframe-Status nicht ermittelbar | siehe [Abschnitt 6](#6-parameter-finden) |
| Skalierung ≤ 25 % | die Hälfte wäre leer, siehe [Abschnitt 9](#stark-verkleinerte-clips) |

Audio-Elemente in der Auswahl werden still ignoriert und im Report als
übersprungen gezählt.

### Phase 2 — Transaktion 1: einfügen

`VideoFilterFactory.createComponent()` ist **asynchron**, die Komponenten
müssen also vor der Transaktion entstehen. Eingefügt werden sie am berechneten
Index: Transformieren an `index`, Zuschneiden an `index + 1`.

Der Index kommt aus `chain.computeInsertionIndex()`. Erwartet wird, dass
Premiere die intrinsischen Komponenten am Anfang der Kette führt; dann ist
Anhängen richtig. Liegt eine Standard-Komponente vor einer intrinsischen, sind
die Intrinsics ein Block am Ende und wir fügen davor ein. Besteht die Kette nur
aus Intrinsics, sind beide Anordnungen nicht unterscheidbar und es wird
angehängt.

Danach werden die Ketten **neu gelesen**, damit die Komponenten adressiert
werden, die wirklich in der Kette stehen — nicht die Handles, die wir erzeugt
haben. (Im Nachbar-Plugin ist zusätzlich dokumentiert, dass Premiere 26.3
Script-Objekte invalidiert, die asynchrone Grenzen überschreiten; für diesen
Code ist das nicht nachgewiesen.)

### Phase 3 — Transaktion 2: Werte

Pro Clip werden geschrieben, in dieser Reihenfolge:

1. die Transformieren-Position — ist sie animiert, geht ein
   `createSetTimeVaryingAction(false)` unmittelbar voraus
2. die vier Crop-Werte, jeder einzeln, und jeweils mit vorangestelltem
   `createSetTimeVaryingAction(false)`, falls dieser Parameter animiert ist
3. `Zoom = false` am Zuschneiden, falls der Parameter existiert — Zoom würde
   die geschnittene Hälfte wieder auf Framegröße ziehen

Das Entkeyframen ist nötig, weil `createSetValueAction` laut Doku für
nicht-animierte Parameter spezifiziert ist; ein animierter Parameter würde den
Schreibvorgang verschlucken. Es repariert zugleich ein Paar, das jemand von
Hand animiert hat.

Weitere Parameter werden nicht angefasst.

### Phase 4 — Nachkontrolle

Eine committete Transaktion heißt nicht, dass der Effekt die Änderung
angenommen hat. Es wird also zurückgelesen und verglichen: die Position auf
0,75 px, die Crop-Werte auf 0,05 **in der Einheit des Hosts** (in der
Prozent-Konvention also 0,05 Prozentpunkte, in der 0‥1-Konvention entsprechend
grober), und es darf keiner unserer Parameter mehr animiert sein. Jede
Abweichung wird als **Fehler** gemeldet, nicht als Erfolg.

## 6. Parameter finden

Hier liegt die unangenehmste Lücke der UXP-API: **`ComponentParam` hat keinen
matchName.** Es gibt nur `displayName`, und der ist lokalisiert — im
Nachbar-Plugin `smooth-auto-frame-uxp` ist dokumentiert, dass er in manchen
Effekten sogar leer ist.

Deshalb wird jeder Parameter in bis zu vier Stufen aufgelöst:

```
1. exakter Name, Kandidaten in Prioritätsreihenfolge
2. Teilstring-Fragment, ebenfalls in Prioritätsreihenfolge
3. Positions-Fallback (nur Zuschneiden, dessen Reihenfolge stabil ist)
4. strukturelle Probe über die Wertform (nur die Transformieren-Position)
   ↓ keine greift
   ABBRUCH mit Nennung des Parameters und vollständigem Parameter-Dump
```

Drei Details, die alle aus konkreten Fehlern stammen:

**Die äußere Schleife läuft über die Kandidaten, nicht über die Parameter.**
Andernfalls gewinnt der Parameter, der in der Liste zufällig früher steht. Bei
„Skalierung" und „Skalierungsbreite" wäre das die falsche Antwort.

**Bereits vergebene Indizes werden gemerkt** (`claimed`). Die Skalierungsbreite
wird deshalb vor der Skalierung belegt, damit das Fragment `skalierung` sie
nicht greifen kann. Ebenso wird der Ankerpunkt des Transformieren-Effekts
belegt, bevor die Position gesucht wird: beide sind Punkte auf der Framemitte,
die strukturelle Probe würde sonst den Ankerpunkt nehmen. Der Positions-
Fallback respektiert diese Belegung ebenfalls — ohne das konnten zwei
Crop-Werte auf denselben Parameter zeigen, einer wurde zweimal geschrieben, ein
anderer nie, und bei symmetrischen Zielwerten fiel das der Nachkontrolle nicht
auf.

**„Gefunden" genügt nicht.** Der Parameter muss einen Wert der erwarteten Art
liefern — Punkt, Zahl oder Schalter. Schalter werden dabei tolerant gelesen
(`true`/`false` oder `1`/`0`), weil die älteren Premiere-APIs Checkboxen
numerisch geführt haben; eine strenge Boolean-Prüfung hätte in so einem Host
jeden Clip abgelehnt, für einen Wert, den wir nur als Ja/Nein benutzen.

### Werte normalisieren

`getValueAtTime` liefert je nach Version und Parametertyp Verschiedenes:
einen nackten Wert, ein `{value: …}`-Paket, ein doppelt verpacktes, ein
zweielementiges Array oder numerische Strings. `src/values.js` normalisiert all
das; gelesen wird zuerst `getStartValue()`, dann mit der Clip-Zeit, dann mit
Null.

Dabei gilt bewusst: ein Array ist nur dann ein Punkt, wenn es **genau zwei**
Elemente hat. Sonst würde eine Farbe als `[r, g, b, a]` als Punkt durchgehen
und die strukturelle Probe könnte einen Farbparameter für die Position halten.

### Die Grenze der Nachkontrolle

Zurücklesen findet verworfene, geklemmte und nicht angekommene Werte
zuverlässig. Es findet **nicht**, dass ein Parameter nur *aussieht* wie der
richtige, oder dass eine Einheit falsch erkannt wurde — Schreiben und Lesen
gehen durch dieselbe Auflösung, ein konsistenter Irrtum bestätigt sich selbst.

Dagegen steht die Zeile **„Parameter-Auflösung"** im Report. Sie erscheint nur,
wenn ein Parameter nicht über seinen Namen gefunden wurde, und nennt dann die
verwendete Stufe. Steht dort `struktur` oder `index`, wo `name` stehen sollte,
gehören die Namenslisten in `src/constants.js` korrigiert — mit dem
Diagnose-Dump als Vorlage.

### Einheiten

Zwei Konventionen sind nicht dokumentiert und werden zur Laufzeit erkannt:

| Frage | Erkennung |
|---|---|
| Position normalisiert (0‥1) oder in Pixeln? | aus dem Betrag des gelesenen Wertes. Eine zentrierte Position liest sich als (0,5; 0,5) oder als (B/2; H/2) — die Bereiche überlappen bei realistischen Framegrößen nicht. Beim ersten Anwenden ist der Transformieren-Wert noch der unberührte Standard, die Erkennung läuft also auf sauberen Daten. |
| Prozentwerte 0‥100 oder 0‥1? | aus dem Bewegungs-Skalierungswert: über 2 heißt Prozent. Das ist eine **effektübergreifende Annahme** — die Konvention der Bewegung entscheidet über die Skala der Zuschneiden-Parameter. In die eine Richtung fällt ein Irrtum auf (50 in einem 0‥1-Parameter wird geklemmt und weicht ab), in die andere nicht. |

## 7. Entfernen und Idempotenz

### Erkennung des eigenen Paares

Unser Zuschneiden ist ein gewöhnlicher Zuschneiden-Effekt, nichts unterscheidet
ihn von einem handgesetzten. Die Signatur ist deshalb **strukturell**: ein
direkt benachbartes Paar Transformieren → Zuschneiden unter den
Standard-Effekten; gibt es mehrere, gilt das letzte.

Bewusst **nicht** „die letzten zwei der Kette". „Splitscreen bauen, dann
Lumetri drauf" ist Alltag. Würde das Plugin sein eigenes Paar danach nicht mehr
erkennen, hängte der nächste Lauf ein zweites an — das Bild zweimal verschoben
und zweimal halbiert, und mit dem Plugin nicht mehr reparierbar. Der Preis ist
der umgekehrte Fall: wer von Hand ein Transformieren direkt gefolgt von einem
Zuschneiden anlegt, bekommt es als Splitscreen erkannt. Das ist die bewusst
gewählte, weniger zerstörerische Seite.

### Erneut ausführen

Ist das Paar vorhanden, entfällt Transaktion 1 vollständig; es werden nur die
Werte überschrieben. Ein zweiter Lauf mit anderem Layout oder getauschter
Zuordnung ist damit ein einzelner Undo-Schritt und stapelt nichts.

### Entfernen

Gelöscht werden ausschließlich unsere beiden Komponenten. Sie werden über die
in Phase 1 ermittelten Paar-Indizes aus der Kette geholt und dann **als
Referenz** gelöscht — dadurch ist die zweite Löschung gegen die
Indexverschiebung der ersten immun. Alles andere bleibt, weil es nie verändert
wurde: ein Punch-In in der Bewegung, Auto Reframe, ein fremder Beschnitt.

Wird kein Paar gefunden, hängt der Report die Effektkette an das Ergebnis —
sonst wäre „Splitscreen unter unerkanntem Effektnamen" nicht von „gar kein
Splitscreen" zu unterscheiden.

## 8. Design-Entscheidungen und ihre Begründung

### Zwei Transaktionen statt einer

Beim ersten Anwenden sind es zwei Undo-Schritte. Zwei Gründe, mit
unterschiedlicher Belegkraft:

**Belegt:** `VideoFilterFactory.createComponent()` ist asynchron. Die
Komponenten können also nicht innerhalb der Transaktion entstehen.

**Annahme:** Ob sich Parameterwerte in *derselben* Transaktion setzen lassen,
die die Komponente einfügt, ist nicht dokumentiert. Statt darauf zu bauen, wird
getrennt eingefügt und geschrieben. Das Indiz dafür kommt aus dem
Nachbar-Plugin `smooth-auto-frame-uxp`: dort muss die Override-Checkbox des
Auto-Reframe-Effekts in einer eigenen, vorangehenden Transaktion committed
werden, sonst meldet der Lauf Erfolg und Premiere hat nichts geändert — der
Zwischenzustand einer Compound-Action ist für die folgenden Actions offenbar
noch nicht sichtbar. Für *diesen* Code ist das nicht verifiziert, nur plausibel
übertragen.

Dasselbe gilt für das erneute Lesen der Ketten zwischen den Transaktionen:
dass Premiere 26.3 Script-Objekte über asynchrone Grenzen invalidiert, ist im
Nachbar-Plugin dokumentiert, hier aber nicht nachgewiesen. Der unmittelbare
Grund für das Neulesen ist schlichter: wir wollen die Komponenten adressieren,
die wirklich in der Kette stehen.

### Rollback über Referenzen, nicht über Indizes

Scheitert Transaktion 2 oder lässt sich das Paar danach nicht wiederfinden,
werden die eingefügten Effekte automatisch entfernt — über die
Komponenten-Referenzen aus dem Einfügeschritt. Eine index-basierte Variante
griffe ausgerechnet im häufigsten Auslöser nicht, denn „Paar nicht
wiedergefunden" heißt ja: es gibt keine Indizes. Ob das Aufräumen geklappt hat,
sagt der Report; wenn nicht, wird zu Cmd/Ctrl+Z aufgefordert.

### Fail-closed als Grundhaltung

Jede nicht beantwortbare Frage führt zur Ablehnung, nicht zu einem Standardwert.
Der Grund ist asymmetrisch: ein unerkannter Parameter „Drehung" würde als 0°
gelesen und damit genau die Prüfung aushebeln, die gedrehte Clips abfangen
soll. Ein Abbruch kostet den Nutzer eine Minute, ein stiller Fehlgriff kostet
ihn einen falsch gebauten Schnitt, den er erst beim Ansehen merkt.

### Vorprüfung meldet alle Gründe

Nicht den ersten. Wer drei Dinge in Ordnung bringen muss, soll sie in einem
Durchgang sehen.

### Reine Module

Geometrie, Regelwerk, Ketten-Logik und Wert-Normalisierung kennen Premiere
nicht und arbeiten auf einfachen Werten. Das ist der Grund, warum die
Platzierungsmathematik 100-prozentig getestet werden kann, obwohl das Plugin
selbst nur in Premiere läuft.

### Code bewusst dupliziert

Das Plugin teilt keinen Code mit `smooth-auto-frame-uxp`, obwohl sich einiges
anbietet. Entscheidung des Projekts: beide Plugins sollen unabhängig
weiterentwickelt und einzeln installiert werden können.

### Nachkontrolle statt Vertrauen

Siehe [Abschnitt 6](#die-grenze-der-nachkontrolle). Kurzfassung: ein Commit ist
keine Zusage, dass der Effekt den Wert übernommen hat.

## 9. Ausnahmen, Grenzen und Sonderfälle

### Stark verkleinerte Clips

Unser Transformieren sitzt vor der Bewegung und muss deshalb um
`¼ Frame ÷ Skalierung` verschieben. Je kleiner der Clip skaliert ist, desto
weiter — und was dabei über den Framerand hinausgeschoben wird, ist dort schon
verworfen, bevor die Bewegung es zurückskalieren könnte.

| Skalierung | Ergebnis |
|---|---|
| ≥ 100 % | funktioniert, Hälfte vollständig gefüllt |
| über 25 % bis unter 100 % | Hälfte wird nicht vollständig gefüllt, schwarzer Rand, Hinweis im Report |
| ≤ 25 % | nichts wäre sichtbar, **Abbruch** |

Die Tabelle gilt für eine zentrierte Bewegungs-Position; eine verschobene
verschiebt die Grenzen (siehe unten).

Das ist eine echte Grenze des Ansatzes, keine Nachlässigkeit. Sie wurde durch
die Testsimulation der Render-Pipeline gefunden, nicht durch Nachdenken.

### Auto-reframte Clips

Brauchen **keinen** Sonderfall. Auto Reframe ist ein Standard-Effekt, läuft also
vor uns, und sein Ergebnis ist für uns der aktuelle Look, von dem wir die Mitte
nehmen. Pannt Auto Reframe, wandert das Motiv innerhalb seiner Hälfte — in der
Regel gewollt; wenn nicht, ist das die Aufgabe von `smooth-auto-frame-uxp`.

### Fremder Beschnitt auf dem Clip

Bleibt erhalten und wandert mit. Ein Zuschneiden macht die beschnittenen
Bereiche transparent, ohne die Framegröße zu ändern, unsere Rechnung bleibt
also gültig. Sichtbare Folge: die transparenten Stellen bleiben transparent.

### Verschobene Bewegungs-Position

Wird kompensiert, solange der nötige Bildteil noch im Frame liegt. Ist sie
weiter verschoben, wird der Crop-Wert geklemmt und die Hälfte bleibt teilweise
leer — mit Hinweis im Report. Bei sehr starker Verschiebung klemmt der Wert auf
100 %, das Fenster hat dann die Breite null, und der Lauf **bricht ab**
(dieselbe `CELL_EMPTY`-Bedingung wie bei stark verkleinerten Clips). Beispiel:
Skalierung 100 %, Position x = 2000 px in einem 1920 px breiten Frame.

### Nicht gleichmäßige Skalierung

„Gleichmäßig skalieren" darf aus sein, beide Achsen werden getrennt gerechnet.
Lässt sich die Skalierungsbreite dann nicht lesen, wird der Clip abgelehnt —
mit `scaleX = scaleY` weiterzurechnen hieße, das Ergebnis still zu verzerren.

### Anpassungsebenen, verschachtelte Sequenzen, Standbilder

Werden wie normale Clips behandelt, solange sie eine Effektkette mit
Video-Intrinsics haben.

### Mehrere Paare gleichzeitig

Ein Lauf verarbeitet beliebig viele Paare. Die Gruppierung läuft über die Zeit,
nicht über die Auswahlreihenfolge, ist also unabhängig davon, wie geklickt
wurde.

### Was es nicht gibt

Kein Nesting, keine Animation, keine Trennlinien oder Rahmen, keine ungleiche
Aufteilung, kein 2×2-Grid, mehr als zwei Clips pro Splitscreen nicht, keinen
manuellen Versatz des Bildausschnitts. Alles bewusst ausgeschlossen.

### Bekannte Harness-Grenze

Die Tests nehmen an, dass die beiden Einfüge-Actions nacheinander wirken, `index
+ 1` also die Position hinter dem Transformieren ist. Löste Premiere beide
Indizes gegen den Vor-Zustand auf, entstünde [Zuschneiden, Transformieren] —
der Mock könnte das nicht aufdecken. Gefährlich ist es trotzdem nicht: die
Paar-Erkennung verlangt `crop.index === transform.index + 1`, die verdrehte
Reihenfolge wird also nicht als unser Paar erkannt, der Lauf meldet einen
Lesefehler und der Rollback entfernt beide Komponenten. Es scheitert
geschlossen, aber es ist eine Annahme und keine belegte Tatsache.

## 10. Wo welcher Code steht

| Datei | Zuständigkeit | Premiere nötig? |
|---|---|---|
| `main.js` | Panel, Report-Darstellung, Log-Export | ja |
| `src/core.js` | Premiere-I/O, Transaktionen, Parameter-Auflösung, Erstellen und Entfernen | ja |
| `src/geometry.js` | Platzierungsmathematik und Deckungsvorhersage | nein |
| `src/values.js` | Normalisierung der Host-Werte, Diagnose-Serialisierung | nein |
| `src/pairing.js` | Paarbildung und Vorprüfung | nein |
| `src/chain.js` | Einfügeindex, Paar-Erkennung, matchName-Auflösung | nein |
| `src/constants.js` | matchNames, Parameternamen und -fragmente, Enums | nein |
| `src/diagnostics.js` | Ketten- und Parameter-Dump | ja |

Die vier reinen Module sind direkt testbar; `core.js` wird über einen
gemockten Premiere-Host getestet (`test/mock-premiere.js`), dessen Mock eine
Zustandsmaschine ist: eingereihte Actions werden beim Commit wirklich
angewendet, Einfügen und Entfernen verändern die Effektkette tatsächlich.
Dadurch prüfen die Tests das Ergebnis und nicht die Absicht.
