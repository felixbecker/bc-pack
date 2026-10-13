const test = require("node:test");
const assert = require("node:assert/strict");
const { referenceTimes } = require("../src/timing.js");
const base = { inPoint: 30, outPoint: 34, start: 100, end: 104, frameDuration: 0.04, speed: 1, reversed: 0 };

test("reference options use visible timeline time mapped to source time", () => {
    assert.equal(referenceTimes({ ...base, timing: "start" }).reference, 30);
    assert.equal(referenceTimes({ ...base, timing: "middle" }).reference, 32);
    assert.equal(referenceTimes({ ...base, timing: "end" }).reference, 33.96);
    assert.equal(referenceTimes({ ...base, timing: "playhead", playhead: 101.24 }).reference, 31.24);
});

test("single-frame clips use their sole visible frame for all references", () => {
    for (const timing of ["start", "middle", "end", "playhead"]) {
        const result = referenceTimes({ ...base, end: 100.04, outPoint: 30.04, timing, playhead: 100 });
        assert.equal(result.reference, 30);
        assert.deepEqual(result.samples, [30]);
    }
});

test("fractional frame rates exclude the exclusive out-point", () => {
    const frame = 1001 / 30000;
    const r = referenceTimes({ ...base, frameDuration: frame, end: 100 + 300 * frame,
        outPoint: 30 + 300 * frame, timing: "end" });
    assert.ok(Math.abs(r.reference - (30 + 299 * frame)) < 1e-10);
    assert.ok(r.samples.every((s) => s >= 30 && s < 30 + 300 * frame));
});

test("mid-frame playhead chooses the displayed frame, outside playhead is not clamped", () => {
    assert.equal(referenceTimes({ ...base, timing: "playhead", playhead: 101.259 }).reference, 31.24);
    for (const playhead of [99, 104, NaN]) {
        assert.throws(() => referenceTimes({ ...base, timing: "playhead", playhead }), /außerhalb/);
    }
});

test("retiming and invalid time ranges are explicit failures", () => {
    for (const patch of [{ speed: 2 }, { reversed: 1 }, { outPoint: 38 }]) {
        assert.throws(() => referenceTimes({ ...base, ...patch }), /Retiming/);
    }
    for (const patch of [{ end: 100 }, { frameDuration: 0 }, { inPoint: NaN }]) {
        assert.throws(() => referenceTimes({ ...base, ...patch }), /Zeitbereich/);
    }
});
