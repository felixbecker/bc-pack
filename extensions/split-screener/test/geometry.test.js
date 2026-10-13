/**
 * Tests for src/geometry.js — the placement maths.
 *
 * The important properties are checked twice: once against the hand-derived
 * values from the requirements, and once by simulating Premiere's render
 * pipeline (our Transform, then our Crop, then intrinsic Motion) and asserting
 * that the visible region really is the target cell. The simulation is what
 * catches sign errors that a table of expected values would happily confirm.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const geometry = require("../src/geometry.js");
const { LAYOUT, CELL } = require("../src/constants.js");

const W = 1920;
const H = 1080;

/**
 * Simulates the render pipeline for one clip.
 *
 * The order matters and is the whole point of this helper:
 *
 *   1. our Transform translates the image inside the clip's frame buffer —
 *      anything pushed past the frame edge is discarded there and then
 *   2. our Crop cuts a window out of the frame
 *   3. intrinsic Motion scales about the frame centre and translates the
 *      centre to the Motion position
 *
 * Returns the visible rectangle in final frame coordinates plus the region of
 * the incoming image ("the current look") that ends up being shown.
 */
function simulate(placement, motion) {
    const scaleX = motion && typeof motion.scaleX === "number" ? motion.scaleX : 1;
    const scaleY = motion && typeof motion.scaleY === "number" ? motion.scaleY : 1;
    const position =
        motion && motion.positionPixels ? motion.positionPixels : { x: W / 2, y: H / 2 };

    const shiftX = placement.transformPositionPixels.x - W / 2;
    const shiftY = placement.transformPositionPixels.y - H / 2;

    // 1. Transform, clipped by the frame.
    const imageX0 = Math.max(0, shiftX);
    const imageX1 = Math.min(W, W + shiftX);
    const imageY0 = Math.max(0, shiftY);
    const imageY1 = Math.min(H, H + shiftY);

    // 2. Crop window in frame space.
    const cropX0 = (placement.crop.left / 100) * W;
    const cropX1 = W - (placement.crop.right / 100) * W;
    const cropY0 = (placement.crop.top / 100) * H;
    const cropY1 = H - (placement.crop.bottom / 100) * H;

    const visX0 = Math.max(imageX0, cropX0);
    const visX1 = Math.min(imageX1, cropX1);
    const visY0 = Math.max(imageY0, cropY0);
    const visY1 = Math.min(imageY1, cropY1);

    // 3. Motion.
    const apply = function (vx, vy) {
        return {
            x: scaleX * (vx - W / 2) + position.x,
            y: scaleY * (vy - H / 2) + position.y
        };
    };

    const topLeft = apply(visX0, visY0);
    const bottomRight = apply(visX1, visY1);

    return {
        visible: {
            x0: topLeft.x,
            y0: topLeft.y,
            x1: bottomRight.x,
            y1: bottomRight.y
        },
        // Undoing the Transform shift tells us which part of the incoming
        // image survived.
        source: {
            x0: visX0 - shiftX,
            x1: visX1 - shiftX,
            y0: visY0 - shiftY,
            y1: visY1 - shiftY
        }
    };
}

/**
 * The region of the incoming image that *should* be shown: the centre half of
 * the clip's rendered look, mapped back through Motion into the image's own
 * coordinates. This is the independent check that crop window and Transform
 * offset agree with each other.
 */
function expectedSource(cell, motion) {
    const scaleX = motion && typeof motion.scaleX === "number" ? motion.scaleX : 1;
    const scaleY = motion && typeof motion.scaleY === "number" ? motion.scaleY : 1;
    const position =
        motion && motion.positionPixels ? motion.positionPixels : { x: W / 2, y: H / 2 };

    const horizontal = cell === CELL.LEFT || cell === CELL.RIGHT;
    const strip = horizontal
        ? { x0: W / 4, x1: (3 * W) / 4, y0: 0, y1: H }
        : { x0: 0, x1: W, y0: H / 4, y1: (3 * H) / 4 };

    return {
        x0: W / 2 + (strip.x0 - position.x) / scaleX,
        x1: W / 2 + (strip.x1 - position.x) / scaleX,
        y0: H / 2 + (strip.y0 - position.y) / scaleY,
        y1: H / 2 + (strip.y1 - position.y) / scaleY
    };
}

function assertRect(actual, expected, message) {
    const tolerance = 0.5;
    assert.ok(
        Math.abs(actual.x0 - expected.x0) <= tolerance &&
            Math.abs(actual.x1 - expected.x1) <= tolerance &&
            Math.abs(actual.y0 - expected.y0) <= tolerance &&
            Math.abs(actual.y1 - expected.y1) <= tolerance,
        message +
            "\n  erwartet: " +
            JSON.stringify(expected) +
            "\n  bekommen: " +
            JSON.stringify(actual)
    );
}

