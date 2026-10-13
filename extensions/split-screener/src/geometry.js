/**
 * Split Screener — src/geometry.js
 *
 * Pure geometry. No Premiere API, no I/O — everything in here is a plain
 * function over numbers so it can be unit tested in Node.
 *
 * THE MODEL
 * ---------
 * Premiere renders a clip as
 *
 *     [ standard effects ]  →  [ intrinsic Motion ]  →  frame
 *
 * We append two standard effects at the very end of the standard chain:
 *
 *     ... user effects (Auto Reframe, Lumetri, a foreign Crop, …)
 *         → our Transform   (moves the image into its half)
 *         → our Crop        (cuts the half out)
 *         → intrinsic Motion
 *
 * Because we sit behind every user effect, whatever the user built is simply
 * "the current look" to us, and we halve that. This is why Auto Reframe needs
 * no special case: its output *is* the current look.
 *
 * Motion, however, runs *after* us and would displace our carefully placed
 * half. Motion is an affine map (uniform-ish scale about the frame centre plus
 * a translation to the Motion position):
 *
 *     M(v) = m · (v − c) + p          c = frame centre, p = Motion position
 *
 * We want the net result to be "the current look, translated by d", where d is
 * ±¼ frame width (or height). Inserting our Transform T before Motion gives
 * M(T(v)), so we need
 *
 *     M ∘ T = Translate(d) ∘ M   ⟺   T = Translate(d / m)
 *
 * which is why the Transform offset is divided by the Motion scale and why the
 * Motion *position* does not appear in it at all. The Crop window, on the
 * other hand, has to be mapped back through M, so there the position does
 * appear:
 *
 *     W = c + (cell − p) / m
 *
 * Both reduce to the trivial values (offset ±¼, crop 50 % on one side) when
 * Motion is untouched, which is the overwhelmingly common case.
 *
 * UNIT DETECTION
 * --------------
 * Adobe's documentation does not state whether Motion position arrives as
 * normalized 0‥1 coordinates or as pixels, nor whether percentage-style
 * parameters are 0‥1 or 0‥100. Rather than hard-coding a guess, both are
 * detected from the values the host actually hands us — see
 * `detectPositionUnit` and `detectScaleConvention`.
 */

const { LAYOUT, CELL } = require("./constants.js");

const SCALE_CONVENTION = {
    /** 100 means "original size" (what Premiere's UI shows). */
    PERCENT: "percent",
    /** 1.0 means "original size". */
    FRACTION: "fraction"
};

const POSITION_UNIT = {
    PIXELS: "pixels",
    NORMALIZED: "normalized"
};

const WARNING = {
    /**
     * The clip does not provide enough image to fill its half — it is scaled
     * below 100 % or shifted so far that part of the cell stays empty.
     */
    CELL_NOT_FILLED: "cell-not-filled",
    /**
     * Nothing at all would be visible. Happens for heavily downscaled clips:
     * our Transform runs *before* Motion, so it has to shift the image by
     * ¼ frame ÷ scale, and below roughly 25 % scale that pushes the whole
     * image out of the frame, where it is discarded before Motion could scale
     * it back down.
     */
    CELL_EMPTY: "cell-empty"
};

/** Values below this are treated as "fraction convention" rather than percent. */
const CONVENTION_THRESHOLD = 2;

/** Sub-pixel deviation accepted when checking whether a cell is fully covered. */
const COVERAGE_EPSILON_PIXELS = 0.5;

function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

/** Rounds to 4 decimals to keep float noise out of written values and reports. */
function round4(value) {
    return Math.round(value * 10000) / 10000;
}

function isFiniteNumber(value) {
    return typeof value === "number" && isFinite(value);
}

function isPoint(value) {
    return (
        value !== null &&
        typeof value === "object" &&
        isFiniteNumber(value.x) &&
        isFiniteNumber(value.y)
    );
}

/**
 * The two cells of a layout, in track order: the clip on the lower video track
 * gets the first entry.
 *
 * @param {string} layout one of LAYOUT
 * @param {boolean} swap  user asked to swap the two clips
 * @returns {string[]} two CELL values
 */
function cellsForLayout(layout, swap) {
    let cells;
    if (layout === LAYOUT.ROWS) {
        cells = [CELL.TOP, CELL.BOTTOM];
    } else if (layout === LAYOUT.COLUMNS) {
        cells = [CELL.LEFT, CELL.RIGHT];
    } else {
        throw new Error('Unbekanntes Layout: "' + String(layout) + '".');
    }
    return swap ? [cells[1], cells[0]] : cells;
}

/**
 * The rectangle a cell occupies in the final frame, in pixels.
 * Origin is the top left corner.
 */
function cellRect(cell, width, height) {
    const halfW = width / 2;
    const halfH = height / 2;
    switch (cell) {
        case CELL.LEFT:
            return { x0: 0, x1: halfW, y0: 0, y1: height };
        case CELL.RIGHT:
            return { x0: halfW, x1: width, y0: 0, y1: height };
        case CELL.TOP:
            return { x0: 0, x1: width, y0: 0, y1: halfH };
        case CELL.BOTTOM:
            return { x0: 0, x1: width, y0: halfH, y1: height };
        default:
            throw new Error('Unbekannte Zelle: "' + String(cell) + '".');
    }
}

