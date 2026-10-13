/**
 * Integration tests for src/core.js, driven through a mocked Premiere.
 *
 * These cover what the pure-module tests structurally cannot: that the right
 * components end up in the chain, in the right order, with the right values,
 * in the right number of transactions — and that every failure path leaves the
 * project in a state the user can live with.
 *
 * The mock applies queued actions on commit, so every assertion below is about
 * the resulting state, not about the plugin's intent.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

// Must come before core.js: installs the `premierepro` interception.
const mock = require("./mock-premiere.js");
const core = require("../src/core.js");

const { S, PointF } = mock;

const COLUMNS = { layout: "columns", swap: false, dryRun: false };

function setup() {
    mock.reset();
}

/**
 * The crop values of a component, by position rather than by name — the tests
 * also cover renamed and nameless parameters.
 */
function cropValues(component) {
    return {
        left: component.getParam(0).current,
        top: component.getParam(1).current,
        right: component.getParam(2).current,
        bottom: component.getParam(3).current
    };
}

function positionOf(component) {
    // Index 1 in the mock Transform: anchor point first, then position.
    const value = component.getParam(1).current;
    return { x: value.x, y: value.y };
}

/** Finds our inserted pair in a chain by match name. */
function ownPairOf(chain) {
    const names = chain.matchNames();
    const transformAt = names.lastIndexOf("AE.ADBE Geometry2");
    if (transformAt < 0) return null;
    return {
        transform: chain.getComponentAtIndex(transformAt),
        crop: chain.getComponentAtIndex(transformAt + 1),
        transformIndex: transformAt
    };
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test("a fresh pair gets Transform and Crop appended behind the user effects", async function () {
    setup();
    const clips = mock.makePair({
        lower: { effectsBefore: [new mock.MockComponent("PR.ADBE Lumetri", "Lumetri", [])] }
    });
    mock.selectClips(clips);

    const report = await core.createSplitScreen(COLUMNS);

    assert.equal(report.fatalError, null, report.fatalError || "");
    assert.equal(report.processed, 2);
    assert.equal(report.errors, 0);

    assert.deepEqual(clips[0].chain.matchNames(), [
        "AE.ADBE Opacity",
        "AE.ADBE Motion",
        "PR.ADBE Lumetri",
        "AE.ADBE Geometry2",
        "AE.ADBE Crop"
    ]);
    assert.deepEqual(clips[1].chain.matchNames(), [
        "AE.ADBE Opacity",
        "AE.ADBE Motion",
        "AE.ADBE Geometry2",
        "AE.ADBE Crop"
    ]);
});

test("the written values match the documented default case", async function () {
    setup();
    const clips = mock.makePair();
    mock.selectClips(clips);

    await core.createSplitScreen(COLUMNS);

    // Lower track goes left: Crop Right 50 %, position a quarter frame left.
    const left = ownPairOf(clips[0].chain);
    assert.deepEqual(cropValues(left.crop), { left: 0, top: 0, right: 50, bottom: 0 });
    assert.deepEqual(positionOf(left.transform), { x: 0.25, y: 0.5 });

    const right = ownPairOf(clips[1].chain);
    assert.deepEqual(cropValues(right.crop), { left: 50, top: 0, right: 0, bottom: 0 });
    assert.deepEqual(positionOf(right.transform), { x: 0.75, y: 0.5 });
});

test("the rows layout writes the other axis", async function () {
    setup();
    const clips = mock.makePair();
    mock.selectClips(clips);

    await core.createSplitScreen({ layout: "rows", swap: false, dryRun: false });

    const top = ownPairOf(clips[0].chain);
    assert.deepEqual(cropValues(top.crop), { left: 0, top: 0, right: 0, bottom: 50 });
    assert.deepEqual(positionOf(top.transform), { x: 0.5, y: 0.25 });
});

test("swap exchanges the two halves", async function () {
    setup();
    const clips = mock.makePair();
    mock.selectClips(clips);

    await core.createSplitScreen({ layout: "columns", swap: true, dryRun: false });

    assert.deepEqual(cropValues(ownPairOf(clips[0].chain).crop), {
        left: 50,
        top: 0,
        right: 0,
        bottom: 0
    });
});

test("Zoom is forced off so the cropped half is not rescaled", async function () {
    setup();
    const clips = mock.makePair();
    mock.selectClips(clips);

    await core.createSplitScreen(COLUMNS);

    const crop = ownPairOf(clips[0].chain).crop;
    assert.equal(crop.param("Zoom").current, false);
});

test("the first run is two transactions, in insert-then-write order", async function () {
    setup();
    mock.selectClips(mock.makePair());

    await core.createSplitScreen(COLUMNS);

    const labels = mock.committedTransactions();
    assert.equal(labels.length, 2);
    assert.match(labels[0], /einfügen/);
    assert.match(labels[1], /anwenden/);
});

test("several pairs in one selection are all built", async function () {
    setup();
    const first = mock.makePair();
    const second = mock.makePair({
        lower: { name: "b-unten.mov", startTicks: S(10), endTicks: S(12) },
        upper: { name: "b-oben.mov", startTicks: S(10), endTicks: S(12) }
    });
    mock.selectClips(first.concat(second));

    const report = await core.createSplitScreen(COLUMNS);

    assert.equal(report.processed, 4);
    for (const clip of first.concat(second)) {
        assert.ok(ownPairOf(clip.chain), "Paar fehlt bei " + clip.name);
    }
});

test("intrinsics at the end of the chain are inserted in front of", async function () {
    setup();
    // A user effect is required for the layout to be detectable at all: a
    // chain consisting only of intrinsics looks the same either way, and
    // computeInsertionIndex then assumes the documented intrinsics-first
    // layout and appends.
    const clips = mock.makePair({
        lower: {
            intrinsicsLast: true,
            effectsBefore: [new mock.MockComponent("PR.ADBE Lumetri", "Lumetri", [])]
        },
        upper: {
            intrinsicsLast: true,
            effectsBefore: [new mock.MockComponent("PR.ADBE Lumetri", "Lumetri", [])]
        }
    });
    mock.selectClips(clips);

    await core.createSplitScreen(COLUMNS);

    assert.deepEqual(clips[0].chain.matchNames(), [
        "PR.ADBE Lumetri",
        "AE.ADBE Geometry2",
        "AE.ADBE Crop",
        "AE.ADBE Opacity",
        "AE.ADBE Motion"
    ]);
});

test("a chain of only intrinsics is appended to", async function () {
    setup();
    const clips = mock.makePair();
    mock.selectClips(clips);

    await core.createSplitScreen(COLUMNS);

    assert.deepEqual(clips[0].chain.matchNames(), [
        "AE.ADBE Opacity",
        "AE.ADBE Motion",
        "AE.ADBE Geometry2",
        "AE.ADBE Crop"
    ]);
});

// ---------------------------------------------------------------------------
// Motion compensation
// ---------------------------------------------------------------------------

test("a 120 % punch-in is compensated in the written values", async function () {
    setup();
    const clips = mock.makePair({ lower: { motion: { scale: 120 } } });
    mock.selectClips(clips);

    await core.createSplitScreen(COLUMNS);

    const pair = ownPairOf(clips[0].chain);
    const crop = cropValues(pair.crop);
    assert.ok(Math.abs(crop.left - 8.3333) < 0.01, "Crop Links ≈ 8,33 %, war " + crop.left);
    assert.equal(crop.right, 50);
    assert.ok(Math.abs(crop.top - 8.3333) < 0.01, "Crop Oben ≈ 8,33 %");
    // 960 + (-480 / 1.2) = 560 px, normalized 560/1920.
    const position = positionOf(pair.transform);
    assert.ok(
        Math.abs(position.x - 560 / 1920) < 0.0001,
        "Position x ≈ 0,2917, war " + position.x
    );
});

test("a punch-in on one clip only affects that clip", async function () {
    setup();
    const clips = mock.makePair({ lower: { motion: { scale: 150 } } });
    mock.selectClips(clips);

    await core.createSplitScreen(COLUMNS);

    assert.deepEqual(cropValues(ownPairOf(clips[1].chain).crop), {
        left: 50,
        top: 0,
        right: 0,
        bottom: 0
    });
});

test("pixel-based positions are written back in pixels", async function () {
    setup();
    // Both the Motion position and the Transform default arrive in pixels.
    mock.state.transformOptions = { positionValue: new PointF(960, 540) };
    const clips = mock.makePair({
        lower: { motion: { position: new PointF(960, 540) } },
        upper: { motion: { position: new PointF(960, 540) } }
    });
    mock.selectClips(clips);

    await core.createSplitScreen(COLUMNS);

    assert.deepEqual(positionOf(ownPairOf(clips[0].chain).transform), { x: 480, y: 540 });
});

test("a clip scaled far down aborts the run instead of vanishing", async function () {
    setup();
    mock.selectClips(mock.makePair({ lower: { motion: { scale: 20 } } }));

    const report = await core.createSplitScreen(COLUMNS);

    assert.ok(report.fatalError);
    assert.equal(mock.wroteAnything(), false, "es darf nichts geschrieben werden");
    assert.ok(
        report.validationErrors.some(function (e) {
            return e.code === "cell-empty";
        })
    );
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test("a second run updates instead of stacking", async function () {
    setup();
    const clips = mock.makePair();
    mock.selectClips(clips);
    await core.createSplitScreen(COLUMNS);

    mock.actionLog.length = 0;
    const report = await core.createSplitScreen({
        layout: "columns",
        swap: true,
        dryRun: false
    });

    assert.equal(report.fatalError, null, report.fatalError || "");
    assert.equal(report.processed, 2);
    assert.equal(mock.records("insert").length, 0, "keine neuen Komponenten");
    assert.equal(mock.committedTransactions().length, 1, "nur eine Transaktion");
    assert.equal(clips[0].chain.matchNames().length, 4);
    // Swapped: the lower clip now holds the right half.
    assert.equal(cropValues(ownPairOf(clips[0].chain).crop).left, 50);
});

test("an effect added after our pair does not cause stacking", async function () {
    setup();
    // The everyday workflow: build the split screen, then grade the clip.
    const clips = mock.makePair({
        lower: {
            withOwnPair: true,
            effectsAfter: [new mock.MockComponent("PR.ADBE Lumetri", "Lumetri", [])]
        },
        upper: {
            withOwnPair: true,
            effectsAfter: [new mock.MockComponent("PR.ADBE Lumetri", "Lumetri", [])]
        }
    });
    mock.selectClips(clips);

    const report = await core.createSplitScreen(COLUMNS);

    assert.equal(report.fatalError, null, report.fatalError || "");
    assert.equal(mock.records("insert").length, 0, "kein zweites Paar");
    assert.equal(
        clips[0].chain.matchNames().filter(function (n) {
            return n === "AE.ADBE Crop";
        }).length,
        1
    );
});

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

test("removal deletes exactly our two components", async function () {
    setup();
    const clips = mock.makePair({
        lower: { withOwnPair: true, effectsBefore: [new mock.MockComponent("PR.ADBE Lumetri", "Lumetri", [])] },
        upper: { withOwnPair: true }
    });
    mock.selectClips(clips);

    const report = await core.removeSplitScreen({ dryRun: false });

    assert.equal(report.processed, 2);
    assert.deepEqual(clips[0].chain.matchNames(), [
        "AE.ADBE Opacity",
        "AE.ADBE Motion",
        "PR.ADBE Lumetri"
    ]);
    assert.deepEqual(clips[1].chain.matchNames(), ["AE.ADBE Opacity", "AE.ADBE Motion"]);
});

test("removal leaves Motion untouched", async function () {
    setup();
    const clips = mock.makePair({
        lower: { withOwnPair: true, motion: { scale: 130 } },
        upper: { withOwnPair: true }
    });
    mock.selectClips(clips);

    await core.removeSplitScreen({ dryRun: false });

    assert.equal(clips[0].motionComponent.param("Skalierung").current, 130);
    assert.equal(clips[0].motionComponent.param("Position").writeCount, 0);
});

test("removal is one transaction", async function () {
    setup();
    mock.selectClips(
        mock.makePair({ lower: { withOwnPair: true }, upper: { withOwnPair: true } })
    );

    await core.removeSplitScreen({ dryRun: false });

    assert.equal(mock.committedTransactions().length, 1);
});

test("removal reports clips that have no split screen", async function () {
    setup();
    const clips = mock.makePair();
    mock.selectClips(clips);

    const report = await core.removeSplitScreen({ dryRun: false });

    assert.equal(report.processed, 0);
    assert.equal(report.skipped, 2);
    assert.equal(mock.wroteAnything(), false);
});

test("a round trip restores the original chain", async function () {
    setup();
    const clips = mock.makePair();
    const before = clips[0].chain.matchNames();
    mock.selectClips(clips);

    await core.createSplitScreen(COLUMNS);
    await core.removeSplitScreen({ dryRun: false });

    assert.deepEqual(clips[0].chain.matchNames(), before);
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

test("a dry run writes nothing at all", async function () {
    setup();
    const clips = mock.makePair();
    mock.selectClips(clips);

    const report = await core.createSplitScreen({
        layout: "columns",
        swap: false,
        dryRun: true
    });

    assert.equal(report.processed, 2);
    assert.equal(mock.wroteAnything(), false);
    assert.equal(mock.records("TX_BEGIN").length, 0, "keine Transaktion");
    assert.equal(mock.state.created.length, 0, "keine Effekte erzeugt");
    assert.equal(ownPairOf(clips[0].chain), null);
});

test("a dry run of the removal writes nothing", async function () {
    setup();
    const clips = mock.makePair({
        lower: { withOwnPair: true },
        upper: { withOwnPair: true }
    });
    mock.selectClips(clips);

    await core.removeSplitScreen({ dryRun: true });

    assert.equal(mock.wroteAnything(), false);
    assert.ok(ownPairOf(clips[0].chain));
});

// ---------------------------------------------------------------------------
// Validation aborts before anything is touched
// ---------------------------------------------------------------------------

test("clips of different length abort the run", async function () {
    setup();
    mock.selectClips(
        mock.makePair({ upper: { endTicks: S(4) } })
    );

    const report = await core.createSplitScreen(COLUMNS);

    assert.ok(report.fatalError);
    assert.equal(mock.wroteAnything(), false);
    assert.equal(mock.state.created.length, 0);
});

test("three congruent clips abort the run", async function () {
    setup();
    const clips = mock.makePair();
    clips.push(mock.makeClip({ name: "drittes.mov", trackIndex: 2 }));
    mock.selectClips(clips);

    const report = await core.createSplitScreen(COLUMNS);

    assert.ok(report.fatalError);
    assert.equal(mock.wroteAnything(), false);
});

test("a rotated clip aborts the run", async function () {
    setup();
    mock.selectClips(mock.makePair({ lower: { motion: { rotation: 5 } } }));

    const report = await core.createSplitScreen(COLUMNS);

    assert.ok(report.fatalError);
    assert.equal(mock.wroteAnything(), false);
    assert.ok(
        report.validationErrors.some(function (e) {
            return e.code === "rotated";
        })
    );
});

test("a keyframed Motion position aborts the run", async function () {
    setup();
    mock.selectClips(
        mock.makePair({ lower: { motion: { positionOptions: { timeVarying: true } } } })
    );

    const report = await core.createSplitScreen(COLUMNS);

    assert.ok(report.fatalError);
    assert.equal(mock.wroteAnything(), false);
});

test("audio clips are ignored, not treated as errors", async function () {
    setup();
    const clips = mock.makePair();
    clips.push(mock.makeClip({ name: "ton.wav", trackIndex: 0, audio: true }));
    mock.selectClips(clips);

    const report = await core.createSplitScreen(COLUMNS);

    assert.equal(report.fatalError, null, report.fatalError || "");
    assert.equal(report.processed, 2);
    assert.equal(report.skipped, 1);
});

test("no selection is a clear message, not a crash", async function () {
    setup();
    mock.selectClips([]);

    const report = await core.createSplitScreen(COLUMNS);

    assert.match(report.fatalError, /ausgewählt/);
});

test("a missing sequence frame size aborts cleanly", async function () {
    setup();
    mock.selectClips(mock.makePair(), { failFrameSize: true });

    const report = await core.createSplitScreen(COLUMNS);

    assert.match(report.fatalError, /Sequenzgröße/);
    assert.equal(mock.wroteAnything(), false);
});

test("a missing effect in the host is reported, not guessed around", async function () {
    setup();
    mock.state.availableMatchNames = ["AE.ADBE Mosaic"];
    mock.selectClips(mock.makePair());

    const report = await core.createSplitScreen(COLUMNS);

    assert.ok(report.fatalError);
    assert.match(report.fatalError, /nicht gefunden/);
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

test("a rejected insert transaction changes nothing", async function () {
    setup();
    mock.state.failingTransactions = ["Split Screener: Effekte einfügen"];
    const clips = mock.makePair();
    mock.selectClips(clips);

    const report = await core.createSplitScreen(COLUMNS);

    assert.ok(report.fatalError);
    assert.equal(ownPairOf(clips[0].chain), null);
    assert.equal(mock.records("setValue").length, 0);
});

test("a rejected value transaction rolls the inserted effects back", async function () {
    setup();
    mock.state.failingTransactions = ["Split Screener: Splitscreen anwenden"];
    const clips = mock.makePair();
    mock.selectClips(clips);

    const report = await core.createSplitScreen(COLUMNS);

    assert.ok(report.fatalError);
    assert.match(report.fatalError, /wieder entfernt/);
    assert.equal(
        ownPairOf(clips[0].chain),
        null,
        "eingefügte Effekte müssen wieder weg sein"
    );
    assert.deepEqual(clips[0].chain.matchNames(), ["AE.ADBE Opacity", "AE.ADBE Motion"]);
});

test("a throwing value transaction also rolls back", async function () {
    setup();
    mock.state.throwingTransactions = ["Split Screener: Splitscreen anwenden"];
    const clips = mock.makePair();
    mock.selectClips(clips);

    const report = await core.createSplitScreen(COLUMNS);

    assert.ok(report.fatalError);
    assert.equal(ownPairOf(clips[0].chain), null);
});

test("components that cannot be found after insertion are rolled back", async function () {
    setup();
    const clips = mock.makePair();
    mock.selectClips(clips);

    // Simulate the handle going stale: the components are inserted but the
    // chain refuses to show them. This is the case the index-based cleanup
    // used to skip — exactly when it was needed.
    const originalInsert = mock.MockChain.prototype.createInsertComponentAction;
    mock.MockChain.prototype.createInsertComponentAction = function (component, index) {
        const action = originalInsert.call(this, component, index);
        const chain = this;
        return {
            record: action.record,
            apply: function () {
                action.apply();
                chain.hidden.push(component);
            }
        };
    };

    let report;
    try {
        report = await core.createSplitScreen(COLUMNS);
    } finally {
        mock.MockChain.prototype.createInsertComponentAction = originalInsert;
    }

    assert.ok(report.fatalError);
    assert.match(report.fatalError, /wieder entfernt/);
    assert.deepEqual(
        clips[0].chain.components.map(function (c) {
            return c.matchName;
        }),
        ["AE.ADBE Opacity", "AE.ADBE Motion"],
        "auch die unsichtbaren Komponenten müssen entfernt werden"
    );
});

test("a failed effect creation changes nothing", async function () {
    setup();
    mock.state.failCreate = true;
    const clips = mock.makePair();
    mock.selectClips(clips);

    const report = await core.createSplitScreen(COLUMNS);

    assert.ok(report.fatalError);
    assert.equal(mock.wroteAnything(), false);
    assert.equal(ownPairOf(clips[0].chain), null);
});

test("silently discarded writes are caught by the verification", async function () {
    setup();
    // Premiere accepts the transaction but drops the values — the failure mode
    // that made the companion plugin report success while nothing changed.
    mock.state.cropOptions = { paramOptions: { rejectWrites: true } };
    const clips = mock.makePair();
    mock.selectClips(clips);

    const report = await core.createSplitScreen(COLUMNS);

    assert.equal(report.processed, 0, "nichts darf als erfolgreich gelten");
    assert.equal(report.errors, 2);
    assert.ok(
        report.results.every(function (r) {
            return r.status === "error";
        })
    );
});

test("a rejected removal transaction leaves the effects in place", async function () {
    setup();
    mock.state.failingTransactions = ["Split Screener: Splitscreen entfernen"];
    const clips = mock.makePair({
        lower: { withOwnPair: true },
        upper: { withOwnPair: true }
    });
    mock.selectClips(clips);

    const report = await core.removeSplitScreen({ dryRun: false });

    assert.ok(report.fatalError);
    assert.ok(ownPairOf(clips[0].chain), "nichts darf halb entfernt sein");
});

// ---------------------------------------------------------------------------
// Chain handling
// ---------------------------------------------------------------------------

test("chains are re-read before writing", async function () {
    setup();
    const clips = mock.makePair();
    mock.selectClips(clips);

    await core.createSplitScreen(COLUMNS);

    assert.ok(
        clips[0].chain.fetchCount >= 2,
        "die Kette muss nach dem Einfügen erneut geholt werden, war " +
            clips[0].chain.fetchCount
    );
});

test("an unreadable chain aborts instead of being mistaken for audio", async function () {
    setup();
    const clips = mock.makePair();
    clips.push(mock.makeClip({ name: "kaputt.mov", trackIndex: 3, failChain: true }));
    mock.selectClips(clips);

    const report = await core.createSplitScreen(COLUMNS);

    // We could not look at the clip, so we must not quietly drop it as "not a
    // video clip" either.
    assert.ok(report.fatalError);
    assert.equal(mock.wroteAnything(), false);
    assert.ok(
        report.validationErrors.some(function (e) {
            return e.code === "chain-unreadable";
        })
    );
    assert.match(
        report.validationErrors
            .map(function (e) {
                return e.message;
            })
            .join(" "),
        /kaputt\.mov/
    );
});

// ---------------------------------------------------------------------------
// Parameter mis-identification — the failure modes the verification cannot see
// ---------------------------------------------------------------------------

test("the positional fallback never takes a parameter twice", async function () {
    setup();
    // "Oben" is found by name at index 3, so the positional fallback for
    // "Unten" (also index 3) must be refused — otherwise one value is written
    // twice and another never, and with symmetric targets the verification
    // would not even notice.
    mock.state.cropOptions = { names: ["", "", "", "Oben"] };
    const clips = mock.makePair();
    mock.selectClips(clips);

    const report = await core.createSplitScreen(COLUMNS);

    assert.ok(report.fatalError, "doppelte Belegung muss auffallen");
    assert.equal(ownPairOf(clips[0].chain), null, "Rollback muss greifen");
});

test("a colour as a four-element array is not mistaken for a position", async function () {
    setup();
    // The structural probe looks for point-shaped values. A Color arriving as
    // [r, g, b, a] must not qualify, or it would stand in for the position —
    // and writing and reading back would confirm each other.
    mock.state.transformOptions = {
        positionName: "Verschiebung",
        extraParamsFirst: [new mock.MockParam("Farbe", [1, 0, 0, 1])]
    };
    const clips = mock.makePair();
    mock.selectClips(clips);

    const report = await core.createSplitScreen(COLUMNS);

    assert.equal(report.fatalError, null, report.fatalError || "");
    const transform = ownPairOf(clips[0].chain).transform;
    assert.deepEqual(
        transform.param("Farbe").current,
        [1, 0, 0, 1],
        "der Farbparameter darf nicht angefasst werden"
    );
    assert.equal(
        transform.param("Verschiebung").current.x,
        0.25,
        "die echte Position muss gefunden werden"
    );
});

test("a checkbox reported as 0 or 1 is accepted", async function () {
    setup();
    // Premiere's typings list boolean as one of five return types and the
    // older API used 0/1. Rejecting that would make the plugin refuse every
    // clip, for a value we only ever read as yes/no.
    const asNumber = function (v) {
        return v ? 1 : 0;
    };
    const clips = mock.makePair({
        lower: { motion: { uniformOptions: { shape: asNumber } } },
        upper: { motion: { uniformOptions: { shape: asNumber } } }
    });
    mock.selectClips(clips);

    const report = await core.createSplitScreen(COLUMNS);

    assert.equal(report.fatalError, null, report.fatalError || "");
    assert.equal(report.processed, 2);
});

test("a checkbox reported as something else is still rejected", async function () {
    setup();
    const asJunk = function () {
        return "vielleicht";
    };
    mock.selectClips(
        mock.makePair({ lower: { motion: { uniformOptions: { shape: asJunk } } } })
    );

    const report = await core.createSplitScreen(COLUMNS);

    assert.ok(report.fatalError);
    assert.equal(mock.wroteAnything(), false);
});

test("keyframes on our own parameters are switched off before writing", async function () {
    setup();
    // createSetValueAction is specified for non-time-varying parameters, so a
    // keyframed one would swallow the write.
    mock.state.cropOptions = { paramOptions: { timeVarying: true } };
    const clips = mock.makePair();
    mock.selectClips(clips);

    const report = await core.createSplitScreen(COLUMNS);

    assert.equal(report.fatalError, null, report.fatalError || "");
    assert.equal(report.errors, 0);
    const crop = ownPairOf(clips[0].chain).crop;
    assert.equal(crop.getParam(0).isTimeVarying(), false, "Keyframing muss aus sein");
    assert.deepEqual(cropValues(crop), { left: 0, top: 0, right: 50, bottom: 0 });
});

test("an unusual resolution strategy shows up in the report", async function () {
    setup();
    mock.state.transformOptions = { positionName: "Verschiebung" };
    mock.selectClips(mock.makePair());

    const report = await core.createSplitScreen(COLUMNS);

    const changes = report.results[0].changes || [];
    const resolution = changes.find(function (c) {
        return c.param === "Parameter-Auflösung";
    });
    assert.ok(resolution, "die Auflösungsstrategie muss im Report stehen");
    assert.match(resolution.value, /struktur/);
});

test("a clean run does not clutter the report with resolution info", async function () {
    setup();
    mock.selectClips(mock.makePair());

    const report = await core.createSplitScreen(COLUMNS);

    const changes = report.results[0].changes || [];
    assert.ok(
        !changes.some(function (c) {
            return c.param === "Parameter-Auflösung";
        })
    );
});

// ---------------------------------------------------------------------------
// Report metadata, continued
// ---------------------------------------------------------------------------

test("an early abort still reports the options it was given", async function () {
    setup();
    mock.selectClips([]);

    const report = await core.createSplitScreen({
        layout: "rows",
        swap: true,
        dryRun: true
    });

    assert.ok(report.fatalError);
    assert.equal(report.dryRun, true, "der Dry-Run darf nicht verloren gehen");
    assert.ok(report.meta.options, "die Optionen müssen im Log stehen");
    assert.equal(report.meta.options.layout, "rows");
});

test("the plugin version is the same in code, manifest and package", function () {
    const manifest = require("../manifest.json");
    const pkg = require("../package.json");
    assert.equal(manifest.version, core.PLUGIN_VERSION);
    assert.equal(pkg.version, core.PLUGIN_VERSION);
});

// ---------------------------------------------------------------------------
// Value shapes — the host does not always hand back a bare value
// ---------------------------------------------------------------------------

test("a position wrapped in {value} is handled end to end", async function () {
    setup();
    const wrap = function (v) {
        return { value: v };
    };
    mock.state.transformOptions = { positionOptions: { shape: wrap } };
    const clips = mock.makePair({
        lower: { motion: { positionOptions: { shape: wrap } } },
        upper: { motion: { positionOptions: { shape: wrap } } }
    });
    mock.selectClips(clips);

    const report = await core.createSplitScreen(COLUMNS);

    assert.equal(report.fatalError, null, report.fatalError || "");
    assert.equal(report.processed, 2);
    assert.deepEqual(positionOf(ownPairOf(clips[0].chain).transform), { x: 0.25, y: 0.5 });
});

test("a position as a two-element array is handled", async function () {
    setup();
    const asArray = function (v) {
        return [v.x, v.y];
    };
    mock.state.transformOptions = { positionOptions: { shape: asArray } };
    const clips = mock.makePair({
        lower: { motion: { positionOptions: { shape: asArray } } },
        upper: { motion: { positionOptions: { shape: asArray } } }
    });
    mock.selectClips(clips);

    const report = await core.createSplitScreen(COLUMNS);

    assert.equal(report.fatalError, null, report.fatalError || "");
    assert.equal(report.processed, 2);
});

test("numeric strings from the host are handled", async function () {
    setup();
    const asStrings = function (v) {
        if (v && typeof v === "object") return { x: String(v.x), y: String(v.y) };
        return String(v);
    };
    mock.state.cropOptions = { paramOptions: { shape: asStrings } };
    const clips = mock.makePair({
        lower: { motion: { scaleOptions: { shape: asStrings } } }
    });
    mock.selectClips(clips);

    const report = await core.createSplitScreen(COLUMNS);

    assert.equal(report.fatalError, null, report.fatalError || "");
    assert.equal(report.processed, 2);
});

test("a genuinely unreadable parameter rejects the clip with a named reason", async function () {
    setup();
    mock.selectClips(
        mock.makePair({ lower: { motion: { positionOptions: { unreadable: true } } } })
    );

    const report = await core.createSplitScreen(COLUMNS);

    assert.ok(report.fatalError);
    assert.equal(mock.wroteAnything(), false);
    const message = report.validationErrors
        .map(function (e) {
            return e.message;
        })
        .join(" ");
    assert.match(message, /Position/);
    assert.match(message, /Vorhandene Parameter/, "der Dump muss mitkommen");
});

// ---------------------------------------------------------------------------
// Localized and nameless parameters
// ---------------------------------------------------------------------------

test("English parameter names work just as well", async function () {
    setup();
    mock.state.cropOptions = { names: ["Left", "Top", "Right", "Bottom"] };
    mock.state.transformOptions = { positionName: "Position", anchorName: "Anchor Point" };
    const clips = mock.makePair({
        lower: {
            motion: {
                names: {
                    position: "Position",
                    scale: "Scale",
                    uniform: "Uniform Scale",
                    scaleWidth: "Scale Width",
                    rotation: "Rotation",
                    anchor: "Anchor Point"
                }
            }
        },
        upper: {
            motion: {
                names: {
                    position: "Position",
                    scale: "Scale",
                    uniform: "Uniform Scale",
                    scaleWidth: "Scale Width",
                    rotation: "Rotation",
                    anchor: "Anchor Point"
                }
            }
        }
    });
    mock.selectClips(clips);

    const report = await core.createSplitScreen(COLUMNS);

    assert.equal(report.fatalError, null, report.fatalError || "");
    assert.deepEqual(cropValues(ownPairOf(clips[0].chain).crop), {
        left: 0,
        top: 0,
        right: 50,
        bottom: 0
    });
});

test("nameless crop parameters fall back to their position", async function () {
    setup();
    // Some effects expose parameters with a blank displayName — name matching
    // can then never find them, which is why Crop has a positional fallback.
    mock.state.cropOptions = { names: ["", "", "", ""] };
    mock.selectClips(mock.makePair());

    const report = await core.createSplitScreen(COLUMNS);

    assert.equal(report.fatalError, null, report.fatalError || "");
    assert.equal(report.processed, 2);
});

test("an unrecognised Transform position name is found structurally", async function () {
    setup();
    // No candidate and no fragment matches "Verschiebung"; the structural
    // probe has to recognise the point sitting on the frame centre — and must
    // not pick the anchor point, which sits there too.
    mock.state.transformOptions = { positionName: "Verschiebung" };
    const clips = mock.makePair();
    mock.selectClips(clips);

    const report = await core.createSplitScreen(COLUMNS);

    assert.equal(report.fatalError, null, report.fatalError || "");
    const transform = ownPairOf(clips[0].chain).transform;
    assert.deepEqual(
        { x: transform.param("Verschiebung").current.x, y: transform.param("Verschiebung").current.y },
        { x: 0.25, y: 0.5 }
    );
    assert.deepEqual(
        transform.param("Ankerpunkt").current,
        new PointF(0.5, 0.5),
        "der Ankerpunkt darf nicht angefasst werden"
    );
});

test("Skalierungsbreite does not answer for Skalierung", async function () {
    setup();
    // "skalierung" is a substring of "Skalierungsbreite". Dropping the real
    // Skalierung must therefore fail closed instead of silently reading the
    // width as the scale.
    mock.selectClips(mock.makePair({ lower: { motion: { dropParam: "Skalierung" } } }));

    const report = await core.createSplitScreen(COLUMNS);

    assert.ok(report.fatalError);
    assert.equal(mock.wroteAnything(), false);
    const message = report.validationErrors
        .map(function (e) {
            return e.message;
        })
        .join(" ");
    assert.match(message, /Skalierung/);
});

test("a missing uniform-scale checkbox rejects the clip", async function () {
    setup();
    mock.selectClips(
        mock.makePair({ lower: { motion: { dropParam: "Gleichmäßig skalieren" } } })
    );

    const report = await core.createSplitScreen(COLUMNS);

    assert.ok(report.fatalError);
    assert.equal(mock.wroteAnything(), false);
});

test("non-uniform scaling is read per axis", async function () {
    setup();
    const clips = mock.makePair({
        lower: { motion: { uniform: false, scale: 120, scaleWidth: 160 } }
    });
    mock.selectClips(clips);

    await core.createSplitScreen(COLUMNS);

    const crop = cropValues(ownPairOf(clips[0].chain).crop);
    // Horizontal uses 1.6, vertical uses 1.2 — the values must differ.
    assert.ok(Math.abs(crop.left - 18.75) < 0.01, "Crop Links bei scaleX 1,6, war " + crop.left);
    assert.ok(Math.abs(crop.top - 8.3333) < 0.01, "Crop Oben bei scaleY 1,2, war " + crop.top);
});

test("a Crop without a Zoom parameter still works", async function () {
    setup();
    mock.state.cropOptions = { withoutZoom: true };
    mock.selectClips(mock.makePair());

    const report = await core.createSplitScreen(COLUMNS);

    assert.equal(report.fatalError, null, report.fatalError || "");
    assert.equal(report.processed, 2);
});

// ---------------------------------------------------------------------------
// Report metadata for exported logs
// ---------------------------------------------------------------------------

test("every report carries a meta block", async function () {
    setup();
    mock.selectClips(mock.makePair());

    const report = await core.createSplitScreen(COLUMNS);

    assert.ok(report.meta, "meta fehlt");
    assert.ok(report.meta.timestamp);
    assert.equal(report.meta.mode, "create");
    assert.equal(report.meta.pluginVersion, core.PLUGIN_VERSION);
    // The options are echoed from what was applied, so a mis-read control is
    // visible in the log rather than silent.
    assert.equal(report.meta.options.layout, "columns");
    assert.equal(report.meta.options.swap, false);
    assert.equal(report.meta.host.uiLocale, "de_DE");
});

test("the meta block survives an aborted run", async function () {
    setup();
    mock.selectClips(mock.makePair({ lower: { motion: { rotation: 10 } } }));

    const report = await core.createSplitScreen(COLUMNS);

    assert.ok(report.fatalError);
    assert.ok(report.meta && report.meta.timestamp);
});

test("the removal report also carries meta", async function () {
    setup();
    mock.selectClips(
        mock.makePair({ lower: { withOwnPair: true }, upper: { withOwnPair: true } })
    );

    const report = await core.removeSplitScreen({ dryRun: false });

    assert.equal(report.meta.mode, "remove");
});

test("a clip without our pair gets its chain attached on removal", async function () {
    setup();
    mock.selectClips(mock.makePair());

    const report = await core.removeSplitScreen({ dryRun: false });

    const skipped = report.results.find(function (r) {
        return r.status === "skipped";
    });
    assert.ok(skipped.components, "die Effektkette muss mitkommen");
    assert.ok(
        skipped.components.some(function (c) {
            return c.matchName === "AE.ADBE Motion";
        })
    );
});
