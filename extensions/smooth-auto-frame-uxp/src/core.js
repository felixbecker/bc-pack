/**
 * Smooth Auto Frame — src/core.js
 *
 * Core algorithm, UXP / Premiere Pro 25.6+.
 *
 * WHAT IT SOLVES
 * Premiere's Auto Reframe effect generates Position/Scale/Rotation keyframes
 * that follow the detected subject. On footage shot from a tripod this adds
 * artificial camera drift. This module pins the affected parameters to a
 * single reference value for the whole clip, keeping Auto Reframe's chosen
 * framing but removing the movement.
 *
 * ARCHITECTURE NOTE (important, enforced by @adobe/eslint-plugin-premierepro)
 * Premiere's UXP API splits into async reads and synchronous "action" writes:
 *   - `create*Action()` may only be called inside `Project.lockedAccess()` or
 *     `Project.executeTransaction()`.
 *   - `addAction()` may only be called inside `Project.executeTransaction()`.
 *   - No `await` is allowed inside those callbacks.
 *   - Action objects must not escape their lock scope.
 * Therefore this module runs in two strict phases:
 *   Phase 1 (async): read everything, compute target values, build a plan.
 *   Phase 2 (sync):  inside one transaction, create and queue all actions.
 * Phase 2 re-acquires every Component/ComponentParam freshly from the stored
 * component chain (`getComponentAtIndex` / `getParam` are synchronous). This
 * also works around a known 26.3 regression where params captured across an
 * async boundary throw "The script object is no longer valid".
 *
 * Because the whole batch runs in a single `executeTransaction`, the user can
 * undo the entire run with one Cmd/Ctrl+Z — something the legacy CEP
 * implementation cannot offer.
 */

const ppro = require("premierepro");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIMING = {
    START: "start",
    MIDDLE: "middle",
    END: "end",
    PLAYHEAD: "playhead",
    AVERAGE: "average"
};

const VALID_TIMING = [
    TIMING.START,
    TIMING.MIDDLE,
    TIMING.END,
    TIMING.PLAYHEAD,
    TIMING.AVERAGE
];

/**
 * Auto Reframe's internal matchName is not publicly documented by Adobe, and
 * the Component API is absent from the Object Model Viewer. We therefore match
 * on matchName fragments first (stable across locales when present) and fall
 * back to localized display names.
 */
const AUTO_REFRAME_MATCHNAME_FRAGMENTS = ["autoreframe", "auto_reframe", "aireframe"];

const AUTO_REFRAME_DISPLAY_NAMES = [
    "auto reframe",
    "ai reframe",
    "automatische neuformatierung",
    "automatisches reframe",
    "reencuadre automático",
    "recadrage automatique",
    "reenquadramento automático",
    "riquadratura automatica"
];

const OVERRIDE_PAN_PARAM_NAMES = [
    "override generated pan",
    "override generated path",
    "overwrite generated path",
    "override generated pan/scan",
    "generierten schwenk überschreiben"
];

const POSITION_PARAM_NAMES = ["adjust position", "position", "position anpassen"];
const SCALE_PARAM_NAMES = ["adjust scale", "scale", "skalierung", "skalierung anpassen"];
const ROTATION_PARAM_NAMES = ["adjust rotation", "rotation", "drehung"];

/** Temporal interpolation mode: hold (step) — see Premiere scripting enum. */
const INTERP_MODE_HOLD = 4;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function normalizeName(value) {
    return String(value || "").trim().toLowerCase();
}

function nameMatches(value, candidates) {
    const normalized = normalizeName(value);
    if (!normalized) return false;
    return candidates.indexOf(normalized) !== -1;
}

function containsFragment(value, fragments) {
    const normalized = normalizeName(value).replace(/[\s._-]/g, "");
    if (!normalized) return false;
    return fragments.some((fragment) => normalized.indexOf(fragment) !== -1);
}

/** True for PointF-like values (UXP returns PointF for point parameters). */
function isPointValue(value) {
    return (
        value !== null &&
        typeof value === "object" &&
        typeof value.x === "number" &&
        typeof value.y === "number"
    );
}

/**
 * Rejects values we must never write: NaN/Infinity, or point values with a
 * non-finite component. Writing NaN into a Position parameter corrupts the
 * clip's framing, so every write passes through here first.
 */
