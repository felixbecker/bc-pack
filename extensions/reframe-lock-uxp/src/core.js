/**
 * Reframe Lock — src/core.js
 *
 * Orchestration: measure, calibrate, plan, write once, verify.
 *
 * ===========================================================================
 * THE APPROACH, AND WHY IT IS NOT THE OBVIOUS ONE
 *
 * Symptom: a tripod-shot 16:9 clip is converted to 1:1 or 9:16 with Auto
 * Reframe. Auto Reframe locks onto the subject and keeps nudging the crop, so
 * the background drifts even though the camera never moved.
 *
 * The obvious fix — the one the well-known tutorial performs by hand — is to
 * enable "override generated path" and reduce Auto Reframe's own position
 * parameter to a single keyframe. Through the UXP API that does not work: the
 * keyframe transfer the tutorial relies on is a side effect of clicking the
 * checkbox in the UI, not of the parameter's value changing. Setting the value
 * programmatically leaves the editable parameter empty, and the effect keeps
 * recomputing its merged output, so any value written into it is overwritten
 * again moments later. Fighting that produces retry loops that race the host
 * and still cannot promise a result.
 *
 * This plugin does something else entirely: it never writes an Auto Reframe
 * parameter.
 *
 *   1. MEASURE   Sample the effect's applied transform over the clip's
 *                duration (see src/premiere.js for why sampling beats reading
 *                keyframes). That yields the actual drift, in numbers.
 *   2. CALIBRATE Determine which coordinate convention those numbers use, by
 *                measurement rather than assumption (see src/geometry.js).
 *                If it cannot be determined, nothing is written.
 *   3. PICK      Choose one frame's value — by default the sample closest to
 *                the median of the whole path, which is the robust centre of a
 *                jitter cloud and is always a framing Auto Reframe itself
 *                chose.
 *   4. BAKE      Write that single value into the clip's own Motion effect as
 *                a static transform, and take Auto Reframe out of the chain.
 *   5. VERIFY    Re-read everything and confirm it.
 *
 * The result is literally what the user asked for: the same crop Auto Reframe
 * picked, held by a plain static transform — as stable as the 16:9 original,
 * because nothing animates any more. There is no effect left to fight, so
 * there is no race, no settle delay, no retry loop, and the whole batch is a
 * single undo step.
 *
 * ===========================================================================
 * ARCHITECTURE CONSTRAINT (enforced by @adobe/eslint-plugin-premierepro)
 *
 *   - create*Action() only inside lockedAccess() / executeTransaction()
 *   - addAction() only inside executeTransaction()
 *   - no await inside those callbacks
 *   - Action objects must not escape their lock scope
 *
 * Hence the strict split: everything async happens before the transaction, the
 * transaction itself is synchronous and written inline (the lint rules check
 * lexical nesting and cannot follow a helper function), and nothing is thrown
 * out of it — problems are collected and reported afterwards so Premiere can
 * tear down transaction and lock normally.
 */

const ppro = require("premierepro");

const geometry = require("./geometry.js");
const pr = require("./premiere.js");
const { Logger, describeError } = require("./logger.js");

const PLUGIN_VERSION = "0.1.0";
const REPORT_SCHEMA = 1;

const SCOPE = {
    SELECTION: "selection",
    TRACK: "track",
    ALL_TRACKS: "allTracks"
};

const SCOPE_VALUES = [SCOPE.SELECTION, SCOPE.TRACK, SCOPE.ALL_TRACKS];

const DEFAULTS = {
    scope: SCOPE.SELECTION,
    reference: geometry.REFERENCE.MEDIAN,
    dryRun: true,
    removeEffect: true,
    freezeScale: true,
    freezeRotation: false,
    sampleCount: 60,
    /** Below this peak-to-peak drift there is nothing worth fixing. */
    minDriftPixels: 0.75,
    /** Allow overwriting a Motion transform the user has already set. */
    force: false,
    /**
     * Write even when the calibration could not be cross-checked.
     *
     * Off by default: an unverified coordinate convention means a crop that
     * may be off by half a frame, and the user cannot see that without
     * scrubbing every clip.
     */
    allowWeakCalibration: false,
    logLevel: "info"
};

/** Motion's factory defaults; used to detect a clip the user already moved. */
const MOTION_DEFAULTS = {
    position: { x: 0.5, y: 0.5 },
    scale: 100,
    rotation: 0
};

const MOTION_DEFAULT_TOLERANCE = { position: 0.0005, scale: 0.05, rotation: 0.01 };

// ---------------------------------------------------------------------------
// Option handling
// ---------------------------------------------------------------------------

function pickNumber(value, fallback, min, max) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!isFinite(parsed)) return fallback;
    if (typeof min === "number" && parsed < min) return min;
    if (typeof max === "number" && parsed > max) return max;
    return parsed;
}

/**
 * Normalizes caller input. Every field is whitelisted rather than trusted:
 * the panel reads values out of Spectrum widgets whose `.value` behaviour is
 * not identical across UXP versions, so an unexpected string must land on a
 * safe default instead of travelling into the write path.
 */