// ---------------------------------------------------------------------------
// Layout and cell basics
// ---------------------------------------------------------------------------

test("cellsForLayout maps lower track to left / top", function () {
    assert.deepEqual(geometry.cellsForLayout(LAYOUT.COLUMNS, false), [
        CELL.LEFT,
        CELL.RIGHT
    ]);
    assert.deepEqual(geometry.cellsForLayout(LAYOUT.ROWS, false), [CELL.TOP, CELL.BOTTOM]);
});

test("cellsForLayout swaps both axes on request", function () {
    assert.deepEqual(geometry.cellsForLayout(LAYOUT.COLUMNS, true), [
        CELL.RIGHT,
        CELL.LEFT
    ]);
    assert.deepEqual(geometry.cellsForLayout(LAYOUT.ROWS, true), [CELL.BOTTOM, CELL.TOP]);
});

test("cellsForLayout rejects an unknown layout", function () {
    assert.throws(function () {
        geometry.cellsForLayout("diagonal", false);
    });
});

test("cellRect covers exactly half the frame", function () {
    assert.deepEqual(geometry.cellRect(CELL.LEFT, W, H), {
        x0: 0,
        x1: 960,
        y0: 0,
        y1: 1080
    });
    assert.deepEqual(geometry.cellRect(CELL.BOTTOM, W, H), {
        x0: 0,
        x1: 1920,
        y0: 540,
        y1: 1080
    });
});

// ---------------------------------------------------------------------------
// The documented default case
// ---------------------------------------------------------------------------

test("default Motion yields the values from the requirements table", function () {
    const cases = [
        { cell: CELL.LEFT, position: { x: 480, y: 540 }, crop: { left: 0, top: 0, right: 50, bottom: 0 } },
        { cell: CELL.RIGHT, position: { x: 1440, y: 540 }, crop: { left: 50, top: 0, right: 0, bottom: 0 } },
        { cell: CELL.TOP, position: { x: 960, y: 270 }, crop: { left: 0, top: 0, right: 0, bottom: 50 } },
        { cell: CELL.BOTTOM, position: { x: 960, y: 810 }, crop: { left: 0, top: 50, right: 0, bottom: 0 } }
    ];

    for (const entry of cases) {
        const placement = geometry.computePlacement({
            cell: entry.cell,
            sequenceWidth: W,
            sequenceHeight: H
        });
        assert.deepEqual(
            placement.transformPositionPixels,
            entry.position,
            "Transform-Position für " + entry.cell
        );
        assert.deepEqual(placement.crop, entry.crop, "Crop für " + entry.cell);
        assert.deepEqual(placement.warnings, [], "keine Warnung für " + entry.cell);
    }
});

test("default Motion fills exactly the target cell", function () {
    const cells = [CELL.LEFT, CELL.RIGHT, CELL.TOP, CELL.BOTTOM];
    for (const cell of cells) {
        const placement = geometry.computePlacement({
            cell: cell,
            sequenceWidth: W,
            sequenceHeight: H
        });
        const rendered = simulate(placement, null);
        assertRect(
            rendered.visible,
            geometry.cellRect(cell, W, H),
            "sichtbarer Bereich für " + cell
        );
        assertRect(
            rendered.source,
            expectedSource(cell, null),
            "gezeigter Bildausschnitt für " + cell
        );
    }
});

test("the centre of the image is what ends up in the cell", function () {
    // Spelled out for the columns case: the middle 50 % of the image, full
    // height — not the left or right edge.
    const placement = geometry.computePlacement({
        cell: CELL.LEFT,
        sequenceWidth: W,
        sequenceHeight: H
    });
    assertRect(
        simulate(placement, null).source,
        { x0: 480, x1: 1440, y0: 0, y1: 1080 },
        "linke Zelle zeigt den mittleren Streifen"
    );
});

// ---------------------------------------------------------------------------
// Motion compensation
// ---------------------------------------------------------------------------

