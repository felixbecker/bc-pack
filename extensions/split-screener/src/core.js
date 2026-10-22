/**
 * Split Screener — src/core.js
 *
 * Everything that talks to Premiere. UXP, Premiere Pro 25.6+.
 *
 * WHAT IT DOES
 * Takes pairs of exactly congruent clips on different video tracks and turns
 * each pair into a 50/50 split screen by appending two standard effects per
 * clip — a Transform that moves the image into its half and a Crop that cuts
 * that half out. Both land behind every user effect, which is why Auto Reframe,
 * Lumetri or a hand-applied Crop need no special handling: they are simply
 * part of "the current look" that we halve.
 *
 * ARCHITECTURE (enforced by @adobe/eslint-plugin-premierepro)
 * Premiere splits into async reads and synchronous action writes:
 *   - `create*Action()` only inside `lockedAccess()` / `executeTransaction()`
 *   - `addAction()` only inside `executeTransaction()`
 *   - no `await` inside those callbacks
 *   - action objects must not escape their lock scope
 * So every operation runs in strict phases: read and plan asynchronously,
 * then write synchronously inside a transaction.
 *
 * WHY TWO TRANSACTIONS ON FIRST APPLICATION
 * `VideoFilterFactory.createComponent()` is asynchronous, so a new component
 * has to be created before the transaction. Whether parameter values can be
 * set on such a component in the *same* transaction that inserts it is not
 * documented. Rather than rely on it, insertion and value assignment are two
 * transactions: the first inserts, then the chain is re-read, then the second
 * writes the values onto the components that are now genuinely in the chain.
 * Re-running on an existing split screen needs only the second one. If the
 * second transaction fails, a third removes what the first inserted so the
 * project is never left half-converted.
 *
 * WHY EVERY WRITE IS VERIFIED
 * Several API details (parameter value units, parameter display names in a
 * localized install) cannot be confirmed from Adobe's documentation. After
 * writing, the values are read back and compared against what was intended;
 * any deviation is reported instead of silently accepted. The Diagnose button
 * in the panel exists for the same reason.
 */

const ppro = require("premierepro");

const C = require("./constants.js");
const V = require("./values.js");
const geometry = require("./geometry.js");
const chainUtil = require("./chain.js");
const pairing = require("./pairing.js");

const TICKS_PER_SECOND = 254016000000;

const PLUGIN_VERSION = "1.2.0";

/** Tolerances used when verifying what was written. */
const VERIFY_EPSILON_PIXELS = 0.75;
const VERIFY_EPSILON_PERCENT = 0.05;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Collects host information for exported logs. Wrapped defensively: the exact
 * shape of the UXP host object is not guaranteed across versions, and a
 * missing field must never break a run. `uiLocale` is the single most useful
 * field here, because every parameter lookup goes through localized display
 * names.
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
        if (uxp && uxp.versions && uxp.versions.uxp) {
            info.uxp = String(uxp.versions.uxp);
        }
    } catch {
        info.note = "Host-Infos nicht verfügbar";
    }
    return info;
}

function describeError(error) {
    if (!error) return "Unbekannter Fehler.";
    if (error instanceof Error) return error.message || String(error);
    return String(error);
}

function emptyReport(mode, dryRun, options) {
    return {
        mode: mode,
        dryRun: !!dryRun,
        processed: 0,
        skipped: 0,
        errors: 0,
        results: [],
        notes: [],
        validationErrors: [],
        fatalError: null,
        /*
         * Context for exported logs. The options are echoed back from what was
         * actually applied, not from what the panel thinks it sent, so a
         * mis-read control is visible in the log instead of silent.
         */
        meta: {
            timestamp: new Date().toISOString(),
            pluginVersion: PLUGIN_VERSION,
            mode: mode,
            options: options || null,
            host: describeHost()
        }
    };
}

function fatal(mode, message, options) {
    const report = emptyReport(mode, !!(options && options.dryRun), options || null);
    report.fatalError = message;
    return report;
}

/**
 * Exact, order-preserving key for a TickTime.
 * @returns {string|null} null when no usable representation is available
 */
function tickKey(tickTime) {
    if (!tickTime) return null;
    if (typeof tickTime.ticks === "string" && tickTime.ticks) return tickTime.ticks;
    if (typeof tickTime.ticksNumber === "number" && isFinite(tickTime.ticksNumber)) {
        return String(tickTime.ticksNumber);
    }
    if (typeof tickTime.seconds === "number" && isFinite(tickTime.seconds)) {
        return "s" + tickTime.seconds;
    }
    return null;
}

function tickSeconds(tickTime) {
    if (!tickTime) return 0;
    if (typeof tickTime.seconds === "number" && isFinite(tickTime.seconds)) {
        return tickTime.seconds;
    }
    if (typeof tickTime.ticksNumber === "number" && isFinite(tickTime.ticksNumber)) {
        return tickTime.ticksNumber / TICKS_PER_SECOND;
    }
    return 0;
}

function formatPosition(tickTime) {
    const total = tickSeconds(tickTime);
    const sign = total < 0 ? "-" : "";
    const absolute = Math.abs(total);
    // Round first, then split, so 59.999 becomes 1:00.00 and not 0:60.00.
    const hundredths = Math.round(absolute * 100);
    const minutes = Math.floor(hundredths / 6000);
    const seconds = (hundredths - minutes * 6000) / 100;
    const secondsText = seconds < 10 ? "0" + seconds.toFixed(2) : seconds.toFixed(2);
    return sign + minutes + ":" + secondsText;
}

function formatPercent(value) {
    return geometry.round4(value) + " %";
}

function formatPoint(point) {
    return "x=" + geometry.round4(point.x) + ", y=" + geometry.round4(point.y);
}

// ---------------------------------------------------------------------------
// Phase 1 — reading (async)
// ---------------------------------------------------------------------------

/**
 * Resolves the match names of the two effects we insert against what the host
 * actually offers, so a renamed or localized effect cannot silently break us.
 */
async function resolveEffectMatchNames() {
    let available = [];
    try {
        available = await ppro.VideoFilterFactory.getMatchNames();
    } catch {
        available = [];
    }

    const transform = chainUtil.resolveMatchName(
        available,
        C.TRANSFORM_MATCHNAMES,
        C.TRANSFORM_MATCHNAME_FRAGMENTS
    );
    const crop = chainUtil.resolveMatchName(
        available,
        C.CROP_MATCHNAMES,
        C.CROP_MATCHNAME_FRAGMENTS
    );

    return { transform: transform, crop: crop, available: available };
}

/** Reads a chain into plain descriptors so chain.js can reason about it. */
async function readChainInfos(componentChain) {
    const infos = [];
    if (!componentChain) return infos;

    const count = componentChain.getComponentCount();
    for (let i = 0; i < count; i++) {
        const component = componentChain.getComponentAtIndex(i);
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

        infos.push({ index: i, matchName: matchName, displayName: displayName });
    }
    return infos;
}

/**
 * Finds a parameter index by localized display name.
 *
 * Candidates are tried in PRIORITY ORDER — the outer loop runs over the names,
 * not over the parameters. Scanning parameters first and accepting whichever
 * matches any candidate would return whatever happens to come earlier in the
 * effect, which is the wrong answer as soon as two parameters have related
 * names ("Skalierung" and "Skalierungsbreite").
 *
 * Exact matches outrank substring fragments. `claimed` holds indices another
 * lookup already took, so a loose fragment cannot steal a parameter that has
 * been identified precisely.
 *
 * @returns {number} -1 when nothing matches
 */
