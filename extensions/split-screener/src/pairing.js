/**
 * Split Screener — src/pairing.js
 *
 * Pure pairing and pre-flight validation. Operates on plain clip descriptors
 * so the whole rule set is unit testable without Premiere.
 *
 * CONTRACT: all-or-nothing. The caller must not write anything unless
 * `buildPlan()` returns `ok: true`. Every rule that fails is reported, not
 * just the first one, so the user can fix everything in one go.
 *
 * A clip descriptor looks like this:
 * {
 *   id: number,              // stable within one run, used for reporting
 *   name: string,
 *   trackIndex: number,      // 0 = V1
 *   startKey: string,        // sequence start time, exact (ticks as string)
 *   endKey: string,          // sequence end time, exact
 *   startLabel: string,      // human readable position for messages
 *   timesReadable: boolean,  // false when start/end could not be read at all
 *   isVideo: boolean,
 *   motionProblem: string|null, // why motion is null, for the message
 *   motion: null | {
 *     rotation: number,        // degrees, for the message
 *     rotated: boolean,        // rotation differs from zero
 *     anchorMoved: boolean,    // anchor point differs from the frame centre
 *     keyframed: boolean       // position or scale is time varying
 *   }
 * }
 */

const { cellsForLayout } = require("./geometry.js");
const { CELL_LABEL } = require("./constants.js");

const ERROR = {
    TOO_FEW_CLIPS: "too-few-clips",
    CHAIN_UNREADABLE: "chain-unreadable",
    NO_PARTNER: "no-partner",
    TOO_MANY_CLIPS: "too-many-clips",
    SAME_TRACK: "same-track",
    TIMES_UNREADABLE: "times-unreadable",
    MOTION_MISSING: "motion-missing",
    ROTATED: "rotated",
    ANCHOR_MOVED: "anchor-moved",
    KEYFRAMED: "keyframed",
    CELL_EMPTY: "cell-empty"
};

function pushError(errors, code, message, clipName) {
    errors.push({
        code: code,
        message: message,
        clipName: clipName || null
    });
}

function timeKeyOf(clip) {
    return String(clip.startKey) + "|" + String(clip.endKey);
}

/**
 * Groups clips by exactly identical start and end time. No tolerance: the
 * requirement is that the two clips are truly congruent.
 *
 * @returns {{key: string, clips: Object[]}[]} groups in input order of first
 *          occurrence, which keeps reports stable
 */
function groupByTime(clips) {
    const order = [];
    const byKey = Object.create(null);

    for (let i = 0; i < clips.length; i++) {
        const key = timeKeyOf(clips[i]);
        if (!byKey[key]) {
            byKey[key] = { key: key, clips: [] };
            order.push(byKey[key]);
        }
        byKey[key].clips.push(clips[i]);
    }

    return order;
}

/**
 * Validates the selection and builds the pair plan.
 *
 * @param {Object[]} clips clip descriptors
 * @param {{layout: string, swap: boolean}} options
 * @returns {{
 *   ok: boolean,
 *   errors: {code: string, message: string, clipName: string|null}[],
 *   pairs: {key: string, startLabel: string, items: {clip: Object, cell: string}[]}[],
 *   ignored: Object[]
 * }}
 */
