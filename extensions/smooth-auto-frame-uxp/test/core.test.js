const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("./mock-premiere.js");
const { runSmoothAutoFrame: run } = require("../src/core.js");

function setup(options, sequenceOptions) {
    const clip = M.makeClip(options);
    const project = M.install([clip], sequenceOptions);
    return { clip, project };
}
const execute = (options) => run({ dryRun: false, ...options });
function succeeded(report) {
    assert.equal(report.errors, 0, JSON.stringify(report.results));
    assert.equal(report.processed, 1);
}
function failed(report, stage) {
    assert.equal(report.processed, 0);
    assert.equal(report.errors, 1, JSON.stringify(report));
    assert.equal(report.results[0].stage, stage, JSON.stringify(report.results));
}

test("tutorial preserves the chosen frame and holds it throughout a trimmed clip", async () => {
    const { clip, project } = setup();
    const originalGenerated = M.clone(clip.generated.keys);
    const before = clip.generated.at(11);
    const r = await execute();
    succeeded(r);
    assert.deepEqual(M.normalize(clip.adjust.at(10)), before);
    assert.deepEqual(M.normalize(clip.adjust.at(11.8)), before);
    assert.equal(clip.adjust.keys.length, 1);
    assert.equal(clip.adjust.keys[0].time, 11);
    assert.deepEqual(clip.generated.keys, originalGenerated);
    assert.deepEqual(M.state.log.map((a) => [a.param, a.kind]), [
        ["", "set"], ["Position anpassen", "off"], ["Position anpassen", "set"],
        ["Position anpassen", "on"], ["Position anpassen", "key"]
    ]);
    assert.equal(project.history.length, 5);
    assert.equal(r.undoSteps, 5);
    assert.equal(r.results[0].steps.at(-1).checks, 2);
    assert.ok(clip.chainReads > 5);
});

test("raw generated and merged Position are never writable targets", async () => {
    const { clip } = setup();
    for (const param of [clip.generated, clip.applied]) {
        param.createSetTimeVaryingAction = () => { throw new Error("read-only output"); };
        param.createSetValueAction = () => { throw new Error("read-only output"); };
        param.createAddKeyframeAction = () => { throw new Error("read-only output"); };
    }
    succeeded(await execute());
    assert.notDeepEqual(M.normalize(clip.adjust.at(11)), M.normalize(clip.applied.at(11)));
});

test("a dry run with override off reports readiness limits, never a fabricated target", async () => {
    const { clip } = setup();
    const r = await run({ timing: "playhead", dryRun: true });
    assert.equal(r.planned, 1);
    assert.equal(r.processed, 0);
    assert.equal(r.results[0].status, "dry-run");
    assert.equal(r.results[0].changes, undefined);
    assert.equal(clip.override.value, false);
    assert.equal(M.state.log.length, 0);
});

test("dry-run defaults on and captures an available editable reference", async () => {
    setup({ override: true });
    const r = await run();
    assert.equal(r.dryRun, true);
    assert.equal(r.planned, 1);
    assert.deepEqual(JSON.parse(r.results[0].changes[0].value), { x: 0.6, y: 0.7 });
    assert.equal(M.state.log.length, 0);
});

test("manually enabled override is not toggled again; rerunning does not regenerate the path", async () => {
    const { clip } = setup({ override: true });
    succeeded(await execute());
    assert.equal(M.state.log.some((a) => a.param === ""), false);
    const first = M.clone(clip.adjust.keys);
    const second = await execute();
    succeeded(second);
    assert.deepEqual(M.clone(clip.adjust.keys), first);
    assert.equal(second.undoSteps, 4);
});

test("an empty editable path aborts after override, leaving generated and adjust data untouched", async () => {
    const { clip } = setup({ transfer: false });
    const generated = M.clone(clip.generated.keys);
    const r = await execute();
    failed(r, "editable-path");
    assert.equal(r.undoSteps, 1);
    assert.match(r.results[0].reason, /manuell aktivieren/);
    assert.deepEqual(clip.generated.keys, generated);
    assert.deepEqual(clip.adjust.value, { x: 0, y: 0 });
    assert.equal(M.state.log.length, 1);
});

test("delayed path availability causes read-only waiting, not repeated writes", async () => {
    setup({ transferDelay: 150 });
    const r = await execute();
    succeeded(r);
    assert.ok(r.results[0].pathReadAttempts > 1);
    assert.equal(M.state.log.filter((a) => a.param === "").length, 1);
    assert.equal(M.state.log.length, 5);
});

