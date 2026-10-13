/**
 * Smooth Auto Frame — main.js
 *
 * Panel wiring: registers the UXP panel entrypoint, reads the UI options and
 * renders the report returned by src/core.js.
 *
 * All DOM output goes through createElement/textContent — never innerHTML —
 * so clip names coming from media filenames can never be interpreted as markup.
 */

const { entrypoints } = require("uxp");
const core = require("./src/core.js");
const { runSmoothAutoFrame } = core;

entrypoints.setup({
    panels: {
        smoothAutoFramePanel: {
            create() {
                /* Panel content is already present in index.html. */
            },
            show() {
                /* Nothing to append — single-panel plugin. */
            }
        }
    }
});

const el = {};

function cacheElements() {
    el.timingOption = document.getElementById("timingOption");
    el.dryRun = document.getElementById("dryRun");
    el.runButton = document.getElementById("runButton");
    el.clearButton = document.getElementById("clearButton");
    el.copyButton = document.getElementById("copyButton");
    el.saveButton = document.getElementById("saveButton");
    el.statusBar = document.getElementById("statusBar");
    el.summary = document.getElementById("summary");
    el.summaryOk = document.getElementById("summaryOk");
    el.summarySkipped = document.getElementById("summarySkipped");
    el.summaryError = document.getElementById("summaryError");
    el.log = document.getElementById("log");
    el.buildInfo = document.getElementById("buildInfo");
}

/** Last report, kept so it can be copied or saved for diagnostics. */
let lastReport = null;

function setExportEnabled(enabled) {
    el.copyButton.disabled = !enabled;
    el.saveButton.disabled = !enabled;
}

/**
 * Renders the last report as pretty-printed JSON for export. Includes the
 * meta block (timestamp, plugin version, chosen options, host info) so a log
 * is self-explanatory without having to ask what settings were used.
 */
function buildLogText() {
    if (!lastReport) return "";
    try {
        return JSON.stringify(lastReport, null, 2);
    } catch (error) {
        return (
            "Report konnte nicht serialisiert werden: " +
            (error && error.message ? error.message : String(error))
        );
    }
}

function suggestedFileName() {
    const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .slice(0, 19);
    return "smooth-auto-frame_" + stamp + ".json";
}

function clearChildren(node) {
    while (node.firstChild) {
        node.removeChild(node.firstChild);
    }
}

function createLine(className, text) {
    const div = document.createElement("div");
    div.className = className;
    div.textContent = text;
    return div;
}

function setStatus(text) {
    el.statusBar.textContent = text || "";
}

function showEmptyState() {
    clearChildren(el.log);
    el.log.appendChild(
        createLine(
            "empty-state",
            'Noch keine Ausführung. Optionen wählen und "Ausführen" klicken.'
        )
    );
    el.summary.classList.remove("visible");
}

function renderFatalError(message) {
    clearChildren(el.log);
    el.log.appendChild(createLine("fatal-error", message));
    el.summary.classList.remove("visible");
}

function formatChanges(changes) {
    const parts = [];
    for (let i = 0; i < changes.length; i++) {
        const change = changes[i];
        let text = change.param + " → " + change.value;
        if (typeof change.keyframesBefore === "number" && change.keyframesBefore > 0) {
            text += " (vorher " + change.keyframesBefore + " Keyframes)";
        }
        parts.push(text);
    }
    return parts.join(" · ");
}

function renderReport(report) {
    if (report.fatalError) {
        renderFatalError(report.fatalError);
        return;
    }

    el.summary.classList.add("visible");
    el.summaryOk.textContent = report.dryRun
        ? "Vorgeprüft: " + report.planned
        : "Verarbeitet: " + report.processed;
    el.summarySkipped.textContent = "Übersprungen: " + report.skipped;
    el.summaryError.textContent = "Fehler: " + report.errors;

    clearChildren(el.log);

    if (report.notes && report.notes.length) {
        for (let i = 0; i < report.notes.length; i++) {
            el.log.appendChild(createLine("reason", report.notes[i]));
        }
    }

    if (!report.results || !report.results.length) {
        el.log.appendChild(createLine("empty-state", "Keine Clips verarbeitet."));
        return;
    }

    for (let i = 0; i < report.results.length; i++) {
        const result = report.results[i];

        const entry = document.createElement("div");
        entry.classList.add("log-entry");
        entry.classList.add("status-" + result.status);

        entry.appendChild(createLine("clip-name", result.clipName));
        if (result.reason) {
            entry.appendChild(createLine("reason", result.reason));
        }
        if (result.steps && result.steps.length) {
            entry.appendChild(createLine("reason", result.steps.map((step) => step.label).join(" → ")));
        }
        if (result.changes && result.changes.length) {
            entry.appendChild(createLine("changes", formatChanges(result.changes)));
        }

        el.log.appendChild(entry);
    }
}