function buildPlan(clips, options) {
    const errors = [];
    const pairs = [];
    const ignored = [];
    const videoClips = [];

    const list = clips || [];
    for (let i = 0; i < list.length; i++) {
        if (list[i].isVideo) {
            videoClips.push(list[i]);
        } else if (list[i].chainProblem) {
            // Could not be inspected at all. Not the same as "no video clip",
            // so it must not be dropped quietly.
            pushError(
                errors,
                ERROR.CHAIN_UNREADABLE,
                'Effektkette von "' +
                    list[i].name +
                    '" ist nicht lesbar: ' +
                    list[i].chainProblem +
                    " Der Clip lässt sich nicht prüfen.",
                list[i].name
            );
        } else {
            ignored.push(list[i]);
        }
    }

    if (errors.length) {
        return { ok: false, errors: errors, pairs: [], ignored: ignored };
    }

    if (videoClips.length < 2) {
        pushError(
            errors,
            ERROR.TOO_FEW_CLIPS,
            "Mindestens zwei Video-Clips auf verschiedenen Spuren auswählen."
        );
        return { ok: false, errors: errors, pairs: [], ignored: ignored };
    }

    const cells = cellsForLayout(options.layout, !!options.swap);

    // Clips whose sequence times could not be read must never be paired: they
    // would all share the same unknown time key and look congruent to each
    // other. Rejected before grouping so that cannot happen.
    const timed = [];
    for (let i = 0; i < videoClips.length; i++) {
        if (videoClips[i].timesReadable === false) {
            pushError(
                errors,
                ERROR.TIMES_UNREADABLE,
                'Start- und Endzeit von "' +
                    videoClips[i].name +
                    '" sind nicht lesbar. Deckungsgleichheit lässt sich nicht prüfen.',
                videoClips[i].name
            );
        } else {
            timed.push(videoClips[i]);
        }
    }

    const groups = groupByTime(timed);

    for (let g = 0; g < groups.length; g++) {
        const group = groups[g];
        const members = group.clips;
        const where = members[0].startLabel || "unbekannte Position";

        if (members.length === 1) {
            pushError(
                errors,
                ERROR.NO_PARTNER,
                'Kein deckungsgleicher Partner bei "' +
                    members[0].name +
                    '" (' +
                    where +
                    "). Start- und Endzeit müssen exakt übereinstimmen.",
                members[0].name
            );
            continue;
        }

        if (members.length > 2) {
            pushError(
                errors,
                ERROR.TOO_MANY_CLIPS,
                "Bei " +
                    where +
                    " liegen " +
                    members.length +
                    " deckungsgleiche Clips übereinander. Es werden genau zwei unterstützt.",
                null
            );
            continue;
        }

        const sorted = members.slice().sort(function (a, b) {
            return a.trackIndex - b.trackIndex;
        });

        if (sorted[0].trackIndex === sorted[1].trackIndex) {
            pushError(
                errors,
                ERROR.SAME_TRACK,
                "Die Clips bei " +
                    where +
                    " liegen auf derselben Spur. Sie müssen auf verschiedenen Spuren liegen.",
                null
            );
            continue;
        }

        pairs.push({
            key: group.key,
            startLabel: where,
            items: [
                { clip: sorted[0], cell: cells[0] },
                { clip: sorted[1], cell: cells[1] }
            ]
        });
    }

    // Per-clip preconditions. Checked for every selected clip, not just the
    // paired ones, so the user sees the full picture in one report.
    const byTrack = videoClips.slice().sort(function (a, b) {
        return a.trackIndex - b.trackIndex;
    });

    for (let i = 0; i < byTrack.length; i++) {
        const clip = byTrack[i];

        if (!clip.motion) {
            pushError(
                errors,
                ERROR.MOTION_MISSING,
                'Bewegungs-Effekt von "' +
                    clip.name +
                    '" ist nicht vollständig lesbar' +
                    (clip.motionProblem ? ": " + clip.motionProblem : "") +
                    ". Ohne ihn lässt sich die Platzierung nicht sicher berechnen — bitte Diagnose ausführen.",
                clip.name
            );
            continue;
        }

        if (clip.motion.rotated) {
            pushError(
                errors,
                ERROR.ROTATED,
                '"' +
                    clip.name +
                    '" ist gedreht (' +
                    clip.motion.rotation +
                    "°). Gedrehte Clips werden nicht unterstützt, weil ein gerader Beschnitt sie nicht korrekt halbieren kann.",
                clip.name
            );
        }

        if (clip.motion.anchorMoved) {
            pushError(
                errors,
                ERROR.ANCHOR_MOVED,
                '"' +
                    clip.name +
                    '" hat einen verschobenen Ankerpunkt. Das wird nicht unterstützt.',
                clip.name
            );
        }

        if (clip.motion.keyframed) {
            pushError(
                errors,
                ERROR.KEYFRAMED,
                '"' +
                    clip.name +
                    '" hat Keyframes auf Position oder Skalierung. Animierte Transformationen werden nicht unterstützt.',
                clip.name
            );
        }
    }

    const ok = errors.length === 0 && pairs.length > 0;

    if (errors.length === 0 && pairs.length === 0) {
        pushError(
            errors,
            ERROR.TOO_FEW_CLIPS,
            "Keine verwertbaren Clip-Paare gefunden."
        );
    }

    return {
        ok: ok,
        errors: errors,
        pairs: ok ? pairs : [],
        ignored: ignored
    };
}

/** "links"/"rechts"/"oben"/"unten" for the report. */
function cellLabel(cell) {
    return CELL_LABEL[cell] || String(cell);
}

module.exports = {
    ERROR,
    timeKeyOf,
    groupByTime,
    buildPlan,
    cellLabel
};
