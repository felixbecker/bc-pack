/**
 * Reframe Lock — src/premiere.js
 *
 * Read-only access to Premiere. Everything in this file either returns data or
 * throws; it never creates an Action and never writes. All writing lives
 * inline in src/core.js, where Adobe's ESLint rules can verify the lexical
 * nesting inside `executeTransaction`.
 *
 * ---------------------------------------------------------------------------
 * HOW THE DRIFT IS MEASURED (the central design decision)
 *
 * The obvious approach is to read Auto Reframe's keyframes. That turns out to
 * be the wrong handle: with "override generated path" switched off, the
 * effect's editable Position parameter reports ZERO keyframes, because the
 * generated path lives in a separate internal parameter. Any plugin that keys
 * off `isTimeVarying()` therefore concludes "nothing animates" on exactly the
 * clips that do.
 *
 * So this plugin does not ask where the keyframes are. It SAMPLES THE EFFECT'S
 * OUTPUT OVER TIME — `getValueAtTime()` across a grid spanning the clip, plus
 * every keyframe time the parameter does happen to expose. Whatever the
 * internal bookkeeping looks like, a value that changes between two sampled
 * times IS the drift the user is complaining about.
 *
 * That makes the measurement independent of the override checkbox, of which
 * internal parameter holds the path, and of whether keyframes exist at all.
 */

const ppro = require("premierepro");
const mediainfo = require("./mediainfo.js");
const { describeError } = require("./logger.js");

// ---------------------------------------------------------------------------
// Component and parameter identification
// ---------------------------------------------------------------------------

/**
 * Auto Reframe.
 *
 * `AE.ADBE AEFilterAutoFramer` is the matchName observed in Premiere 26.3.2.
 * matchNames are not localized, which makes them the only stable identifier —
 * `ComponentParam` has no equivalent, which is why parameters below need the
 * much more awkward treatment.
 */
const AUTO_REFRAME = {
    matchName: "AE.ADBE AEFilterAutoFramer",
    matchFragments: ["autoframer", "autoreframe", "aireframe"],
    displayFragments: ["autoreframe", "aireframe", "automatischeneuformatierung"],
    displayNames: [
        "auto reframe",
        "ai reframe",
        "automatische neuformatierung",
        "automatisches reframe",
        "reencuadre automático",
        "recadrage automatique",
        "reenquadramento automático",
        "riquadratura automatica"
    ]
};

/**
 * Motion — the clip's intrinsic transform, and our write target.
 */
const MOTION = {
    matchName: "AE.ADBE Motion",
    matchFragments: ["motion"],
    displayNames: ["motion", "bewegung", "movimiento", "mouvement", "movimento"]
};

/*
 * Parameter layout of AE.ADBE AEFilterAutoFramer, observed in Premiere 26.3.2
 * (de_DE). Used ONLY as a fallback when name resolution fails, and the
 * parameter found at an index is always type-checked before use, so a layout
 * change in a future version produces a clean error instead of a wrong read.
 *
 *   0  " "                        effect enable toggle (boolean)
 *   1  "Motion-Tracking"
 *   2  "Position"                 merged transform output  <- what we read
 *   3  "Scale (Merged)"           merged scale output
 *   4  "Uniform Scale"
 *   5  "Anchor Point"             corroborates the calibration
 *   6  "Position anpassen"        editable offset
 *   7  "Generated Keyframes"      raw generated path       <- fallback source
 *   8  ""                         "override generated path" (boolean)
 *   9  "Hash arb data"
 *  10  "Reframing für Versatz"
 *  11  "Reframing für Skalierung"
 *  12  "Scale (Auto Generated)"
 *  13  "Reframing für Drehung"
 */
const AUTO_REFRAME_LAYOUT = {
    enabled: 0,
    appliedPosition: 2,
    appliedScale: 3,
    anchorPoint: 5,
    generatedPath: 7
};

/** Standard layout of the intrinsic Motion effect. */
const MOTION_LAYOUT = {
    position: 0,
    scale: 1,
    scaleWidth: 2,
    uniformScale: 3,
    rotation: 4,
    anchorPoint: 5
};