function resolveOptions(raw) {
    const input = raw || {};
    return {
        scope: SCOPE_VALUES.indexOf(input.scope) !== -1 ? input.scope : DEFAULTS.scope,
        reference:
            geometry.REFERENCE_VALUES.indexOf(input.reference) !== -1
                ? input.reference
                : DEFAULTS.reference,
        dryRun: input.dryRun === undefined ? DEFAULTS.dryRun : !!input.dryRun,
        removeEffect:
            input.removeEffect === undefined ? DEFAULTS.removeEffect : !!input.removeEffect,
        freezeScale: input.freezeScale === undefined ? DEFAULTS.freezeScale : !!input.freezeScale,
        freezeRotation: !!input.freezeRotation,
        force: !!input.force,
        allowWeakCalibration: !!input.allowWeakCalibration,
        sampleCount: Math.round(pickNumber(input.sampleCount, DEFAULTS.sampleCount, 8, 240)),
        minDriftPixels: pickNumber(input.minDriftPixels, DEFAULTS.minDriftPixels, 0, 500),
        logLevel: input.logLevel === "debug" ? "debug" : "info"
    };
}

function describeHost() {
    const info = {};
    try {
        const uxp = require("uxp");
        if (uxp && uxp.host) {
            if (uxp.host.name) info.app = String(uxp.host.name);
            if (uxp.host.version) info.appVersion = String(uxp.host.version);
            if (uxp.host.uiLocale) info.uiLocale = String(uxp.host.uiLocale);
        }
        if (uxp && uxp.versions && uxp.versions.uxp) info.uxp = String(uxp.versions.uxp);
    } catch {
        info.note = "Host-Infos nicht verfügbar";
    }
    return info;
}

function pointsClose(a, b, tolerance) {
    if (!a || !b) return false;
    return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
}

/** Keeps the exported sample curve useful without bloating the log. */
function thinSamples(samples, limit) {
    if (samples.length <= limit) return samples;
    const out = [];
    const stride = samples.length / limit;
    for (let i = 0; i < limit; i++) {
        out.push(samples[Math.min(samples.length - 1, Math.floor(i * stride))]);
    }
    out[out.length - 1] = samples[samples.length - 1];
    return out;
}

// ---------------------------------------------------------------------------
// Phase 1 — analysis of one clip (async, read-only)
// ---------------------------------------------------------------------------

/**
 * Measures one clip and, if everything checks out, returns the write plan.
 *
 * The return value always carries a `status`:
 *   "planned" — ready to write (or to show in a dry run)
 *   "skipped" — nothing to do, with a reason
 *   "error"   — something could not be established; never write in this case
 *
 * Note what is NOT done here: no fallback that "does its best". Every step
 * that cannot be established turns into a skip or an error with the data
 * attached. Reporting success for a clip that still drifts is the one failure
 * mode this plugin must not have, because the user cannot see the difference
 * without scrubbing every clip by hand.
 */
