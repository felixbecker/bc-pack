/**
 * The tutorial's workflow, using UXP actions:
 * override -> read Adjust Position -> stopwatch off -> static value ->
 * stopwatch on -> one keyframe. Each transition is committed and checked.
 *
 * Only Override and Adjust Position are written. The merged Position is read
 * to check reference framing and sampled output, never used as a write target.
 * These parameter checks do not replace a visual acceptance test in Premiere.
 */
const ppro = require("premierepro");
const V = require("./values.js");
const { referenceTimes } = require("./timing.js");

const PLUGIN_VERSION = "1.1.0";
const DIAGNOSTICS_VERSION = 10;
const TIMING = { START: "start", MIDDLE: "middle", END: "end", PLAYHEAD: "playhead" };
const EFFECT = "AE.ADBE AEFilterAutoFramer";
const EFFECT_NAMES = ["auto reframe", "ai reframe", "automatische neuformatierung"];
const PARAM_NAMES = {
    override: ["overwrite generated path", "override generated path", "override generated pan",
        "erzeugten pfad überschreiben", "generierten pfad überschreiben"],
    adjust: ["adjust position", "position anpassen"],
    applied: ["position"]
};
const STEP = {
    OVERRIDE: "override", PATH: "editable-path", OFF: "stopwatch-off",
    STATIC: "static-value", ON: "stopwatch-on", KEY: "single-keyframe", VERIFY: "verify"
};
const LABELS = {
    override: "Pfad überschreiben", "editable-path": "Bearbeitbaren Pfad lesen",
    "stopwatch-off": "Stoppuhr ausschalten", "static-value": "Referenzwert setzen",
    "stopwatch-on": "Stoppuhr einschalten", "single-keyframe": "Einen Keyframe setzen",
    verify: "Parameter nachprüfen"
};
const EPSILON = 1e-6; // raw parameter units, NOT a claimed pixel tolerance
const PATH_READS = 11;
const PATH_READ_INTERVAL_MS = 100;
const VERIFY_DELAY_MS = 300;
const normalizeName = (name) => String(name || "").trim().toLowerCase();
const describeError = (error) => error && error.message ? error.message : String(error);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hostInfo() {
    try {
        const { host } = require("uxp");
        return { app: host.name, appVersion: host.version, uiLocale: host.uiLocale };
    } catch {
        return {};
    }
}

function paramIndex(component, names) {
    for (const name of names) {
        for (let i = 0; i < component.getParamCount(); i++) {
            if (normalizeName(component.getParam(i).displayName) === name) return i;
        }
    }
    return -1;
}

/** Diagnostic reads may fail; algorithmic reads below must never hide failure. */
async function dumpParams(component) {
    const result = [];
    for (let i = 0; i < component.getParamCount(); i++) {
        const entry = { index: i };
        try {
            const param = component.getParam(i);
            entry.name = param.displayName;
            entry.timeVarying = param.isTimeVarying();
            entry.keyframes = keyTimes(param).length;
            entry.value = V.normalize(await param.getStartValue());
        } catch (error) {
            entry.error = describeError(error);
        }
        result.push(entry);
    }
    return result;
}

async function locate(trackItem) {
    const chain = await trackItem.getComponentChain();
    if (!chain) throw new Error("Effektkette nicht lesbar.");
    const components = [];
    const matches = [];
    for (let i = 0; i < chain.getComponentCount(); i++) {
        const component = chain.getComponentAtIndex(i);
        if (!component) throw new Error("Komponente " + i + " nicht lesbar.");
        const matchName = await component.getMatchName();
        const name = await component.getDisplayName();
        components.push({ index: i, matchName: matchName, name: name });
        const compact = normalizeName(matchName).replace(/[\s._-]/g, "");
        if (compact.includes("autoframer") || compact.includes("autoreframe") ||
            EFFECT_NAMES.includes(normalizeName(name))) matches.push(i);
    }
    if (matches.length > 1) throw new Error("Mehrere Auto-Reframe-Effekte auf einem Clip sind nicht eindeutig.");
    return { chain: chain, index: matches.length ? matches[0] : -1, components: components };
}

