/*
 * Integration tests for src/core.js against a mocked Premiere.
 *
 * The mock is a STATE MACHINE, not a recorder: actions created by the plugin
 * are actually applied to the mock objects when the transaction commits, and
 * removing a component really removes it from the chain. Tests can therefore
 * assert the resulting STATE, not merely the intent — which is the only way to
 * catch the failure mode this plugin is built to avoid, namely reporting
 * success while nothing changed.
 *
 * The mock also reproduces the two awkward real-world behaviours this design
 * depends on:
 *   - a position parameter whose getValueAtTime() varies over time even though
 *     isTimeVarying() is false and it exposes no keyframes (the normal state
 *     while "override generated path" is off),
 *   - a host that can silently discard a write.
 *
 * No test framework required — plain node:assert.
 *   node test/core.test.js
 */
const Module = require("module");
const path = require("path");
const assert = require("assert");

const PLUGIN_DIR = path.resolve(__dirname, "..");
const TICKS_PER_SECOND = 254016000000;
const S = (seconds) => Math.round(seconds * TICKS_PER_SECOND);

// ---- Mock Premiere API -----------------------------------------------------

class TickTime {
    constructor(ticks) {
        this._t = ticks;
    }
    get ticksNumber() {
        return this._t;
    }
    get seconds() {
        return this._t / TICKS_PER_SECOND;
    }
    add(other) {
        return new TickTime(this._t + other.ticksNumber);
    }
    subtract(other) {
        return new TickTime(this._t - other.ticksNumber);
    }
    static createWithSeconds(seconds) {
        return new TickTime(Math.round(seconds * TICKS_PER_SECOND));
    }
}

class PointF {
    constructor(x, y) {
        this.x = x;
        this.y = y;
    }
}

/** Every action the plugin queued, in order, for assertions. */
const log = [];

/**
 * A parameter that actually changes when actions are applied.
 *
 * `path` makes getValueAtTime() time-dependent without any keyframes, which is
 * exactly how Auto Reframe behaves before the override checkbox is touched.
 * `rejectWrites` simulates Premiere discarding a write.
 */
class MockParam {
    constructor(name, options) {
        const opts = options || {};
        this.displayName = name;
        this._value = opts.value;
        this._path = opts.path || null;
        this._keys = (opts.keyframes || []).slice();
        this._tv = !!opts.timeVarying;
        this._reject = !!opts.rejectWrites;
    }

    isTimeVarying() {
        return this._tv;
    }
    async areKeyframesSupported() {
        return true;
    }
    getKeyframeListAsTickTimes() {
        return this._keys.map((t) => new TickTime(t));
    }
    async getStartValue() {
        return { value: await this.getValueAtTime(new TickTime(0)) };
    }
    async getValueAtTime(time) {
        if (this._path) return this._path(time.ticksNumber);
        return this._value;
    }
    createKeyframe(value) {
        return { value: value, position: null };
    }

    _action(record, apply) {
        return { record: record, apply: this._reject ? () => {} : apply };
    }

    createSetTimeVaryingAction(flag) {
        return this._action(
            { kind: "setTimeVarying", param: this.displayName, value: flag },
            () => {
                this._tv = flag;
                if (!flag) this._keys = [];
            }
        );
    }
    createSetValueAction(keyframe, safe) {
        return this._action(
            {
                kind: "setValue",
                param: this.displayName,
                value: keyframe.value,
                safe: safe
            },
            () => {
                this._value = keyframe.value;
                // A written static value replaces any generated path.
                this._path = null;
            }
        );
    }
    createRemoveKeyframeRangeAction(from, to) {
        return this._action({ kind: "removeRange", param: this.displayName }, () => {
            this._keys = this._keys.filter(
                (t) => t < from.ticksNumber || t > to.ticksNumber
            );
        });
    }
}

class MockComponent {
    constructor(matchName, displayName, params) {
        this._m = matchName;
        this._d = displayName;
        this._p = params;
    }
    async getMatchName() {
        return this._m;
    }
    async getDisplayName() {
        return this._d;
    }
    getParamCount() {
        return this._p.length;
    }
    getParam(index) {
        return this._p[index];
    }
}

class MockChain {
    constructor(components) {
        this._c = components;
    }
    getComponentCount() {
        return this._c.length;
    }
    getComponentAtIndex(index) {
        return this._c[index];
    }
    createRemoveComponentAction(component) {
        return {
            record: { kind: "removeComponent", matchName: component._m },
            apply: () => {
                const at = this._c.indexOf(component);
                if (at !== -1) this._c.splice(at, 1);
            }
        };
    }
}

class MockProjectItem {
    constructor(metadata, pixelAspect) {
        this._metadata = metadata;
        this._par = pixelAspect;
    }
    async getFootageInterpretation() {
        if (this._par === null) return null;
        const par = this._par;
        return { getPixelAspectRatio: () => par };
    }
}

class MockTrackItem {
    constructor(options) {
        this._name = options.name;
        this._chain = options.chain;
        this._in = options.inTicks;
        this._out = options.outTicks;
        this._start = options.startTicks || 0;
        this._trackIndex = options.trackIndex || 0;
        this._projectItem = options.projectItem;
        this.chainFetchCount = 0;
    }
    async getName() {
        return this._name;
    }
    async getComponentChain() {
        this.chainFetchCount++;
        return this._chain;
    }
    async getInPoint() {
        return new TickTime(this._in);
    }
    async getOutPoint() {
        return new TickTime(this._out);
    }
    async getStartTime() {
        return new TickTime(this._start);
    }
    async getTrackIndex() {
        return this._trackIndex;
    }
    async getProjectItem() {
        return this._projectItem;
    }
}

