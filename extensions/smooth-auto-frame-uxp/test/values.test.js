const test = require("node:test");
const assert = require("node:assert/strict");
const V = require("../src/values.js");

test("normalizes host getters, wrappers, arrays and numeric strings without changing units", () => {
    class HostPoint { get x() { return "0"; } get y() { return "0.42"; } }
    for (const raw of [new HostPoint(), [0, "0.42"], { value: { value: new HostPoint() } }]) {
        assert.deepEqual(V.normalize(raw), { x: 0, y: 0.42 });
    }
    assert.equal(V.normalize({ value: false }), false);
    assert.equal(V.normalize(0), 0);
});

test("rejects colors, cycles, missing values and nonfinite numbers", () => {
    const cycle = {}; cycle.value = cycle;
    for (const raw of [[1, 2, 3, 4], cycle, { x: NaN, y: 1 }, undefined, null, "", Infinity]) {
        assert.equal(V.normalize(raw), null);
    }
});

test("value comparison detects an incorrect single keyframe", () => {
    assert.equal(V.close({ x: 0.6, y: 0.7 }, { x: 0.9, y: 0.9 }, 1e-6), false);
    assert.equal(V.close({ x: 0, y: 0 }, { x: 0, y: 0 }, 1e-6), true);
});

test("diagnostics include non-enumerable host getters and tolerate throwing getters", () => {
    class Host { get unitType() { return "point"; } get bad() { throw new Error("gone"); } }
    const text = V.describe(new Host());
    assert.match(text, /unitType/);
    assert.match(text, /nicht lesbar/);
});