async function analyzeClip(item, context) {
    const { sequence, options, logger, frame } = context;
    const trackItem = item.trackItem;

    const record = {
        trackIndex: item.trackIndex === null ? null : item.trackIndex + 1,
        clipName: "(unbenannter Clip)",
        status: "skipped"
    };

    try {
        record.clipName = (await trackItem.getName()) || record.clipName;
    } catch {
        /* keep the fallback name */
    }
    const scope = "clip:" + record.clipName;

    if (typeof trackItem.getComponentChain !== "function") {
        record.reason = "Kein Videoclip — übersprungen.";
        return record;
    }

    const chain = await trackItem.getComponentChain();
    if (!chain) {
        record.status = "error";
        record.reason = "Effektkette nicht lesbar.";
        return record;
    }

    // ---- locate Auto Reframe -------------------------------------------
    const found = await pr.findComponent(chain, pr.AUTO_REFRAME);
    if (!found.found) {
        record.reason = "Kein Auto-Reframe-Effekt auf diesem Clip.";
        record.components = found.components;
        logger.debug(scope, "Auto Reframe nicht gefunden", found.components);
        return record;
    }
    record.autoReframe = {
        componentIndex: found.index,
        matchName: found.matchName,
        displayName: found.displayName
    };
    logger.info(scope, "Auto Reframe gefunden: " + found.matchName);

    const autoReframe = found.component;
    const paramDump = await pr.dumpParams(autoReframe);
    logger.debug(scope, "Auto-Reframe-Parameter", paramDump);

    // ---- resolve the parameters we read --------------------------------
    let positionParam;
    try {
        positionParam = await pr.resolveParam(
            autoReframe,
            pr.PARAM_SPECS.autoReframePosition,
            paramDump
        );
    } catch (error) {
        record.status = "error";
        record.reason = describeError(error);
        record.params = paramDump;
        return record;
    }

    const scaleParam = await pr.tryResolveParam(
        autoReframe,
        pr.PARAM_SPECS.autoReframeScale,
        paramDump
    );
    const anchorParam = await pr.tryResolveParam(
        autoReframe,
        pr.PARAM_SPECS.autoReframeAnchor,
        paramDump
    );
    const generatedParam = await pr.tryResolveParam(
        autoReframe,
        pr.PARAM_SPECS.autoReframeGenerated,
        paramDump
    );

    // ---- sample the applied transform over time ------------------------
    const inPoint = await trackItem.getInPoint();
    const outPoint = await trackItem.getOutPoint();
    const inTicks = Number(inPoint.ticksNumber);
    const outTicks = Number(outPoint.ticksNumber);

    /*
     * The clip's own source format, MEASURED — never assumed.
     *
     * Together with the sequence frame this determines which axis a fill-crop
     * is pinned along, which is what the calibration probes. Both rectangles
     * are inputs; no format is special-cased anywhere in this plugin. A null
     * here is handled rather than papered over: the calibration falls back to
     * its geometry-free probes and lowers its own confidence accordingly.
     */
    const sourceFrame = await pr.readSourceFrame(trackItem, logger, scope);
    record.sourceFrame = sourceFrame;
    if (!sourceFrame) {
        logger.warn(
            scope,
            "Quellformat nicht lesbar — der Kalibrierung fehlt damit ihre stärkste Prüfung."
        );
    }

    const keyTicks = pr.keyframeTicks(positionParam.param);
    const sampleTicks = pr.buildSampleTicks(inTicks, outTicks, keyTicks, options.sampleCount);
    logger.debug(scope, "Abtastpunkte", {
        inTicks: inTicks,
        outTicks: outTicks,
        keyframes: keyTicks.length,
        samples: sampleTicks.length
    });

    let measurement = await pr.samplePath(
        positionParam.param,
        scaleParam ? scaleParam.param : null,
        null,
        sampleTicks
    );
    let sourceName = positionParam.name;
    let sourceRole = "appliedPosition";
    let summary = geometry.summarizePath(measurement.samples);

    /*
     * Fallback to the raw generated path.
     *
     * While "override generated path" is off, the applied Position parameter
     * can report a constant value even though the picture moves, because the
     * path still lives in the effect's internal parameter. If the applied
     * output looks static, ask the generated path before concluding there is
     * no drift.
     */
    const appliedSpan = summary.x ? summary.x.span : 0;
    if (appliedSpan === 0 && generatedParam) {
        const generatedKeys = pr.keyframeTicks(generatedParam.param);
        const generatedTicks = pr.buildSampleTicks(
            inTicks,
            outTicks,
            generatedKeys,
            options.sampleCount
        );
        const generated = await pr.samplePath(
            generatedParam.param,
            scaleParam ? scaleParam.param : null,
            null,
            generatedTicks
        );
        const generatedSummary = geometry.summarizePath(generated.samples);
        if (generatedSummary.x && generatedSummary.x.span > 0) {
            logger.info(
                scope,
                'Der angewandte Positionsparameter ist konstant; der Pfad wurde aus "' +
                    generatedParam.name +
                    '" gelesen.'
            );
            measurement = generated;
            summary = generatedSummary;
            sourceName = generatedParam.name;
            sourceRole = "generatedPath";
        }
    }

    record.measurement = {
        source: sourceName,
        sourceRole: sourceRole,
        paramIndex: sourceRole === "appliedPosition" ? positionParam.index : generatedParam.index,
        resolvedBy:
            sourceRole === "appliedPosition" ? positionParam.resolvedBy : generatedParam.resolvedBy,
        sampleCount: measurement.samples.length,
        readFailures: measurement.failures,
        keyframeCount: measurement.keyframeCount,
        raw: summary
    };

    if (!measurement.samples.length) {
        record.status = "error";
        record.reason =
            "Der Positionsparameter gab an keinem Zeitpunkt einen lesbaren Punktwert " +
            "zurück (" +
            measurement.failures +
            " Fehlversuche). Es wurde nichts geschrieben.";
        record.params = paramDump;
        return record;
    }

    /*
     * ---- Is there any movement at all? --------------------------------
     *
     * Checked in RAW units, before calibration, because "the value never
     * changes" is true in every coordinate convention. Doing it the other way
     * round would make a perfectly static clip fail with a confusing
     * calibration error: with nothing moving, the unmoved-axis probe cannot
     * tell which axis is the pinned one.
     *
     * Two very different situations produce "no movement", and conflating them
     * would be a lie in one of the two cases.
     */
    const rawXSpan = summary.x ? summary.x.span : 0;
    const rawYSpan = summary.y ? summary.y.span : 0;
    if (rawXSpan === 0 && rawYSpan === 0) {
        if (measurement.keyframeCount > 0) {
            record.status = "error";
            record.reason =
                "Der Parameter hat " +
                measurement.keyframeCount +
                " Keyframes, liefert über die gesamte Clipdauer aber immer " +
                "denselben Wert. Die API gibt den Bewegungspfad hier offenbar " +
                "nicht heraus — ohne gemessenen Pfad wird nichts geschrieben.";
            record.params = paramDump;
            record.samples = thinSamples(measurement.samples, 40);
            return record;
        }
        record.status = "skipped";
        record.reason =
            "Keine Bewegung messbar — der Bildausschnitt dieses Clips steht bereits still.";
        return record;
    }

    // ---- calibrate -----------------------------------------------------
    /*
     * Everything the calibration gets is measured: the sequence frame from the
     * sequence settings, the source frame from the clip's media, the anchor
     * point and the scale from the effect itself. See src/geometry.js — the
     * pinned axis is derived from the two aspect ratios, so square, portrait,
     * 4:3, anamorphic or a vertical source in a horizontal sequence all go
     * through the same code path.
     */
    let anchorValue = null;
    if (anchorParam && pr.valueKind(anchorParam.probe) === "point") {
        anchorValue = anchorParam.probe;
    }
    const measuredScale =
        summary.scale && typeof summary.scale.median === "number" ? summary.scale.median : null;

    const calibration = geometry.detectConvention({
        summary: summary,
        frame: frame,
        source: sourceFrame,
        anchor: anchorValue,
        measuredScale: measuredScale
    });
    record.calibration = calibration;
    for (let i = 0; i < calibration.reasons.length; i++) {
        logger.info(scope, calibration.reasons[i]);
    }

    if (calibration.convention === geometry.CONVENTION.UNKNOWN) {
        record.status = "error";
        record.reason =
            "Das Koordinatensystem von Auto Reframe ließ sich nicht bestimmen, " +
            "deshalb wurde nichts geschrieben. " +
            calibration.reasons.join(" ");
        record.params = paramDump;
        record.samples = thinSamples(measurement.samples, 40);
        return record;
    }

    /*
     * A calibration that rests on a single weak probe can be off by half a
     * frame, and the user would not notice without scrubbing every clip. That
     * is exactly the failure mode this plugin exists to avoid, so it takes an
     * explicit opt-in.
     */
    if (
        (calibration.confidence === "weak" || calibration.confidence === "ambiguous") &&
        !options.allowWeakCalibration
    ) {
        record.status = "error";
        record.reason =
            "Die Kalibrierung ist nicht belastbar (" +
            calibration.confidence +
            "). " +
            calibration.reasons.join(" ") +
            ' Zum Schreiben trotzdem: "Unsichere Kalibrierung zulassen" aktivieren.';
        record.samples = thinSamples(measurement.samples, 40);
        return record;
    }

    // ---- quantify the drift in a unit the user can judge ---------------
    const normalized = geometry.normalizeSummary(summary, calibration.convention, frame);
    const drift = geometry.describeDrift(normalized, frame);
    record.drift = drift;
    record.normalized = normalized;
    logger.info(
        scope,
        "Gemessene Drift: " +
            (drift ? drift.peakPixels.toFixed(1) + " px" : "unbekannt") +
            " über " +
            measurement.samples.length +
            " Abtastpunkte."
    );

    const plausible = geometry.plausibility(normalized, frame, sourceFrame);
    record.plausibility = plausible.info;
    if (plausible.warnings.length) {
        record.warnings = (record.warnings || []).concat(plausible.warnings);
        for (let i = 0; i < plausible.warnings.length; i++) {
            logger.warn(scope, plausible.warnings[i]);
        }
    }

    if (drift && drift.peakPixels < options.minDriftPixels) {
        /*
         * Movement exists but is below the threshold — sub-pixel jitter that
         * nobody can see. Freezing it would overwrite the clip's transform for
         * no visible gain, so the honest answer is to leave it alone. (The
         * "exactly zero movement" case was already handled before
         * calibration.)
         */
        record.status = "skipped";
        record.reason =
            "Bewegung unterhalb der Schwelle (" +
            drift.peakPixels.toFixed(3) +
            " px, Schwelle " +
            options.minDriftPixels +
            " px). Dieser Clip wackelt nicht sichtbar.";
        return record;
    }

    // ---- pick the reference frame --------------------------------------
    let playheadTicks = null;
    if (options.reference === geometry.REFERENCE.PLAYHEAD) {
        try {
            const playhead = await sequence.getPlayerPosition();
            const clipStart = await trackItem.getStartTime();
            if (playhead && clipStart) {
                // Map the sequence playhead into the clip's own time domain.
                playheadTicks =
                    inTicks + (Number(playhead.ticksNumber) - Number(clipStart.ticksNumber));
                playheadTicks = Math.max(inTicks, Math.min(outTicks, playheadTicks));
            }
        } catch (error) {
            logger.warn(scope, "Abspielposition nicht lesbar: " + describeError(error));
        }
    }

    const reference = geometry.pickReference(measurement.samples, options.reference, {
        inTicks: inTicks,
        outTicks: outTicks,
        playheadTicks: playheadTicks
    });
    if (!reference) {
        record.status = "error";
        record.reason =
            "Referenz-Frame konnte nicht bestimmt werden (Option: " + options.reference + ").";
        return record;
    }

    const targetPosition = geometry.toMotionPosition(
        reference.sample.position,
        calibration.convention,
        frame
    );
    if (!targetPosition) {
        record.status = "error";
        record.reason = "Referenzwert ließ sich nicht in Motion-Koordinaten umrechnen.";
        return record;
    }

    record.reference = {
        method: reference.method,
        note: reference.note,
        ticks: reference.sample.ticks,
        seconds: (reference.sample.ticks - inTicks) / pr.TICKS_PER_SECOND,
        rawValue: reference.sample.position,
        motionPosition: targetPosition,
        scale: typeof reference.sample.scale === "number" ? reference.sample.scale : null
    };

    // ---- locate Motion and read its current state ----------------------
    const motionFound = await pr.findComponent(chain, pr.MOTION);
    if (!motionFound.found) {
        record.status = "error";
        record.reason =
            "Der intrinsische Motion-Effekt wurde auf diesem Clip nicht gefunden. " +
            "Vorhandene Effekte: " +
            JSON.stringify(motionFound.components);
        record.components = motionFound.components;
        return record;
    }

    const motion = motionFound.component;
    const motionDump = await pr.dumpParams(motion);
    logger.debug(scope, "Motion-Parameter", motionDump);

    let motionPosition;
    let motionScale = null;
    let motionRotation = null;
    try {
        motionPosition = await pr.resolveParam(motion, pr.PARAM_SPECS.motionPosition, motionDump);
        if (options.freezeScale) {
            motionScale = await pr.resolveParam(motion, pr.PARAM_SPECS.motionScale, motionDump);
        }
        if (options.freezeRotation) {
            motionRotation = await pr.resolveParam(
                motion,
                pr.PARAM_SPECS.motionRotation,
                motionDump
            );
        }
    } catch (error) {
        record.status = "error";
        record.reason = describeError(error);
        record.motionParams = motionDump;
        return record;
    }

    const motionBefore = {
        position: motionPosition.probe,
        positionParamIndex: motionPosition.index,
        positionResolvedBy: motionPosition.resolvedBy,
        scale: motionScale ? motionScale.probe : null,
        rotation: motionRotation ? motionRotation.probe : null,
        positionKeyframes: pr.keyframeTicks(motionPosition.param).length,
        scaleKeyframes: motionScale ? pr.keyframeTicks(motionScale.param).length : 0,
        rotationKeyframes: motionRotation ? pr.keyframeTicks(motionRotation.param).length : 0
    };
    record.motionBefore = motionBefore;

    /*
     * Refuse to silently discard the user's own work.
     *
     * Baking an absolute transform into Motion overwrites whatever was there.
     * If Motion still holds its factory defaults that is harmless; if the user
     * has panned, scaled or keyframed the clip themselves, overwriting it
     * destroys that — so it takes an explicit opt-in.
     */
    const motionTouched =
        !pointsClose(motionBefore.position, MOTION_DEFAULTS.position, MOTION_DEFAULT_TOLERANCE.position) ||
        (motionScale &&
            Math.abs(motionBefore.scale - MOTION_DEFAULTS.scale) >
                MOTION_DEFAULT_TOLERANCE.scale) ||
        (motionRotation &&
            Math.abs(motionBefore.rotation - MOTION_DEFAULTS.rotation) >
                MOTION_DEFAULT_TOLERANCE.rotation);
    const motionKeyframed =
        motionBefore.positionKeyframes > 0 ||
        motionBefore.scaleKeyframes > 0 ||
        motionBefore.rotationKeyframes > 0;

    if ((motionTouched || motionKeyframed) && !options.force) {
        record.status = "error";
        record.reason =
            "Der Motion-Effekt dieses Clips ist nicht auf Standardwerten" +
            (motionKeyframed ? " und hat eigene Keyframes" : "") +
            " (Position " +
            JSON.stringify(motionBefore.position) +
            ", Skalierung " +
            motionBefore.scale +
            "). Das Einbacken würde diese Einstellung überschreiben. " +
            'Zum Überschreiben "Vorhandene Motion-Werte überschreiben" aktivieren.';
        return record;
    }
    if (motionTouched || motionKeyframed) {
        const warning =
            "Vorhandene Motion-Werte wurden auf ausdrücklichen Wunsch überschrieben.";
        record.warnings = (record.warnings || []).concat([warning]);
        logger.warn(scope, warning);
    }

    // ---- the effect toggle, when disabling instead of removing ---------
    let enabledParam = null;
    if (!options.removeEffect) {
        enabledParam = await pr.tryResolveParam(
            autoReframe,
            pr.PARAM_SPECS.autoReframeEnabled,
            paramDump
        );
        if (!enabledParam) {
            record.status = "error";
            record.reason =
                "Der Ein/Aus-Schalter des Auto-Reframe-Effekts ließ sich nicht " +
                "zweifelsfrei identifizieren (er hat in diesem Effekt keinen " +
                'Anzeigenamen). Nutze stattdessen "Auto Reframe entfernen".';
            record.params = paramDump;
            return record;
        }
    }

    // ---- the plan -------------------------------------------------------
    record.status = "planned";
    record.write = {
        motionPositionIndex: motionPosition.index,
        motionScaleIndex: motionScale ? motionScale.index : null,
        motionRotationIndex: motionRotation ? motionRotation.index : null,
        position: targetPosition,
        scale:
            motionScale && typeof record.reference.scale === "number"
                ? record.reference.scale
                : null,
        rotation: motionRotation ? MOTION_DEFAULTS.rotation : null,
        clearPositionKeyframes: motionBefore.positionKeyframes > 0,
        clearScaleKeyframes: motionBefore.scaleKeyframes > 0,
        clearRotationKeyframes: motionBefore.rotationKeyframes > 0,
        autoReframeAction: options.removeEffect ? "remove" : "disable",
        autoReframeEnabledIndex: enabledParam ? enabledParam.index : null
    };
    record.reason =
        "Bereit: " +
        (drift ? drift.peakPixels.toFixed(1) + " px" : "?") +
        " Drift werden auf einen festen Bildausschnitt reduziert (" +
        reference.note +
        "), Auto Reframe wird " +
        (options.removeEffect ? "entfernt" : "deaktiviert") +
        ".";

    // Internals the transaction needs. Kept on a non-enumerable-ish key so a
    // JSON export of the report never tries to serialize host objects.
    record._handles = {
        trackItem: trackItem,
        chain: chain,
        motionComponentIndex: motionFound.index,
        autoReframeComponentIndex: found.index
    };

    if (options.logLevel === "debug") {
        record.samples = thinSamples(measurement.samples, 40);
        record.params = paramDump;
        record.motionParams = motionDump;
    }

    return record;
}

