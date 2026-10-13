/**
 * Reframe Lock — src/logger.js
 *
 * A structured logger that doubles as the debug payload.
 *
 * The whole point of this file is remote diagnosis: the plugin runs on a
 * client machine with a Premiere version, UI language and footage that are not
 * available here. A run therefore has to produce one self-contained artifact
 * that explains what happened and why, without anyone having to ask follow-up
 * questions. Entries are kept as structured data (not formatted strings) so
 * the same log can be rendered for the panel and exported as JSON.
 *
 * Pure: no Premiere, no DOM.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keeps a run's log from growing without bound on a long timeline. */
const MAX_ENTRIES = 4000;

class Logger {
    /**
     * @param {string} [level] lowest level that is retained ("debug" | "info")
     */
    constructor(level) {
        this.threshold = LEVELS[level] || LEVELS.info;
        this.levelName = LEVELS[level] ? level : "info";
        this.entries = [];
        this.counts = { debug: 0, info: 0, warn: 0, error: 0 };
        this.truncated = false;
        this.startedAt = Date.now();
    }

    _push(level, scope, message, data) {
        this.counts[level]++;
        if (LEVELS[level] < this.threshold) return;
        if (this.entries.length >= MAX_ENTRIES) {
            this.truncated = true;
            return;
        }
        const entry = {
            // Milliseconds since the run started: more useful than wall clock
            // for spotting where time went.
            t: Date.now() - this.startedAt,
            level: level,
            scope: scope,
            message: message
        };
        if (data !== undefined) entry.data = data;
        this.entries.push(entry);
    }

    debug(scope, message, data) {
        this._push("debug", scope, message, data);
    }
    info(scope, message, data) {
        this._push("info", scope, message, data);
    }
    warn(scope, message, data) {
        this._push("warn", scope, message, data);
    }
    error(scope, message, data) {
        this._push("error", scope, message, data);
    }

    /** True when the log contains anything the user should look at. */
    hasProblems() {
        return this.counts.warn > 0 || this.counts.error > 0;
    }

    toJSON() {
        return {
            level: this.levelName,
            counts: this.counts,
            truncated: this.truncated,
            entries: this.entries
        };
    }
}

/**
 * Turns any thrown value into a message. `String(error)` on a host object
 * yields "[object Object]", which tells nobody anything.
 */
function describeError(error) {
    if (!error) return "Unbekannter Fehler.";
    if (error instanceof Error) return error.message || String(error);
    if (typeof error === "object") {
        try {
            const message = error.message || error.description || error.name;
            if (message) return String(message);
            return JSON.stringify(error);
        } catch {
            return "Nicht darstellbarer Fehler.";
        }
    }
    return String(error);
}

module.exports = {
    Logger: Logger,
    LEVELS: LEVELS,
    describeError: describeError
};
