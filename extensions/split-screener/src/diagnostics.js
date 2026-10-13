/**
 * Split Screener — src/diagnostics.js
 *
 * Dumps everything about the selected clips that the plugin relies on: the
 * component chain with match names and indices, every parameter with its value
 * and kind, the match names the host offers for the two effects we insert, and
 * the result of the unit detection.
 *
 * This exists because several details cannot be confirmed from Adobe's
 * documentation — the units of the Transform position, whether percentage
 * parameters are 0‥1 or 0‥100, the localized parameter display names (there is
 * no matchName for parameters, and in some effects the name is blank), and
 * where the intrinsic components sit in the chain. Running this once in the
 * target installation turns all of those from guesses into facts.
 *
 * Read-only. Nothing in here touches the project.
 */

const ppro = require("premierepro");

const C = require("./constants.js");
const V = require("./values.js");
const geometry = require("./geometry.js");
const chainUtil = require("./chain.js");
const core = require("./core.js");

const MAX_COMPONENTS = 40;

function describeDumpValue(entry) {
    if (entry.note) return "(" + entry.note + ")";
    if (entry.value === undefined) return "(nicht gelesen)";
    if (entry.valueType === "point") {
        return (
            "PointF(x=" +
            geometry.round4(entry.value.x) +
            ", y=" +
            geometry.round4(entry.value.y) +
            ")"
        );
    }
    if (entry.valueType === "number") return "number(" + geometry.round4(entry.value) + ")";
    if (entry.valueType === "boolean") return "boolean(" + entry.value + ")";
    // Unusable: `value` already holds the safeJson rendering of the raw value.
    return "unbrauchbar " + String(entry.value);
}

/**
 * @returns {Promise<{fatalError: string|null, lines: string[], meta: Object}>}
 */
