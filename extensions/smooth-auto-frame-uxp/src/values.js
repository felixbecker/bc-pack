/** Plain values at the UXP boundary. No coordinate conversion. */
function number(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function normalize(raw) {
    let value = raw;
    for (let depth = 0; depth < 5; depth++) {
        if (typeof value === "boolean") return value;
        if (value === null || typeof value !== "object") return number(value);
        const x = number(Array.isArray(value) ? value[0] : value.x);
        const y = number(Array.isArray(value) ? value[1] : value.y);
        if ((!Array.isArray(value) || value.length === 2) && x !== null && y !== null) return { x: x, y: y };
        const next = value.value;
        if (next === undefined || next === value) return null;
        value = next;
    }
    return null;
}

function isPoint(value) {
    return !!value && Number.isFinite(value.x) && Number.isFinite(value.y);
}

function close(a, b, epsilon) {
    return isPoint(a) && isPoint(b) && Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
}

function describe(raw) {
    // Include prototype getters on UXP host objects; JSON.stringify alone can
    // reduce an unexpected host value to {}. Never serialize host handles.
    try {
        if (!raw || typeof raw !== "object") return String(raw);
        const details = {};
        const proto = Object.getPrototypeOf(raw);
        const keys = Array.from(new Set(Object.keys(raw).concat(proto ? Object.getOwnPropertyNames(proto) : [])));
        for (const key of keys.slice(0, 20)) {
            if (key === "constructor") continue;
            try {
                const value = raw[key];
                if (typeof value !== "function") details[key] = typeof value === "object" ? "[Objekt]" : value;
            } catch {
                details[key] = "[nicht lesbar]";
            }
        }
        return JSON.stringify(details);
    } catch {
        return "[nicht darstellbarer Host-Wert]";
    }
}

module.exports = { normalize, isPoint, close, describe };
