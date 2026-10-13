/** A deliberately limited host model, not evidence of real Auto Reframe
 * behaviour. Enforces COMMITTED stopwatch state at action creation time and
 * models applied Position as a derived output distinct from Adjust Position.
 */
const Module = require("node:module");
const assert = require("node:assert/strict");
const V = require("../src/values.js");
const TPS = 254016000000;
const clone = (value) => JSON.parse(JSON.stringify(value));

class TickTime {
    constructor(seconds) { this.seconds = seconds; }
    get ticksNumber() { return Math.round(this.seconds * TPS); }
    get ticks() { return String(this.ticksNumber); }
    static createWithSeconds(seconds) { return new TickTime(seconds); }
}
class PointF {
    constructor(x, y) { this.x = x; this.y = y; }
}

const state = { project: null, locked: false, log: [] };

class Param {
    constructor(name, value, keys = []) {
        this.displayName = name;
        this.value = value;
        this.keys = clone(keys);
        this.varying = keys.length > 0;
        this.reject = null;
        this.beforeRead = () => {};
        this.afterWrite = () => {};
        this.shape = (value) => value;
    }
    isTimeVarying() { this.beforeRead(); return this.varying; }
    getKeyframeListAsTickTimes() { this.beforeRead(); return this.keys.map((key) => new TickTime(key.time)); }
    async areKeyframesSupported() { return true; }
    at(seconds) {
        this.beforeRead();
        if (!this.varying || !this.keys.length) return this.value;
        if (seconds <= this.keys[0].time) return this.keys[0].value;
        for (let i = 1; i < this.keys.length; i++) {
            if (seconds <= this.keys[i].time) {
                const a = this.keys[i - 1], b = this.keys[i];
                const f = (seconds - a.time) / (b.time - a.time);
                return { x: a.value.x + (b.value.x - a.value.x) * f,
                    y: a.value.y + (b.value.y - a.value.y) * f };
            }
        }
        return this.keys[this.keys.length - 1].value;
    }
    async getValueAtTime(time) { return this.shape(this.at(time.seconds)); }
    async getStartValue() { return { value: this.shape(this.varying && this.keys.length ? this.keys[0].value : this.value) }; }
    createKeyframe(value) { assert.ok(state.locked); return { value: value, position: null }; }
    action(kind, value, apply) {
        assert.ok(state.locked, "Actions must be created under lock");
        return { kind: kind, param: this.displayName, value: value, apply: () => {
            if (this.reject === kind) return;
            apply(); this.afterWrite(kind, value);
        } };
    }
    createSetTimeVaryingAction(flag) {
        return this.action(flag ? "on" : "off", flag, () => {
            this.varying = flag;
            if (!flag) this.keys = [];
        });
    }
    createSetValueAction(keyframe) {
        assert.equal(this.varying, false, "setValue requires a previously committed stopwatch-off");
        return this.action("set", keyframe.value, () => { this.value = keyframe.value; });
    }
    createAddKeyframeAction(keyframe) {
        assert.equal(this.varying, true, "addKeyframe requires a previously committed stopwatch-on");
        return this.action("key", { time: keyframe.position.seconds, value: keyframe.value }, () => {
            this.keys = this.keys.filter((key) => key.time !== keyframe.position.seconds);
            this.keys.push({ time: keyframe.position.seconds, value: keyframe.value });
            this.keys.sort((a, b) => a.time - b.time);
        });
    }
}

class Component {
    constructor(params, matchName = "AE.ADBE AEFilterAutoFramer", name = "Auto Reframe") {
        this.params = params; this.matchName = matchName; this.name = name;
    }
    async getMatchName() { return this.matchName; }
    async getDisplayName() { return this.name; }
    getParamCount() { return this.params.length; }
    getParam(i) { return this.params[i]; }
}

