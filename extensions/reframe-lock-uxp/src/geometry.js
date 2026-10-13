/**
 * Reframe Lock — src/geometry.js
 *
 * Pure math and calibration. Imports NOTHING from Premiere, takes plain
 * numbers and returns plain numbers, and is therefore fully unit-testable
 * without any mock. Everything in this file is provable on a laptop; only
 * src/premiere.js and src/core.js depend on host behaviour.
 *
 * ===========================================================================
 * NO FORMAT IS ASSUMED ANYWHERE IN THIS FILE
 *
 * Both rectangles are inputs, measured at runtime: the sequence frame comes
 * from the sequence settings, the source frame from the clip's media. Square,
 * portrait, 4:3, anamorphic, 2.39:1, vertical source into a horizontal
 * sequence — all of it is just two aspect ratios to this code. There is no
 * 16:9 constant, no 1:1 branch and no 9:16 branch.
 *
 * ===========================================================================
 * THE PROBLEM THIS FILE SOLVES
 *
 * Auto Reframe reports its chosen crop as a position value per frame. We want
 * to write ONE of those values into the clip's Motion effect, which is
 * documented to take normalized 0..1 coordinates with (0.5, 0.5) = frame
 * centre. What is NOT documented is the convention Auto Reframe reports in.
 * Guessing it would mean a silently wrong crop.
 *
 * So the convention is measured, using a fact that holds for ANY pair of
 * formats: a fill-crop has freedom along exactly one axis.
 *
 *   Scaling a source to cover the frame means one dimension matches the frame
 *   exactly and the other overhangs. The crop can only slide along the
 *   overhanging axis; along the other one it is pinned to the centre, because
 *   there is no slack. Which axis that is follows from the two aspect ratios:
 *
 *     sourceAspect > frameAspect  ->  source is wider   ->  Y is pinned
 *     sourceAspect < frameAspect  ->  source is taller  ->  X is pinned
 *     sourceAspect = frameAspect  ->  both are pinned
 *
 *   Whatever number the effect reports along the PINNED axis therefore means
 *   "centre", and that reveals the convention:
 *
 *     reports ~0.5          -> same normalization as Motion     (direct copy)
 *     reports ~0            -> offset from centre               (add 0.5)
 *     reports ~length/2     -> absolute pixels                  (divide)
 *     reports anything else -> unknown; refuse to write
 *
 * Three further independent probes cross-check that conclusion (the effect's
 * anchor point, the measured-vs-expected fill scale, and a falsification test
 * that throws out any convention which would place the crop outside the source
 * image). Probes vote; agreement raises confidence, disagreement lowers it,
 * and no probe at all means nothing is written.
 */

/** Coordinate conventions a host parameter might report in. */
const CONVENTION = {
    /** (0.5, 0.5) = frame centre, 1.0 = one frame width. Motion's convention. */
    FRAME_NORMALIZED: "frameNormalized",
    /** (0, 0) = frame centre, in frame widths/heights. */
    CENTER_RELATIVE: "centerRelative",
    /** Absolute pixels. */
    PIXELS: "pixels",
    /** Could not be determined — never write in this case. */
    UNKNOWN: "unknown"
};

const CONVENTION_VALUES = [
    CONVENTION.FRAME_NORMALIZED,
    CONVENTION.CENTER_RELATIVE,
    CONVENTION.PIXELS
];

/** Reference-frame selection strategies. */
const REFERENCE = {
    START: "start",
    MIDDLE: "middle",
    END: "end",
    PLAYHEAD: "playhead",
    /** Sample closest to the component-wise median. Default. */
    MEDIAN: "median",
    MEAN: "mean"
};

const REFERENCE_VALUES = [
    REFERENCE.START,
    REFERENCE.MIDDLE,
    REFERENCE.END,
    REFERENCE.PLAYHEAD,
    REFERENCE.MEDIAN,
    REFERENCE.MEAN
];

const AXIS = { X: "x", Y: "y", BOTH: "both" };

/**
 * How far a probe may deviate from a hypothesis, in frame widths/heights.
 *
 * Auto Reframe may bias the crop slightly off-centre along the pinned axis
 * (headroom, safe margins), so this is deliberately loose. It only has to
 * separate hypotheses that are 0.5 apart, so a 0.15 window leaves a wide
 * margin on both sides and still cannot confuse 0.5 with 0.
 */
const PROBE_TOLERANCE = 0.15;

/** Same tolerance for the pixel hypothesis, relative to the axis length. */
const PIXEL_PROBE_TOLERANCE = 0.15;