// ---------------------------------------------------------------------------
// Phase 3 — verification (async, after the transaction)
// ---------------------------------------------------------------------------

/**
 * Confirms the write actually took effect.
 *
 * A transaction that returns without throwing is not evidence: Premiere can
 * discard a write it considers invalid, and the user would be told "done"
 * while the clip still drifts. So the result is re-read from a freshly fetched
 * component chain and compared against the plan.
 */
async function verifyClip(record, options, logger) {
    const handles = record._handles;
    const scope = "verify:" + record.clipName;
    const result = { checked: [], problems: [] };

    const chain = await handles.trackItem.getComponentChain();
    if (!chain) {
        result.problems.push("Effektkette nach dem Schreiben nicht lesbar.");
        return result;
    }

    // Auto Reframe gone, or off?
    const stillThere = await pr.findComponent(chain, pr.AUTO_REFRAME);
    if (options.removeEffect) {
        result.autoReframePresent = stillThere.found;
        if (stillThere.found) {
            result.problems.push(
                "Der Auto-Reframe-Effekt ist noch in der Effektkette — das Entfernen " +
                    "wurde nicht übernommen."
            );
        } else {
            result.checked.push("Auto Reframe ist aus der Effektkette entfernt.");
        }
    } else if (stillThere.found) {
        const dump = await pr.dumpParams(stillThere.component);
        const toggle = dump[record.write.autoReframeEnabledIndex];
        result.autoReframeEnabled = toggle ? toggle.value : null;
        if (toggle && toggle.value === false) {
            result.checked.push("Auto Reframe ist deaktiviert.");
        } else {
            result.problems.push(
                "Auto Reframe ist weiterhin aktiv (Schalter: " +
                    JSON.stringify(toggle ? toggle.value : null) +
                    ")."
            );
        }
    }

    // Motion holding the baked value, and not animating?
    const motion = chain.getComponentAtIndex(handles.motionComponentIndex);
    const motionByName = motion ? null : await pr.findComponent(chain, pr.MOTION);
    const motionComponent = motion || (motionByName && motionByName.component);
    if (!motionComponent) {
        result.problems.push("Motion-Effekt nach dem Schreiben nicht lesbar.");
        return result;
    }

    const positionParam = motionComponent.getParam(record.write.motionPositionIndex);
    if (!positionParam) {
        result.problems.push("Motion-Position nach dem Schreiben nicht lesbar.");
        return result;
    }

    const after = await pr.readValueAtTime(positionParam, pr.tickTime(0));
    const keyframes = pr.keyframeTicks(positionParam).length;
    result.motionAfter = { position: after, positionKeyframes: keyframes };

    if (!pointsClose(after, record.write.position, 0.002)) {
        result.problems.push(
            "Motion-Position hält nicht den geschriebenen Wert. Erwartet " +
                JSON.stringify(record.write.position) +
                ", gelesen " +
                JSON.stringify(after) +
                "."
        );
    } else {
        result.checked.push(
            "Motion-Position hält den Referenzwert (" +
                after.x.toFixed(4) +
                " / " +
                after.y.toFixed(4) +
                ")."
        );
    }

    if (keyframes > 0) {
        result.problems.push(
            "Motion-Position hat noch " +
                keyframes +
                " Keyframes — der Wert ist damit nicht konstant."
        );
    } else {
        result.checked.push("Motion-Position hat keine Keyframes, ist also konstant.");
    }

    if (record.write.motionScaleIndex !== null) {
        const scaleParam = motionComponent.getParam(record.write.motionScaleIndex);
        if (scaleParam) {
            const scaleAfter = await pr.readValueAtTime(scaleParam, pr.tickTime(0));
            const scaleKeyframes = pr.keyframeTicks(scaleParam).length;
            result.motionAfter.scale = scaleAfter;
            result.motionAfter.scaleKeyframes = scaleKeyframes;
            if (scaleKeyframes > 0) {
                result.problems.push(
                    "Motion-Skalierung hat noch " + scaleKeyframes + " Keyframes."
                );
            }
        }
    }

    logger.info(
        scope,
        result.problems.length
            ? result.problems.length + " Problem(e) bei der Nachprüfung."
            : "Nachprüfung bestanden."
    );
    return result;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Runs the whole operation.
 *
 * @param {Object} rawOptions see DEFAULTS
 * @returns {Promise<Object>} the report; also the debug payload for export
 */
async function runReframeLock(rawOptions) {
    const options = resolveOptions(rawOptions);
    const logger = new Logger(options.logLevel);
    const startedAt = new Date();

    const report = {
        schema: REPORT_SCHEMA,
        plugin: { name: "Reframe Lock", version: PLUGIN_VERSION },
        startedAt: startedAt.toISOString(),
        options: options,
        host: describeHost(),
        summary: {
            dryRun: options.dryRun,
            clipsInScope: 0,
            planned: 0,
            written: 0,
            skipped: 0,
            failed: 0
        },
        clips: []
    };

    const finish = (fatal) => {
        if (fatal) report.fatalError = fatal;
        report.finishedAt = new Date().toISOString();
        report.durationMs = Date.now() - startedAt.getTime();
        // Strip host-object handles so the report is JSON-serializable.
        for (let i = 0; i < report.clips.length; i++) delete report.clips[i]._handles;
        report.log = logger.toJSON();
        return report;
    };

    logger.info("run", "Start", { options: options });

    const project = await ppro.Project.getActiveProject();
    if (!project) return finish("Kein aktives Projekt gefunden.");

    const sequence = await project.getActiveSequence();
    if (!sequence) {
        return finish("Keine aktive Sequenz. Öffne eine Sequenz und versuche es erneut.");
    }

    const frame = await pr.readFrameRect(sequence);
    if (!frame) {
        return finish(
            "Die Bildgröße der Sequenz ließ sich nicht lesen. Ohne sie ist keine " +
                "Kalibrierung möglich."
        );
    }
    report.sequence = {
        frame: frame,
        aspect: frame.aspect,
        aspectLabel: geometry.formatAspect(frame.aspect),
        sizeLabel: frame.width + "×" + frame.height
    };
    logger.info(
        "run",
        "Sequenz " +
            frame.width +
            "×" +
            frame.height +
            " (" +
            geometry.formatAspect(frame.aspect) +
            ") — aus den Sequenzeinstellungen gelesen, nicht angenommen."
    );

    let items;
    try {
        items = await pr.collectTrackItems(sequence, options.scope, logger);
    } catch (error) {
        return finish(describeError(error));
    }
    if (!items.length) {
        return finish(
            options.scope === SCOPE.SELECTION
                ? "Keine Clips ausgewählt. Wähle Clips in der Timeline aus."
                : "Auf den gewählten Spuren liegen keine Clips."
        );
    }
    report.summary.clipsInScope = items.length;
    logger.info("run", items.length + " Clip(s) im Bearbeitungsbereich");

    // ---- Phase 1: measure, calibrate, plan ----------------------------
    const context = { sequence: sequence, options: options, logger: logger, frame: frame };
    const planned = [];

    for (let i = 0; i < items.length; i++) {
        let record;
        try {
            record = await analyzeClip(items[i], context);
        } catch (error) {
            record = {
                trackIndex: items[i].trackIndex === null ? null : items[i].trackIndex + 1,
                clipName: "(Clip " + (i + 1) + ")",
                status: "error",
                reason: describeError(error)
            };
        }
        report.clips.push(record);
        if (record.status === "planned") {
            report.summary.planned++;
            planned.push(record);
        } else if (record.status === "error") {
            report.summary.failed++;
            logger.error("clip:" + record.clipName, record.reason);
        } else {
            report.summary.skipped++;
            logger.info("clip:" + record.clipName, record.reason);
        }
    }

    if (options.dryRun) {
        logger.info(
            "run",
            "Dry-Run: " + planned.length + " Clip(s) wären geändert worden, geschrieben wurde nichts."
        );
        for (let i = 0; i < planned.length; i++) {
            planned[i].status = "dryRun";
        }
        return finish();
    }

    if (!planned.length) {
        logger.info("run", "Kein Clip war zu ändern.");
        return finish();
    }

    // ---- Phase 2: refresh handles immediately before writing ----------
    /*
     * Premiere 26.3 invalidates script objects that cross async boundaries
     * ("The script object is no longer valid"). The chains fetched during
     * analysis have survived many awaits by now, so they are re-fetched here
     * and the Components/Params are then derived from them synchronously
     * inside the transaction.
     */
    for (let i = 0; i < planned.length; i++) {
        try {
            const refreshed = await planned[i]._handles.trackItem.getComponentChain();
            if (refreshed) planned[i]._handles.chain = refreshed;
        } catch (error) {
            planned[i].status = "error";
            planned[i].reason = "Effektkette vor dem Schreiben nicht erneuerbar: " + describeError(error);
            report.summary.planned--;
            report.summary.failed++;
        }
    }

    const writable = planned.filter((record) => record.status === "planned");
    if (!writable.length) return finish();

    // ---- Phase 3: ONE transaction -------------------------------------
    /*
     * Everything happens here: Motion gets the static values, then Auto
     * Reframe leaves the chain. One compound action means one Cmd/Ctrl+Z for
     * the whole batch, and it means a clip can never end up half-converted
     * (baked framing but effect still active, or vice versa).
     *
     * No await, no throw: Adobe's lint rules forbid the former, and the latter
     * would leave Premiere's lock and transaction to be torn down by an
     * exception. Failures are collected and reported after the lock is gone.
     */
    let transactionError = null;
    const queued = [];

    project.lockedAccess(() => {
        try {
            project.executeTransaction((compoundAction) => {
                for (let i = 0; i < writable.length; i++) {
                    const record = writable[i];
                    const handles = record._handles;
                    const plan = record.write;

                    const motion = handles.chain.getComponentAtIndex(
                        handles.motionComponentIndex
                    );
                    if (!motion) {
                        record.writeNote = "Motion-Komponente beim Schreiben nicht lesbar.";
                        continue;
                    }

                    const positionParam = motion.getParam(plan.motionPositionIndex);
                    if (!positionParam) {
                        record.writeNote = "Motion-Position beim Schreiben nicht lesbar.";
                        continue;
                    }

                    // Keyframing off first: a parameter without keyframes is
                    // constant by definition, which is exactly the goal.
                    if (plan.clearPositionKeyframes) {
                        compoundAction.addAction(positionParam.createSetTimeVaryingAction(false));
                    }
                    compoundAction.addAction(
                        positionParam.createSetValueAction(
                            positionParam.createKeyframe(
                                new ppro.PointF(plan.position.x, plan.position.y)
                            ),
                            true
                        )
                    );

                    if (plan.motionScaleIndex !== null && plan.scale !== null) {
                        const scaleParam = motion.getParam(plan.motionScaleIndex);
                        if (scaleParam) {
                            if (plan.clearScaleKeyframes) {
                                compoundAction.addAction(
                                    scaleParam.createSetTimeVaryingAction(false)
                                );
                            }
                            compoundAction.addAction(
                                scaleParam.createSetValueAction(
                                    scaleParam.createKeyframe(plan.scale),
                                    true
                                )
                            );
                        }
                    }

                    if (plan.motionRotationIndex !== null && plan.rotation !== null) {
                        const rotationParam = motion.getParam(plan.motionRotationIndex);
                        if (rotationParam) {
                            if (plan.clearRotationKeyframes) {
                                compoundAction.addAction(
                                    rotationParam.createSetTimeVaryingAction(false)
                                );
                            }
                            compoundAction.addAction(
                                rotationParam.createSetValueAction(
                                    rotationParam.createKeyframe(plan.rotation),
                                    true
                                )
                            );
                        }
                    }

                    // Auto Reframe out of the signal path, last — so the
                    // reads above never depend on a chain we just mutated.
                    const autoReframe = handles.chain.getComponentAtIndex(
                        handles.autoReframeComponentIndex
                    );
                    if (!autoReframe) {
                        record.writeNote = "Auto-Reframe-Komponente beim Schreiben nicht lesbar.";
                        continue;
                    }

                    if (plan.autoReframeAction === "remove") {
                        compoundAction.addAction(
                            handles.chain.createRemoveComponentAction(autoReframe)
                        );
                    } else {
                        const toggle = autoReframe.getParam(plan.autoReframeEnabledIndex);
                        if (toggle) {
                            compoundAction.addAction(
                                toggle.createSetValueAction(toggle.createKeyframe(false), true)
                            );
                        } else {
                            record.writeNote = "Ein/Aus-Schalter beim Schreiben nicht lesbar.";
                            continue;
                        }
                    }

                    queued.push(record);
                }
            }, "Reframe Lock — Bildausschnitt fixieren");
        } catch (error) {
            transactionError = error;
        }
    });

    if (transactionError) {
        const message = describeError(transactionError);
        logger.error("write", "Transaktion fehlgeschlagen: " + message);
        for (let i = 0; i < writable.length; i++) {
            writable[i].status = "error";
            writable[i].reason = "Transaktion fehlgeschlagen: " + message;
            report.summary.planned--;
            report.summary.failed++;
        }
        return finish();
    }

    for (let i = 0; i < writable.length; i++) {
        if (queued.indexOf(writable[i]) === -1) {
            writable[i].status = "error";
            writable[i].reason =
                writable[i].writeNote || "Clip wurde beim Schreiben übersprungen.";
            report.summary.planned--;
            report.summary.failed++;
        }
    }

    logger.info("write", queued.length + " Clip(s) in einer Transaktion geschrieben.");

    // ---- Phase 4: verify ----------------------------------------------
    for (let i = 0; i < queued.length; i++) {
        const record = queued[i];
        let verification;
        try {
            verification = await verifyClip(record, options, logger);
        } catch (error) {
            verification = { checked: [], problems: ["Nachprüfung fehlgeschlagen: " + describeError(error)] };
        }
        record.verification = verification;

        if (verification.problems.length) {
            record.status = "error";
            record.reason =
                "Geschrieben, aber die Nachprüfung schlug fehl: " +
                verification.problems.join(" ");
            report.summary.planned--;
            report.summary.failed++;
        } else {
            record.status = "ok";
            record.reason =
                "Bildausschnitt fixiert (" +
                (record.drift ? record.drift.peakPixels.toFixed(1) + " px" : "?") +
                " Drift entfernt), Auto Reframe " +
                (options.removeEffect ? "entfernt" : "deaktiviert") +
                ", nachgeprüft.";
            report.summary.planned--;
            report.summary.written++;
        }
    }

    if (report.summary.written > 0) {
        logger.info("run", "Der ganze Lauf ist ein einzelner Undo-Schritt (Cmd/Ctrl+Z).");
    }

    return finish();
}

module.exports = {
    runReframeLock: runReframeLock,
    resolveOptions: resolveOptions,
    SCOPE: SCOPE,
    SCOPE_VALUES: SCOPE_VALUES,
    DEFAULTS: DEFAULTS,
    MOTION_DEFAULTS: MOTION_DEFAULTS,
    REFERENCE: geometry.REFERENCE,
    PLUGIN_VERSION: PLUGIN_VERSION,
    REPORT_SCHEMA: REPORT_SCHEMA
};