test("pure vertical motion is frozen using Adjust Position", async () => {
    const { clip } = setup({ keys: [
        { time: 10, value: { x: 0.5, y: 0.4 } }, { time: 12, value: { x: 0.5, y: 0.8 } }
    ] });
    succeeded(await execute());
    assert.equal(clip.adjust.at(10).x, 0.5);
    assert.ok(Math.abs(clip.adjust.at(12).y - 0.6) < 1e-10);
});

test("bare Position is not a fallback for missing Adjust Position", async () => {
    const { clip } = setup();
    clip.adjust.displayName = "Unbekannter Parameter";
    const r = await execute();
    failed(r, "discovery");
    assert.match(r.results[0].reason, /Position anpassen/);
    assert.equal(M.state.log.length, 0);
});

test("measured blank override layout touches index 8, never the other booleans", async () => {
    const { clip } = setup();
    const r = await execute();
    succeeded(r);
    assert.equal(r.results[0].overrideResolvedBy, "index-26.3-layout");
    assert.equal(clip.effect.params[0].value, false);
    assert.equal(clip.effect.params[4].value, true);
    assert.equal(clip.override.value, true);
});

test("a changed anonymous parameter layout is not guessed", async () => {
    const { clip } = setup();
    clip.generated.displayName = "Different layout";
    failed(await execute(), "discovery");
    assert.equal(M.state.log.length, 0);
});

test("named English parameters work without index fallback", async () => {
    const { clip } = setup({ namedOverride: true });
    clip.override.displayName = "Overwrite generated path";
    clip.adjust.displayName = "Adjust Position";
    const r = await execute();
    succeeded(r);
    assert.equal(r.results[0].overrideResolvedBy, "name");
});

test("wrong override type and unsupported keyframing fail before mutations", async () => {
    let s = setup();
    s.clip.override.value = 42;
    failed(await execute(), "reference-time");
    assert.equal(M.state.log.length, 0);
    s = setup();
    s.clip.adjust.areKeyframesSupported = async () => false;
    failed(await execute(), "reference-time");
    assert.equal(M.state.log.length, 0);
});

for (const [kind, stage, count] of [
    ["off", "stopwatch-off", 2], ["set", "static-value", 3],
    ["on", "stopwatch-on", 4], ["key", "verify", 5]
]) {
    test("discarded " + kind + " action is detected at its checkpoint", async () => {
        const { clip } = setup();
        clip.adjust.reject = kind;
        const r = await execute();
        failed(r, stage);
        assert.equal(r.undoSteps, count);
        assert.equal(M.state.log.length, count);
        assert.match(r.results[0].reason, /Rückgängig/);
    });
}

test("rejected override never starts modifying position", async () => {
    const { clip } = setup(); clip.override.reject = "set";
    failed(await execute(), "editable-path");
    assert.equal(M.state.log.length, 1);
});

test("false transaction / addAction results and thrown transactions are not successes", async () => {
    for (const prop of ["reject", "rejectAdd", "throwAt"]) {
        const { project } = setup(); project[prop] = "off";
        const r = await execute();
        failed(r, "stopwatch-off");
        assert.equal(r.undoSteps, 1);
        assert.equal(M.state.log.length, 1);
    }
});

test("one keyframe with the wrong value does not pass verification", async () => {
    const { clip } = setup();
    clip.adjust.afterWrite = (kind) => { if (kind === "key") clip.adjust.keys[0].value = { x: 0.99, y: 0.99 }; };
    failed(await execute(), "verify");
});

test("one keyframe at the wrong time does not pass verification", async () => {
    const { clip } = setup();
    clip.adjust.afterWrite = (kind) => { if (kind === "key") clip.adjust.keys[0].time += 0.04; };
    failed(await execute(), "verify");
});

test("a still-moving merged output fails despite a correctly frozen editable parameter", async () => {
    setup({ ignoreOverride: true });
    const r = await execute();
    failed(r, "verify");
    assert.match(r.results[0].reason, /Angewandte Position/);
    assert.ok(r.results[0].verificationSamples.length);
});

test("override changing the reference framing is reported before deleting the editable keys", async () => {
    const { clip } = setup();
    const original = clip.applied.at;
    clip.applied.at = (seconds) => {
        const p = original(seconds);
        return { x: p.x + (clip.override.value ? 0.1 : 0), y: p.y };
    };
    const r = await execute();
    failed(r, "editable-path");
    assert.match(r.results[0].reason, /Referenzausschnitt verändert/);
    assert.equal(M.state.log.length, 1);
});

