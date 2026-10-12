/*
 * Regression tests for src/core.js.
 *
 * Premiere cannot be driven from CI, so this harness mocks the `premierepro`
 * UXP module (TickTime, PointF, Project/Sequence/TrackItem/Component chain)
 * and records every Action the algorithm queues. That makes the real decision
 * logic testable: which value is read, at which time, what gets written, and
 * that nothing is written during a dry run.
 *
 * No test framework required — plain node:assert.
 *   node test/core.test.js
 */
const Module = require("module");
const path = require("path");
const assert = require("assert");

const PLUGIN_DIR = path.resolve(__dirname, "..");

// ---- Mock Premiere API -----------------------------------------------------

class TickTime {
    constructor(ticks) { this._t = ticks; }
    get ticksNumber() { return this._t; }
    get ticks() { return String(this._t); }
    get seconds() { return this._t / 254016000000; }
    add(o) { return new TickTime(this._t + o.ticksNumber); }
    subtract(o) { return new TickTime(this._t - o.ticksNumber); }
    divide(d) { return new TickTime(Math.floor(this._t / d)); }
    static createWithSeconds(s) { return new TickTime(Math.round(s * 254016000000)); }
}
class PointF {
    constructor(x, y) { this.x = x; this.y = y; }
}

const log = [];

class MockParam {
    constructor(name, keyframes, staticValue, timeVarying) {
        this.displayName = name;
        this._keys = keyframes || [];       // [{t: ticks, v: value}]
        this._static = staticValue;
        this._tv = !!timeVarying;
    }
    isTimeVarying() { return this._tv; }
    async areKeyframesSupported() { return true; }
    getKeyframeListAsTickTimes() {
        if (!this._tv) return [];
        return this._keys.map((k) => new TickTime(k.t));
    }
    async getValueAtTime(time) {
        if (!this._tv) return this._static;
        const hit = this._keys.find((k) => k.t === time.ticksNumber);
        return hit ? hit.v : this._keys[0].v;
    }
    createKeyframe(v) { return { value: v, position: null }; }
    createSetTimeVaryingAction(b) { return { kind: "setTimeVarying", param: this.displayName, value: b }; }
    createSetValueAction(kf, safe) { return { kind: "setValue", param: this.displayName, value: kf.value, safe: safe }; }
    createAddKeyframeAction(kf) { return { kind: "addKeyframe", param: this.displayName, value: kf.value, position: kf.position && kf.position.ticksNumber }; }
    createRemoveKeyframeRangeAction(a, b, updateUI) { return { kind: "removeRange", param: this.displayName, from: a.ticksNumber, to: b.ticksNumber, updateUI: updateUI }; }
    createSetInterpolationAtKeyframeAction(t, mode) { return { kind: "setInterp", param: this.displayName, at: t.ticksNumber, mode: mode }; }
}

class MockComponent {
    constructor(matchName, displayName, params) {
        this._m = matchName; this._d = displayName; this._p = params;
    }
    async getMatchName() { return this._m; }
    async getDisplayName() { return this._d; }
    getParamCount() { return this._p.length; }
    getParam(i) { return this._p[i]; }
}

class MockChain {
    constructor(components) { this._c = components; }
    getComponentCount() { return this._c.length; }
    getComponentAtIndex(i) { return this._c[i]; }
}

class MockTrackItem {
    constructor(name, chain, inTicks, outTicks, startTicks) {
        this._n = name; this._chain = chain;
        this._in = inTicks; this._out = outTicks; this._start = startTicks;
        this.chainFetchCount = 0;
    }
    async getName() { return this._n; }
    async getComponentChain() { this.chainFetchCount++; return this._chain; }
    async getInPoint() { return new TickTime(this._in); }
    async getOutPoint() { return new TickTime(this._out); }
    async getStartTime() { return new TickTime(this._start); }
}

function makeProject(sequence) {
    return {
        async getActiveSequence() { return sequence; },
        lockedAccess(cb) { log.push({ kind: "LOCK_ENTER" }); cb(); log.push({ kind: "LOCK_EXIT" }); },
        executeTransaction(cb, undoString) {
            log.push({ kind: "TX_BEGIN", undoString });
            cb({ addAction: (a) => log.push(a) });
            log.push({ kind: "TX_COMMIT" });
            return true;
        }
    };
}

let currentProject = null;
const pproMock = {
    PointF,
    TickTime,
    Project: { async getActiveProject() { return currentProject; } }
};

// ---- Intercept require("premierepro") --------------------------------------
const origLoad = Module._load;
Module._load = function (request) {
    if (request === "premierepro") return pproMock;
    return origLoad.apply(this, arguments);
};

const { runSmoothAutoFrame } = require(path.join(PLUGIN_DIR, "src/core.js"));

