/*
 * Regression tests for src/core.js.
 *
 * Premiere cannot be driven from CI, so this harness mocks the `premierepro`
 * UXP module (TickTime, PointF, Project/Sequence/TrackItem/Component chain).
 *
 * Crucially the mock is a STATE MACHINE, not just a recorder: actions created
 * by the algorithm are actually applied to the mock parameters when the
 * transaction commits. An earlier version of this harness only logged actions,
 * which is precisely why a bug slipped through where the plugin reported
 * success while Premiere had changed nothing. Tests can therefore now assert
 * the resulting state, not just the intent.
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

/** Every action the algorithm queued, in order (for assertions). */
const log = [];

/**
 * A parameter that actually changes when actions are applied.
 * `options.rejectWrites` simulates Premiere discarding a write — the case that
 * caused the real-world bug.
 */
class MockParam {
    constructor(name, keyframes, staticValue, timeVarying, options) {
        this.displayName = name;
        this._keys = (keyframes || []).map((k) => ({ t: k.t, v: k.v, interp: null }));
        this._static = staticValue;
        this._tv = !!timeVarying;
        this._reject = !!(options && options.rejectWrites);
    }

    isTimeVarying() { return this._tv; }
    async areKeyframesSupported() { return true; }

    getKeyframeListAsTickTimes() {
        if (!this._tv) return [];
        return this._keys.map((k) => new TickTime(k.t));
    }

    async getStartValue() {
        if (!this._tv) return this._static;
        return this._keys.length ? this._keys[0].v : this._static;
    }

    async getValueAtTime(time) {
        if (!this._tv) return this._static;
        const hit = this._keys.find((k) => k.t === time.ticksNumber);
        if (hit) return hit.v;
        return this._keys.length ? this._keys[0].v : this._static;
    }

    createKeyframe(v) { return { value: v, position: null }; }

    _action(record, apply) {
        return { record: record, apply: this._reject ? () => {} : apply };
    }

    createSetTimeVaryingAction(b) {
        return this._action(
            { kind: "setTimeVarying", param: this.displayName, value: b },
            () => {
                this._tv = b;
                // Turning keyframing off drops the keyframes, as in Premiere.
                if (!b) this._keys = [];
            }
        );
    }

    createSetValueAction(kf, safe) {
        return this._action(
            { kind: "setValue", param: this.displayName, value: kf.value, safe: safe },
            () => { this._static = kf.value; }
        );
    }

    createAddKeyframeAction(kf) {
        const pos = kf.position ? kf.position.ticksNumber : null;
        return this._action(
            { kind: "addKeyframe", param: this.displayName, value: kf.value, position: pos },
            () => {
                this._tv = true;
                this._keys = this._keys.filter((k) => k.t !== pos);
                this._keys.push({ t: pos, v: kf.value, interp: null });
                this._keys.sort((a, b) => a.t - b.t);
            }
        );
    }

    createRemoveKeyframeRangeAction(a, b, updateUI) {
        return this._action(
            {
                kind: "removeRange", param: this.displayName,
                from: a.ticksNumber, to: b.ticksNumber, updateUI: updateUI
            },
            () => {
                this._keys = this._keys.filter(
                    (k) => k.t < a.ticksNumber || k.t > b.ticksNumber
                );
            }
        );
    }