function resolveParams(found) {
    const component = found.chain.getComponentAtIndex(found.index);
    const indexes = {};
    for (const role of Object.keys(PARAM_NAMES)) indexes[role] = paramIndex(component, PARAM_NAMES[role]);

    // Index 8 is nameless on 26.3.2/de_DE. Accept that measured layout only,
    // including its neighbouring named fields, not any boolean at index 8.
    let overrideResolvedBy = "name";
    if (indexes.override < 0 &&
        normalizeName(found.components[found.index].matchName) === normalizeName(EFFECT) &&
        component.getParamCount() >= 14 && indexes.applied === 2 && indexes.adjust === 6 &&
        ["generated keyframes", "erzeugte keyframes"].includes(normalizeName(component.getParam(7).displayName)) &&
        normalizeName(component.getParam(8).displayName) === "") {
        indexes.override = 8;
        overrideResolvedBy = "index-26.3-layout";
    }
    const missing = Object.keys(indexes).filter((role) => indexes[role] < 0);
    if (missing.length) {
        throw new Error("Parameter nicht gefunden: " + missing.map((role) =>
            ({ override: "Erzeugten Pfad überschreiben", adjust: "Position anpassen", applied: "Position (Ausgabe)" })[role]).join(", ") +
            ". Keine Ausweichschreibzugriffe auf andere Positionsparameter.");
    }
    return { indexes: indexes, overrideResolvedBy: overrideResolvedBy };
}

function keyTimes(param) {
    const times = param.getKeyframeListAsTickTimes();
    if (!Array.isArray(times)) throw new Error("Keyframe-Liste nicht lesbar.");
    for (const time of times) {
        if (!time || !Number.isFinite(time.seconds)) throw new Error("Ungültige Keyframe-Zeit.");
    }
    return times.slice().sort((a, b) => a.seconds - b.seconds);
}

function paramAt(found, role) {
    const component = found.chain.getComponentAtIndex(found.index);
    const param = component && component.getParam(found.indexes[role]);
    if (!param) throw new Error("Parameter nicht mehr verfügbar: " + role);
    return param;
}

async function read(found, role, time) {
    const raw = await paramAt(found, role).getValueAtTime(time);
    const value = V.normalize(raw);
    if (role === "override" ? typeof value !== "boolean" : !V.isPoint(value)) {
        throw new Error("Unlesbarer Wert für " + role + ": " + V.describe(raw));
    }
    return value;
}

async function refresh(plan) {
    const found = await locate(plan.trackItem);
    if (found.index < 0) throw new Error("Auto Reframe ist nicht mehr vorhanden.");
    return Object.assign(found, resolveParams(found));
}

function assertPoint(actual, expected, label) {
    if (!V.close(actual, expected, EPSILON)) {
        throw new Error(label + ": erwartet " + JSON.stringify(expected) +
            ", gelesen " + JSON.stringify(actual) + ".");
    }
}

async function snapshot(plan, found) {
    const adjust = paramAt(found, "adjust");
    const varying = adjust.isTimeVarying();
    if (typeof varying !== "boolean") throw new Error("Stoppuhr-Zustand nicht lesbar.");
    const keys = keyTimes(adjust);
    return {
        override: await read(found, "override", plan.time),
        varying: varying,
        keys: keys.map((t) => t.seconds),
        adjust: await read(found, "adjust", plan.time),
        applied: await read(found, "applied", plan.time)
    };
}

