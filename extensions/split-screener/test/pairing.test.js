/**
 * Tests for src/pairing.js and src/chain.js — the rule set and the chain
 * reasoning. Both operate on plain descriptors, so no Premiere is involved.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const pairing = require("../src/pairing.js");
const chainUtil = require("../src/chain.js");
const { LAYOUT, CELL } = require("../src/constants.js");

const OK_MOTION = {
    positionPixels: { x: 960, y: 540 },
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    rotated: false,
    anchorMoved: false,
    keyframed: false
};

function clip(overrides) {
    return Object.assign(
        {
            id: 0,
            name: "Clip",
            trackIndex: 0,
            startKey: "1000",
            endKey: "2000",
            startLabel: "0:01.00",
            isVideo: true,
            motion: Object.assign({}, OK_MOTION)
        },
        overrides || {}
    );
}

function pair(startKey, endKey, idBase) {
    return [
        clip({ id: idBase, name: "unten " + startKey, trackIndex: 0, startKey, endKey }),
        clip({ id: idBase + 1, name: "oben " + startKey, trackIndex: 1, startKey, endKey })
    ];
}

const COLUMNS = { layout: LAYOUT.COLUMNS, swap: false };

function codes(result) {
    return result.errors.map(function (error) {
        return error.code;
    });
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

test("two congruent clips become one pair, lower track to the left", function () {
    const result = pairing.buildPlan(pair("1000", "2000", 0), COLUMNS);

    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.pairs.length, 1);
    assert.equal(result.pairs[0].items[0].clip.trackIndex, 0);
    assert.equal(result.pairs[0].items[0].cell, CELL.LEFT);
    assert.equal(result.pairs[0].items[1].cell, CELL.RIGHT);
});

test("swap reverses the cell assignment only", function () {
    const result = pairing.buildPlan(pair("1000", "2000", 0), {
        layout: LAYOUT.COLUMNS,
        swap: true
    });

    assert.equal(result.ok, true);
    assert.equal(result.pairs[0].items[0].clip.trackIndex, 0);
    assert.equal(result.pairs[0].items[0].cell, CELL.RIGHT);
    assert.equal(result.pairs[0].items[1].cell, CELL.LEFT);
});

test("the rows layout uses top and bottom", function () {
    const result = pairing.buildPlan(pair("1000", "2000", 0), {
        layout: LAYOUT.ROWS,
        swap: false
    });
    assert.equal(result.pairs[0].items[0].cell, CELL.TOP);
    assert.equal(result.pairs[0].items[1].cell, CELL.BOTTOM);
});

test("several pairs in one selection are all planned", function () {
    const clips = pair("1000", "2000", 0)
        .concat(pair("5000", "6000", 2))
        .concat(pair("9000", "9900", 4));

    const result = pairing.buildPlan(clips, COLUMNS);

    assert.equal(result.ok, true);
    assert.equal(result.pairs.length, 3);
});

test("pairs are grouped by time, not by track adjacency", function () {
    // Interleaved input order: the grouping must not depend on it.
    const a = pair("1000", "2000", 0);
    const b = pair("5000", "6000", 2);
    const result = pairing.buildPlan([a[0], b[1], a[1], b[0]], COLUMNS);

    assert.equal(result.ok, true);
    assert.equal(result.pairs.length, 2);
    for (const planned of result.pairs) {
        assert.equal(planned.items[0].clip.startKey, planned.items[1].clip.startKey);
    }
});

test("non-video items are ignored, not treated as errors", function () {
    const clips = pair("1000", "2000", 0);
    clips.push(clip({ id: 9, name: "Audio", isVideo: false, trackIndex: 0, motion: null }));

    const result = pairing.buildPlan(clips, COLUMNS);

    assert.equal(result.ok, true);
    assert.equal(result.pairs.length, 1);
    assert.equal(result.ignored.length, 1);
});

test("clips on far apart tracks still pair up", function () {
    const clips = [
        clip({ id: 0, trackIndex: 0, name: "V1" }),
        clip({ id: 1, trackIndex: 7, name: "V8" })
    ];
    const result = pairing.buildPlan(clips, COLUMNS);
    assert.equal(result.ok, true);
    assert.equal(result.pairs[0].items[0].clip.name, "V1");
});

// ---------------------------------------------------------------------------
// Validation failures — all of them abort the whole run
// ---------------------------------------------------------------------------

test("fewer than two video clips is rejected", function () {
    const result = pairing.buildPlan([clip({})], COLUMNS);
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result), [pairing.ERROR.TOO_FEW_CLIPS]);
    assert.deepEqual(result.pairs, []);
});

test("an empty selection is rejected", function () {
    const result = pairing.buildPlan([], COLUMNS);
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result), [pairing.ERROR.TOO_FEW_CLIPS]);
});

test("a clip without a congruent partner is rejected", function () {
    const clips = [
        clip({ id: 0, trackIndex: 0, startKey: "1000", endKey: "2000" }),
        clip({ id: 1, trackIndex: 1, startKey: "1000", endKey: "2001" })
    ];
    const result = pairing.buildPlan(clips, COLUMNS);

    assert.equal(result.ok, false);
    assert.deepEqual(codes(result), [pairing.ERROR.NO_PARTNER, pairing.ERROR.NO_PARTNER]);
});

test("a single tick of difference is enough to reject — no tolerance", function () {
    const clips = [
        clip({ id: 0, trackIndex: 0, startKey: "1000", endKey: "2000" }),
        clip({ id: 1, trackIndex: 1, startKey: "1001", endKey: "2000" })
    ];
    assert.equal(pairing.buildPlan(clips, COLUMNS).ok, false);
});

test("three congruent clips abort the run", function () {
    const clips = pair("1000", "2000", 0);
    clips.push(clip({ id: 2, name: "drittes", trackIndex: 2 }));

    const result = pairing.buildPlan(clips, COLUMNS);

    assert.equal(result.ok, false);
    assert.deepEqual(codes(result), [pairing.ERROR.TOO_MANY_CLIPS]);
    assert.deepEqual(result.pairs, [], "auch gesunde Paare werden nicht gebaut");
});

test("one bad group aborts the healthy groups too", function () {
    const clips = pair("1000", "2000", 0).concat([
        clip({ id: 2, name: "einsam", trackIndex: 0, startKey: "7000", endKey: "8000" })
    ]);

    const result = pairing.buildPlan(clips, COLUMNS);

    assert.equal(result.ok, false);
    assert.deepEqual(result.pairs, []);
});

test("two congruent clips on the same track are rejected", function () {
    const clips = [
        clip({ id: 0, trackIndex: 3, name: "a" }),
        clip({ id: 1, trackIndex: 3, name: "b" })
    ];
    const result = pairing.buildPlan(clips, COLUMNS);

    assert.equal(result.ok, false);
    assert.deepEqual(codes(result), [pairing.ERROR.SAME_TRACK]);
});

test("a rotated clip is rejected", function () {
    const clips = pair("1000", "2000", 0);
    clips[1].motion.rotated = true;
    clips[1].motion.rotation = 5;

    const result = pairing.buildPlan(clips, COLUMNS);

    assert.equal(result.ok, false);
    assert.deepEqual(codes(result), [pairing.ERROR.ROTATED]);
    assert.match(result.errors[0].message, /gedreht/);
});

test("a moved anchor point is rejected", function () {
    const clips = pair("1000", "2000", 0);
    clips[0].motion.anchorMoved = true;

    const result = pairing.buildPlan(clips, COLUMNS);

    assert.equal(result.ok, false);
    assert.deepEqual(codes(result), [pairing.ERROR.ANCHOR_MOVED]);
});

test("keyframed position or scale is rejected", function () {
    const clips = pair("1000", "2000", 0);
    clips[0].motion.keyframed = true;

    const result = pairing.buildPlan(clips, COLUMNS);

    assert.equal(result.ok, false);
    assert.deepEqual(codes(result), [pairing.ERROR.KEYFRAMED]);
});

test("an unreadable Motion effect is rejected", function () {
    const clips = pair("1000", "2000", 0);
    clips[1].motion = null;

    const result = pairing.buildPlan(clips, COLUMNS);

    assert.equal(result.ok, false);
    assert.deepEqual(codes(result), [pairing.ERROR.MOTION_MISSING]);
});

test("every failing rule is reported, not just the first", function () {
    const clips = pair("1000", "2000", 0);
    clips[0].motion.rotated = true;
    clips[0].motion.rotation = 3;
    clips[1].motion.keyframed = true;

    const result = pairing.buildPlan(clips, COLUMNS);

    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 2);
    assert.deepEqual(codes(result).sort(), [pairing.ERROR.KEYFRAMED, pairing.ERROR.ROTATED]);
});

test("a scaled clip is accepted — it is taken as it is", function () {
    const clips = pair("1000", "2000", 0);
    clips[0].motion.scaleX = 1.2;
    clips[0].motion.scaleY = 1.2;

    const result = pairing.buildPlan(clips, COLUMNS);

    assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Grouping helper
// ---------------------------------------------------------------------------

test("groupByTime keys on start and end together", function () {
    const groups = pairing.groupByTime([
        clip({ id: 0, startKey: "1", endKey: "2" }),
        clip({ id: 1, startKey: "1", endKey: "3" }),
        clip({ id: 2, startKey: "1", endKey: "2" })
    ]);

    assert.equal(groups.length, 2);
    assert.equal(groups[0].clips.length, 2);
    assert.equal(groups[1].clips.length, 1);
});

// ---------------------------------------------------------------------------
// Chain reasoning
// ---------------------------------------------------------------------------

function info(index, matchName) {
    return { index: index, matchName: matchName, displayName: matchName };
}

test("intrinsic components are recognised", function () {
    assert.equal(chainUtil.isIntrinsicMatchName("AE.ADBE Motion"), true);
    assert.equal(chainUtil.isIntrinsicMatchName("AE.ADBE Opacity"), true);
    assert.equal(chainUtil.isIntrinsicMatchName("AE.ADBE Time Remapping"), true);
    assert.equal(chainUtil.isIntrinsicMatchName("AE.ADBE Crop"), false);
    assert.equal(chainUtil.isIntrinsicMatchName("AE.ADBE Geometry2"), false);
});

test("with intrinsics first, our effects are appended", function () {
    const infos = [
        info(0, "AE.ADBE Opacity"),
        info(1, "AE.ADBE Motion"),
        info(2, "AE.ADBE AutoReframe"),
        info(3, "PR.ADBE Lumetri")
    ];
    assert.equal(chainUtil.computeInsertionIndex(infos), 4);
});

test("with intrinsics last, our effects go in front of them", function () {
    const infos = [
        info(0, "AE.ADBE AutoReframe"),
        info(1, "PR.ADBE Lumetri"),
        info(2, "AE.ADBE Motion"),
        info(3, "AE.ADBE Opacity")
    ];
    assert.equal(chainUtil.computeInsertionIndex(infos), 2);
});

test("a chain of only intrinsics appends", function () {
    const infos = [info(0, "AE.ADBE Opacity"), info(1, "AE.ADBE Motion")];
    assert.equal(chainUtil.computeInsertionIndex(infos), 2);
});

test("an empty chain inserts at zero", function () {
    assert.equal(chainUtil.computeInsertionIndex([]), 0);
});

test("our own pair is detected at the end of the standard effects", function () {
    const infos = [
        info(0, "AE.ADBE Opacity"),
        info(1, "AE.ADBE Motion"),
        info(2, "PR.ADBE Lumetri"),
        info(3, "AE.ADBE Geometry2"),
        info(4, "AE.ADBE Crop")
    ];
    assert.deepEqual(chainUtil.findOwnPair(infos, "AE.ADBE Geometry2", "AE.ADBE Crop"), {
        transformIndex: 3,
        cropIndex: 4
    });
});

test("a foreign crop alone is not mistaken for our pair", function () {
    const infos = [
        info(0, "AE.ADBE Motion"),
        info(1, "AE.ADBE Crop"),
        info(2, "PR.ADBE Lumetri")
    ];
    assert.equal(chainUtil.findOwnPair(infos, "AE.ADBE Geometry2", "AE.ADBE Crop"), null);
});

test("the wrong order is not mistaken for our pair", function () {
    const infos = [
        info(0, "AE.ADBE Motion"),
        info(1, "AE.ADBE Crop"),
        info(2, "AE.ADBE Geometry2")
    ];
    assert.equal(chainUtil.findOwnPair(infos, "AE.ADBE Geometry2", "AE.ADBE Crop"), null);
});

test("our pair is still found when a foreign crop precedes it", function () {
    const infos = [
        info(0, "AE.ADBE Motion"),
        info(1, "AE.ADBE Crop"),
        info(2, "AE.ADBE Geometry2"),
        info(3, "AE.ADBE Crop")
    ];
    assert.deepEqual(chainUtil.findOwnPair(infos, "AE.ADBE Geometry2", "AE.ADBE Crop"), {
        transformIndex: 2,
        cropIndex: 3
    });
});

test("match names are resolved exactly when available", function () {
    const available = ["AE.ADBE Mosaic", "AE.ADBE Crop", "AE.ADBE Geometry2"];
    assert.equal(
        chainUtil.resolveMatchName(available, ["AE.ADBE Crop"], ["crop"]),
        "AE.ADBE Crop"
    );
});

test("match name resolution falls back to the shortest fragment match", function () {
    const available = ["AE.ADBE Auto Crop Pro", "AE.ADBE Crop2"];
    assert.equal(
        chainUtil.resolveMatchName(available, ["AE.ADBE Crop"], ["crop"]),
        "AE.ADBE Crop2"
    );
});

test("match name resolution reports nothing when the effect is absent", function () {
    assert.equal(
        chainUtil.resolveMatchName(["AE.ADBE Mosaic"], ["AE.ADBE Crop"], ["crop"]),
        null
    );
});

test("the Motion component is located by match name", function () {
    const infos = [info(0, "AE.ADBE Opacity"), info(1, "AE.ADBE Motion")];
    assert.equal(chainUtil.findMotionIndex(infos), 1);
    assert.equal(chainUtil.findMotionIndex([info(0, "AE.ADBE Crop")]), -1);
});

test("name matching is case and whitespace tolerant", function () {
    assert.equal(chainUtil.nameMatchesAny("  Position ", ["position"]), true);
    assert.equal(chainUtil.nameMatchesAny("Skalierung", ["scale", "skalierung"]), true);
    assert.equal(chainUtil.nameMatchesAny("", ["position"]), false);
    assert.equal(chainUtil.nameMatchesAny(null, ["position"]), false);
});

test("cell labels are German", function () {
    assert.equal(pairing.cellLabel(CELL.LEFT), "links");
    assert.equal(pairing.cellLabel(CELL.BOTTOM), "unten");
});

// ---------------------------------------------------------------------------
// Unreadable clip times must never pair up with each other
// ---------------------------------------------------------------------------

test("a clip with unreadable times is rejected", function () {
    const clips = pair("1000", "2000", 0);
    clips[1].timesReadable = false;

    const result = pairing.buildPlan(clips, COLUMNS);

    assert.equal(result.ok, false);
    assert.ok(codes(result).indexOf(pairing.ERROR.TIMES_UNREADABLE) >= 0);
});

test("two clips with unreadable times are not paired with each other", function () {
    // Without the explicit rejection both would carry the same unknown time
    // key and look perfectly congruent.
    const clips = [
        clip({ id: 0, name: "a", trackIndex: 0, timesReadable: false }),
        clip({ id: 1, name: "b", trackIndex: 1, timesReadable: false })
    ];

    const result = pairing.buildPlan(clips, COLUMNS);

    assert.equal(result.ok, false);
    assert.deepEqual(result.pairs, []);
    assert.deepEqual(codes(result), [
        pairing.ERROR.TIMES_UNREADABLE,
        pairing.ERROR.TIMES_UNREADABLE
    ]);
});

test("the reason a Motion effect was unreadable reaches the message", function () {
    const clips = pair("1000", "2000", 0);
    clips[0].motion = null;
    clips[0].motionProblem = "Parameter nicht gefunden: Drehung";

    const result = pairing.buildPlan(clips, COLUMNS);

    assert.equal(result.ok, false);
    assert.match(result.errors[0].message, /Drehung/);
});

// ---------------------------------------------------------------------------
// Own-pair detection must survive later edits, or the next run stacks
// ---------------------------------------------------------------------------

test("our pair is still found when an effect was added afterwards", function () {
    // Everyday workflow: build the split screen, then grade the clip.
    const infos = [
        info(0, "AE.ADBE Opacity"),
        info(1, "AE.ADBE Motion"),
        info(2, "AE.ADBE Geometry2"),
        info(3, "AE.ADBE Crop"),
        info(4, "PR.ADBE Lumetri")
    ];
    assert.deepEqual(chainUtil.findOwnPair(infos, "AE.ADBE Geometry2", "AE.ADBE Crop"), {
        transformIndex: 2,
        cropIndex: 3
    });
});

test("with two stacked pairs the last one is addressed", function () {
    const infos = [
        info(0, "AE.ADBE Motion"),
        info(1, "AE.ADBE Geometry2"),
        info(2, "AE.ADBE Crop"),
        info(3, "AE.ADBE Geometry2"),
        info(4, "AE.ADBE Crop")
    ];
    assert.deepEqual(chainUtil.findOwnPair(infos, "AE.ADBE Geometry2", "AE.ADBE Crop"), {
        transformIndex: 3,
        cropIndex: 4
    });
});

test("a non-adjacent Transform and Crop are not taken for our pair", function () {
    const infos = [
        info(0, "AE.ADBE Motion"),
        info(1, "AE.ADBE Geometry2"),
        info(2, "PR.ADBE Lumetri"),
        info(3, "AE.ADBE Crop")
    ];
    assert.equal(chainUtil.findOwnPair(infos, "AE.ADBE Geometry2", "AE.ADBE Crop"), null);
});

// ---------------------------------------------------------------------------
// Video vs audio
// ---------------------------------------------------------------------------

test("a video chain is recognised by its video-only intrinsics", function () {
    assert.equal(
        chainUtil.looksLikeVideoChain([info(0, "AE.ADBE Opacity"), info(1, "AE.ADBE Motion")]),
        true
    );
});

test("an audio chain is not recognised as video", function () {
    assert.equal(
        chainUtil.looksLikeVideoChain([
            info(0, "AE.ADBE Volume"),
            info(1, "AE.ADBE Panner")
        ]),
        false
    );
});

test("a video clip with an unrecognised Motion effect still counts as video", function () {
    // It must reach the Motion validation and produce a clear error there,
    // instead of being silently dropped as "not a video clip".
    const infos = [info(0, "AE.ADBE Opacity"), info(1, "AE.ADBE SomethingNew")];
    assert.equal(chainUtil.looksLikeVideoChain(infos), true);
    assert.equal(chainUtil.findMotionIndex(infos), -1);
});
