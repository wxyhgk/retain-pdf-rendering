"use strict";

// Justification: the per-gap stretch cap (retain line model) and balanced
// breaking (Linebreak balance + passes/justify.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const Text = require("../src/text/measurer");
const { defaultFontTable } = require("../src/index.js");
const RetainLines = require("../src/fit-model/line-models/retain");
const { sourceHanSerifInk } = require("../src/fit-model/constants");

const measurer = Text.createMeasurer({ metrics: defaultFontTable() });
// A wide unbreakable box after a short CJK run: greedy breaking leaves the
// line before it with a lot of slack.
const content = [
  { type: "text", text: "在认知功能受损组中，受教育程度较低的参与者比例更高" },
  { type: "math", tex: "p < 0.001", widthEm: 6, heightEm: .7, depthEm: .1 },
  { type: "text", text: "，而且未婚与无规律运动的比例也明显更高，此外农村居住比例同样较高。" }
];
const text = content.map(run => run.type === "math" ? "￼" : run.text).join("");

test("justify: the retain line model caps stretch per justifiable gap", () => {
  const prepared = measurer.prepare(content);
  const capped = RetainLines.createRetainLineModel({ inkExtents: sourceHanSerifInk, justifyCap: 0.15 });
  const free = RetainLines.createRetainLineModel({ inkExtents: sourceHanSerifInk, justifyCap: null });
  const options = { fontSize: 10, lineHeight: 1.29, width: 150, align: "justify", text };
  const a = capped.layoutText(measurer, prepared, options);
  const b = free.layoutText(measurer, prepared, options);
  assert.equal(a.lines.length, b.lines.length, "the cap never changes breaks");
  let sawCap = false;
  for (const line of a.lines) {
    if (!line.justified) continue;
    const gaps = RetainLines.justifiableGaps(text.slice(line.start, line.end));
    assert.ok(line.width <= line.naturalWidth + gaps * 0.15 * 10 + 1e-6, "stretch stays within the cap");
    if (line.width < (b.lines.find(other => other.start === line.start)?.width ?? 0) - 1e-6) sawCap = true;
  }
  assert.ok(sawCap, "at least one line in this sample is capped");
  a.lines.forEach((line, index) => {
    assert.equal(line.baseline, b.lines[index].baseline, "vertical placement is unchanged");
  });
});

test("justify: balanced breaking keeps the line count and lowers the worst stretch", () => {
  const prepared = measurer.prepare(content);
  const greedy = measurer.layout(prepared, { fontSize: 10, width: 150, align: "justify" });
  const balanced = measurer.layout(prepared, { fontSize: 10, width: 150, align: "justify", balance: {} });
  assert.equal(balanced.lines.length, greedy.lines.length);
  const worst = result => Math.max(...result.lines.slice(0, -1).map(line => {
    const gaps = RetainLines.justifiableGaps(text.slice(line.start, line.end));
    return gaps ? (line.available - line.width) / gaps : 0;
  }));
  assert.ok(worst(balanced) <= worst(greedy) + 1e-9, `${worst(balanced)} <= ${worst(greedy)}`);
});

test("justify: the post-fit balance pass only keeps re-breaks with identical vertical extents", () => {
  const { sameVerticalExtents } = require("../src/fit-model/passes/justify");
  const line = { paragraph: 0, top: 1, baseline: 9, glyphTop: 1.5, glyphBottom: 10 };
  assert.ok(sameVerticalExtents({ lines: [line] }, { lines: [{ ...line }] }));
  assert.ok(!sameVerticalExtents({ lines: [line] }, { lines: [{ ...line, glyphBottom: 10.2 }] }));
  assert.ok(!sameVerticalExtents({ lines: [line] }, { lines: [line, line] }));
});
