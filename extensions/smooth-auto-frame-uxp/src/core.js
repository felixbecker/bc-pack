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
const AUTO_REFRAME_MATCHNAME_FRAGMENTS = [
    "autoframer",
    "autoreframe",
    "auto_reframe",
    "aireframe"
];

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

/*
 * Parameter identification.
 *
 * Unlike Component, `ComponentParam` exposes no matchName — only the
 * LOCALIZED `displayName`. There is therefore no language-independent name to
 * match on, which is a genuine gap in the API. Matching exact names alone is
 * fragile: the German label for the override checkbox is "Erzeugten Pfad
 * überschreiben", not the "Generierten Schwenk überschreiben" that was
 * guessed here originally.
 *
 * Each parameter is therefore resolved in three stages:
 *   1. exact match against known localized names,
 *   2. substring match against language-spanning fragments,
 *   3. failing both, the clip is reported as an error together with a dump of
 *      all parameter names, so the lists can be corrected from real data
 *      instead of guesses.
 */

const OVERRIDE_PAN_PARAM_NAMES = [
    "override generated pan",
    "override generated path",
    "overwrite generated path",
    "override generated pan/scan",
    "erzeugten pfad überschreiben",
    "generierten pfad überschreiben",
    "generierten schwenk überschreiben"
];
const OVERRIDE_PAN_FRAGMENTS = ["überschreib", "uberschreib", "override", "overwrite"];

/*
 * Observed layout of AE.ADBE AEFilterAutoFramer (Premiere 26.3.2, de_DE):
 *
 *   0  " "                        (blank name)
 *   1  "Motion-Tracking"
 *   2  "Position"                 merged transform output, keyframed
 *   3  "Scale (Merged)"
 *   4  "Uniform Scale"
 *   5  "Anchor Point"
 *   6  "Position anpassen"        <- the parameter the manual workflow edits
 *   7  "Generated Keyframes"      the raw generated path
 *   8  ""                         (blank name)
 *   9  "Hash arb data"
 *  10  "Reframing für Versatz"
 *  11  "Reframing für Skalierung"
 *  12  "Scale (Auto Generated)"
 *  13  "Reframing für Drehung"
 *
 * Note that the "override generated path" checkbox visible in the UI has NO
 * usable displayName here — it is one of the blank entries. Name matching can
 * therefore never find it, which is why parameter VALUES are dumped as well:
 * the checkbox is identified by observing which parameter flips when it is
 * toggled manually.
 */
const AUTO_REFRAME_MATCHNAME = "AE.ADBE AEFilterAutoFramer";

/*
 * Known parameter indexes per effect matchName.
 *
 * Needed because some parameters have NO usable displayName. Confirmed by
 * diffing diagnostic dumps from Premiere 26.3.2 (de_DE) with the override
 * checkbox off and on: index 8 — whose displayName is the empty string — is
 * the only parameter that flipped false -> true. Index 0 (a single space) and
 * index 4 ("Uniform Scale") stayed unchanged, which rules them out.
 *
 * An index is only ever used when the name lookup fails, and the parameter
 * found there is still type-validated. A layout shift in a future Premiere
 * version therefore produces a clean error rather than a wrong write.
 */
const KNOWN_PARAM_LAYOUTS = {
    "ae.adbe aefilterautoframer": {
        overridePan: 8
    }
};

function knownParamIndex(matchName, key) {
    const layout = KNOWN_PARAM_LAYOUTS[normalizeName(matchName)];
    if (!layout) return -1;
    const index = layout[key];
    return typeof index === "number" ? index : -1;
}

/**
 * Waits. Needed because Premiere does not transfer the generated path onto the
 * editable parameter synchronously when the override checkbox is committed.
 */
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/*
 * The effect exposes three position-carrying parameters, and freezing only one
 * of them does NOT stop the movement. Measured in Premiere 26.3.2 after
 * pinning "Position anpassen" successfully (26 keyframes -> 0):
 *
 *   index 2 "Position"            26 keyframes, still animating
 *   index 6 "Position anpassen"    0 keyframes  (frozen)
 *   index 7 "Generated Keyframes" 26 keyframes, still animating
 *
 * The picture kept drifting, so "Position anpassen" is an additional offset
 * rather than the effective path. Every animated position parameter is
 * therefore frozen, each to its own value at the reference time.
 *
 * "Position" is the APPLIED parameter and doubles as the success criterion:
 * if it still animates afterwards, the movement was not removed.
 */
const APPLIED_POSITION_NAMES = ["position"];
const GENERATED_PATH_NAMES = ["generated keyframes", "erzeugte keyframes"];
const ADJUST_POSITION_NAMES = ["adjust position", "position anpassen"];

/* "Position anpassen" / "Adjust Position" must outrank the bare "Position". */
const POSITION_PARAM_NAMES = ["adjust position", "position anpassen", "position"];
const POSITION_FRAGMENTS = ["position anpassen", "adjust position", "position"];

const SCALE_PARAM_NAMES = ["adjust scale", "scale", "skalierung", "skalierung anpassen"];
const SCALE_FRAGMENTS = ["scale", "skalier", "zoom"];

const ROTATION_PARAM_NAMES = ["adjust rotation", "rotation", "drehung"];
const ROTATION_FRAGMENTS = ["rotation", "drehung", "rotat"];


const PLUGIN_VERSION = "1.0.0";

/*
 * Incremented whenever the diagnostics payload changes. A log can then be
 * matched to the build that produced it — without this it was unclear whether
 * a report came from the current code or a stale installed copy.
 */
const DIAGNOSTICS_VERSION = 9;

/**
 * Collects host application info for diagnostics logs. Wrapped defensively
 * because the exact shape of the UXP host object is not guaranteed across
 * versions, and a missing field must never break a run.
 */