let currentProject = null;
let transactionShouldThrow = false;

function makeProject(sequence) {
    return {
        async getActiveSequence() {
            return sequence;
        },
        lockedAccess(callback) {
            log.push({ kind: "LOCK_ENTER" });
            callback();
            log.push({ kind: "LOCK_EXIT" });
        },
        executeTransaction(callback, undoString) {
            log.push({ kind: "TX_BEGIN", undoString: undoString });
            if (transactionShouldThrow) {
                throw new Error("Premiere lehnte die Transaktion ab");
            }
            const queued = [];
            callback({
                addAction: (action) => {
                    log.push(action.record);
                    queued.push(action);
                    return true;
                }
            });
            for (const action of queued) action.apply();
            log.push({ kind: "TX_COMMIT" });
            return true;
        }
    };
}

const metadataByItem = new WeakMap();

const pproMock = {
    PointF: PointF,
    TickTime: TickTime,
    Project: {
        async getActiveProject() {
            return currentProject;
        }
    },
    Metadata: {
        async getProjectColumnsMetadata(projectItem) {
            const text = metadataByItem.get(projectItem);
            if (text === undefined) throw new Error("keine Metadaten");
            return text;
        },
        async getProjectMetadata() {
            throw new Error("nicht verfügbar");
        }
    },
    Constants: {
        TrackItemType: { EMPTY: 0, CLIP: 1, TRANSITION: 2, PREVIEW: 3, FEEDBACK: 4 }
    }
};

// ---- Intercept require("premierepro") --------------------------------------
const origLoad = Module._load;
Module._load = function (request) {
    if (request === "premierepro") return pproMock;
    if (request === "uxp") {
        return { host: { name: "Premiere Pro", version: "26.3.2", uiLocale: "de_DE" } };
    }
    return origLoad.apply(this, arguments);
};

const core = require(path.join(PLUGIN_DIR, "src/core.js"));
const geometry = require(path.join(PLUGIN_DIR, "src/geometry.js"));

// ---- Fixtures --------------------------------------------------------------

/**
 * The real parameter layout of AE.ADBE AEFilterAutoFramer, observed in
 * Premiere 26.3.2 (de_DE). Index 8's display name really is the empty string.
 */
function autoReframeParams(options) {
    const opts = options || {};
    const drift = opts.drift === undefined ? 0.04 : opts.drift;
    const baseX = opts.baseX === undefined ? 0.68 : opts.baseX;
    const baseY = opts.baseY === undefined ? 0.5 : opts.baseY;
    const inTicks = opts.inTicks === undefined ? 0 : opts.inTicks;
    const outTicks = opts.outTicks === undefined ? S(2) : opts.outTicks;
    const vertical = !!opts.verticalDrift;
    const pixels = !!opts.pixels;

    const progress = (ticks) => {
        if (outTicks === inTicks) return 0;
        return Math.max(0, Math.min(1, (ticks - inTicks) / (outTicks - inTicks)));
    };
    const positionPath = (ticks) => {
        const t = progress(ticks);
        const x = vertical ? baseX : baseX + drift * t;
        const y = vertical ? baseY + drift * t : baseY;
        return pixels ? new PointF(x, y) : new PointF(x, y);
    };

    const params = [];
    params[0] = new MockParam(" ", { value: true }); // effect enable toggle
    params[1] = new MockParam("Motion-Tracking", { value: 1 });
    params[2] = new MockParam("Position", {
        path: opts.appliedConstant ? null : positionPath,
        value: opts.appliedConstant ? new PointF(baseX, baseY) : undefined,
        keyframes: opts.appliedKeyframes || []
    });
    params[3] = new MockParam("Scale (Merged)", {
        value: opts.scale === undefined ? 100 : opts.scale
    });
    params[4] = new MockParam("Uniform Scale", { value: true });
    params[5] = new MockParam("Anchor Point", {
        value: opts.anchor === undefined ? new PointF(0.5, 0.5) : opts.anchor
    });
    params[6] = new MockParam("Position anpassen", { value: new PointF(0, 0) });
    params[7] = new MockParam("Generated Keyframes", {
        path: opts.generatedPath === false ? null : positionPath,
        value: opts.generatedPath === false ? new PointF(baseX, baseY) : undefined,
        keyframes: opts.generatedKeyframes || []
    });
    params[8] = new MockParam("", { value: false }); // override generated path
    params[9] = new MockParam("Hash arb data", { value: null });
    params[10] = new MockParam("Reframing für Versatz", { value: new PointF(0, 0) });
    params[11] = new MockParam("Reframing für Skalierung", { value: 100 });
    params[12] = new MockParam("Scale (Auto Generated)", { value: 100 });
    params[13] = new MockParam("Reframing für Drehung", { value: 0 });
    return params;
}

