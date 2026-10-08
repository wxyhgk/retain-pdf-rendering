"use strict";

// Invariants of what the Typst output paints: src/fit-model.js in the exact
// configuration of experiments/typst/run.js --fitter model (lineModel
// "measurer", strict collisions, RetainPdfRendering.Text, MathJax boxes).
//   (a) no two painted lines / formula boxes on a page overlap in ink —
//       within one node or across nodes
//   (b) nothing outside its page
//   (c) stacked nodes of one column keep their order: the upper node's ink
//       ends above the lower node's ink and box
// (d) — every emitted line renders as exactly one line — needs Typst and
// PyMuPDF: npm run test:output.

const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("./helpers/fit-model-parity");
const { createOutputFitter, outputViolations, mathRenderer } = require("./helpers/output-path");
const { injectDemoMath } = require("../experiments/typst/demo-math");

function check(model, mode) {
  const fitted = createOutputFitter().fitDocument(model, { mode });
  const violations = outputViolations(fitted);
  assert.deepEqual(violations.lineOverlaps.slice(0, 5), [], "(a) painted lines overlap");
  assert.deepEqual(violations.outside.slice(0, 5), [], "(b) ink outside the page");
  assert.deepEqual(violations.order.slice(0, 5), [], "(c) stacked nodes out of order");
  return fitted;
}

for (const fixture of P.fixtures()) {
  for (const mode of ["source", "translation"]) {
    for (const demo of [false, true]) {
      test(`output invariants: ${fixture.name}/${mode}${demo ? " + inline math" : ""}`, t => {
        if (demo && !mathRenderer()) t.diagnostic("mathjax-full not installed: formulas use the raw-LaTeX fallback box");
        const model = JSON.parse(JSON.stringify(fixture.expected));
        if (demo) injectDemoMath(model);
        check(model, mode);
      });
    }
  }
}

test("output invariants: 300 pages (two-column-article x 100, inline math)", t => {
  const fixture = P.fixtures().find(item => item.name === "two-column-article");
  const pages = [];
  for (let copy = 0; copy < 100; copy++) {
    for (const page of fixture.expected.pages) {
      const clone = JSON.parse(JSON.stringify(page).replace(/"(id|blockId|block_id)":"([^"]+)"/g, (_m, key, value) => `"${key}":"c${copy}_${value}"`));
      clone.index = pages.length;
      pages.push(clone);
    }
  }
  const model = { ...JSON.parse(JSON.stringify(fixture.expected)), pages };
  injectDemoMath(model);
  const started = performance.now();
  const fitted = check(model, "translation");
  t.diagnostic(`300 pages fitted in ${Math.round(performance.now() - started)} ms`);
  assert.equal(fitted.pages.length, 300);
});
