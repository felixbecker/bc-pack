/*
 * Unit tests for src/geometry.js and src/mediainfo.js.
 *
 * No mock, no harness, no Premiere: this file exercises the parts of the
 * plugin that are pure arithmetic and pure string parsing. That matters
 * because every other test in this project can only prove "the algorithm
 * decided X given a fake host" — these prove the maths itself is right, which
 * is the half that would otherwise rest on nothing but careful reading.
 *
 * IMPORTANT: the format pairs below are TEST FIXTURES, not configuration. The
 * production code contains no format constants at all; it receives two
 * measured rectangles. The fixtures are deliberately varied — square,
 * portrait, 4:3, anamorphic, and a vertical source in a horizontal sequence —
 * so that a format assumption sneaking back into the code would fail a test.
 *
 *   node test/geometry.test.js
 */
const assert = require("assert");
const path = require("path");
const g = require(path.resolve(__dirname, "../src/geometry.js"));
const mediainfo = require(path.resolve(__dirname, "../src/mediainfo.js"));

// --- Fixtures: arbitrary format pairs, none of them privileged by the code --
const SRC_HD = { width: 1920, height: 1080, pixelAspect: 1 }; // 16:9
const SRC_VERTICAL = { width: 1080, height: 1920, pixelAspect: 1 }; // 9:16
/* 720×576 mit PAR 16/9·576/720 ist anamorphes 16:9 — nur über PAR erkennbar. */
const SRC_SD_ANAMORPHIC = { width: 720, height: 576, pixelAspect: 1024 / 720 };
const SRC_4K_CINEMA = { width: 4096, height: 1716, pixelAspect: 1 }; // ~2.39:1

const SEQ_SQUARE = { width: 1080, height: 1080 };
const SEQ_PORTRAIT = { width: 1080, height: 1920 };
const SEQ_LANDSCAPE = { width: 1920, height: 1080 };
const SEQ_43 = { width: 1440, height: 1080 };

const tests = [];
function test(name, fn) {
    tests.push({ name: name, fn: fn });
}
function close(actual, expected, label, epsilon) {
    const tolerance = epsilon === undefined ? 1e-6 : epsilon;
    assert.ok(
        typeof actual === "number" && Math.abs(actual - expected) < tolerance,
        (label || "Wert") + ": erwartet ~" + expected + ", war " + actual
    );
}

/** Builds a sampled path from x values; y constant unless given. */
function pathFrom(xs, y, startTicks, stepTicks) {
    const start = startTicks === undefined ? 0 : startTicks;
    const step = stepTicks === undefined ? 100 : stepTicks;
    return xs.map((x, i) => ({
        ticks: start + i * step,
        position: { x: x, y: y === undefined ? 0.5 : y }
    }));
}

/** Builds a sampled path that drifts vertically instead of horizontally. */
function verticalPathFrom(ys, x) {
    return ys.map((y, i) => ({
        ticks: i * 100,
        position: { x: x === undefined ? 0.5 : x, y: y }
    }));
}