/**
 * Reads the selected timing option.
 *
 * `sp-picker` normally exposes `.value`, but across UXP versions it can come
 * back empty while the selected `sp-menu-item` carries the value. Falling back
 * blindly to a default would silently ignore the user's choice, so both paths
 * are checked explicitly.
 */
function readTimingOption() {
    const picker = el.timingOption;
    if (!picker) return "playhead";

    if (typeof picker.value === "string" && picker.value) {
        return picker.value;
    }

    const selected =
        picker.querySelector("sp-menu-item[selected]") ||
        picker.querySelector("sp-menu-item[aria-selected='true']");
    if (selected) {
        const attr = selected.getAttribute("value");
        if (attr) return attr;
        if (typeof selected.value === "string" && selected.value) {
            return selected.value;
        }
    }

    return "playhead";
}

function readOptions() {
    return {
        timing: readTimingOption(),
        dryRun: !!el.dryRun.checked
    };
}

const TIMING_LABELS = {
    start: "Anfang des Clips",
    middle: "Mitte des Clips",
    end: "Letzter sichtbarer Frame",
    playhead: "Aktuelle Abspielposition"
};

async function onRun() {
    el.runButton.disabled = true;
    const options = readOptions();
    setStatus(options.dryRun ? "Dry-Run läuft…" : "Wird ausgeführt…");

    try {
        const report = await runSmoothAutoFrame(options);
        lastReport = report;
        setExportEnabled(true);
        renderReport(report);
        if (report.fatalError) {
            setStatus("Abgebrochen.");
        } else {
            const label = TIMING_LABELS[report.timing] || report.timing;
            setStatus(
                (report.errors ? "Mit Fehlern beendet" : options.dryRun ? "Vorprüfung abgeschlossen" : "Parameter geprüft") +
                    " — Referenz: " +
                    label
            );
        }
    } catch (error) {
        const message =
            error && error.message ? error.message : String(error || "Unbekannter Fehler");
        lastReport = {
            fatalError: message,
            meta: { timestamp: new Date().toISOString(), options: options }
        };
        setExportEnabled(true);
        setStatus("Fehler.");
        renderFatalError("Unerwarteter Fehler: " + message);
        console.error(error);
    } finally {
        el.runButton.disabled = false;
    }
}

/** Copies the last report to the system clipboard. */
async function onCopy() {
    const text = buildLogText();
    if (!text) {
        setStatus("Kein Log vorhanden.");
        return;
    }
    try {
        await navigator.clipboard.setContent({ "text/plain": text });
        setStatus("Log in die Zwischenablage kopiert (" + text.length + " Zeichen).");
    } catch (error) {
        setStatus("Kopieren fehlgeschlagen.");
        console.error(error);
    }
}

/**
 * Saves the last report to a user-chosen file.
 * Uses a save dialog, so the plugin only ever touches the one file the user
 * explicitly picked (manifest permission: localFileSystem "request").
 */
async function onSave() {
    const text = buildLogText();
    if (!text) {
        setStatus("Kein Log vorhanden.");
        return;
    }
    try {
        const { localFileSystem } = require("uxp").storage;
        const file = await localFileSystem.getFileForSaving(suggestedFileName(), {
            types: ["json"]
        });
        if (!file) {
            setStatus("Speichern abgebrochen.");
            return;
        }
        await file.write(text);
        setStatus("Log gespeichert: " + (file.nativePath || file.name));
    } catch (error) {
        setStatus("Speichern fehlgeschlagen.");
        console.error(error);
    }
}

function onClear() {
    lastReport = null;
    setExportEnabled(false);
    showEmptyState();
    setStatus("");
}

/**
 * Shows which build is loaded.
 *
 * UXP caches required modules, so a Reload in UDT can leave stale code
 * running. Without a visible marker that is indistinguishable from a working
 * build — which cost several test cycles. If the number here does not match
 * the expected one, the loaded code is old: remove and re-add the plugin in
 * UDT, or restart Premiere.
 */
function showBuildInfo() {
    if (!el.buildInfo) return;
    el.buildInfo.textContent =
        "Build " + (core.PLUGIN_VERSION || "?") +
        " · Diagnose d" + (core.DIAGNOSTICS_VERSION || "?");
}

function init() {
    cacheElements();
    showBuildInfo();
    el.runButton.addEventListener("click", onRun);
    el.clearButton.addEventListener("click", onClear);
    el.copyButton.addEventListener("click", onCopy);
    el.saveButton.addEventListener("click", onSave);
    setExportEnabled(false);
    showEmptyState();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