/** The intrinsic Motion effect's standard layout. */
function motionParams(options) {
    const opts = options || {};
    return [
        new MockParam("Position", {
            value: opts.position || new PointF(0.5, 0.5),
            keyframes: opts.positionKeyframes || [],
            timeVarying: !!(opts.positionKeyframes && opts.positionKeyframes.length),
            rejectWrites: !!opts.rejectWrites
        }),
        new MockParam("Skalierung", {
            value: opts.scale === undefined ? 100 : opts.scale,
            rejectWrites: !!opts.rejectWrites
        }),
        new MockParam("Skalierungsbreite", { value: 100 }),
        new MockParam("Einheitliche Skalierung", { value: true }),
        new MockParam("Drehung", { value: opts.rotation === undefined ? 0 : opts.rotation }),
        new MockParam("Ankerpunkt", { value: new PointF(0.5, 0.5) }),
        new MockParam("Flackern reduzieren", { value: 0 })
    ];
}

/**
 * Builds a clip. Every format is explicit — the plugin reads both rectangles
 * and must work for any pair.
 */
function makeClip(options) {
    const opts = options || {};
    const inTicks = opts.inTicks === undefined ? 0 : opts.inTicks;
    const outTicks = opts.outTicks === undefined ? S(2) : opts.outTicks;

    const components = [];
    const motion = new MockComponent(
        "AE.ADBE Motion",
        "Bewegung",
        motionParams(opts.motion)
    );
    components.push(motion);

    let autoReframe = null;
    if (opts.withAutoReframe !== false) {
        autoReframe = new MockComponent(
            "AE.ADBE AEFilterAutoFramer",
            "Auto Reframe",
            autoReframeParams(Object.assign({ inTicks: inTicks, outTicks: outTicks }, opts.effect))
        );
        components.push(autoReframe);
    }
    if (opts.extraComponent) components.push(opts.extraComponent);

    const chain = new MockChain(components);
    const projectItem = new MockProjectItem(null, opts.pixelAspect === undefined ? 1 : opts.pixelAspect);
    if (opts.sourceMetadata !== null) {
        metadataByItem.set(
            projectItem,
            opts.sourceMetadata ||
                '{"Column.Intrinsic.VideoInfo":"1920 x 1080 (1.0)"}'
        );
    }

    const trackItem = new MockTrackItem({
        name: opts.name || "tripod.mov",
        chain: chain,
        inTicks: inTicks,
        outTicks: outTicks,
        startTicks: opts.startTicks || 0,
        trackIndex: opts.trackIndex || 0,
        projectItem: projectItem
    });

    return { trackItem: trackItem, chain: chain, motion: motion, autoReframe: autoReframe };
}

/** Builds a sequence of the given frame size containing the given clips. */
function makeSequence(clips, options) {
    const opts = options || {};
    const width = opts.width === undefined ? 1080 : opts.width;
    const height = opts.height === undefined ? 1080 : opts.height;
    const selected = opts.selected === undefined ? clips : opts.selected;
    const trackCount = opts.trackCount === undefined ? 1 : opts.trackCount;

    const sequence = {
        async getSettings() {
            return {
                async getVideoFrameRect() {
                    return { width: width, height: height };
                }
            };
        },
        async getSelection() {
            return {
                async getTrackItems() {
                    return selected.map((c) => c.trackItem);
                }
            };
        },
        async getPlayerPosition() {
            return new TickTime(opts.playheadTicks || 0);
        },
        async getVideoTrackCount() {
            return trackCount;
        },
        async getVideoTrack(index) {
            return {
                getTrackItems() {
                    return clips
                        .filter((c) => (c.trackItem._trackIndex || 0) === index)
                        .map((c) => c.trackItem);
                }
            };
        }
    };
    currentProject = makeProject(sequence);
    return sequence;
}

function reset() {
    log.length = 0;
    transactionShouldThrow = false;
}

function firstClip(report) {
    return report.clips[0];
}

function motionPosition(parts) {
    return parts.motion._p[0]._value;
}

function hasAutoReframe(parts) {
    return parts.chain._c.some((c) => c._m === "AE.ADBE AEFilterAutoFramer");
}

