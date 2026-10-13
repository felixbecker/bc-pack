/**
 * Split Screener — src/constants.js
 *
 * All match names and parameter names the plugin has to recognise.
 *
 * Two different lookup strategies are used on purpose:
 *
 *  - Effects are looked up by **matchName**, which is locale independent. The
 *    exact candidates are tried first; if Adobe ever renames them, the
 *    fragment lists act as a fallback. The authoritative list of what is
 *    actually available is queried at runtime via
 *    `VideoFilterFactory.getMatchNames()`.
 *
 *  - Parameters have to be looked up by **display name**, which is localized.
 *    Hence every parameter carries a candidate list with the English and
 *    German spellings, plus a positional fallback index for the Crop effect
 *    whose parameter order (Left, Top, Right, Bottom, Zoom) is fixed.
 */

/** Layout chosen by the user. */
const LAYOUT = {
    /** Clips side by side, split line runs vertically. */
    COLUMNS: "columns",
    /** Clips stacked, split line runs horizontally. */
    ROWS: "rows"
};

/** The half of the frame a clip is placed in. */
const CELL = {
    LEFT: "left",
    RIGHT: "right",
    TOP: "top",
    BOTTOM: "bottom"
};

const CELL_LABEL = {
    left: "links",
    right: "rechts",
    top: "oben",
    bottom: "unten"
};

// ---------------------------------------------------------------------------
// Effects we insert
// ---------------------------------------------------------------------------

/** Transform effect — carries the placement offset. */
const TRANSFORM_MATCHNAMES = ["AE.ADBE Geometry2", "ADBE Geometry2"];
const TRANSFORM_MATCHNAME_FRAGMENTS = ["geometry2", "geometry"];

/** Crop effect — cuts the cell out of the frame. */
const CROP_MATCHNAMES = ["AE.ADBE Crop", "ADBE Crop", "PR.ADBE Crop"];
const CROP_MATCHNAME_FRAGMENTS = ["crop"];

// ---------------------------------------------------------------------------
// Effects we read
// ---------------------------------------------------------------------------

/** Intrinsic Motion effect — applied after all standard effects. */
const MOTION_MATCHNAME_FRAGMENTS = ["adbe motion"];

/**
 * Intrinsic components. They are never user effects, so they are excluded when
 * determining where our own effects have to be inserted.
 */
const INTRINSIC_MATCHNAME_FRAGMENTS = [
    "adbe motion",
    "adbe opacity",
    "adbe time remapping",
    "adbe timeremapping",
    "adbe volume",
    "adbe audio",
    "adbe channel volume",
    "adbe panner"
];

/**
 * The subset of intrinsics that only ever appear on video clips. Used to tell
 * video from audio: an audio chain carries Volume and Panner, never Motion or
 * Opacity. Opacity is included deliberately so that a video clip whose Motion
 * component we fail to recognise is still treated as video and produces a
 * clear error, instead of being silently skipped as "not a video clip".
 */
const VIDEO_INTRINSIC_MATCHNAME_FRAGMENTS = [
    "adbe motion",
    "adbe opacity",
    "adbe time remapping",
    "adbe timeremapping"
];

// ---------------------------------------------------------------------------
// Parameter display names
// ---------------------------------------------------------------------------

/*
 * Parameter identification.
 *
 * `ComponentParam` exposes no matchName — only the LOCALIZED `displayName`.
 * There is therefore no language-independent handle, which is a genuine gap in
 * the API, and in some effects a parameter's display name is even blank. Each
 * parameter is consequently resolved in up to four stages: exact name in
 * priority order, substring fragment, a positional fallback where the
 * parameter order is known to be stable, and a structural probe by value
 * shape. Failing all of those, the clip is rejected with the full parameter
 * dump attached — see resolveRequiredParam in core.js.
 */

const CROP_PARAMS = [
    { key: "left", label: "Links", names: ["left", "links"], fragments: ["links", "left"], fallbackIndex: 0 },
    { key: "top", label: "Oben", names: ["top", "oben"], fragments: ["oben", "top"], fallbackIndex: 1 },
    { key: "right", label: "Rechts", names: ["right", "rechts"], fragments: ["rechts", "right"], fallbackIndex: 2 },
    { key: "bottom", label: "Unten", names: ["bottom", "unten"], fragments: ["unten", "bottom"], fallbackIndex: 3 }
];

/**
 * Crop's "Zoom" checkbox. We never want it: it would rescale the cropped
 * result and defeat the placement. Explicitly forced off so that a re-run on
 * a pair whose Zoom someone switched on repairs itself.
 */
