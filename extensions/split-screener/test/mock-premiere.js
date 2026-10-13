/**
 * Split Screener — test/mock-premiere.js
 *
 * Mocks the `premierepro` UXP module so src/core.js can be driven without
 * Premiere.
 *
 * The mock is a STATE MACHINE, not a recorder. Actions created by the
 * algorithm are really applied to the mock components and parameters when the
 * transaction commits, and inserting or removing a component really changes
 * the chain. That matters: a recorder-only harness can confirm the plugin's
 * intent but not its effect, and "reported success while Premiere changed
 * nothing" is precisely the class of bug this plugin has to defend against.
 *
 * Deliberate affordances for the failure modes we care about:
 *   - `rejectWrites` on a parameter: Premiere silently discards the write
 *   - `state.failingTransactions`: a named transaction returns false
 *   - `state.throwingTransactions`: the host throws while the transaction runs
 *   - `state.failCreate`: VideoFilterFactory refuses to create a component
 *   - `shape`: a parameter returns its value in an awkward wrapper form
 *   - `unreadable`: reading a parameter throws
 *   - `chain.hidden`: a component is in the chain but invisible to it, which
 *     is how a stale handle behaves
 *
 * KNOWN LIMIT OF THIS HARNESS
 * `createInsertComponentAction` applies its splice when the action is applied,
 * so inserting at `index` and then at `index + 1` necessarily yields
 * [Transform, Crop] here. Were Premiere to resolve both indices against the
 * pre-transaction state, the real order would be [Crop, Transform] and this
 * harness could not tell. That is not silently dangerous: `findOwnPair`
 * requires `crop.index === transform.index + 1`, so the reversed order is not
 * recognised as our pair, the run reports a read-back failure and the rollback
 * removes both components. It fails closed, but it is an assumption, not a
 * verified fact.
 *
 * Not a file matched by the test glob (`*.test.js`), so it is only loaded by
 * the test that requires it — and it must be required BEFORE src/core.js so
 * the module interception is in place.
 */

const Module = require("module");

const TICKS_PER_SECOND = 254016000000;

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