/** One action per transaction: no action can depend on an uncommitted toggle. */
async function writeStep(project, plan, step) {
    const found = await refresh(plan);
    const before = await snapshot(plan, found);
    if (step !== STEP.OVERRIDE && !before.override) throw new Error("Override ist nicht mehr aktiv.");
    if (step === STEP.OFF) {
        if (!before.varying || !before.keys.length) throw new Error("Bearbeitbarer Pfad ist nicht mehr verfügbar.");
        assertPoint(before.adjust, plan.value, "Referenzwert hat sich seit dem Lesen geändert");
    }
    if ((step === STEP.STATIC || step === STEP.ON) && (before.varying || before.keys.length)) {
        throw new Error("Stoppuhr wurde erneut aktiviert; Fixierung abgebrochen.");
    }
    if (step === STEP.KEY && (!before.varying || before.keys.length !== 0)) {
        throw new Error("Unerwarteter Pfad nach dem Einschalten der Stoppuhr.");
    }

    // Refresh again after async reads. Params/actions are obtained under lock.
    const fresh = await refresh(plan);
    let committed = false;
    let added = false;
    const label = "Smooth Auto Frame — " + plan.result.clipName + " — " + LABELS[step];
    project.lockedAccess(() => {
        committed = project.executeTransaction((compoundAction) => {
            const component = fresh.chain.getComponentAtIndex(fresh.index);
            const role = step === STEP.OVERRIDE ? "override" : "adjust";
            const param = component.getParam(fresh.indexes[role]);
            if (step === STEP.OFF || step === STEP.ON) {
                added = compoundAction.addAction(param.createSetTimeVaryingAction(step === STEP.ON));
            } else if (step === STEP.KEY) {
                const keyframe = param.createKeyframe(new ppro.PointF(plan.value.x, plan.value.y));
                keyframe.position = plan.time;
                added = compoundAction.addAction(param.createAddKeyframeAction(keyframe));
            } else {
                const value = step === STEP.OVERRIDE ? true : new ppro.PointF(plan.value.x, plan.value.y);
                // This boolean means safeForPlayback, NOT ExtendScript's updateUI.
                added = compoundAction.addAction(param.createSetValueAction(param.createKeyframe(value), true));
            }
        }, label);
    });
    if (!committed || !added) throw new Error("Premiere hat den Schreibschritt nicht übernommen: " + LABELS[step]);
    plan.result.undoSteps++;
    plan.result.steps.push({ step: step, label: LABELS[step], committed: true });
}

/** Bounded READ-only wait for the editable path. No repeated override writes. */
async function awaitEditablePath(plan) {
    for (let attempt = 0; attempt < PATH_READS; attempt++) {
        const found = await refresh(plan);
        const state = await snapshot(plan, found);
        plan.result.pathReadAttempts = attempt + 1;
        plan.result.afterOverride = state;
        if (!state.override) throw new Error("Die Override-Checkbox ist nach dem Setzen nicht aktiv.");
        if (state.varying && state.keys.length) {
            assertPoint(state.applied, plan.before.applied, "Override hat den Referenzausschnitt verändert");
            return state;
        }
        if (attempt + 1 < PATH_READS) await delay(PATH_READ_INTERVAL_MS);
    }
    throw new Error("Override ist aktiv, aber „Position anpassen“ hat keinen bearbeitbaren Keyframe-Pfad. " +
        "Es wurde kein Positionswert ersetzt. Zum Eingrenzen Override in Premiere manuell aktivieren, " +
        "die Keyframes prüfen und erneut ausführen.");
}

async function verify(plan) {
    const found = await refresh(plan);
    const state = await snapshot(plan, found);
    plan.result.after = state;
    if (!state.override || !state.varying || state.keys.length !== 1) {
        throw new Error("Erwartet: Override aktiv, Stoppuhr an und genau ein Keyframe. Gelesen: " + JSON.stringify(state));
    }
    if (Math.abs(state.keys[0] - plan.time.seconds) > 1e-7) {
        throw new Error("Der einzelne Keyframe liegt nicht am Referenzzeitpunkt.");
    }
    const samples = [];
    for (const time of plan.sampleTimes) {
        const current = await refresh(plan);
        const adjust = await read(current, "adjust", time);
        const applied = await read(current, "applied", time);
        samples.push({ seconds: time.seconds, adjust: adjust, applied: applied });
        // Keep even a failed comparison in the exported diagnostics.
        plan.result.verificationSamples = samples;
        assertPoint(adjust, plan.value, "Position anpassen bei " + time.seconds + " s");
        assertPoint(applied, plan.before.applied, "Angewandte Position bei " + time.seconds + " s");
    }
    return state;
}

