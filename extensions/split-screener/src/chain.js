/**
 * Split Screener — src/chain.js
 *
 * Pure reasoning about a clip's component chain. Takes plain descriptor
 * objects (`{ index, matchName, displayName }`), never the Premiere objects
 * themselves, so all of it is unit testable.
 *
 * WHY THE INSERTION INDEX MATTERS
 * Our two effects must end up behind every user effect. Premiere's intrinsic
 * components (Motion, Opacity, …) live in the same chain but are always
 * rendered last regardless of their index, so they must not be counted as
 * user effects when we look for "the end of the standard effects".
 *
 * WHY THE PAIR DETECTION LOOKS LIKE THIS
 * Our Crop is an ordinary Crop effect — nothing distinguishes it from one the
 * user applied by hand. The signature is therefore structural: an adjacent
 * Transform-then-Crop pair among the standard components, the last one if
 * there are several. See `findOwnPair` for why it is not pinned to the end of
 * the chain.
 */

const {
    INTRINSIC_MATCHNAME_FRAGMENTS,
    VIDEO_INTRINSIC_MATCHNAME_FRAGMENTS,
    MOTION_MATCHNAME_FRAGMENTS,
    AUTO_REFRAME_MATCHNAME_FRAGMENTS
} = require("./constants.js");

function normalizeName(value) {
    return String(value === null || value === undefined ? "" : value)
        .trim()
        .toLowerCase();
}

/** Collapses whitespace and separators so "AE.ADBE Motion" matches "adbe motion". */
function compactName(value) {
    return normalizeName(value).replace(/[\s._-]/g, "");
}

function nameMatchesAny(value, candidates) {
    const normalized = normalizeName(value);
    if (!normalized) return false;
    for (let i = 0; i < candidates.length; i++) {
        if (normalized === normalizeName(candidates[i])) return true;
    }
    return false;
}

function containsAnyFragment(value, fragments) {
    const compact = compactName(value);
    if (!compact) return false;
    for (let i = 0; i < fragments.length; i++) {
        if (compact.indexOf(compactName(fragments[i])) !== -1) return true;
    }
    return false;
}

function isIntrinsicMatchName(matchName) {
    return containsAnyFragment(matchName, INTRINSIC_MATCHNAME_FRAGMENTS);
}

/** True for intrinsics that only ever occur on video clips. */
function isVideoIntrinsicMatchName(matchName) {
    return containsAnyFragment(matchName, VIDEO_INTRINSIC_MATCHNAME_FRAGMENTS);
}

/** True when the chain carries at least one video-only intrinsic. */
function looksLikeVideoChain(infos) {
    if (!infos) return false;
    for (let i = 0; i < infos.length; i++) {
        if (isVideoIntrinsicMatchName(infos[i].matchName)) return true;
    }
    return false;
}

function isMotionMatchName(matchName) {
    return containsAnyFragment(matchName, MOTION_MATCHNAME_FRAGMENTS);
}

/**
 * Index at which our effects have to be inserted so they RENDER behind all
 * user effects.
 *
 * THE CHAIN RUNS OPPOSITE TO THE RENDER ORDER. Measured in Premiere 26.3.2:
 * a clip whose chain was
 *
 *   [0] Opacity  [1] Motion  [2] Auto Reframe  [3] Transform  [4] Crop
 *
 * showed its standard effects in Effect Controls — which is render order, top
 * first — as
 *
 *   Crop(4) → Transform(3) → Auto Reframe(2)
 *
 * So a HIGHER chain index renders EARLIER. To render last, our effects need
 * the LOWEST indices among the standard components, which means inserting in
 * front of them — not appending. Appending put us before Auto Reframe, which
 * then reframed our already-placed halves out of the picture.
 *
 * The intrinsics form the leading block of the chain (Opacity, Motion), so the
 * insertion point is the first non-intrinsic index.
 *
 * @param {{index: number, matchName: string}[]} infos whole chain, in order
 * @returns {number}
 */
function computeInsertionIndex(infos) {
    if (!infos || !infos.length) return 0;
    for (let i = 0; i < infos.length; i++) {
        if (!isIntrinsicMatchName(infos[i].matchName)) return i;
    }
    // Nothing but intrinsics — append, there is no user effect to get behind.
    return infos.length;
}