function describeHost() {
    const info = {};
    try {
        const uxp = require("uxp");
        if (uxp && uxp.host) {
            if (uxp.host.name) info.app = String(uxp.host.name);
            if (uxp.host.version) info.appVersion = String(uxp.host.version);
            if (uxp.host.uiLocale) info.uiLocale = String(uxp.host.uiLocale);
        }
        if (uxp && uxp.versions) {
            if (uxp.versions.uxp) info.uxp = String(uxp.versions.uxp);
            if (uxp.versions.plugin) info.plugin = String(uxp.versions.plugin);
        }
    } catch {
        info.note = "Host-Infos nicht verfügbar";
    }
    return info;
}

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

/**
 * Coerces a value to a finite number, accepting numeric strings.
 * Returns null when that is not possible.
 */
function toFiniteNumber(candidate) {
    if (typeof candidate === "number") {
        return isFinite(candidate) ? candidate : null;
    }
    if (typeof candidate === "string" && candidate.trim() !== "") {
        const parsed = Number(candidate);
        return isFinite(parsed) ? parsed : null;
    }
    return null;
}

/** True for anything that carries two usable numeric components. */
function looksLikePoint(candidate) {
    if (candidate === null || typeof candidate !== "object") return false;
    if (Array.isArray(candidate)) {
        return (
            candidate.length >= 2 &&
            toFiniteNumber(candidate[0]) !== null &&
            toFiniteNumber(candidate[1]) !== null
        );
    }
    return toFiniteNumber(candidate.x) !== null && toFiniteNumber(candidate.y) !== null;
}

function readPoint(candidate) {
    if (Array.isArray(candidate)) {
        return { x: toFiniteNumber(candidate[0]), y: toFiniteNumber(candidate[1]) };
    }
    return { x: toFiniteNumber(candidate.x), y: toFiniteNumber(candidate.y) };
}

const MAX_UNWRAP_DEPTH = 4;

/**
 * Premiere does not always hand back a bare value. Depending on version and
 * parameter type it can return a wrapper around it — the UXP reference even
 * types `Keyframe.value` as `{value: ...}`, i.e. the payload sits one level
 * deeper. This peels off such layers until an inspectable value appears.
 */
function unwrapValue(raw) {
    let current = raw;
    for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
        if (current === null || typeof current !== "object") return current;
        if (Array.isArray(current) || looksLikePoint(current)) return current;

        let next;
        try {
            next = current.value;
        } catch {
            return current;
        }
        if (next === undefined || next === current) return current;
        current = next;
    }
    return current;
}

/**
 * Normalizes whatever Premiere returned into plain JS:
 * a number, a boolean, or `{x, y}`. Returns null if the value is unusable,
 * which callers must treat as "do not write anything".
 */
function normalizeReadValue(raw) {
    const value = unwrapValue(raw);

    if (typeof value === "boolean") return value;

    if (typeof value !== "object" || value === null) {
        const numeric = toFiniteNumber(value);
        return numeric === null ? null : numeric;
    }

    if (looksLikePoint(value)) return readPoint(value);

    return null;
}

const MAX_JSON_DEPTH = 5;
const MAX_JSON_ENTRIES = 24;

/**
 * Collects the readable property names of a value.
 *
 * `for...in` alone is not enough for Premiere's host objects: accessors
 * declared on a class prototype are non-enumerable, so a PointF-like object
 * would appear to have no properties at all. This therefore also walks the
 * prototype chain via getOwnPropertyNames.
 */
function collectReadableKeys(value) {
    const keys = [];
    const seen = Object.create(null);

    function push(key) {
        if (key === "constructor" || seen[key]) return;
        seen[key] = true;
        keys.push(key);
    }

    try {
        for (const key in value) push(key);
    } catch {
        /* host objects may refuse enumeration */
    }

    let current = value;
    let depth = 0;
    while (current && current !== Object.prototype && depth < 6) {
        try {
            const names = Object.getOwnPropertyNames(current);
            for (let i = 0; i < names.length; i++) push(names[i]);
        } catch {
            break;
        }
        try {
            current = Object.getPrototypeOf(current);
        } catch {
            break;
        }
        depth++;
    }

    return keys;
}

/**
 * Serializes a value for diagnostics.
 *
 * Plain JSON.stringify is not enough for Premiere's host objects: their data
 * usually sits behind non-enumerable prototype getters, which JSON.stringify
 * skips — a PointF would come out as "{}". This reads the properties found by
 * collectReadableKeys instead, bounded in depth and width, and never throws.
 */
function safeJson(value, depth) {
    const level = depth || 0;

    if (value === null) return "null";
    if (value === undefined) return "undefined";

    const type = typeof value;
    if (type === "number") {
        return isFinite(value) ? String(value) : '"' + String(value) + '"';
    }
    if (type === "boolean") return String(value);
    if (type === "string") return JSON.stringify(value);
    if (type === "function") return '"[Function]"';
    if (type !== "object") return '"' + String(value) + '"';

    if (level >= MAX_JSON_DEPTH) return '"[zu tief verschachtelt]"';

    if (Array.isArray(value)) {
        const items = [];
        for (let i = 0; i < value.length && i < MAX_JSON_ENTRIES; i++) {
            items.push(safeJson(value[i], level + 1));
        }
        if (value.length > MAX_JSON_ENTRIES) items.push('"…"');
        return "[" + items.join(",") + "]";
    }

    const keys = collectReadableKeys(value);
    const parts = [];
    for (let i = 0; i < keys.length; i++) {
        if (parts.length >= MAX_JSON_ENTRIES) {
            parts.push('"…":"abgeschnitten"');
            break;
        }
        const key = keys[i];
        let member;
        try {
            member = value[key];
        } catch {
            member = "[nicht lesbar]";
        }
        // Methods add noise without diagnostic value.
        if (typeof member === "function") continue;
        parts.push(JSON.stringify(key) + ":" + safeJson(member, level + 1));
    }

    return "{" + parts.join(",") + "}";
}

