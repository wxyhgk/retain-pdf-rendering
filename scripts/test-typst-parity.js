#!/usr/bin/env node
"use strict";

// Live parity of src/text against Typst's own line breaking
// (experiments/measure/compare-typst.js). Needs the `typst` CLI (TYPST_BIN or
// ~/.local/bin/typst), retain-pdf's bundled fonts (RPR_FONT_DIR) and Python
// with PyMuPDF (RPR_PYTHON) to read the lines back; skips with a message when
// any of them is missing. `npm test` covers the same probes offline through
// test/fixtures/text-parity/typst-lines.json.
//
// npm run test:typst [-- --export]   (--export also refreshes that fixture)

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const typst = process.env.TYPST_BIN || path.join(os.homedir(), ".local/bin/typst");
const fontDir = process.env.RPR_FONT_DIR || path.resolve(root, "../retain-pdf/resources/fonts");
const python = process.env.RPR_PYTHON || path.resolve(root, "../retain-pdf/backend/.venv/bin/python");

function skip(reason) {
  console.log(`test:typst skipped: ${reason}`);
  process.exit(0);
}

if (spawnSync(typst, ["--version"], { encoding: "utf8" }).status !== 0) skip(`typst not found (${typst}); set TYPST_BIN`);
if (!fs.existsSync(path.join(fontDir, "SourceHanSerifSC-Regular.otf"))) skip(`Source Han Serif SC not found in ${fontDir}; set RPR_FONT_DIR`);
if (spawnSync(python, ["-c", "import fitz"], { encoding: "utf8" }).status !== 0) skip(`Python with PyMuPDF not found (${python}); set RPR_PYTHON`);

const out = fs.mkdtempSync(path.join(os.tmpdir(), "rpr-typst-parity-"));
// Default probes (fixtures, inline-math demo, stress text) plus targeted
// probes around formula boxes and closing quotes.
const args = [path.join(root, "experiments/measure/compare-typst.js"), "--out", out, "--extra", path.join(root, "experiments/measure/probes/box-and-quote.json")];
if (process.argv.includes("--export")) {
  // The committed fixture holds the default probes only (the targeted ones
  // are one paragraph per width and would quadruple its size).
  const exportArgs = [path.join(root, "experiments/measure/compare-typst.js"), "--out", fs.mkdtempSync(path.join(os.tmpdir(), "rpr-typst-export-")), "--export", path.join(root, "test/fixtures/text-parity/typst-lines.json")];
  const exported = spawnSync(process.execPath, exportArgs, { cwd: root, encoding: "utf8", stdio: ["ignore", "ignore", "inherit"] });
  if (exported.status !== 0) process.exit(exported.status || 1);
}
const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
process.stdout.write(result.stdout);
if (result.status !== 0) process.exit(result.status || 1);
const summary = JSON.parse(fs.readFileSync(path.join(out, "parity.json"), "utf8")).summary;
if (summary.exactBreaks !== summary.probes) {
  console.error(`test:typst: ${summary.probes - summary.exactBreaks} of ${summary.probes} probes break differently from Typst (see ${out}/parity.json)`);
  process.exit(1);
}
console.log(`test:typst: ${summary.exactBreaks}/${summary.probes} probes match Typst`);