test("a 120 % punch-in is compensated to the documented values", function () {
    const placement = geometry.computePlacement({
        cell: CELL.LEFT,
        sequenceWidth: W,
        sequenceHeight: H,
        motion: { scaleX: 1.2, scaleY: 1.2, positionPixels: { x: 960, y: 540 } }
    });

    assert.equal(geometry.round4(placement.transformPositionPixels.x), 560);
    assert.equal(placement.transformPositionPixels.y, 540);
    assert.ok(Math.abs(placement.crop.left - 8.3333) < 0.001, "Crop Links ≈ 8,33 %");
    assert.equal(placement.crop.right, 50);
    assert.ok(Math.abs(placement.crop.top - 8.3333) < 0.001, "Crop Oben ≈ 8,33 %");
    assert.ok(Math.abs(placement.crop.bottom - 8.3333) < 0.001, "Crop Unten ≈ 8,33 %");
});

test("compensation holds for a range of scales and offsets", function () {
    const motions = [
        { scaleX: 1, scaleY: 1, positionPixels: { x: 960, y: 540 } },
        { scaleX: 1.2, scaleY: 1.2, positionPixels: { x: 960, y: 540 } },
        { scaleX: 2, scaleY: 2, positionPixels: { x: 960, y: 540 } },
        { scaleX: 1.5, scaleY: 1.5, positionPixels: { x: 1100, y: 600 } },
        { scaleX: 1.4, scaleY: 1.1, positionPixels: { x: 900, y: 500 } },
        { scaleX: 3, scaleY: 3, positionPixels: { x: 700, y: 400 } }
    ];
    const cells = [CELL.LEFT, CELL.RIGHT, CELL.TOP, CELL.BOTTOM];

    for (const motion of motions) {
        for (const cell of cells) {
            const placement = geometry.computePlacement({
                cell: cell,
                sequenceWidth: W,
                sequenceHeight: H,
                motion: motion
            });
            if (placement.warnings.length) continue; // clamped: covered separately
            const rendered = simulate(placement, motion);
            const label = "Zelle " + cell + " bei Motion " + JSON.stringify(motion);
            assertRect(rendered.visible, geometry.cellRect(cell, W, H), label);
            assertRect(
                rendered.source,
                expectedSource(cell, motion),
                "Bildausschnitt — " + label
            );
        }
    }
});

test("non-uniform Motion scale is compensated per axis", function () {
    const motion = { scaleX: 1.6, scaleY: 1.2, positionPixels: { x: 960, y: 540 } };
    const placement = geometry.computePlacement({
        cell: CELL.RIGHT,
        sequenceWidth: W,
        sequenceHeight: H,
        motion: motion
    });
    const rendered = simulate(placement, motion);
    assertRect(
        rendered.visible,
        geometry.cellRect(CELL.RIGHT, W, H),
        "rechte Zelle bei getrennten Achsenskalierungen"
    );
    assertRect(
        rendered.source,
        expectedSource(CELL.RIGHT, motion),
        "Bildausschnitt bei getrennten Achsenskalierungen"
    );
});

test("computePlacement reports the visible region it predicts", function () {
    // geometry.js computes the coverage itself in order to raise warnings;
    // this makes sure its own prediction matches the independent simulation.
    const motions = [
        null,
        { scaleX: 1.2, scaleY: 1.2, positionPixels: { x: 960, y: 540 } },
        { scaleX: 0.8, scaleY: 0.8, positionPixels: { x: 960, y: 540 } },
        { scaleX: 1, scaleY: 1, positionPixels: { x: 1300, y: 540 } }
    ];
    for (const motion of motions) {
        for (const cell of [CELL.LEFT, CELL.RIGHT, CELL.TOP, CELL.BOTTOM]) {
            const placement = geometry.computePlacement({
                cell: cell,
                sequenceWidth: W,
                sequenceHeight: H,
                motion: motion
            });
            assertRect(
                simulate(placement, motion).visible,
                placement.visibleFinal,
                "Vorhersage für " + cell + " bei " + JSON.stringify(motion)
            );
        }
    }
});

test("the Transform offset ignores the Motion position", function () {
    const centred = geometry.computePlacement({
        cell: CELL.LEFT,
        sequenceWidth: W,
        sequenceHeight: H,
        motion: { scaleX: 1.3, scaleY: 1.3, positionPixels: { x: 960, y: 540 } }
    });
    const shifted = geometry.computePlacement({
        cell: CELL.LEFT,
        sequenceWidth: W,
        sequenceHeight: H,
        motion: { scaleX: 1.3, scaleY: 1.3, positionPixels: { x: 1300, y: 200 } }
    });
    assert.deepEqual(centred.transformPositionPixels, shifted.transformPositionPixels);
});

// ---------------------------------------------------------------------------
// Clamping and warnings
// ---------------------------------------------------------------------------

