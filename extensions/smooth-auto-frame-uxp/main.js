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
const { runSmoothAutoFrame } = require("./src/core.js");

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
    el.fixScale = document.getElementById("fixScale");
    el.fixRotation = document.getElementById("fixRotation");
    el.dryRun = document.getElementById("dryRun");
    el.keyframeMode = document.getElementById("keyframeMode");
    el.runButton = document.getElementById("runButton");
    el.clearButton = document.getElementById("clearButton");
    el.statusBar = document.getElementById("statusBar");
    el.summary = document.getElementById("summary");
    el.summaryOk = document.getElementById("summaryOk");
    el.summarySkipped = document.getElementById("summarySkipped");
    el.summaryError = document.getElementById("summaryError");
    el.log = document.getElementById("log");
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
    el.summaryOk.textContent = "Verarbeitet: " + report.processed;
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
    if (!picker) return "start";

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

    return "start";
}

function readOptions() {
    return {
        timing: readTimingOption(),
        fixScale: !!el.fixScale.checked,
        fixRotation: !!el.fixRotation.checked,
        dryRun: !!el.dryRun.checked,
        keyframeMode: !!el.keyframeMode.checked
    };
}

const TIMING_LABELS = {
    start: "Anfang des Clips",
    middle: "Mitte des Clips",
    end: "Ende des Clips",
    playhead: "Aktuelle Abspielposition",
    average: "Mittelwert aller Keyframes"
};

async function onRun() {
    el.runButton.disabled = true;
    const options = readOptions();
    setStatus(options.dryRun ? "Dry-Run läuft…" : "Wird ausgeführt…");

    try {
        const report = await runSmoothAutoFrame(options);
        renderReport(report);
        if (report.fatalError) {
            setStatus("Abgebrochen.");
        } else {
            const label = TIMING_LABELS[report.timing] || report.timing;
            setStatus(
                (options.dryRun ? "Dry-Run abgeschlossen" : "Fertig") +
                    " — Referenz: " +
                    label
            );
        }
    } catch (error) {
        const message =
            error && error.message ? error.message : String(error || "Unbekannter Fehler");
        setStatus("Fehler.");
        renderFatalError("Unerwarteter Fehler: " + message);
        console.error(error);
    } finally {
        el.runButton.disabled = false;
    }
}

function onClear() {
    showEmptyState();
    setStatus("");
}

function init() {
    cacheElements();
    el.runButton.addEventListener("click", onRun);
    el.clearButton.addEventListener("click", onClear);
    showEmptyState();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