async function processClip(project, frameDuration, playhead, trackItem, options) {
    const result = { clipName: "(unbenannter Clip)", status: "error", stage: "discovery", undoSteps: 0, steps: [] };
    const plan = { trackItem: trackItem, result: result };
    try {
        result.clipName = (await trackItem.getName()) || result.clipName;
        if (typeof trackItem.getComponentChain !== "function") {
            result.status = "skipped";
            result.reason = "Kein Videoclip.";
            return result;
        }
        const found = await locate(trackItem);
        result.components = found.components;
        if (found.index < 0) {
            result.status = "skipped";
            result.reason = "Kein Auto-Reframe-Effekt auf diesem Clip.";
            return result;
        }
        result.params = await dumpParams(found.chain.getComponentAtIndex(found.index));
        Object.assign(found, resolveParams(found));
        result.overrideResolvedBy = found.overrideResolvedBy;
        result.parameters = found.indexes;

        result.stage = "reference-time";
        const inPoint = await trackItem.getInPoint();
        const outPoint = await trackItem.getOutPoint();
        const start = await trackItem.getStartTime();
        const end = await trackItem.getEndTime();
        const speed = await trackItem.getSpeed();
        const reversed = await trackItem.isSpeedReversed();
        const times = referenceTimes({
            inPoint: inPoint.seconds, outPoint: outPoint.seconds,
            start: start.seconds, end: end.seconds, frameDuration: frameDuration,
            playhead: playhead, timing: options.timing, speed: speed, reversed: reversed
        });
        plan.time = ppro.TickTime.createWithSeconds(times.reference);
        plan.sampleTimes = times.samples.map((s) => ppro.TickTime.createWithSeconds(s));
        result.reference = times;
        plan.before = await snapshot(plan, await refresh(plan));
        result.before = plan.before;
        if (paramAt(await refresh(plan), "override").isTimeVarying()) {
            throw new Error("Die Override-Checkbox ist animiert; dieser Zustand wird nicht unterstützt.");
        }
        if (!await paramAt(await refresh(plan), "adjust").areKeyframesSupported()) {
            throw new Error("Position anpassen unterstützt laut Host keine Keyframes.");
        }

        if (options.dryRun) {
            result.status = "dry-run";
            result.reason = plan.before.override && plan.before.varying && plan.before.keys.length
                ? "Dry-Run: Referenzwert lesbar; der Schreibablauf wurde nicht ausgeführt."
                : "Dry-Run: Parameter gefunden. Der Referenzwert ist erst nach Freigabe des bearbeitbaren Pfads belastbar.";
            if (plan.before.override && plan.before.varying && plan.before.keys.length) {
                result.changes = [{ param: "Position anpassen", value: JSON.stringify(plan.before.adjust), keyframesBefore: plan.before.keys.length }];
            }
            return result;
        }

        result.stage = STEP.OVERRIDE;
        if (!plan.before.override) await writeStep(project, plan, STEP.OVERRIDE);
        else result.steps.push({ step: STEP.OVERRIDE, label: "Override war bereits aktiv", committed: false });

        result.stage = STEP.PATH;
        const editable = await awaitEditablePath(plan);
        plan.value = editable.adjust;
        result.changes = [{ param: "Position anpassen", value: JSON.stringify(plan.value), keyframesBefore: editable.keys.length }];
        result.steps.push({ step: STEP.PATH, label: LABELS[STEP.PATH], value: plan.value, keyframes: editable.keys.length });

        result.stage = STEP.OFF;
        await writeStep(project, plan, STEP.OFF);
        let state = await snapshot(plan, await refresh(plan));
        if (state.varying || state.keys.length) throw new Error("Die Stoppuhr ließ sich nicht ausschalten beziehungsweise Keyframes blieben erhalten.");

        result.stage = STEP.STATIC;
        await writeStep(project, plan, STEP.STATIC);
        state = await snapshot(plan, await refresh(plan));
        if (state.varying || state.keys.length) throw new Error("Der statische Zustand wurde nicht beibehalten.");
        assertPoint(state.adjust, plan.value, "Statischer Referenzwert nicht übernommen");

        result.stage = STEP.ON;
        await writeStep(project, plan, STEP.ON);
        state = await snapshot(plan, await refresh(plan));
        if (!state.varying || state.keys.length > 1) throw new Error("Stoppuhr nicht aktiv oder Pfad erneut befüllt.");
        // Some hosts may create a key at the playhead on enabling animation.
        // Accept it only if it already is precisely the intended final key.
        if (state.keys.length === 1) {
            if (Math.abs(state.keys[0] - plan.time.seconds) > 1e-7) throw new Error("Stoppuhr hat einen Keyframe an einem anderen Zeitpunkt angelegt.");
            assertPoint(state.adjust, plan.value, "Automatisch angelegter Keyframe");
        } else {
            result.stage = STEP.KEY;
            await writeStep(project, plan, STEP.KEY);
        }

        result.stage = STEP.VERIFY;
        await verify(plan);
        // A second observation catches immediate repopulation, not arbitrary
        // future changes. Never rewrite parameters to force this check to pass.
        await delay(VERIFY_DELAY_MS);
        await verify(plan);
        result.steps.push({ step: STEP.VERIFY, label: LABELS[STEP.VERIFY], checks: 2 });
        result.status = "ok";
        result.reason = "Ein Referenz-Keyframe gesetzt. Positionswerte an den Prüfzeiten konstant und Referenzposition erhalten. Bildkontrolle in Premiere erforderlich.";
    } catch (error) {
        result.status = "error";
        result.reason = (LABELS[result.stage] || result.stage) + ": " + describeError(error);
        if (result.undoSteps) {
            result.reason += " Bereits " + result.undoSteps + " Schreibschritt(e) ausgeführt; mit Rückgängig zurücknehmen.";
        }
        try {
            const found = await locate(trackItem);
            if (found.index >= 0) result.paramsAfter = await dumpParams(found.chain.getComponentAtIndex(found.index));
        } catch (diagnosticError) {
            result.diagnosticError = describeError(diagnosticError);
        }
    }
    return result;
}

