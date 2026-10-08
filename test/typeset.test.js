"use strict";

// src/typeset: the typesetting engine sets text at the size it is given and
// reports what does not fit; it never decides sizes.

const test = require("node:test");
const assert = require("node:assert/strict");
const Text = require("../src/text/measurer");
const Typeset = require("../src/typeset");
const { defaultFontTable } = require("../src/index.js");

const measurer = Text.createMeasurer({ metrics: defaultFontTable() });
const engine = Typeset.createTypesetter({ measurer, measurers: { bold: Text.createMeasurer({ metrics: defaultFontTable("bold") }) } });
const UNIT = "本研究采用合成数据分析冲击波在水中的传播并比较测量结果与数值模拟之间的差异。";
const runs = text => [{ type: "text", text }];

function page(blocks, obstacles = []) {
  return { pages: [{ index: 0, width: 600, height: 800, blocks, obstacles }] };
}

test("typeset: lines sit at firstBaseline + n x lineHeight x fontSize", () => {
  const result = engine.typeset(page([{ id: "a", box: [50, 100, 350, 400], paragraphs: [{ runs: runs(UNIT.repeat(3)) }], fontSize: 10, lineHeight: 1.5, align: "left" }]));
  const lines = result.pages[0].nodes[0].lines;
  assert.ok(lines.length >= 3);
  lines.forEach((line, n) => assert.ok(Math.abs(line.baseline - (100 + 8.8 + n * 15)) < 1e-9, `line ${n} at ${line.baseline}`));
  const explicit = engine.typeset(page([{ id: "a", box: [50, 100, 350, 400], paragraphs: [{ runs: runs(UNIT) }], fontSize: 10, lineHeight: 1.5, firstBaseline: 12, align: "left" }]));
  assert.equal(explicit.pages[0].nodes[0].lines[0].baseline, 112);
});

test("typeset: the given size is kept even when the text overflows; the report says by how much", () => {
  const result = engine.typeset(page([{ id: "a", box: [50, 100, 350, 130], paragraphs: [{ runs: runs(UNIT.repeat(6)) }], fontSize: 12, lineHeight: 1.4 }]));
  const node = result.pages[0].nodes[0];
  assert.equal(node.fontSize, 12, "never shrunk");
  const block = result.report.blocks.a;
  assert.ok(block.overflowBottom > 20, `overflow ${block.overflowBottom}`);
  const inkBottom = Math.max(...node.textRects.map(rect => rect.bottom));
  assert.ok(Math.abs(block.overflowBottom - (inkBottom - 130)) < 1e-9);
});

test("typeset: an inline formula taller than the font pushes its line and the ones below", () => {
  const tall = { type: "math", tex: "x", widthEm: 2, heightEm: 2.4, depthEm: 0.9 };
  const plain = engine.typeset(page([{ id: "a", box: [50, 100, 120, 400], paragraphs: [{ runs: runs(UNIT) }], fontSize: 10, lineHeight: 1.3, align: "left" }]));
  const withMath = engine.typeset(page([{ id: "a", box: [50, 100, 120, 400], paragraphs: [{ runs: [...runs(UNIT.slice(0, 3)), tall, ...runs(UNIT.slice(3))] }], fontSize: 10, lineHeight: 1.3, align: "left" }]));
  const p = plain.pages[0].nodes[0].lines, m = withMath.pages[0].nodes[0].lines;
  // ascent 0.88 em, the formula reaches 2.4 - 0.9 = 1.5 em above the baseline.
  assert.ok(Math.abs((m[0].baseline - p[0].baseline) - (1.5 - 0.88) * 10) < 1e-9, "first line pushed by the extra ascent");
  for (let i = 1; i < m.length; i++) assert.ok(m[i].baseline - m[i - 1].baseline >= 13 - 1e-9, "pitch never shrinks");
  // ink of consecutive lines never overlaps
  for (let i = 1; i < m.length; i++) assert.ok(m[i].glyphTop >= m[i - 1].glyphBottom - 1e-9, `line ${i} ink overlaps line ${i - 1}`);
});

