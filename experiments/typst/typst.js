"use strict";

const { spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const TYPST = process.env.TYPST_BIN || path.join(os.homedir(), ".local/bin/typst");
// The bundled fonts of retain-pdf; --ignore-system-fonts makes every machine
// measure with exactly these files.
const FONT_DIR = process.env.RPR_FONT_DIR || path.resolve(__dirname, "../../../retain-pdf/resources/fonts");

const invocations = [];

function run(args, cwd) {
  const started = performance.now();
  const result = spawnSync(TYPST, [...args, "--font-path", FONT_DIR, "--ignore-system-fonts"], {
    cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024
  });
  const ms = performance.now() - started;
  invocations.push({ command: args[0], ms: Math.round(ms) });
  if (result.status !== 0) {
    throw new Error(`typst ${args[0]} failed (${result.status}):\n${result.stderr}`);
  }
  return { stdout: result.stdout, stderr: result.stderr, ms };
}

// Evaluates every <rpr-measure> metadata value in `file` (relative to cwd).
function queryMeasurements(file, cwd) {
  const { stdout, ms } = run(["eval", "query(<rpr-measure>).map(it => it.value)", "--in", file, "--format", "json"], cwd);
  return { values: JSON.parse(stdout), ms };
}

function compile(file, output, cwd) {
  return run(["compile", file, output], cwd);
}

function version() {
  const result = spawnSync(TYPST, ["--version"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

module.exports = { queryMeasurements, compile, version, invocations, TYPST, FONT_DIR };
