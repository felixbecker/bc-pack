/**
 * Tests for src/values.js.
 *
 * The six value shapes below are not hypothetical: Premiere returns parameter
 * values in different forms depending on version and parameter type, and the
 * companion plugin in this repository was broken by exactly that. A plugin
 * that fails closed on unreadable values — as this one does — turns a shape it
 * does not recognise into a total refusal to work, so the recogniser has to be
 * generous and well covered.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const values = require("../src/values.js");

// A stand-in for Premiere's PointF: data behind non-enumerable prototype
// getters, which is what breaks naive JSON.stringify / Object.keys.
class HostPointF {
    constructor(x, y) {
        this._x = x;
        this._y = y;
    }
    get x() {
        return this._x;
    }
    get y() {
        return this._y;
    }
    toString() {
        return "[object PointF]";
    }
}

// ---------------------------------------------------------------------------
// The six shapes
// ---------------------------------------------------------------------------

test("a plain point is read", function () {
    assert.deepEqual(values.normalizeReadValue({ x: 0.25, y: 0.5 }), { x: 0.25, y: 0.5 });
});

test("a host point with prototype getters is read", function () {
    assert.deepEqual(values.normalizeReadValue(new HostPointF(480, 540)), {
        x: 480,
        y: 540
    });
});

test("a point wrapped in {value} is read", function () {
    assert.deepEqual(values.normalizeReadValue({ value: { x: 1, y: 2 } }), { x: 1, y: 2 });
});

test("a doubly wrapped point is read", function () {
    assert.deepEqual(values.normalizeReadValue({ value: { value: { x: 3, y: 4 } } }), {
        x: 3,
        y: 4
    });
});

test("a point as a two-element array is read", function () {
    assert.deepEqual(values.normalizeReadValue([7, 8]), { x: 7, y: 8 });
});

test("a wrapped array is read", function () {
    assert.deepEqual(values.normalizeReadValue({ value: [9, 10] }), { x: 9, y: 10 });
});

test("numeric strings are read", function () {
    assert.deepEqual(values.normalizeReadValue({ x: "0.25", y: "0.5" }), {
        x: 0.25,
        y: 0.5
    });
    assert.equal(values.normalizeReadValue("120"), 120);
    assert.equal(values.normalizeReadValue({ value: "50" }), 50);
});

// ---------------------------------------------------------------------------
// Scalars and booleans
// ---------------------------------------------------------------------------

test("numbers and booleans pass through, wrapped or not", function () {
    assert.equal(values.normalizeReadValue(100), 100);
    assert.equal(values.normalizeReadValue({ value: 100 }), 100);
    assert.equal(values.normalizeReadValue(true), true);
    assert.equal(values.normalizeReadValue({ value: false }), false);
});

test("zero and false are not mistaken for missing", function () {
    assert.equal(values.normalizeReadValue(0), 0);
    assert.equal(values.normalizeReadValue({ value: 0 }), 0);
    assert.equal(values.normalizeReadValue(false), false);
});

// ---------------------------------------------------------------------------
// Rejection
// ---------------------------------------------------------------------------

test("unusable values are rejected rather than guessed", function () {
    assert.equal(values.normalizeReadValue(null), null);
    assert.equal(values.normalizeReadValue(undefined), null);
    assert.equal(values.normalizeReadValue({}), null);
    assert.equal(values.normalizeReadValue("keine Zahl"), null);
    assert.equal(values.normalizeReadValue(Number.NaN), null);
    assert.equal(values.normalizeReadValue(Number.POSITIVE_INFINITY), null);
    assert.equal(values.normalizeReadValue({ x: 1 }), null, "halber Punkt ist kein Punkt");
    assert.equal(values.normalizeReadValue([5]), null, "ein Element ist kein Punkt");
    assert.equal(values.normalizeReadValue({ x: Number.NaN, y: 2 }), null);
});

test("a colour as a four-element array is not a point", function () {
    // Otherwise a Color parameter would pass the structural probe in core.js
    // and could stand in for a position.
    assert.equal(values.normalizeReadValue([1, 0, 0, 1]), null);
    assert.equal(values.looksLikePoint([1, 0, 0, 1]), false);
    assert.equal(values.looksLikePoint([1, 0, 0]), false);
    assert.equal(values.looksLikePoint([1, 0]), true);
});

test("checkbox values are read tolerantly but not loosely", function () {
    assert.equal(values.toFlag(true), true);
    assert.equal(values.toFlag(false), false);
    assert.equal(values.toFlag(1), true);
    assert.equal(values.toFlag(0), false);
    assert.equal(values.toFlag(2), null, "2 ist kein Schalter");
    assert.equal(values.toFlag("1"), null, "ein String ist kein Schalter");
    assert.equal(values.toFlag(null), null);
    assert.equal(values.isFlag(0), true);
    assert.equal(values.isFlag(2), false);
});

test("a throwing getter does not escape", function () {
    const hostile = {
        get x() {
            throw new Error("nicht lesbar");
        },
        get y() {
            return 1;
        }
    };
    assert.equal(values.normalizeReadValue(hostile), null);
});

test("unwrapping stops instead of chasing a cycle", function () {
    const cyclic = {};
    cyclic.value = cyclic;
    assert.equal(values.normalizeReadValue(cyclic), null);
});

// ---------------------------------------------------------------------------
// Serialization for diagnostics
// ---------------------------------------------------------------------------

test("safeJson sees prototype getters that JSON.stringify misses", function () {
    const point = new HostPointF(960, 540);
    assert.equal(JSON.stringify(point), '{"_x":960,"_y":540}');

    const json = values.safeJson(point);
    assert.match(json, /"x":960/);
    assert.match(json, /"y":540/);
});

test("safeJson handles the usual primitives", function () {
    assert.equal(values.safeJson(null), "null");
    assert.equal(values.safeJson(undefined), "undefined");
    assert.equal(values.safeJson(42), "42");
    assert.equal(values.safeJson(true), "true");
    assert.equal(values.safeJson("x"), '"x"');
    assert.equal(values.safeJson(Number.NaN), '"NaN"');
});

test("safeJson survives cycles and deep nesting", function () {
    const cyclic = { name: "a" };
    cyclic.self = cyclic;
    const json = values.safeJson(cyclic);
    assert.match(json, /"name":"a"/);
    assert.match(json, /zu tief verschachtelt/);
});

test("safeJson truncates wide objects instead of dumping everything", function () {
    const wide = {};
    for (let i = 0; i < 60; i++) wide["k" + i] = i;
    assert.match(values.safeJson(wide), /abgeschnitten/);
});

test("safeJson skips methods", function () {
    const withMethod = { a: 1, doThing: function () {} };
    const json = values.safeJson(withMethod);
    assert.match(json, /"a":1/);
    assert.ok(json.indexOf("doThing") === -1);
});

test("safeJson renders a parameter dump readably", function () {
    const dump = [
        { index: 0, name: "Links", value: 0, valueType: "number" },
        { index: 1, name: "", value: true, valueType: "boolean" }
    ];
    const json = values.safeJson(dump);
    assert.match(json, /"name":"Links"/);
    assert.match(json, /"value":true/);
});

// ---------------------------------------------------------------------------
// Shape description for error messages
// ---------------------------------------------------------------------------

test("describeShape names the type instead of [object Object]", function () {
    const described = values.describeShape(new HostPointF(1, 2));
    assert.equal(String(new HostPointF(1, 2)), "[object PointF]");
    assert.match(described, /typ=HostPointF/);
    assert.match(described, /x:number=1/);
});

test("describeShape handles primitives, null and arrays", function () {
    assert.equal(values.describeShape(null), "null");
    assert.equal(values.describeShape(undefined), "undefined");
    assert.equal(values.describeShape(5), "number 5");
    assert.equal(values.describeShape("text"), "string text");
    assert.match(values.describeShape([1, 2, 3]), /array\(3\)/);
});

test("describeShape says so when there is nothing to see", function () {
    assert.equal(values.describeShape(Object.create(null)), "leeres Objekt");
});

// ---------------------------------------------------------------------------
// Helpers used by the parameter resolver
// ---------------------------------------------------------------------------

test("valueKind tags what was actually read", function () {
    assert.equal(values.valueKind(1), "number");
    assert.equal(values.valueKind(true), "boolean");
    assert.equal(values.valueKind({ x: 1, y: 2 }), "point");
    assert.equal(values.valueKind(null), "unbrauchbar");
    assert.equal(values.valueKind("text"), "unbrauchbar");
});

test("isNormalizedPoint accepts only finite plain points", function () {
    assert.equal(values.isNormalizedPoint({ x: 1, y: 2 }), true);
    assert.equal(values.isNormalizedPoint({ x: "1", y: "2" }), false);
    assert.equal(values.isNormalizedPoint({ x: Number.NaN, y: 2 }), false);
    assert.equal(values.isNormalizedPoint(null), false);
});

test("toFiniteNumber is strict about what counts as a number", function () {
    assert.equal(values.toFiniteNumber(5), 5);
    assert.equal(values.toFiniteNumber("5.5"), 5.5);
    assert.equal(values.toFiniteNumber(""), null);
    assert.equal(values.toFiniteNumber("  "), null);
    assert.equal(values.toFiniteNumber("abc"), null);
    assert.equal(values.toFiniteNumber(null), null);
    assert.equal(values.toFiniteNumber(true), null, "ein Boolean ist keine Zahl");
});