/**
 * Builds a human-readable description of an unexpected value, for error
 * messages. Plain String(value) yields "[object Object]", which tells nobody
 * anything — this surfaces constructor name, keys and probe fields instead.
 */
function describeShape(raw) {
    if (raw === null) return "null";
    if (raw === undefined) return "undefined";

    const type = typeof raw;
    if (type !== "object") return type + " " + String(raw);

    const parts = [];
    try {
        if (raw.constructor && raw.constructor.name) {
            parts.push("typ=" + raw.constructor.name);
        }
    } catch {
        /* host objects may not expose constructor */
    }

    if (Array.isArray(raw)) {
        parts.push("array(" + raw.length + ")");
    }

    const keys = [];
    const found = collectReadableKeys(raw);
    for (let i = 0; i < found.length && keys.length < 14; i++) {
        let member;
        try {
            member = raw[found[i]];
        } catch {
            member = undefined;
        }
        if (typeof member === "function") continue;
        keys.push(found[i]);
    }
    if (keys.length) parts.push("keys=[" + keys.join(",") + "]");

    const probes = ["value", "x", "y", "horizontal", "vertical", "width", "height"];
    for (let i = 0; i < probes.length; i++) {
        const probe = probes[i];
        try {
            const probed = raw[probe];
            if (probed !== undefined) {
                parts.push(probe + ":" + typeof probed + "=" + String(probed));
            }
        } catch {
            /* ignore inaccessible property */
        }
    }

    return parts.length ? parts.join(" ") : "leeres Objekt";
}

/** True for the normalized point form produced by normalizeReadValue. */
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
 *
 * Returns the component when found, otherwise a list of every component that
 * WAS present (matchName + displayName). Without that list a clip with an
 * Auto Reframe effect under an unrecognized name would be indistinguishable
 * from a clip that genuinely has no Auto Reframe — the report must be able to
 * tell those two apart.
 *
 * @returns {Promise<{found: boolean, chain, index, component, components}>}
 */
