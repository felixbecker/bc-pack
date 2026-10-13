/**
 * Reframe Lock — main.js
 *
 * Panel wiring only: register the entrypoint, read the options, render the
 * report, export the log. No algorithm lives here.
 *
 * All DOM output goes through createElement/textContent — never innerHTML — so
 * clip names coming from media filenames can never be interpreted as markup.
 */

const { entrypoints } = require("uxp");
const core = require("./src/core.js");
const reportView = require("./src/report.js");

entrypoints.setup({
    panels: {
        reframeLockPanel: {
            create() {
                /* Panel content already lives in index.html. */
            },
            show() {
                /* Single-panel plugin — nothing to append. */
            }
        }
    }
});

const el = {};
let lastReport = null;

function cacheElements() {
    const ids = [
        "scope",
        "reference",
        "dryRun",
        "removeEffect",
        "freezeScale",
        "freezeRotation",
        "debugLog",
        "force",
        "allowWeakCalibration",
        "runButton",
        "clearButton",
        "copyButton",
        "saveButton",
        "statusBar",
        "summary",
        "notes",
        "log",
        "buildInfo"
    ];
    for (let i = 0; i < ids.length; i++) {
        el[ids[i]] = document.getElementById(ids[i]);
    }
}

/**
 * Reads a Spectrum picker's value.
 *
 * `sp-picker` normally exposes `.value`, but across UXP versions it can come
 * back empty while the selected `sp-menu-item` carries the value. Silently
 * falling back to a default would ignore the user's choice, so both paths are
 * checked and the applied value is echoed in the status line afterwards.
 */
function readPicker(picker, fallback) {
    if (!picker) return fallback;
    if (typeof picker.value === "string" && picker.value) return picker.value;

    const selected =
        picker.querySelector("sp-menu-item[selected]") ||
        picker.querySelector("sp-menu-item[aria-selected='true']");
    if (selected) {
        const attr = selected.getAttribute("value");
        if (attr) return attr;
        if (typeof selected.value === "string" && selected.value) return selected.value;
    }
    return fallback;
}

function readOptions() {
    return {
        scope: readPicker(el.scope, core.SCOPE.SELECTION),
        reference: readPicker(el.reference, core.REFERENCE.MEDIAN),
        dryRun: !!el.dryRun.checked,
        removeEffect: !!el.removeEffect.checked,
        freezeScale: !!el.freezeScale.checked,
        freezeRotation: !!el.freezeRotation.checked,
        force: !!el.force.checked,
        allowWeakCalibration: !!el.allowWeakCalibration.checked,
        logLevel: el.debugLog.checked ? "debug" : "info"
    };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
}

function line(className, text) {
    const div = document.createElement("div");
    div.className = className;
    div.textContent = text;
    return div;
}

function setStatus(text) {
    el.statusBar.textContent = text || "";
}

function setExportEnabled(enabled) {
    el.copyButton.disabled = !enabled;
    el.saveButton.disabled = !enabled;
}

function showEmptyState() {
    clearChildren(el.log);
    clearChildren(el.notes);
    el.log.appendChild(
        line(
            "empty-state",
            'Noch keine Messung. Clips wählen, Optionen setzen, "Ausführen" klicken. ' +
                "Dry-Run ist voreingestellt und schreibt nichts."
        )
    );
    el.summary.classList.remove("visible");
}

function render(report) {
    const model = reportView.viewModel(report);

    clearChildren(el.log);
    clearChildren(el.notes);
    clearChildren(el.summary);

    if (model.fatal) {
        el.summary.classList.remove("visible");
        el.log.appendChild(line("fatal-error", model.fatal));
        return;
    }

    el.summary.classList.add("visible");
    for (let i = 0; i < model.pills.length; i++) {
        const span = document.createElement("span");
        span.className = "pill " + model.pills[i].kind;
        span.textContent = model.pills[i].text;
        el.summary.appendChild(span);
    }

    for (let i = 0; i < model.notes.length; i++) {
        el.notes.appendChild(line("note", model.notes[i]));
    }

    if (!model.clips.length) {
        el.log.appendChild(line("empty-state", "Keine Clips im Bearbeitungsbereich."));
        return;
    }

    for (let i = 0; i < model.clips.length; i++) {
        const clip = model.clips[i];
        const entry = document.createElement("div");
        entry.className = "log-entry status-" + clip.status;

        const header = document.createElement("div");
        header.className = "clip-name";
        header.textContent = clip.name + " ";
        const tag = document.createElement("span");
        tag.className = "status-tag";
        tag.textContent = "— " + clip.statusLabel;
        header.appendChild(tag);
        entry.appendChild(header);

        for (let l = 0; l < clip.lines.length; l++) {
            entry.appendChild(line(clip.lines[l].kind, clip.lines[l].text));
        }
        el.log.appendChild(entry);
    }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function onRun() {
    el.runButton.disabled = true;
    const options = readOptions();
    setStatus(options.dryRun ? "Messe (Dry-Run)…" : "Messe und schreibe…");

    try {
        const report = await core.runReframeLock(options);
        lastReport = report;
        setExportEnabled(true);
        render(report);
        setStatus(
            report.fatalError
                ? "Abgebrochen."
                : reportView.viewModel(report).headline +
                      " · " +
                      (report.durationMs || 0) +
                      " ms"
        );
    } catch (error) {
        const message = error && error.message ? error.message : String(error);
        lastReport = {
            fatalError: message,
            plugin: { name: "Reframe Lock", version: core.PLUGIN_VERSION },
            startedAt: new Date().toISOString(),
            options: options
        };
        setExportEnabled(true);
        setStatus("Fehler.");
        clearChildren(el.log);
        el.log.appendChild(line("fatal-error", "Unerwarteter Fehler: " + message));
        console.error(error);
    } finally {
        el.runButton.disabled = false;
    }
}

function logText() {
    return lastReport ? reportView.toJsonText(lastReport) : "";
}

function suggestedFileName() {
    const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .slice(0, 19);
    return "reframe-lock_" + stamp + ".json";
}

async function onCopy() {
    const text = logText();
    if (!text) {
        setStatus("Kein Log vorhanden.");
        return;
    }
    try {
        await navigator.clipboard.setContent({ "text/plain": text });
        setStatus("Log kopiert (" + text.length + " Zeichen).");
    } catch (error) {
        setStatus("Kopieren fehlgeschlagen.");
        console.error(error);
    }
}

async function onSave() {
    const text = logText();
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
 * UXP caches required modules, so a Reload in the Developer Tool can leave
 * stale code running — indistinguishable from a working build unless the
 * version is visible somewhere.
 */
function showBuildInfo() {
    if (!el.buildInfo) return;
    el.buildInfo.textContent =
        "Build " + core.PLUGIN_VERSION + " · Report-Schema " + core.REPORT_SCHEMA;
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