/**
 * Above this span (in frame widths/heights) an axis is clearly not pinned.
 * Used to sanity-check the geometric prediction against the measurement, and
 * as the fallback probe when the source format could not be read.
 */
const MAX_PROBE_SPAN = 0.08;

/** Slack allowed when falsifying a convention against the possible crop range. */
const RANGE_SLACK = 0.03;

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function isFiniteNumber(value) {
    return typeof value === "number" && isFinite(value);
}

function isPositive(value) {
    return isFiniteNumber(value) && value > 0;
}

/** Median of a numeric array. Does not mutate the input. */
function median(values) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values) {
    if (!values.length) return null;
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[i];
    return sum / values.length;
}

/**
 * Descriptive statistics for one numeric series.
 * `span` is peak-to-peak, which is the number the user actually perceives as
 * "the picture wobbles by this much".
 */
function describeSeries(values) {
    const usable = values.filter(isFiniteNumber);
    if (!usable.length) return null;
    let min = usable[0];
    let max = usable[0];
    for (let i = 1; i < usable.length; i++) {
        if (usable[i] < min) min = usable[i];
        if (usable[i] > max) max = usable[i];
    }
    return {
        count: usable.length,
        min: min,
        max: max,
        span: max - min,
        median: median(usable),
        mean: mean(usable),
        first: usable[0],
        last: usable[usable.length - 1]
    };
}

// ---------------------------------------------------------------------------
// Format geometry — everything below derives from two measured rectangles
// ---------------------------------------------------------------------------

/**
 * Display aspect ratio of a frame description.
 *
 * `pixelAspect` matters: anamorphic and DV sources store non-square pixels, so
 * width/height alone is the STORAGE aspect, not what the viewer sees. Defaults
 * to 1 when unknown, which is correct for everything shot in the last decade
 * and wrong only in a way that the plausibility report will surface.
 */
function aspectOf(rect) {
    if (!rect || !isPositive(rect.width) || !isPositive(rect.height)) return null;
    const par = isPositive(rect.pixelAspect) ? rect.pixelAspect : 1;
    return (rect.width * par) / rect.height;
}

/**
 * Which axis a fill-crop has NO freedom along.
 *
 * This is the whole basis of the calibration, and it is pure geometry: no
 * format is special-cased, the answer follows from comparing the two aspect
 * ratios. Returns null when either aspect is unknown.
 */
function pinnedAxis(sourceAspect, frameAspect) {
    if (!isPositive(sourceAspect) || !isPositive(frameAspect)) return null;
    // A relative comparison, so a 1-pixel rounding difference in the reported
    // dimensions does not flip the verdict.
    const ratio = sourceAspect / frameAspect;
    if (Math.abs(ratio - 1) < 0.001) return AXIS.BOTH;
    return ratio > 1 ? AXIS.Y : AXIS.X;
}

/** The axis the crop CAN slide along; null when there is none. */
function freeAxis(sourceAspect, frameAspect) {
    const pinned = pinnedAxis(sourceAspect, frameAspect);
    if (pinned === null) return null;
    if (pinned === AXIS.BOTH) return null;
    return pinned === AXIS.Y ? AXIS.X : AXIS.Y;
}

/**
 * Scale, in Premiere's percent, needed to make the source cover the frame.
 *
 * Works for any pair of formats, including a source SMALLER than the frame
 * (then the result is above 100) and a source larger (below 100).
 */
function fillScalePercent(source, frame) {
    if (!source || !frame) return null;
    if (!isPositive(source.width) || !isPositive(source.height)) return null;
    if (!isPositive(frame.width) || !isPositive(frame.height)) return null;
    const par = isPositive(source.pixelAspect) ? source.pixelAspect : 1;
    const displayedWidth = source.width * par;
    const factor = Math.max(frame.width / displayedWidth, frame.height / source.height);
    return factor * 100;
}

/**
 * How far the crop centre can travel from the frame centre before the source
 * edge enters the picture, per axis, in units of the respective frame
 * dimension.
 *
 * Derivation: after a fill-scale, the displayed source measures
 * sourceAspect/frameAspect frame widths horizontally and
 * frameAspect/sourceAspect frame heights vertically. One of those is 1 (the
 * pinned axis) and the other is greater than 1 (the overhang). The usable
 * half-range is half the overhang. Note this needs only the two ASPECTS — not
 * the pixel dimensions — which is what makes it work even when only the
 * aspects could be established.
 */
