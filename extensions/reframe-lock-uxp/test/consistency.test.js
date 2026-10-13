/*
 * Consistency checks that no unit test can catch, because they span files:
 * manifest vs. entrypoint id, HTML ids vs. main.js wiring, picker values vs.
 * the whitelists in core.js/geometry.js, the "no await/throw in the
 * transaction" rule Adobe's lint plugin only checks syntactically, and the
 * purity of the modules that must stay testable without Premiere.
 *
 * These are exactly the mistakes that only surface when the plugin is loaded
 * into a running Premiere — the slowest possible feedback loop.
 *
 *   node test/consistency.test.js
 */
const fs = require("fs");
const path = require("path");
const dir = path.resolve(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

const m = JSON.parse(read("manifest.json"));
let bad = 0;
const ok = (cond, msg) => {
    if (!cond) bad++;
    console.log((cond ? "OK    " : "FEHLER ") + msg);
};

for (const f of [m.main, ...m.icons.map((i) => i.path)]) {
    ok(fs.existsSync(path.join(dir, f)), "Manifest-Datei vorhanden: " + f);
}

const main = read("main.js");
const html = read("index.html");
const id = m.entrypoints[0].id;
ok(main.includes(id + ":"), "Entrypoint-ID stimmt zwischen Manifest und main.js: " + id);
ok(html.includes("style.css") && html.includes("main.js"), "index.html referenziert CSS + JS");

const ids = [...html.matchAll(/id="([^"]+)"/g)].map((x) => x[1]);
const missing = ids.filter((i) => !main.includes('"' + i + '"'));
ok(missing.length === 0, "alle " + ids.length + " UI-Elemente in main.js verdrahtet" + (missing.length ? ": " + missing : ""));

// Picker-Werte im HTML müssen den Whitelists im Code entsprechen.
const core = read("src/core.js");
const geometry = read("src/geometry.js");
const scopeValues = [...html.matchAll(/<sp-menu-item value="(selection|track|allTracks)"/g)].map((x) => x[1]);
ok(scopeValues.length === 3, "drei Bereichsoptionen im HTML");
for (const v of scopeValues) ok(core.includes('"' + v + '"'), "Bereichswert in core.js bekannt: " + v);

const refValues = [...html.matchAll(/<sp-menu-item value="(median|start|middle|end|playhead|mean)"/g)].map((x) => x[1]);
ok(refValues.length === 6, "sechs Referenzoptionen im HTML");
for (const v of refValues) ok(geometry.includes('"' + v + '"'), "Referenzwert in geometry.js bekannt: " + v);

// Die Transaktion darf kein await und kein throw enthalten.
const txStart = core.indexOf("executeTransaction((compoundAction)");
const txEnd = core.indexOf('}, "Reframe Lock');
const txBody = core.slice(txStart, txEnd);
ok(txStart !== -1 && txEnd !== -1, "Transaktionsblock gefunden");
ok(!/\bawait\b/.test(txBody), "kein await im Transaktionsblock");
ok(!/\bthrow\b/.test(txBody), "kein throw im Transaktionsblock");

// geometry.js und mediainfo.js dürfen Premiere nicht importieren.
for (const f of ["src/geometry.js", "src/mediainfo.js", "src/logger.js", "src/report.js"]) {
    ok(!read(f).includes('require("premierepro")'), f + " ist frei von Premiere-Abhängigkeiten");
}

console.log(bad === 0 ? "\n  Konsistenzprüfung bestanden\n" : "\n  " + bad + " PROBLEM(E)\n");
process.exit(bad === 0 ? 0 : 1);