async function findAutoReframeComponent(trackItem) {
    const chain = await trackItem.getComponentChain();
    if (!chain) return { found: false, components: [] };

    const components = [];
    const count = chain.getComponentCount();

    for (let i = 0; i < count; i++) {
        const component = chain.getComponentAtIndex(i);
        if (!component) {
            components.push({ index: i, note: "nicht lesbar" });
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

        components.push({ index: i, matchName: matchName, name: displayName });

        if (
            // Exact matchName is the most reliable identifier: it is not
            // localized and does not change with the UI language.
            normalizeName(matchName) === normalizeName(AUTO_REFRAME_MATCHNAME) ||
            containsFragment(matchName, AUTO_REFRAME_MATCHNAME_FRAGMENTS) ||
            containsFragment(displayName, AUTO_REFRAME_MATCHNAME_FRAGMENTS) ||
            nameMatches(displayName, AUTO_REFRAME_DISPLAY_NAMES)
        ) {
            return {
                found: true,
                chain: chain,
                index: i,
                component: component,
                matchName: matchName,
                components: components
            };
        }
    }

    return { found: false, chain: chain, components: components };
}

/**
 * Finds a parameter index on a component.
 *
 * Candidates are tried in PRIORITY ORDER, not in parameter order: the Auto
 * Reframe effect exposes both "Position" (the merged transform output) and
 * "Position anpassen" / "Adjust Position" (the parameter the manual workflow
 * edits). Scanning parameters first and matching any name would pick whichever
 * comes earlier in the effect, which is the wrong one.
 *
 * Exact names are preferred over substring fragments. Returns -1 when nothing
 * matches.
 */
function findParamIndex(component, candidateNames, fragments) {
    const count = component.getParamCount();

    for (let c = 0; c < candidateNames.length; c++) {
        const wanted = normalizeName(candidateNames[c]);
        for (let i = 0; i < count; i++) {
            const param = component.getParam(i);
            if (param && normalizeName(param.displayName) === wanted) return i;
        }
    }

    if (fragments && fragments.length) {
        for (let f = 0; f < fragments.length; f++) {
            for (let i = 0; i < count; i++) {
                const param = component.getParam(i);
                if (!param) continue;
                if (normalizeName(param.displayName).indexOf(fragments[f]) !== -1) {
                    return i;
                }
            }
        }
    }

    return -1;
}

/**
 * Resolves a REQUIRED parameter, or throws with full diagnostics.
 *
 * Name-based lookups against localized `displayName` strings are inherently
 * unreliable — there is no matchName for parameters. A lookup that silently
 * returns "not found" and lets the caller continue is therefore the single
 * most dangerous pattern in this plugin: that is exactly how an earlier
 * version skipped the override checkbox and then reported success.
 *
 * Every name-based lookup must thus either succeed or abort loudly, and the
 * error has to carry enough context to correct the name lists from real data.
 *
 * @param {string} label   human-readable purpose, e.g. "Position"
 * @param {boolean} [expectBoolean]  verify the parameter reads as a boolean —
 *        guards against matching a numeric parameter by accident
 */
async function resolveRequiredParam(
    component,
    label,
    candidateNames,
    fragments,
    paramDump,
    expectBoolean,
    fallbackIndex
) {
    let index = findParamIndex(component, candidateNames, fragments);
    let resolvedBy = "name";

    // Some parameters carry no usable displayName (the override checkbox is
    // literally named ""), so a known index is the only way to reach them.
    if (index < 0 && typeof fallbackIndex === "number" && fallbackIndex >= 0) {
        if (fallbackIndex < component.getParamCount()) {
            index = fallbackIndex;
            resolvedBy = "index";
        }
    }

    if (index < 0) {
        let hint = "";
        if (expectBoolean && paramDump && paramDump.length) {
            const booleans = [];
            for (let i = 0; i < paramDump.length; i++) {
                if (paramDump[i].valueType === "boolean") {
                    booleans.push(
                        "Index " +
                            paramDump[i].index +
                            ' ("' +
                            (paramDump[i].name || "") +
                            '") = ' +
                            paramDump[i].value
                    );
                }
            }
            hint = booleans.length
                ? " Parameter mit Wahrheitswert (mögliche Checkbox): " +
                  booleans.join("; ") +
                  "."
                : " Es gibt keinen Parameter mit Wahrheitswert.";
        }

        throw new Error(
            'Parameter "' +
                label +
                '" wurde im Auto-Reframe-Effekt nicht gefunden. Die UXP-API ' +
                "bietet für Parameter nur den lokalisierten Anzeigenamen, daher " +
                "kann die Suche bei einer unbekannten Sprachversion fehlschlagen." +
                hint +
                " Vorhandene Parameter: " +
                safeJson(paramDump)
        );
    }

    const param = component.getParam(index);
    if (!param) {
        throw new Error(
            'Parameter "' + label + '" (Index ' + index + ") ist nicht lesbar."
        );
    }

    // "Found" is not enough — the parameter must also yield a usable value.
    if (expectBoolean) {
        let probe;
        try {
            probe = normalizeReadValue(await param.getStartValue());
        } catch {
            probe = undefined;
        }
        if (probe === undefined || probe === null) {
            try {
                probe = normalizeReadValue(
                    await param.getValueAtTime(TickTimeZero())
                );
            } catch {
                probe = undefined;
            }
        }
        if (typeof probe !== "boolean") {
            throw new Error(
                'Der als "' +
                    label +
                    '" erkannte Parameter "' +
                    param.displayName +
                    '" (aufgelöst per ' + resolvedBy +
                    ') liefert keinen Wahrheitswert, sondern ' +
                    safeJson(probe) +
                    ". Vermutlich wurde der falsche Parameter getroffen. " +
                    "Vorhandene Parameter: " +
                    safeJson(paramDump)
            );
        }
    }

    return {
        index: index,
        param: param,
        name: param.displayName,
        resolvedBy: resolvedBy
    };
}

/** TickTime zero, used for probing a parameter's value. */
function TickTimeZero() {
    return ppro.TickTime.createWithSeconds(0);
}

/**
 * Dumps every parameter of a component: index, display name, whether it is
 * keyframed, how many keyframes it has — and its CURRENT VALUE.
 *
 * The values matter because the override checkbox has no usable displayName in
 * this effect. Dumping values makes it identifiable empirically: toggle the
 * checkbox in Premiere, dump again, and the parameter that flipped is the one.
 * Purely read-only.
 */
async function describeComponentParams(component) {
    const params = [];
    let count = 0;
    try {
        count = component.getParamCount();
    } catch {
        return params;
    }

    for (let i = 0; i < count; i++) {
        const entry = { index: i };
        try {
            const param = component.getParam(i);
            if (!param) {
                entry.note = "nicht lesbar";
                params.push(entry);
                continue;
            }
            entry.name = param.displayName;
            try {
                entry.timeVarying = param.isTimeVarying();
            } catch {
                entry.timeVarying = null;
            }
            try {
                entry.keyframes = getKeyframeTimes(param).length;
            } catch {
                entry.keyframes = null;
            }

            let raw;
            try {
                raw = await param.getStartValue();
            } catch {
                raw = undefined;
            }
            if (raw === undefined) {
                try {
                    raw = await param.getValueAtTime(TickTimeZero());
                } catch {
                    raw = undefined;
                }
            }
            const normalized = normalizeReadValue(raw);
            entry.value = normalized === null ? safeJson(raw) : normalized;
            entry.valueType = typeof normalized;
        } catch (error) {
            entry.note = describeError(error);
        }
        params.push(entry);
    }
    return params;
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
        return normalizeReadValue(await param.getValueAtTime(fallbackTime));
    }

    let sumX = 0;
    let sumY = 0;
    let sumScalar = 0;
    let isPoint = false;
    let count = 0;

    for (let i = 0; i < keyTimes.length; i++) {
        const value = normalizeReadValue(await param.getValueAtTime(keyTimes[i]));
        if (isPointValue(value)) {
            isPoint = true;
            sumX += value.x;
            sumY += value.y;
        } else if (typeof value === "number") {
            sumScalar += value;
        } else {
            // Unsupported type for averaging — fall back to a single sample.
            return normalizeReadValue(await param.getValueAtTime(fallbackTime));
        }
        count++;
    }

    if (!count) return normalizeReadValue(await param.getValueAtTime(fallbackTime));
    if (isPoint) return { x: sumX / count, y: sumY / count };
    return sumScalar / count;
}

/**
 * Builds the write plan for one parameter: which value to pin it to, and at
 * which time (the latter only matters in keyframe mode).
 */