/** The chain entries that are user effects, in order. */
function standardComponents(infos) {
    const result = [];
    if (!infos) return result;
    for (let i = 0; i < infos.length; i++) {
        if (!isIntrinsicMatchName(infos[i].matchName)) result.push(infos[i]);
    }
    return result;
}

/**
 * Locates the Crop + Transform pair this plugin applied.
 *
 * Note the order: because the chain runs opposite to the render order (see
 * computeInsertionIndex), our pair sits in the chain as Crop first, Transform
 * directly after it — which renders as Transform, then Crop.
 *
 * Scans from the front and takes the first such adjacent pair, i.e. the one
 * that renders last and is therefore the operative one. Deliberately not
 * pinned to a fixed position in the chain: adding a Lumetri after building a
 * split screen is an everyday thing to do, and failing to recognise our own
 * pair there would make the next run insert a second one — halving and
 * shifting the image twice, unrepairable from inside the plugin. The cost is
 * the mirror-image risk: a hand-built Crop directly followed by a Transform is
 * taken for ours. That is the documented limitation, and it is the far less
 * destructive of the two.
 *
 * @param {{index: number, matchName: string}[]} infos
 * @param {string} transformMatchName resolved at runtime
 * @param {string} cropMatchName resolved at runtime
 * @returns {{transformIndex: number, cropIndex: number}|null}
 */
function findOwnPair(infos, transformMatchName, cropMatchName) {
    const standard = standardComponents(infos);
    if (standard.length < 2) return null;

    for (let i = 0; i < standard.length - 1; i++) {
        const crop = standard[i];
        const transform = standard[i + 1];

        if (!nameMatchesAny(crop.matchName, [cropMatchName])) continue;
        if (!nameMatchesAny(transform.matchName, [transformMatchName])) continue;
        if (transform.index !== crop.index + 1) continue;

        return { transformIndex: transform.index, cropIndex: crop.index };
    }

    return null;
}

/** Index of the intrinsic Motion component, or -1. */
function findMotionIndex(infos) {
    if (!infos) return -1;
    for (let i = 0; i < infos.length; i++) {
        if (isMotionMatchName(infos[i].matchName)) return infos[i].index;
    }
    return -1;
}

/**
 * True when the clip carries Auto Reframe.
 *
 * Relevant because Premiere disables the intrinsic Motion effect entirely
 * while Auto Reframe is applied — Effect Controls says so in as many words:
 * "Bewegung (Deaktiviert, wenn Auto Reframe angewendet ist)". Motion's values
 * are then inert, so neither compensating for them nor rejecting a clip
 * because of them would be correct.
 */
function hasAutoReframe(infos) {
    if (!infos) return false;
    for (let i = 0; i < infos.length; i++) {
        if (containsAnyFragment(infos[i].matchName, AUTO_REFRAME_MATCHNAME_FRAGMENTS)) {
            return true;
        }
    }
    return false;
}

/**
 * Picks the match name to use for an effect: an exact candidate if the host
 * offers it, otherwise the shortest fragment match (shortest wins because
 * "Crop" should beat a hypothetical "Auto Crop Pro").
 *
 * @param {string[]} available all match names reported by the host
 * @param {string[]} candidates preferred exact match names
 * @param {string[]} fragments fallback fragments
 * @returns {string|null}
 */
function resolveMatchName(available, candidates, fragments) {
    const list = available || [];

    for (let i = 0; i < candidates.length; i++) {
        for (let j = 0; j < list.length; j++) {
            if (normalizeName(list[j]) === normalizeName(candidates[i])) {
                return list[j];
            }
        }
    }

    let best = null;
    for (let j = 0; j < list.length; j++) {
        if (!containsAnyFragment(list[j], fragments)) continue;
        if (best === null || String(list[j]).length < String(best).length) {
            best = list[j];
        }
    }
    return best;
}

module.exports = {
    normalizeName,
    compactName,
    nameMatchesAny,
    containsAnyFragment,
    isIntrinsicMatchName,
    isVideoIntrinsicMatchName,
    looksLikeVideoChain,
    isMotionMatchName,
    computeInsertionIndex,
    standardComponents,
    findOwnPair,
    findMotionIndex,
    hasAutoReframe,
    resolveMatchName
};