// ---- Tests -----------------------------------------------------------------
(async () => {
    let failures = 0;
    const t = async (name, fn) => {
        reset();
        try {
            await fn();
            console.log("  PASS  " + name);
        } catch (error) {
            failures++;
            console.log("  FAIL  " + name + "\n        " + error.message);
        }
    };

    console.log("\n--- core.js (gemockte Premiere-API, Zustandsautomat) ---");

    // === Dry run ==========================================================

    await t("Dry-Run schreibt nichts, liefert aber den vollen Plan", async () => {
        const clip = makeClip({});
        makeSequence([clip]);
        const report = await core.runReframeLock({ dryRun: true });

        assert.strictEqual(log.length, 0, "es wurden Actions erzeugt obwohl Dry-Run");
        assert.strictEqual(report.summary.planned, 1, JSON.stringify(report.clips[0]));
        assert.strictEqual(report.summary.written, 0);
        assert.ok(hasAutoReframe(clip), "Auto Reframe wurde im Dry-Run entfernt");
        assert.ok(
            motionPosition(clip).x === 0.5,
            "Motion wurde im Dry-Run verändert: " + motionPosition(clip).x
        );

        const record = firstClip(report);
        assert.strictEqual(record.status, "dryRun");
        assert.ok(record.drift, "keine Drift gemessen");
        assert.ok(record.drift.peakPixels > 40, "Drift: " + record.drift.peakPixels);
        assert.ok(record.write, "kein Schreibplan");
        assert.ok(record.calibration, "keine Kalibrierung");
    });

    // === The happy path ===================================================

    await t("Echter Lauf: Motion hält den Wert, Auto Reframe ist weg", async () => {
        const clip = makeClip({});
        makeSequence([clip]);
        const report = await core.runReframeLock({ dryRun: false, reference: "start" });

        assert.strictEqual(report.summary.failed, 0, JSON.stringify(report.clips[0]));
        assert.strictEqual(report.summary.written, 1);
        assert.strictEqual(firstClip(report).status, "ok");

        // Der Bildausschnitt vom Clipanfang: x = 0,68.
        const written = motionPosition(clip);
        assert.ok(Math.abs(written.x - 0.68) < 1e-6, "Motion-x: " + written.x);
        assert.ok(Math.abs(written.y - 0.5) < 1e-6, "Motion-y: " + written.y);
        assert.strictEqual(hasAutoReframe(clip), false, "Auto Reframe noch in der Kette");
    });

    await t("Der ganze Lauf ist EINE Transaktion = ein Undo-Schritt", async () => {
        const a = makeClip({ name: "a.mov" });
        const b = makeClip({ name: "b.mov" });
        makeSequence([a, b]);
        const report = await core.runReframeLock({ dryRun: false });

        assert.strictEqual(report.summary.written, 2, JSON.stringify(report.clips));
        const transactions = log.filter((e) => e.kind === "TX_BEGIN");
        assert.strictEqual(
            transactions.length,
            1,
            "erwartet 1 Transaktion, waren " + transactions.length
        );
        assert.ok(transactions[0].undoString, "kein Undo-Text gesetzt");
        assert.strictEqual(log.filter((e) => e.kind === "LOCK_ENTER").length, 1);
    });

    await t("Motion wird VOR dem Entfernen geschrieben", async () => {
        // Sonst würden die Parameter aus einer Kette gelesen, die gerade
        // mutiert wurde.
        const clip = makeClip({});
        makeSequence([clip]);
        await core.runReframeLock({ dryRun: false });
        const setValueAt = log.findIndex((e) => e.kind === "setValue");
        const removeAt = log.findIndex((e) => e.kind === "removeComponent");
        assert.ok(setValueAt !== -1 && removeAt !== -1, "Actions fehlen");
        assert.ok(setValueAt < removeAt, "Reihenfolge falsch");
    });

    await t("Skalierung wird mit eingefroren, wenn gewünscht", async () => {
        const clip = makeClip({ effect: { scale: 100 } });
        makeSequence([clip]);
        await core.runReframeLock({ dryRun: false, freezeScale: true });
        assert.strictEqual(clip.motion._p[1]._value, 100, "Motion-Skalierung nicht gesetzt");
    });

    await t("Ohne freezeScale bleibt die Motion-Skalierung unberührt", async () => {
        const clip = makeClip({});
        makeSequence([clip]);
        await core.runReframeLock({ dryRun: false, freezeScale: false });
        const scaleWrites = log.filter((e) => e.param === "Skalierung");
        assert.strictEqual(scaleWrites.length, 0, "Skalierung wurde ungefragt geschrieben");
    });

    // === Verification is not optional =====================================

    await t("REGRESSION: verworfener Schreibvorgang wird als Fehler gemeldet", async () => {
        // Premiere ignoriert die Writes -> es darf KEIN Erfolg gemeldet werden.
        const clip = makeClip({ motion: { rejectWrites: true } });
        makeSequence([clip]);
        const report = await core.runReframeLock({ dryRun: false });

        assert.strictEqual(report.summary.written, 0, "Erfolg trotz verworfener Writes!");
        assert.strictEqual(report.summary.failed, 1);
        const record = firstClip(report);
        assert.strictEqual(record.status, "error");
        assert.ok(record.reason.includes("Nachprüfung"), record.reason);
        assert.ok(record.verification.problems.length > 0);
    });

    await t("Nachprüfung belegt jeden einzelnen Teilschritt", async () => {
        const clip = makeClip({});
        makeSequence([clip]);
        const report = await core.runReframeLock({ dryRun: false });
        const checked = firstClip(report).verification.checked.join(" ");
        assert.ok(checked.includes("entfernt"), checked);
        assert.ok(checked.includes("Referenzwert"), checked);
        assert.ok(checked.includes("keine Keyframes"), checked);
    });

    await t("Fehlgeschlagene Transaktion: alle Clips als Fehler, nichts verändert", async () => {
        const clip = makeClip({});
        makeSequence([clip]);
        transactionShouldThrow = true;
        const report = await core.runReframeLock({ dryRun: false });
        assert.strictEqual(report.summary.written, 0);
        assert.strictEqual(report.summary.failed, 1);
        assert.ok(firstClip(report).reason.includes("Transaktion"), firstClip(report).reason);
        assert.ok(hasAutoReframe(clip), "Auto Reframe trotz Fehler entfernt");
    });

    // === Measurement without keyframes ====================================

    await t("KERNANNAHME: Drift wird ohne jeden Keyframe gemessen", async () => {
        /*
         * Der Parameter meldet isTimeVarying()=false und null Keyframes, sein
         * Wert ändert sich aber über die Zeit — genau der Zustand, solange
         * "Erzeugten Pfad überschreiben" aus ist. Eine Umsetzung, die auf
         * Keyframes schaut, findet hier nichts.
         */
        const clip = makeClip({});
        assert.strictEqual(clip.autoReframe._p[2].isTimeVarying(), false, "Vorbedingung");
        assert.strictEqual(clip.autoReframe._p[2].getKeyframeListAsTickTimes().length, 0);

        makeSequence([clip]);
        const report = await core.runReframeLock({ dryRun: true });
        const record = firstClip(report);
        assert.strictEqual(record.status, "dryRun", record.reason);
        assert.strictEqual(record.measurement.keyframeCount, 0);
        assert.ok(record.measurement.sampleCount > 10, "zu wenige Abtastpunkte");
        assert.ok(record.drift.peakPixels > 40, "Drift: " + record.drift.peakPixels);
    });

    await t("Statischer Clip wird übersprungen, nicht angefasst", async () => {
        const clip = makeClip({ effect: { drift: 0, generatedPath: false } });
        makeSequence([clip]);
        const report = await core.runReframeLock({ dryRun: false });
        assert.strictEqual(report.summary.skipped, 1, JSON.stringify(report.clips[0]));
        assert.strictEqual(log.length, 0, "es wurde geschrieben");
        assert.ok(firstClip(report).reason.includes("Keine Bewegung"), firstClip(report).reason);
        assert.ok(hasAutoReframe(clip), "Auto Reframe entfernt, obwohl nichts zu tun war");
    });

    await t("Keyframes vorhanden, aber Wert konstant -> Fehler statt Erfolg", async () => {
        /*
         * Wenn die API Keyframes meldet, der Wert sich aber nie ändert, gibt
         * sie den Pfad nicht heraus. Das ist etwas anderes als "kein Wackeln"
         * und darf nicht als solches gemeldet werden.
         */
        const clip = makeClip({
            effect: {
                drift: 0,
                generatedPath: false,
                appliedKeyframes: [0, S(1), S(2)]
            }
        });
        makeSequence([clip]);
        const report = await core.runReframeLock({ dryRun: false });
        assert.strictEqual(report.summary.failed, 1);
        assert.ok(firstClip(report).reason.includes("Keyframes"), firstClip(report).reason);
        assert.ok(firstClip(report).reason.includes("nicht heraus"), firstClip(report).reason);
        assert.strictEqual(log.length, 0);
    });

    await t("Konstanter angewandter Parameter: Pfad kommt aus dem erzeugten Pfad", async () => {
        const clip = makeClip({ effect: { appliedConstant: true } });
        makeSequence([clip]);
        const report = await core.runReframeLock({ dryRun: true });
        const record = firstClip(report);
        assert.strictEqual(record.measurement.sourceRole, "generatedPath", record.reason);
        assert.strictEqual(record.measurement.source, "Generated Keyframes");
        assert.ok(record.drift.peakPixels > 40);
    });

    // === Formats are measured, never assumed ==============================

    await t("Quellformat wird aus den Metadaten gemessen (16:9 in 1:1)", async () => {
        const clip = makeClip({});
        makeSequence([clip], { width: 1080, height: 1080 });
        const report = await core.runReframeLock({ dryRun: true });
        const record = firstClip(report);
        assert.deepStrictEqual(
            { w: record.sourceFrame.width, h: record.sourceFrame.height },
            { w: 1920, h: 1080 },
            "Quellformat nicht gelesen"
        );
        assert.strictEqual(record.calibration.geometry.pinnedAxis, "y");
        assert.strictEqual(record.calibration.confidence, "cross-checked");
    });

    await t("FORMATFREI: 9:16-Quelle in 16:9-Sequenz prüft die HORIZONTALE", async () => {
        /*
         * Der umgekehrte Fall. Hier liegt x fest und y wandert. Eine
         * Umsetzung mit fest eingebauter Vertikal-Prüfung scheitert hier.
         */
        const clip = makeClip({
            sourceMetadata: '{"Column.Intrinsic.VideoInfo":"1080 x 1920 (1.0)"}',
            effect: { verticalDrift: true, baseX: 0.5, baseY: 0.3, drift: 0.2 }
        });
        makeSequence([clip], { width: 1920, height: 1080 });
        const report = await core.runReframeLock({ dryRun: false });

        const record = firstClip(report);
        assert.strictEqual(record.status, "ok", record.reason);
        assert.strictEqual(record.calibration.geometry.pinnedAxis, "x");
        assert.ok(
            record.calibration.probes.some((p) => p.name === "pinnedAxis:x"),
            "horizontale Achse nicht als Prüfwert benutzt"
        );
        assert.strictEqual(hasAutoReframe(clip), false);
    });

    await t("FORMATFREI: 2.39:1-Quelle in 4:3-Sequenz", async () => {
        const clip = makeClip({
            sourceMetadata: '{"Column.Intrinsic.VideoInfo":"4096 x 1716 (1.0)"}',
            effect: { baseX: 0.45, drift: 0.1 }
        });
        makeSequence([clip], { width: 1440, height: 1080 });
        const report = await core.runReframeLock({ dryRun: false });
        assert.strictEqual(firstClip(report).status, "ok", firstClip(report).reason);
        assert.strictEqual(firstClip(report).calibration.geometry.pinnedAxis, "y");
    });

    await t("FORMATFREI: anamorphe Quelle wird über das PAR erkannt", async () => {
        // 720×576 mit PAR 1,4222 ist 16:9 — ohne PAR wäre es 5:4 und die
        // festliegende Achse würde falsch bestimmt.
        const clip = makeClip({
            sourceMetadata: '{"Column.Intrinsic.VideoInfo":"720 x 576 (1.4222)"}',
            pixelAspect: 1024 / 720
        });
        makeSequence([clip], { width: 1080, height: 1080 });
        const report = await core.runReframeLock({ dryRun: true });
        const geo = firstClip(report).calibration.geometry;
        assert.ok(Math.abs(geo.sourceAspect - 16 / 9) < 1e-3, "Seitenverhältnis: " + geo.sourceAspect);
        assert.strictEqual(geo.pinnedAxis, "y");
    });

    await t("Sequenzformat kommt aus den Sequenzeinstellungen", async () => {
        const clip = makeClip({});
        makeSequence([clip], { width: 1080, height: 1920 });
        const report = await core.runReframeLock({ dryRun: true });
        assert.deepStrictEqual(report.sequence.frame.width, 1080);
        assert.deepStrictEqual(report.sequence.frame.height, 1920);
        assert.strictEqual(report.sequence.aspectLabel, "9:16");
        // Drift in Pixeln muss die SEQUENZbreite benutzen, nicht 1080 fix.
        assert.ok(firstClip(report).drift.xPixels > 0);
    });

    await t("Unlesbares Quellformat: Kalibrierung sinkt, wird aber nicht geraten", async () => {
        const clip = makeClip({ sourceMetadata: null });
        makeSequence([clip]);
        const report = await core.runReframeLock({ dryRun: true });
        const record = firstClip(report);
        assert.strictEqual(record.sourceFrame, null, "Format wurde erfunden");
        assert.strictEqual(record.calibration.geometry.sourceAspectKnown, false);
        // Der Ankerpunkt trägt die Kalibrierung weiterhin.
        assert.strictEqual(record.calibration.convention, geometry.CONVENTION.FRAME_NORMALIZED);
    });

    await t("Unsichere Kalibrierung wird standardmäßig NICHT geschrieben", async () => {
        // Kein Quellformat und kein brauchbarer Anker -> nur schwache Prüfung.
        const clip = makeClip({
            sourceMetadata: null,
            effect: { anchor: null, baseX: 0.4, drift: 0.2 }
        });
        makeSequence([clip]);
        const report = await core.runReframeLock({ dryRun: false });
        assert.strictEqual(report.summary.written, 0, "trotz schwacher Kalibrierung geschrieben");
        assert.strictEqual(log.length, 0);
        assert.ok(firstClip(report).reason.includes("nicht belastbar"), firstClip(report).reason);
    });

    await t("Unsichere Kalibrierung auf ausdrücklichen Wunsch zulassen", async () => {
        const clip = makeClip({
            sourceMetadata: null,
            effect: { anchor: null, baseX: 0.4, drift: 0.2 }
        });
        makeSequence([clip]);
        const report = await core.runReframeLock({
            dryRun: false,
            allowWeakCalibration: true
        });
        assert.strictEqual(report.summary.written, 1, JSON.stringify(report.clips[0]));
    });

    await t("Pixel-Konvention wird erkannt und korrekt umgerechnet", async () => {
        const clip = makeClip({
            effect: { baseX: 734.4, baseY: 540, drift: 40, anchor: new PointF(540, 540) }
        });
        makeSequence([clip], { width: 1080, height: 1080 });
        const report = await core.runReframeLock({ dryRun: false, reference: "start" });
        const record = firstClip(report);
        assert.strictEqual(record.calibration.convention, geometry.CONVENTION.PIXELS, record.reason);
        const written = motionPosition(clip);
        assert.ok(Math.abs(written.x - 0.68) < 1e-4, "Motion-x: " + written.x);
        assert.ok(Math.abs(written.y - 0.5) < 1e-4, "Motion-y: " + written.y);
    });

    await t("Unbestimmbare Konvention -> Fehler, kein Schreibvorgang", async () => {
        const clip = makeClip({
            sourceMetadata: null,
            effect: { baseX: 7.3, baseY: 7.3, drift: 0.5, anchor: new PointF(9.9, 9.9) }
        });
        makeSequence([clip]);
        const report = await core.runReframeLock({ dryRun: false });
        assert.strictEqual(report.summary.failed, 1);
        assert.strictEqual(log.length, 0, "es wurde geschrieben");
        assert.ok(
            firstClip(report).reason.includes("Koordinatensystem") ||
                firstClip(report).reason.includes("nicht belastbar"),
            firstClip(report).reason
        );
    });

    // === Guards ===========================================================

    await t("Clip ohne Auto Reframe wird übersprungen und nennt die Effekte", async () => {
        const clip = makeClip({ withAutoReframe: false });
        makeSequence([clip]);
        const report = await core.runReframeLock({ dryRun: false });
        assert.strictEqual(report.summary.skipped, 1);
        assert.strictEqual(log.length, 0);
        assert.ok(firstClip(report).components, "Effektliste fehlt");
        assert.ok(
            JSON.stringify(firstClip(report).components).includes("AE.ADBE Motion"),
            "Motion fehlt in der Effektliste"
        );
    });

    await t("Veränderte Motion-Werte werden nicht stillschweigend überschrieben", async () => {
        const clip = makeClip({ motion: { position: new PointF(0.3, 0.7) } });
        makeSequence([clip]);
        const report = await core.runReframeLock({ dryRun: false });
        assert.strictEqual(report.summary.failed, 1);
        assert.strictEqual(log.length, 0, "es wurde geschrieben");
        assert.ok(firstClip(report).reason.includes("Standardwerten"), firstClip(report).reason);
        assert.strictEqual(motionPosition(clip).x, 0.3, "Position wurde verändert");
    });

    await t("Motion mit eigenen Keyframes wird geschützt", async () => {
        const clip = makeClip({ motion: { positionKeyframes: [0, S(1)] } });
        makeSequence([clip]);
        const report = await core.runReframeLock({ dryRun: false });
        assert.strictEqual(report.summary.failed, 1);
        assert.ok(firstClip(report).reason.includes("Keyframes"), firstClip(report).reason);
    });

    await t("force überschreibt vorhandene Motion-Werte und warnt dabei", async () => {
        const clip = makeClip({ motion: { position: new PointF(0.3, 0.7) } });
        makeSequence([clip]);
        const report = await core.runReframeLock({
            dryRun: false,
            force: true,
            reference: "start"
        });
        assert.strictEqual(report.summary.written, 1, JSON.stringify(report.clips[0]));
        assert.ok(
            Math.abs(motionPosition(clip).x - 0.68) < 1e-6,
            "Motion-x: " + motionPosition(clip).x
        );
        assert.ok(
            JSON.stringify(firstClip(report).warnings).includes("überschrieben"),
            "keine Warnung protokolliert"
        );
    });

    await t("Keine Auswahl -> fatalError, nichts verändert", async () => {
        const clip = makeClip({});
        makeSequence([clip], { selected: [] });
        const report = await core.runReframeLock({ dryRun: false });
        assert.ok(report.fatalError, "kein fatalError");
        assert.strictEqual(log.length, 0);
    });

    // === Effect handling ==================================================

    await t("Deaktivieren statt entfernen setzt den Schalter", async () => {
        const clip = makeClip({});
        makeSequence([clip]);
        const report = await core.runReframeLock({ dryRun: false, removeEffect: false });
        assert.strictEqual(firstClip(report).status, "ok", firstClip(report).reason);
        assert.ok(hasAutoReframe(clip), "Effekt wurde entfernt statt deaktiviert");
        assert.strictEqual(clip.autoReframe._p[0]._value, false, "Schalter nicht umgelegt");
    });

    // === Scope ============================================================

    await t("Bereich 'Spur' bearbeitet alle Clips der Spur der Auswahl", async () => {
        const v1a = makeClip({ name: "v1a.mov", trackIndex: 0 });
        const v1b = makeClip({ name: "v1b.mov", trackIndex: 0 });
        const v2 = makeClip({ name: "v2.mov", trackIndex: 1 });
        makeSequence([v1a, v1b, v2], { selected: [v1a], trackCount: 2 });

        const report = await core.runReframeLock({ dryRun: false, scope: "track" });
        assert.strictEqual(report.summary.clipsInScope, 2, "Clips: " + report.summary.clipsInScope);
        assert.strictEqual(report.summary.written, 2);
        assert.strictEqual(hasAutoReframe(v1b), false, "zweiter Clip der Spur nicht bearbeitet");
        assert.strictEqual(hasAutoReframe(v2), true, "fremde Spur wurde angefasst");
    });

    await t("Bereich 'alle Spuren' nimmt jede Videospur", async () => {
        const v1 = makeClip({ name: "v1.mov", trackIndex: 0 });
        const v2 = makeClip({ name: "v2.mov", trackIndex: 1 });
        makeSequence([v1, v2], { selected: [], trackCount: 2 });
        const report = await core.runReframeLock({ dryRun: false, scope: "allTracks" });
        assert.strictEqual(report.summary.clipsInScope, 2);
        assert.strictEqual(report.summary.written, 2);
    });

    await t("Bereich 'Spur' ohne Auswahl bricht verständlich ab", async () => {
        const clip = makeClip({});
        makeSequence([clip], { selected: [] });
        const report = await core.runReframeLock({ dryRun: false, scope: "track" });
        assert.ok(report.fatalError, "kein fatalError");
        assert.ok(report.fatalError.includes("ganze Spur"), report.fatalError);
    });

    await t("Spurnummer landet im Report (V1, V2 …)", async () => {
        const v2 = makeClip({ name: "v2.mov", trackIndex: 1 });
        makeSequence([v2], { trackCount: 2 });
        const report = await core.runReframeLock({ dryRun: true });
        assert.strictEqual(firstClip(report).trackIndex, 2);
    });

    // === Reference selection ==============================================

    await t("Referenz 'end' nimmt den Wert am Clipende", async () => {
        const clip = makeClip({});
        makeSequence([clip]);
        await core.runReframeLock({ dryRun: false, reference: "end" });
        // 0,68 + 0,04 am Ende.
        assert.ok(
            Math.abs(motionPosition(clip).x - 0.72) < 1e-3,
            "Motion-x: " + motionPosition(clip).x
        );
    });

    await t("Referenz 'median' ist die Voreinstellung", async () => {
        const clip = makeClip({});
        makeSequence([clip]);
        const report = await core.runReframeLock({ dryRun: true });
        assert.strictEqual(firstClip(report).reference.method, "median");
        assert.strictEqual(report.options.reference, "median");
    });

    await t("Referenz 'playhead' rechnet Sequenzzeit in Clipzeit um", async () => {
        const clip = makeClip({ startTicks: S(10), inTicks: 0, outTicks: S(2) });
        makeSequence([clip], { playheadTicks: S(12) });
        await core.runReframeLock({ dryRun: false, reference: "playhead" });
        // Playhead am Clipende -> 0,72.
        assert.ok(
            Math.abs(motionPosition(clip).x - 0.72) < 1e-3,
            "Motion-x: " + motionPosition(clip).x
        );
    });

    await t("Unbekannte Optionswerte fallen auf sichere Vorgaben zurück", async () => {
        const clip = makeClip({});
        makeSequence([clip]);
        const report = await core.runReframeLock({
            dryRun: true,
            scope: "evil(); //",
            reference: "../../etc/passwd"
        });
        assert.strictEqual(report.options.scope, "selection");
        assert.strictEqual(report.options.reference, "median");
    });

    // === Logging and export ===============================================

    await t("Report ist JSON-serialisierbar (keine Host-Objekte)", async () => {
        const clip = makeClip({});
        makeSequence([clip]);
        const report = await core.runReframeLock({ dryRun: false });
        const text = JSON.stringify(report);
        assert.ok(text.length > 500, "Report zu klein: " + text.length);
        assert.ok(!text.includes("_handles"), "Host-Handles im Export");
        assert.ok(text.includes('"log"'), "kein Log im Export");
        assert.ok(text.includes('"sequence"'), "keine Sequenzinfo im Export");
    });

    await t("Log enthält Host-Infos, Optionen und Dauer für Ferndiagnose", async () => {
        const clip = makeClip({});
        makeSequence([clip]);
        const report = await core.runReframeLock({ dryRun: true });
        assert.strictEqual(report.host.app, "Premiere Pro");
        assert.strictEqual(report.host.appVersion, "26.3.2");
        assert.strictEqual(report.host.uiLocale, "de_DE");
        assert.ok(report.startedAt && report.finishedAt);
        assert.ok(typeof report.durationMs === "number");
        assert.ok(report.plugin.version);
    });

    await t("Debug-Log liefert Parameter-Dump und Messkurve, info nicht", async () => {
        const clip = makeClip({});
        makeSequence([clip]);
        const quiet = await core.runReframeLock({ dryRun: true, logLevel: "info" });
        assert.strictEqual(firstClip(quiet).params, undefined, "Dump trotz logLevel=info");

        reset();
        const clip2 = makeClip({});
        makeSequence([clip2]);
        const verbose = await core.runReframeLock({ dryRun: true, logLevel: "debug" });
        assert.ok(firstClip(verbose).params, "kein Parameter-Dump");
        assert.ok(firstClip(verbose).samples, "keine Messkurve");
        assert.ok(
            firstClip(verbose).params.some((p) => p.name === "Position"),
            "Dump unvollständig"
        );
        assert.ok(verbose.log.counts.debug > 0, "keine Debug-Einträge");
    });

    await t("Parameter-Dump nennt Index, Name, Typ und Wert", async () => {
        const clip = makeClip({});
        makeSequence([clip]);
        const report = await core.runReframeLock({ dryRun: true, logLevel: "debug" });
        const entry = firstClip(report).params[3];
        assert.strictEqual(entry.index, 3);
        assert.strictEqual(entry.name, "Scale (Merged)");
        assert.strictEqual(entry.type, "number");
        assert.strictEqual(entry.value, 100);
    });

    await t("Effektkette wird vor dem Schreiben erneut geholt", async () => {
        const clip = makeClip({});
        makeSequence([clip]);
        await core.runReframeLock({ dryRun: false });
        assert.ok(
            clip.trackItem.chainFetchCount >= 3,
            "Kette nur " + clip.trackItem.chainFetchCount + "× geholt"
        );
    });

    await t("Mehrere Clips: Erfolge und Fehler werden getrennt gezählt", async () => {
        const good = makeClip({ name: "good.mov" });
        const noEffect = makeClip({ name: "plain.mov", withAutoReframe: false });
        const touched = makeClip({
            name: "moved.mov",
            motion: { position: new PointF(0.2, 0.2) }
        });
        makeSequence([good, noEffect, touched]);
        const report = await core.runReframeLock({ dryRun: false });

        assert.strictEqual(report.summary.clipsInScope, 3);
        assert.strictEqual(report.summary.written, 1, JSON.stringify(report.summary));
        assert.strictEqual(report.summary.skipped, 1);
        assert.strictEqual(report.summary.failed, 1);
        assert.strictEqual(report.clips.length, 3);
        // Ein Fehler bei einem Clip darf die anderen nicht verhindern.
        assert.strictEqual(hasAutoReframe(good), false);
        assert.strictEqual(hasAutoReframe(touched), true);
    });

    console.log(
        failures === 0
            ? "\n  ALLE TESTS BESTANDEN\n"
            : "\n  " + failures + " TEST(S) FEHLGESCHLAGEN\n"
    );
    process.exit(failures === 0 ? 0 : 1);
})();
