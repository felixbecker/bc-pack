/**
 * Split Screener — src/values.js
 *
 * Turning whatever Premiere hands back into plain JavaScript, and describing
 * it when that fails. Pure — no Premiere API, no I/O — so all of it is unit
 * testable.
 *
 * WHY THIS EXISTS
 * `ComponentParam.getValueAtTime()` is documented as returning a number, a
 * string, a boolean, a PointF or a Color. In practice the shape varies with
 * version and parameter type: the value can arrive wrapped in an object
 * (`{value: …}`, which is how the UXP reference types `Keyframe.value`, i.e.
 * the payload sits one level deeper), as a two-element array, or as numeric
 * strings. Code that insists on `typeof value.x === "number"` therefore
 * rejects values that are perfectly usable — and because this plugin fails
 * closed on unreadable parameters, that would not degrade gracefully, it would
 * refuse to work at all.
 *
 * The companion plugin in this repository hit exactly that and now covers six
 * different shapes; this module is the same treatment.
 *
 * The second half is about *reporting* host values. Premiere's host objects
 * keep their data behind non-enumerable prototype getters, so
 * `JSON.stringify(pointF)` yields "{}" and `String(pointF)` yields
 * "[object Object]" — neither tells anyone anything. `safeJson` and
 * `describeShape` walk the prototype chain instead, bounded and never
 * throwing, so a diagnostics log is actually usable.
 */

/** How many `{value: …}` wrappers to peel before giving up. */
const MAX_UNWRAP_DEPTH = 4;

/** Depth and width limits for serialization, so a cyclic host object cannot hang us. */
const MAX_JSON_DEPTH = 5;
const MAX_JSON_ENTRIES = 24;

/** How far up a prototype chain to look for readable property names. */
const MAX_PROTOTYPE_DEPTH = 6;

/**
 * Coerces to a finite number, accepting numeric strings.
 * @returns {number|null} null when that is not possible
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

/**
 * True for anything carrying exactly two usable numeric components.
 *
 * The length check is strict on purpose: a Color arriving as `[r, g, b, a]`
 * would otherwise pass as a point and its first two channels would be read as
 * coordinates. Since the structural parameter probe in core.js looks for
 * point-shaped values, that would let a colour parameter stand in for a
 * position — and because writing and verifying both go through the same
 * resolution, the mistake would confirm itself.
 */
function looksLikePoint(candidate) {
    if (candidate === null || typeof candidate !== "object") return false;
    if (Array.isArray(candidate)) {
        return (
            candidate.length === 2 &&
            toFiniteNumber(candidate[0]) !== null &&
            toFiniteNumber(candidate[1]) !== null
        );
    }
    let x;
    let y;
    try {
        x = candidate.x;
        y = candidate.y;
    } catch {
        return false;
    }
    return toFiniteNumber(x) !== null && toFiniteNumber(y) !== null;
}

/** Reads a point-like value into `{x, y}`. Assumes `looksLikePoint` passed. */
function readPoint(candidate) {
    if (Array.isArray(candidate)) {
        return { x: toFiniteNumber(candidate[0]), y: toFiniteNumber(candidate[1]) };
    }
    return { x: toFiniteNumber(candidate.x), y: toFiniteNumber(candidate.y) };
}

/**
 * Peels `{value: …}` wrappers until something inspectable appears. Stops at
 * points and arrays so a PointF is never unwrapped into one of its members.
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
 * Normalizes a host value into plain JavaScript: a number, a boolean or
 * `{x, y}`.
 *
 * @returns {number|boolean|{x: number, y: number}|null} null means "unusable",
 *          which every caller must treat as "do not write anything"
 */
function normalizeReadValue(raw) {
    const value = unwrapValue(raw);

    if (typeof value === "boolean") return value;

    if (value === null || typeof value !== "object") {
        return toFiniteNumber(value);
    }

    if (looksLikePoint(value)) return readPoint(value);

    return null;
}

/**
 * Collects the readable property names of a value, including inherited ones.
 *
 * `for…in` alone is not enough for Premiere's host objects: accessors declared
 * on a class prototype are non-enumerable, so a PointF-like object would look
 * like it had no properties at all.
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
    while (current && current !== Object.prototype && depth < MAX_PROTOTYPE_DEPTH) {
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
 * Serializes a value for diagnostics. Bounded in depth and width, reads
 * inherited getters, skips methods, and never throws.
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
        try {
            for (let i = 0; i < value.length && i < MAX_JSON_ENTRIES; i++) {
                items.push(safeJson(value[i], level + 1));
            }
            if (value.length > MAX_JSON_ENTRIES) items.push('"…"');
        } catch {
            items.push('"[nicht lesbar]"');
        }
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
 * Describes an unexpected value for an error message: constructor name, the
 * property names found, and a few probe fields. The point is that a reader of
 * the log can tell *what* arrived instead of seeing "[object Object]".
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

    if (Array.isArray(raw)) parts.push("array(" + raw.length + ")");

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

    const probes = ["value", "x", "y", "width", "height"];
    for (let i = 0; i < probes.length; i++) {
        const probe = probes[i];
        try {
            const probed = raw[probe];
            if (probed !== undefined && typeof probed !== "function") {
                parts.push(probe + ":" + typeof probed + "=" + String(probed));
            }
        } catch {
            /* ignore inaccessible property */
        }
    }

    return parts.length ? parts.join(" ") : "leeres Objekt";
}

/** The normalized point form produced by `normalizeReadValue`. */
function isNormalizedPoint(value) {
    return (
        value !== null &&
        typeof value === "object" &&
        typeof value.x === "number" &&
        typeof value.y === "number" &&
        isFinite(value.x) &&
        isFinite(value.y)
    );
}

/** Type tag used by the parameter resolver to state what it expected. */
function valueKind(value) {
    if (typeof value === "number") return "number";
    if (typeof value === "boolean") return "boolean";
    if (isNormalizedPoint(value)) return "point";
    return "unbrauchbar";
}

/**
 * Reads a checkbox-style parameter tolerantly.
 *
 * Premiere's typings list boolean as only one of five possible return types,
 * and the older ExtendScript API represented checkboxes as 0/1 numbers. A
 * strict boolean check would therefore risk rejecting every clip in a host
 * that reports them numerically — a total refusal to work, for a value we only
 * ever use as a yes/no.
 *
 * @returns {boolean|null} null when the value is no kind of flag at all
 */
function toFlag(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (value === 0) return false;
        if (value === 1) return true;
    }
    return null;
}

/** True for values `toFlag` can make sense of. */
function isFlag(value) {
    return toFlag(value) !== null;
}

module.exports = {
    toFiniteNumber,
    looksLikePoint,
    readPoint,
    unwrapValue,
    normalizeReadValue,
    collectReadableKeys,
    safeJson,
    describeShape,
    isNormalizedPoint,
    valueKind,
    toFlag,
    isFlag
};
