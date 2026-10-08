"use strict";

// Typography profile "retain": retain-pdf's body font-size and leading rules
// (src/fit-model/typography-retain.js, passes/retain-body.js,
// line-models/retain.js). Expected numbers are worked out from the
// retain-pdf sources cited in typography-retain.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../src/fit-model/typography-retain.js");
const FitModel = require("../src/fit-model.js");
const Text = require("../src/text/measurer");
const { defaultFontTable } = require("../src/index.js");

test("retain leading: body blend 35% source pitch / 65% Chinese target, floors and clamp", () => {
  // pitch 12 at 10 pt: 0.2 * .35 + .56 * .65 = .434, * .988 = .429, raised to
  // the normal floor .52 * .988 = .514 -> .51
  assert.equal(T.bodyLeadingEm({ fontSize: 10, sourcePitch: 12 }), 0.51);
  // no source pitch: .56 * .988 = .553 -> .55
  assert.equal(T.bodyLeadingEm({ fontSize: 10 }), 0.55);
  // pitch 16: .6 * .35 + .364 = .574 * .988 = .567 -> .57
  assert.equal(T.bodyLeadingEm({ fontSize: 10, sourcePitch: 16 }), 0.57);
  // very loose source: clamped to BODY_LEADING_MAX .68
  assert.equal(T.bodyLeadingEm({ fontSize: 10, sourcePitch: 30 }), 0.68);
  // formula-heavy: at least BODY_LEADING_MIN / FORMULA_LEADING_RATIO = .478 (the .514 floor wins)
  assert.equal(T.bodyLeadingEm({ fontSize: 10, sourcePitch: 10.5, formulaWeight: 0.2 }), 0.51);
});

test("retain leading: non-body blend 55% source pitch / 45% default .48, clamp .26-.56", () => {
  // pitch 12 at 10 pt: (.2 * .55 + .48 * .45) * .988 = .322 -> .32
  assert.equal(T.nonBodyLeadingEm({ fontSize: 10, sourcePitch: 12 }), 0.32);
  assert.equal(T.nonBodyLeadingEm({ fontSize: 10 }), 0.47);
  assert.equal(T.nonBodyLeadingEm({ fontSize: 10, sourcePitch: 25 }), 0.56);
  assert.equal(T.nonBodyLeadingEm({ fontSize: 10, sourcePitch: 9 }), 0.26);
});

test("retain book target: 25th percentile after dropping extreme small sizes", () => {
  assert.equal(T.lowQuantileFontTarget([9, 10, 10, 10.5, 11]), 10);
  // 5 pt is below max(median * .82, median - 1.6) = 8.8 and is dropped;
  // [10, 10.4, 10.6, 11][floor(3 * .25)] = 10 (with 5 kept it would be 10 too,
  // so also check a case where dropping changes the result)
  assert.equal(T.lowQuantileFontTarget([5, 10, 10.4, 10.6, 11]), 10);
  // dropped: [10.2, 10.4, 10.6, 11, 11.2][1] = 10.4 (kept, it would be 5.5)
  assert.equal(T.lowQuantileFontTarget([5, 5.5, 10.2, 10.4, 10.6, 11, 11.2]), 10.4);
  assert.equal(T.lowQuantileFontTarget([]), 0);
});

test("retain unify decision: larger -> target; smaller -> target only when it renders directly or density <= 1.08", () => {
  assert.equal(T.unifyDecision({ currentFont: 11, targetFont: 10, densityAtTarget: 2 }), "target");
  assert.equal(T.unifyDecision({ currentFont: 9.95, targetFont: 10, densityAtTarget: 2, directRender: false }), "target");
  assert.equal(T.unifyDecision({ currentFont: 9, targetFont: 10, densityAtTarget: 1.0, directRender: false }), "target");
  assert.equal(T.unifyDecision({ currentFont: 9, targetFont: 10, densityAtTarget: 1.2, directRender: false }), "keep");
});

test("retain density: real line count x inflated line step x formula discount over box height", () => {
  // 3 lines at 10 pt, leading .56: step 15.6, 46.8 / 60
  assert.ok(Math.abs(T.estimatedDensity({ lines: 3, fontSize: 10, leadingEm: 0.56, boxHeight: 60 }) - 0.78) < 1e-9);
  // leading below .02 uses the 1.02 floor
  assert.ok(Math.abs(T.estimatedDensity({ lines: 1, fontSize: 10, leadingEm: 0, boxHeight: 10.2 }) - 1) < 1e-9);
  assert.equal(T.formulaEstimateDiscount(10, []), 1);
  assert.ok(T.formulaEstimateDiscount(10, ["\\frac{a}{b}"]) < 1);
});