const PARAM_SPECS = {
    autoReframePosition: {
        label: "Auto Reframe: Position (angewandt)",
        names: ["position"],
        fragments: [],
        index: AUTO_REFRAME_LAYOUT.appliedPosition,
        expect: "point"
    },
    autoReframeGenerated: {
        label: "Auto Reframe: erzeugter Pfad",
        names: ["generated keyframes", "erzeugte keyframes"],
        fragments: ["generatedkeyframes"],
        index: AUTO_REFRAME_LAYOUT.generatedPath,
        expect: "point"
    },
    autoReframeScale: {
        label: "Auto Reframe: Skalierung (angewandt)",
        names: ["scale (merged)", "skalierung (zusammengefasst)"],
        fragments: ["scale(merged)", "skalierung(zusammen"],
        index: AUTO_REFRAME_LAYOUT.appliedScale,
        expect: "number"
    },
    autoReframeAnchor: {
        label: "Auto Reframe: Ankerpunkt",
        names: ["anchor point", "ankerpunkt"],
        fragments: ["anchorpoint", "ankerpunkt"],
        index: AUTO_REFRAME_LAYOUT.anchorPoint,
        expect: "point"
    },
    autoReframeEnabled: {
        label: "Auto Reframe: Effekt aktiviert",
        names: [],
        fragments: [],
        index: AUTO_REFRAME_LAYOUT.enabled,
        expect: "boolean"
    },
    motionPosition: {
        label: "Motion: Position",
        names: ["position", "posición", "posizione"],
        fragments: [],
        index: MOTION_LAYOUT.position,
        expect: "point"
    },
    motionScale: {
        label: "Motion: Skalierung",
        // "scale width" must never win over "scale", hence exact names first.
        names: ["scale", "skalierung", "escala", "échelle", "scala"],
        fragments: [],
        index: MOTION_LAYOUT.scale,
        expect: "number"
    },
    motionRotation: {
        label: "Motion: Drehung",
        names: ["rotation", "drehung", "rotación", "rotazione", "rotação"],
        fragments: ["rotation", "drehung"],
        index: MOTION_LAYOUT.rotation,
        expect: "number"
    },
    motionAnchor: {
        label: "Motion: Ankerpunkt",
        names: ["anchor point", "ankerpunkt", "punto de anclaje"],
        fragments: ["anchorpoint", "ankerpunkt"],
        index: MOTION_LAYOUT.anchorPoint,
        expect: "point"
    }
};

// ---------------------------------------------------------------------------
// Value normalization
// ---------------------------------------------------------------------------

function normalizeName(value) {
    return String(value === undefined || value === null ? "" : value)
        .trim()
        .toLowerCase();
}

/** Lower-cased, with separators stripped, for fragment matching. */
function compactName(value) {
    return normalizeName(value).replace(/[\s._\-/]/g, "");
}

function toNumber(candidate) {
    if (typeof candidate === "number") return isFinite(candidate) ? candidate : null;
    if (typeof candidate === "string" && candidate.trim() !== "") {
        const parsed = Number(candidate);
        return isFinite(parsed) ? parsed : null;
    }
    return null;
}

function asPoint(candidate) {
    if (!candidate || typeof candidate !== "object") return null;
    if (Array.isArray(candidate)) {
        const x = toNumber(candidate[0]);
        const y = toNumber(candidate[1]);
        return x === null || y === null ? null : { x: x, y: y };
    }
    const x = toNumber(candidate.x);
    const y = toNumber(candidate.y);
    return x === null || y === null ? null : { x: x, y: y };
}

/**
 * Normalizes whatever Premiere hands back into a plain number, boolean or
 * {x, y}, or null when it is unusable.
 *
 * One level of unwrapping is not defensive guesswork: the official UXP
 * reference types `Keyframe.value` as `{ value: ... }`, so a keyframe read
 * genuinely nests the payload one level deeper than a `getValueAtTime()` read.
 * We therefore peel at most two levels and stop — deeper "just in case"
 * unwrapping only hides real problems.
 */
function normalizeValue(raw) {
    let current = raw;
    for (let depth = 0; depth < 2; depth++) {
        if (current === null || current === undefined) return null;
        if (typeof current === "boolean") return current;
        if (typeof current === "number" || typeof current === "string") {
            return toNumber(current);
        }
        const point = asPoint(current);
        if (point) return point;

        let next;
        try {
            next = current.value;
        } catch {
            return null;
        }
        if (next === undefined || next === current) return null;
        current = next;
    }
    return null;
}

function valueKind(value) {
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "number") return "number";
    if (value && typeof value === "object" && typeof value.x === "number") return "point";
    return "unusable";
}