function findParamIndex(component, names, fragments, claimed) {
    const count = component.getParamCount();
    const skip = claimed || [];

    for (let c = 0; c < names.length; c++) {
        const wanted = chainUtil.normalizeName(names[c]);
        if (!wanted) continue;
        for (let i = 0; i < count; i++) {
            if (skip.indexOf(i) !== -1) continue;
            const param = component.getParam(i);
            if (param && chainUtil.normalizeName(param.displayName) === wanted) return i;
        }
    }

    if (fragments && fragments.length) {
        for (let f = 0; f < fragments.length; f++) {
            const fragment = chainUtil.normalizeName(fragments[f]);
            if (!fragment) continue;
            for (let i = 0; i < count; i++) {
                if (skip.indexOf(i) !== -1) continue;
                const param = component.getParam(i);
                if (!param) continue;
                if (chainUtil.normalizeName(param.displayName).indexOf(fragment) !== -1) {
                    return i;
                }
            }
        }
    }

    return -1;
}

/** A TickTime of zero, for probing a parameter outside any clip context. */
function zeroTime() {
    try {
        return ppro.TickTime.createWithSeconds(0);
    } catch {
        return null;
    }
}

/**
 * Reads a parameter value and normalizes it to plain JavaScript.
 *
 * Three read paths are tried in turn because none of them is reliable on its
 * own: `getStartValue()` is documented to return a Keyframe (so the payload
 * sits one level deeper), `getValueAtTime()` needs a time that is valid for
 * this parameter, and some parameters answer only at zero. Everything goes
 * through values.js, which also copes with wrapped, array-shaped and
 * string-numeric returns.
 *
 * @returns {{ok: boolean, value: *, raw: *}} `ok: false` means "unusable —
 *          do not write anything"
 */
async function readParamValue(param, time) {
    const times = [];
    if (time) times.push(time);
    const zero = zeroTime();
    if (zero) times.push(zero);

    let lastRaw;
    let lastError = null;

    try {
        const raw = await param.getStartValue();
        lastRaw = raw;
        const value = V.normalizeReadValue(raw);
        if (value !== null) return { ok: true, value: value, raw: raw, error: null };
    } catch (error) {
        lastError = describeError(error);
    }

    for (let i = 0; i < times.length; i++) {
        try {
            const raw = await param.getValueAtTime(times[i]);
            lastRaw = raw;
            const value = V.normalizeReadValue(raw);
            if (value !== null) return { ok: true, value: value, raw: raw, error: null };
        } catch (error) {
            lastError = describeError(error);
        }
    }

    return { ok: false, value: null, raw: lastRaw, error: lastError };
}

/**
 * Reads whether a parameter is keyframed.
 * @returns {boolean|null} null when the question could not be answered
 */
function isTimeVaryingSafe(param) {
    try {
        return !!param.isTimeVarying();
    } catch {
        return null;
    }
}

/**
 * Dumps every parameter of a component: index, display name, keyframe state,
 * current value and value kind.
 *
 * Attached to every parameter-resolution failure. `ComponentParam` exposes no
 * matchName — only the localized `displayName`, and in some effects that name
 * is even blank — so a failed lookup cannot be diagnosed from the message
 * alone. The dump is what makes the name lists correctable from real data
 * instead of guesses. Read-only.
 */
async function describeComponentParams(component, time) {
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
            entry.timeVarying = isTimeVaryingSafe(param);

            const read = await readParamValue(param, time);
            if (read.ok) {
                entry.value = read.value;
                entry.valueType = V.valueKind(read.value);
            } else {
                entry.value = V.safeJson(read.raw);
                entry.valueType = "unbrauchbar";
            }
        } catch (error) {
            entry.note = describeError(error);
        }
        dump.push(entry);
    }

    return dump;
}

/**
 * Last-resort identification of a point-valued parameter when its name is not
 * recognised in this locale.
 *
 * First pass looks for a point sitting on the frame centre, which is what a
 * freshly inserted Transform's Position reads as. Second pass takes the first
 * unclaimed point-valued parameter, which is what keeps a *re-run* working
 * after we have moved that position off-centre ourselves.
 */
function makePointParamFallback(time, width, height) {
    return async function (component, claimed) {
        const skip = claimed || [];
        let count = 0;
        try {
            count = component.getParamCount();
        } catch {
            return -1;
        }

        const candidates = [];
        for (let i = 0; i < count; i++) {
            if (skip.indexOf(i) !== -1) continue;
            const param = component.getParam(i);
            if (!param) continue;
            const read = await readParamValue(param, time);
            if (!read.ok || !V.isNormalizedPoint(read.value)) continue;

            const pixels = geometry.toPixelPosition(read.value, width, height);
            const onCentre =
                Math.abs(pixels.x - width / 2) <= 1 && Math.abs(pixels.y - height / 2) <= 1;
            if (onCentre) return i;
            candidates.push(i);
        }

        return candidates.length ? candidates[0] : -1;
    };
}

/**
 * Last-resort identification of a checkbox whose display name is unusable.
 *
 * Confirmed necessary in Premiere 26.3.2: the Motion effect's
 * "Gleichmäßig skalieren" has a display name of a single space, so no name
 * list can ever find it. The probe therefore looks for the *only* parameter
 * that reads as a genuine boolean — unique in that effect, where every other
 * parameter is a number or a point.
 *
 * Requires a real boolean rather than values.toFlag, which would also accept
 * the numeric 0 of "Anti-Flimmer-Filter" and make the result ambiguous. If
 * more than one candidate exists the probe gives up, so an ambiguous effect
 * fails closed instead of guessing.
 */
function makeSingleBooleanParamFallback(time) {
    return async function (component, claimed) {
        const skip = claimed || [];
        let count = 0;
        try {
            count = component.getParamCount();
        } catch {
            return -1;
        }

        let found = -1;
        for (let i = 0; i < count; i++) {
            if (skip.indexOf(i) !== -1) continue;
            const param = component.getParam(i);
            if (!param) continue;
            const read = await readParamValue(param, time);
            if (!read.ok || typeof read.value !== "boolean") continue;
            if (found >= 0) return -1; // ambiguous
            found = i;
        }
        return found;
    };
}

function paramLookupError(label, reason, dump) {
    return new Error(
        'Parameter "' +
            label +
            '": ' +
            reason +
            " Die UXP-API bietet für Parameter nur den lokalisierten Anzeigenamen, " +
            "daher kann die Suche in einer unbekannten Sprachversion fehlschlagen. " +
            "Vorhandene Parameter: " +
            V.safeJson(dump)
    );
}

/**
 * Resolves a REQUIRED parameter, or throws with full diagnostics.
 *
 * A lookup that quietly returns "not found" and lets the caller carry on is
 * the most dangerous pattern available here: it is how a plugin ends up
 * reporting success without having changed anything. So every lookup either
 * succeeds or aborts loudly — and "found" is not enough, the parameter also
 * has to yield a value of the expected kind, which keeps a numeric parameter
 * from being mistaken for a checkbox.
 *
 * @param {Object} spec
 * @param {Object} spec.component
 * @param {string} spec.label        human-readable purpose, used in messages
 * @param {string[]} spec.names      exact candidates, in priority order
 * @param {string[]} [spec.fragments] substring fallbacks, in priority order
 * @param {string} spec.expect       "point", "number" or "boolean"
 * @param {*} spec.time              reference time for reading
 * @param {Object[]} spec.dump       parameter dump for error messages
 * @param {number[]} [spec.claimed]  indices already taken by other lookups
 * @param {number} [spec.indexFallback] positional fallback, see CROP_PARAMS
 * @param {Function} [spec.structuralFallback] async (component, claimed) => index
 */