test("retain underfill target and formula insets follow body_font_underfill_policy / formula_safety", () => {
  // short boxes never grow (BODY_UNDERFILLED_FONT_GROW_SHORT_MAX_PT = 0)
  assert.equal(T.underfillTargetFont({ fontSize: 10, density: 0.3, pageFontTarget: 10, pageUnderfillRatio: 0, lineCount: 1, boxHeight: 40, sourceLines: 1 }), 10);
  const grown = T.underfillTargetFont({ fontSize: 10, density: 0.3, pageFontTarget: 10, pageUnderfillRatio: 0, lineCount: 3, boxHeight: 80, sourceLines: 3 });
  assert.ok(grown > 10 && grown <= 10 + 1.15 + 0.04 + 0.08 + 0.18, `grown ${grown}`);
  assert.deepEqual(T.formulaInsets(10, 40, []), { top: 0, bottom: 0 });
  assert.deepEqual(T.formulaInsets(10, 40, ["x"]), { top: 0.45, bottom: 1.1 });
  assert.deepEqual(T.formulaInsets(10, 40, ["x^2"]), { top: 0.7, bottom: 1.8 });
});

// One sparse body paragraph that the underfill rule wants to grow, optionally
// with a preserved element right below its text.
function underfillModel(obstacleTop) {
  const text = "本研究采用合成数据分析冲击波在水中的传播并比较测量结果与数值模拟之间的差异。".repeat(2);
  const absoluteBlocks = obstacleTop === null ? [] : [{ id: "obstacle", type: "image", kind: "image", bbox: [40, obstacleTop, 360, obstacleTop + 40], sourceOnly: true }];
  return {
    pages: [{
      index: 0, width: 600, height: 800, blocks: [{ id: "a", translatable: true, translatedText: text }],
      restoration: {
        streams: [{
          pageIndex: 0, bbox: [50, 100, 350, 200], fontSize: 10, lineHeight: 1.25, paragraphGap: 0.16,
          styleKind: "body_text", debugRole: "body_candidate", columnKey: "",
          items: [{ id: "a", text: "x", translatedText: text, originalLineCount: 6 }]
        }],
        absoluteBlocks
      }
    }]
  };
}

function fitRetain(model) {
  const measurer = Text.createMeasurer({ metrics: defaultFontTable() });
  const fitter = FitModel.createModelFitter({ measurer, lineModel: "measurer", typography: "retain" });
  return fitter.fitDocument(model, { mode: "translation" });
}

test("retain underfill growth grows a sparse paragraph and stops at the first collision", () => {
  const free = fitRetain(underfillModel(null));
  const body = fitted => fitted.pages[0].nodes.find(node => node.styleKind === "body_text");
  const grownFree = body(free);
  assert.ok(grownFree.fontSize > 10.2, `a sparse paragraph grows: ${grownFree.fontSize}`);
  const freeBottom = Math.max(...grownFree.textRects.map(rect => rect.bottom));

  // A preserved element 0.4 pt below where the grown text ends: growth must
  // stop earlier and the text must stay clear of it.
  const blocked = fitRetain(underfillModel(freeBottom - 1));
  const grownBlocked = body(blocked);
  assert.ok(grownBlocked.fontSize < grownFree.fontSize, `${grownBlocked.fontSize} < ${grownFree.fontSize}`);
  const bottom = Math.max(...grownBlocked.textRects.map(rect => rect.bottom));
  assert.ok(bottom <= freeBottom - 1 + 1e-6, `text ends at ${bottom}, obstacle starts at ${freeBottom - 1}`);
});

test("retain profile off: the default fitter ignores retain-only node fields", () => {
  const measurer = Text.createMeasurer({ metrics: defaultFontTable() });
  const plain = FitModel.createModelFitter({ measurer, lineModel: "measurer" }).fitDocument(underfillModel(null), { mode: "translation" });
  const node = plain.pages[0].nodes.find(item => item.styleKind === "body_text");
  assert.ok(Number.isFinite(node.fontSize));
  assert.equal(node.lines[0].fitTop, undefined, "default line model reports no fit band");
});