async function runDiagnostics() {
    const lines = [];
    const meta = {
        timestamp: new Date().toISOString(),
        pluginVersion: core.PLUGIN_VERSION,
        mode: "diagnostics",
        host: core.describeHost()
    };

    lines.push("— Umgebung —");
    const hostKeys = Object.keys(meta.host);
    for (let i = 0; i < hostKeys.length; i++) {
        lines.push(hostKeys[i] + ": " + meta.host[hostKeys[i]]);
    }
    lines.push("Plugin-Version: " + meta.pluginVersion);
    lines.push("Zeitpunkt: " + meta.timestamp);

    const project = await ppro.Project.getActiveProject();
    if (!project) {
        return { fatalError: "Kein aktives Projekt gefunden.", lines: lines, meta: meta };
    }

    const sequence = await project.getActiveSequence();
    if (!sequence) {
        return { fatalError: "Keine aktive Sequenz.", lines: lines, meta: meta };
    }

    lines.push("");
    lines.push("— Sequenz —");
    lines.push("Name: " + (sequence.name || "(unbenannt)"));

    let width = 0;
    let height = 0;
    try {
        const frameSize = await sequence.getFrameSize();
        width = frameSize ? frameSize.width : 0;
        height = frameSize ? frameSize.height : 0;
        lines.push("Framegröße: " + width + " x " + height);
    } catch (error) {
        lines.push("Framegröße nicht lesbar: " + core.describeError(error));
    }

    lines.push("");
    lines.push("— Verfügbare Effekt-matchNames —");
    const resolved = await core.resolveEffectMatchNames();
    lines.push("Transformieren aufgelöst als: " + (resolved.transform || "NICHT GEFUNDEN"));
    lines.push("Zuschneiden aufgelöst als: " + (resolved.crop || "NICHT GEFUNDEN"));

    const interesting = [];
    for (let i = 0; i < resolved.available.length; i++) {
        const name = resolved.available[i];
        if (
            chainUtil.containsAnyFragment(name, C.CROP_MATCHNAME_FRAGMENTS) ||
            chainUtil.containsAnyFragment(name, C.TRANSFORM_MATCHNAME_FRAGMENTS)
        ) {
            interesting.push(name);
        }
    }
    lines.push(
        "Kandidaten im Host (" +
            resolved.available.length +
            " Effekte insgesamt): " +
            (interesting.length ? interesting.join(", ") : "keine")
    );

    const selection = await sequence.getSelection();
    const trackItems = selection ? await selection.getTrackItems() : [];
    if (!trackItems || !trackItems.length) {
        lines.push("");
        lines.push("Kein Clip ausgewählt — Effektkette kann nicht ausgelesen werden.");
        return { fatalError: null, lines: lines, meta: meta };
    }

    for (let t = 0; t < trackItems.length; t++) {
        const trackItem = trackItems[t];

        let name = "(unbenannt)";
        try {
            name = (await trackItem.getName()) || name;
        } catch {
            /* keep fallback */
        }

        lines.push("");
        lines.push("— Clip " + (t + 1) + ": " + name + " —");

        try {
            lines.push("Spurindex: " + (await trackItem.getTrackIndex()));
        } catch {
            lines.push("Spurindex: nicht lesbar");
        }

        let time = null;
        try {
            time = await trackItem.getInPoint();
        } catch {
            time = null;
        }
        lines.push("Zeitbasis (In-Punkt): " + (time ? time.seconds + " s" : "nicht lesbar"));

        if (typeof trackItem.getComponentChain !== "function") {
            lines.push("Keine Effektkette (kein Video-Clip).");
            continue;
        }

        let componentChain = null;
        try {
            componentChain = await trackItem.getComponentChain();
        } catch (error) {
            lines.push("Effektkette nicht lesbar: " + core.describeError(error));
            continue;
        }
        if (!componentChain) {
            lines.push("Effektkette ist leer.");
            continue;
        }

        const infos = await core.readChainInfos(componentChain);
        lines.push(
            "Als Video-Clip erkannt: " + (chainUtil.looksLikeVideoChain(infos) ? "ja" : "nein")
        );
        lines.push(
            "Einfügeindex für unsere Effekte: " + chainUtil.computeInsertionIndex(infos)
        );
        const ownPair =
            resolved.transform && resolved.crop
                ? chainUtil.findOwnPair(infos, resolved.transform, resolved.crop)
                : null;
        lines.push(
            "Von Split Screener angelegtes Paar: " +
                (ownPair
                    ? "ja (Transformieren @" +
                      ownPair.transformIndex +
                      ", Zuschneiden @" +
                      ownPair.cropIndex +
                      ")"
                    : "nein")
        );

        const limit = Math.min(infos.length, MAX_COMPONENTS);
        for (let i = 0; i < limit; i++) {
            const info = infos[i];
            const component = componentChain.getComponentAtIndex(info.index);
            if (!component) continue;

            lines.push(
                "  [" +
                    info.index +
                    "] " +
                    (info.displayName || "(ohne Namen)") +
                    "  matchName=" +
                    (info.matchName || "?") +
                    (chainUtil.isIntrinsicMatchName(info.matchName) ? "  (intrinsisch)" : "")
            );

            // Same dump the parameter resolver attaches to its errors, so the
            // log and the error messages describe the effect identically.
            const dump = await core.describeComponentParams(component, time);
            for (let p = 0; p < dump.length; p++) {
                const entry = dump[p];
                lines.push(
                    "      (" +
                        entry.index +
                        ") " +
                        (entry.name === undefined || entry.name === ""
                            ? "(OHNE NAMEN)"
                            : entry.name) +
                        " = " +
                        describeDumpValue(entry) +
                        " · " +
                        (entry.timeVarying === null
                            ? "Keyframe-Status unbekannt"
                            : entry.timeVarying
                              ? "keyframed"
                              : "statisch")
                );
            }
        }
        if (infos.length > limit) {
            lines.push("  … " + (infos.length - limit) + " weitere Komponenten");
        }

        // Unit detection, spelled out so the result can be sanity checked.
        const motionIndex = chainUtil.findMotionIndex(infos);
        if (motionIndex >= 0 && width > 0 && height > 0) {
            const motion = componentChain.getComponentAtIndex(motionIndex);
            const dump = await core.describeComponentParams(motion, time);
            lines.push("  Einheiten-Erkennung:");

            const positionIndex = core.findParamIndex(
                motion,
                C.MOTION_POSITION_NAMES,
                C.MOTION_POSITION_FRAGMENTS,
                []
            );
            if (positionIndex >= 0) {
                const entry = dump[positionIndex] || {};
                lines.push(
                    "    Bewegung · Position: " +
                        describeDumpValue(entry) +
                        " → " +
                        (entry.valueType === "point"
                            ? geometry.detectPositionUnit(entry.value, width, height)
                            : "nicht bestimmbar")
                );
            } else {
                lines.push("    Bewegung · Position: Parameter nicht gefunden!");
            }

            const scaleIndex = core.findParamIndex(
                motion,
                C.MOTION_SCALE_NAMES,
                C.MOTION_SCALE_FRAGMENTS,
                []
            );
            if (scaleIndex >= 0) {
                const entry = dump[scaleIndex] || {};
                lines.push(
                    "    Bewegung · Skalierung: " +
                        describeDumpValue(entry) +
                        " → " +
                        (entry.valueType === "number"
                            ? geometry.detectScaleConvention(entry.value) +
                              " (Faktor " +
                              geometry.round4(geometry.toScaleFactor(entry.value)) +
                              ")"
                            : "nicht bestimmbar")
                );
            } else {
                lines.push("    Bewegung · Skalierung: Parameter nicht gefunden!");
            }
        } else if (motionIndex < 0) {
            lines.push("  Kein Bewegungs-Effekt in der Kette gefunden.");
        }

        if (ownPair) {
            const transform = componentChain.getComponentAtIndex(ownPair.transformIndex);
            const positionIndex = core.findParamIndex(
                transform,
                C.TRANSFORM_POSITION_NAMES,
                C.TRANSFORM_POSITION_FRAGMENTS,
                []
            );
            lines.push(
                "    Transformieren · Position: " +
                    (positionIndex >= 0
                        ? "Index " + positionIndex
                        : "über den Namen nicht gefunden — struktureller Fallback nötig")
            );
        }
    }

    lines.push("");
    lines.push("— Rohdaten —");
    lines.push(V.safeJson(meta));

    return { fatalError: null, lines: lines, meta: meta };
}

module.exports = {
    runDiagnostics: runDiagnostics
};