function calibrate(samples, frame, source, extra) {
    const input = Object.assign(
        { summary: g.summarizePath(samples), frame: frame, source: source },
        extra || {}
    );
    return g.detectConvention(input);
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

test("median ist robust gegen Ausreißer, mean nicht", () => {
    const values = [1, 1, 1, 1, 100];
    assert.strictEqual(g.median(values), 1);
    assert.strictEqual(g.mean(values), 20.8);
    // Das ist der ganze Grund, warum der Median die Voreinstellung ist.
});

test("median mittelt bei gerader Anzahl", () => {
    assert.strictEqual(g.median([1, 2, 3, 4]), 2.5);
    assert.strictEqual(g.median([]), null);
});

test("describeSeries liefert Spanne, Median und Randwerte", () => {
    const series = g.describeSeries([0.5, 0.7, 0.6]);
    assert.strictEqual(series.count, 3);
    assert.strictEqual(series.min, 0.5);
    assert.strictEqual(series.max, 0.7);
    close(series.span, 0.2, "span");
    assert.strictEqual(series.median, 0.6);
    assert.strictEqual(series.first, 0.5);
    assert.strictEqual(series.last, 0.6);
});

test("describeSeries ignoriert NaN, Infinity und Nicht-Zahlen", () => {
    const series = g.describeSeries([0.5, NaN, Infinity, 0.7, "nope"]);
    assert.strictEqual(series.count, 2);
    assert.strictEqual(series.min, 0.5);
    assert.strictEqual(series.max, 0.7);
});

test("summarizePath trennt x, y, scale und rotation", () => {
    const samples = [
        { ticks: 0, position: { x: 0.6, y: 0.5 }, scale: 100, rotation: 0 },
        { ticks: 10, position: { x: 0.8, y: 0.5 }, scale: 100, rotation: 0 }
    ];
    const summary = g.summarizePath(samples);
    assert.strictEqual(summary.samples, 2);
    close(summary.x.span, 0.2, "x.span");
    assert.strictEqual(summary.y.span, 0);
    assert.strictEqual(summary.scale.span, 0);
});

// ---------------------------------------------------------------------------
// Format geometry — no format is hardcoded, everything derives from two rects
// ---------------------------------------------------------------------------

test("aspectOf berücksichtigt das Pixel-Seitenverhältnis", () => {
    close(g.aspectOf(SRC_HD), 16 / 9, "16:9");
    close(g.aspectOf(SEQ_SQUARE), 1, "1:1");
    // 720×576 ist als Speicherformat 5:4; erst mit PAR wird daraus 16:9.
    close(g.aspectOf({ width: 720, height: 576, pixelAspect: 1 }), 1.25, "ohne PAR");
    close(g.aspectOf(SRC_SD_ANAMORPHIC), 16 / 9, "mit PAR");
    assert.strictEqual(g.aspectOf({ width: 0, height: 100 }), null);
    assert.strictEqual(g.aspectOf(null), null);
});

test("pinnedAxis: breitere Quelle -> vertikal festgenagelt", () => {
    assert.strictEqual(g.pinnedAxis(g.aspectOf(SRC_HD), g.aspectOf(SEQ_SQUARE)), "y");
    assert.strictEqual(g.pinnedAxis(g.aspectOf(SRC_HD), g.aspectOf(SEQ_PORTRAIT)), "y");
    assert.strictEqual(g.pinnedAxis(g.aspectOf(SRC_4K_CINEMA), g.aspectOf(SEQ_43)), "y");
});

test("pinnedAxis: höhere Quelle -> horizontal festgenagelt", () => {
    // Der umgekehrte Fall: 9:16-Quelle in eine 16:9-Sequenz.
    assert.strictEqual(g.pinnedAxis(g.aspectOf(SRC_VERTICAL), g.aspectOf(SEQ_LANDSCAPE)), "x");
    assert.strictEqual(g.pinnedAxis(g.aspectOf(SRC_VERTICAL), g.aspectOf(SEQ_SQUARE)), "x");
});

test("pinnedAxis: gleiches Seitenverhältnis -> beide Achsen", () => {
    assert.strictEqual(g.pinnedAxis(g.aspectOf(SRC_HD), g.aspectOf(SEQ_LANDSCAPE)), "both");
    // Anamorphes SD in 16:9 ist ebenfalls formatgleich — nur dank PAR erkennbar.
    assert.strictEqual(
        g.pinnedAxis(g.aspectOf(SRC_SD_ANAMORPHIC), g.aspectOf(SEQ_LANDSCAPE)),
        "both"
    );
});

test("pinnedAxis ohne bekanntes Format liefert null statt zu raten", () => {
    assert.strictEqual(g.pinnedAxis(null, g.aspectOf(SEQ_SQUARE)), null);
    assert.strictEqual(g.pinnedAxis(g.aspectOf(SRC_HD), null), null);
});

test("freeAxis ist die Gegenachse von pinnedAxis", () => {
    assert.strictEqual(g.freeAxis(g.aspectOf(SRC_HD), g.aspectOf(SEQ_PORTRAIT)), "x");
    assert.strictEqual(g.freeAxis(g.aspectOf(SRC_VERTICAL), g.aspectOf(SEQ_LANDSCAPE)), "y");
    assert.strictEqual(g.freeAxis(g.aspectOf(SRC_HD), g.aspectOf(SEQ_LANDSCAPE)), null);
});

test("cropHalfRange: 16:9 in 1:1 erlaubt ±0,3889 Bildbreiten, vertikal nichts", () => {
    const range = g.cropHalfRange(g.aspectOf(SRC_HD), g.aspectOf(SEQ_SQUARE));
    close(range.x, 0.388889, "x", 1e-5);
    assert.strictEqual(range.y, 0);
});

test("cropHalfRange: 16:9 in 9:16 erlaubt deutlich mehr", () => {
    const range = g.cropHalfRange(g.aspectOf(SRC_HD), g.aspectOf(SEQ_PORTRAIT));
    close(range.x, 1.080247, "x", 1e-5);
    assert.strictEqual(range.y, 0);
});

test("cropHalfRange: 9:16 in 16:9 erlaubt vertikalen Spielraum", () => {
    const range = g.cropHalfRange(g.aspectOf(SRC_VERTICAL), g.aspectOf(SEQ_LANDSCAPE));
    assert.strictEqual(range.x, 0);
    close(range.y, 1.080247, "y", 1e-5);
});

test("cropHalfRange: formatgleich -> kein Spielraum auf beiden Achsen", () => {
    const range = g.cropHalfRange(g.aspectOf(SRC_HD), g.aspectOf(SEQ_LANDSCAPE));
    assert.strictEqual(range.x, 0);
    assert.strictEqual(range.y, 0);
});

test("fillScalePercent gilt für beliebige Formate, auch anamorph", () => {
    close(g.fillScalePercent(SRC_HD, SEQ_SQUARE), 100, "16:9 -> 1:1");
    close(g.fillScalePercent(SRC_HD, SEQ_PORTRAIT), 177.7777, "16:9 -> 9:16", 1e-3);
    close(g.fillScalePercent(SRC_VERTICAL, SEQ_LANDSCAPE), 177.7777, "9:16 -> 16:9", 1e-3);
    // Anamorphes SD: 720 Pixel breit, aber 1050 Pixel BREIT dargestellt.
    close(g.fillScalePercent(SRC_SD_ANAMORPHIC, SEQ_LANDSCAPE), 187.5, "SD -> HD", 0.2);
    assert.strictEqual(g.fillScalePercent(null, SEQ_SQUARE), null);
});

test("formatAspect benennt gängige Formate, sonst numerisch", () => {
    assert.strictEqual(g.formatAspect(16 / 9), "16:9");
    assert.strictEqual(g.formatAspect(1), "1:1");
    assert.strictEqual(g.formatAspect(9 / 16), "9:16");
    assert.strictEqual(g.formatAspect(4 / 3), "4:3");
    assert.strictEqual(g.formatAspect(1.5), "1.500:1");
    assert.strictEqual(g.formatAspect(null), "unbekannt");
});

// ---------------------------------------------------------------------------
// Calibration — the heart of the plugin, and format-agnostic
// ---------------------------------------------------------------------------

test("Kalibrierung 16:9 -> 1:1: vertikaler Prüfwert ~0,5 = Motion-Normierung", () => {
    const result = calibrate(pathFrom([0.68, 0.70, 0.72], 0.5), SEQ_SQUARE, SRC_HD);
    assert.strictEqual(result.convention, g.CONVENTION.FRAME_NORMALIZED);
    assert.strictEqual(result.geometry.pinnedAxis, "y");
});

test("Kalibrierung 16:9 -> 9:16 funktioniert mit demselben Code", () => {
    const result = calibrate(pathFrom([0.2, 0.3, 0.4], 0.5), SEQ_PORTRAIT, SRC_HD);
    assert.strictEqual(result.convention, g.CONVENTION.FRAME_NORMALIZED);
    assert.strictEqual(result.geometry.pinnedAxis, "y");
});

test("Kalibrierung 9:16 -> 16:9: die HORIZONTALE ist jetzt der Prüfwert", () => {
    /*
     * Der umgekehrte Fall. Hier wandert y und x liegt fest — eine Umsetzung,
     * die fest auf die Vertikale prüft, scheitert an diesem Test.
     */
    const result = calibrate(verticalPathFrom([0.3, 0.4, 0.5], 0.5), SEQ_LANDSCAPE, SRC_VERTICAL);
    assert.strictEqual(result.geometry.pinnedAxis, "x");
    assert.strictEqual(result.convention, g.CONVENTION.FRAME_NORMALIZED);
    assert.ok(
        result.probes.some((p) => p.name === "pinnedAxis:x"),
        "die horizontale Achse wurde nicht als Prüfwert benutzt: " +
            result.probes.map((p) => p.name).join(", ")
    );
});

test("Kalibrierung 4:3-Sequenz aus 2.39:1-Quelle", () => {
    const result = calibrate(pathFrom([0.4, 0.5, 0.6], 0.5), SEQ_43, SRC_4K_CINEMA);
    assert.strictEqual(result.geometry.pinnedAxis, "y");
    assert.strictEqual(result.convention, g.CONVENTION.FRAME_NORMALIZED);
});

test("Kalibrierung: Prüfwert ~0 = Versatz zur Bildmitte", () => {
    const result = calibrate(pathFrom([0.18, 0.2, 0.22], 0.0), SEQ_SQUARE, SRC_HD);
    assert.strictEqual(result.convention, g.CONVENTION.CENTER_RELATIVE);
});

test("Kalibrierung: Prüfwert ~Bildhöhe/2 = Sequenzpixel", () => {
    const result = calibrate(pathFrom([700, 720, 740], 540), SEQ_SQUARE, SRC_HD);
    assert.strictEqual(result.convention, g.CONVENTION.PIXELS);
});

test("Kalibrierung: unpassender Prüfwert -> UNKNOWN, niemals raten", () => {
    const result = calibrate(pathFrom([0.7, 0.72], 7.3), SEQ_SQUARE, SRC_HD);
    assert.strictEqual(result.convention, g.CONVENTION.UNKNOWN);
    assert.strictEqual(result.confidence, "none");
});

test("Kalibrierung: Ankerpunkt als zweite, unabhängige Prüfung", () => {
    const withAnchor = calibrate(pathFrom([0.68, 0.7], 0.5), SEQ_SQUARE, SRC_HD, {
        anchor: { x: 0.5, y: 0.5 }
    });
    assert.strictEqual(withAnchor.convention, g.CONVENTION.FRAME_NORMALIZED);
    assert.strictEqual(withAnchor.confidence, "cross-checked");
    assert.ok(withAnchor.probes.some((p) => p.name === "anchorPoint"));
});

test("Kalibrierung: gemessene Füllskalierung als dritte Prüfung", () => {
    // 16:9 in 1:1 erwartet 100 % — der Effekt meldet 100 %, also stimmig.
    const result = calibrate(pathFrom([0.68, 0.7], 0.5), SEQ_SQUARE, SRC_HD, {
        measuredScale: 100
    });
    assert.ok(
        result.probes.some((p) => p.name === "fillScale"),
        "fillScale-Prüfung fehlt: " + result.probes.map((p) => p.name).join(", ")
    );
    assert.strictEqual(result.confidence, "cross-checked");
    close(result.geometry.expectedFillScalePercent, 100, "erwartete Skalierung");
});

test("Kalibrierung: abweichende Skalierung wird vermerkt, nicht als Prüfung gezählt", () => {
    const result = calibrate(pathFrom([0.68, 0.7], 0.5), SEQ_SQUARE, SRC_HD, {
        measuredScale: 140
    });
    assert.ok(!result.probes.some((p) => p.name === "fillScale"));
    assert.ok(result.reasons.join(" ").includes("weicht von der erwarteten"));
});

test("Kalibrierung: ohne Quellformat greift der Ankerpunkt", () => {
    const result = calibrate(pathFrom([0.68, 0.7], 0.5), SEQ_SQUARE, null, {
        anchor: { x: 0.5, y: 0.5 }
    });
    assert.strictEqual(result.convention, g.CONVENTION.FRAME_NORMALIZED);
    assert.strictEqual(result.geometry.sourceAspectKnown, false);
    assert.ok(result.reasons.join(" ").includes("Quellformat ließ sich nicht"));
});

test("Kalibrierung: ohne Quellformat und ohne Anker nur schwache Prüfung", () => {
    // x wandert deutlich, y liegt still -> y ist vermutlich die feste Achse.
    const result = calibrate(pathFrom([0.3, 0.5, 0.7], 0.5), SEQ_SQUARE, null);
    assert.strictEqual(result.convention, g.CONVENTION.FRAME_NORMALIZED);
    assert.strictEqual(result.confidence, "weak");
    assert.ok(result.probes.some((p) => p.name === "staticAxis:y"));
});

test("Kalibrierung: beide Achsen still und kein Format -> keine Prüfung", () => {
    // Nichts bewegt sich, also sagt auch die unbewegte Achse nichts aus.
    const result = calibrate(pathFrom([0.68, 0.70, 0.72], 0.5), SEQ_SQUARE, null);
    assert.strictEqual(result.convention, g.CONVENTION.UNKNOWN);
});

test("Kalibrierung: gar keine Prüfung möglich -> UNKNOWN", () => {
    // Beide Achsen wandern, kein Quellformat, kein Anker: nichts zu messen.
    const samples = [
        { ticks: 0, position: { x: 0.3, y: 0.3 } },
        { ticks: 10, position: { x: 0.7, y: 0.7 } }
    ];
    const result = calibrate(samples, SEQ_SQUARE, null);
    assert.strictEqual(result.convention, g.CONVENTION.UNKNOWN);
    assert.strictEqual(result.confidence, "none");
});

test("Kalibrierung ohne lesbare Werte -> UNKNOWN", () => {
    const result = calibrate([], SEQ_SQUARE, SRC_HD);
    assert.strictEqual(result.convention, g.CONVENTION.UNKNOWN);
});

test("Kalibrierung: Formatgeometrie widerspricht der Messung -> Hinweis", () => {
    /*
     * Laut Formaten müsste y festliegen, die Messung zeigt aber Wandern.
     * Das darf nicht verschwiegen werden: dann passen die gelesenen Formate
     * nicht zu dem, was der Effekt verarbeitet.
     */
    const result = calibrate(verticalPathFrom([0.40, 0.62], 0.6), SEQ_SQUARE, SRC_HD);
    assert.ok(
        result.reasons.join(" ").includes("müsste laut Formatgeometrie festliegen"),
        result.reasons.join(" ")
    );
});

test("REGRESSION: 0,5 und 0 dürfen nicht verwechselt werden", () => {
    // Die Hypothesen liegen 0,5 auseinander; die Toleranz muss sie sicher
    // trennen, sonst wird ein um eine halbe Bildbreite versetzter Ausschnitt
    // geschrieben.
    assert.ok(g.PROBE_TOLERANCE < 0.25, "Toleranz zu groß: " + g.PROBE_TOLERANCE);
    const atHalf = calibrate(pathFrom([0.6], 0.5), SEQ_SQUARE, SRC_HD);
    const atZero = calibrate(pathFrom([0.1], 0.0), SEQ_SQUARE, SRC_HD);
    assert.strictEqual(atHalf.convention, g.CONVENTION.FRAME_NORMALIZED);
    assert.strictEqual(atZero.convention, g.CONVENTION.CENTER_RELATIVE);
});

test("Bereichsprüfung schließt eine geometrisch unmögliche Konvention aus", () => {
    /*
     * Prüfwert 0,0 vertikal passt auf CENTER_RELATIVE. Horizontal reichen die
     * Werte aber bis 1,2 — als Versatz gelesen landet der Ausschnitt bei 1,7
     * Bildbreiten, weit außerhalb des für 16:9 in 1:1 Möglichen (±0,389).
     * Die Falsifikation muss das erkennen.
     */
    const summary = g.summarizePath(pathFrom([0.1, 1.2], 0.0));
    const test1 = g.rangeTest(
        summary,
        g.CONVENTION.CENTER_RELATIVE,
        SEQ_SQUARE,
        g.cropHalfRange(g.aspectOf(SRC_HD), g.aspectOf(SEQ_SQUARE))
    );
    assert.strictEqual(test1.passed, false);
    assert.ok(test1.failures.length > 0);
});

test("Bereichsprüfung lässt die geometrisch möglichen Werte durch", () => {
    const summary = g.summarizePath(pathFrom([0.45, 0.55], 0.5));
    const result = g.rangeTest(
        summary,
        g.CONVENTION.FRAME_NORMALIZED,
        SEQ_SQUARE,
        g.cropHalfRange(g.aspectOf(SRC_HD), g.aspectOf(SEQ_SQUARE))
    );
    assert.strictEqual(result.passed, true);
});

test("hypothesesForCentre skaliert Pixelabstände vergleichbar", () => {
    const atCentre = g.hypothesesForCentre(0.5, 1080);
    assert.ok(atCentre.some((h) => h.convention === g.CONVENTION.FRAME_NORMALIZED));
    const atPixelCentre = g.hypothesesForCentre(540, 1080);
    assert.ok(atPixelCentre.some((h) => h.convention === g.CONVENTION.PIXELS));
    // 540 ist weit weg von 0,5 und 0 — nur die Pixel-Hypothese darf passen.
    assert.strictEqual(atPixelCentre.length, 1);
    assert.deepStrictEqual(g.hypothesesForCentre(NaN, 1080), []);
});

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

test("toMotionPosition rechnet jede Konvention korrekt um", () => {
    const point = { x: 0.68, y: 0.5 };
    const check = (actual, x, y, label) => {
        assert.ok(actual, label + ": null");
        close(actual.x, x, label + " x");
        close(actual.y, y, label + " y");
    };
    check(g.toMotionPosition(point, g.CONVENTION.FRAME_NORMALIZED, SEQ_SQUARE), 0.68, 0.5, "normiert");
    check(
        g.toMotionPosition({ x: 0.18, y: 0 }, g.CONVENTION.CENTER_RELATIVE, SEQ_SQUARE),
        0.68,
        0.5,
        "mittenrelativ"
    );
    check(
        g.toMotionPosition({ x: 734.4, y: 540 }, g.CONVENTION.PIXELS, SEQ_SQUARE),
        0.68,
        0.5,
        "pixel"
    );
    assert.strictEqual(g.toMotionPosition(point, g.CONVENTION.UNKNOWN, SEQ_SQUARE), null);
    assert.strictEqual(g.toMotionPosition(null, g.CONVENTION.FRAME_NORMALIZED, SEQ_SQUARE), null);
});

test("toMotionPosition nutzt pro Achse die richtige Bilddimension", () => {
    // Nicht-quadratische Sequenz: x muss durch die Breite, y durch die Höhe.
    const result = g.toMotionPosition({ x: 540, y: 960 }, g.CONVENTION.PIXELS, SEQ_PORTRAIT);
    close(result.x, 0.5, "x");
    close(result.y, 0.5, "y");
});

test("normalizeSummary skaliert Pixel, verschiebt aber keinen Ursprung", () => {
    const summary = g.summarizePath(pathFrom([540, 648], 540));
    const normalized = g.normalizeSummary(summary, g.CONVENTION.PIXELS, SEQ_SQUARE);
    close(normalized.x.span, 0.1, "Pixelspanne");
    close(normalized.x.min, 0.5, "Pixelminimum");
    // Eine Spanne ist eine Differenz: der +0,5-Versatz darf NICHT angewandt
    // werden, sonst wird die Drift um eine halbe Bildbreite überschätzt.
    const relative = g.normalizeSummary(
        g.summarizePath(pathFrom([0.1, 0.2], 0)),
        g.CONVENTION.CENTER_RELATIVE,
        SEQ_SQUARE
    );
    close(relative.x.span, 0.1, "mittenrelative Spanne");
});

test("describeDrift übersetzt die Spanne in Pixel der jeweiligen Achse", () => {
    const summary = g.summarizePath(pathFrom([0.60, 0.65], 0.5));
    const drift = g.describeDrift(summary, SEQ_SQUARE);
    close(drift.xPixels, 54, "xPixels");
    assert.strictEqual(drift.yPixels, 0);
    close(drift.peakPixels, 54, "peakPixels");
    close(drift.xPercentOfWidth, 5, "Prozent");

    // Dieselbe normierte Spanne ergibt in einer höheren Sequenz mehr y-Pixel.
    const vertical = g.describeDrift(g.summarizePath(verticalPathFrom([0.5, 0.6])), SEQ_PORTRAIT);
    close(vertical.yPixels, 192, "yPixels in 1080×1920");
});

// ---------------------------------------------------------------------------
// Reference-frame selection
// ---------------------------------------------------------------------------

test("Referenz start/end nehmen den ersten bzw. letzten Abtastpunkt", () => {
    const samples = pathFrom([0.1, 0.2, 0.3]);
    assert.strictEqual(g.pickReference(samples, g.REFERENCE.START, {}).sample.position.x, 0.1);
    assert.strictEqual(g.pickReference(samples, g.REFERENCE.END, {}).sample.position.x, 0.3);
});

test("REGRESSION: 'Mitte' ist die ZEITLICHE Mitte, nicht der mittlere Eintrag", () => {
    /*
     * Abtastpunkte bei 0, 5, 10 und 100 Ticks. Der mittlere EINTRAG wäre
     * Index 1 (5 Ticks); die zeitliche Mitte des Clips liegt bei 50 Ticks und
     * der nächstliegende Punkt ist Index 2 (10 Ticks).
     */
    const samples = [
        { ticks: 0, position: { x: 0.1, y: 0.5 } },
        { ticks: 5, position: { x: 0.2, y: 0.5 } },
        { ticks: 10, position: { x: 0.3, y: 0.5 } },
        { ticks: 100, position: { x: 0.4, y: 0.5 } }
    ];
    const result = g.pickReference(samples, g.REFERENCE.MIDDLE, { inTicks: 0, outTicks: 100 });
    assert.strictEqual(result.index, 2, "Index " + result.index + " gewählt");
    assert.strictEqual(result.sample.position.x, 0.3);
});

test("Referenz playhead nimmt den nächstliegenden Abtastpunkt", () => {
    const samples = pathFrom([0.1, 0.2, 0.3], 0.5, 0, 100);
    const result = g.pickReference(samples, g.REFERENCE.PLAYHEAD, {
        inTicks: 0,
        outTicks: 200,
        playheadTicks: 190
    });
    assert.strictEqual(result.sample.ticks, 200);
});

test("Referenz playhead ohne Abspielposition liefert null statt zu raten", () => {
    assert.strictEqual(g.pickReference(pathFrom([0.1, 0.2]), g.REFERENCE.PLAYHEAD, {}), null);
});

test("Median wählt einen ECHTEN Abtastpunkt, nie einen interpolierten Wert", () => {
    const samples = pathFrom([0.50, 0.52, 0.54, 1.00, 1.02, 1.04]);
    const result = g.pickReference(samples, g.REFERENCE.MEDIAN, {});
    const xs = samples.map((s) => s.position.x);
    assert.ok(
        xs.indexOf(result.sample.position.x) !== -1,
        "geschrieben würde " + result.sample.position.x + ", das ist kein echter Abtastpunkt"
    );
});

test("Median und Mittelwert unterscheiden sich bei schiefer Verteilung", () => {
    const samples = pathFrom([0.1, 0.2, 0.3, 0.4, 5.0]);
    assert.strictEqual(g.pickReference(samples, g.REFERENCE.MEDIAN, {}).sample.position.x, 0.3);
    assert.strictEqual(g.pickReference(samples, g.REFERENCE.MEAN, {}).sample.position.x, 0.4);
});

test("Median landet im dominanten Cluster, nicht auf dem Ausreißer", () => {
    const result = g.pickReference(pathFrom([0.70, 0.70, 0.71, 0.70, 3.0]), g.REFERENCE.MEDIAN, {});
    assert.ok(result.sample.position.x < 0.8, "gewählt: " + result.sample.position.x);
});

test("Unbekannte Referenz-Option fällt auf den Median zurück (Whitelist)", () => {
    const result = g.pickReference(pathFrom([0.1, 0.9, 0.5]), "evil(); //", {});
    assert.strictEqual(result.method, g.REFERENCE.MEDIAN);
});

test("pickReference auf leerer Liste liefert null", () => {
    assert.strictEqual(g.pickReference([], g.REFERENCE.MEDIAN, {}), null);
    assert.strictEqual(g.pickReference(null, g.REFERENCE.MEDIAN, {}), null);
});

// ---------------------------------------------------------------------------
// Plausibility
// ---------------------------------------------------------------------------

test("Plausibilität: Werte außerhalb des geometrisch Möglichen warnen", () => {
    const summary = g.summarizePath(pathFrom([0.05, 0.95], 0.5));
    const result = g.plausibility(summary, SEQ_SQUARE, SRC_HD);
    assert.ok(result.warnings.length > 0, "keine Warnung erzeugt");
    assert.ok(result.warnings.join(" ").includes("außerhalb"));
    close(result.info.cropHalfRange.x, 0.388889, "halbe Spanne", 1e-5);
});

test("Plausibilität: Werte im möglichen Bereich warnen nicht", () => {
    const result = g.plausibility(g.summarizePath(pathFrom([0.60, 0.70], 0.5)), SEQ_SQUARE, SRC_HD);
    assert.strictEqual(result.warnings.length, 0, result.warnings.join(" "));
});

test("Plausibilität nennt beide gemessenen Formate im Klartext", () => {
    const result = g.plausibility(g.summarizePath(pathFrom([0.6], 0.5)), SEQ_PORTRAIT, SRC_HD);
    assert.strictEqual(result.info.sourceAspectLabel, "16:9");
    assert.strictEqual(result.info.frameAspectLabel, "9:16");
    assert.strictEqual(result.info.sourceMeasured, true);
});

test("Plausibilität: fehlendes Quellformat wird als Einschränkung gemeldet", () => {
    const result = g.plausibility(g.summarizePath(pathFrom([0.6], 0.5)), SEQ_SQUARE, null);
    assert.strictEqual(result.info.sourceMeasured, false);
    assert.ok(result.warnings.join(" ").includes("Quellformat"));
});

test("Plausibilität: formatgleiche Quelle hat nichts zu wählen", () => {
    const result = g.plausibility(
        g.summarizePath(pathFrom([0.5], 0.5)),
        SEQ_LANDSCAPE,
        SRC_HD
    );
    assert.ok(result.warnings.join(" ").includes("dasselbe Seitenverhältnis"));
});

test("Plausibilität: variierende Skalierung wird gemeldet", () => {
    const samples = [
        { ticks: 0, position: { x: 0.6, y: 0.5 }, scale: 100 },
        { ticks: 10, position: { x: 0.62, y: 0.5 }, scale: 118 }
    ];
    const result = g.plausibility(g.summarizePath(samples), SEQ_SQUARE, SRC_HD);
    assert.ok(result.warnings.join(" ").includes("Skalierung"), result.warnings.join(" "));
});

// ---------------------------------------------------------------------------
// Source format parsing (src/mediainfo.js)
// ---------------------------------------------------------------------------

test("parseVideoInfoValue liest Maße und Pixel-Seitenverhältnis", () => {
    const parsed = mediainfo.parseVideoInfoValue("1920 x 1080 (1.0)");
    assert.deepStrictEqual(parsed, { width: 1920, height: 1080, pixelAspect: 1 });
    const anamorphic = mediainfo.parseVideoInfoValue("720 x 576 (1.4587)");
    assert.strictEqual(anamorphic.pixelAspect, 1.4587);
});

test("parseVideoInfoValue akzeptiert das Mal-Zeichen und fehlende PAR", () => {
    assert.deepStrictEqual(mediainfo.parseVideoInfoValue("3840×2160"), {
        width: 3840,
        height: 2160,
        pixelAspect: 1
    });
});

test("parseVideoInfoValue verwirft unplausible Maße", () => {
    assert.strictEqual(mediainfo.parseVideoInfoValue("4 x 3"), null);
    assert.strictEqual(mediainfo.parseVideoInfoValue("kein Format"), null);
    assert.strictEqual(mediainfo.parseVideoInfoValue(null), null);
});

test("parseSourceFrame findet das benannte Feld in XML und JSON", () => {
    const xml =
        '<premierePrivateProjectMetaData:Column.Intrinsic.VideoInfo>1080 x 1920 (1.0)' +
        "</premierePrivateProjectMetaData:Column.Intrinsic.VideoInfo>";
    const fromXml = mediainfo.parseSourceFrame(xml);
    assert.strictEqual(fromXml.width, 1080);
    assert.strictEqual(fromXml.height, 1920);
    assert.strictEqual(fromXml.via, "Column.Intrinsic.VideoInfo");

    const json = '{"Column.Intrinsic.VideoInfo":"4096 x 1716 (1.0)","Other":"x"}';
    const fromJson = mediainfo.parseSourceFrame(json);
    assert.strictEqual(fromJson.width, 4096);
    assert.strictEqual(fromJson.height, 1716);
});

test("parseSourceFrame bevorzugt das benannte Feld vor einem früheren Treffer", () => {
    const text =
        '{"Column.Intrinsic.MediaStart":"00:00:00:00",' +
        '"Column.Intrinsic.VideoInfo":"1920 x 1080 (1.0)"}';
    const parsed = mediainfo.parseSourceFrame(text);
    assert.strictEqual(parsed.width, 1920);
    assert.strictEqual(parsed.via, "Column.Intrinsic.VideoInfo");
});

test("parseSourceFrame markiert die Mustersuche als unsicher", () => {
    const parsed = mediainfo.parseSourceFrame("irgendwas 1920 x 1080 irgendwas");
    assert.strictEqual(parsed.width, 1920);
    assert.ok(parsed.via.includes("unsicher"), parsed.via);
});

test("parseSourceFrame gibt null zurück, statt ein Format zu erfinden", () => {
    assert.strictEqual(mediainfo.parseSourceFrame(""), null);
    assert.strictEqual(mediainfo.parseSourceFrame(null), null);
    assert.strictEqual(mediainfo.parseSourceFrame("{}"), null);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

console.log("\n--- geometry.js + mediainfo.js (reine Unit-Tests, keine Premiere-API) ---");
let failures = 0;
for (const entry of tests) {
    try {
        entry.fn();
        console.log("  PASS  " + entry.name);
    } catch (error) {
        failures++;
        console.log("  FAIL  " + entry.name + "\n        " + error.message);
    }
}
console.log(
    failures === 0
        ? "\n  " + tests.length + " Tests bestanden\n"
        : "\n  " + failures + " von " + tests.length + " TESTS FEHLGESCHLAGEN\n"
);
process.exit(failures === 0 ? 0 : 1);