test("a clip scaled below 100 % is reported as not filling its cell", function () {
    const placement = geometry.computePlacement({
        cell: CELL.LEFT,
        sequenceWidth: W,
        sequenceHeight: H,
        motion: { scaleX: 0.5, scaleY: 0.5, positionPixels: { x: 960, y: 540 } }
    });
    assert.deepEqual(placement.warnings, [geometry.WARNING.CELL_NOT_FILLED]);
    assert.equal(placement.crop.left, 0, "negative Crop-Werte werden auf 0 begrenzt");
    assert.ok(placement.cropRaw.left < 0, "der ungeklemmte Wert bleibt sichtbar");
});

test("a clip shifted out of its half is reported as not filling it", function () {
    const placement = geometry.computePlacement({
        cell: CELL.LEFT,
        sequenceWidth: W,
        sequenceHeight: H,
        motion: { scaleX: 1, scaleY: 1, positionPixels: { x: 1500, y: 540 } }
    });
    assert.deepEqual(placement.warnings, [geometry.WARNING.CELL_NOT_FILLED]);
});

test("an extreme downscale is reported as empty, not as merely unfilled", function () {
    // Our Transform has to shift by ¼ frame ÷ scale, which at very small
    // scales pushes the whole image out of the frame before Motion can scale
    // it back. That is unfixable from where we sit, so it must be reported.
    const placement = geometry.computePlacement({
        cell: CELL.LEFT,
        sequenceWidth: W,
        sequenceHeight: H,
        motion: { scaleX: 0.2, scaleY: 0.2, positionPixels: { x: 960, y: 540 } }
    });
    assert.deepEqual(placement.warnings, [geometry.WARNING.CELL_EMPTY]);
});

test("just above the threshold it is unfilled rather than empty", function () {
    const placement = geometry.computePlacement({
        cell: CELL.LEFT,
        sequenceWidth: W,
        sequenceHeight: H,
        motion: { scaleX: 0.3, scaleY: 0.3, positionPixels: { x: 960, y: 540 } }
    });
    assert.deepEqual(placement.warnings, [geometry.WARNING.CELL_NOT_FILLED]);
    assert.ok(
        simulate(placement, { scaleX: 0.3, scaleY: 0.3, positionPixels: { x: 960, y: 540 } })
            .visible.x1 > 0,
        "es ist noch etwas zu sehen"
    );
});

test("the full-frame case raises no warning at all", function () {
    for (const cell of [CELL.LEFT, CELL.RIGHT, CELL.TOP, CELL.BOTTOM]) {
        const placement = geometry.computePlacement({
            cell: cell,
            sequenceWidth: W,
            sequenceHeight: H,
            motion: { scaleX: 1, scaleY: 1, positionPixels: { x: 960, y: 540 } }
        });
        assert.deepEqual(placement.warnings, [], "keine Warnung für " + cell);
    }
});

test("crop values never leave the valid range", function () {
    const motions = [
        { scaleX: 0.1, scaleY: 0.1, positionPixels: { x: 0, y: 0 } },
        { scaleX: 5, scaleY: 5, positionPixels: { x: 1920, y: 1080 } },
        { scaleX: 1, scaleY: 1, positionPixels: { x: -500, y: 2000 } }
    ];
    for (const motion of motions) {
        for (const cell of [CELL.LEFT, CELL.RIGHT, CELL.TOP, CELL.BOTTOM]) {
            const placement = geometry.computePlacement({
                cell: cell,
                sequenceWidth: W,
                sequenceHeight: H,
                motion: motion
            });
            const keys = ["left", "top", "right", "bottom"];
            for (const key of keys) {
                assert.ok(
                    placement.crop[key] >= 0 && placement.crop[key] <= 100,
                    "Crop " + key + " im Bereich 0‥100"
                );
            }
            assert.ok(
                placement.crop.left + placement.crop.right <= 100.0001,
                "Links + Rechts überschneiden sich nicht"
            );
            assert.ok(
                placement.crop.top + placement.crop.bottom <= 100.0001,
                "Oben + Unten überschneiden sich nicht"
            );
        }
    }
});

