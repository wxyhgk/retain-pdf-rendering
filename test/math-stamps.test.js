"use strict";

// Formula glyphs as reusable PDF stamps (experiments/typst/math-stamps.js):
// flattening MathJax SVGs into placements, the fallback path, and outline
// deduplication. No Typst needed.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { flattenFormulaSVG, parseTransform, pathBBox, StampStore } = require("../experiments/typst/math-stamps");
const { texToSVG } = require("../src/text/mathjax-node");

const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);

test("math stamps: transforms compose translate/scale and reject anything else", () => {
  assert.deepEqual(parseTransform("translate(10,5) scale(2)"), [2, 0, 0, 2, 10, 5]);
  assert.deepEqual(parseTransform("scale(1,-1)"), [1, 0, 0, -1, 0, 0]);
  assert.deepEqual(parseTransform(""), [1, 0, 0, 1, 0, 0]);
  assert.equal(parseTransform("rotate(30)"), null);
  assert.equal(parseTransform("translate(1,2) skewX(3)"), null);
});

test("math stamps: path bbox follows Q/T control points, H/V and Z", () => {
  // T reflects the previous Q control point about the current point:
  // (0,10) about (10,10) -> (20,10); then H30 and V-5 set the extremes.
  const box = pathBBox("M0 0Q0 10 10 10T20 0H30V-5Z");
  assert.deepEqual(box, { x0: 0, y0: -5, x1: 30, y1: 10 });
  // A T after a curve whose control point lies below: (5,-20) about (10,0) -> (15,20).
  assert.deepEqual(pathBBox("M0 0Q5 -20 10 0T20 0"), { x0: 0, y0: -20, x1: 20, y1: 20 });
  assert.equal(pathBBox("M0 0a5 5 0 0 1 10 0"), null, "arcs/relative commands are not flattened");
});

test("math stamps: nested groups, the root flip and rules flatten to viewBox coordinates", () => {
  const svg = `<svg viewBox="0 -500 1000 700"><g transform="scale(1,-1)">
    <g transform="translate(100,0)"><g transform="scale(0.5)"><path data-c="41" d="M0 0L100 0L100 200Z"></path></g></g>
    <g transform="translate(300,50)"><rect x="0" y="0" width="200" height="40"></rect></g>
    <path data-c="A0" d=""></path></g></svg>`;
  const flat = flattenFormulaSVG(svg);
  assert.equal(flat.shapes.length, 1, "empty <path d=\"\"> (spaces) is skipped");
  assert.deepEqual(flat.shapes[0].m, [0.5, 0, 0, -0.5, 100, 0]);
  assert.deepEqual(flat.rects, [{ x: 300, y: -90, w: 200, h: 40 }]);
});

test("math stamps: unsupported SVG falls back (null) and is counted", () => {
  const store = new StampStore(fs.mkdtempSync(path.join(os.tmpdir(), "rpr-stamps-")));
  const withText = `<svg viewBox="0 0 10 10"><g transform="scale(1,-1)"><text>Å</text></g></svg>`;
  assert.equal(flattenFormulaSVG(withText), null);
  assert.equal(store.formulaItems(withText, "\\text{Å}"), null);
  const mirrored = `<svg viewBox="0 0 10 10"><g transform="scale(-1,-1)"><path data-c="41" d="M0 0L1 1Z"></path></g></svg>`;
  assert.equal(store.formulaItems(mirrored, "mirrored"), null);
  assert.deepEqual(store.stats.fallbacks.map(entry => entry.reason), ["unsupported svg", "transformed glyph"]);
});

test("math stamps: real MathJax formulas stamp every glyph and share outlines", () => {
  const store = new StampStore(fs.mkdtempSync(path.join(os.tmpdir(), "rpr-stamps-")));
  const a = texToSVG("\\psi + \\psi^{2} = \\frac{1}{2}");
  const b = texToSVG("\\left[\\hat{H}, \\psi\\right]");
  assert.ok(a.ok && b.ok);
  const itemsA = store.formulaItems(a.svg, "a");
  const itemsB = store.formulaItems(b.svg, "b");
  assert.ok(itemsA && itemsB, "both flatten without fallback");
  const glyphPaths = svg => [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map(match => match[1]);
  const drawsA = glyphPaths(a.svg).length, drawsB = glyphPaths(b.svg).length;
  assert.equal(itemsA.filter(item => item[0] > 0).length, drawsA, "one stamp draw per glyph path");
  assert.ok(itemsA.some(item => item[0] === 0), "the fraction bar becomes a rule");
  const unique = new Set([...glyphPaths(a.svg), ...glyphPaths(b.svg)]).size;
  assert.equal(store.list.length, unique, "one stamp page per distinct outline across formulas");
  assert.ok(unique < drawsA + drawsB, "psi is shared");
  // Placements stay inside the formula box (fractions of it).
  for (const [, x, y, w, h] of [...itemsA, ...itemsB]) {
    assert.ok(x > -0.05 && y > -0.05 && x + w < 1.05 && y + h < 1.05, `placement ${[x, y, w, h]}`);
  }
});

test("math stamps: stamp pages are never smaller than Typst's 3pt minimum", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "rpr-stamps-"));
  const store = new StampStore(out);
  const dot = texToSVG("0.1");
  store.formulaItems(dot.svg, "0.1");
  const typ = fs.readFileSync(path.join(out, store.writeSources()), "utf8");
  for (const match of typ.matchAll(/width: ([\d.]+)pt, height: ([\d.]+)pt, margin/g)) {
    assert.ok(Number(match[1]) >= 3 && Number(match[2]) >= 3, `page ${match[1]} x ${match[2]}pt`);
  }
  close(Math.min(...[...typ.matchAll(/width: ([\d.]+)pt, height: ([\d.]+)pt, margin/g)].flatMap(m => [Number(m[1]), Number(m[2])])), 4, "smallest side");
});