    createSetInterpolationAtKeyframeAction(t, mode) {
        return this._action(
            { kind: "setInterp", param: this.displayName, at: t.ticksNumber, mode: mode },
            () => {
                const hit = this._keys.find((k) => k.t === t.ticksNumber);
                if (hit) hit.interp = mode;
            }
        );
    }
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
            const queued = [];
            cb({
                addAction: (a) => {
                    log.push(a.record);
                    queued.push(a);
                }
            });
            // Commit: apply every queued action, like Premiere would.
            for (const action of queued) action.apply();
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

/** Builds a single-clip project. Returns the parts for assertions. */
function makeScenario(params, opts) {
    const options = opts || {};
    const comp = new MockComponent(
        options.matchName || "AE.ADBE AutoReframe",
        options.displayName || "Auto Reframe",
        params
    );
    const chain = new MockChain(
        options.extraComponents ? options.extraComponents.concat([comp]) : [comp]
    );
    const clip = new MockTrackItem(
        options.clipName || "clip.mov",
        chain,
        options.inPoint !== undefined ? options.inPoint : S(1),
        options.outPoint !== undefined ? options.outPoint : S(3),
        options.start !== undefined ? options.start : S(0)
    );
    currentProject = makeProject({
        async getSelection() { return { async getTrackItems() { return [clip]; } }; },
        async getPlayerPosition() { return new TickTime(options.playhead || 0); }
    });
    return { comp, chain, clip };
}

/** The standard tripod-drift scenario: Position drifts, Rotation constant 0. */
function buildScenario() {
    const override = new MockParam("Erzeugten Pfad überschreiben", [], false, false);
    const position = new MockParam("Position", [
        { t: S(1), v: new PointF(0.50, 0.50) },
        { t: S(2), v: new PointF(0.54, 0.50) },
        { t: S(3), v: new PointF(0.60, 0.50) }
    ], null, true);
    const scale = new MockParam("Skalierung", [
        { t: S(1), v: 1.0 }, { t: S(3), v: 1.2 }
    ], null, true);
    const rotation = new MockParam("Drehung", [], 0, false);

    const parts = makeScenario([override, position, scale, rotation], {
        clipName: "tripod_shot.mov",
        inPoint: S(1), outPoint: S(3), start: S(10), playhead: S(11)
    });
    return Object.assign({ override, position, scale, rotation }, parts);
}

/** Position with a given raw value shape, plus a working override checkbox. */
function buildShapeScenario(rawValue, paramOptions) {
    const override = new MockParam("Erzeugten Pfad überschreiben", [], false, false);
    const position = new MockParam("Position", [{ t: S(1), v: rawValue }], null, true, paramOptions);
    const parts = makeScenario([override, position], { clipName: "shape.mov" });
    return Object.assign({ override, position }, parts);
}

/**
 * Models "Position" as a DERIVED readout of the adjust parameter: it reports
 * keyframes only while the source does. That is the behaviour the plugin now
 * verifies — freezing the adjust parameter must settle the applied position.
 * If real Premiere behaves differently, the verification reports it.
 */
function linkAppliedPosition(applied, source) {
    applied.isTimeVarying = function () { return source.isTimeVarying(); };
    applied.getKeyframeListAsTickTimes = function () {
        return source.getKeyframeListAsTickTimes();
    };
    return applied;
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
        const s = buildScenario();
        const r = await runSmoothAutoFrame({ timing: "start", dryRun: true });
        assert.strictEqual(r.processed, 1, "processed");
        assert.strictEqual(log.length, 0, "es wurden Actions erzeugt obwohl Dry-Run");
        assert.strictEqual(s.position._keys.length, 3, "Keyframes wurden verändert");
        assert.strictEqual(s.override._static, false, "Override wurde verändert");
        assert.ok(r.results[0].params, "Parameter-Dump fehlt im Dry-Run");
    });

    await t("Override wird zuerst gesetzt, in eigener Transaktion", async () => {
        const s = buildScenario();
        await runSmoothAutoFrame({ timing: "start", dryRun: false });
        const txs = log.filter((l) => l.kind === "TX_BEGIN");
        assert.strictEqual(txs.length, 2, "erwartet 2 Transaktionen, waren " + txs.length);
        const firstOverride = log.findIndex((l) => l.param === "Erzeugten Pfad überschreiben");
        const firstPosition = log.findIndex((l) => l.param === "Position");
        assert.ok(firstOverride < firstPosition, "Override wurde nicht zuerst gesetzt");
        assert.strictEqual(s.override._static, true, "Override-Checkbox ist nicht aktiv");
    });

    await t("Standardmodus entfernt Keyframes wirklich und meldet Erfolg", async () => {
        const s = buildScenario();
        const r = await runSmoothAutoFrame({ timing: "start", dryRun: false });
        assert.strictEqual(r.errors, 0, "Fehler: " + JSON.stringify(r.results));
        assert.strictEqual(r.processed, 1);
        assert.strictEqual(s.position._tv, false, "Position ist noch animiert");
        assert.strictEqual(s.position._keys.length, 0, "Keyframes noch vorhanden");
        assert.ok(s.position._static instanceof PointF, "Wert ist kein PointF");
        assert.strictEqual(s.position._static.x, 0.50, "falscher Wert fixiert");
        const change = r.results[0].changes[0];
        assert.strictEqual(change.keyframesBefore, 3);
        assert.strictEqual(change.keyframesAfter, 0, "Nachprüfung meldet Keyframes");
    });

    await t("REGRESSION: verworfener Schreibvorgang wird als Fehler gemeldet", async () => {
        // Premiere ignoriert die Writes (rejectWrites) -> das Plugin darf NICHT
        // Erfolg melden. Genau dieser Fall trat in echtem Premiere auf.
        const override = new MockParam("Erzeugten Pfad überschreiben", [], false, false, { rejectWrites: true });
        const position = new MockParam("Position", [
            { t: S(1), v: new PointF(0.72, 0.5) }
        ], null, true, { rejectWrites: true });
        makeScenario([override, position], { clipName: "stubborn.mov" });

        const r = await runSmoothAutoFrame({ timing: "start", dryRun: false });
        assert.strictEqual(r.processed, 0, "Erfolg gemeldet, obwohl nichts passiert ist!");
        assert.strictEqual(r.errors, 1, "kein Fehler gemeldet");
        const reason = r.results[0].reason;
        assert.ok(
            reason.includes("nicht übernommen") || reason.includes("nicht aktivieren"),
            "Meldung: " + reason
        );
        assert.ok(reason.includes("Checkbox") || reason.includes("animiert"),
            "Meldung nennt die Ursache nicht: " + reason);
        assert.ok(reason.includes("Erzeugten Pfad"), "Parameter-Dump fehlt: " + reason);
        assert.ok(reason.includes("nichts geschrieben") || r.processed === 0,
            "unklar, ob geschrieben wurde: " + reason);
    });

    await t("Fehlende Override-Checkbox: Fehler statt stillem Weitermachen", async () => {
        const position = new MockParam("Position", [{ t: S(1), v: new PointF(0.5, 0.5) }], null, true);
        makeScenario([position], { clipName: "no_override.mov" });

        const r = await runSmoothAutoFrame({ timing: "start", dryRun: false });
        assert.strictEqual(r.errors, 1, "erwartet 1 Fehler");
        assert.strictEqual(r.processed, 0);
        assert.strictEqual(log.length, 0, "es wurde geschrieben ohne Override-Parameter");
        const reason = r.results[0].reason;
        assert.ok(reason.includes("Erzeugten Pfad überschreiben"), reason);
        assert.ok(reason.includes("nicht gefunden"), reason);
        assert.ok(r.results[0].params, "Parameter-Dump fehlt");
    });

    await t("Override wird per Fragment gefunden, auch bei unbekanntem Label", async () => {
        const override = new MockParam("Generierten Verlauf überschreiben lassen", [], false, false);
        const position = new MockParam("Position", [{ t: S(1), v: new PointF(0.3, 0.4) }], null, true);
        makeScenario([override, position], { clipName: "fuzzy.mov" });

        const r = await runSmoothAutoFrame({ timing: "start", dryRun: false });
        assert.strictEqual(r.errors, 0, "Fehler: " + JSON.stringify(r.results));
        assert.strictEqual(override._static, true, "Override nicht gesetzt");
    });

    // --- Magic-String-Lookups müssen laut scheitern, nicht still ----------

    await t("Angefordertes Scale nicht auffindbar -> Fehler, kein stilles Überspringen", async () => {
        const override = new MockParam("Erzeugten Pfad überschreiben", [], false, false);
        const position = new MockParam("Position", [{ t: S(1), v: new PointF(0.5, 0.5) }], null, true);
        // Kein Scale-Parameter vorhanden, aber der Nutzer hat ihn angehakt.
        makeScenario([override, position], { clipName: "no_scale.mov" });

        const r = await runSmoothAutoFrame({ timing: "start", fixScale: true, dryRun: false });
        assert.strictEqual(r.errors, 1, "erwartet 1 Fehler, war " + r.errors);
        assert.strictEqual(r.processed, 0, "Erfolg gemeldet trotz fehlendem Parameter");
        assert.ok(r.results[0].reason.includes("Skalierung"), r.results[0].reason);
        assert.ok(r.results[0].params, "Parameter-Dump fehlt");
        assert.strictEqual(log.length, 0, "es wurde geschrieben, obwohl der Plan scheiterte");
    });

    await t("Angeforderte Rotation nicht auffindbar -> Fehler", async () => {
        const override = new MockParam("Erzeugten Pfad überschreiben", [], false, false);
        const position = new MockParam("Position", [{ t: S(1), v: new PointF(0.5, 0.5) }], null, true);
        makeScenario([override, position], { clipName: "no_rot.mov" });

        const r = await runSmoothAutoFrame({ timing: "start", fixRotation: true, dryRun: false });
        assert.strictEqual(r.errors, 1);
        assert.ok(r.results[0].reason.includes("Drehung"), r.results[0].reason);
    });

    await t("Nicht angefordertes Scale fehlt -> kein Fehler", async () => {
        const override = new MockParam("Erzeugten Pfad überschreiben", [], false, false);
        const position = new MockParam("Position", [{ t: S(1), v: new PointF(0.5, 0.5) }], null, true);
        makeScenario([override, position], { clipName: "ok.mov" });

        const r = await runSmoothAutoFrame({ timing: "start", dryRun: false });
        assert.strictEqual(r.errors, 0, "Fehler: " + JSON.stringify(r.results));
        assert.strictEqual(r.processed, 1);
    });

    await t("Falsch getroffene Checkbox (kein Boolean) -> Fehler", async () => {
        // Ein Zahlenparameter, dessen Name das Fragment "override" enthaelt.
        const fake = new MockParam("Override amount", [], 42, false);
        const position = new MockParam("Position", [{ t: S(1), v: new PointF(0.5, 0.5) }], null, true);
        makeScenario([fake, position], { clipName: "wrong_param.mov" });

        const r = await runSmoothAutoFrame({ timing: "start", dryRun: false });
        assert.strictEqual(r.errors, 1, "erwartet 1 Fehler");
        const reason = r.results[0].reason;
        assert.ok(reason.includes("Wahrheitswert"), "Meldung: " + reason);
        assert.ok(reason.includes("42"), "gelesener Wert fehlt: " + reason);
        assert.strictEqual(log.length, 0, "es wurde geschrieben");
    });

    await t("Clip ohne Auto Reframe nennt die vorhandenen Effekte", async () => {
        const other = new MockComponent("AE.ADBE Opacity", "Deckkraft", []);
        const other2 = new MockComponent("AE.ADBE Motion", "Bewegung", []);
        const clip = new MockTrackItem("plain.mov", new MockChain([other, other2]), S(0), S(2), S(0));
        currentProject = makeProject({
            async getSelection() { return { async getTrackItems() { return [clip]; } }; },
            async getPlayerPosition() { return new TickTime(0); }
        });
        const r = await runSmoothAutoFrame({ timing: "start", dryRun: false });
        assert.strictEqual(r.skipped, 1);
        const reason = r.results[0].reason;
        assert.ok(reason.includes("Deckkraft") && reason.includes("Bewegung"),
            "Effektliste fehlt: " + reason);
        assert.ok(r.results[0].components, "components-Feld fehlt");
    });

    await t("REIHENFOLGE: Werte werden erst nach Aktivieren der Checkbox gelesen", async () => {
        /*
         * Exakt das in Premiere 26.3.2 beobachtete Verhalten: solange die
         * Checkbox aus ist, meldet "Position anpassen" 0 Keyframes und
         * timeVarying=false. Erst nach dem Aktivieren erscheinen die 3
         * Keyframes. Wer vorher liest, bekommt den falschen Referenzwert.
         */
        const gate = { open: false };

        const override = new MockParam("Erzeugten Pfad überschreiben", [], false, false);
        const origOverrideSet = override.createSetValueAction.bind(override);
        override.createSetValueAction = function (kf, safe) {
            const action = origOverrideSet(kf, safe);
            const origApply = action.apply;
            action.apply = () => { origApply(); if (kf.value === true) gate.open = true; };
            return action;
        };

        const position = new MockParam("Position anpassen", [
            { t: S(1), v: new PointF(0.81, 0.5) },
            { t: S(2), v: new PointF(0.85, 0.5) },
            { t: S(3), v: new PointF(0.90, 0.5) }
        ], new PointF(0.0, 0.0), true);
        // Gesperrt: ohne offene Checkbox keine Keyframes, kein timeVarying.
        // Mit offener Checkbox gilt der echte Zustand des Parameters.
        const origTv = position.isTimeVarying.bind(position);
        position.isTimeVarying = function () { return gate.open && origTv(); };
        const origList = position.getKeyframeListAsTickTimes.bind(position);
        position.getKeyframeListAsTickTimes = function () {
            return gate.open ? origList() : [];
        };

        makeScenario([override, position], { clipName: "gated.mov" });

        const r = await runSmoothAutoFrame({ timing: "start", dryRun: false });
        assert.strictEqual(r.errors, 0, "Fehler: " + JSON.stringify(r.results));
        assert.strictEqual(r.processed, 1);
        // Der erste Keyframe-Wert (0.81) ist nur sichtbar, wenn NACH dem
        // Aktivieren gelesen wurde. Vorher waere der statische 0.0 gelesen worden.
        assert.ok(position._static instanceof PointF, "kein PointF");
        assert.strictEqual(position._static.x, 0.81,
            "falscher Referenzwert -> zu frueh gelesen: " + position._static.x);
    });

    await t("Checkbox ohne Anzeigenamen wird per bekanntem Index aufgelöst", async () => {
        /*
         * Reale Lage in AE.ADBE AEFilterAutoFramer (Premiere 26.3.2, de_DE):
         * die Override-Checkbox liegt auf Index 8 und hat den Anzeigenamen "".
         * Index 0 (" ") und Index 4 ("Uniform Scale") sind ebenfalls Booleans,
         * duerfen aber NICHT getroffen werden.
         */
        const p = [];
        p[0] = new MockParam(" ", [], false, false);
        p[1] = new MockParam("Motion-Tracking", [], 1, false);
        p[2] = new MockParam("Position", [{ t: S(1), v: new PointF(0.68, 0.5) }], null, true);
        p[3] = new MockParam("Scale (Merged)", [], 100, false);
        p[4] = new MockParam("Uniform Scale", [], true, false);
        p[5] = new MockParam("Anchor Point", [], new PointF(0.5, 0.5), false);
        p[6] = new MockParam("Position anpassen", [{ t: S(1), v: new PointF(0.42, 0.5) }], null, true);
        p[7] = new MockParam("Generated Keyframes", [{ t: S(1), v: new PointF(0.5, 0.5) }], null, true);
        p[8] = new MockParam("", [], false, false);   // <- die Checkbox
        p[9] = new MockParam("Hash arb data", [], null, false);
        p[10] = new MockParam("Reframing für Versatz", [], new PointF(0, 0), false);
        p[11] = new MockParam("Reframing für Skalierung", [], 100, false);
        p[12] = new MockParam("Scale (Auto Generated)", [], 100, false);
        p[13] = new MockParam("Reframing für Drehung", [], 0, false);
        linkAppliedPosition(p[2], p[6]);

        makeScenario(p, {
            matchName: "AE.ADBE AEFilterAutoFramer",
            displayName: "Auto Reframe",
            clipName: "real_layout.mov"
        });

        const r = await runSmoothAutoFrame({ timing: "start", dryRun: false });
        assert.strictEqual(r.errors, 0, "Fehler: " + JSON.stringify(r.results));
        assert.strictEqual(r.processed, 1);
        assert.strictEqual(p[8]._static, true, "Checkbox auf Index 8 nicht gesetzt");
        assert.strictEqual(p[0]._static, false, "falsche Checkbox (Index 0) gesetzt");
        assert.strictEqual(p[4]._static, true, "Uniform Scale veraendert");
        // Bearbeitet werden muss "Position anpassen" (Index 6), nicht Index 2.
        assert.strictEqual(r.results[0].changes[0].param, "Position anpassen",
            "falscher Parameter: " + r.results[0].changes[0].param);
        assert.strictEqual(p[6]._keys.length, 0, "Index 6 nicht bereinigt");
        assert.strictEqual(p[2]._keys.length, 1, "Index 2 wurde fälschlich angefasst");
        assert.strictEqual(r.results[0].overrideResolvedBy, "index",
            "Auflösungsart nicht protokolliert");
        assert.ok(r.results[0].paramsAfter, "paramsAfter fehlt");
    });

    await t("REGRESSION: verzögerte Keyframe-Übertragung wird abgewartet", async () => {
        /*
         * Premiere uebertraegt den erzeugten Pfad NICHT synchron auf den
         * bearbeitbaren Parameter, wenn die Checkbox committed wird. Eine
         * frühere Fassung las sofort danach, bekam 0 Keyframes und den
         * neutralen Wert 0.5 — und fror diesen fest, mit Erfolgsmeldung.
         */
        let committedAt = null;
        let reveals = 0;

        const override = new MockParam("Erzeugten Pfad überschreiben", [], false, false);
        const origSet = override.createSetValueAction.bind(override);
        override.createSetValueAction = function (kf, safe) {
            const action = origSet(kf, safe);
            const origApply = action.apply;
            action.apply = () => { origApply(); if (kf.value === true) committedAt = Date.now(); };
            return action;
        };

        const adjust = new MockParam("Position anpassen", [
            { t: S(1), v: new PointF(0.6889, 0.5) },
            { t: S(2), v: new PointF(0.72, 0.5) }
        ], new PointF(0.5, 0.5), true);

        // Keyframes erscheinen erst ~250 ms nach dem Commit.
        const origList = adjust.getKeyframeListAsTickTimes.bind(adjust);
        const origTv = adjust.isTimeVarying.bind(adjust);
        const revealed = () => committedAt !== null && Date.now() - committedAt >= 250;
        adjust.getKeyframeListAsTickTimes = function () {
            return revealed() ? origList() : [];
        };
        adjust.isTimeVarying = function () {
            // getKeyframeTimes() bricht hier ab, wenn false -> hier zaehlen.
            if (!revealed()) { reveals++; return false; }
            return origTv();
        };

        const generated = new MockParam("Generated Keyframes", [
            { t: S(1), v: new PointF(0.5, 0.5) },
            { t: S(2), v: new PointF(0.5, 0.5) }
        ], null, true);

        const applied = new MockParam("Position", [], new PointF(0.6889, 0.5), false);
        linkAppliedPosition(applied, adjust);

        makeScenario([override, applied, adjust, generated], { clipName: "delayed.mov" });

        const r = await runSmoothAutoFrame({ timing: "start", dryRun: false });
        assert.strictEqual(r.errors, 0, "Fehler: " + JSON.stringify(r.results));
        assert.ok(reveals > 0, "es wurde nie zu frueh gelesen - Test greift nicht");
        // Entscheidend: der ECHTE erste Keyframe-Wert, nicht der neutrale 0.5.
        assert.ok(Math.abs(adjust._static.x - 0.6889) < 1e-9,
            "neutraler Wert eingefroren statt echtem: " + adjust._static.x);
        assert.ok(r.results[0].keyframeWaitAttempts >= 1, "keine Wartezyklen protokolliert");
    });

    await t("Referenz 'end' nimmt den LETZTEN Keyframe-Wert", async () => {
        const s = buildScenario();
        await runSmoothAutoFrame({ timing: "end", dryRun: false });
        assert.strictEqual(s.position._static.x, 0.60, "x war " + s.position._static.x);
    });

    await t("Mittelwert-Modus mittelt PointF korrekt", async () => {
        const s = buildScenario();
        await runSmoothAutoFrame({ timing: "average", dryRun: false });
        const expected = (0.50 + 0.54 + 0.60) / 3;
        assert.ok(Math.abs(s.position._static.x - expected) < 1e-9, "x=" + s.position._static.x);
    });

    await t("Playhead-Modus rechnet Sequenzzeit in Clipzeit um", async () => {
        const s = buildScenario(); // start=10s, inPoint=1s, playhead=11s -> 2s
        await runSmoothAutoFrame({ timing: "playhead", dryRun: false });
        assert.strictEqual(s.position._static.x, 0.54, "x war " + s.position._static.x);
    });

    await t("Rotation == 0 wird geschrieben (N1-Regression)", async () => {
        const s = buildScenario();
        const r = await runSmoothAutoFrame({ timing: "start", fixRotation: true, dryRun: false });
        assert.strictEqual(r.errors, 0, "Fehler: " + JSON.stringify(r.results));
        assert.strictEqual(s.rotation._static, 0, "Rotation nicht 0");
        const names = r.results[0].changes.map((c) => c.param);
        assert.ok(names.includes("Drehung"), "Rotation nicht verarbeitet: " + names);
    });

    await t("Scale wird nur auf Wunsch angefasst", async () => {
        const s = buildScenario();
        await runSmoothAutoFrame({ timing: "start", dryRun: false });
        assert.strictEqual(s.scale._keys.length, 2, "Scale wurde ungefragt verändert");

        reset();
        const s2 = buildScenario();
        await runSmoothAutoFrame({ timing: "start", fixScale: true, dryRun: false });
        assert.strictEqual(s2.scale._keys.length, 0, "Scale-Keyframes nicht entfernt");
        assert.strictEqual(s2.scale._static, 1.0, "Scale-Wert falsch: " + s2.scale._static);
    });

    await t("Keyframe-Modus: Hold-Keys in der Keyframe-Domäne", async () => {
        const s = buildScenario();
        const r = await runSmoothAutoFrame({ timing: "start", dryRun: false, keyframeMode: true });
        assert.strictEqual(r.errors, 0, "Fehler: " + JSON.stringify(r.results));
        const rr = log.find((l) => l.kind === "removeRange" && l.param === "Position");
        assert.strictEqual(rr.from, S(1), "Bereichsstart");
        assert.strictEqual(rr.to, S(3), "Bereichsende");
        assert.strictEqual(s.position._keys.length, 2, "erwartet 2 Hold-Keyframes");
        assert.deepStrictEqual(s.position._keys.map((k) => k.t), [S(1), S(3)]);
        assert.ok(s.position._keys.every((k) => k.interp === 4), "Interpolation nicht Hold");
    });

    await t("Unbekannte Timing-Option fällt auf 'start' zurück (Whitelist)", async () => {
        buildScenario();
        const r = await runSmoothAutoFrame({ timing: "evil(); //", dryRun: true });
        assert.strictEqual(r.timing, "start", "timing=" + r.timing);
    });

    await t("Clip ohne Auto Reframe wird übersprungen, nicht verändert", async () => {
        const other = new MockComponent("AE.ADBE Opacity", "Deckkraft", []);
        const clip = new MockTrackItem("plain.mov", new MockChain([other]), S(0), S(2), S(0));
        currentProject = makeProject({
            async getSelection() { return { async getTrackItems() { return [clip]; } }; },
            async getPlayerPosition() { return new TickTime(0); }
        });
        const r = await runSmoothAutoFrame({ timing: "start", dryRun: false });
        assert.strictEqual(r.skipped, 1, "skipped=" + r.skipped);
        assert.strictEqual(r.errors, 0);
        assert.strictEqual(log.length, 0, "es wurde geschrieben");
    });

    await t("Echter matchName AE.ADBE AEFilterAutoFramer wird erkannt", async () => {
        // Aus echtem Premiere 26.3.2 (de_DE) beobachtet.
        const override = new MockParam("Erzeugten Pfad überschreiben", [], false, false);
        const position = new MockParam("Position anpassen", [{ t: S(1), v: new PointF(0.72, 0.5) }], null, true);
        makeScenario([override, position], {
            matchName: "AE.ADBE AEFilterAutoFramer",
            displayName: "Auto Reframe",
            clipName: "real.mov"
        });
        const r = await runSmoothAutoFrame({ timing: "start", dryRun: false });
        assert.strictEqual(r.errors, 0, "Fehler: " + JSON.stringify(r.results));
        assert.strictEqual(r.processed, 1);
    });

    await t("'Position anpassen' hat Vorrang vor blossem 'Position'", async () => {
        // Echter Effekt hat BEIDE. Das Tutorial bearbeitet "Adjust Position".
        const override = new MockParam("Erzeugten Pfad überschreiben", [], false, false);
        const merged = new MockParam("Position", [{ t: S(1), v: new PointF(0.11, 0.11) }], null, true);
        const adjust = new MockParam("Position anpassen", [{ t: S(1), v: new PointF(0.72, 0.5) }], null, true);
        linkAppliedPosition(merged, adjust);
        const s = makeScenario([override, merged, adjust], { clipName: "prio.mov" });

        const r = await runSmoothAutoFrame({ timing: "start", dryRun: false });
        assert.strictEqual(r.errors, 0, "Fehler: " + JSON.stringify(r.results));
        assert.strictEqual(r.results[0].changes[0].param, "Position anpassen",
            "falscher Parameter gewaehlt: " + r.results[0].changes[0].param);
        assert.strictEqual(merged._keys.length, 1, "falscher Parameter wurde verändert");
        assert.strictEqual(adjust._keys.length, 0, "Zielparameter nicht bereinigt");
        void s;
    });

    await t("Parameter-Dump enthält Werte und Werttypen", async () => {
        buildScenario();
        const r = await runSmoothAutoFrame({ timing: "start", dryRun: true });
        const dump = r.results[0].params;
        assert.ok(dump && dump.length, "kein Dump");
        const override = dump.find((p) => p.name.indexOf("überschreiben") !== -1);
        assert.ok(override, "Override nicht im Dump");
        assert.strictEqual(override.valueType, "boolean", "Werttyp fehlt/falsch");
        assert.strictEqual(override.value, false, "Wert fehlt");
    });

    await t("Auto Reframe wird neben anderen Effekten gefunden", async () => {
        const override = new MockParam("Erzeugten Pfad überschreiben", [], false, false);
        const position = new MockParam("Position", [{ t: S(1), v: new PointF(0.2, 0.3) }], null, true);
        makeScenario([override, position], {
            extraComponents: [new MockComponent("AE.ADBE Opacity", "Deckkraft", [])]
        });
        const r = await runSmoothAutoFrame({ timing: "start", dryRun: false });
        assert.strictEqual(r.errors, 0, "Fehler: " + JSON.stringify(r.results));
        assert.strictEqual(r.processed, 1);
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
        const s = buildScenario();
        await runSmoothAutoFrame({ timing: "start", dryRun: false });
        assert.ok(s.clip.chainFetchCount >= 2,
            "Chain nur " + s.clip.chainFetchCount + "x geholt");
    });

    // --- Werteformen, die Premiere real zurückgeben kann -------------------
    const shapeCases = [
        ["PointF-artig {x,y}",    () => new PointF(0.42, 0.5),              0.42],
        ["Wrapper {value:{x,y}}", () => ({ value: new PointF(0.42, 0.5) }), 0.42],
        ["doppelt verpackt",      () => ({ value: { value: new PointF(0.42, 0.5) } }), 0.42],
        ["Array [x,y]",           () => [0.42, 0.5],                        0.42],
        ["Wrapper um Array",      () => ({ value: [0.42, 0.5] }),            0.42],
        ["numerische Strings",    () => ({ x: "0.42", y: "0.5" }),           0.42]
    ];

    for (const [label, make, expectedX] of shapeCases) {
        await t("Position als " + label + " wird gelesen und geschrieben", async () => {
            const s = buildShapeScenario(make());
            const r = await runSmoothAutoFrame({ timing: "start", dryRun: false });
            assert.strictEqual(r.errors, 0, "Fehler: " + JSON.stringify(r.results));
            assert.ok(s.position._static instanceof PointF, "Wert ist kein PointF");
            assert.ok(Math.abs(s.position._static.x - expectedX) < 1e-9,
                "x=" + s.position._static.x);
        });
    }

    await t("Unlesbarer Wert: Meldung nennt Struktur UND JSON statt [object Object]", async () => {
        const s = buildShapeScenario({ foo: "bar", nested: {} });
        const r = await runSmoothAutoFrame({ timing: "start", dryRun: false });
        assert.strictEqual(r.errors, 1, "erwartete genau einen Fehler");
        const reason = r.results[0].reason;
        assert.ok(!reason.includes("[object Object]"), "noch [object Object]: " + reason);
        assert.ok(reason.includes("keys=") || reason.includes("typ="), "keine Struktur: " + reason);
        assert.ok(reason.includes("JSON:"), "kein JSON: " + reason);
        assert.ok(reason.includes('"foo"'), "JSON ohne Daten: " + reason);
        assert.strictEqual(s.position._keys.length, 1, "trotz Fehler geschrieben");
    });

    await t("JSON-Diagnose erfasst auch Prototyp-Getter (Host-Objekte)", async () => {
        class HostLike {
            get unitType() { return "percent"; }
            get payload() { return "verborgen"; }
        }
        const hostish = new HostLike();
        assert.strictEqual(JSON.stringify(hostish), "{}", "Vorbedingung: stringify liefert {}");

        buildShapeScenario(hostish);
        const r = await runSmoothAutoFrame({ timing: "start", dryRun: false });
        const reason = r.results[0].reason;
        assert.ok(reason.includes("unitType") || reason.includes("payload"),
            "Prototyp-Getter fehlen: " + reason);
    });

    await t("Report enthält Meta-Block für den Log-Export", async () => {
        buildScenario();
        const r = await runSmoothAutoFrame({ timing: "middle", fixScale: true, dryRun: true });
        assert.ok(r.meta, "kein meta-Block");
        assert.ok(r.meta.timestamp, "kein timestamp");
        assert.strictEqual(r.meta.options.timing, "middle");
        assert.strictEqual(r.meta.options.fixScale, true);
        assert.ok(r.meta.pluginVersion, "keine pluginVersion");
        const text = JSON.stringify(r, null, 2);
        assert.ok(text.length > 50 && text.includes('"meta"'), "nicht exportierbar");
    });

    console.log(failures === 0
        ? "\n  ALLE TESTS BESTANDEN\n"
        : "\n  " + failures + " TEST(S) FEHLGESCHLAGEN\n");
    process.exit(failures === 0 ? 0 : 1);
})();
