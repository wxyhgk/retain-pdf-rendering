"use strict";

// Structure of src/fit-model/: the parts load as plain browser scripts in the
// documented order, and no part reaches into another part's state.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const PARTS_DIR = path.join(ROOT, "src/fit-model");

// The browser load order documented in src/fit-model/README.md.
const LOAD_ORDER = [
  "constants.js",
  "rects.js",
  "content.js",
  "document.js",
  "typography-retain.js",
  "line-models/base.js",
  "line-models/measurer.js",
  "line-models/css.js",
  "line-models/retain.js",
  "line-models/index.js",
  "geometry.js",
  "collision.js",
  "tuning.js",
  "passes/titles.js",
  "passes/clamps.js",
  "passes/final-audit.js",
  "passes/formulas.js",
  "passes/retain-body.js",
  "passes/justify.js",
  "run.js",
  "serialize.js",
  "index.js"
];

function partFiles() {
  const out = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) out.push(path.relative(PARTS_DIR, full));
    }
  };
  walk(PARTS_DIR);
  return out.sort();
}

function dependencies(file) {
  const source = fs.readFileSync(path.join(PARTS_DIR, file), "utf8");
  const match = source.match(/const DEPENDENCIES = (\[.*\]);/);
  assert.ok(match, `${file} declares its DEPENDENCIES`);
  return JSON.parse(match[1]).map(([, relative]) => path.normalize(path.join(path.dirname(file), relative)) + ".js");
}

test("fit-model parts: the documented load order lists every part after its dependencies", () => {
  assert.deepEqual([...LOAD_ORDER].sort(), partFiles(), "every part is in the load order exactly once");
  for (const file of LOAD_ORDER) {
    for (const dependency of dependencies(file)) {
      assert.ok(LOAD_ORDER.indexOf(dependency) >= 0 && LOAD_ORDER.indexOf(dependency) < LOAD_ORDER.indexOf(file),
        `${file} loads after ${dependency}`);
    }
  }
});

test("fit-model parts: only the declared dependencies, no configuration outside index.js", () => {
  for (const file of partFiles()) {
    const source = fs.readFileSync(path.join(PARTS_DIR, file), "utf8");
    // The UMD header is the only place a part resolves another part.
    assert.equal((source.match(/require\(/g) || []).length - (file === "content.js" ? 1 : 0), 1, `${file}: require only in the header`);
    assert.equal((source.match(/FitModelParts/g) || []).length, 3, `${file}: FitModelParts only in the header`);
    // Parts read the frozen ctx; only the fitter sees the raw configuration.
    if (file !== "index.js") assert.doesNotMatch(source, /\bconfig\./, `${file} must not read config`);
    // Only the wiring creates parts; a part never instantiates a sibling.
    if (file !== "index.js" && file !== "line-models/index.js") {
      assert.doesNotMatch(source, /\b[A-Z][A-Za-z]*\.create[A-Z]\w*\(/, `${file} must not create other parts`);
    }
    assert.doesNotMatch(source, /\b(?:window|document\.(?:createElement|querySelector)|Zotero|LitMTrans)\b/, `${file} is host-agnostic`);
  }
});

test("fit-model parts: loaded as plain scripts they fit exactly like the Node modules", () => {
  const table = require(path.join(ROOT, "data/fonts/source-han-serif-sc-regular.json"));
  const fixture = require("./helpers/fit-model-parity").fixtures().find(item => item.name === "basic-figure-equation-furniture");

  // Browser-style: no require, no module; every file attaches to the global.
  const context = vm.createContext({});
  const scripts = [
    "src/render.js",
    "src/text/uax14-data.js", "src/text/metrics.js", "src/text/linebreak.js", "src/text/measurer.js",
    ...LOAD_ORDER.map(file => `src/fit-model/${file}`),
    "src/fit-model.js"
  ];
  for (const file of scripts) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });
  }
  context.table = table;
  context.model = JSON.parse(JSON.stringify(fixture.expected));
  const browser = vm.runInContext(`(() => {
    const R = globalThis.RetainPdfRendering;
    const measurer = R.Text.createMeasurer({ metrics: table });
    const contentFor = R.FitModel.defaultContentFor({ renderMathBox: R.Text.fallbackMathBox });
    return JSON.stringify(R.FitModel.createModelFitter({ measurer, contentFor }).fitDocument(model, { mode: "translation" }));
  })()`, context);

  const FitModel = require(path.join(ROOT, "src/fit-model.js"));
  const Text = require(path.join(ROOT, "src/text/measurer"));
  const node = JSON.stringify(FitModel.createModelFitter({
    measurer: Text.createMeasurer({ metrics: table }),
    contentFor: FitModel.defaultContentFor({ renderMathBox: Text.fallbackMathBox })
  }).fitDocument(JSON.parse(JSON.stringify(fixture.expected)), { mode: "translation" }));
  assert.equal(browser, node);
});

test("fit-model parts: a part loaded before its dependencies names what is missing", () => {
  const context = vm.createContext({});
  assert.throws(
    () => vm.runInContext(fs.readFileSync(path.join(PARTS_DIR, "geometry.js"), "utf8"), context),
    /load fit-model\/constants\.js before geometry/
  );
});