async function resolveRequiredParam(spec) {
    const claimed = spec.claimed || [];
    let index = findParamIndex(spec.component, spec.names, spec.fragments, claimed);
    let strategy = "name";

    if (index < 0 && typeof spec.indexFallback === "number") {
        let count = 0;
        try {
            count = spec.component.getParamCount();
        } catch {
            count = 0;
        }
        // The positional fallback must respect the claims as well, otherwise
        // two keys can end up addressing the same parameter — one value would
        // be written twice and another never, and with symmetric targets the
        // verification would not even notice.
        if (
            count >= C.CROP_MIN_PARAM_COUNT &&
            spec.indexFallback < count &&
            claimed.indexOf(spec.indexFallback) === -1
        ) {
            index = spec.indexFallback;
            strategy = "index";
        }
    }

    if (index < 0 && spec.structuralFallback) {
        index = await spec.structuralFallback(spec.component, claimed);
        if (index >= 0) strategy = "struktur";
    }

    if (index < 0) {
        throw paramLookupError(spec.label, "nicht gefunden.", spec.dump);
    }

    const param = spec.component.getParam(index);
    if (!param) {
        throw paramLookupError(
            spec.label,
            "Index " + index + " ist nicht lesbar.",
            spec.dump
        );
    }

    const read = await readParamValue(param, spec.time);
    if (!read.ok) {
        throw paramLookupError(
            spec.label,
            'liefert keinen verwertbaren Wert (gefunden als "' +
                param.displayName +
                '", erhalten: ' +
                V.describeShape(read.raw) +
                (read.error ? ", Fehler: " + read.error : "") +
                ").",
            spec.dump
        );
    }

    // "flag" is deliberately laxer than "boolean": see values.toFlag.
    let value = read.value;
    if (spec.expect === "flag") {
        const flag = V.toFlag(value);
        if (flag === null) {
            throw paramLookupError(
                spec.label,
                'wurde als "' +
                    param.displayName +
                    '" erkannt, liefert aber keinen Schalterwert, sondern ' +
                    V.describeShape(read.raw) +
                    " — vermutlich der falsche Parameter.",
                spec.dump
            );
        }
        value = flag;
    } else if (spec.expect) {
        const kind = V.valueKind(value);
        if (kind !== spec.expect) {
            throw paramLookupError(
                spec.label,
                'wurde als "' +
                    param.displayName +
                    '" erkannt, liefert aber ' +
                    kind +
                    " statt " +
                    spec.expect +
                    " — vermutlich der falsche Parameter.",
                spec.dump
            );
        }
    }

    return {
        index: index,
        param: param,
        name: param.displayName,
        value: value,
        raw: read.raw,
        strategy: strategy
    };
}

/**
 * Reads the intrinsic Motion state we need in order to compensate for it.
 *
 * Fails closed throughout. Every parameter this plugin reasons about has to be
 * found and readable; if one is not, the clip is rejected with a message
 * naming it, rather than silently defaulting. Defaulting would be actively
 * dangerous here: an unrecognised "Rotation" parameter would read as 0° and
 * wave a rotated clip through the very check that exists to stop it.
 *
 * Resolution order is deliberate: the most specifically named parameters go
 * first and claim their index, so a loose fragment match cannot later steal
 * them — "Skalierungsbreite" must not end up answering for "Skalierung".
 *
 * @returns {{motion: Object|null, problem: string|null, params: Object[]}}
 */
async function readMotionState(motionComponent, time, width, height) {
    const dump = await describeComponentParams(motionComponent, time);
    const claimed = [];

    try {
        const anchor = await resolveRequiredParam({
            component: motionComponent,
            label: "Bewegung · Ankerpunkt",
            names: C.MOTION_ANCHOR_NAMES,
            fragments: C.MOTION_ANCHOR_FRAGMENTS,
            expect: "point",
            time: time,
            dump: dump,
            claimed: claimed
        });
        claimed.push(anchor.index);

        // Claimed before "Skalierung" is resolved, never mind whether uniform
        // scaling is on, precisely so the scale fragment cannot grab it.
        const scaleWidthIndex = findParamIndex(
            motionComponent,
            C.MOTION_SCALE_WIDTH_NAMES,
            C.MOTION_SCALE_WIDTH_FRAGMENTS,
            claimed
        );
        if (scaleWidthIndex >= 0) claimed.push(scaleWidthIndex);

        const position = await resolveRequiredParam({
            component: motionComponent,
            label: "Bewegung · Position",
            names: C.MOTION_POSITION_NAMES,
            fragments: C.MOTION_POSITION_FRAGMENTS,
            expect: "point",
            time: time,
            dump: dump,
            claimed: claimed
        });
        claimed.push(position.index);

        const scale = await resolveRequiredParam({
            component: motionComponent,
            label: "Bewegung · Skalierung",
            names: C.MOTION_SCALE_NAMES,
            fragments: C.MOTION_SCALE_FRAGMENTS,
            expect: "number",
            time: time,
            dump: dump,
            claimed: claimed
        });
        claimed.push(scale.index);

        const rotation = await resolveRequiredParam({
            component: motionComponent,
            label: "Bewegung · Drehung",
            names: C.MOTION_ROTATION_NAMES,
            fragments: C.MOTION_ROTATION_FRAGMENTS,
            expect: "number",
            time: time,
            dump: dump,
            claimed: claimed
        });
        claimed.push(rotation.index);

        const uniform = await resolveRequiredParam({
            component: motionComponent,
            label: "Bewegung · Gleichmäßig skalieren",
            names: C.MOTION_UNIFORM_SCALE_NAMES,
            fragments: C.MOTION_UNIFORM_SCALE_FRAGMENTS,
            expect: "flag",
            time: time,
            dump: dump,
            claimed: claimed,
            // Nameless in Premiere 26.3.2 — see makeSingleBooleanParamFallback.
            structuralFallback: makeSingleBooleanParamFallback(time)
        });
        claimed.push(uniform.index);

        let scaleX = geometry.toScaleFactor(scale.value);
        const scaleY = geometry.toScaleFactor(scale.value);
        let scaleWidthParam = null;

        if (!uniform.value) {
            // Switched off means the axes are scaled separately, so the width
            // parameter is now genuinely required. Its index was claimed up
            // front, so it is addressed directly rather than searched again.
            if (scaleWidthIndex < 0) {
                throw paramLookupError(
                    "Bewegung · Skalierungsbreite",
                    '"Gleichmäßig skalieren" ist aus, die Breite wurde aber nicht gefunden.',
                    dump
                );
            }
            scaleWidthParam = motionComponent.getParam(scaleWidthIndex);
            if (!scaleWidthParam) {
                throw paramLookupError(
                    "Bewegung · Skalierungsbreite",
                    "Index " + scaleWidthIndex + " ist nicht lesbar.",
                    dump
                );
            }
            const scaleWidthRead = await readParamValue(scaleWidthParam, time);
            if (!scaleWidthRead.ok || V.valueKind(scaleWidthRead.value) !== "number") {
                throw paramLookupError(
                    "Bewegung · Skalierungsbreite",
                    "liefert keine Zahl, sondern " +
                        V.describeShape(scaleWidthRead.raw) +
                        ".",
                    dump
                );
            }
            scaleX = geometry.toScaleFactor(scaleWidthRead.value);
        }

        const anchorPixels = geometry.toPixelPosition(anchor.value, width, height);
        const anchorOffset = Math.max(
            Math.abs(anchorPixels.x - width / 2),
            Math.abs(anchorPixels.y - height / 2)
        );

        const positionVarying = isTimeVaryingSafe(position.param);
        const scaleVarying = isTimeVaryingSafe(scale.param);
        const scaleWidthVarying =
            scaleWidthParam === null ? false : isTimeVaryingSafe(scaleWidthParam);
        // Rotation, anchor and the uniform-scale switch are checked for
        // keyframes too, not just for their value: a clip sitting at 0° on the
        // frame we sample but animating away from it would otherwise pass the
        // rotation check.
        const rotationVarying = isTimeVaryingSafe(rotation.param);
        const anchorVarying = isTimeVaryingSafe(anchor.param);
        const uniformVarying = isTimeVaryingSafe(uniform.param);

        if (
            positionVarying === null ||
            scaleVarying === null ||
            scaleWidthVarying === null ||
            rotationVarying === null ||
            anchorVarying === null ||
            uniformVarying === null
        ) {
            throw new Error(
                "Keyframe-Zustand der Bewegungs-Parameter nicht lesbar. Vorhandene Parameter: " +
                    V.safeJson(dump)
            );
        }

        return {
            problem: null,
            params: dump,
            motion: {
                positionPixels: geometry.toPixelPosition(position.value, width, height),
                scaleX: scaleX,
                scaleY: scaleY,
                scaleConvention: geometry.detectScaleConvention(scale.value),
                rotation: geometry.round4(rotation.value),
                rotated: Math.abs(rotation.value) > C.ROTATION_EPSILON || rotationVarying,
                anchorMoved: anchorOffset > C.ANCHOR_EPSILON_PIXELS || anchorVarying,
                keyframed:
                    positionVarying || scaleVarying || scaleWidthVarying || uniformVarying,
                // How each parameter was identified, so a lookup that only
                // worked via the positional or structural fallback is visible
                // in the report instead of silently fine.
                strategies: {
                    "Bewegung·Position": position.strategy,
                    "Bewegung·Skalierung": scale.strategy,
                    "Bewegung·Drehung": rotation.strategy,
                    "Bewegung·Ankerpunkt": anchor.strategy,
                    "Bewegung·GleichmäßigSkalieren": uniform.strategy
                }
            }
        };
    } catch (error) {
        return { motion: null, problem: describeError(error), params: dump };
    }
}