test("retain: geometryLocalFontSize follows local_font_size_pt for non-body blocks", () => {
  const Retain = require("../src/fit-model/typography-retain.js");
  // glyph height 12 -> metric 11.76 -> x0.9215 = 10.84 (clamped 8.4..14.2)
  assert.equal(Retain.geometryLocalFontSize({ glyphHeight: 12, pitch: 0 }), 10.84);
  // captions: x0.86, capped at 10
  assert.equal(Retain.geometryLocalFontSize({ glyphHeight: 12, pitch: 0, role: "caption" }), 9.32);
  assert.equal(Retain.geometryLocalFontSize({ glyphHeight: 30, pitch: 0, role: "caption" }), 10);
  // headings are not pulled toward the page body size and stop at 14.2
  assert.equal(Retain.geometryLocalFontSize({ glyphHeight: 40, pitch: 0 }), 14.2);
  assert.equal(Retain.geometryLocalFontSize({ glyphHeight: 0, pitch: 0 }), 0);
});

test("fit-model: measurers.bold measures title nodes (and nothing else)", () => {
  const FitModel = require("../src/fit-model.js");
  const Text = require("../src/text/measurer");
  const { defaultFontTable } = require("../src/index.js");
  const fs = require("node:fs");
  const path = require("node:path");
  const regular = Text.createMeasurer({ metrics: defaultFontTable() });
  const boldTable = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "fonts", "source-han-serif-sc-bold.json"), "utf8"));
  const bold = Text.createMeasurer({ metrics: boldTable });
  const used = { regular: 0, bold: 0 };
  const counting = (measurer, key) => ({ ...measurer, layout(prepared, options) { used[key] += 1; return measurer.layout(prepared, options); } });
  const P = require("./helpers/fit-model-parity");
  const fixture = P.fixtures().find(item => item.name === "two-column-article");
  const fitter = FitModel.createModelFitter({ measurer: counting(regular, "regular"), measurers: { bold: counting(bold, "bold") }, lineModel: "measurer" });
  const fitted = fitter.fitDocument(JSON.parse(JSON.stringify(fixture.expected)), { mode: "translation" });
  const titles = fitted.pages.flatMap(page => page.nodes).filter(node => node.kind === "block" && node.type === "title");
  assert.ok(titles.length > 0, "fixture has titles");
  assert.ok(used.bold > 0, "bold measurer used for titles");
  assert.ok(used.regular > 0, "regular measurer still used for the rest");
  // Bold Latin and CJK run wider than regular in Source Han Serif.
  const width = measurer => measurer.layout(measurer.prepare([{ type: "text", text: "Results 研究人群特征" }]), { fontSize: 10, width: 1e6 }).maxLineWidth;
  assert.ok(width(bold) > width(regular));
});

test("retain: headings are sized on their own boxes, bold, and the main title is left-aligned", () => {
  const FitModel = require("../src/fit-model.js");
  const Text = require("../src/text/measurer");
  const { defaultFontTable } = require("../src/index.js");
  const P = require("./helpers/fit-model-parity");
  const fixture = P.fixtures().find(item => item.name === "two-column-article");
  const fitter = FitModel.createModelFitter({
    measurer: Text.createMeasurer({ metrics: defaultFontTable() }),
    measurers: { bold: Text.createMeasurer({ metrics: defaultFontTable("bold") }) },
    typography: "retain"
  });
  const fitted = fitter.fitDocument(JSON.parse(JSON.stringify(fixture.expected)), { mode: "translation" });
  const titles = fitted.pages.flatMap(page => page.nodes).filter(node => node.kind === "block" && node.type === "title");
  assert.ok(titles.length > 0);
  assert.ok(titles.every(node => node.fontWeight === "bold"), "titles are painted bold when measured bold");
  assert.ok(titles.every(node => /^retain-(title|heading)$/.test(node.fit?.pass || "")), "retain title pass sized every heading");
  assert.equal(titles.filter(node => node.align === "center").length, 0, "no centred main title in the retain profile");
  const bodies = fitted.pages.flatMap(page => page.nodes).filter(node => node.kind === "stream");
  assert.ok(bodies.every(node => node.fontWeight === undefined), "body text stays regular");
});