async function planParam(component, paramIndex, trackItem, sequence, timing, sourceIndex) {
    const param = component.getParam(paramIndex);
    if (!param) return null;

    /*
     * Where to READ the reference value from.
     *
     * Premiere only transfers the generated path onto the editable parameter
     * when the checkbox is toggled in the UI; setting it through the API does
     * not trigger that side effect, so the editable parameter can stay empty
     * and would yield the neutral default. The raw generated path carries the
     * keyframes regardless, so it serves as the source of truth when the
     * target parameter has none. Written is always the target parameter.
     */
    let readParam = param;
    let readFrom = "target";
    if (typeof sourceIndex === "number" && sourceIndex >= 0 && sourceIndex !== paramIndex) {
        if (getKeyframeTimes(param).length === 0) {
            const source = component.getParam(sourceIndex);
            if (source && getKeyframeTimes(source).length > 0) {
                readParam = source;
                readFrom = "generatedPath";
            }
        }
    }

    const referenceTime = await resolveReferenceTime(readParam, trackItem, sequence, timing);

    const rawValue =
        timing === TIMING.AVERAGE
            ? await computeAverageValue(readParam, referenceTime)
            : await readParam.getValueAtTime(referenceTime);

    // The average path already returns normalized data; a direct read does not.
    const value =
        timing === TIMING.AVERAGE ? rawValue : normalizeReadValue(rawValue);

    if (!isWritableValue(value)) {
        throw new Error(
            'Parameter "' +
                param.displayName +
                '" lieferte keinen verwertbaren Wert.' +
                " Struktur: " +
                describeShape(rawValue) +
                " | JSON: " +
                safeJson(rawValue)
        );
    }

    const keyTimes = getKeyframeTimes(readParam);

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
    let clearStart;
    let clearEnd;
    if (keyTimes.length > 0) {
        clearStart = keyTimes[0];
        clearEnd = keyTimes[keyTimes.length - 1];
    } else {
        clearStart = await trackItem.getInPoint();
        clearEnd = await trackItem.getOutPoint();
    }

    /*
     * The single keyframe sits at the reference time — the frame the user
     * chose to keep. That is the whole point: everything else is discarded and
     * this one value holds for the clip.
     */
    const writeStart = referenceTime;

    return {
        paramIndex: paramIndex,
        paramName: param.displayName,
        readFrom: readFrom,
        readParamName: readParam.displayName,
        value: value,
        referenceTime: referenceTime,
        writeStart: writeStart,
        clearStart: clearStart,
        clearEnd: clearEnd,
        keyframeCount: keyTimes.length
    };
}

/**
 * Discovery for a single clip: locate the effect and resolve the parameter
 * indices. Reads NO keyframe data yet.
 *
 * Splitting discovery from value reading is required by how Auto Reframe
 * behaves: with the override checkbox off, "Position" and "Position anpassen"
 * report as non-keyframed with zero keyframes — the generated path lives in a
 * separate "Generated Keyframes" parameter. The keyframes only become visible
 * on the editable parameters once the checkbox is enabled. Reading values
 * before that point therefore yields the wrong reference value.
 */
async function discoverClip(trackItem, options) {
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
    if (!found.found) {
        return {
            status: "skipped",
            clipName: clipName,
            reason:
                "Kein Auto-Reframe-Effekt auf diesem Clip gefunden. " +
                "Vorhandene Effekte: " +
                safeJson(found.components),
            // Lets an Auto Reframe effect under an unknown name be told apart
            // from a clip that genuinely has none.
            components: found.components
        };
    }

    const component = found.component;
    const paramDump = await describeComponentParams(component);

    try {
        const position = await resolveRequiredParam(
            component, "Position", POSITION_PARAM_NAMES, POSITION_FRAGMENTS, paramDump
        );
        /*
         * The override checkbox has an empty displayName in this effect, so
         * the name lookup is expected to fail and the known index is used.
         * The parameter found there is still validated as a boolean.
         */
        const override = await resolveRequiredParam(
            component,
            "Erzeugten Pfad überschreiben",
            OVERRIDE_PAN_PARAM_NAMES,
            OVERRIDE_PAN_FRAGMENTS,
            paramDump,
            true,
            knownParamIndex(found.matchName, "overridePan")
        );

        const extras = [];
        if (options.fixScale) {
            extras.push(
                await resolveRequiredParam(
                    component, "Skalierung", SCALE_PARAM_NAMES, SCALE_FRAGMENTS, paramDump
                )
            );
        }
        if (options.fixRotation) {
            extras.push(
                await resolveRequiredParam(
                    component, "Drehung", ROTATION_PARAM_NAMES, ROTATION_FRAGMENTS, paramDump
                )
            );
        }

        let overrideActive = null;
        try {
            overrideActive =
                normalizeReadValue(await override.param.getStartValue()) === true;
        } catch {
            overrideActive = null;
        }

        const generatedIndex = findParamIndex(component, GENERATED_PATH_NAMES, null);
        const appliedIndex = findParamIndex(component, APPLIED_POSITION_NAMES, null);
        const adjustIndex = findParamIndex(component, ADJUST_POSITION_NAMES, null);

        /*
         * All position-carrying parameters, in the order they are frozen.
         * Duplicates and unresolved entries are dropped; the primary target
         * (resolved above) is always included.
         */
        const positionIndexes = [];
        const seenIndex = {};
        const candidates = [appliedIndex, adjustIndex, generatedIndex, position.index];
        for (let c = 0; c < candidates.length; c++) {
            const idx = candidates[c];
            if (idx >= 0 && !seenIndex[idx]) {
                seenIndex[idx] = true;
                positionIndexes.push(idx);
            }
        }

        return {
            status: "discovered",
            clipName: clipName,
            generatedPathIndex: generatedIndex,
            trackItem: trackItem,
            chain: found.chain,
            componentIndex: found.index,
            overridePanIndex: override.index,
            overrideResolvedBy: override.resolvedBy,
            overrideActiveBefore: overrideActive,
            paramIndexes: positionIndexes.concat(extras.map((e) => e.index)),
            // Separated because the skip rule differs: a position candidate
            // without keyframes has nothing to freeze, whereas Scale/Rotation
            // were requested explicitly and must be handled even when static.
            positionIndexCount: positionIndexes.length,
            params: paramDump,
            components: found.components
        };
    } catch (error) {
        // A failed lookup or an unusable value aborts this clip loudly, with
        // the full parameter layout attached so the cause is visible.
        return {
            status: "error",
            clipName: clipName,
            reason: describeError(error),
            params: paramDump,
            components: found.components
        };
    }
}

/**
 * Reads the reference values for a discovered clip and builds the write plan.
 * Must run AFTER the override checkbox has been enabled — see discoverClip.
 */
