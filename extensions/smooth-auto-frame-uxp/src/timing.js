/** Reference times are source times inside the VISIBLE clip, not the extrema
 * of its keyframe list. This first implementation supports forward 100% clips.
 */
function referenceTimes(input) {
    const { inPoint, outPoint, start, end, frameDuration, timing, playhead, speed, reversed } = input;
    if (![inPoint, outPoint, start, end, frameDuration].every(Number.isFinite) ||
        outPoint <= inPoint || end <= start || frameDuration <= 0) {
        throw new Error("Clip-Zeitbereich oder Framerate nicht lesbar.");
    }
    const duration = end - start;
    if (speed !== 1 || reversed !== 0 && reversed !== false ||
        Math.abs((outPoint - inPoint) - duration) > 1e-6) {
        throw new Error("Dieser Ablauf unterstützt vorwärts laufende Clips mit 100 % Geschwindigkeit; Retiming zuerst auflösen.");
    }
    const lastFrame = Math.max(0, Math.ceil(duration / frameDuration - 1e-7) - 1);
    let frame = 0;
    if (timing === "end") frame = lastFrame;
    else if (timing === "middle") frame = Math.min(lastFrame, Math.floor(duration / (2 * frameDuration) + 1e-7));
    else if (timing === "playhead") {
        if (!Number.isFinite(playhead) || playhead < start || playhead >= end) {
            throw new Error("Abspielposition liegt außerhalb dieses Clips. Playhead hineinsetzen oder Anfang/Mitte/Ende wählen.");
        }
        frame = Math.min(lastFrame, Math.floor((playhead - start) / frameDuration + 1e-7));
    }
    const reference = inPoint + frame * frameDuration;
    const samples = [0, 0.25, 0.5, 0.75, 1].map((fraction) =>
        inPoint + Math.floor(lastFrame * fraction) * frameDuration);
    samples.push(reference);
    return {
        reference: reference,
        sequenceReference: start + frame * frameDuration,
        first: inPoint,
        last: inPoint + lastFrame * frameDuration,
        samples: Array.from(new Set(samples)).sort((a, b) => a - b)
    };
}

module.exports = { referenceTimes };