function cropHalfRange(sourceAspect, frameAspect) {
    if (!isPositive(sourceAspect) || !isPositive(frameAspect)) return null;
    const widthInFrames = sourceAspect / frameAspect;
    const heightInFrames = frameAspect / sourceAspect;
    return {
        x: widthInFrames > 1 ? (widthInFrames - 1) / 2 : 0,
        y: heightInFrames > 1 ? (heightInFrames - 1) / 2 : 0
    };
}

// ---------------------------------------------------------------------------
// Drift summary
// ---------------------------------------------------------------------------

/**
 * Summarizes a sampled transform path.
 *
 * @param {Array<{ticks:number, position:?{x:number,y:number}, scale:?number, rotation:?number}>} samples
 * @returns {Object} per-component statistics
 */
function summarizePath(samples) {
    const xs = [];
    const ys = [];
    const scales = [];
    const rotations = [];

    for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        if (sample.position) {
            if (isFiniteNumber(sample.position.x)) xs.push(sample.position.x);
            if (isFiniteNumber(sample.position.y)) ys.push(sample.position.y);
        }
        if (isFiniteNumber(sample.scale)) scales.push(sample.scale);
        if (isFiniteNumber(sample.rotation)) rotations.push(sample.rotation);
    }

    return {
        samples: samples.length,
        x: describeSeries(xs),
        y: describeSeries(ys),
        scale: describeSeries(scales),
        rotation: describeSeries(rotations)
    };
}

/**
 * Converts a path summary already rescaled to Motion units into pixel drift.
 * This is the headline number: it answers "how much does it actually wobble"
 * in a unit the user can judge, instead of in the effect's internal units.
 */