/**
 * Reads everything about one selected track item.
 *
 * @returns {Object} record holding both the Premiere handles and the plain
 *          descriptor that pairing.js consumes
 */
async function readClipRecord(trackItem, id, width, height, resolved) {
    let name = "(unbenannter Clip)";
    try {
        name = (await trackItem.getName()) || name;
    } catch {
        /* keep fallback */
    }

    const record = {
        id: id,
        trackItem: trackItem,
        chain: null,
        infos: [],
        ownPair: null,
        insertionIndex: 0,
        motionIndex: -1,
        time: null,
        descriptor: {
            id: id,
            name: name,
            trackIndex: -1,
            startKey: "?" + id,
            endKey: "?" + id,
            startLabel: "unbekannte Position",
            timesReadable: false,
            isVideo: false,
            chainProblem: null,
            motionProblem: null,
            motionDisabled: false,
            motion: null
        }
    };

    if (typeof trackItem.getComponentChain !== "function") {
        return record;
    }

    let componentChain = null;
    let chainError = null;
    try {
        componentChain = await trackItem.getComponentChain();
    } catch (error) {
        chainError = describeError(error);
    }
    if (!componentChain) {
        // Not the same thing as "not a video clip": we could not look, so we
        // must not quietly drop the clip. Reported as unreadable and handled
        // as a hard precondition failure by pairing.js.
        record.descriptor.chainProblem =
            chainError || "Effektkette ist leer oder nicht verfügbar.";
        return record;
    }

    record.chain = componentChain;
    record.infos = await readChainInfos(componentChain);
    record.motionIndex = chainUtil.findMotionIndex(record.infos);

    // Video is identified by the presence of a video-only intrinsic. An audio
    // chain carries Volume and Panner and therefore never matches.
    record.descriptor.isVideo = chainUtil.looksLikeVideoChain(record.infos);
    if (!record.descriptor.isVideo) return record;

    record.insertionIndex = chainUtil.computeInsertionIndex(record.infos);
    if (resolved.transform && resolved.crop) {
        record.ownPair = chainUtil.findOwnPair(
            record.infos,
            resolved.transform,
            resolved.crop
        );
        record.strays = chainUtil.findStrayOwnEffects(
            record.infos,
            resolved.transform,
            resolved.crop,
            record.ownPair
        );
    }

    try {
        record.descriptor.trackIndex = await trackItem.getTrackIndex();
    } catch {
        record.descriptor.trackIndex = -1;
    }

    try {
        const start = await trackItem.getStartTime();
        const end = await trackItem.getEndTime();
        const startKey = tickKey(start);
        const endKey = tickKey(end);
        if (startKey !== null && endKey !== null) {
            record.descriptor.startKey = startKey;
            record.descriptor.endKey = endKey;
            record.descriptor.startLabel = formatPosition(start);
            record.descriptor.timesReadable = true;
        }
    } catch {
        // timesReadable stays false; pairing rejects the clip explicitly
        // instead of letting it group with other unreadable clips.
    }

    try {
        record.time = await trackItem.getInPoint();
    } catch {
        record.time = null;
    }

    if (record.motionIndex < 0) {
        record.descriptor.motionProblem = "Bewegungs-Effekt nicht in der Effektkette";
        return record;
    }
    if (!record.time) {
        record.descriptor.motionProblem = "Clip-Zeitbasis nicht lesbar";
        return record;
    }

    const motionComponent = componentChain.getComponentAtIndex(record.motionIndex);
    if (!motionComponent) {
        record.descriptor.motionProblem = "Bewegungs-Effekt nicht zugreifbar";
        return record;
    }

    /*
     * Premiere switches the intrinsic Motion effect off while Auto Reframe is
     * applied — Effect Controls states it outright: "Bewegung (Deaktiviert,
     * wenn Auto Reframe angewendet ist)". Its values are then inert, so they
     * must neither be compensated for nor used to reject the clip: a leftover
     * rotation or keyframe in a disabled effect changes nothing on screen.
     *
     * The parameters are still dumped for the diagnostics log.
     */
    if (chainUtil.hasAutoReframe(record.infos)) {
        record.descriptor.motionDisabled = true;
        record.descriptor.motion = {
            positionPixels: { x: width / 2, y: height / 2 },
            scaleX: 1,
            scaleY: 1,
            scaleConvention: geometry.SCALE_CONVENTION.PERCENT,
            rotation: 0,
            rotated: false,
            anchorMoved: false,
            keyframed: false,
            disabled: true,
            strategies: {}
        };
        record.descriptor.motionProblem = null;
        return record;
    }

    const motionResult = await readMotionState(motionComponent, record.time, width, height);
    record.descriptor.motion = motionResult.motion;
    record.descriptor.motionProblem = motionResult.problem;

    return record;
}

/**
 * Reads the current values of one Transform + Crop pair.
 *
 * `positionUnit` is detected from the Transform's own position value. On a
 * freshly inserted component that value is the untouched default (the frame
 * centre), which makes the detection reliable exactly when it matters. On a
 * re-run it is whatever the previous run wrote, so a re-run inherits the first
 * run's interpretation — see the assumptions table in the README.
 *
 * @returns {{ok: boolean, reason?: string, ...}} never a bare null, so the
 *          caller can say *which* parameter was the problem
 */
