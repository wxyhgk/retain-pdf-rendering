#!/usr/bin/env node
"use strict";

// Behavioural fingerprint of src/fit-model for refactors that must not change
// output. `generate DIR` writes:
//   fit/<fixture>.<mode>.<profile>.json  JSON.stringify(fitDocument(...)) for
//       every golden model, both modes, the CSS line model (browser parity
//       fitter) and the measurer line model (Typst output fitter), plus
//       option variants (strict source fit + body caps, translated clamp,
//       user body font);
//   typst/<fixture>.<mode>[.math].typ     experiments/typst/run.js --fitter model;
//   typst/x100.typ                        the same for a large document, when
//       --large FILE is given;
//   overlay/<job>.typ + <job>.json        experiments/overlay/run.js overlay
//       source and its invariants / font sizes, for every --job DIR.
// `compare BASELINE DIR` lists every differing or missing file and exits 1
// on any difference. `check BASELINE [options]` generates into a temporary
// directory and compares.
//
//   node scripts/fit-model-equivalence.js generate out/ --large x100.json --job JOB1 --job JOB2
//   node scripts/fit-model-equivalence.js check out/ --large x100.json --job JOB1 --job JOB2

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const options = { command: argv[0], dirs: [], large: "", jobs: [] };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--large") options.large = argv[++i];
    else if (argv[i] === "--job") options.jobs.push(argv[++i]);
    else options.dirs.push(argv[i]);
  }
  return options;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`node ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function generateFits(dir) {
  const P = require(path.join(ROOT, "test/helpers/fit-model-parity"));
  const { createOutputFitter } = require(path.join(ROOT, "test/helpers/output-path"));
  const profiles = {
    css: () => P.createFitter("browser"),
    "css-typst-spacing": () => P.createFitter("typst"),
    measurer: () => createOutputFitter()
  };
  const variants = {
    default: {},
    strict: { strictSourceFit: true },
    caps: { strictSourceFit: true, bodyNodeFontCaps: true, bodyMaxFont: 9 },
    clamp: { translatedClamp: true },
    user: { userBodyFontPt: 8 }
  };
  let count = 0;
  for (const fixture of P.fixtures()) {
    for (const mode of ["source", "translation"]) {
      for (const [profile, make] of Object.entries(profiles)) {
        for (const [variant, extra] of Object.entries(variants)) {
          if (profile !== "measurer" && variant !== "default" && variant !== "strict") continue;
          const model = JSON.parse(JSON.stringify(fixture.expected));
          const fitted = make().fitDocument(model, { mode, ...extra });
          write(path.join(dir, "fit", `${fixture.name}.${mode}.${profile}.${variant}.json`), JSON.stringify(fitted));
          count += 1;
        }
      }
    }
  }
  return count;
}

function generateTypst(dir, large) {
  const P = require(path.join(ROOT, "test/helpers/fit-model-parity"));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "fit-model-eq-"));
  let count = 0;
  for (const fixture of P.fixtures()) {
    for (const mode of ["source", "translation"]) {
      for (const math of [false, true]) {
        const out = path.join(scratch, `${fixture.name}-${mode}-${math}`);
        runNode(["experiments/typst/run.js", fixture.name, "--mode", mode, ...(math ? ["--demo-inline-math"] : []),
          "--measurer", "js", "--fitter", "model", "--no-png", "--no-drift-check", "--out", out]);
        fs.copyFileSync(path.join(out, "doc.typ"), path.join(dir, "typst", `${fixture.name}.${mode}${math ? ".math" : ""}.typ`));
        count += 1;
      }
    }
  }
  if (large) {
    const out = path.join(scratch, "large");
    runNode(["experiments/typst/run.js", path.resolve(large), "--mode", "translation", "--demo-inline-math",
      "--measurer", "js", "--fitter", "model", "--no-png", "--no-drift-check", "--out", out]);
    fs.copyFileSync(path.join(out, "doc.typ"), path.join(dir, "typst", "large.typ"));
    const report = JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8"));
    write(path.join(dir, "timing", "large.json"), JSON.stringify(report.timings || {}, null, 2));
    count += 1;
  }
  return count;
}

function generateOverlays(dir, jobs) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "fit-model-eq-overlay-"));
  for (const job of jobs) {
    const name = path.basename(path.resolve(job));
    const out = path.join(scratch, name);
    runNode(["experiments/overlay/run.js", path.resolve(job), "--out", out, "--no-drift-check"]);
    fs.copyFileSync(path.join(out, "overlay.typ"), path.join(dir, "overlay", `${name}.typ`));
    const report = JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8"));
    write(path.join(dir, "overlay", `${name}.json`), JSON.stringify({
      invariants: report.invariants, spillBelowBox: report.spillBelowBox, bodyFont: report.bodyFont,
      fontSizes: report.fontSizes, examples: report.examples
    }, null, 2));
  }
  return jobs.length;
}

function generate(dir, options) {
  fs.mkdirSync(path.join(dir, "typst"), { recursive: true });
  fs.mkdirSync(path.join(dir, "overlay"), { recursive: true });
  const fits = generateFits(dir);
  const typst = generateTypst(dir, options.large);
  const overlays = generateOverlays(dir, options.jobs);
  console.log(`generated ${fits} fit dumps, ${typst} Typst sources, ${overlays} overlays in ${dir}`);
}

function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out.filter(file => !file.startsWith("timing/")).sort();
}

function compare(baseline, candidate) {
  const left = listFiles(baseline);
  const right = new Set(listFiles(candidate));
  const problems = [];
  for (const file of left) {
    if (!right.has(file)) { problems.push(`missing ${file}`); continue; }
    if (!fs.readFileSync(path.join(baseline, file)).equals(fs.readFileSync(path.join(candidate, file)))) problems.push(`differs ${file}`);
    right.delete(file);
  }
  for (const file of right) problems.push(`extra ${file}`);
  for (const problem of problems) console.log(problem);
  console.log(`${left.length} baseline files compared, ${problems.length} difference(s)`);
  return problems.length === 0;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "generate" && options.dirs.length === 1) generate(path.resolve(options.dirs[0]), options);
  else if (options.command === "compare" && options.dirs.length === 2) process.exitCode = compare(path.resolve(options.dirs[0]), path.resolve(options.dirs[1])) ? 0 : 1;
  else if (options.command === "check" && options.dirs.length === 1) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fit-model-eq-check-"));
    generate(dir, options);
    process.exitCode = compare(path.resolve(options.dirs[0]), dir) ? 0 : 1;
  }
  else {
    console.error("usage: fit-model-equivalence.js generate DIR | compare BASELINE DIR | check BASELINE  [--large FILE] [--job DIR]...");
    process.exitCode = 2;
  }
}

main();