test("the two halves of a pair never overlap", function () {
    const motionA = { scaleX: 1, scaleY: 1, positionPixels: { x: 960, y: 540 } };
    const motionB = { scaleX: 1.8, scaleY: 1.8, positionPixels: { x: 960, y: 540 } };

    const left = geometry.computePlacement({
        cell: CELL.LEFT,
        sequenceWidth: W,
        sequenceHeight: H,
        motion: motionA
    });
    const right = geometry.computePlacement({
        cell: CELL.RIGHT,
        sequenceWidth: W,
        sequenceHeight: H,
        motion: motionB
    });

    const visibleLeft = simulate(left, motionA).visible;
    const visibleRight = simulate(right, motionB).visible;

    assert.ok(
        visibleLeft.x1 <= visibleRight.x0 + 0.5,
        "linke Hälfte endet dort, wo die rechte beginnt"
    );
    assert.ok(
        visibleLeft.x1 >= visibleRight.x0 - 0.5,
        "zwischen den Hälften bleibt keine Lücke"
    );
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test("invalid sequence sizes are rejected", function () {
    assert.throws(function () {
        geometry.computePlacement({ cell: CELL.LEFT, sequenceWidth: 0, sequenceHeight: H });
    });
    assert.throws(function () {
        geometry.computePlacement({
            cell: CELL.LEFT,
            sequenceWidth: W,
            sequenceHeight: Number.NaN
        });
    });
});

test("a zero or negative Motion scale is rejected", function () {
    assert.throws(function () {
        geometry.computePlacement({
            cell: CELL.LEFT,
            sequenceWidth: W,
            sequenceHeight: H,
            motion: { scaleX: 0, scaleY: 1 }
        });
    });
    assert.throws(function () {
        geometry.computePlacement({
            cell: CELL.LEFT,
            sequenceWidth: W,
            sequenceHeight: H,
            motion: { scaleX: 1, scaleY: -2 }
        });
    });
});

test("an unknown cell is rejected", function () {
    assert.throws(function () {
        geometry.computePlacement({
            cell: "middle",
            sequenceWidth: W,
            sequenceHeight: H
        });
    });
});

// ---------------------------------------------------------------------------
// Unit detection
// ---------------------------------------------------------------------------

test("scale convention is detected from the magnitude", function () {
    assert.equal(geometry.detectScaleConvention(100), geometry.SCALE_CONVENTION.PERCENT);
    assert.equal(geometry.detectScaleConvention(120), geometry.SCALE_CONVENTION.PERCENT);
    assert.equal(geometry.detectScaleConvention(1), geometry.SCALE_CONVENTION.FRACTION);
    assert.equal(geometry.detectScaleConvention(1.2), geometry.SCALE_CONVENTION.FRACTION);
});

test("toScaleFactor normalizes both conventions", function () {
    assert.equal(geometry.toScaleFactor(100), 1);
    assert.equal(geometry.toScaleFactor(120), 1.2);
    assert.equal(geometry.toScaleFactor(1), 1);
    assert.equal(geometry.toScaleFactor(1.2), 1.2);
    assert.equal(geometry.toScaleFactor(undefined), 1, "fehlender Wert heißt 100 %");
});

test("position unit is detected from the magnitude", function () {
    assert.equal(
        geometry.detectPositionUnit({ x: 0.5, y: 0.5 }, W, H),
        geometry.POSITION_UNIT.NORMALIZED
    );
    assert.equal(
        geometry.detectPositionUnit({ x: 960, y: 540 }, W, H),
        geometry.POSITION_UNIT.PIXELS
    );
    assert.equal(
        geometry.detectPositionUnit({ x: 5, y: 540 }, W, H),
        geometry.POSITION_UNIT.PIXELS,
        "ein großer Anteil genügt für Pixel"
    );
});

test("position conversion round-trips in both units", function () {
    const pixels = { x: 480, y: 540 };
    const asNormalized = geometry.fromPixelPosition(
        pixels,
        geometry.POSITION_UNIT.NORMALIZED,
        W,
        H
    );
    assert.deepEqual(asNormalized, { x: 0.25, y: 0.5 });
    assert.deepEqual(geometry.toPixelPosition(asNormalized, W, H), pixels);

    const asPixels = geometry.fromPixelPosition(
        pixels,
        geometry.POSITION_UNIT.PIXELS,
        W,
        H
    );
    assert.deepEqual(asPixels, pixels);
    assert.deepEqual(geometry.toPixelPosition(asPixels, W, H), pixels);
});

test("a missing position falls back to the frame centre", function () {
    assert.deepEqual(geometry.toPixelPosition(null, W, H), { x: 960, y: 540 });
});

// ---------------------------------------------------------------------------
// Portrait sequences
// ---------------------------------------------------------------------------

test("a vertical sequence works the same way", function () {
    const pw = 1080;
    const ph = 1920;
    const placement = geometry.computePlacement({
        cell: CELL.TOP,
        sequenceWidth: pw,
        sequenceHeight: ph
    });
    assert.deepEqual(placement.transformPositionPixels, { x: 540, y: 480 });
    assert.deepEqual(placement.crop, { left: 0, top: 0, right: 0, bottom: 50 });
});
