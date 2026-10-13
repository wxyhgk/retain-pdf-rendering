"use strict";

// TeX normalization before MathJax (src/text/mathjax-node.js) and the formula check service
// (bin/rpr-math-check.js) that lets retain-pdf validate translated formulas with the renderer itself.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createMathRenderer, normalizeTexForMathJax } = require("../src/text/mathjax-node.js");

const renderer = createMathRenderer();

test("math: chemistry in \\mathrm with several subscripts renders (MathJax read it as double subscripts)", () => {
  for (const tex of ["\\mathrm{H_aC_aH_b}", "\\angle \\mathrm{H_aC_aC_b}", "\\mathrm{Cl^- + H_aH_bC_a(Cl)H_c}"]) {
    assert.equal(renderer.texToSVG(tex, false).ok, true, tex);
  }
});

test("math: bracing single-character scripts is the same formula", () => {
  assert.equal(normalizeTexForMathJax("x_i^2 + \\mathrm{H_ab}"), "x_{i}^{2} + \\mathrm{H_{a}b}");
  assert.equal(normalizeTexForMathJax("a\\_b \\^{} x_{ij} e^{-x} y^\\prime"), "a\\_b \\^{} x_{ij} e^{-x} y^\\prime");
  for (const [bare, braced] of [["x_i", "x_{i}"], ["a^2", "a^{2}"], ["\\sum_{i=1}^n x_i", "\\sum_{i=1}^{n} x_{i}"]]) {
    const a = renderer.texToSVG(bare, false);
    const b = createMathRenderer().texToSVG(braced, false);
    assert.deepEqual([a.widthEm, a.heightEm, a.depthEm], [b.widthEm, b.heightEm, b.depthEm], bare);
  }
});

test("math: an unrenderable formula reports MathJax's own message", () => {
  const result = renderer.texToSVG("\\rho_{s}(\\mathbf{r}}) = 1", false);
  assert.equal(result.ok, false);
  assert.match(result.error, /brace/i);
});

test("math check service: one JSON line per formula, ready line first", () => {
  const input = [
    { id: 1, tex: "\\frac{a}{b}" },
    { id: "x", tex: "\\rho_{s}(\\mathbf{r}})", display: true },
    { id: 3, tex: "\\mathrm{H_aC_aH_b}" }
  ].map(line => JSON.stringify(line)).join("\n") + "\nnot json\n";
  const run = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "rpr-math-check.js")], { input, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(lines[0].ready, true);
  assert.deepEqual(lines[1], { id: 1, ok: true });
  assert.equal(lines[2].id, "x");
  assert.equal(lines[2].ok, false);
  assert.match(lines[2].error, /brace/i);
  assert.deepEqual(lines[3], { id: 3, ok: true });
  assert.equal(lines[4].ok, false);
  assert.match(lines[4].error, /^bad request/);
});