function describeDrift(normalizedSummary, frame) {
    if (!frame || !isPositive(frame.width) || !isPositive(frame.height)) return null;
    const xSpan = normalizedSummary.x ? normalizedSummary.x.span : 0;
    const ySpan = normalizedSummary.y ? normalizedSummary.y.span : 0;
    const xPx = xSpan * frame.width;
    const yPx = ySpan * frame.height;
    return {
        xPixels: xPx,
        yPixels: yPx,
        peakPixels: Math.sqrt(xPx * xPx + yPx * yPx),
        xPercentOfWidth: xSpan * 100,
        yPercentOfHeight: ySpan * 100
    };
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/** Where "centre" sits along an axis, under each convention. */
function centreFor(convention, axisLength) {
    if (convention === CONVENTION.FRAME_NORMALIZED) return 0.5;
    if (convention === CONVENTION.CENTER_RELATIVE) return 0;
    if (convention === CONVENTION.PIXELS) {
        return isPositive(axisLength) ? axisLength / 2 : null;
    }
    return null;
}

/**
 * Which conventions are compatible with a value that is known to mean
 * "centre" along an axis of the given pixel length.
 *
 * Distances are returned normalized by the axis length so that a pixel
 * hypothesis and a fractional one can be compared on the same scale.
 */
function hypothesesForCentre(value, axisLength) {
    const out = [];
    if (!isFiniteNumber(value)) return out;

    for (let i = 0; i < CONVENTION_VALUES.length; i++) {
        const convention = CONVENTION_VALUES[i];
        const centre = centreFor(convention, axisLength);
        if (centre === null) continue;

        if (convention === CONVENTION.PIXELS) {
            const distance = Math.abs(value - centre) / axisLength;
            if (distance <= PIXEL_PROBE_TOLERANCE) {
                out.push({ convention: convention, distance: distance });
            }
            continue;
        }
        const distance = Math.abs(value - centre);
        if (distance <= PROBE_TOLERANCE) {
            out.push({ convention: convention, distance: distance });
        }
    }
    return out;
}

/**
 * Rescales a value from a convention into Motion's convention along one axis.
 */
function axisToMotion(value, convention, axisLength) {
    if (!isFiniteNumber(value)) return null;
    if (convention === CONVENTION.FRAME_NORMALIZED) return value;
    if (convention === CONVENTION.CENTER_RELATIVE) return value + 0.5;
    if (convention === CONVENTION.PIXELS) {
        return isPositive(axisLength) ? value / axisLength : null;
    }
    return null;
}

/**
 * Falsification test: would this convention put the crop outside the source?
 *
 * Converting the measured path under a candidate convention yields crop
 * centres in Motion units. Those must stay inside the geometrically possible
 * range, otherwise part of the frame would show nothing — which Auto Reframe
 * never produces. A convention that implies the impossible is simply wrong,
 * and this is the one check that can rule one out rather than merely rank it.
 *
 * Returns null when it cannot be evaluated (unknown source aspect).
 */
function rangeTest(summary, convention, frame, halfRange) {
    if (!halfRange || !frame) return null;

    const axes = [
        { key: "x", series: summary.x, length: frame.width, half: halfRange.x },
        { key: "y", series: summary.y, length: frame.height, half: halfRange.y }
    ];

    const failures = [];
    for (let i = 0; i < axes.length; i++) {
        const axis = axes[i];
        if (!axis.series) continue;
        const min = axisToMotion(axis.series.min, convention, axis.length);
        const max = axisToMotion(axis.series.max, convention, axis.length);
        if (min === null || max === null) continue;
        const lower = 0.5 - axis.half - RANGE_SLACK;
        const upper = 0.5 + axis.half + RANGE_SLACK;
        if (min < lower || max > upper) {
            failures.push({
                axis: axis.key,
                measured: { min: min, max: max },
                allowed: { from: lower, to: upper }
            });
        }
    }
    return { passed: failures.length === 0, failures: failures };
}

/**
 * Determines which coordinate convention the sampled position values use.
 *
 * Up to four independent probes are evaluated; each contributes the set of
 * conventions it considers possible, and they vote. See the file header for
 * the reasoning behind each one.
 *
 * @param {Object} input
 * @param {Object} input.summary        output of summarizePath()
 * @param {{width:number,height:number}} input.frame      sequence frame, measured
 * @param {?{width:number,height:number,pixelAspect:number}} input.source  source frame, measured
 * @param {?{x:number,y:number}} input.anchor              effect anchor point, if readable
 * @param {?number} input.measuredScale                    effect scale at the reference time
 * @returns {{convention, confidence, probes, reasons, geometry}}
 */
function detectConvention(input) {
    const summary = input.summary;
    const frame = input.frame;
    const source = input.source || null;
    const anchor = input.anchor || null;

    const reasons = [];
    const probes = [];
    const frameAspect = aspectOf(frame);
    const sourceAspect = aspectOf(source);
    const pinned = pinnedAxis(sourceAspect, frameAspect);
    const free = freeAxis(sourceAspect, frameAspect);
    const halfRange = cropHalfRange(sourceAspect, frameAspect);

    const geometryInfo = {
        frame: frame ? { width: frame.width, height: frame.height } : null,
        frameAspect: frameAspect,
        source: source || null,
        sourceAspect: sourceAspect,
        sourceAspectKnown: sourceAspect !== null,
        pinnedAxis: pinned,
        freeAxis: free,
        cropHalfRange: halfRange,
        expectedFillScalePercent: fillScalePercent(source, frame),
        measuredScalePercent: isFiniteNumber(input.measuredScale) ? input.measuredScale : null
    };

    // ---- Probe 1: the pinned axis means "centre" -----------------------
    if (pinned !== null) {
        const axisKeys = pinned === AXIS.BOTH ? [AXIS.X, AXIS.Y] : [pinned];
        for (let i = 0; i < axisKeys.length; i++) {
            const key = axisKeys[i];
            const series = summary[key];
            if (!series || !isFiniteNumber(series.median)) continue;
            const length = key === AXIS.X ? frame.width : frame.height;
            const candidates = hypothesesForCentre(series.median, length);
            probes.push({
                name: "pinnedAxis:" + key,
                weight: 2,
                value: series.median,
                span: series.span,
                axisLength: length,
                candidates: candidates,
                note:
                    "Die " +
                    (key === AXIS.X ? "horizontale" : "vertikale") +
                    " Achse hat bei " +
                    formatAspect(sourceAspect) +
                    "-Quelle in " +
                    formatAspect(frameAspect) +
                    "-Sequenz keinen Spielraum, ist also mittig; gemeldet wird " +
                    series.median.toFixed(4)
            });

            // The measurement should agree that this axis barely moves. If it
            // does move, the reported dimensions are probably not what the
            // effect actually operates on.
            if (series.span > MAX_PROBE_SPAN) {
                reasons.push(
                    "Achtung: die " +
                        (key === AXIS.X ? "horizontale" : "vertikale") +
                        " Achse müsste laut Formatgeometrie festliegen, schwankt " +
                        "aber um " +
                        series.span.toFixed(4) +
                        ". Quell- oder Sequenzformat passen möglicherweise nicht " +
                        "zu dem, was der Effekt tatsächlich verarbeitet."
                );
            }
        }
    } else {
        reasons.push(
            "Das Quellformat ließ sich nicht aus den Clip-Metadaten lesen; die " +
                "Kalibrierung stützt sich daher auf Ankerpunkt und Messdaten."
        );
    }

    // ---- Probe 2: the effect's anchor point is the centre ---------------
    if (anchor) {
        const fromX = hypothesesForCentre(anchor.x, frame ? frame.width : null);
        const fromY = hypothesesForCentre(anchor.y, frame ? frame.height : null);
        // Only conventions that explain BOTH anchor components.
        const names = {};
        for (const entry of fromY) names[entry.convention] = entry.distance;
        const candidates = [];
        for (const entry of fromX) {
            if (names[entry.convention] !== undefined) {
                candidates.push({
                    convention: entry.convention,
                    distance: (entry.distance + names[entry.convention]) / 2
                });
            }
        }
        if (candidates.length) {
            probes.push({
                name: "anchorPoint",
                weight: 2,
                value: anchor,
                candidates: candidates,
                note:
                    "Der Ankerpunkt des Effekts liegt per Definition in der Mitte; " +
                    "gemeldet wird " +
                    anchor.x.toFixed(4) +
                    " / " +
                    anchor.y.toFixed(4)
            });
        }
    }

    // ---- Probe 3: an axis that does not move is probably the pinned one --
    /*
     * Weaker than probe 1 because an axis can also sit still simply because
     * the subject never moved along it. Used only when the geometry is
     * unknown, as the sole remaining handle.
     */
    if (pinned === null) {
        const stillX = summary.x && summary.x.span <= MAX_PROBE_SPAN;
        const stillY = summary.y && summary.y.span <= MAX_PROBE_SPAN;
        if (stillX !== stillY) {
            const key = stillX ? AXIS.X : AXIS.Y;
            const series = summary[key];
            const length = key === AXIS.X ? frame.width : frame.height;
            probes.push({
                name: "staticAxis:" + key,
                weight: 1,
                value: series.median,
                candidates: hypothesesForCentre(series.median, length),
                note:
                    "Die " +
                    (key === AXIS.X ? "horizontale" : "vertikale") +
                    " Achse bewegt sich nicht und ist daher vermutlich die " +
                    "festliegende; gemeldet wird " +
                    series.median.toFixed(4)
            });
        }
    }

    // ---- Probe 4: measured fill scale matches the predicted one ---------
    /*
     * Independent of the position parameters entirely. If the effect's own
     * scale readout matches the fill scale computed from the two measured
     * rectangles, the effect expresses its transform in the same terms Motion
     * does — which is strong corroboration for the frame-normalized reading
     * and rules out nothing else on its own.
     */
    if (
        isFiniteNumber(geometryInfo.expectedFillScalePercent) &&
        isFiniteNumber(geometryInfo.measuredScalePercent)
    ) {
        const expected = geometryInfo.expectedFillScalePercent;
        const measured = geometryInfo.measuredScalePercent;
        const relative = Math.abs(measured - expected) / expected;
        geometryInfo.fillScaleAgreement = relative;
        if (relative <= 0.02) {
            probes.push({
                name: "fillScale",
                weight: 1,
                value: measured,
                candidates: [{ convention: CONVENTION.FRAME_NORMALIZED, distance: relative }],
                note:
                    "Die gemeldete Skalierung " +
                    measured.toFixed(2) +
                    " % entspricht der aus den gemessenen Formaten berechneten " +
                    "Füllskalierung " +
                    expected.toFixed(2) +
                    " % — der Effekt rechnet also in denselben Einheiten wie Motion"
            });
        } else {
            reasons.push(
                "Hinweis: die gemeldete Skalierung " +
                    measured.toFixed(2) +
                    " % weicht von der erwarteten Füllskalierung " +
                    expected.toFixed(2) +
                    " % ab (" +
                    (relative * 100).toFixed(1) +
                    " %). Das kann an einem abweichenden Pixel-Seitenverhältnis " +
                    "liegen oder daran, dass der Effekt zusätzlich zoomt."
            );
        }
    }

    if (!probes.length) {
        reasons.unshift(
            "Keine Kalibrierung möglich: weder Formatgeometrie noch Ankerpunkt " +
                "noch Messdaten liefern einen verwertbaren Prüfwert. Es wird " +
                "nichts geschrieben."
        );
        return {
            convention: CONVENTION.UNKNOWN,
            confidence: "none",
            probes: probes,
            geometry: geometryInfo,
            reasons: reasons
        };
    }

    // ---- Vote -----------------------------------------------------------
    const tally = {};
    for (const probe of probes) {
        for (const candidate of probe.candidates) {
            const entry =
                tally[candidate.convention] ||
                (tally[candidate.convention] = { votes: 0, distance: 0, probes: [] });
            entry.votes += probe.weight;
            entry.distance += candidate.distance;
            entry.probes.push(probe.name);
        }
    }

    let ranked = Object.keys(tally).map((convention) => ({
        convention: convention,
        votes: tally[convention].votes,
        distance: tally[convention].distance,
        probes: tally[convention].probes,
        range: rangeTest(summary, convention, frame, halfRange)
    }));

    if (!ranked.length) {
        reasons.unshift(
            "Die Prüfwerte passen zu keiner bekannten Konvention. Es wird nichts " +
                "geschrieben."
        );
        return {
            convention: CONVENTION.UNKNOWN,
            confidence: "none",
            probes: probes,
            geometry: geometryInfo,
            reasons: reasons
        };
    }

    // Falsification outranks voting: a convention that implies an impossible
    // crop is wrong no matter how many probes liked it.
    const survivors = ranked.filter((entry) => !entry.range || entry.range.passed);
    let eliminated = [];
    if (survivors.length && survivors.length < ranked.length) {
        eliminated = ranked.filter((entry) => survivors.indexOf(entry) === -1);
        reasons.push(
            "Ausgeschlossen durch die Bereichsprüfung: " +
                eliminated.map((entry) => entry.convention).join(", ") +
                " — damit läge der Bildausschnitt teilweise außerhalb des " +
                "Quellbildes, was Auto Reframe nicht erzeugt."
        );
        ranked = survivors;
    }

    ranked.sort((a, b) => (b.votes - a.votes) || (a.distance - b.distance));
    const winner = ranked[0];
    const contested = ranked.length > 1 && ranked[1].votes === winner.votes;

    for (const probe of probes) {
        if (probe.candidates.some((c) => c.convention === winner.convention)) {
            reasons.push(probe.note + ".");
        }
    }

    let confidence;
    if (contested) {
        confidence = "ambiguous";
        reasons.push(
            "Mehrere Konventionen sind gleich gut belegt (" +
                ranked
                    .filter((entry) => entry.votes === winner.votes)
                    .map((entry) => entry.convention)
                    .join(", ") +
                "). Die nächstliegende wurde gewählt — Ergebnis im Dry-Run prüfen."
        );
    } else if (winner.probes.length >= 2) {
        confidence = "cross-checked";
        reasons.push(
            "Belegt durch " + winner.probes.length + " unabhängige Prüfungen: " + winner.probes.join(", ") + "."
        );
    } else if (winner.probes.length === 1 && winner.probes[0].indexOf("staticAxis") === 0) {
        confidence = "weak";
        reasons.push(
            "Nur eine schwache Prüfung verfügbar (unbewegte Achse). Das Ergebnis " +
                "unbedingt im Dry-Run gegenprüfen."
        );
    } else {
        confidence = "measured";
    }

    return {
        convention: winner.convention,
        confidence: confidence,
        probes: probes,
        ranked: ranked.map((entry) => ({
            convention: entry.convention,
            votes: entry.votes,
            distance: entry.distance,
            probes: entry.probes,
            rangePassed: entry.range ? entry.range.passed : null
        })),
        eliminated: eliminated.map((entry) => ({
            convention: entry.convention,
            failures: entry.range ? entry.range.failures : null
        })),
        geometry: geometryInfo,
        reasons: reasons
    };
}

/** Human-readable aspect label, e.g. "16:9" or "1.85:1". Pure cosmetics. */
function formatAspect(aspect) {
    if (!isPositive(aspect)) return "unbekannt";
    const common = [
        [16, 9],
        [9, 16],
        [4, 3],
        [3, 4],
        [1, 1],
        [21, 9],
        [2, 1],
        [1, 2],
        [5, 4],
        [239, 100],
        [185, 100]
    ];
    for (const [w, h] of common) {
        if (Math.abs(aspect - w / h) < 0.005) return w + ":" + h;
    }
    return aspect.toFixed(3) + ":1";
}

/**
 * Converts one point from a detected convention into Motion's convention
 * (normalized, 0.5 = centre). Returns null for unusable input.
 */
function toMotionPosition(point, convention, frame) {
    if (!point || !isFiniteNumber(point.x) || !isFiniteNumber(point.y)) return null;
    const x = axisToMotion(point.x, convention, frame ? frame.width : null);
    const y = axisToMotion(point.y, convention, frame ? frame.height : null);
    if (x === null || y === null) return null;
    return { x: x, y: y };
}

/**
 * Rescales a whole path summary into Motion units, for drift reporting.
 *
 * Only the UNIT is converted here, not the origin: a span, a min and a max all
 * scale the same way, but adding the centre offset (as toMotionPosition does)
 * would be wrong for a span. Since drift reporting only ever looks at
 * differences, leaving the origin alone keeps the two conversions from being
 * confused for one another.
 */
function normalizeSummary(summary, convention, frame) {
    const unit = (length) => (value) => {
        if (!isFiniteNumber(value)) return value;
        if (convention === CONVENTION.PIXELS) {
            return isPositive(length) ? value / length : value;
        }
        return value;
    };
    const mapSeries = (series, fn) => {
        if (!series) return null;
        return {
            count: series.count,
            min: fn(series.min),
            max: fn(series.max),
            span: fn(series.span),
            median: fn(series.median),
            mean: fn(series.mean),
            first: fn(series.first),
            last: fn(series.last)
        };
    };

    return {
        samples: summary.samples,
        x: mapSeries(summary.x, unit(frame ? frame.width : null)),
        y: mapSeries(summary.y, unit(frame ? frame.height : null)),
        scale: summary.scale,
        rotation: summary.rotation
    };
}

// ---------------------------------------------------------------------------
// Reference-frame selection
// ---------------------------------------------------------------------------

/**
 * Picks the sample whose value is written to Motion.
 *
 * MEDIAN is the default and deserves a note: for a tripod shot the path is a
 * tight jitter cloud around one framing, and the median is the robust centre
 * of that cloud — unlike the arithmetic mean it is unaffected by a few frames
 * where the subject detection jumped. To keep the written value faithful we do
 * not write the computed median itself but the ACTUAL SAMPLE closest to it, so
 * the plugin never writes a framing that Auto Reframe did not itself choose.
 *
 * @param {Array} samples   as passed to summarizePath()
 * @param {string} method   one of REFERENCE
 * @param {Object} context  { inTicks, outTicks, playheadTicks }
 */
function pickReference(samples, method, context) {
    if (!samples || !samples.length) return null;
    const ctx = context || {};
    const chosen = REFERENCE_VALUES.indexOf(method) !== -1 ? method : REFERENCE.MEDIAN;

    const pick = (index, note) => ({
        sample: samples[index],
        index: index,
        method: chosen,
        note: note
    });

    if (chosen === REFERENCE.START) return pick(0, "erster Abtastpunkt des Clips");
    if (chosen === REFERENCE.END) {
        return pick(samples.length - 1, "letzter Abtastpunkt des Clips");
    }
    if (chosen === REFERENCE.MIDDLE) {
        /*
         * The TEMPORAL middle, not the middle index. With unevenly spaced
         * samples those differ, and the user asked for the middle of the clip
         * — not for "the middle entry of a list they cannot see".
         */
        const from = isFiniteNumber(ctx.inTicks) ? ctx.inTicks : samples[0].ticks;
        const to = isFiniteNumber(ctx.outTicks)
            ? ctx.outTicks
            : samples[samples.length - 1].ticks;
        return pick(
            nearestByTicks(samples, (from + to) / 2),
            "Abtastpunkt nächstliegend zur zeitlichen Clipmitte"
        );
    }
    if (chosen === REFERENCE.PLAYHEAD) {
        if (!isFiniteNumber(ctx.playheadTicks)) return null;
        return pick(
            nearestByTicks(samples, ctx.playheadTicks),
            "Abtastpunkt nächstliegend zur Abspielposition"
        );
    }
    if (chosen === REFERENCE.MEAN) {
        const positioned = samples.filter((s) => s.position);
        const target = {
            x: mean(positioned.map((s) => s.position.x)),
            y: mean(positioned.map((s) => s.position.y))
        };
        return pick(
            nearestByPosition(samples, target),
            "Abtastpunkt nächstliegend zum arithmetischen Mittel"
        );
    }

    const positioned = samples.filter((s) => s.position);
    const target = {
        x: median(positioned.map((s) => s.position.x)),
        y: median(positioned.map((s) => s.position.y))
    };
    if (!isFiniteNumber(target.x) || !isFiniteNumber(target.y)) {
        return pick(0, "Median nicht berechenbar — erster Abtastpunkt");
    }
    return pick(
        nearestByPosition(samples, target),
        "Abtastpunkt nächstliegend zum Median aller Abtastpunkte (robust gegen Ausreißer)"
    );
}

function nearestByTicks(samples, ticks) {
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < samples.length; i++) {
        const distance = Math.abs(samples[i].ticks - ticks);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = i;
        }
    }
    return best;
}

