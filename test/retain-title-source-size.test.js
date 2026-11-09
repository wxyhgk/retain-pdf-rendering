"use strict";

// rpr_fit: a heading's source_font_size_pt (retain-pdf measures it from the source
// PDF's text layer, else from its source text filling the box) caps the heading's
// size: it keeps the source size and only shrinks to fit. Without it the heading
// grows to fill its box as before -- a box two source lines tall, so a heading
// translated into one line came out at nearly twice its size.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fitInput } = require("../src/retain/measured.js");
const { MathStore } = require("../src/output/math-store.js");
const { blockNumber } = require("../src/retain/job-model.js");

const BLOCK = "p015-b0007"; // a two-line paragraph box (26 pt tall), turned into a heading

function headingNode(sourceFontSize, translated = "第一节 引言") {
  const input = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/retain-yield/stacked-exercises.json"), "utf8"));
  const page = input.document.pages.find(candidate => candidate.blocks.some(block => block.block_id === BLOCK));
  page.blocks.find(block => block.block_id === BLOCK).sub_type = "heading";
  const item = input.translations.find(entry => entry.page_idx === page.page_index && entry.block_idx === blockNumber(BLOCK));
  item.translated_text = translated;
  if (sourceFontSize !== undefined) item.source_font_size_pt = sourceFontSize;
  const maths = new MathStore(fs.mkdtempSync(path.join(os.tmpdir(), "rpr-title-")), { files: false });
  return fitInput(input, { maths }).fitted.pages.flatMap(fitted => fitted.nodes).find(node => node.id === BLOCK);
}

test("retain: without source_font_size_pt a short heading still grows to fill its box", () => {
  const node = headingNode(undefined);
  assert.ok(node.fontSize > 20, `font ${node.fontSize}`);
});

test("retain: a heading keeps its source_font_size_pt instead of filling the box", () => {
  const node = headingNode(11);
  assert.equal(node.fontSize, 11);
  assert.equal(node.textRects.length, 1, "one line, no growth into the second source line");
});

test("retain: a heading whose source size does not fit still shrinks to fit", () => {
  const node = headingNode(40, "第一节 引言：这一节的标题很长，排在原来的框里放不下四十磅的字");
  assert.ok(node.fontSize < 40, `font ${node.fontSize}`);
  const box = node.bbox;
  const bottom = Math.max(...node.textRects.map(rect => rect.bottom));
  assert.ok(bottom <= box[3] + 1, `text bottom ${bottom}, box bottom ${box[3]}`);
});

test("retain: a missing, zero or invalid source_font_size_pt keeps the fill rule", () => {
  const fill = headingNode(undefined).fontSize;
  for (const value of [0, -3, "x", null]) assert.equal(headingNode(value).fontSize, fill, String(value));
});