/**
 * How far the frame centre has to move so that the centre of the image lands
 * in the centre of its cell — before any Motion compensation.
 */
function standardOffset(cell, width, height) {
    const quarterW = width / 4;
    const quarterH = height / 4;
    switch (cell) {
        case CELL.LEFT:
            return { dx: -quarterW, dy: 0 };
        case CELL.RIGHT:
            return { dx: quarterW, dy: 0 };
        case CELL.TOP:
            return { dx: 0, dy: -quarterH };
        case CELL.BOTTOM:
            return { dx: 0, dy: quarterH };
        default:
            throw new Error('Unbekannte Zelle: "' + String(cell) + '".');
    }
}

/**
 * Decides whether the host reports scale-like values as 0‥100 or as 0‥1.
 *
 * A clip at its original size reads as either 100 or 1.0, and no sane clip is
 * scaled to 2 % — so a value above the threshold can only be the percent
 * convention. Documented limitation: a clip genuinely scaled to ≤ 2 % would be
 * misread. That is accepted.
 */
function detectScaleConvention(rawScale) {
    if (!isFiniteNumber(rawScale)) return SCALE_CONVENTION.PERCENT;
    return Math.abs(rawScale) > CONVENTION_THRESHOLD
        ? SCALE_CONVENTION.PERCENT
        : SCALE_CONVENTION.FRACTION;
}

/** Converts a raw scale reading into a plain factor (1.0 = original size). */
function toScaleFactor(rawScale) {
    if (!isFiniteNumber(rawScale)) return 1;
    return detectScaleConvention(rawScale) === SCALE_CONVENTION.PERCENT
        ? rawScale / 100
        : rawScale;
}

/**
 * Decides whether a point parameter is normalized (0‥1 of the frame) or in
 * pixels. A centred position reads as (0.5, 0.5) or as (width/2, height/2);
 * for any realistic frame size those ranges do not overlap.
 */
function detectPositionUnit(point, width, height) {
    if (!isPoint(point)) return POSITION_UNIT.NORMALIZED;
    const limit = Math.max(4, Math.min(width, height) * 0.01);
    return Math.abs(point.x) <= limit && Math.abs(point.y) <= limit
        ? POSITION_UNIT.NORMALIZED
        : POSITION_UNIT.PIXELS;
}

/** Normalizes a point parameter to pixels, whichever unit it arrived in. */
function toPixelPosition(point, width, height) {
    if (!isPoint(point)) return { x: width / 2, y: height / 2 };
    if (detectPositionUnit(point, width, height) === POSITION_UNIT.PIXELS) {
        return { x: point.x, y: point.y };
    }
    return { x: point.x * width, y: point.y * height };
}

/** Converts pixels back into the unit the host expects for writing. */
function fromPixelPosition(pixels, unit, width, height) {
    if (unit === POSITION_UNIT.PIXELS) {
        return { x: pixels.x, y: pixels.y };
    }
    return { x: pixels.x / width, y: pixels.y / height };
}

/**
 * The heart of the plugin: computes the values for our Transform and our Crop.
 *
 * @param {Object} input
 * @param {string} input.cell            one of CELL
 * @param {number} input.sequenceWidth   frame width in pixels
 * @param {number} input.sequenceHeight  frame height in pixels
 * @param {Object} [input.motion]        intrinsic Motion state of the clip
 * @param {{x: number, y: number}} [input.motion.positionPixels]
 *        Motion position in pixels; defaults to the frame centre
 * @param {number} [input.motion.scaleX] Motion horizontal scale factor (1 = 100 %)
 * @param {number} [input.motion.scaleY] Motion vertical scale factor
 * @returns {{
 *   cell: string,
 *   transformPositionPixels: {x: number, y: number},
 *   crop: {left: number, top: number, right: number, bottom: number},
 *   cropRaw: {left: number, top: number, right: number, bottom: number},
 *   cellRect: {x0: number, x1: number, y0: number, y1: number},
 *   visibleFinal: {x0: number, x1: number, y0: number, y1: number},
 *   warnings: string[]
 * }} crop values are percentages (0‥100); `cropRaw` keeps the unclamped
 *    figures, `visibleFinal` is the region predicted to end up on screen
 */