test("typeset: justified lines stretch at most justifyCap em per justifiable gap", () => {
  const text = "研究 p < 0.001 结果 https://example.org/a/very/long/path/that/cannot/break 之后";
  const block = { id: "a", box: [0, 0, 160, 300], paragraphs: [{ runs: runs(text) }], fontSize: 10, lineHeight: 1.4, align: "justify" };
  const free = engine.typeset(page([block])).pages[0].nodes[0];
  const capped = engine.typeset(page([{ ...block, justifyCap: 0.1 }])).pages[0].nodes[0];
  const prepared = measurer.prepare(runs(text));
  const Linebreak = require("../src/text/linebreak");
  capped.lines.forEach(line => {
    if (!line.justified) return;
    const gaps = Linebreak.justifiableGaps(prepared, line.start, line.end);
    assert.ok(line.width <= line.naturalWidth + gaps * 0.1 * 10 + 1e-9, `line stretched beyond the cap: ${line.width} > ${line.naturalWidth} + ${gaps} gaps`);
  });
  assert.deepEqual(capped.lines.map(l => [l.start, l.end]), free.lines.map(l => [l.start, l.end]), "the cap never changes line breaks");
});

test("typeset: collisions are reported, with whether the boxes already overlapped in the source", () => {
  const result = engine.typeset(page(
    [
      { id: "a", box: [50, 100, 350, 120], paragraphs: [{ runs: runs(UNIT.repeat(3)) }], fontSize: 10, lineHeight: 1.4 },
      { id: "b", box: [50, 125, 350, 160], paragraphs: [{ runs: runs(UNIT) }], fontSize: 10, lineHeight: 1.4 }
    ],
    [{ id: "fig-inside", box: [300, 100, 360, 118] }, { id: "fig-below", box: [50, 200, 350, 260] }]
  ));
  const kinds = result.report.collisions.map(c => `${c.a}-${c.b}:${c.kind}`);
  assert.ok(kinds.includes("a-b:text"), "a's overflowing lines run into b");
  const inside = result.report.collisions.find(c => c.b === "fig-inside");
  assert.ok(inside && inside.insideOwnBox === true, "an obstacle box overlapping a's own box is flagged as a source overlap");
  assert.ok(!result.report.collisions.some(c => c.b === "fig-below" && c.a === "b"), "b stays clear of the figure below it");
});

test("typeset: bold blocks are measured with the bold table; output is deterministic", () => {
  // One line in both weights, so the widths compare like for like.
  const block = { id: "h", box: [50, 100, 550, 200], paragraphs: [{ runs: runs("Electrochemical cage activation") }], fontSize: 16, lineHeight: 1.3, align: "left" };
  const regular = engine.typeset(page([block])).pages[0].nodes[0];
  const bold = engine.typeset(page([{ ...block, fontWeight: "bold" }])).pages[0].nodes[0];
  assert.equal(bold.fontWeight, "bold");
  assert.equal(regular.lines.length, 1);
  assert.equal(bold.lines.length, 1);
  assert.ok(bold.lines[0].naturalWidth > regular.lines[0].naturalWidth, "bold Latin is wider");
  assert.deepEqual(engine.typeset(page([block])), engine.typeset(page([block])));
});

test("typeset: optimized breaking (the default) may shrink a line's spaces to fit, as Typst does", () => {
  const sentence = "The shock wave travels through water at about two kilometres per second.";
  const prepared = measurer.prepare(runs(sentence));
  const natural = measurer.layout(prepared, { fontSize: 10, width: 10000, align: "left" }).lines[0].width;
  // 0.8 pt narrower than the sentence: Typst lets each space shrink to 2/3.
  const block = { id: "a", box: [50, 100, 50 + natural - 0.8, 200], paragraphs: [{ runs: runs(sentence) }], fontSize: 10, lineHeight: 1.3, align: "justify" };
  const optimized = engine.typeset(page([block])).pages[0].nodes[0];
  const simple = engine.typeset(page([{ ...block, linebreaks: "simple" }])).pages[0].nodes[0];
  assert.equal(optimized.lines.length, 1, "set on one line, spaces shrunk");
  assert.equal(simple.lines.length, 2, "greedy breaking never shrinks");
  const line = optimized.lines[0];
  assert.ok(line.naturalWidth > line.width, "natural width wider than the painted width");
  assert.ok(Math.abs(line.width - (natural - 0.8)) < 1e-6, "painted exactly at the box width");
  assert.equal(line.justified, true, "drawn with Typst's justification, which shrinks");
  assert.equal(engine.typeset(page([block])).report.blocks.a.overflowRight, 0);
});