function nearestByPosition(samples, target) {
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < samples.length; i++) {
        const position = samples[i].position;
        if (!position) continue;
        const dx = position.x - target.x;
        const dy = position.y - target.y;
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance) {
            bestDistance = distance;
            best = i;
        }
    }
    return best;
}

// ---------------------------------------------------------------------------
// Plausibility (soft checks — reported, not enforced)
// ---------------------------------------------------------------------------

/**
 * Soft plausibility report on the calibrated data.
 *
 * Separate from the falsification inside detectConvention: that one chooses
 * between conventions, this one flags things the user should know about the
 * clip itself. Never blocks a write on its own.
 */
function plausibility(normalizedSummary, frame, source) {
    const warnings = [];
    const frameAspect = aspectOf(frame);
    const sourceAspect = aspectOf(source);
    const halfRange = cropHalfRange(sourceAspect, frameAspect);

    const info = {
        frameAspect: frameAspect,
        frameAspectLabel: formatAspect(frameAspect),
        sourceAspect: sourceAspect,
        sourceAspectLabel: formatAspect(sourceAspect),
        sourceMeasured: sourceAspect !== null,
        pinnedAxis: pinnedAxis(sourceAspect, frameAspect),
        freeAxis: freeAxis(sourceAspect, frameAspect),
        cropHalfRange: halfRange
    };

    if (sourceAspect === null) {
        warnings.push(
            "Das Quellformat des Clips ließ sich nicht lesen. Die geometrische " +
                "Gegenprüfung des Bildausschnitts entfällt dadurch."
        );
    } else if (halfRange && halfRange.x === 0 && halfRange.y === 0) {
        warnings.push(
            "Quelle (" +
                info.sourceAspectLabel +
                ") und Sequenz (" +
                info.frameAspectLabel +
                ") haben dasselbe Seitenverhältnis — es gibt keinen Spielraum für " +
                "einen Bildausschnitt. Auto Reframe hat hier nichts zu wählen."
        );
    }

    if (halfRange) {
        const axes = [
            { key: "x", series: normalizedSummary.x, half: halfRange.x, label: "horizontal" },
            { key: "y", series: normalizedSummary.y, half: halfRange.y, label: "vertikal" }
        ];
        info.allowedRange = {};
        for (const axis of axes) {
            info.allowedRange[axis.key] = { from: 0.5 - axis.half, to: 0.5 + axis.half };
            if (!axis.series) continue;
            if (
                axis.series.min < 0.5 - axis.half - RANGE_SLACK ||
                axis.series.max > 0.5 + axis.half + RANGE_SLACK
            ) {
                warnings.push(
                    "Die " +
                        axis.label +
                        " gemessenen Positionen (" +
                        axis.series.min.toFixed(4) +
                        " … " +
                        axis.series.max.toFixed(4) +
                        ") liegen außerhalb des für " +
                        info.sourceAspectLabel +
                        " in " +
                        info.frameAspectLabel +
                        " möglichen Bereichs (" +
                        (0.5 - axis.half).toFixed(4) +
                        " … " +
                        (0.5 + axis.half).toFixed(4) +
                        ")."
                );
            }
        }
    }

    if (normalizedSummary.scale && normalizedSummary.scale.span > 0.5) {
        warnings.push(
            "Auto Reframe variiert auch die Skalierung (Spanne " +
                normalizedSummary.scale.span.toFixed(3) +
                "). Das Einfrieren auf einen Wert verändert damit nicht nur die " +
                "Bewegung, sondern auch den Bildausschnitt über die Clipdauer."
        );
    }

    return { info: info, warnings: warnings };
}

module.exports = {
    CONVENTION: CONVENTION,
    CONVENTION_VALUES: CONVENTION_VALUES,
    REFERENCE: REFERENCE,
    REFERENCE_VALUES: REFERENCE_VALUES,
    AXIS: AXIS,
    PROBE_TOLERANCE: PROBE_TOLERANCE,
    MAX_PROBE_SPAN: MAX_PROBE_SPAN,
    RANGE_SLACK: RANGE_SLACK,
    median: median,
    mean: mean,
    describeSeries: describeSeries,
    aspectOf: aspectOf,
    formatAspect: formatAspect,
    pinnedAxis: pinnedAxis,
    freeAxis: freeAxis,
    fillScalePercent: fillScalePercent,
    cropHalfRange: cropHalfRange,
    summarizePath: summarizePath,
    describeDrift: describeDrift,
    centreFor: centreFor,
    hypothesesForCentre: hypothesesForCentre,
    axisToMotion: axisToMotion,
    rangeTest: rangeTest,
    detectConvention: detectConvention,
    toMotionPosition: toMotionPosition,
    normalizeSummary: normalizeSummary,
    pickReference: pickReference,
    plausibility: plausibility
};