async function runSmoothAutoFrame(rawOptions) {
    const input = rawOptions || {};
    const options = {
        timing: Object.values(TIMING).includes(input.timing) ? input.timing : TIMING.PLAYHEAD,
        dryRun: input.dryRun === undefined ? true : !!input.dryRun
    };
    const report = {
        processed: 0, planned: 0, skipped: 0, errors: 0, undoSteps: 0,
        dryRun: options.dryRun, timing: options.timing, results: [], notes: [],
        meta: { timestamp: new Date().toISOString(), pluginVersion: PLUGIN_VERSION,
            diagnosticsVersion: DIAGNOSTICS_VERSION, options: options, host: hostInfo() }
    };
    try {
        if (input.fixScale || input.fixRotation || input.staticValue || input.timing === "average") {
            throw new Error("Veraltete Optionen: dieses Build verwendet ausschließlich den Tutorial-Ablauf. Panel neu laden.");
        }
        const project = await ppro.Project.getActiveProject();
        if (!project) throw new Error("Kein aktives Projekt gefunden.");
        const sequence = await project.getActiveSequence();
        if (!sequence) throw new Error("Keine aktive Sequenz.");
        const selection = await sequence.getSelection();
        const trackItems = selection ? await selection.getTrackItems() : [];
        if (!trackItems.length) throw new Error("Keine Clips ausgewählt.");
        const settings = await sequence.getSettings();
        const rate = settings.getVideoFrameRate();
        if (!rate || !Number.isFinite(rate.value) || rate.value <= 0) throw new Error("Sequenz-Framerate nicht lesbar.");
        const frameDuration = Number.isFinite(rate.ticksPerFrame) && rate.ticksPerFrame > 0
            ? rate.ticksPerFrame / 254016000000 : 1 / rate.value;
        // Capture once for the whole batch; later user scrubbing must not change
        // which reference frame was requested for the other clips.
        const playhead = options.timing === TIMING.PLAYHEAD ? (await sequence.getPlayerPosition()).seconds : null;
        for (const trackItem of trackItems) {
            const result = await processClip(project, frameDuration, playhead, trackItem, options);
            report.results.push(result);
            report.undoSteps += result.undoSteps;
            if (result.status === "ok") report.processed++;
            else if (result.status === "dry-run") report.planned++;
            else if (result.status === "skipped") report.skipped++;
            else report.errors++;
        }
        if (report.undoSteps) report.notes.push("Dieser Lauf hat " + report.undoSteps +
            " abgeschlossene Schreibschritte (Undo) erzeugt. Auch fehlgeschlagene Clips können bereits geändert sein.");
        if (report.processed) report.notes.push("Die Nachprüfung liest Parameterwerte; sie vergleicht keine gerenderten Bilder.");
    } catch (error) {
        report.fatalError = describeError(error);
    }
    return report;
}

module.exports = { runSmoothAutoFrame, TIMING, PLUGIN_VERSION, DIAGNOSTICS_VERSION };