/**
 * Describes an unexpected value well enough to debug it remotely.
 * `String(hostObject)` yields "[object Object]"; this names the constructor
 * and the readable fields instead.
 */
function describeValueShape(raw) {
    if (raw === null) return "null";
    if (raw === undefined) return "undefined";
    const type = typeof raw;
    if (type !== "object") return type + " " + String(raw);

    const parts = [];
    try {
        if (raw.constructor && raw.constructor.name) parts.push("typ=" + raw.constructor.name);
    } catch {
        /* host objects may hide their constructor */
    }
    if (Array.isArray(raw)) parts.push("array(" + raw.length + ")");

    for (const probe of ["value", "x", "y", "width", "height"]) {
        try {
            const probed = raw[probe];
            if (probed !== undefined && typeof probed !== "function") {
                parts.push(probe + "=" + String(probed));
            }
        } catch {
            /* inaccessible property */
        }
    }
    return parts.length ? parts.join(" ") : "leeres Objekt";
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Finds a component in a chain and reports every component it saw.
 *
 * The full list matters: a clip whose Auto Reframe effect carries an
 * unrecognized name must be distinguishable from a clip that genuinely has no
 * Auto Reframe, otherwise "skipped" is an unfalsifiable claim.
 */
async function findComponent(chain, spec) {
    const seen = [];
    const count = chain.getComponentCount();

    for (let i = 0; i < count; i++) {
        const component = chain.getComponentAtIndex(i);
        if (!component) {
            seen.push({ index: i, note: "nicht lesbar" });
            continue;
        }

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
        seen.push({ index: i, matchName: matchName, displayName: displayName });

        const compactMatch = compactName(matchName);
        const compactDisplay = compactName(displayName);
        const hit =
            compactMatch === compactName(spec.matchName) ||
            spec.matchFragments.some((f) => compactMatch.indexOf(f) !== -1) ||
            (spec.displayFragments || []).some((f) => compactDisplay.indexOf(f) !== -1) ||
            spec.displayNames.indexOf(normalizeName(displayName)) !== -1;

        if (hit) {
            return {
                found: true,
                index: i,
                component: component,
                matchName: matchName,
                displayName: displayName,
                components: seen
            };
        }
    }

    return { found: false, components: seen };
}

/**
 * Resolves a parameter on a component, then PROVES it is the right one by
 * checking the type of the value it returns.
 *
 * Parameter resolution is the weakest point of the whole Premiere UXP API:
 * `ComponentParam` exposes only a localized `displayName`, so there is no
 * language-independent name to match. Two consequences are designed for here:
 *
 *  1. A known index is accepted as a fallback, because some parameters have no
 *     usable name at all (Auto Reframe's override checkbox is literally named
 *     the empty string).
 *  2. Nothing is trusted on the strength of a name or an index alone. The
 *     resolved parameter must return a value of the expected type, otherwise
 *     this throws with the full parameter layout attached. Silently returning
 *     "not found" and letting the caller continue is how a plugin ends up
 *     reporting success while having changed nothing.
 */
async function resolveParam(component, spec, dump) {
    const count = component.getParamCount();
    let index = -1;
    let resolvedBy = "name";

    for (let n = 0; n < spec.names.length && index < 0; n++) {
        const wanted = normalizeName(spec.names[n]);
        for (let i = 0; i < count; i++) {
            const param = component.getParam(i);
            if (param && normalizeName(param.displayName) === wanted) {
                index = i;
                break;
            }
        }
    }

    for (let f = 0; f < (spec.fragments || []).length && index < 0; f++) {
        for (let i = 0; i < count; i++) {
            const param = component.getParam(i);
            if (param && compactName(param.displayName).indexOf(spec.fragments[f]) !== -1) {
                index = i;
                resolvedBy = "fragment";
                break;
            }
        }
    }

    if (index < 0 && typeof spec.index === "number" && spec.index < count) {
        index = spec.index;
        resolvedBy = "index";
    }

    if (index < 0) {
        throw new Error(
            'Parameter "' +
                spec.label +
                '" nicht gefunden. Die UXP-API liefert für Parameter nur den ' +
                "lokalisierten Anzeigenamen, daher kann die Suche in einer " +
                "unbekannten Sprachversion fehlschlagen. Vorhandene Parameter: " +
                JSON.stringify(dump || [])
        );
    }

    const param = component.getParam(index);
    if (!param) {
        throw new Error('Parameter "' + spec.label + '" (Index ' + index + ") ist nicht lesbar.");
    }

    const probe = await readValueAtTime(param, tickTime(0));
    const kind = valueKind(probe);
    if (spec.expect && kind !== spec.expect) {
        throw new Error(
            'Der als "' +
                spec.label +
                '" erkannte Parameter "' +
                param.displayName +
                '" (Index ' +
                index +
                ", aufgelöst per " +
                resolvedBy +
                ") liefert " +
                kind +
                " statt " +
                spec.expect +
                ". Vermutlich wurde der falsche Parameter getroffen. Vorhandene " +
                "Parameter: " +
                JSON.stringify(dump || [])
        );
    }

    return {
        index: index,
        param: param,
        name: param.displayName,
        resolvedBy: resolvedBy,
        probe: probe
    };
}

/** Same as resolveParam, but returns null instead of throwing. */
async function tryResolveParam(component, spec, dump) {
    try {
        return await resolveParam(component, spec, dump);
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Premiere's fixed tick resolution. */
const TICKS_PER_SECOND = 254016000000;

function tickTime(seconds) {
    return ppro.TickTime.createWithSeconds(seconds);
}

function tickTimeFromTicks(ticks) {
    // TickTime has no public ticks constructor in the UXP surface, so go via
    // seconds. TICKS_PER_SECOND is Premiere's fixed tick resolution.
    return ppro.TickTime.createWithSeconds(ticks / TICKS_PER_SECOND);
}

async function readValueAtTime(param, time) {
    try {
        return normalizeValue(await param.getValueAtTime(time));
    } catch {
        return null;
    }
}

function keyframeTicks(param) {
    try {
        const times = param.getKeyframeListAsTickTimes();
        if (!times || !times.length) return [];
        return times
            .map((t) => Number(t.ticksNumber))
            .filter((t) => isFinite(t))
            .sort((a, b) => a - b);
    } catch {
        return [];
    }
}

/** Upper bound on samples per parameter, so a pathological clip cannot hang. */
const MAX_SAMPLES = 240;

/**
 * Builds the list of times at which a parameter is sampled.
 *
 * Two sources are merged:
 *  - a uniform grid over the clip, which finds drift even when the parameter
 *    exposes no keyframes at all (the normal case while "override generated
 *    path" is off),
 *  - the parameter's own keyframe times, which are the exact instants the
 *    effect made a decision and are guaranteed valid for this parameter.
 *
 * Merging both means neither assumption has to hold on its own.
 */
function buildSampleTicks(inTicks, outTicks, keyTicks, gridSize) {
    const ticks = [];
    const push = (value) => {
        if (!isFinite(value)) return;
        ticks.push(value);
    };

    const span = outTicks - inTicks;
    const steps = Math.max(2, Math.min(gridSize, MAX_SAMPLES));
    if (span > 0) {
        for (let i = 0; i < steps; i++) {
            push(Math.round(inTicks + (span * i) / (steps - 1)));
        }
    } else {
        push(inTicks);
    }

    for (let i = 0; i < keyTicks.length; i++) push(keyTicks[i]);

    // Deduplicate and sort; cap the total.
    const unique = Array.from(new Set(ticks)).sort((a, b) => a - b);
    if (unique.length <= MAX_SAMPLES) return unique;

    const thinned = [];
    const stride = unique.length / MAX_SAMPLES;
    for (let i = 0; i < MAX_SAMPLES; i++) {
        thinned.push(unique[Math.min(unique.length - 1, Math.floor(i * stride))]);
    }
    // Always keep the exact end points — "start" and "end" must be exact.
    thinned[0] = unique[0];
    thinned[thinned.length - 1] = unique[unique.length - 1];
    return Array.from(new Set(thinned)).sort((a, b) => a - b);
}

/**
 * Samples a position parameter (plus optional scale/rotation parameters) over
 * a list of tick times.
 *
 * @returns {Promise<{samples:Array, failures:number, keyframeCount:number}>}
 */
async function samplePath(positionParam, scaleParam, rotationParam, sampleTicks) {
    const samples = [];
    let failures = 0;

    for (let i = 0; i < sampleTicks.length; i++) {
        const ticks = sampleTicks[i];
        const time = tickTimeFromTicks(ticks);

        const position = await readValueAtTime(positionParam, time);
        if (valueKind(position) !== "point") {
            failures++;
            continue;
        }

        const sample = { ticks: ticks, position: position };

        if (scaleParam) {
            const scale = await readValueAtTime(scaleParam, time);
            if (typeof scale === "number") sample.scale = scale;
        }
        if (rotationParam) {
            const rotation = await readValueAtTime(rotationParam, time);
            if (typeof rotation === "number") sample.rotation = rotation;
        }

        samples.push(sample);
    }

    return {
        samples: samples,
        failures: failures,
        keyframeCount: keyframeTicks(positionParam).length
    };
}

/**
 * Dumps every parameter of a component: index, name, type, current value and
 * keyframe count. Read-only, and the single most useful thing in a remote bug
 * report, because parameters can only be addressed by localized name or by
 * index and this is the one language-independent view of the layout.
 */
async function dumpParams(component) {
    const dump = [];
    let count = 0;
    try {
        count = component.getParamCount();
    } catch {
        return dump;
    }

    for (let i = 0; i < count; i++) {
        const entry = { index: i };
        try {
            const param = component.getParam(i);
            if (!param) {
                entry.note = "nicht lesbar";
                dump.push(entry);
                continue;
            }
            entry.name = param.displayName;
            try {
                entry.timeVarying = param.isTimeVarying();
            } catch {
                entry.timeVarying = null;
            }
            entry.keyframes = keyframeTicks(param).length;

            let raw;
            try {
                raw = await param.getValueAtTime(tickTime(0));
            } catch {
                raw = undefined;
            }
            const value = normalizeValue(raw);
            entry.type = valueKind(value);
            entry.value = entry.type === "unusable" ? describeValueShape(raw) : value;
        } catch (error) {
            entry.note = describeError(error);
        }
        dump.push(entry);
    }
    return dump;
}

// ---------------------------------------------------------------------------
// Sequence and selection
// ---------------------------------------------------------------------------

/** Sequence frame size in pixels, plus the derived aspect ratio. */
async function readFrameRect(sequence) {
    const settings = await sequence.getSettings();
    if (!settings) return null;
    const rect = await settings.getVideoFrameRect();
    if (!rect) return null;
    const width = toNumber(rect.width);
    const height = toNumber(rect.height);
    if (width === null || height === null || width <= 0 || height <= 0) return null;
    // Sequence pixels are square unless the sequence itself is anamorphic;
    // Premiere reports the frame rect in display pixels, so no PAR here.
    return { width: width, height: height, pixelAspect: 1, aspect: width / height };
}

/**
 * Reads the SOURCE frame size of a clip.
 *
 * This is what makes the calibration format-agnostic: together with the
 * sequence frame it determines which axis a fill-crop is pinned along, with no
 * assumption about either format. The UXP API has no direct accessor, so it
 * goes through the project metadata (see src/mediainfo.js).
 *
 * Returns null rather than a guess when the metadata cannot be read — the
 * calibration then falls back to its geometry-free probes and says so. A
 * fabricated default would be worse than a missing value, because it would
 * silently steer the pinned-axis decision.
 */
async function readSourceFrame(trackItem, logger, scope) {
    let projectItem = null;
    try {
        projectItem = await trackItem.getProjectItem();
    } catch (error) {
        logger.debug(scope, "ProjectItem nicht lesbar: " + describeError(error));
        return null;
    }
    if (!projectItem) return null;

    const sources = [];
    try {
        sources.push({
            name: "getProjectColumnsMetadata",
            text: await ppro.Metadata.getProjectColumnsMetadata(projectItem)
        });
    } catch (error) {
        logger.debug(scope, "getProjectColumnsMetadata fehlgeschlagen: " + describeError(error));
    }
    try {
        sources.push({
            name: "getProjectMetadata",
            text: await ppro.Metadata.getProjectMetadata(projectItem)
        });
    } catch (error) {
        logger.debug(scope, "getProjectMetadata fehlgeschlagen: " + describeError(error));
    }

    let frame = null;
    for (let i = 0; i < sources.length && !frame; i++) {
        const parsed = mediainfo.parseSourceFrame(sources[i].text);
        if (parsed) {
            frame = parsed;
            frame.metadataSource = sources[i].name;
        }
    }

    if (!frame) {
        logger.debug(scope, "Quellformat in den Metadaten nicht gefunden", {
            checked: sources.map((s) => s.name),
            lengths: sources.map((s) => (typeof s.text === "string" ? s.text.length : null))
        });
        return null;
    }

    /*
     * Prefer the authoritative pixel aspect ratio over the one embedded in the
     * VideoInfo string: the user may have reinterpreted the footage, and
     * FootageInterpretation reflects that while the metadata column may not.
     */
    try {
        const interpretation = await projectItem.getFootageInterpretation();
        if (interpretation) {
            const par = toNumber(interpretation.getPixelAspectRatio());
            if (par !== null && par > 0) {
                if (Math.abs(par - frame.pixelAspect) > 0.001) {
                    logger.debug(
                        scope,
                        "Pixel-Seitenverhältnis aus der Footage-Interpretation (" +
                            par +
                            ") weicht von den Metadaten (" +
                            frame.pixelAspect +
                            ") ab — die Interpretation gilt."
                    );
                }
                frame.pixelAspect = par;
                frame.pixelAspectSource = "FootageInterpretation";
            }
        }
    } catch (error) {
        logger.debug(scope, "Footage-Interpretation nicht lesbar: " + describeError(error));
    }

    logger.info(
        scope,
        "Quellformat gemessen: " +
            frame.width +
            "×" +
            frame.height +
            (frame.pixelAspect !== 1 ? " (PAR " + frame.pixelAspect + ")" : "") +
            " via " +
            frame.via
    );
    return frame;
}

/**
 * Collects the track items to work on.
 *
 * `scope` is one of:
 *   "selection"  — the current timeline selection
 *   "track"      — every clip on the track(s) that the selection sits on
 *   "allTracks"  — every clip on every video track
 *
 * "track" is deliberately derived from the selection rather than from a track
 * number typed into the panel: selecting one clip on V2 and saying "the whole
 * track" is the gesture the user described, and it cannot pick the wrong track
 * by off-by-one.
 */
async function collectTrackItems(sequence, scope, logger) {
    const trackCount = await sequence.getVideoTrackCount();

    if (scope === "allTracks" || scope === "track") {
        const selectedTrackIndexes = {};
        if (scope === "track") {
            const selection = await sequence.getSelection();
            const selected = selection ? await selection.getTrackItems() : [];
            for (let i = 0; i < selected.length; i++) {
                try {
                    const index = await selected[i].getTrackIndex();
                    selectedTrackIndexes[index] = true;
                } catch {
                    /* an item without a readable track index is skipped */
                }
            }
            if (!Object.keys(selectedTrackIndexes).length) {
                throw new Error(
                    "Für „ganze Spur“ muss mindestens ein Clip auf der gewünschten " +
                        "Spur ausgewählt sein, damit klar ist, welche Spur gemeint ist."
                );
            }
        }

        const items = [];
        for (let t = 0; t < trackCount; t++) {
            if (scope === "track" && !selectedTrackIndexes[t]) continue;
            const track = await sequence.getVideoTrack(t);
            if (!track) continue;
            const clips = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
            logger.debug("scope", "Spur V" + (t + 1) + ": " + clips.length + " Clips");
            for (let c = 0; c < clips.length; c++) {
                items.push({ trackIndex: t, trackItem: clips[c] });
            }
        }
        return items;
    }

    const selection = await sequence.getSelection();
    const selected = selection ? await selection.getTrackItems() : [];
    const items = [];
    for (let i = 0; i < selected.length; i++) {
        let trackIndex = null;
        try {
            trackIndex = await selected[i].getTrackIndex();
        } catch {
            trackIndex = null;
        }
        items.push({ trackIndex: trackIndex, trackItem: selected[i] });
    }
    return items;
}

module.exports = {
    AUTO_REFRAME: AUTO_REFRAME,
    MOTION: MOTION,
    AUTO_REFRAME_LAYOUT: AUTO_REFRAME_LAYOUT,
    MOTION_LAYOUT: MOTION_LAYOUT,
    PARAM_SPECS: PARAM_SPECS,
    TICKS_PER_SECOND: TICKS_PER_SECOND,
    normalizeValue: normalizeValue,
    valueKind: valueKind,
    describeValueShape: describeValueShape,
    tickTime: tickTime,
    tickTimeFromTicks: tickTimeFromTicks,
    readValueAtTime: readValueAtTime,
    keyframeTicks: keyframeTicks,
    buildSampleTicks: buildSampleTicks,
    samplePath: samplePath,
    dumpParams: dumpParams,
    findComponent: findComponent,
    resolveParam: resolveParam,
    tryResolveParam: tryResolveParam,
    readFrameRect: readFrameRect,
    readSourceFrame: readSourceFrame,
    collectTrackItems: collectTrackItems
};
