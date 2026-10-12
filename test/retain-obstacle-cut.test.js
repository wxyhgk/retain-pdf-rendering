"use strict";

// job-model: the part of an OCR obstacle that a repainted text box covers is that text's own
// source, not the figure — it is cut out of the obstacle, like vectorObstacles does for drawings.
// Before, a footnote OCR left inside its flowchart's box hit the figure at every size and
// collapsed to the 4.8 pt floor.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fitInput } = require("../src/retain/measured.js");
const { MathStore } = require("../src/output/math-store.js");

const overlap = (a, b) => Math.min(a.right, b[2]) - Math.max(a.left, b[0]) > 0.01 && Math.min(a.bottom, b[3]) - Math.max(a.top, b[1]) > 0.01;

test("retain: a footnote inside its figure's OCR box is set at its size, clear of the figure", () => {
  const input = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/retain-obstacle-cut/flowchart-footnote.json"), "utf8"));
  const maths = new MathStore(fs.mkdtempSync(path.join(os.tmpdir(), "rpr-cut-")), { files: false });
  const nodes = fitInput(input, { maths }).fitted.pages.flatMap(page => page.nodes);

  const footnote = nodes.find(node => node.id === "p013-b0004");
  assert.ok(footnote.fontSize > 8, `footnote at ${footnote.fontSize} pt`);

  // The flowchart stays an obstacle everywhere else: the footnote's text touches none of it.
  const figure = nodes.filter(node => String(node.id).startsWith("p013-b0003"));
  assert.ok(figure.length > 1, "the figure box was cut around the footnote");
  for (const piece of figure) {
    assert.ok(piece.bbox[2] - piece.bbox[0] >= 1 && piece.bbox[3] - piece.bbox[1] >= 1, `no slivers: ${piece.bbox}`);
    for (const rect of footnote.textRects) assert.ok(!overlap(rect, piece.bbox), `${JSON.stringify(rect)} in ${piece.id}`);
  }
});