test("post-write repopulation is detected by the second observation without another write", async () => {
    const { clip } = setup();
    clip.adjust.afterWrite = (kind) => {
        if (kind === "key") setTimeout(() => { clip.adjust.keys = M.clone(clip.generated.keys); }, 100);
    };
    const r = await execute();
    failed(r, "verify");
    assert.equal(M.state.log.length, 5);
});

test("a host-created key when enabling the stopwatch is accepted only at the intended time/value", async () => {
    const { clip } = setup();
    clip.adjust.afterWrite = (kind) => {
        if (kind === "on") clip.adjust.keys = [{ time: 11, value: clip.adjust.value }];
    };
    const r = await execute();
    succeeded(r);
    assert.equal(r.undoSteps, 4);
    assert.equal(clip.adjust.keys.length, 1);
});

test("unreadable keyframe state is an error, not an empty path or success", async () => {
    const { clip } = setup();
    clip.adjust.getKeyframeListAsTickTimes = () => { throw new Error("invalid script object"); };
    const r = await execute();
    failed(r, "reference-time");
    assert.equal(M.state.log.length, 0);
});

test("undoing the reported steps restores override and the original parameters", async () => {
    const { clip, project } = setup();
    const original = M.clone(clip.effect.params.map((p) => ({ value: p.value, keys: p.keys, varying: p.varying })));
    const r = await execute(); succeeded(r);
    for (let i = 0; i < r.undoSteps; i++) project.undo();
    assert.deepEqual(M.clone(clip.effect.params.map((p) => ({ value: p.value, keys: p.keys, varying: p.varying }))), original);
});

test("batch results count success, failed readiness, and audio separately", async () => {
    const good = M.makeClip({ name: "good" });
    const bad = M.makeClip({ name: "bad", transfer: false });
    const audio = M.makeClip({ noEffect: true });
    M.install([bad, audio, good]);
    const r = await execute();
    assert.equal(r.processed, 1); assert.equal(r.errors, 1); assert.equal(r.skipped, 1);
    assert.equal(r.undoSteps, 6);
    assert.equal(good.adjust.keys.length, 1);
});

test("end uses the last VISIBLE frame, not an out-of-range original keyframe", async () => {
    const { clip } = setup();
    const expected = clip.generated.at(11.96);
    const r = await execute({ timing: "end" }); succeeded(r);
    assert.equal(clip.adjust.keys[0].time, 11.96);
    assert.deepEqual(M.normalize(clip.adjust.keys[0].value), expected);
});

test("start is the trimmed source in-point", async () => {
    const { clip } = setup();
    succeeded(await execute({ timing: "start" }));
    assert.equal(clip.adjust.keys[0].time, 10);
    assert.deepEqual(M.normalize(clip.adjust.keys[0].value), { x: 0.4, y: 0.5 });
});

test("out-of-clip playhead and retimed clips fail before override", async () => {
    setup({}, { playhead: 102 });
    failed(await execute(), "reference-time");
    assert.equal(M.state.log.length, 0);
    setup({ speed: 2 });
    failed(await execute(), "reference-time");
    assert.equal(M.state.log.length, 0);
});

test("wrapped point and boolean host values work end to end", async () => {
    setup({ shape: (value) => ({ value: { value: value } }) });
    succeeded(await execute());
});

test("no project/sequence/selection retains report metadata and writes nothing", async () => {
    M.install([]);
    let r = await execute(); assert.ok(r.fatalError); assert.ok(r.meta);
    M.state.project = null;
    r = await execute(); assert.ok(r.fatalError); assert.ok(r.meta);
    M.state.project = { getActiveSequence: async () => null };
    r = await execute(); assert.ok(r.fatalError); assert.ok(r.meta);
    assert.equal(M.state.log.length, 0);
});

test("legacy options are rejected instead of silently running a different operation", async () => {
    setup();
    for (const options of [{ fixScale: true }, { fixRotation: true }, { staticValue: true }, { timing: "average" }]) {
        const r = await execute(options);
        assert.match(r.fatalError, /Veraltete Optionen/);
    }
    assert.equal(M.state.log.length, 0);
});

test("reports are JSON-serializable and identify the build and completed stages", async () => {
    setup(); const r = await execute(); succeeded(r);
    const serialized = JSON.parse(JSON.stringify(r));
    assert.equal(serialized.meta.pluginVersion, "1.1.0");
    assert.equal(serialized.meta.diagnosticsVersion, 10);
    assert.equal(serialized.results[0].parameters.adjust, 6);
    assert.equal(serialized.results[0].steps[1].step, "editable-path");
});