// ---- Fixtures --------------------------------------------------------------
const S = (s) => Math.round(s * 254016000000);

function buildScenario() {
    // Position: PointF keyframes drifting; Scale: numbers; Rotation: constant 0
    const position = new MockParam("Position", [
        { t: S(1), v: new PointF(0.50, 0.50) },
        { t: S(2), v: new PointF(0.54, 0.50) },
        { t: S(3), v: new PointF(0.60, 0.50) }
    ], null, true);
    const scale = new MockParam("Scale", [
        { t: S(1), v: 1.0 }, { t: S(3), v: 1.2 }
    ], null, true);
    const rotation = new MockParam("Rotation", [], 0, false); // <-- N1 regression guard
    const overridePan = new MockParam("Override Generated Pan", [], false, false);

    const comp = new MockComponent("AE.ADBE AutoReframe", "Auto Reframe",
        [overridePan, position, scale, rotation]);
    const other = new MockComponent("AE.ADBE Opacity", "Opacity", []);
    const chain = new MockChain([other, comp]);

    const clip = new MockTrackItem("tripod_shot.mov", chain, S(1), S(3), S(10));
    const sequence = {
        async getSelection() { return { async getTrackItems() { return [clip]; } }; },
        async getPlayerPosition() { return new TickTime(S(11)); }
    };
    currentProject = makeProject(sequence);
    return { clip, position, scale, rotation };
}

function reset() { log.length = 0; }