function isWritableValue(value) {
    if (typeof value === "number") return isFinite(value);
    if (typeof value === "boolean") return true;
    if (isPointValue(value)) return isFinite(value.x) && isFinite(value.y);
    return false;
}

function describeValue(value) {
    if (isPointValue(value)) {
        return "x=" + value.x.toFixed(4) + ", y=" + value.y.toFixed(4);
    }
    if (typeof value === "number") return value.toFixed(4);
    return String(value);
}

function describeError(error) {
    if (!error) return "Unbekannter Fehler.";
    if (error instanceof Error) return error.message || String(error);
    return String(error);
}

/**
 * Reads the keyframe times of a parameter. Returns an empty array when the
 * parameter does not support keyframes or currently has none.
 */
function getKeyframeTimes(param) {
    try {
        if (!param.isTimeVarying()) return [];
        const times = param.getKeyframeListAsTickTimes();
        if (!times || !times.length) return [];
        return times
            .slice()
            .sort((a, b) => a.ticksNumber - b.ticksNumber);
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Phase 1 — discovery and reading (async)
// ---------------------------------------------------------------------------

/**
 * Locates the Auto Reframe component on a track item.
 * @returns {Promise<{chain: object, index: number, component: object}|null>}
 */
async function findAutoReframeComponent(trackItem) {
    const chain = await trackItem.getComponentChain();
    if (!chain) return null;

    const count = chain.getComponentCount();
    for (let i = 0; i < count; i++) {
        const component = chain.getComponentAtIndex(i);
        if (!component) continue;

        let matchName = "";
        let displayName = "";
        try {
            matchName = await component.getMatchName();
        } catch {
            matchName = "";
        }
        try {
            displayName = await component.getDisplayName();
        } catch {
            displayName = "";
        }

        if (
            containsFragment(matchName, AUTO_REFRAME_MATCHNAME_FRAGMENTS) ||
            containsFragment(displayName, AUTO_REFRAME_MATCHNAME_FRAGMENTS) ||
            nameMatches(displayName, AUTO_REFRAME_DISPLAY_NAMES)
        ) {
            return { chain: chain, index: i, component: component };
        }
    }
    return null;
}

/**
 * Finds a parameter index on a component by display name.
 * `ComponentParam.displayName` is a synchronous property.
 */
function findParamIndex(component, candidateNames) {
    const count = component.getParamCount();
    for (let i = 0; i < count; i++) {
        const param = component.getParam(i);
        if (param && nameMatches(param.displayName, candidateNames)) {
            return i;
        }
    }
    return -1;
}

/**
 * Determines the TickTime at which the reference value should be sampled.
 *
 * Preferring an existing keyframe time sidesteps any ambiguity about whether
 * effect keyframes live in clip-relative or sequence-relative time: a time
 * taken from the parameter's own keyframe list is guaranteed to be valid for
 * that parameter. Only when no keyframes exist do we fall back to the clip's
 * in/out points.
 */
async function resolveReferenceTime(param, trackItem, sequence, timing) {
    if (timing === TIMING.PLAYHEAD) {
        const playhead = await sequence.getPlayerPosition();
        if (!playhead) {
            throw new Error(
                "Abspielposition konnte nicht gelesen werden. Wähle eine andere Referenz-Option."
            );
        }
        const clipStart = await trackItem.getStartTime();
        const inPoint = await trackItem.getInPoint();
        const outPoint = await trackItem.getOutPoint();

        // Map the sequence playhead into the clip's own time domain.
        let mapped = inPoint.add(playhead.subtract(clipStart));
        if (mapped.ticksNumber < inPoint.ticksNumber) mapped = inPoint;
        if (mapped.ticksNumber > outPoint.ticksNumber) mapped = outPoint;
        return mapped;
    }

    const keyTimes = getKeyframeTimes(param);
    if (keyTimes.length > 0) {
        if (timing === TIMING.END) return keyTimes[keyTimes.length - 1];
        if (timing === TIMING.MIDDLE) {
            return keyTimes[Math.floor((keyTimes.length - 1) / 2)];
        }
        return keyTimes[0];
    }

    // No keyframes present — derive from the clip's source in/out points.
    const inPoint = await trackItem.getInPoint();
    const outPoint = await trackItem.getOutPoint();
    if (timing === TIMING.END) return outPoint;
    if (timing === TIMING.MIDDLE) {
        return inPoint.add(outPoint.subtract(inPoint).divide(2));
    }
    return inPoint;
}

/**
 * Averages a parameter across all of its keyframes.
 *
 * Note: for a genuine pan the arithmetic mean can land on a framing that is
 * good in no single frame. It is most useful for tripod shots where Auto
 * Reframe only jitters slightly around one position.
 */
async function computeAverageValue(param, fallbackTime) {
    const keyTimes = getKeyframeTimes(param);
    if (!keyTimes.length) {
        return await param.getValueAtTime(fallbackTime);
    }

    let sumX = 0;
    let sumY = 0;
    let sumScalar = 0;
    let isPoint = false;
    let count = 0;

    for (let i = 0; i < keyTimes.length; i++) {
        const value = await param.getValueAtTime(keyTimes[i]);
        if (isPointValue(value)) {
            isPoint = true;
            sumX += value.x;
            sumY += value.y;
        } else if (typeof value === "number") {
            sumScalar += value;
        } else {
            // Unsupported type for averaging — fall back to a single sample.
            return await param.getValueAtTime(fallbackTime);
        }
        count++;
    }

    if (!count) return await param.getValueAtTime(fallbackTime);
    if (isPoint) return { x: sumX / count, y: sumY / count };
    return sumScalar / count;
}

/**
 * Builds the write plan for one parameter: which value to pin it to, and at
 * which time (the latter only matters in keyframe mode).
 */
async function planParam(component, paramIndex, trackItem, sequence, timing) {
    const param = component.getParam(paramIndex);
    if (!param) return null;

    const referenceTime = await resolveReferenceTime(param, trackItem, sequence, timing);

    const value =
        timing === TIMING.AVERAGE
            ? await computeAverageValue(param, referenceTime)
            : await param.getValueAtTime(referenceTime);

    if (!isWritableValue(value)) {
        throw new Error(
            'Parameter "' +
                param.displayName +
                '" lieferte keinen verwertbaren Wert (' +
                String(value) +
                ")."
        );
    }

    const keyTimes = getKeyframeTimes(param);

    /*
     * Write bounds for keyframe mode.
     *
     * These are deliberately derived from this parameter's OWN keyframe list
     * whenever it has one, so the keyframes we write — and the range we clear —
     * live in exactly the same time domain as the keyframes Auto Reframe
     * generated. Mixing domains (reading from the keyframe list but writing at
     * the clip's source in/out points) would place the new keys outside the
     * range that actually matters. Only when the parameter has no keyframes at
     * all do we fall back to the clip's in/out points.
     */
    let writeStart;
    let writeEnd;
    if (keyTimes.length > 0) {
        writeStart = keyTimes[0];
        writeEnd = keyTimes[keyTimes.length - 1];
    } else {
        writeStart = await trackItem.getInPoint();
        writeEnd = await trackItem.getOutPoint();
    }

    return {
        paramIndex: paramIndex,
        paramName: param.displayName,
        value: value,
        referenceTime: referenceTime,
        writeStart: writeStart,
        writeEnd: writeEnd,
        // A single keyframe (or a zero-length range) means the second Hold key
        // would land on the first — write only one in that case.
        writeDistinctBounds: writeEnd.ticksNumber > writeStart.ticksNumber,
        keyframeCount: keyTimes.length
    };
}

/**
 * Phase 1 for a single clip. Returns a plan (no mutation performed) or a
 * skip/error record.
 */
async function buildClipPlan(trackItem, sequence, options) {
    let clipName = "(unbenannter Clip)";
    try {
        clipName = (await trackItem.getName()) || clipName;
    } catch {
        /* keep fallback name */
    }

    // Guard: audio items have no video component chain to work on.
    if (typeof trackItem.getComponentChain !== "function") {
        return {
            status: "skipped",
            clipName: clipName,
            reason: "Kein Video-Clip — übersprungen."
        };
    }

    const found = await findAutoReframeComponent(trackItem);
    if (!found) {
        return {
            status: "skipped",
            clipName: clipName,
            reason: "Kein Auto-Reframe-Effekt auf diesem Clip gefunden."
        };
    }

    const component = found.component;
    const positionIndex = findParamIndex(component, POSITION_PARAM_NAMES);
    if (positionIndex < 0) {
        return {
            status: "skipped",
            clipName: clipName,
            reason: "Auto Reframe gefunden, aber kein Position-Parameter auflösbar."
        };
    }

    const overridePanIndex = findParamIndex(component, OVERRIDE_PAN_PARAM_NAMES);
    const targets = [];

    targets.push(
        await planParam(component, positionIndex, trackItem, sequence, options.timing)
    );

    if (options.fixScale) {
        const scaleIndex = findParamIndex(component, SCALE_PARAM_NAMES);
        if (scaleIndex >= 0) {
            targets.push(
                await planParam(component, scaleIndex, trackItem, sequence, options.timing)
            );
        }
    }

    if (options.fixRotation) {
        const rotationIndex = findParamIndex(component, ROTATION_PARAM_NAMES);
        if (rotationIndex >= 0) {
            targets.push(
                await planParam(component, rotationIndex, trackItem, sequence, options.timing)
            );
        }
    }

    const validTargets = targets.filter((target) => target !== null);
    if (!validTargets.length) {
        return {
            status: "skipped",
            clipName: clipName,
            reason: "Keine schreibbaren Parameter gefunden."
        };
    }

    return {
        status: "planned",
        clipName: clipName,
        trackItem: trackItem,
        chain: found.chain,
        componentIndex: found.index,
        overridePanIndex: overridePanIndex,
        targets: validTargets
    };
}

// ---------------------------------------------------------------------------
// Phase 2 — writing (synchronous, inside one transaction)
// ---------------------------------------------------------------------------

/** Converts a plain point back into a PointF instance for the Premiere API. */
function toNativeValue(value) {
    if (isPointValue(value)) {
        return new ppro.PointF(value.x, value.y);
    }
    return value;
}

/*
 * NOTE: the action-queuing code is intentionally written inline inside the
 * `executeTransaction` callback further down rather than extracted into a
 * helper. Adobe's syntactic ESLint rules
 * (`@adobe/premierepro/require-action-lock-scope` and
 * `require-execute-transaction`) verify lexical nesting and cannot follow
 * indirection through a helper function, so extracting it would both trip the
 * linter and remove the guarantee it provides.
 */

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Runs the whole operation.
 *
 * @param {Object} rawOptions
 * @param {string} rawOptions.timing     one of TIMING
 * @param {boolean} rawOptions.fixScale
 * @param {boolean} rawOptions.fixRotation
 * @param {boolean} rawOptions.dryRun
 * @param {boolean} rawOptions.keyframeMode
 * @returns {Promise<Object>} report
 */
async function runSmoothAutoFrame(rawOptions) {
    const options = {
        // Whitelist the timing option instead of trusting the caller.
        timing:
            VALID_TIMING.indexOf(rawOptions && rawOptions.timing) !== -1
                ? rawOptions.timing
                : TIMING.START,
        fixScale: !!(rawOptions && rawOptions.fixScale),
        fixRotation: !!(rawOptions && rawOptions.fixRotation),
        dryRun: !!(rawOptions && rawOptions.dryRun),
        keyframeMode: !!(rawOptions && rawOptions.keyframeMode)
    };

    const report = {
        processed: 0,
        skipped: 0,
        errors: 0,
        dryRun: options.dryRun,
        // Echoed back so the panel can show which option was actually applied —
        // this makes a mis-read picker value visible instead of silent.
        timing: options.timing,
        results: [],
        notes: []
    };

    const project = await ppro.Project.getActiveProject();
    if (!project) {
        return { fatalError: "Kein aktives Projekt gefunden." };
    }

    const sequence = await project.getActiveSequence();
    if (!sequence) {
        return {
            fatalError: "Keine aktive Sequenz. Öffne eine Sequenz und versuche es erneut."
        };
    }

    const selection = await sequence.getSelection();
    const trackItems = selection ? await selection.getTrackItems() : [];
    if (!trackItems || !trackItems.length) {
        return {
            fatalError:
                "Keine Clips ausgewählt. Wähle einen oder mehrere Clips in der Timeline aus."
        };
    }

    // ---- Phase 1: read everything and build the plan (async) ----
    const plans = [];
    for (let i = 0; i < trackItems.length; i++) {
        const trackItem = trackItems[i];
        let planOrResult;
        try {
            planOrResult = await buildClipPlan(trackItem, sequence, options);
        } catch (error) {
            report.errors++;
            report.results.push({
                clipName: "(Clip " + (i + 1) + ")",
                status: "error",
                reason: describeError(error)
            });
            continue;
        }

        if (planOrResult.status !== "planned") {
            report.skipped++;
            report.results.push(planOrResult);
            continue;
        }

        plans.push(planOrResult);
    }

    // ---- Dry run: report the plan without touching the project ----
    if (options.dryRun) {
        for (let i = 0; i < plans.length; i++) {
            const plan = plans[i];
            report.processed++;
            report.results.push({
                clipName: plan.clipName,
                status: "ok",
                reason: "Dry-Run — es wurde nichts geschrieben.",
                changes: plan.targets.map((target) => ({
                    param: target.paramName,
                    value: describeValue(target.value),
                    keyframesBefore: target.keyframeCount
                }))
            });
        }
        if (!plans.length && !report.results.length) {
            report.notes.push("Nichts zu tun.");
        }
        return report;
    }

    if (!plans.length) {
        report.notes.push("Kein Clip hatte einen verwertbaren Auto-Reframe-Effekt.");
        return report;
    }

    /*
     * ---- Phase 1b: refresh component chains immediately before writing ----
     *
     * The chain handles obtained during discovery have by now survived a number
     * of awaits. Premiere 26.3 is known to invalidate script objects that cross
     * async boundaries ("The script object is no longer valid"). Re-fetching
     * every chain directly before the transaction keeps that window as short as
     * possible; Components and ComponentParams are then derived from these
     * fresh chains synchronously inside the transaction itself.
     */
    for (let i = 0; i < plans.length; i++) {
        try {
            const refreshedChain = await plans[i].trackItem.getComponentChain();
            if (refreshedChain) {
                plans[i].chain = refreshedChain;
            }
        } catch (error) {
            plans[i].chainError = describeError(error);
        }
    }

    // ---- Phase 2: one atomic, undoable transaction (synchronous) ----
    let committed = false;
    let transactionError = null;
    // Problems detected while queuing actions. Collected instead of thrown:
    // throwing out of the transaction callback would leave it to Premiere to
    // unwind both the transaction and the surrounding lock, which is not
    // documented behaviour.
    const queueProblems = [];

    project.lockedAccess(() => {
        try {
            committed = project.executeTransaction((compoundAction) => {
                // Everything in here is synchronous by contract: no await,
                // and every Component/ComponentParam is re-acquired fresh from
                // the chain so no stale handle is used.
                for (let i = 0; i < plans.length; i++) {
                    const plan = plans[i];

                    if (plan.chainError) {
                        queueProblems.push({
                            clipName: plan.clipName,
                            reason:
                                "Effektkette nicht mehr lesbar: " + plan.chainError
                        });
                        continue;
                    }

                    const component = plan.chain.getComponentAtIndex(plan.componentIndex);
                    if (!component) {
                        queueProblems.push({
                            clipName: plan.clipName,
                            reason:
                                "Auto-Reframe-Komponente war beim Schreiben nicht mehr verfügbar."
                        });
                        continue;
                    }

                    // Step 1: enable "Override Generated Pan" so the generated
                    // path becomes editable (first step of the manual workflow).
                    if (plan.overridePanIndex >= 0) {
                        const overrideParam = component.getParam(plan.overridePanIndex);
                        if (overrideParam) {
                            const overrideKeyframe = overrideParam.createKeyframe(true);
                            compoundAction.addAction(
                                overrideParam.createSetValueAction(overrideKeyframe, true)
                            );
                        }
                    }

                    // Step 2: pin each target parameter to its reference value.
                    for (let t = 0; t < plan.targets.length; t++) {
                        const target = plan.targets[t];
                        const param = component.getParam(target.paramIndex);
                        if (!param) {
                            queueProblems.push({
                                clipName: plan.clipName,
                                reason:
                                    'Parameter "' +
                                    target.paramName +
                                    '" war beim Schreiben nicht mehr verfügbar.'
                            });
                            continue;
                        }

                        const nativeValue = toNativeValue(target.value);

                        if (options.keyframeMode) {
                            // Fallback: keep the parameter keyframed but reduce
                            // it to identical Hold keyframes, so the value
                            // cannot interpolate between them. Bounds come from
                            // this parameter's own keyframe domain.
                            compoundAction.addAction(
                                param.createSetTimeVaryingAction(true)
                            );
                            compoundAction.addAction(
                                param.createRemoveKeyframeRangeAction(
                                    target.writeStart,
                                    target.writeEnd,
                                    true
                                )
                            );

                            const startKeyframe = param.createKeyframe(nativeValue);
                            startKeyframe.position = target.writeStart;
                            compoundAction.addAction(
                                param.createAddKeyframeAction(startKeyframe)
                            );
                            compoundAction.addAction(
                                param.createSetInterpolationAtKeyframeAction(
                                    target.writeStart,
                                    INTERP_MODE_HOLD,
                                    true
                                )
                            );

                            if (target.writeDistinctBounds) {
                                const endKeyframe = param.createKeyframe(nativeValue);
                                endKeyframe.position = target.writeEnd;
                                compoundAction.addAction(
                                    param.createAddKeyframeAction(endKeyframe)
                                );
                                compoundAction.addAction(
                                    param.createSetInterpolationAtKeyframeAction(
                                        target.writeEnd,
                                        INTERP_MODE_HOLD,
                                        true
                                    )
                                );
                            }
                        } else {
                            // Primary path: switch keyframing off entirely and
                            // write one static value. A parameter without
                            // keyframes is constant by definition — the direct
                            // equivalent of turning the stopwatch off in the
                            // Effect Controls panel.
                            compoundAction.addAction(
                                param.createSetTimeVaryingAction(false)
                            );
                            const staticKeyframe = param.createKeyframe(nativeValue);
                            compoundAction.addAction(
                                param.createSetValueAction(staticKeyframe, true)
                            );
                        }
                    }
                }
            }, "Smooth Auto Frame");
        } catch (error) {
            transactionError = error;
        }
    });

    if (transactionError) {
        // The transaction is all-or-nothing: nothing was applied, so there is
        // no partially-destroyed state to repair.
        report.errors += plans.length;
        for (let i = 0; i < plans.length; i++) {
            report.results.push({
                clipName: plans[i].clipName,
                status: "error",
                reason: describeError(transactionError)
            });
        }
        report.notes.push(
            "Transaktion fehlgeschlagen — es wurden keine Änderungen übernommen."
        );
        return report;
    }

    if (!committed) {
        report.errors += plans.length;
        for (let i = 0; i < plans.length; i++) {
            report.results.push({
                clipName: plans[i].clipName,
                status: "error",
                reason: "Premiere hat die Transaktion abgelehnt."
            });
        }
        return report;
    }

    // Clips whose handles went stale while queuing: nothing was written for
    // them, but the rest of the transaction did commit.
    const failedClipNames = {};
    for (let i = 0; i < queueProblems.length; i++) {
        const problem = queueProblems[i];
        failedClipNames[problem.clipName] = true;
        report.errors++;
        report.results.push({
            clipName: problem.clipName,
            status: "error",
            reason: problem.reason
        });
    }

    for (let i = 0; i < plans.length; i++) {
        const plan = plans[i];
        if (failedClipNames[plan.clipName]) continue;

        report.processed++;
        report.results.push({
            clipName: plan.clipName,
            status: "ok",
            reason: options.keyframeMode
                ? "Auf Hold-Keyframes reduziert."
                : "Auf konstanten Wert fixiert (keine Keyframes).",
            changes: plan.targets.map((target) => ({
                param: target.paramName,
                value: describeValue(target.value),
                keyframesBefore: target.keyframeCount
            }))
        });
    }

    if (report.processed > 0) {
        report.notes.push(
            "Alle Änderungen sind ein einzelner Undo-Schritt (Cmd/Ctrl+Z)."
        );
    }
    return report;
}

module.exports = {
    runSmoothAutoFrame: runSmoothAutoFrame,
    TIMING: TIMING
};
