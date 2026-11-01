"use strict";

// rpr_fit: a translation item's first_line_indent_pt (retain-pdf measures it from the
// source PDF's text layer) indents the first line of that paragraph. Without it the
// paragraph starts flush left as before: OCR line boxes cannot tell an indent.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fitInput } = require("../src/retain/measured.js");
const { MathStore } = require("../src/output/math-store.js");
const { blockNumber } = require("../src/retain/job-model.js");

// indents: { "<document block id>": first_line_indent_pt } (items match blocks by block number).
function firstRects(indents) {
  const input = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/retain-yield/stacked-exercises.json"), "utf8"));
  const byBlock = new Map(Object.entries(indents).map(([id, value]) => [blockNumber(id), value]));
  for (const item of input.translations) {
    if (byBlock.has(item.block_idx)) item.first_line_indent_pt = byBlock.get(item.block_idx);
  }
  const maths = new MathStore(fs.mkdtempSync(path.join(os.tmpdir(), "rpr-indent-")), { files: false });
  const nodes = fitInput(input, { maths }).fitted.pages.flatMap(page => page.nodes);
  return { rects: id => nodes.find(node => node.id === id).textRects };
}

test("retain: first_line_indent_pt indents the first line of that paragraph only", () => {
  const plain = firstRects({});
  const indented = firstRects({ "p015-b0007": 18 });
  const [first, second] = indented.rects("p015-b0007");
  assert.ok(Math.abs(first.left - (second.left + 18)) < 0.01, `first ${first.left}, second ${second.left}`);
  const [plainFirst, plainSecond] = plain.rects("p015-b0007");
  assert.equal(plainFirst.left, plainSecond.left, "no indent given: flush left");
  // The other paragraphs keep their own first lines.
  for (const id of ["p015-b0020", "p015-b0025"]) {
    assert.equal(indented.rects(id)[0].left, indented.rects(id)[1].left, id);
  }
});

test("retain: a missing, zero or invalid first_line_indent_pt means no indent", () => {
  for (const value of [0, -4, "x", null]) {
    const [first, second] = firstRects({ "p015-b0007": value }).rects("p015-b0007");
    assert.equal(first.left, second.left, String(value));
  }
});