// ---- Tests -----------------------------------------------------------------
(async () => {
    let failures = 0;
    const t = async (name, fn) => {
        reset();
        try { await fn(); console.log("  PASS  " + name); }
        catch (e) { failures++; console.log("  FAIL  " + name + "\n        " + e.message); }
    };

    console.log("\n--- UXP core.js Funktionstest (gemockte Premiere-API) ---");

    await t("Dry-Run schreibt nichts, meldet aber den Plan", async () => {
        buildScenario();
        const r = await runSmoothAutoFrame({ timing: "start", dryRun: true });
        assert.strictEqual(r.processed, 1, "processed");
        assert.strictEqual(log.length, 0, "es wurden Actions erzeugt obwohl Dry-Run");
        assert.ok(r.results[0].changes.length >= 1);
    });

    await t("Standardmodus: setTimeVarying(false) + setValue, in EINER Transaktion", async () => {
        buildScenario();
        const r = await runSmoothAutoFrame({ timing: "start", dryRun: false });
        assert.strictEqual(r.processed, 1);
        const tx = log.filter((l) => l.kind === "TX_BEGIN");
        assert.strictEqual(tx.length, 1, "es muss genau eine Transaktion geben");
        assert.strictEqual(tx[0].undoString, "Smooth Auto Frame", "Undo-String");
        assert.ok(log[0].kind === "LOCK_ENTER", "lockedAccess muss die Transaktion umschliessen");
        const kinds = log.filter((l) => l.param === "Position").map((l) => l.kind);
        assert.deepStrictEqual(kinds, ["setTimeVarying", "setValue"], "Position-Actions: " + kinds);
        const tv = log.find((l) => l.kind === "setTimeVarying" && l.param === "Position");
        assert.strictEqual(tv.value, false, "setTimeVarying muss false sein");
    });

    await t("Position wird als PointF rekonstruiert (nicht als Array/Objekt)", async () => {
        buildScenario();
        await runSmoothAutoFrame({ timing: "start", dryRun: false });
        const sv = log.find((l) => l.kind === "setValue" && l.param === "Position");
        assert.ok(sv.value instanceof PointF, "Wert ist kein PointF: " + JSON.stringify(sv.value));
        assert.strictEqual(sv.value.x, 0.50, "x des ersten Keyframes");
    });

    await t("Referenz 'end' nimmt den LETZTEN Keyframe-Wert", async () => {
        buildScenario();
        await runSmoothAutoFrame({ timing: "end", dryRun: false });
        const sv = log.find((l) => l.kind === "setValue" && l.param === "Position");
        assert.strictEqual(sv.value.x, 0.60, "x muss 0.60 sein, war " + sv.value.x);
    });

    await t("Mittelwert-Modus mittelt PointF korrekt", async () => {
        buildScenario();
        await runSmoothAutoFrame({ timing: "average", dryRun: false });
        const sv = log.find((l) => l.kind === "setValue" && l.param === "Position");
        const expected = (0.50 + 0.54 + 0.60) / 3;
        assert.ok(Math.abs(sv.value.x - expected) < 1e-9, "x=" + sv.value.x + " erwartet " + expected);
    });

    await t("Rotation == 0 wird geschrieben, nicht als Fehler verworfen (N1-Regression)", async () => {
        buildScenario();
        const r = await runSmoothAutoFrame({ timing: "start", fixRotation: true, dryRun: false });
        assert.strictEqual(r.processed, 1, "Clip wurde uebersprungen: " + JSON.stringify(r.results));
        const sv = log.find((l) => l.kind === "setValue" && l.param === "Rotation");
        assert.ok(sv, "keine Rotation-Action erzeugt");
        assert.strictEqual(sv.value, 0, "Rotation muss 0 schreiben");
    });

    await t("Override Generated Pan wird auf true gesetzt", async () => {
        buildScenario();
        await runSmoothAutoFrame({ timing: "start", dryRun: false });
        const sv = log.find((l) => l.param === "Override Generated Pan" && l.kind === "setValue");
        assert.ok(sv && sv.value === true, "Override Pan nicht aktiviert");
    });

    await t("Keyframe-Modus: Bereich + Hold-Keys aus der Keyframe-Domaene", async () => {
        buildScenario();
        await runSmoothAutoFrame({ timing: "start", dryRun: false, keyframeMode: true });
        const rr = log.find((l) => l.kind === "removeRange" && l.param === "Position");
        assert.strictEqual(rr.from, S(1), "Bereichsstart muss erster Keyframe sein");
        assert.strictEqual(rr.to, S(3), "Bereichsende muss letzter Keyframe sein");
        const adds = log.filter((l) => l.kind === "addKeyframe" && l.param === "Position");
        assert.strictEqual(adds.length, 2, "zwei Hold-Keyframes erwartet");
        assert.deepStrictEqual(adds.map((a) => a.position), [S(1), S(3)]);
        const interps = log.filter((l) => l.kind === "setInterp" && l.param === "Position");
        assert.ok(interps.every((i) => i.mode === 4), "Interpolation muss Hold (4) sein");
    });

    await t("Rotation ohne Keyframes: nur EIN Key im Keyframe-Modus (Bounds identisch)", async () => {
        buildScenario();
        await runSmoothAutoFrame({ timing: "start", fixRotation: true, dryRun: false, keyframeMode: true });
        const adds = log.filter((l) => l.kind === "addKeyframe" && l.param === "Rotation");
        assert.ok(adds.length >= 1, "kein Rotation-Keyframe");
        assert.strictEqual(adds.length, 2, "in/out unterscheiden sich -> 2 Keys erwartet");
    });

    await t("Unbekannte Timing-Option fällt auf 'start' zurück (Whitelist)", async () => {
        buildScenario();
        const r = await runSmoothAutoFrame({ timing: "evil(); //", dryRun: true });
        assert.strictEqual(r.timing, "start", "timing=" + r.timing);
    });

    await t("Clip ohne Auto Reframe wird übersprungen, nicht verändert", async () => {
        const chain = new MockChain([new MockComponent("AE.ADBE Opacity", "Opacity", [])]);
        const clip = new MockTrackItem("plain.mov", chain, S(0), S(2), S(0));
        currentProject = makeProject({
            async getSelection() { return { async getTrackItems() { return [clip]; } }; },
            async getPlayerPosition() { return new TickTime(0); }
        });
        const r = await runSmoothAutoFrame({ timing: "start", dryRun: false });
        assert.strictEqual(r.skipped, 1, "skipped=" + r.skipped);
        assert.strictEqual(log.length, 0, "es wurde geschrieben obwohl kein Auto Reframe");
    });

    await t("Keine Auswahl -> fatalError, keine Mutation", async () => {
        currentProject = makeProject({
            async getSelection() { return { async getTrackItems() { return []; } }; },
            async getPlayerPosition() { return new TickTime(0); }
        });
        const r = await runSmoothAutoFrame({ timing: "start", dryRun: false });
        assert.ok(r.fatalError, "kein fatalError");
        assert.strictEqual(log.length, 0);
    });

    await t("Chain wird vor dem Schreiben erneut geholt (N3)", async () => {
        const { clip } = buildScenario();
        await runSmoothAutoFrame({ timing: "start", dryRun: false });
        assert.ok(clip.chainFetchCount >= 2,
            "Chain nur " + clip.chainFetchCount + "x geholt, Phase 1b fehlt");
    });

    await t("Playhead-Modus rechnet Sequenzzeit in Clipzeit um", async () => {
        buildScenario(); // clip start=10s, inPoint=1s, playhead=11s -> clipTime=2s
        await runSmoothAutoFrame({ timing: "playhead", dryRun: false });
        const sv = log.find((l) => l.kind === "setValue" && l.param === "Position");
        assert.strictEqual(sv.value.x, 0.54, "erwartet Wert des 2s-Keyframes (0.54), war " + sv.value.x);
    });

    console.log(failures === 0
        ? "\n  ALLE TESTS BESTANDEN\n"
        : "\n  " + failures + " TEST(S) FEHLGESCHLAGEN\n");
    process.exit(failures === 0 ? 0 : 1);
})();
