/**
 * Reframe Lock — src/report.js
 *
 * Turns a report object into display data and into the exportable log text.
 *
 * Pure: no DOM, no Premiere. main.js converts the returned descriptors into
 * elements, which keeps the formatting — the part that is easy to get subtly
 * wrong — unit-testable, and keeps clip names (which come from media
 * filenames) away from any markup path.
 */

const STATUS_LABEL = {
    ok: "fixiert",
    dryRun: "Vorschau",
    planned: "geplant",
    skipped: "übersprungen",
    error: "Fehler"
};

function num(value, digits) {
    if (typeof value !== "number" || !isFinite(value)) return "–";
    return value.toFixed(digits === undefined ? 2 : digits);
}

function formatPoint(point, digits) {
    if (!point || typeof point.x !== "number") return "–";
    return num(point.x, digits === undefined ? 4 : digits) + " / " + num(point.y, digits === undefined ? 4 : digits);
}

function formatDrift(drift) {
    if (!drift) return "unbekannt";
    return (
        num(drift.peakPixels, 1) +
        " px (" +
        num(drift.xPercentOfWidth, 2) +
        " % der Breite, " +
        num(drift.yPercentOfHeight, 2) +
        " % der Höhe)"
    );
}

const REFERENCE_LABEL = {
    start: "Anfang des Clips",
    middle: "Zeitliche Mitte",
    end: "Ende des Clips",
    playhead: "Abspielposition",
    median: "Median aller Abtastpunkte",
    mean: "Mittelwert aller Abtastpunkte"
};

const SCOPE_LABEL = {
    selection: "Auswahl",
    track: "Ganze Spur der Auswahl",
    allTracks: "Alle Videospuren"
};

const CONVENTION_LABEL = {
    frameNormalized: "normiert, 0,5 = Bildmitte (wie Motion)",
    centerRelative: "Versatz zur Bildmitte (0 = Mitte)",
    pixels: "Sequenzpixel",
    unknown: "unbestimmt"
};

const CONFIDENCE_LABEL = {
    "cross-checked": "gegengeprüft",
    measured: "gemessen",
    ambiguous: "mehrdeutig",
    weak: "schwach",
    none: "keine"
};

/** Which axis a fill-crop has no freedom along — the calibration's probe. */
const AXIS_LABEL = {
    x: "horizontal",
    y: "vertikal",
    both: "beide (gleiches Seitenverhältnis)"
};

/**
 * Builds the detail lines for one clip.
 * Each line is `{ kind, text }`; `kind` drives the CSS class only.
 */
function clipLines(record) {
    const lines = [];

    if (record.reason) lines.push({ kind: "reason", text: record.reason });

    /*
     * Both formats are shown because both are MEASURED, and because the pair
     * is what decides the calibration. Seeing them makes a wrong read (e.g.
     * footage reinterpreted with the wrong pixel aspect) immediately obvious.
     */
    const geo = record.calibration && record.calibration.geometry;
    if (geo) {
        const sourceLabel = geo.source
            ? geo.source.width +
              "×" +
              geo.source.height +
              (geo.source.pixelAspect && geo.source.pixelAspect !== 1
                  ? " PAR " + num(geo.source.pixelAspect, 3)
                  : "")
            : "nicht lesbar";
        lines.push({
            kind: "metric",
            text:
                "Format: Quelle " +
                sourceLabel +
                " → Sequenz " +
                (geo.frame ? geo.frame.width + "×" + geo.frame.height : "?") +
                " · festliegende Achse: " +
                (AXIS_LABEL[geo.pinnedAxis] || "unbekannt")
        });
        if (
            typeof geo.expectedFillScalePercent === "number" &&
            typeof geo.measuredScalePercent === "number"
        ) {
            lines.push({
                kind: "metric",
                text:
                    "Füllskalierung: gemessen " +
                    num(geo.measuredScalePercent, 2) +
                    " %, aus den Formaten berechnet " +
                    num(geo.expectedFillScalePercent, 2) +
                    " %"
            });
        }
    }

    if (record.drift) {
        lines.push({
            kind: "metric",
            text:
                "Gemessene Bewegung: " +
                formatDrift(record.drift) +
                " über " +
                (record.measurement ? record.measurement.sampleCount : "?") +
                " Abtastpunkte"
        });
    }

    if (record.calibration && record.calibration.convention) {
        const probes = (record.calibration.probes || []).map((p) => p.name).join(", ");
        lines.push({
            kind: "metric",
            text:
                "Kalibrierung: " +
                (CONVENTION_LABEL[record.calibration.convention] ||
                    record.calibration.convention) +
                " · Vertrauen: " +
                (CONFIDENCE_LABEL[record.calibration.confidence] ||
                    record.calibration.confidence) +
                (probes ? " · Prüfungen: " + probes : "")
        });
    }

    if (record.reference) {
        lines.push({
            kind: "metric",
            text:
                "Referenz: " +
                (REFERENCE_LABEL[record.reference.method] || record.reference.method) +
                " bei " +
                num(record.reference.seconds, 3) +
                " s im Clip"
        });
    }

    if (record.write) {
        const parts = ["Position → " + formatPoint(record.write.position)];
        if (record.write.scale !== null && record.write.scale !== undefined) {
            parts.push("Skalierung → " + num(record.write.scale, 2) + " %");
        }
        if (record.write.rotation !== null && record.write.rotation !== undefined) {
            parts.push("Drehung → " + num(record.write.rotation, 2) + "°");
        }
        parts.push(
            record.write.autoReframeAction === "remove"
                ? "Auto Reframe entfernen"
                : "Auto Reframe deaktivieren"
        );
        lines.push({ kind: "changes", text: parts.join(" · ") });
    }

    if (record.verification) {
        for (let i = 0; i < record.verification.checked.length; i++) {
            lines.push({ kind: "verified", text: "✓ " + record.verification.checked[i] });
        }
        for (let i = 0; i < record.verification.problems.length; i++) {
            lines.push({ kind: "problem", text: "✗ " + record.verification.problems[i] });
        }
    }

    if (record.warnings) {
        for (let i = 0; i < record.warnings.length; i++) {
            lines.push({ kind: "warning", text: "⚠ " + record.warnings[i] });
        }
    }

    return lines;
}

