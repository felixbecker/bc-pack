/**
 * Split Screener — main.js
 *
 * Panel wiring: registers the UXP panel entrypoint, reads the options, calls
 * src/core.js and renders the report.
 *
 * All output goes through createElement/textContent — never innerHTML — so a
 * clip name coming from a media filename can never be interpreted as markup.
 */

const { entrypoints } = require("uxp");
const core = require("./src/core.js");
const diagnostics = require("./src/diagnostics.js");
const { LAYOUT } = require("./src/constants.js");

const SETTINGS_KEY = "splitScreener.settings.v1";

entrypoints.setup({
    panels: {
        splitScreenerPanel: {
            create() {
                /* Panel content already lives in index.html. */
            },
            show() {
                /* Nothing to append — single-panel plugin. */
            }
        }
    }
});

const el = {};

/**
 * The last report or diagnostics result, kept so it can be exported.
 *
 * Exporting matters more here than in most plugins: several API details cannot
 * be confirmed from Adobe's documentation and are detected at runtime instead,
 * so the log is the evidence for whether that detection was right. Having to
 * retype it from the panel would make it useless.
 */
let lastResult = null;

function cacheElements() {
    el.layoutOption = document.getElementById("layoutOption");
    el.swapClips = document.getElementById("swapClips");
    el.dryRun = document.getElementById("dryRun");
    el.createButton = document.getElementById("createButton");
    el.removeButton = document.getElementById("removeButton");
    el.diagnoseButton = document.getElementById("diagnoseButton");
    el.clearButton = document.getElementById("clearButton");
    el.copyButton = document.getElementById("copyButton");
    el.saveButton = document.getElementById("saveButton");
    el.statusBar = document.getElementById("statusBar");
    el.summary = document.getElementById("summary");
    el.summaryOk = document.getElementById("summaryOk");
    el.summarySkipped = document.getElementById("summarySkipped");
    el.summaryError = document.getElementById("summaryError");
    el.log = document.getElementById("log");
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

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

function setBusy(busy) {
    el.createButton.disabled = busy;
    el.removeButton.disabled = busy;
    el.diagnoseButton.disabled = busy;
}

function setExportEnabled(enabled) {
    el.copyButton.disabled = !enabled;
    el.saveButton.disabled = !enabled;
}

/** Remembers a result for export and enables the export buttons. */
function keepForExport(result) {
    lastResult = result;
    setExportEnabled(!!result);
}

/**
 * Renders the kept result as text. Reports go out as JSON — they are
 * structured data including the parameter dumps — while a diagnostics run is
 * already a list of lines and stays readable as plain text.
 */
function buildLogText() {
    if (!lastResult) return "";
    try {
        if (lastResult.lines) {
            const header = lastResult.meta
                ? "# Split Screener Diagnose\n" +
                  JSON.stringify(lastResult.meta, null, 2) +
                  "\n\n"
                : "# Split Screener Diagnose\n\n";
            return header + lastResult.lines.join("\n") + "\n";
        }
        return JSON.stringify(lastResult, null, 2);
    } catch (error) {
        return (
            "Log konnte nicht serialisiert werden: " +
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
    const kind = lastResult && lastResult.lines ? "diagnose" : "report";
    const extension = lastResult && lastResult.lines ? ".txt" : ".json";
    return "split-screener_" + kind + "_" + stamp + extension;
}

function showEmptyState() {
    clearChildren(el.log);
    el.log.appendChild(
        createLine(
            "empty-state",
            "Noch keine Ausführung. Zwei deckungsgleiche Clips auswählen und starten."
        )
    );
    el.summary.classList.remove("visible");
}

function formatChanges(changes) {
    const parts = [];
    for (let i = 0; i < changes.length; i++) {
        parts.push(changes[i].param + ": " + changes[i].value);
    }
    return parts.join(" · ");
}

function renderReport(report) {
    clearChildren(el.log);

    if (report.fatalError) {
        el.log.appendChild(createLine("fatal-error", report.fatalError));
    }

    if (report.validationErrors && report.validationErrors.length) {
        for (let i = 0; i < report.validationErrors.length; i++) {
            el.log.appendChild(
                createLine("validation", "• " + report.validationErrors[i].message)
            );
        }
    }

    const hasCounters =
        report.processed > 0 ||
        report.skipped > 0 ||
        report.errors > 0 ||
        (report.results && report.results.length > 0);

    if (hasCounters) {
        el.summary.classList.add("visible");
        el.summaryOk.textContent = "Verarbeitet: " + report.processed;
        el.summarySkipped.textContent = "Übersprungen: " + report.skipped;
        el.summaryError.textContent = "Fehler: " + report.errors;
    } else {
        el.summary.classList.remove("visible");
    }

    if (report.notes && report.notes.length) {
        for (let i = 0; i < report.notes.length; i++) {
            el.log.appendChild(createLine("reason", report.notes[i]));
        }
    }

    if (report.results && report.results.length) {
        for (let i = 0; i < report.results.length; i++) {
            const result = report.results[i];

            const entry = document.createElement("div");
            entry.classList.add("log-entry");
            entry.classList.add("status-" + result.status);

            entry.appendChild(createLine("clip-name", result.clipName));
            if (result.reason) {
                entry.appendChild(createLine("reason", result.reason));
            }
            if (result.changes && result.changes.length) {
                entry.appendChild(createLine("changes", formatChanges(result.changes)));
            }

            el.log.appendChild(entry);
        }
    } else if (!report.fatalError && !(report.notes && report.notes.length)) {
        el.log.appendChild(createLine("empty-state", "Keine Clips verarbeitet."));
    }
}

function renderDiagnostics(result) {
    clearChildren(el.log);
    el.summary.classList.remove("visible");

    if (result.fatalError) {
        el.log.appendChild(createLine("fatal-error", result.fatalError));
        return;
    }
    for (let i = 0; i < result.lines.length; i++) {
        el.log.appendChild(createLine("diagnostic-line", result.lines[i]));
    }
}

function renderUnexpected(message) {
    clearChildren(el.log);
    el.summary.classList.remove("visible");
    el.log.appendChild(createLine("fatal-error", "Unerwarteter Fehler: " + message));
}

// ---------------------------------------------------------------------------
// Options and persistence
// ---------------------------------------------------------------------------

function readOptions() {
    return {
        layout: el.layoutOption.value === LAYOUT.ROWS ? LAYOUT.ROWS : LAYOUT.COLUMNS,
        swap: !!el.swapClips.checked,
        dryRun: !!el.dryRun.checked
    };
}

function saveSettings() {
    try {
        const options = readOptions();
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(options));
    } catch {
        /* Settings are a convenience — never break the panel over them. */
    }
}

function restoreSettings() {
    let stored = null;
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        stored = raw ? JSON.parse(raw) : null;
    } catch {
        stored = null;
    }
    if (!stored || typeof stored !== "object") return;

    if (stored.layout === LAYOUT.ROWS || stored.layout === LAYOUT.COLUMNS) {
        el.layoutOption.value = stored.layout;
    }
    if (typeof stored.swap === "boolean") {
        el.swapClips.checked = stored.swap;
    }
    if (typeof stored.dryRun === "boolean") {
        el.dryRun.checked = stored.dryRun;
    }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function run(label, work) {
    setBusy(true);
    setStatus(label);
    try {
        const report = await work();
        keepForExport(report);
        renderReport(report);
        setStatus(report.fatalError ? "Abgebrochen." : "Fertig.");
    } catch (error) {
        const message =
            error && error.message ? error.message : String(error || "Unbekannter Fehler");
        setStatus("Fehler.");
        // Drop the previous result: exporting it next to an "unexpected error"
        // log would be actively misleading.
        keepForExport(null);
        renderUnexpected(message);
        console.error(error);
    } finally {
        setBusy(false);
    }
}

async function onCreate() {
    saveSettings();
    const options = readOptions();
    await run(options.dryRun ? "Dry-Run läuft…" : "Splitscreen wird erstellt…", function () {
        return core.createSplitScreen(options);
    });
}

async function onRemove() {
    saveSettings();
    const options = readOptions();
    await run(options.dryRun ? "Dry-Run läuft…" : "Splitscreen wird entfernt…", function () {
        return core.removeSplitScreen({ dryRun: options.dryRun });
    });
}

async function onDiagnose() {
    setBusy(true);
    setStatus("Diagnose läuft…");
    try {
        const result = await diagnostics.runDiagnostics();
        keepForExport(result);
        renderDiagnostics(result);
        setStatus("Diagnose abgeschlossen.");
    } catch (error) {
        const message =
            error && error.message ? error.message : String(error || "Unbekannter Fehler");
        setStatus("Fehler.");
        // Drop the previous result: exporting it next to an "unexpected error"
        // log would be actively misleading.
        keepForExport(null);
        renderUnexpected(message);
        console.error(error);
    } finally {
        setBusy(false);
    }
}

/** Copies the kept log to the system clipboard. */
async function onCopy() {
    const text = buildLogText();
    if (!text) return;
    try {
        await navigator.clipboard.setContent({ "text/plain": text });
        setStatus("Log in die Zwischenablage kopiert.");
    } catch (error) {
        setStatus("Kopieren fehlgeschlagen.");
        console.error(error);
    }
}

/**
 * Writes the kept log to a file the user picks.
 *
 * The manifest asks for `localFileSystem: "request"`, so no path is reachable
 * without the user choosing it explicitly in the file dialog.
 */
async function onSave() {
    const text = buildLogText();
    if (!text) return;
    try {
        const storage = require("uxp").storage;
        const file = await storage.localFileSystem.getFileForSaving(suggestedFileName(), {
            types: ["json", "txt"]
        });
        if (!file) {
            setStatus("Speichern abgebrochen.");
            return;
        }
        await file.write(text);
        setStatus("Log gespeichert: " + (file.name || ""));
    } catch (error) {
        setStatus("Speichern fehlgeschlagen.");
        console.error(error);
    }
}

function onClear() {
    keepForExport(null);
    showEmptyState();
    setStatus("");
}

function init() {
    cacheElements();
    restoreSettings();

    el.createButton.addEventListener("click", onCreate);
    el.removeButton.addEventListener("click", onRemove);
    el.diagnoseButton.addEventListener("click", onDiagnose);
    el.clearButton.addEventListener("click", onClear);
    el.copyButton.addEventListener("click", onCopy);
    el.saveButton.addEventListener("click", onSave);

    el.layoutOption.addEventListener("change", saveSettings);
    el.swapClips.addEventListener("change", saveSettings);
    el.dryRun.addEventListener("change", saveSettings);

    setExportEnabled(false);
    showEmptyState();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