async function readPairValues(componentChain, ownPair, time, width, height) {
    if (!componentChain || !ownPair) {
        return { ok: false, reason: "Effektkette nicht verfügbar." };
    }
    if (!time) {
        return { ok: false, reason: "Zeitbasis des Clips nicht lesbar." };
    }

    const transform = componentChain.getComponentAtIndex(ownPair.transformIndex);
    const crop = componentChain.getComponentAtIndex(ownPair.cropIndex);
    if (!transform || !crop) {
        return {
            ok: false,
            reason: "Transformieren oder Zuschneiden ist in der Effektkette nicht lesbar."
        };
    }

    const transformDump = await describeComponentParams(transform, time);
    const cropDump = await describeComponentParams(crop, time);

    try {
        // Claim the anchor point first: it is also a point sitting on the
        // frame centre, so both the "position" fragment and the structural
        // fallback could otherwise pick it instead of Position.
        const transformClaimed = [];
        const anchorIndex = findParamIndex(
            transform,
            C.TRANSFORM_ANCHOR_NAMES,
            C.TRANSFORM_ANCHOR_FRAGMENTS,
            transformClaimed
        );
        if (anchorIndex >= 0) transformClaimed.push(anchorIndex);

        const position = await resolveRequiredParam({
            component: transform,
            label: "Transformieren · Position",
            names: C.TRANSFORM_POSITION_NAMES,
            fragments: C.TRANSFORM_POSITION_FRAGMENTS,
            expect: "point",
            time: time,
            dump: transformDump,
            claimed: transformClaimed,
            structuralFallback: makePointParamFallback(time, width, height)
        });

        const cropClaimed = [];
        const cropIndices = {};
        const cropValues = {};
        const strategies = { position: position.strategy };
        // Our own parameters must be static: createSetValueAction is specified
        // for non-time-varying parameters, so a keyframed one would swallow the
        // write. Collected here and switched off before writing.
        const keyframed = [];
        if (isTimeVaryingSafe(position.param)) keyframed.push("position");

        for (let i = 0; i < C.CROP_PARAMS.length; i++) {
            const spec = C.CROP_PARAMS[i];
            const resolvedParam = await resolveRequiredParam({
                component: crop,
                label: "Zuschneiden · " + spec.label,
                names: spec.names,
                fragments: spec.fragments,
                expect: "number",
                time: time,
                dump: cropDump,
                claimed: cropClaimed,
                indexFallback: spec.fallbackIndex
            });
            cropClaimed.push(resolvedParam.index);
            cropIndices[spec.key] = resolvedParam.index;
            cropValues[spec.key] = resolvedParam.value;
            strategies[spec.key] = resolvedParam.strategy;
            if (isTimeVaryingSafe(resolvedParam.param)) keyframed.push(spec.key);
        }

        // Crop's "Zoom" would rescale the cropped result back to full frame.
        // Nameless in Premiere 26.3.2 — the display name is an empty string —
        // so it is resolved the same way as Motion's uniform-scale checkbox:
        // the only parameter in the effect that reads as a genuine boolean.
        // Optional: a build that does not expose it is fine, because a freshly
        // created Crop has it switched off anyway.
        let zoomIndex = findParamIndex(crop, C.CROP_ZOOM_NAMES, null, cropClaimed);
        if (zoomIndex < 0) {
            const probe = makeSingleBooleanParamFallback(time);
            zoomIndex = await probe(crop, cropClaimed);
            if (zoomIndex >= 0) strategies.zoom = "struktur";
        } else {
            strategies.zoom = "name";
        }

        return {
            ok: true,
            positionIndex: position.index,
            positionRaw: position.raw,
            positionUnit: geometry.detectPositionUnit(position.value, width, height),
            positionPixels: geometry.toPixelPosition(position.value, width, height),
            cropIndices: cropIndices,
            cropValues: cropValues,
            zoomIndex: zoomIndex,
            keyframed: keyframed,
            strategies: strategies,
            transformParams: transformDump,
            cropParams: cropDump
        };
    } catch (error) {
        return {
            ok: false,
            reason: describeError(error),
            transformParams: transformDump,
            cropParams: cropDump
        };
    }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

async function collectContext(mode, options) {
    const project = await ppro.Project.getActiveProject();
    if (!project) {
        return { error: fatal(mode, "Kein aktives Projekt gefunden.", options) };
    }

    const sequence = await project.getActiveSequence();
    if (!sequence) {
        return {
            error: fatal(
                mode,
                "Keine aktive Sequenz. Öffne eine Sequenz und versuche es erneut.",
                options
            )
        };
    }

    let width = 0;
    let height = 0;
    try {
        const frameSize = await sequence.getFrameSize();
        width = frameSize ? frameSize.width : 0;
        height = frameSize ? frameSize.height : 0;
    } catch {
        width = 0;
        height = 0;
    }
    if (!(width > 0) || !(height > 0)) {
        return {
            error: fatal(mode, "Sequenzgröße konnte nicht gelesen werden.", options)
        };
    }

    const selection = await sequence.getSelection();
    const trackItems = selection ? await selection.getTrackItems() : [];
    if (!trackItems || !trackItems.length) {
        return {
            error: fatal(
                mode,
                "Keine Clips ausgewählt. Wähle die Clips in der Timeline aus.",
                options
            )
        };
    }

    const resolved = await resolveEffectMatchNames();
    if (!resolved.transform || !resolved.crop) {
        const missing = [];
        if (!resolved.transform) missing.push("Transformieren");
        if (!resolved.crop) missing.push("Zuschneiden");
        return {
            error: fatal(
                mode,
                "Benötigte Effekte nicht gefunden: " +
                    missing.join(", ") +
                    ". Bitte den Diagnose-Button ausführen und die Ausgabe prüfen.",
                options
            )
        };
    }

    return {
        project: project,
        sequence: sequence,
        width: width,
        height: height,
        trackItems: trackItems,
        resolved: resolved
    };
}

/**
 * Converts a placement into the units the host expects for writing.
 *
 * Crop values go out as percentages. That used to be inferred from the Motion
 * effect's scale value — one effect's convention deciding another's, which was
 * a guess dressed up as a detection. Measured in Premiere 26.3.2: writing 50
 * into the Crop effect yields "50,0 %" in Effect Controls, so the range is
 * 0‥100. If a future version disagrees, writing 50 into a 0‥1 parameter gets
 * clamped and the read-back comparison reports it — that guard is real, unlike
 * the old heuristic.
 */
function toWriteValues(placement, positionUnit, width, height) {
    const position = geometry.fromPixelPosition(
        placement.transformPositionPixels,
        positionUnit,
        width,
        height
    );
    return {
        position: position,
        crop: {
            left: geometry.round4(placement.crop.left),
            top: geometry.round4(placement.crop.top),
            right: geometry.round4(placement.crop.right),
            bottom: geometry.round4(placement.crop.bottom)
        }
    };
}

function describeChanges(placement) {
    return [
        { param: "Zelle", value: pairing.cellLabel(placement.cell) },
        {
            param: "Transformieren · Position",
            value: formatPoint(placement.transformPositionPixels) + " px"
        },
        { param: "Zuschneiden · Links", value: formatPercent(placement.crop.left) },
        { param: "Zuschneiden · Oben", value: formatPercent(placement.crop.top) },
        { param: "Zuschneiden · Rechts", value: formatPercent(placement.crop.right) },
        { param: "Zuschneiden · Unten", value: formatPercent(placement.crop.bottom) }
    ];
}

/**
 * Describes how each parameter was identified, but only when something other
 * than its name was used.
 *
 * This is the field-diagnosis handle for the two ways a lookup can go wrong
 * without the verification noticing: the positional fallback and the
 * structural probe can both land on a parameter that merely looks right, and
 * because writing and reading back use the same resolution, the mistake would
 * otherwise confirm itself. If a log says "struktur" where it should say
 * "name", the name lists need fixing.
 */
/**
 * Warns about additional Crop or Transform effects on the clip.
 *
 * They render before our pair and therefore change the result — either because
 * the user applied them deliberately, which is supported, or because half of a
 * previous split screen was deleted by hand and the other half stayed behind.
 * The chain cannot tell those apart, so this reports instead of deciding; the
 * stray would otherwise halve the image a second time while the run still said
 * "ok".
 */
function describeStrays(record) {
    if (!record.strays || !record.strays.length) return null;
    const parts = [];
    for (let i = 0; i < record.strays.length; i++) {
        parts.push(record.strays[i].matchName + " @" + record.strays[i].index);
    }
    return {
        param: "Achtung",
        value:
            "weitere Zuschneiden-/Transformieren-Effekte auf dem Clip (" +
            parts.join(", ") +
            ") — sie rendern vor dem Splitscreen und verändern das Ergebnis. " +
            "Falls das ein Rest eines früheren Splitscreens ist, von Hand entfernen."
    };
}

function describeResolution(current, motion) {
    const unusual = [];

    function collect(strategies) {
        if (!strategies) return;
        const keys = Object.keys(strategies);
        for (let i = 0; i < keys.length; i++) {
            const strategy = strategies[keys[i]];
            if (strategy && strategy !== "name") {
                unusual.push(keys[i] + ": " + strategy);
            }
        }
    }

    collect(motion && motion.strategies);
    collect(current && current.strategies);

    if (!unusual.length) return null;

    return {
        param: "Parameter-Auflösung",
        value: "nicht über den Namen gefunden — " + unusual.join(", ")
    };
}

/**
 * Builds the split screen.
 *
 * @param {{layout: string, swap: boolean, dryRun: boolean}} rawOptions
 */
async function createSplitScreen(rawOptions) {
    const options = {
        layout:
            rawOptions && rawOptions.layout === C.LAYOUT.ROWS
                ? C.LAYOUT.ROWS
                : C.LAYOUT.COLUMNS,
        swap: !!(rawOptions && rawOptions.swap),
        dryRun: !!(rawOptions && rawOptions.dryRun)
    };

    const report = emptyReport("create", options.dryRun, options);

    const context = await collectContext("create", options);
    if (context.error) return context.error;

    const { project, width, height, trackItems, resolved } = context;

    // ---- read every selected clip ----
    const records = [];
    const descriptors = [];
    for (let i = 0; i < trackItems.length; i++) {
        let record;
        try {
            record = await readClipRecord(trackItems[i], i, width, height, resolved);
        } catch (error) {
            report.fatalError =
                "Clip " + (i + 1) + " konnte nicht gelesen werden: " + describeError(error);
            return report;
        }
        records.push(record);
        descriptors.push(record.descriptor);
    }

    const byId = Object.create(null);
    for (let i = 0; i < records.length; i++) {
        byId[records[i].id] = records[i];
    }

    // ---- pre-flight validation: all or nothing ----
    const plan = pairing.buildPlan(descriptors, options);

    if (plan.ignored.length) {
        report.skipped += plan.ignored.length;
        report.notes.push(
            plan.ignored.length +
                (plan.ignored.length === 1
                    ? " Element der Auswahl ist kein Video-Clip und wurde ignoriert."
                    : " Elemente der Auswahl sind keine Video-Clips und wurden ignoriert.")
        );
    }

    if (!plan.ok) {
        report.validationErrors = plan.errors;
        report.fatalError =
            "Vorprüfung fehlgeschlagen — es wurde nichts geändert (" +
            plan.errors.length +
            (plan.errors.length === 1 ? " Grund)." : " Gründe).");
        return report;
    }

    // ---- compute placements ----
    const entries = [];
    for (let p = 0; p < plan.pairs.length; p++) {
        const pair = plan.pairs[p];
        for (let i = 0; i < pair.items.length; i++) {
            const item = pair.items[i];
            const record = byId[item.clip.id];
            let placement;
            try {
                placement = geometry.computePlacement({
                    cell: item.cell,
                    sequenceWidth: width,
                    sequenceHeight: height,
                    motion: record.descriptor.motion
                });
            } catch (error) {
                report.fatalError =
                    'Platzierung für "' +
                    record.descriptor.name +
                    '" nicht berechenbar: ' +
                    describeError(error);
                return report;
            }
            entries.push({
                record: record,
                pairIndex: p,
                startLabel: pair.startLabel,
                placement: placement
            });
        }
    }

    // A clip scaled far below 100 % cannot be moved into its half at all:
    // our Transform sits in front of Motion, so it has to shift by a quarter
    // frame divided by the Motion scale, and that pushes the whole image out
    // of the frame where it is discarded. Nothing sensible can be written, so
    // the run aborts rather than producing an invisible clip.
    const empties = [];
    for (let i = 0; i < entries.length; i++) {
        if (entries[i].placement.warnings.indexOf(geometry.WARNING.CELL_EMPTY) >= 0) {
            empties.push(entries[i]);
        }
    }
    if (empties.length) {
        for (let i = 0; i < empties.length; i++) {
            report.validationErrors.push({
                code: pairing.ERROR.CELL_EMPTY,
                message:
                    '"' +
                    empties[i].record.descriptor.name +
                    '" ist zu stark verkleinert, um in seine Hälfte verschoben zu werden. Skalierung auf über 25 % anheben.',
                clipName: empties[i].record.descriptor.name
            });
        }
        report.fatalError =
            "Vorprüfung fehlgeschlagen — es wurde nichts geändert (" +
            empties.length +
            (empties.length === 1 ? " Grund)." : " Gründe).");
        return report;
    }

    // ---- dry run stops here ----
    if (options.dryRun) {
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            report.processed++;

            const changes = describeChanges(entry.placement);
            if (entry.placement.warnings.indexOf(geometry.WARNING.CELL_NOT_FILLED) >= 0) {
                changes.push({
                    param: "Hinweis",
                    value: "Clip liefert zu wenig Bild — Hälfte wird nicht vollständig gefüllt."
                });
            }
            // Only the Motion lookups have run at this point; the Transform
            // and Crop parameters do not exist yet in the dry run.
            const resolution = describeResolution(null, entry.record.descriptor.motion);
            if (resolution) changes.push(resolution);
            const stray = describeStrays(entry.record);
            if (stray) changes.push(stray);

            report.results.push({
                clipName: entry.record.descriptor.name,
                status: "ok",
                reason:
                    "Dry-Run — nichts geschrieben. Paar bei " +
                    entry.startLabel +
                    (entry.record.ownPair
                        ? " · bestehender Splitscreen würde aktualisiert."
                        : " · Effekte würden neu eingefügt."),
                changes: changes
            });
        }
        report.notes.push(
            plan.pairs.length +
                (plan.pairs.length === 1 ? " Paar erkannt." : " Paare erkannt.")
        );
        return report;
    }

    // ---- create the components we are missing (async, before any transaction) ----
    const toInsert = [];
    for (let i = 0; i < entries.length; i++) {
        if (entries[i].record.ownPair) continue;
        try {
            entries[i].newTransform = await ppro.VideoFilterFactory.createComponent(
                resolved.transform
            );
            entries[i].newCrop = await ppro.VideoFilterFactory.createComponent(
                resolved.crop
            );
        } catch (error) {
            report.fatalError =
                "Effekt konnte nicht erzeugt werden: " + describeError(error);
            return report;
        }
        if (!entries[i].newTransform || !entries[i].newCrop) {
            report.fatalError =
                "Premiere hat die Effekt-Erzeugung abgelehnt. Diagnose-Button ausführen.";
            return report;
        }
        toInsert.push(entries[i]);
    }

    // ---- transaction 1: insert missing components ----
    if (toInsert.length) {
        let inserted = false;
        let insertError = null;

        project.lockedAccess(() => {
            try {
                inserted = project.executeTransaction((compoundAction) => {
                    for (let i = 0; i < toInsert.length; i++) {
                        const entry = toInsert[i];
                        const chain = entry.record.chain;
                        const index = entry.record.insertionIndex;
                        /*
                         * Both go in at the SAME index, Transform first: the
                         * second insertion pushes the Transform one up, which
                         * leaves the chain as [… Crop, Transform, user effects]
                         * — and because the chain runs opposite to the render
                         * order, that renders as user effects → Transform →
                         * Crop. See chain.computeInsertionIndex.
                         */
                        compoundAction.addAction(
                            chain.createInsertComponentAction(entry.newTransform, index)
                        );
                        compoundAction.addAction(
                            chain.createInsertComponentAction(entry.newCrop, index)
                        );
                    }
                }, C.UNDO_INSERT);
            } catch (error) {
                insertError = error;
            }
        });

        if (insertError || !inserted) {
            report.fatalError =
                "Effekte konnten nicht eingefügt werden — es wurde nichts geändert." +
                (insertError ? " " + describeError(insertError) : "");
            return report;
        }
    }

    // ---- re-read the chains so we address the components that are really in them ----
    for (let i = 0; i < entries.length; i++) {
        const record = entries[i].record;
        try {
            record.chain = await record.trackItem.getComponentChain();
            record.infos = await readChainInfos(record.chain);
            record.ownPair = chainUtil.findOwnPair(
                record.infos,
                resolved.transform,
                resolved.crop
            );
        } catch (error) {
            entries[i].readBackError = describeError(error);
        }

        if (!record.ownPair) {
            entries[i].readBackError =
                entries[i].readBackError ||
                "Eingefügte Effekte konnten in der Effektkette nicht wiedergefunden werden.";
            continue;
        }

        entries[i].current = await readPairValues(
            record.chain,
            record.ownPair,
            record.time,
            width,
            height
        );
        if (!entries[i].current.ok) {
            entries[i].readBackError = entries[i].current.reason;
            entries[i].paramDump = {
                transform: entries[i].current.transformParams,
                crop: entries[i].current.cropParams
            };
        }
    }

    const writable = [];
    const broken = [];
    for (let i = 0; i < entries.length; i++) {
        if (entries[i].readBackError) {
            broken.push(entries[i]);
        } else {
            writable.push(entries[i]);
        }
    }

    if (broken.length) {
        // Half-converted state: roll back the components we inserted.
        //
        // Rolled back by *component reference*, not by chain index. The most
        // likely reason to be here is that the inserted pair could not be
        // found in the re-read chain — so an index-based cleanup would skip
        // exactly the clips that need it. `createRemoveComponentAction` takes
        // a component, and the handles from the insertion are still valid.
        let cleanupOk = true;
        if (toInsert.length) {
            let cleanupError = null;
            let cleanupCommitted = false;

            project.lockedAccess(() => {
                try {
                    cleanupCommitted = project.executeTransaction((compoundAction) => {
                        for (let i = 0; i < toInsert.length; i++) {
                            const entry = toInsert[i];
                            const chain = entry.record.chain;
                            compoundAction.addAction(
                                chain.createRemoveComponentAction(entry.newCrop)
                            );
                            compoundAction.addAction(
                                chain.createRemoveComponentAction(entry.newTransform)
                            );
                        }
                    }, C.UNDO_CLEANUP);
                } catch (error) {
                    cleanupError = error;
                }
            });

            cleanupOk = cleanupCommitted && !cleanupError;
        }

        report.errors += broken.length;
        for (let i = 0; i < broken.length; i++) {
            report.results.push({
                clipName: broken[i].record.descriptor.name,
                status: "error",
                reason: broken[i].readBackError,
                // The full parameter layout, so a failed lookup can be
                // diagnosed from an exported log without guessing.
                params: broken[i].paramDump || null
            });
        }
        for (let i = 0; i < writable.length; i++) {
            report.results.push({
                clipName: writable[i].record.descriptor.name,
                status: "skipped",
                reason: "Nicht geschrieben, weil der Lauf abgebrochen wurde."
            });
            report.skipped++;
        }
        report.fatalError =
            "Abgebrochen: " +
            broken.length +
            " Clip(s) nicht beschreibbar. " +
            (toInsert.length === 0
                ? "Es wurde nichts eingefügt."
                : cleanupOk
                  ? "Eingefügte Effekte wurden wieder entfernt."
                  : "Die eingefügten Effekte konnten NICHT automatisch entfernt werden — bitte Cmd/Ctrl+Z drücken.");
        report.notes.push("Bitte Diagnose ausführen und die Ausgabe prüfen.");
        return report;
    }

    // ---- transaction 2: write the values ----
    for (let i = 0; i < writable.length; i++) {
        const entry = writable[i];
        entry.write = toWriteValues(
            entry.placement,
            entry.current.positionUnit,
            width,
            height
        );
    }

    let committed = false;
    let writeError = null;

    project.lockedAccess(() => {
        try {
            committed = project.executeTransaction((compoundAction) => {
                for (let i = 0; i < writable.length; i++) {
                    const entry = writable[i];
                    const chain = entry.record.chain;
                    const transform = chain.getComponentAtIndex(
                        entry.record.ownPair.transformIndex
                    );
                    const crop = chain.getComponentAtIndex(entry.record.ownPair.cropIndex);
                    if (!transform || !crop) {
                        throw new Error(
                            'Effekte von "' +
                                entry.record.descriptor.name +
                                '" waren beim Schreiben nicht mehr verfügbar.'
                        );
                    }

                    const positionParam = transform.getParam(entry.current.positionIndex);

                    // A keyframed parameter would swallow createSetValueAction,
                    // so keyframing is switched off first — this also repairs a
                    // pair someone animated by hand.
                    const keyframed = entry.current.keyframed || [];
                    if (keyframed.indexOf("position") !== -1) {
                        compoundAction.addAction(
                            positionParam.createSetTimeVaryingAction(false)
                        );
                    }

                    const positionKeyframe = positionParam.createKeyframe(
                        new ppro.PointF(entry.write.position.x, entry.write.position.y)
                    );
                    compoundAction.addAction(
                        positionParam.createSetValueAction(positionKeyframe, true)
                    );

                    for (let k = 0; k < C.CROP_PARAMS.length; k++) {
                        const key = C.CROP_PARAMS[k].key;
                        const cropParam = crop.getParam(entry.current.cropIndices[key]);
                        if (keyframed.indexOf(key) !== -1) {
                            compoundAction.addAction(
                                cropParam.createSetTimeVaryingAction(false)
                            );
                        }
                        const cropKeyframe = cropParam.createKeyframe(entry.write.crop[key]);
                        compoundAction.addAction(
                            cropParam.createSetValueAction(cropKeyframe, true)
                        );
                    }

                    // Crop's "Zoom" must stay off, otherwise the cropped half
                    // gets rescaled back to full frame. Forced rather than
                    // assumed, so a re-run repairs a pair someone fiddled with.
                    if (entry.current.zoomIndex >= 0) {
                        const zoomParam = crop.getParam(entry.current.zoomIndex);
                        const zoomKeyframe = zoomParam.createKeyframe(false);
                        compoundAction.addAction(
                            zoomParam.createSetValueAction(zoomKeyframe, true)
                        );
                    }
                }
            }, C.UNDO_VALUES);
        } catch (error) {
            writeError = error;
        }
    });

    if (writeError || !committed) {
        // Same rollback as above: remove what this run inserted, by reference.
        let cleanupOk = true;
        if (toInsert.length) {
            let cleanupError = null;
            let cleanupCommitted = false;

            project.lockedAccess(() => {
                try {
                    cleanupCommitted = project.executeTransaction((compoundAction) => {
                        for (let i = 0; i < toInsert.length; i++) {
                            const entry = toInsert[i];
                            const chain = entry.record.chain;
                            compoundAction.addAction(
                                chain.createRemoveComponentAction(entry.newCrop)
                            );
                            compoundAction.addAction(
                                chain.createRemoveComponentAction(entry.newTransform)
                            );
                        }
                    }, C.UNDO_CLEANUP);
                } catch (error) {
                    cleanupError = error;
                }
            });

            cleanupOk = cleanupCommitted && !cleanupError;
        }

        report.errors += writable.length;
        for (let i = 0; i < writable.length; i++) {
            report.results.push({
                clipName: writable[i].record.descriptor.name,
                status: "error",
                reason: "Werte wurden nicht geschrieben."
            });
        }
        report.fatalError =
            "Werte konnten nicht geschrieben werden." +
            (writeError ? " " + describeError(writeError) : "") +
            " " +
            (toInsert.length === 0
                ? "Bestehende Effekte sind unverändert."
                : cleanupOk
                  ? "Eingefügte Effekte wurden wieder entfernt."
                  : "Die eingefügten Effekte konnten NICHT automatisch entfernt werden — bitte Cmd/Ctrl+Z drücken.");
        return report;
    }

    // ---- verification: read back what we wrote ----
    for (let i = 0; i < writable.length; i++) {
        const entry = writable[i];
        const record = entry.record;
        const changes = describeChanges(entry.placement);
        const problems = [];

        try {
            const after = await readPairValues(
                await record.trackItem.getComponentChain(),
                record.ownPair,
                record.time,
                width,
                height
            );
            if (!after.ok) {
                problems.push("Nachkontrolle nicht möglich: " + after.reason);
            } else {
                if (
                    !after.positionPixels ||
                    !geometry.nearlyEqual(
                        after.positionPixels.x,
                        entry.placement.transformPositionPixels.x,
                        VERIFY_EPSILON_PIXELS
                    ) ||
                    !geometry.nearlyEqual(
                        after.positionPixels.y,
                        entry.placement.transformPositionPixels.y,
                        VERIFY_EPSILON_PIXELS
                    )
                ) {
                    problems.push("Position weicht nach dem Schreiben ab.");
                }
                for (let k = 0; k < C.CROP_PARAMS.length; k++) {
                    const key = C.CROP_PARAMS[k].key;
                    if (
                        !geometry.nearlyEqual(
                            after.cropValues[key],
                            entry.write.crop[key],
                            VERIFY_EPSILON_PERCENT
                        )
                    ) {
                        problems.push("Zuschneiden-Wert " + key + " weicht ab.");
                    }
                }
                if (after.keyframed && after.keyframed.length) {
                    problems.push(
                        "Noch animiert nach dem Schreiben: " + after.keyframed.join(", ") + "."
                    );
                }
            }
        } catch (error) {
            problems.push("Nachkontrolle fehlgeschlagen: " + describeError(error));
        }

        if (entry.placement.warnings.indexOf(geometry.WARNING.CELL_NOT_FILLED) >= 0) {
            changes.push({
                param: "Hinweis",
                value: "Clip liefert zu wenig Bild — Hälfte wird nicht vollständig gefüllt."
            });
        }

        const resolution = describeResolution(
            entry.current,
            entry.record.descriptor.motion
        );
        if (resolution) changes.push(resolution);
        const stray = describeStrays(entry.record);
        if (stray) changes.push(stray);

        if (problems.length) {
            report.errors++;
            report.results.push({
                clipName: record.descriptor.name,
                status: "error",
                reason: problems.join(" "),
                changes: changes
            });
        } else {
            report.processed++;
            report.results.push({
                clipName: record.descriptor.name,
                status: "ok",
                reason:
                    pairing.cellLabel(entry.placement.cell) +
                    " · Paar bei " +
                    entry.startLabel,
                changes: changes
            });
        }
    }

    report.notes.push(
        plan.pairs.length + (plan.pairs.length === 1 ? " Paar" : " Paare") + " verarbeitet."
    );

    let disabledMotion = 0;
    for (let i = 0; i < writable.length; i++) {
        if (writable[i].record.descriptor.motionDisabled) disabledMotion++;
    }
    if (disabledMotion > 0) {
        report.notes.push(
            disabledMotion +
                (disabledMotion === 1 ? " Clip hat" : " Clips haben") +
                " Auto Reframe — Premiere schaltet dort den Bewegungs-Effekt ab, " +
                "es wurde daher nichts kompensiert."
        );
    }
    report.notes.push(
        toInsert.length
            ? "Rückgängig: zwei Schritte (Effekte einfügen, Werte setzen)."
            : "Rückgängig: ein Schritt."
    );
    if (report.errors > 0) {
        report.notes.push(
            "Abweichungen bei der Nachkontrolle deuten auf andere Einheiten oder Parameternamen hin — bitte Diagnose ausführen."
        );
    }

    return report;
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

/**
 * Removes the split screen by deleting only the two components this plugin
 * added. Everything else — a punch-in in Motion, Auto Reframe, a foreign Crop
 * — is left untouched, because it was never modified in the first place.
 *
 * @param {{dryRun: boolean}} rawOptions
 */
async function removeSplitScreen(rawOptions) {
    const options = { dryRun: !!(rawOptions && rawOptions.dryRun) };
    const report = emptyReport("remove", options.dryRun, options);

    const context = await collectContext("remove", options);
    if (context.error) return context.error;

    const { project, width, height, trackItems, resolved } = context;

    const targets = [];
    for (let i = 0; i < trackItems.length; i++) {
        let record;
        try {
            record = await readClipRecord(trackItems[i], i, width, height, resolved);
        } catch (error) {
            report.errors++;
            report.results.push({
                clipName: "(Clip " + (i + 1) + ")",
                status: "error",
                reason: describeError(error)
            });
            continue;
        }

        if (!record.descriptor.isVideo) {
            report.skipped++;
            report.results.push({
                clipName: record.descriptor.name,
                status: "skipped",
                reason: "Kein Video-Clip — ignoriert."
            });
            continue;
        }
        if (!record.ownPair) {
            report.skipped++;
            report.results.push({
                clipName: record.descriptor.name,
                status: "skipped",
                reason: "Kein von Split Screener angelegter Splitscreen gefunden.",
                // The chain, so "split screen under an unrecognised effect
                // name" can be told apart from "genuinely no split screen".
                components: record.infos
            });
            continue;
        }
        targets.push(record);
    }

    if (!targets.length) {
        report.notes.push("Nichts zu entfernen.");
        return report;
    }

    if (options.dryRun) {
        for (let i = 0; i < targets.length; i++) {
            report.processed++;
            report.results.push({
                clipName: targets[i].descriptor.name,
                status: "ok",
                reason: "Dry-Run — Transformieren und Zuschneiden würden entfernt."
            });
        }
        return report;
    }

    let committed = false;
    let removeError = null;

    project.lockedAccess(() => {
        try {
            committed = project.executeTransaction((compoundAction) => {
                for (let i = 0; i < targets.length; i++) {
                    const record = targets[i];
                    const chain = record.chain;
                    const transform = chain.getComponentAtIndex(record.ownPair.transformIndex);
                    const crop = chain.getComponentAtIndex(record.ownPair.cropIndex);
                    if (!transform || !crop) {
                        throw new Error(
                            'Effekte von "' +
                                record.descriptor.name +
                                '" waren beim Entfernen nicht mehr verfügbar.'
                        );
                    }
                    compoundAction.addAction(chain.createRemoveComponentAction(crop));
                    compoundAction.addAction(chain.createRemoveComponentAction(transform));
                }
            }, C.UNDO_REMOVE);
        } catch (error) {
            removeError = error;
        }
    });

    if (removeError || !committed) {
        report.errors += targets.length;
        report.fatalError =
            "Entfernen fehlgeschlagen — es wurde nichts geändert." +
            (removeError ? " " + describeError(removeError) : "");
        return report;
    }

    for (let i = 0; i < targets.length; i++) {
        const record = targets[i];
        let stillThere = false;
        try {
            const freshChain = await record.trackItem.getComponentChain();
            const infos = await readChainInfos(freshChain);
            stillThere = !!chainUtil.findOwnPair(infos, resolved.transform, resolved.crop);
        } catch {
            stillThere = false;
        }

        if (stillThere) {
            report.errors++;
            report.results.push({
                clipName: record.descriptor.name,
                status: "error",
                reason: "Effekte sind nach dem Entfernen noch vorhanden."
            });
        } else {
            report.processed++;
            report.results.push({
                clipName: record.descriptor.name,
                status: "ok",
                reason: "Transformieren und Zuschneiden entfernt, übriger Clip unverändert."
            });
        }
    }

    report.notes.push("Alle Änderungen sind ein einzelner Undo-Schritt (Cmd/Ctrl+Z).");
    return report;
}

module.exports = {
    createSplitScreen: createSplitScreen,
    removeSplitScreen: removeSplitScreen,
    PLUGIN_VERSION: PLUGIN_VERSION,
    describeHost: describeHost,
    // exported for src/diagnostics.js
    resolveEffectMatchNames: resolveEffectMatchNames,
    readChainInfos: readChainInfos,
    describeComponentParams: describeComponentParams,
    describeError: describeError,
    findParamIndex: findParamIndex
};