/** Builds the whole panel view model. */
function viewModel(report) {
    if (report.fatalError) {
        return { fatal: report.fatalError, pills: [], clips: [], headline: "Abgebrochen" };
    }

    const summary = report.summary || {};
    const pills = [
        { kind: "ok", text: (summary.dryRun ? "Vorschau: " : "Fixiert: ") + (summary.dryRun ? summary.planned || 0 : summary.written || 0) },
        { kind: "skipped", text: "Übersprungen: " + (summary.skipped || 0) },
        { kind: "error", text: "Fehler: " + (summary.failed || 0) }
    ];

    const headline =
        (summary.dryRun ? "Dry-Run abgeschlossen" : "Fertig") +
        " — " +
        (summary.clipsInScope || 0) +
        " Clip(s) geprüft, Bereich: " +
        (SCOPE_LABEL[report.options && report.options.scope] ||
            (report.options && report.options.scope) ||
            "?") +
        ", Referenz: " +
        (REFERENCE_LABEL[report.options && report.options.reference] ||
            (report.options && report.options.reference) ||
            "?");

    const clips = (report.clips || []).map((record) => ({
        name: (record.trackIndex ? "V" + record.trackIndex + " · " : "") + record.clipName,
        status: record.status,
        statusLabel: STATUS_LABEL[record.status] || record.status,
        lines: clipLines(record)
    }));

    const notes = [];
    if (summary.dryRun) {
        notes.push(
            "Dry-Run: es wurde nichts geschrieben. Zum echten Schreiben Dry-Run abwählen."
        );
    } else if (summary.written > 0) {
        notes.push("Der ganze Lauf ist ein einzelner Undo-Schritt (Cmd/Ctrl+Z).");
    }
    if (report.sequence) {
        notes.push(
            "Sequenz: " +
                report.sequence.sizeLabel +
                " (" +
                report.sequence.aspectLabel +
                ") — aus den Sequenzeinstellungen gelesen. Quellformate werden je " +
                "Clip aus den Medien-Metadaten gemessen."
        );
    }
    if (report.log && report.log.truncated) {
        notes.push("Das Log wurde gekürzt — es gab mehr Einträge als die Obergrenze.");
    }

    return { headline: headline, pills: pills, clips: clips, notes: notes };
}

/** Pretty-printed JSON for the clipboard and for the saved log file. */
function toJsonText(report) {
    try {
        return JSON.stringify(report, null, 2);
    } catch (error) {
        return (
            "Report konnte nicht serialisiert werden: " +
            (error && error.message ? error.message : String(error))
        );
    }
}

module.exports = {
    STATUS_LABEL: STATUS_LABEL,
    REFERENCE_LABEL: REFERENCE_LABEL,
    SCOPE_LABEL: SCOPE_LABEL,
    CONVENTION_LABEL: CONVENTION_LABEL,
    AXIS_LABEL: AXIS_LABEL,
    formatDrift: formatDrift,
    formatPoint: formatPoint,
    clipLines: clipLines,
    viewModel: viewModel,
    toJsonText: toJsonText
};