async function planClipValues(discovery, sequence, options, firstPass) {
    const component = discovery.chain.getComponentAtIndex(discovery.componentIndex);
    if (!component) {
        throw new Error("Auto-Reframe-Komponente nicht mehr lesbar.");
    }

    // How many position candidates actually carry keyframes — decides whether
    // a keyframe-less candidate can be skipped.
    let positionTargets = 0;
    for (let i = 0; i < (discovery.positionIndexCount || 0); i++) {
        const probe = component.getParam(discovery.paramIndexes[i]);
        if (probe && getKeyframeTimes(probe).length > 0) positionTargets++;
    }

    const targets = [];
    for (let i = 0; i < discovery.paramIndexes.length; i++) {
        const index = discovery.paramIndexes[i];
        const param = component.getParam(index);
        if (!param) continue;

        /*
         * Position candidates without keyframes carry no movement, so freezing
         * them would only overwrite a user setting for no gain — they are
         * skipped as long as at least one other position candidate remains.
         * Explicitly requested parameters (Scale/Rotation) are always handled,
         * even when static: the user asked for them, and silently doing
         * nothing while reporting success is the bug class this plugin exists
         * to avoid.
         */
        const isPositionCandidate = i < (discovery.positionIndexCount || 1);
        // Scale/Rotation are handled once, in the first pass only.
        if (!isPositionCandidate && !firstPass) continue;

        /*
         * A parameter already written in this run and sitting at its target
         * state is settled. Without this check the default mode would see its
         * own single keyframe as "animating" and rewrite it forever.
         */
        const alreadyWritten =
            discovery.writtenTargets && discovery.writtenTargets[index];
        if (alreadyWritten) {
            const expectedCount = options.staticValue ? 0 : 1;
            if (getKeyframeTimes(param).length === expectedCount) continue;
        }
        const hasKeyframes = getKeyframeTimes(param).length > 0;
        if (isPositionCandidate && !hasKeyframes) {
            // At least one position candidate carries the movement: the others
            // are static and must stay untouched.
            if (positionTargets >= 1) continue;
            // None carries keyframes. On the first pass keep the primary
            // candidate so the run has a target at all; in later passes an
            // empty set is the desired outcome and must not be re-written.
            if (!firstPass || i > 0) continue;
        }

        targets.push(
            await planParam(
                component,
                index,
                discovery.trackItem,
                sequence,
                options.timing,
                // Fall back to the generated path only when this parameter
                // itself carries no keyframes.
                discovery.generatedPathIndex
            )
        );
    }

    // An empty result is normal in later passes: nothing animates any more.
    return targets.filter((target) => target !== null);
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
 * @param {boolean} rawOptions.staticValue  no keyframes at all (opt-in)
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
        /*
         * Default follows the manual workflow from the tutorial: delete all
         * keyframes, then write exactly ONE keyframe holding the chosen value.
         * Its author notes that "Premiere Pro wants to have at least one
         * keyframe on this property" — and that matches what was measured
         * here: with keyframing switched off entirely, Premiere re-transfers
         * the generated path onto the parameter afterwards.
         *
         * staticValue is the opt-in alternative (no keyframes at all).
         */
        staticValue: !!(rawOptions && rawOptions.staticValue)
    };

    const report = {
        processed: 0,
        skipped: 0,
        errors: 0,
        dryRun: options.dryRun,
        // Echoed back so the panel can show which option was actually applied —
        // this makes a mis-read picker value visible instead of silent.
        timing: options.timing,
        // Context for exported diagnostics logs.
        meta: {
            timestamp: new Date().toISOString(),
            pluginVersion: PLUGIN_VERSION,
            diagnosticsVersion: DIAGNOSTICS_VERSION,
            options: {
                timing: options.timing,
                fixScale: options.fixScale,
                fixRotation: options.fixRotation,
                dryRun: options.dryRun,
                staticValue: options.staticValue
            },
            host: describeHost()
        },
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

    // ---- Phase 1: discover effect and parameter indices (no values yet) ----
    const plans = [];
    for (let i = 0; i < trackItems.length; i++) {
        const trackItem = trackItems[i];
        let discovery;
        try {
            discovery = await discoverClip(trackItem, options);
        } catch (error) {
            report.errors++;
            report.results.push({
                clipName: "(Clip " + (i + 1) + ")",
                status: "error",
                reason: describeError(error)
            });
            continue;
        }

        if (discovery.status !== "discovered") {
            if (discovery.status === "error") {
                report.errors++;
            } else {
                report.skipped++;
            }
            report.results.push(discovery);
            continue;
        }

        plans.push(discovery);
    }

    /*
     * ---- Dry run: report without touching the project ----
     *
     * With the override checkbox off, the editable parameters report zero
     * keyframes — the generated path is not exposed on them yet. A dry run
     * must not enable the checkbox, so the reference values it can show are
     * limited in that state. This is stated explicitly rather than presenting
     * possibly meaningless numbers as if they were final.
     */
    if (options.dryRun) {
        for (let i = 0; i < plans.length; i++) {
            const plan = plans[i];
            let targets = null;
            let planError = null;
            try {
                targets = await planClipValues(plan, sequence, options);
            } catch (error) {
                planError = describeError(error);
            }

            report.processed++;
            report.results.push({
                clipName: plan.clipName,
                status: "ok",
                reason:
                    "Dry-Run — es wurde nichts geschrieben." +
                    (plan.overrideActiveBefore === false
                        ? ' Hinweis: "Erzeugten Pfad überschreiben" ist noch nicht aktiv. ' +
                          "Auto Reframe gibt die Keyframes erst nach dem Aktivieren auf " +
                          "den bearbeitbaren Parametern frei — der echte Lauf aktiviert " +
                          "die Checkbox zuerst und liest die Werte danach."
                        : ""),
                overrideActiveBefore: plan.overrideActiveBefore,
                changes: targets
                    ? targets.map((target) => ({
                          param: target.paramName,
                          value: describeValue(target.value),
                          keyframesBefore: target.keyframeCount
                      }))
                    : [],
                planError: planError,
                // Index layout of the effect, for diagnostics. Parameters can
                // only be addressed by localized name or by index, so this is
                // the one language-independent handle available.
                params: plan.params
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

    // ---- Phase 2a: enable the override checkbox, in its own transaction ----
    /*
     * This deliberately runs BEFORE the value writes rather than in the same
     * compound action. Auto Reframe drives the position from its own motion
     * analysis; the parameter only becomes writable once "override generated
     * path" is committed. Inside a single compound action the intermediate
     * state is not yet visible to the following actions, which is why an
     * earlier version appeared to succeed while changing nothing.
     *
     * The cost is that a run is two undo steps instead of one. That is the
     * right trade: correctness over undo convenience.
     */
    let overrideError = null;
    project.lockedAccess(() => {
        try {
            project.executeTransaction((compoundAction) => {
                for (let i = 0; i < plans.length; i++) {
                    const plan = plans[i];
                    if (plan.chainError) continue;

                    const component = plan.chain.getComponentAtIndex(plan.componentIndex);
                    if (!component) continue;

                    const overrideParam = component.getParam(plan.overridePanIndex);
                    if (!overrideParam) continue;

                    const keyframe = overrideParam.createKeyframe(true);
                    compoundAction.addAction(
                        overrideParam.createSetValueAction(keyframe, true)
                    );
                }
            }, "Smooth Auto Frame — Pfad überschreiben");
        } catch (error) {
            overrideError = error;
        }
    });

    if (overrideError) {
        report.errors += plans.length;
        for (let i = 0; i < plans.length; i++) {
            report.results.push({
                clipName: plans[i].clipName,
                status: "error",
                reason:
                    "Checkbox zum Überschreiben konnte nicht gesetzt werden: " +
                    describeError(overrideError)
            });
        }
        return report;
    }

    /*
     * ---- Phase 2b: confirm the override checkbox actually took effect ----
     */
    const active = [];
    for (let i = 0; i < plans.length; i++) {
        const plan = plans[i];
        if (plan.chainError) {
            report.errors++;
            report.results.push({
                clipName: plan.clipName,
                status: "error",
                reason: "Effektkette nicht mehr lesbar: " + plan.chainError
            });
            continue;
        }

        try {
            const refreshed = await plan.trackItem.getComponentChain();
            if (refreshed) plan.chain = refreshed;
            const component = plan.chain.getComponentAtIndex(plan.componentIndex);
            const overrideParam = component ? component.getParam(plan.overridePanIndex) : null;
            if (!overrideParam) {
                throw new Error("Override-Parameter nach dem Setzen nicht lesbar.");
            }

            plan.overrideActive =
                normalizeReadValue(await overrideParam.getStartValue()) === true;

            if (!plan.overrideActive) {
                report.errors++;
                report.results.push({
                    clipName: plan.clipName,
                    status: "error",
                    reason:
                        'Die Checkbox "Erzeugten Pfad überschreiben" ließ sich nicht ' +
                        "aktivieren — Auto Reframe würde jede Änderung verwerfen. " +
                        "Es wurde nichts geschrieben. Parameter: " +
                        safeJson(plan.params),
                    params: plan.params
                });
                continue;
            }

            plan.allChanges = [];
            plan.passes = 0;
            active.push(plan);
        } catch (error) {
            report.errors++;
            report.results.push({
                clipName: plan.clipName,
                status: "error",
                reason: describeError(error),
                params: plan.params
            });
        }
    }

    if (!active.length) {
        report.notes.push(
            "Kein Clip war nach dem Aktivieren der Checkbox beschreibbar."
        );
        return report;
    }

    /*
     * ---- Phase 2c: freeze in repeated passes until nothing animates ----
     *
     * One pass is not enough. Premiere populates the position parameters
     * ASYNCHRONOUSLY after the override is enabled, so a parameter that was
     * empty while planning can acquire the keyframes right after the write.
     * Measured in 26.3.2: "Position" and "Generated Keyframes" were frozen
     * successfully, and afterwards "Position anpassen" held 32 keyframes and
     * the picture still drifted.
     *
     * Each pass therefore re-reads which parameters currently animate, freezes
     * exactly those, waits briefly for the effect to settle, and repeats.
     */
    const MAX_PASSES = 5;
    const SETTLE_MS = 300;

    for (let pass = 0; pass < MAX_PASSES; pass++) {
        const pending = [];

        for (let i = 0; i < active.length; i++) {
            const plan = active[i];
            if (plan.failed) continue;

            try {
                const refreshed = await plan.trackItem.getComponentChain();
                if (refreshed) plan.chain = refreshed;

                // Extras (Scale/Rotation) only need handling once.
                const targets = await planClipValues(plan, sequence, options, pass === 0);
                if (targets.length) pending.push({ plan: plan, targets: targets });
            } catch (error) {
                plan.failed = true;
                plan.failure = describeError(error);
            }
        }

        if (!pending.length) break;

        let passError = null;
        project.lockedAccess(() => {
            try {
                project.executeTransaction((compoundAction) => {
                    // Synchronous by contract: no await, params re-acquired
                    // from the freshly fetched chain.
                    for (let i = 0; i < pending.length; i++) {
                        const plan = pending[i].plan;
                        const targets = pending[i].targets;
                        const component = plan.chain.getComponentAtIndex(
                            plan.componentIndex
                        );
                        if (!component) continue;

                        for (let t = 0; t < targets.length; t++) {
                            const target = targets[t];
                            const param = component.getParam(target.paramIndex);
                            if (!param) continue;

                            const nativeValue = toNativeValue(target.value);

                            if (!options.staticValue) {
                                /*
                                 * The tutorial's workflow: clear every
                                 * keyframe, then write exactly ONE holding the
                                 * chosen value. A single keyframe is constant
                                 * by definition — there is nothing to
                                 * interpolate towards — and it satisfies
                                 * Premiere's apparent expectation that the
                                 * property carries at least one keyframe.
                                 * Writing two (as an earlier version did) adds
                                 * no safety and deviates from the only
                                 * variant known to work.
                                 */
                                compoundAction.addAction(
                                    param.createSetTimeVaryingAction(true)
                                );
                                compoundAction.addAction(
                                    param.createRemoveKeyframeRangeAction(
                                        target.clearStart,
                                        target.clearEnd,
                                        true
                                    )
                                );

                                const keyframe = param.createKeyframe(nativeValue);
                                keyframe.position = target.writeStart;
                                compoundAction.addAction(
                                    param.createAddKeyframeAction(keyframe)
                                );
                            } else {
                                // Switch keyframing off and write one static
                                // value — a parameter without keyframes is
                                // constant by definition.
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
                }, "Smooth Auto Frame — Werte fixieren");
            } catch (error) {
                passError = error;
            }
        });

        if (passError) {
            for (let i = 0; i < pending.length; i++) {
                pending[i].plan.failed = true;
                pending[i].plan.failure = describeError(passError);
            }
            break;
        }

        for (let i = 0; i < pending.length; i++) {
            const plan = pending[i].plan;
            plan.passes = pass + 1;
            if (!plan.writtenTargets) plan.writtenTargets = {};
            for (let t = 0; t < pending[i].targets.length; t++) {
                const target = pending[i].targets[t];
                plan.writtenTargets[target.paramIndex] = target;
                plan.allChanges.push({
                    pass: pass + 1,
                    param: target.paramName,
                    value: describeValue(target.value),
                    readFrom: target.readFrom,
                    readParam: target.readParamName,
                    keyframesBefore: target.keyframeCount
                });
            }
        }

        // Give the effect a moment to repopulate before the next pass.
        await delay(SETTLE_MS);
    }

    /*
     * ---- Phase 3: final verification across ALL position parameters ----
     *
     * The success criterion is that NO position-carrying parameter animates
     * any more. Checking only the one that was written is what previously
     * produced a success message while the movement had merely moved to a
     * sibling parameter.
     */
    for (let i = 0; i < active.length; i++) {
        const plan = active[i];

        let paramsAfter = null;
        const stillAnimating = [];

        try {
            const refreshed = await plan.trackItem.getComponentChain();
            if (refreshed) plan.chain = refreshed;
            const component = plan.chain.getComponentAtIndex(plan.componentIndex);
            if (component) {
                paramsAfter = await describeComponentParams(component);

                for (let c = 0; c < plan.positionIndexCount; c++) {
                    const index = plan.paramIndexes[c];
                    const param = component.getParam(index);
                    if (!param) continue;
                    const count = getKeyframeTimes(param).length;
                    let varying = null;
                    try {
                        varying = param.isTimeVarying();
                    } catch {
                        varying = null;
                    }
                    const written =
                        plan.writtenTargets && plan.writtenTargets[index];
                    let expected = 0;
                    if (!options.staticValue && written) expected = 1;

                    if (count !== expected) {
                        stillAnimating.push({
                            index: index,
                            param: param.displayName,
                            keyframes: count,
                            expected: expected,
                            timeVarying: varying
                        });
                    }
                }
            }
        } catch (error) {
            plan.failed = true;
            plan.failure = describeError(error);
        }

        if (plan.failed) {
            report.errors++;
            report.results.push({
                clipName: plan.clipName,
                status: "error",
                reason: plan.failure,
                changes: plan.allChanges,
                passes: plan.passes,
                params: plan.params,
                paramsAfter: paramsAfter
            });
            continue;
        }

        if (stillAnimating.length) {
            const names = stillAnimating.map(
                (entry) =>
                    '"' + entry.param + '" (Index ' + entry.index + ", " +
                    entry.keyframes + " Keyframes)"
            );
            report.errors++;
            report.results.push({
                clipName: plan.clipName,
                status: "error",
                reason:
                    "Die Bewegung ist NICHT entfernt. Nach " +
                    plan.passes +
                    " Durchläufen animieren weiterhin: " +
                    names.join(", ") +
                    ". Premiere füllt diese Parameter asynchron nachträglich " +
                    "wieder, schneller als sie eingefroren werden können.",
                changes: plan.allChanges,
                stillAnimating: stillAnimating,
                passes: plan.passes,
                params: plan.params,
                paramsAfter: paramsAfter
            });
            continue;
        }

        report.processed++;
        report.results.push({
            clipName: plan.clipName,
            status: "ok",
            reason:
                (options.staticValue
                    ? "Auf konstanten Wert fixiert (keine Keyframes)"
                    : "Auf einen einzelnen Keyframe reduziert") +
                " und nachgeprüft: kein Positions-Parameter animiert mehr" +
                (plan.passes > 1 ? " (" + plan.passes + " Durchläufe)" : "") +
                ".",
            changes: plan.allChanges,
            passes: plan.passes,
            overrideResolvedBy: plan.overrideResolvedBy,
            paramsAfter: paramsAfter
        });
    }

    if (report.processed > 0) {
        report.notes.push(
            "Ein Lauf besteht aus mehreren Undo-Schritten: pro Durchlauf einer, " +
                "plus einer für die Override-Checkbox."
        );
    }
    return report;
}

module.exports = {
    runSmoothAutoFrame: runSmoothAutoFrame,
    TIMING: TIMING,
    // Exported so the panel can display which build is actually loaded. UXP
    // caches required modules, so a Reload can leave stale code running — and
    // without a visible marker that is indistinguishable from a working build.
    PLUGIN_VERSION: PLUGIN_VERSION,
    DIAGNOSTICS_VERSION: DIAGNOSTICS_VERSION
};