function computePlacement(input) {
    const width = input && input.sequenceWidth;
    const height = input && input.sequenceHeight;

    if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) {
        throw new Error("Ungültige Sequenzgröße.");
    }

    const motion = (input && input.motion) || {};
    const scaleX = isFiniteNumber(motion.scaleX) ? motion.scaleX : 1;
    const scaleY = isFiniteNumber(motion.scaleY) ? motion.scaleY : 1;

    if (scaleX <= 0 || scaleY <= 0) {
        throw new Error("Motion-Skalierung ist 0 oder negativ — nicht kompensierbar.");
    }

    const position = isPoint(motion.positionPixels)
        ? motion.positionPixels
        : { x: width / 2, y: height / 2 };

    const rect = cellRect(input.cell, width, height);
    const offset = standardOffset(input.cell, width, height);
    const centreX = width / 2;
    const centreY = height / 2;

    // Transform: the standard offset, pre-divided by the Motion scale so that
    // Motion's own scaling turns it back into exactly the standard offset.
    const transformPositionPixels = {
        x: round4(centreX + offset.dx / scaleX),
        y: round4(centreY + offset.dy / scaleY)
    };

    // Crop: map the target cell back through Motion into pre-Motion frame space.
    const windowXMin = centreX + (rect.x0 - position.x) / scaleX;
    const windowXMax = centreX + (rect.x1 - position.x) / scaleX;
    const windowYMin = centreY + (rect.y0 - position.y) / scaleY;
    const windowYMax = centreY + (rect.y1 - position.y) / scaleY;

    const cropRaw = {
        left: (windowXMin / width) * 100,
        right: (1 - windowXMax / width) * 100,
        top: (windowYMin / height) * 100,
        bottom: (1 - windowYMax / height) * 100
    };

    const crop = {
        left: round4(clamp(cropRaw.left, 0, 100)),
        top: round4(clamp(cropRaw.top, 0, 100)),
        right: round4(clamp(cropRaw.right, 0, 100)),
        bottom: round4(clamp(cropRaw.bottom, 0, 100))
    };

    // What will actually be visible. Two things can eat into the target cell:
    //
    //  - Crop cannot be negative, so a window reaching outside the frame gets
    //    clamped and the cell stays partly empty.
    //  - Our Transform shifts the image inside the clip's own frame buffer, so
    //    whatever it pushes past the frame edge is discarded right there —
    //    before Motion gets a chance to scale it back inside.
    //
    // Both are consequences of having to sit in front of Motion, and both are
    // reported rather than silently accepted.
    const shiftX = transformPositionPixels.x - centreX;
    const shiftY = transformPositionPixels.y - centreY;

    const imageX0 = Math.max(0, shiftX);
    const imageX1 = Math.min(width, width + shiftX);
    const imageY0 = Math.max(0, shiftY);
    const imageY1 = Math.min(height, height + shiftY);

    const windowX0 = (crop.left / 100) * width;
    const windowX1 = width - (crop.right / 100) * width;
    const windowY0 = (crop.top / 100) * height;
    const windowY1 = height - (crop.bottom / 100) * height;

    const visibleX0 = Math.max(imageX0, windowX0);
    const visibleX1 = Math.min(imageX1, windowX1);
    const visibleY0 = Math.max(imageY0, windowY0);
    const visibleY1 = Math.min(imageY1, windowY1);

    const warnings = [];

    if (visibleX1 - visibleX0 <= 0 || visibleY1 - visibleY0 <= 0) {
        warnings.push(WARNING.CELL_EMPTY);
    }

    const visibleFinal = {
        x0: round4(scaleX * (visibleX0 - centreX) + position.x),
        x1: round4(scaleX * (visibleX1 - centreX) + position.x),
        y0: round4(scaleY * (visibleY0 - centreY) + position.y),
        y1: round4(scaleY * (visibleY1 - centreY) + position.y)
    };

    if (
        warnings.length === 0 &&
        (!nearlyEqual(visibleFinal.x0, rect.x0, COVERAGE_EPSILON_PIXELS) ||
            !nearlyEqual(visibleFinal.x1, rect.x1, COVERAGE_EPSILON_PIXELS) ||
            !nearlyEqual(visibleFinal.y0, rect.y0, COVERAGE_EPSILON_PIXELS) ||
            !nearlyEqual(visibleFinal.y1, rect.y1, COVERAGE_EPSILON_PIXELS))
    ) {
        warnings.push(WARNING.CELL_NOT_FILLED);
    }

    return {
        cell: input.cell,
        transformPositionPixels: transformPositionPixels,
        crop: crop,
        cropRaw: {
            left: round4(cropRaw.left),
            top: round4(cropRaw.top),
            right: round4(cropRaw.right),
            bottom: round4(cropRaw.bottom)
        },
        cellRect: rect,
        visibleFinal: visibleFinal,
        warnings: warnings
    };
}

/**
 * True when two numbers are equal within tolerance. Used to verify what was
 * actually written back into the project.
 */
function nearlyEqual(a, b, epsilon) {
    const tolerance = isFiniteNumber(epsilon) ? epsilon : 0.01;
    if (!isFiniteNumber(a) || !isFiniteNumber(b)) return false;
    return Math.abs(a - b) <= tolerance;
}

module.exports = {
    SCALE_CONVENTION,
    POSITION_UNIT,
    WARNING,
    clamp,
    round4,
    isPoint,
    cellsForLayout,
    cellRect,
    standardOffset,
    detectScaleConvention,
    toScaleFactor,
    detectPositionUnit,
    toPixelPosition,
    fromPixelPosition,
    computePlacement,
    nearlyEqual
};