const CROP_ZOOM_NAMES = ["zoom"];

/**
 * Lower bound for the number of parameters Premiere's Crop effect is expected
 * to have. It exposes Left, Top, Right, Bottom and usually a Zoom checkbox;
 * four is required so the positional fallback cannot address a component that
 * clearly is not the Crop effect.
 */
const CROP_MIN_PARAM_COUNT = 4;

const TRANSFORM_POSITION_NAMES = ["position"];
const TRANSFORM_POSITION_FRAGMENTS = ["position"];

/**
 * The Transform effect's anchor point. Not written, only resolved so it can be
 * claimed: it is a point sitting on the frame centre just like Position, so
 * both the fragment search and the structural probe could otherwise pick it.
 */
const TRANSFORM_ANCHOR_NAMES = ["anchor point", "ankerpunkt"];
const TRANSFORM_ANCHOR_FRAGMENTS = ["anker", "anchor"];

const MOTION_POSITION_NAMES = ["position"];
const MOTION_POSITION_FRAGMENTS = ["position"];

const MOTION_SCALE_NAMES = ["scale", "skalierung", "scale height", "skalierungshöhe"];
const MOTION_SCALE_FRAGMENTS = ["skalierungshöhe", "scale height", "skalierung", "scale"];

const MOTION_SCALE_WIDTH_NAMES = [
    "scale width",
    "skalierungsbreite",
    "breite skalieren"
];
const MOTION_SCALE_WIDTH_FRAGMENTS = ["skalierungsbreite", "scale width"];

const MOTION_UNIFORM_SCALE_NAMES = [
    "uniform scale",
    "gleichmäßig skalieren",
    "einheitliche skalierung",
    "proportional skalieren"
];
const MOTION_UNIFORM_SCALE_FRAGMENTS = [
    "gleichmäßig",
    "gleichmassig",
    "uniform",
    "proportional",
    "einheitlich"
];

const MOTION_ROTATION_NAMES = ["rotation", "drehung"];
const MOTION_ROTATION_FRAGMENTS = ["drehung", "rotation", "rotat"];

const MOTION_ANCHOR_NAMES = ["anchor point", "ankerpunkt", "ankerpunkt position"];
const MOTION_ANCHOR_FRAGMENTS = ["anker", "anchor"];

// ---------------------------------------------------------------------------
// Transaction labels (these show up in Premiere's undo stack)
// ---------------------------------------------------------------------------

const UNDO_INSERT = "Split Screener: Effekte einfügen";
const UNDO_VALUES = "Split Screener: Splitscreen anwenden";
const UNDO_CLEANUP = "Split Screener: Aufräumen";
const UNDO_REMOVE = "Split Screener: Splitscreen entfernen";

/** Tolerance below which a rotation / anchor offset counts as "untouched". */
const ROTATION_EPSILON = 0.0001;
const ANCHOR_EPSILON_PIXELS = 0.5;

module.exports = {
    LAYOUT,
    CELL,
    CELL_LABEL,
    TRANSFORM_MATCHNAMES,
    TRANSFORM_MATCHNAME_FRAGMENTS,
    CROP_MATCHNAMES,
    CROP_MATCHNAME_FRAGMENTS,
    MOTION_MATCHNAME_FRAGMENTS,
    INTRINSIC_MATCHNAME_FRAGMENTS,
    VIDEO_INTRINSIC_MATCHNAME_FRAGMENTS,
    CROP_PARAMS,
    CROP_ZOOM_NAMES,
    CROP_MIN_PARAM_COUNT,
    TRANSFORM_POSITION_NAMES,
    TRANSFORM_POSITION_FRAGMENTS,
    TRANSFORM_ANCHOR_NAMES,
    TRANSFORM_ANCHOR_FRAGMENTS,
    MOTION_POSITION_NAMES,
    MOTION_POSITION_FRAGMENTS,
    MOTION_SCALE_NAMES,
    MOTION_SCALE_FRAGMENTS,
    MOTION_SCALE_WIDTH_NAMES,
    MOTION_SCALE_WIDTH_FRAGMENTS,
    MOTION_UNIFORM_SCALE_NAMES,
    MOTION_UNIFORM_SCALE_FRAGMENTS,
    MOTION_ROTATION_NAMES,
    MOTION_ROTATION_FRAGMENTS,
    MOTION_ANCHOR_NAMES,
    MOTION_ANCHOR_FRAGMENTS,
    UNDO_INSERT,
    UNDO_VALUES,
    UNDO_CLEANUP,
    UNDO_REMOVE,
    ROTATION_EPSILON,
    ANCHOR_EPSILON_PIXELS
};