function makeClip(options = {}) {
    const keys = options.keys || [
        { time: 0, value: { x: 0.1, y: 0.2 } },
        { time: 10, value: { x: 0.4, y: 0.5 } },
        { time: 11, value: { x: 0.6, y: 0.7 } },
        { time: 12, value: { x: 0.8, y: 0.9 } },
        { time: 20, value: { x: 0.9, y: 1 } }
    ];
    const adjust = new Param("Position anpassen", { x: 0, y: 0 }, options.override ? keys : []);
    const generated = new Param("Generated Keyframes", { x: 0, y: 0 }, keys);
    const override = new Param(options.namedOverride ? "Erzeugten Pfad überschreiben" : "", !!options.override);
    const applied = new Param("Position", { x: 0.5, y: 0.5 });
    let transferAt = Infinity;
    adjust.beforeRead = () => {
        if (Date.now() >= transferAt) {
            transferAt = Infinity;
            adjust.keys = clone(generated.keys); adjust.varying = true;
        }
    };
    override.afterWrite = () => {
        if (options.transfer !== false) transferAt = Date.now() + (options.transferDelay || 0);
    };
    applied.at = (seconds) => {
        const path = override.value && options.ignoreOverride !== true ? adjust : generated;
        const p = path.at(seconds);
        return { x: p.x + 0.12, y: p.y - 0.1 };
    };
    const params = [
        new Param(" ", false), new Param("Motion-Tracking", 1), applied,
        new Param("Scale (Merged)", 100), new Param("Uniform Scale", true),
        new Param("Anchor Point", { x: 0.5, y: 0.5 }), adjust, generated, override,
        new Param("Hash arb data", "internal"), new Param("Reframing für Versatz", { x: 0.12, y: -0.1 }),
        new Param("Reframing für Skalierung", 100), new Param("Scale (Auto Generated)", 100),
        new Param("Reframing für Drehung", 0)
    ];
    const effect = new Component(params);
    const components = options.noEffect ? [new Component([], "AE.ADBE Volume", "Lautstärke")] : [effect];
    const clip = {
        components: components, effect: effect, adjust: adjust, applied: applied, override: override, generated: generated,
        chainReads: 0,
        async getName() { return options.name || "Podcast.mov"; },
        async getComponentChain() {
            this.chainReads++;
            return { getComponentCount: () => components.length, getComponentAtIndex: (i) => components[i] };
        },
        async getInPoint() { return new TickTime(options.inPoint ?? 10); },
        async getOutPoint() { return new TickTime(options.outPoint ?? 12); },
        async getStartTime() { return new TickTime(options.start ?? 100); },
        async getEndTime() { return new TickTime(options.end ?? 102); },
        async getSpeed() { return options.speed ?? 1; },
        async isSpeedReversed() { return options.reversed ?? 0; }
    };
    if (options.shape) for (const param of params) param.shape = options.shape;
    return clip;
}

function install(clips, options = {}) {
    state.log = [];
    state.locked = false;
    const history = [];
    const sequence = {
        async getSelection() { return { getTrackItems: async () => clips }; },
        async getPlayerPosition() { return new TickTime(options.playhead ?? 101); },
        async getSettings() { return { getVideoFrameRate: () => ({ value: options.fps ?? 25 }) }; }
    };
    const project = {
        history: history,
        reject: null, throwAt: null, rejectAdd: null,
        async getActiveSequence() { return sequence; },
        lockedAccess(callback) {
            state.locked = true;
            try { assert.equal(callback() instanceof Promise, false); }
            finally { state.locked = false; }
        },
        executeTransaction(callback, label) {
            const actions = [];
            assert.equal(callback({ addAction: (action) => {
                if (this.rejectAdd === action.kind) return false;
                actions.push(action); return true;
            } }) instanceof Promise, false);
            if (actions.some((action) => action.kind === this.throwAt)) throw new Error("Host transaction error");
            if (actions.some((action) => action.kind === this.reject)) return false;
            if (!actions.length) return false;
            const saved = clips.flatMap((clip) => clip.components.flatMap((component) => component.params.map((param) =>
                ({ param: param, value: clone(param.value), keys: clone(param.keys), varying: param.varying }))));
            for (const action of actions) {
                state.log.push({ kind: action.kind, param: action.param, value: action.value, label: label });
                action.apply();
            }
            history.push(saved);
            return true;
        },
        undo() {
            for (const entry of history.pop()) {
                entry.param.value = entry.value; entry.param.keys = entry.keys; entry.param.varying = entry.varying;
            }
        }
    };
    state.project = project;
    return project;
}

const originalLoad = Module._load;
Module._load = function (request) {
    if (request === "premierepro") return { PointF, TickTime, Project: { getActiveProject: async () => state.project } };
    if (request === "uxp") return { host: { name: "Premiere Pro mock", version: "26.3.2", uiLocale: "de_DE" } };
    return originalLoad.apply(this, arguments);
};

module.exports = { makeClip, install, state, Param, Component, TickTime, PointF, clone, normalize: V.normalize };
