"use strict";

// Retain profile safety net: before shrinking a paragraph whose last line
// reaches the paragraph directly below, push the lower paragraph's first line
// down or lift this one's first line into free space above, each by at most
// NUDGE_MAX_EM (0.5 em) of the moved node's size (passes/retain-body.js,
// pushLowerFirstLine / liftIntoSpaceAbove).

const test = require("node:test");
const assert = require("node:assert/strict");
const FitModel = require("../src/fit-model.js");
const Text = require("../src/text/measurer");
const { defaultFontTable } = require("../src/index.js");
const { outputViolations } = require("./helpers/output-path");

const UNIT = "本研究采用合成数据分析冲击波在水中的传播并比较测量结果与数值模拟之间的差异。";

// Two stacked body paragraphs 3 pt apart; the upper one ("a") needs more
// room than its box at the shared body size. `aboveBottom` places a preserved
// element ending there, above "a".
function stackedModel({ aLen = 74, gap = 3, aboveBottom = null } = {}) {
  const textA = UNIT.repeat(4).slice(0, aLen);
  const textB = UNIT.repeat(4).slice(0, 60);
  const stream = (id, top, bottom, text) => ({
    pageIndex: 0, bbox: [50, top, 350, bottom], fontSize: 10, lineHeight: 1.25, paragraphGap: 0.16,
    styleKind: "body_text", debugRole: "body_candidate", columnKey: "",
    items: [{ id, text: "x", translatedText: text, originalLineCount: Math.round((bottom - top) / 12) }]
  });
  const absoluteBlocks = aboveBottom === null ? [] : [{ id: "above", type: "image", kind: "image", bbox: [50, aboveBottom - 30, 350, aboveBottom], sourceOnly: true }];
  return {
    pages: [{
      index: 0, width: 600, height: 800,
      blocks: [{ id: "a", translatable: true, translatedText: textA }, { id: "b", translatable: true, translatedText: textB }],
      restoration: { streams: [stream("a", 100, 124, textA), stream("b", 124 + gap, 160, textB)], absoluteBlocks }
    }]
  };
}

function fit(model, options = {}) {
  const events = [];
  const measurer = Text.createMeasurer({ metrics: defaultFontTable() });
  const fitted = FitModel.createModelFitter({ measurer, lineModel: "measurer", typography: "retain" })
    .fitDocument(model, { mode: "translation", retainTrace: (id, stage, data) => events.push({ id, stage, ...data }), ...options });
  const node = id => fitted.pages[0].nodes.find(item => item.id === id);
  return { fitted, events, node };
}

const firstTop = node => Math.min(...node.textRects.map(rect => rect.top));

test("retain nudge: push/lift keep the upper paragraph's size where shrinking was the only option", () => {
  const on = fit(stackedModel());
  const off = fit(stackedModel(), { retainPushLowerFirstLine: false });
  assert.ok(on.node("a").fontSize > off.node("a").fontSize,
    `nudges keep a larger size: ${on.node("a").fontSize} vs ${off.node("a").fontSize}`);
  const nudges = on.events.filter(event => event.stage === "push-lower" || event.stage === "lift");
  assert.ok(nudges.length > 0, "the nudge path ran");
  const violations = outputViolations(on.fitted);
  assert.equal(violations.lineOverlaps.length, 0, JSON.stringify(violations.lineOverlaps.slice(0, 2)));
  assert.equal(violations.order.length, 0, JSON.stringify(violations.order.slice(0, 2)));
});

test("retain nudge: every push and lift stays within 0.5 em of the moved paragraph's size", () => {
  // {aLen 80, gap 1.5} needs a push beyond the cap: it must be refused, not
  // applied (a push used to be measured from the box top instead of from the
  // first line's natural ink, under-counting it by the CJK overhang).
  for (const config of [{}, { gap: 4 }, { aLen: 68 }, { aLen: 78 }, { aLen: 80, gap: 1.5 }, { aLen: 90, gap: 1 }]) {
    const { events } = fit(stackedModel(config));
    for (const event of events) {
      if (event.stage === "push-lower") {
        assert.ok(event.moved <= event.cap + 1e-6, `${JSON.stringify(config)}: first line pushed ${event.moved} > cap ${event.cap}`);
      }
      if (event.stage === "lift") {
        assert.ok(event.moved <= event.cap + 1e-6, `${JSON.stringify(config)}: first line lifted ${event.moved} > cap ${event.cap}`);
      }
    }
  }
});

test("retain nudge: no lift into a preserved element above, and still no overlaps", () => {
  // The free model lifts "a"; put a preserved element right above its
  // natural first line so there is no room left to lift into.
  const free = fit(stackedModel());
  assert.ok(free.events.some(event => event.stage === "lift" && event.id === "a"), "precondition: 'a' is lifted when the space above is free");
  const naturalTop = firstTop(fit(stackedModel(), { retainPushLowerFirstLine: false }).node("a"));
  const blocked = fit(stackedModel({ aboveBottom: Math.floor(naturalTop) }));
  const a = blocked.node("a");
  assert.ok(!blocked.events.some(event => event.stage === "lift" && event.id === "a"), "no lift when the element above leaves no room");
  assert.ok(firstTop(a) >= Math.floor(naturalTop) - 1e-6, `first line ${firstTop(a)} stays below the element ending at ${Math.floor(naturalTop)}`);
  const violations = outputViolations(blocked.fitted);
  assert.equal(violations.lineOverlaps.length, 0, JSON.stringify(violations.lineOverlaps.slice(0, 2)));
});
