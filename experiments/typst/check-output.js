#!/usr/bin/env node
"use strict";

// (d) of the output invariants: render every golden fixture (both modes, with
// and without the inline-math demo) and the 300-page document through
// run.js --fitter model and require the drift check to report 0 mismatches.
// Skips (exit 0) when Typst or PyMuPDF is unavailable.
//
// node experiments/typst/check-output.js [--big path/to/x100.json]

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const typst = require("./typst");

const PYTHON = process.env.RPR_PYTHON || path.resolve(__dirname, "../../../retain-pdf/backend/.venv/bin/python");
const probe = spawnSync(typst.TYPST, ["--version"], { encoding: "utf8" });
const py = spawnSync(PYTHON, ["-c", "import fitz"], { encoding: "utf8" });
if (probe.status !== 0 || py.status !== 0) {
  console.log(`skipped: needs typst (${typst.TYPST}) and PyMuPDF (${PYTHON})`);
  process.exit(0);
}

const bigIndex = process.argv.indexOf("--big");
const fixtures = fs.readdirSync(path.resolve(__dirname, "../../test/fixtures/model-golden")).filter(n => n.endsWith(".json")).map(n => n.replace(/\.json$/, ""));
const runs = [];
for (const fixture of fixtures) for (const mode of ["source", "translation"]) for (const demo of [false, true]) runs.push({ fixture, mode, demo });
if (bigIndex > 0) runs.push({ fixture: path.resolve(process.argv[bigIndex + 1]), mode: "translation", demo: true, big: true });

const out = fs.mkdtempSync(path.join(os.tmpdir(), "rpr-output-"));
let failed = 0;
for (const run of runs) {
  const args = [path.join(__dirname, "run.js"), run.fixture, "--mode", run.mode, "--fitter", "model", "--no-png", "--out", path.join(out, `${path.basename(run.fixture)}-${run.mode}${run.demo ? "-math" : ""}`)];
  if (run.demo) args.push("--demo-inline-math");
  const result = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  let report = null;
  try { report = JSON.parse(result.stdout); } catch (_error) { report = null; }
  const drift = report?.drift;
  const ok = result.status === 0 && drift && !drift.error && drift.mismatch === 0;
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${path.basename(run.fixture)}/${run.mode}${run.demo ? "+math" : ""}: ${drift ? `${drift.nodes} nodes, ${drift.mismatch} drifting` : (result.stderr || "no report").slice(0, 300)}${run.big ? ` (fit ${report.timings.fitModelMs} ms, compile ${report.timings.typstCompileMs} ms)` : ""}`);
}
fs.rmSync(out, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