class TickTime {
    constructor(ticks) {
        this._t = ticks;
    }
    get ticksNumber() {
        return this._t;
    }
    get ticks() {
        return String(this._t);
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
    divide(d) {
        return new TickTime(Math.floor(this._t / d));
    }
    static createWithSeconds(s) {
        return new TickTime(Math.round(s * TICKS_PER_SECOND));
    }
}

class PointF {
    constructor(x, y) {
        this.x = x;
        this.y = y;
    }
}

/** Seconds to ticks, for fixtures. */
function S(seconds) {
    return Math.round(seconds * TICKS_PER_SECOND);
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** Everything the algorithm did, in order. Reset per test. */
const actionLog = [];

function resetLog() {
    actionLog.length = 0;
}

function records(kind) {
    return actionLog.filter(function (entry) {
        return entry.kind === kind;
    });
}

/** Undo labels of the transactions that actually committed, in order. */
function committedTransactions() {
    return records("TX_COMMIT").map(function (entry) {
        return entry.undoString;
    });
}

function wroteAnything() {
    return (
        records("setValue").length > 0 ||
        records("insert").length > 0 ||
        records("remove").length > 0
    );
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

class MockParam {
    /**
     * @param {string} displayName localized name, as Premiere exposes it
     * @param {*} value current value in plain form
     * @param {Object} [options]
     * @param {boolean} [options.rejectWrites] discard writes silently
     * @param {boolean} [options.timeVarying] parameter is keyframed
     * @param {boolean} [options.unreadable] reads throw
     * @param {Function} [options.shape] wraps the value on the way out
     */
    constructor(displayName, value, options) {
        const opts = options || {};
        this.displayName = displayName;
        this._value = value;
        this._tv = !!opts.timeVarying;
        this._reject = !!opts.rejectWrites;
        this._unreadable = !!opts.unreadable;
        this._shape = opts.shape || null;
        this._keyTimes = opts.keyframeTimes || [S(1), S(2)];
        this.writeCount = 0;
    }

    /** The value as the host would hand it back. */
    _out() {
        if (this._unreadable) throw new Error("Parameter nicht lesbar (Mock)");
        return this._shape ? this._shape(this._value) : this._value;
    }

    /** The value as a test wants to assert it. */
    get current() {
        return this._value;
    }

    async getStartValue() {
        return this._out();
    }

    async getValueAtTime() {
        return this._out();
    }

    isTimeVarying() {
        if (this._unreadable) throw new Error("isTimeVarying nicht lesbar (Mock)");
        return this._tv;
    }

    getKeyframeListAsTickTimes() {
        if (!this._tv) return [];
        return this._keyTimes.map(function (t) {
            return new TickTime(t);
        });
    }

    createKeyframe(value) {
        return { value: value, position: null };
    }

    createSetValueAction(keyframe, safeForPlayback) {
        const self = this;
        return {
            record: {
                kind: "setValue",
                param: this.displayName,
                value: keyframe.value,
                safe: safeForPlayback
            },
            apply: function () {
                if (self._reject) return;
                self.writeCount++;
                self._value = keyframe.value;
            }
        };
    }

    createSetTimeVaryingAction(timeVarying) {
        const self = this;
        return {
            record: { kind: "setTimeVarying", param: this.displayName, value: timeVarying },
            apply: function () {
                self._tv = timeVarying;
            }
        };
    }
}

// ---------------------------------------------------------------------------
// Components and chains
// ---------------------------------------------------------------------------

class MockComponent {
    constructor(matchName, displayName, params) {
        this.matchName = matchName;
        this.displayName = displayName;
        this.params = params;
    }
    async getMatchName() {
        return this.matchName;
    }
    async getDisplayName() {
        return this.displayName;
    }
    getParamCount() {
        return this.params.length;
    }
    getParam(index) {
        return this.params[index] || null;
    }
    /** Convenience for assertions. */
    param(name) {
        return this.params.find(function (p) {
            return p.displayName === name;
        });
    }
}

class MockChain {
    constructor(components) {
        this.components = components.slice();
        this.fetchCount = 0;
        /** Components that exist but refuse to show up — simulates a lost handle. */
        this.hidden = [];
    }

    _visible() {
        const hidden = this.hidden;
        return this.components.filter(function (c) {
            return hidden.indexOf(c) === -1;
        });
    }

    getComponentCount() {
        return this._visible().length;
    }

    getComponentAtIndex(index) {
        return this._visible()[index] || null;
    }

    createInsertComponentAction(component, index) {
        const self = this;
        return {
            record: { kind: "insert", matchName: component.matchName, index: index },
            apply: function () {
                self.components.splice(index, 0, component);
            }
        };
    }

    createRemoveComponentAction(component) {
        const self = this;
        return {
            record: { kind: "remove", matchName: component.matchName },
            apply: function () {
                const at = self.components.indexOf(component);
                if (at >= 0) self.components.splice(at, 1);
                const hiddenAt = self.hidden.indexOf(component);
                if (hiddenAt >= 0) self.hidden.splice(hiddenAt, 1);
            }
        };
    }

    /** Match names in chain order, for assertions. */
    matchNames() {
        return this._visible().map(function (c) {
            return c.matchName;
        });
    }
}

class MockTrackItem {
    constructor(options) {
        this.name = options.name;
        this.chain = options.chain;
        this.trackIndex = options.trackIndex;
        this.startTicks = options.startTicks;
        this.endTicks = options.endTicks;
        this.inTicks = options.inTicks === undefined ? S(0) : options.inTicks;
        this.failTimes = !!options.failTimes;
        this.failChain = !!options.failChain;
        this.noChain = !!options.noChain;
        if (this.noChain) this.getComponentChain = undefined;
    }

    async getName() {
        return this.name;
    }

    async getComponentChain() {
        if (this.failChain) throw new Error("Effektkette nicht lesbar (Mock)");
        this.chain.fetchCount++;
        return this.chain;
    }

    async getTrackIndex() {
        return this.trackIndex;
    }

    async getStartTime() {
        if (this.failTimes) throw new Error("Startzeit nicht lesbar (Mock)");
        return new TickTime(this.startTicks);
    }

    async getEndTime() {
        if (this.failTimes) throw new Error("Endzeit nicht lesbar (Mock)");
        return new TickTime(this.endTicks);
    }

    async getInPoint() {
        return new TickTime(this.inTicks);
    }
}

// ---------------------------------------------------------------------------
// Project, sequence, factory
// ---------------------------------------------------------------------------

const state = {
    project: null,
    /** Undo labels whose transaction should return false. */
    failingTransactions: [],
    /** Undo labels whose transaction should throw. */
    throwingTransactions: [],
    /** When true, VideoFilterFactory.createComponent rejects. */
    failCreate: false,
    /** Match names the host claims to offer. */
    availableMatchNames: [
        "AE.ADBE Mosaic",
        "AE.ADBE Crop",
        "AE.ADBE Geometry2",
        "AE.ADBE AEFilterAutoFramer",
        "PR.ADBE Lumetri"
    ],
    /** Components created by the factory, in order. */
    created: []
};

function makeProject(sequence) {
    return {
        async getActiveSequence() {
            return sequence;
        },
        lockedAccess(callback) {
            actionLog.push({ kind: "LOCK_ENTER" });
            try {
                callback();
            } finally {
                actionLog.push({ kind: "LOCK_EXIT" });
            }
        },
        executeTransaction(callback, undoString) {
            actionLog.push({ kind: "TX_BEGIN", undoString: undoString });

            const queued = [];
            callback({
                addAction: function (action) {
                    actionLog.push(action.record);
                    queued.push(action);
                }
            });

            if (state.throwingTransactions.indexOf(undoString) !== -1) {
                actionLog.push({ kind: "TX_THROW", undoString: undoString });
                throw new Error("Transaktion abgelehnt (Mock): " + undoString);
            }
            if (state.failingTransactions.indexOf(undoString) !== -1) {
                actionLog.push({ kind: "TX_FAIL", undoString: undoString });
                return false;
            }

            for (let i = 0; i < queued.length; i++) queued[i].apply();
            actionLog.push({ kind: "TX_COMMIT", undoString: undoString });
            return true;
        }
    };
}

/** Builds the Transform effect a fresh insertion would produce. */
function makeTransformComponent(options) {
    const opts = options || {};
    const centre = opts.positionValue || new PointF(0.5, 0.5);
    const params = [
        new MockParam(
            opts.anchorName === undefined ? "Ankerpunkt" : opts.anchorName,
            new PointF(0.5, 0.5)
        ),
        new MockParam(
            opts.positionName === undefined ? "Position" : opts.positionName,
            centre,
            opts.positionOptions || {}
        ),
        new MockParam("Gleichmäßig skalieren", true),
        new MockParam("Skalierung", 100),
        new MockParam("Drehung", 0),
        new MockParam("Deckkraft", 100)
    ];
    // Injected in front of the position, so a structural probe that is too
    // generous would pick these instead.
    if (opts.extraParamsFirst) {
        params.unshift.apply(params, opts.extraParamsFirst);
    }
    return new MockComponent("AE.ADBE Geometry2", "Transformieren", params);
}

/** Builds the Crop effect a fresh insertion would produce. */
function makeCropComponent(options) {
    const opts = options || {};
    const names = opts.names || ["Links", "Oben", "Rechts", "Unten"];
    const params = [
        new MockParam(names[0], 0, opts.paramOptions || {}),
        new MockParam(names[1], 0, opts.paramOptions || {}),
        new MockParam(names[2], 0, opts.paramOptions || {}),
        new MockParam(names[3], 0, opts.paramOptions || {})
    ];
    if (!opts.withoutZoom) params.push(new MockParam("Zoom", false));
    return new MockComponent("AE.ADBE Crop", "Zuschneiden", params);
}

const VideoFilterFactory = {
    async getMatchNames() {
        return state.availableMatchNames.slice();
    },
    async getDisplayNames() {
        return state.availableMatchNames.slice();
    },
    async createComponent(matchName) {
        if (state.failCreate) throw new Error("createComponent abgelehnt (Mock)");
        let component;
        if (matchName === "AE.ADBE Geometry2") {
            component = makeTransformComponent(state.transformOptions);
        } else if (matchName === "AE.ADBE Crop") {
            component = makeCropComponent(state.cropOptions);
        } else {
            component = new MockComponent(matchName, matchName, []);
        }
        state.created.push(component);
        return component;
    }
};

const pproMock = {
    PointF: PointF,
    TickTime: TickTime,
    VideoFilterFactory: VideoFilterFactory,
    Project: {
        async getActiveProject() {
            return state.project;
        }
    }
};

// ---------------------------------------------------------------------------
// Module interception
// ---------------------------------------------------------------------------

const originalLoad = Module._load;
Module._load = function (request) {
    if (request === "premierepro") return pproMock;
    if (request === "uxp") {
        return {
            host: { name: "PremierePro", version: "26.3.2", uiLocale: "de_DE" },
            versions: { uxp: "8.1.0" },
            entrypoints: { setup() {} }
        };
    }
    return originalLoad.apply(this, arguments);
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Builds the intrinsic components of a video clip.
 *
 * Premiere is expected to keep the intrinsics at the front of the chain, which
 * is why `intrinsicsLast` exists: the insertion index logic has to work in
 * both layouts and only a test can prove it.
 */
function makeMotionComponent(options) {
    const opts = options || {};
    const names = Object.assign(
        {
            position: "Position",
            scale: "Skalierung",
            uniform: "Gleichmäßig skalieren",
            scaleWidth: "Skalierungsbreite",
            rotation: "Drehung",
            anchor: "Ankerpunkt"
        },
        opts.names || {}
    );

    const params = [
        new MockParam(
            names.position,
            opts.position || new PointF(0.5, 0.5),
            opts.positionOptions || {}
        ),
        new MockParam(
            names.scale,
            opts.scale === undefined ? 100 : opts.scale,
            opts.scaleOptions || {}
        ),
        new MockParam(
            names.uniform,
            opts.uniform === undefined ? true : opts.uniform,
            opts.uniformOptions || {}
        ),
        new MockParam(
            names.scaleWidth,
            opts.scaleWidth === undefined ? 100 : opts.scaleWidth
        ),
        new MockParam(names.rotation, opts.rotation === undefined ? 0 : opts.rotation),
        new MockParam(names.anchor, opts.anchor || new PointF(0.5, 0.5))
    ];

    if (opts.dropParam) {
        for (let i = params.length - 1; i >= 0; i--) {
            if (params[i].displayName === opts.dropParam) params.splice(i, 1);
        }
    }

    return new MockComponent("AE.ADBE Motion", "Bewegung", params);
}

/**
 * Builds one video clip.
 *
 * @param {Object} options
 * @param {string} options.name
 * @param {number} options.trackIndex
 * @param {number} [options.startTicks] sequence start, default 1 s
 * @param {number} [options.endTicks] sequence end, default 3 s
 * @param {Object} [options.motion] see makeMotionComponent
 * @param {MockComponent[]} [options.effectsBefore] user effects before ours
 * @param {MockComponent[]} [options.effectsAfter] user effects after ours
 * @param {boolean} [options.withOwnPair] pre-existing split screen
 * @param {boolean} [options.intrinsicsLast] intrinsics at the end of the chain
 * @param {boolean} [options.audio] audio clip (no video intrinsics)
 */
function makeClip(options) {
    const opts = options || {};

    const intrinsics = opts.audio
        ? [
              new MockComponent("AE.ADBE Volume", "Lautstärke", []),
              new MockComponent("AE.ADBE Panner", "Panner", [])
          ]
        : [
              new MockComponent("AE.ADBE Opacity", "Deckkraft", [
                  new MockParam("Deckkraft", 100)
              ]),
              makeMotionComponent(opts.motion)
          ];

    const standard = [];
    if (opts.effectsBefore) standard.push.apply(standard, opts.effectsBefore);

    let ownTransform = null;
    let ownCrop = null;
    if (opts.withOwnPair) {
        ownTransform = makeTransformComponent(opts.ownPairOptions);
        ownCrop = makeCropComponent(opts.ownPairOptions);
        standard.push(ownTransform, ownCrop);
    }

    if (opts.effectsAfter) standard.push.apply(standard, opts.effectsAfter);

    const components = opts.intrinsicsLast
        ? standard.concat(intrinsics)
        : intrinsics.concat(standard);

    const chain = new MockChain(components);
    const clip = new MockTrackItem({
        name: opts.name || "clip.mov",
        chain: chain,
        trackIndex: opts.trackIndex === undefined ? 0 : opts.trackIndex,
        startTicks: opts.startTicks === undefined ? S(1) : opts.startTicks,
        endTicks: opts.endTicks === undefined ? S(3) : opts.endTicks,
        inTicks: opts.inTicks,
        failTimes: opts.failTimes,
        failChain: opts.failChain,
        noChain: opts.noChain
    });

    clip.ownTransform = ownTransform;
    clip.ownCrop = ownCrop;
    clip.motionComponent = opts.audio ? null : intrinsics[1];
    return clip;
}

/** A congruent pair on V1 and V2, the normal case. */
function makePair(options) {
    const opts = options || {};
    const lower = makeClip(
        Object.assign({ name: "unten.mov", trackIndex: 0 }, opts.lower || {})
    );
    const upper = makeClip(
        Object.assign({ name: "oben.mov", trackIndex: 1 }, opts.upper || {})
    );
    return [lower, upper];
}

/** Installs a selection and returns the sequence mock. */
function selectClips(clips, options) {
    const opts = options || {};
    const sequence = {
        name: opts.sequenceName || "Sequenz 01",
        async getFrameSize() {
            if (opts.failFrameSize) throw new Error("Framegröße nicht lesbar (Mock)");
            return {
                width: opts.width === undefined ? 1920 : opts.width,
                height: opts.height === undefined ? 1080 : opts.height
            };
        },
        async getSelection() {
            if (opts.noSelection) return null;
            return {
                async getTrackItems() {
                    return clips;
                }
            };
        }
    };
    state.project = makeProject(sequence);
    return sequence;
}

/** Resets every piece of mutable mock state. Call at the start of each test. */
function reset() {
    resetLog();
    state.project = null;
    state.failingTransactions = [];
    state.throwingTransactions = [];
    state.failCreate = false;
    state.created = [];
    state.transformOptions = null;
    state.cropOptions = null;
    state.availableMatchNames = [
        "AE.ADBE Mosaic",
        "AE.ADBE Crop",
        "AE.ADBE Geometry2",
        "AE.ADBE AEFilterAutoFramer",
        "PR.ADBE Lumetri"
    ];
}

module.exports = {
    S,
    TickTime,
    PointF,
    MockParam,
    MockComponent,
    MockChain,
    actionLog,
    records,
    committedTransactions,
    wroteAnything,
    state,
    makeMotionComponent,
    makeTransformComponent,
    makeCropComponent,
    makeClip,
    makePair,
    selectClips,
    reset
};
