"use strict";

// src/fit-model.js against the browser fitter it ports.
//
// Oracle: test/browser/__snapshots__/<fixture>.firefox.SourceHanSerifCN-Regular.json,
// the per-node font size / line height the DOM fitter (src/fit.js) settles on
// in Firefox with Source Han Serif. The model fitter runs on the same golden
// layout models with RetainPdfRendering.Text (src/text) and lineModel "css":
//   - CSS line boxes and Gecko's whole-pixel content areas (cssPixelRounding)
//   - spacing "browser": the measurer's prepared paragraphs without what
//     Firefox does not do (CJK-Latin autospacing, CJK punctuation
//     compression); spacing "typst" (the measurer unchanged) is reported
//   - sans nodes (titles, page furniture, captions) measured with the system
//     Arial when present (macOS); without it they use the serif advances and
//     are reported, not asserted
// Invariants mirror test/browser/fit.browser.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const FitModel = require("../src/fit-model.js");
const { createMeasurer } = require("./helpers/model-measurers");
const P = require("./helpers/fit-model-parity");

const FONT_TOLERANCE = 0.25;   // px
const LINE_TOLERANCE = 0.05;   // line-height ratio
const TOLERANCE = 1.5;         // fitter's rectsOverlap padding / page tolerance
const SANS_CATEGORIES = new Set(["title", "caption"]);
const sansAvailable = Boolean(P.sansMeasurers("browser"));

function rectsOverlap(a, b, padding) {
  return a.left < b.right - padding && a.right > b.left + padding &&
    a.top < b.bottom - padding && a.bottom > b.top + padding;
}

function box(node) {
  const [left, top, right, bottom] = node.bbox;
  return { left, top, right, bottom };
}

// Final-audit collision predicate (fit.js enforceFinalTextCollisionSafety ->
// textCollisionDetails), applied to every node with text, exactly as the
// browser test's page host does.
function fitterCollision(source, nodes) {
  const own = box(source);
  const isBody = source.styleKind === "body_text";
  for (const barrier of nodes) {
    if (barrier === source) continue;
    const barrierBox = box(barrier);
    if (isBody && !(own.left < barrierBox.right - 1.5 && own.right > barrierBox.left + 1.5)) continue;
    const geometry = isBody ? barrier.contentRects : [barrierBox];
    for (const rect of source.textRects) {
      const hit = geometry.find(other => rectsOverlap(rect, other, TOLERANCE));
      if (!hit) continue;
      if (isBody && rect.top < own.top && barrierBox.bottom <= own.top + 1.5) continue;
      const sharesRightEdge = Math.abs(own.right - barrierBox.left) <= 1.5;
      const sharesLeftEdge = Math.abs(own.left - barrierBox.right) <= 1.5;
      if ((sharesRightEdge && rect.right <= own.right + 4.0) || (sharesLeftEdge && rect.left >= own.left - 4.0)) continue;
      const sharesBottomEdge = Math.abs(own.bottom - barrierBox.top) <= 1.5;
      const sharesTopEdge = Math.abs(own.top - barrierBox.bottom) <= 1.5;
      if ((sharesBottomEdge && rect.bottom <= own.bottom + 3.0) || (sharesTopEdge && rect.top >= own.top - 3.0)) continue;
      return { source: source.label, blocker: barrier.label, rect, hit };
    }
  }
  return null;
}

function inspect(fitted) {
  const overflows = [];
  const collisions = [];
  for (const page of fitted.pages) {
    for (const node of page.nodes) {
      const outside = node.textRects.find(rect =>
        rect.left < -TOLERANCE || rect.top < -TOLERANCE ||
        rect.right > page.width + TOLERANCE || rect.bottom > page.height + TOLERANCE);
      if (outside) overflows.push({ page: page.index, node: node.label, rect: outside });
    }
    for (const node of page.nodes) {
      if (!node.textRects.length) continue;
      const hit = fitterCollision(node, page.nodes);
      if (hit) collisions.push({ page: page.index, ...hit });
    }
  }
  return { overflows, collisions };
}

function styles(fitted) {
  return fitted.pages.map(page => page.nodes.map(node => [node.label, node.fontSize, node.styleLineHeight]));
}

function bodyInheritedFlags(model) {
  const flags = new Map();
  for (const page of model.pages || []) {
    for (const stream of page.restoration?.streams || []) {
      const id = String(stream.items?.[0]?.id || stream.items?.[0]?.parts?.[0]?.id || "");
      if (stream.bodyInherited) flags.set(`${page.index}#${id}`, true);
    }
  }
  return flags;
}

const summary = [];

for (const fixture of P.fixtures()) {
  const snapshot = P.snapshotFor(fixture.name);
  if (!snapshot) continue;
  for (const mode of Object.keys(snapshot.modes)) {
    test(`fit-model parity: ${fixture.name}/${mode}`, t => {
      const fitter = P.createFitter("browser");
      const fitted = fitter.fitDocument(fixture.expected, { mode });
      const rows = P.compare(fitted, snapshot.modes[mode]);
      assert.ok(rows.every(row => !row.missing), "every page has the same nodes as the browser");
      const inherited = bodyInheritedFlags(fixture.expected);
      let maxFont = 0;
      let maxLine = 0;
      const failures = [];
      for (const row of rows) {
        assert.equal(row.label, row.snapshotLabel, "nodes line up with the snapshot");
        const sansOnly = SANS_CATEGORIES.has(row.category) || /^block:(page_header|header|page_footer|footer|page_number)/.test(row.label);
        const asserted = sansAvailable || !sansOnly;
        if (!asserted) continue;
        maxFont = Math.max(maxFont, Math.abs(row.dFont));
        maxLine = Math.max(maxLine, Math.abs(row.dLine));
        if (Math.abs(row.dFont) > FONT_TOLERANCE || Math.abs(row.dLine) > LINE_TOLERANCE) {
          failures.push(`p${row.page} ${row.label}: font ${row.browserFont} -> ${row.modelFont}, line ${row.browserLine} -> ${row.modelLine}`);
        }
      }
      const bodyRows = rows.filter(row => row.category === "body" && !inherited.get(`${row.page}#${row.node.id}`));
      const browserBody = [...new Set(bodyRows.map(row => row.browserFont))].join("/") || "-";
      const modelBody = [...new Set(bodyRows.map(row => row.modelFont))].join("/") || "-";
      summary.push({ fixture: fixture.name, mode, browserBody, modelBody, maxFont, maxLine, nodes: rows.length, outside: failures.length });
      if (!sansAvailable) t.diagnostic("system Arial not found: titles, captions and page furniture are not compared");
      assert.deepEqual(failures, [], `nodes outside ±${FONT_TOLERANCE}px / ±${LINE_TOLERANCE}`);
    });
  }
}

for (const profile of ["browser", "typst"]) { // spacing of the measurer
  for (const fixture of P.fixtures()) {
    const modes = fixture.expected.pages.some(page => (page.blocks || []).some(block => block.translatable && block.translatedText))
      ? ["source", "translation"]
      : ["source"];
    for (const mode of modes) {
      test(`fit-model invariants (${profile}): ${fixture.name}/${mode}`, () => {
        const fitter = P.createFitter(profile);
        const first = fitter.fitDocument(fixture.expected, { mode });
        const second = P.createFitter(profile).fitDocument(fixture.expected, { mode });
        const result = inspect(first);
        assert.deepEqual(result.overflows, [], "glyph rects outside their page");
        assert.deepEqual(result.collisions, [], "glyph rects collide with another node (final-audit predicate)");
        const inherited = bodyInheritedFlags(fixture.expected);
        const bodyFonts = new Set();
        for (const page of first.pages) {
          for (const node of page.nodes) {
            if (node.kind === "stream" && node.styleKind === "body_text" && node.flowKind === "text" && !inherited.get(`${page.index}#${node.id}`)) {
              bodyFonts.add(node.fontSize);
            }
          }
        }
        assert.ok(bodyFonts.size <= 1, `non-inherited body streams share one font size, got ${[...bodyFonts].join(", ")}`);
        assert.deepEqual(styles(second), styles(first), "fit is deterministic");
      });
    }
  }
}

test("fit-model: the invariant probes detect an oversized body stream", () => {
  const fixture = P.fixtures().find(item => item.name === "two-column-article");
  const fitted = P.createFitter("browser").fitDocument(fixture.expected, { mode: "translation" });
  // The user body-font override is applied after fitting and is never
  // backed off: 30pt (40px) body text must trip both probes.
  const model = JSON.parse(JSON.stringify(fixture.expected));
  const fitter = FitModel.createModelFitter({ measurer: createMeasurer({ spacing: "browser" }), lineModel: "css", cssPixelRounding: true });
  const strict = fitter.fitDocument(model, { mode: "translation", userBodyFontPt: 30 });
  const result = inspect(strict);
  assert.ok(result.collisions.length > 0, "a 40px body stream must collide with its neighbours");
  assert.ok(result.overflows.length > 0, "a 40px body stream must leave its page");
  assert.equal(inspect(fitted).collisions.length, 0);
});

test("fit-model: lines are absolute and in reading order", () => {
  const fixture = P.fixtures().find(item => item.name === "two-column-article");
  const fitted = P.createFitter("browser").fitDocument(fixture.expected, { mode: "translation" });
  const body = fitted.pages[0].nodes.find(node => node.styleKind === "body_text");
  assert.ok(body.lines.length > 3);
  for (let i = 1; i < body.lines.length; i++) assert.ok(body.lines[i].top >= body.lines[i - 1].top);
  assert.ok(body.lines.every(line => line.x >= body.bbox[0] && line.x + line.width <= body.bbox[2] + .01));
  assert.ok(Array.isArray(body.paragraphs) && body.paragraphs[0].runs.length > 0);
});

test("fit-model: the measurer is injected, never required", () => {
  const calls = { prepare: 0, layout: 0 };
  const fake = {
    prepare(runs) { calls.prepare += 1; return { text: runs.map(run => run.text || "").join("") }; },
    layout(prepared, options) {
      calls.layout += 1;
      const perLine = Math.max(1, Math.floor(options.nowrap ? 1e9 : options.width / options.fontSize));
      const count = Math.max(1, Math.ceil(prepared.text.length / perLine));
      const L = options.fontSize * options.lineHeight;
      const lines = Array.from({ length: prepared.text.length ? count : 0 }, (_, i) => ({
        start: i * perLine, end: Math.min(prepared.text.length, (i + 1) * perLine),
        width: Math.min(options.width || 1e9, prepared.text.length * options.fontSize), x: 0, top: i * L,
        baseline: i * L + .8 * L, ascent: .8 * L, descent: .2 * L, glyphTop: i * L, glyphBottom: (i + 1) * L, justified: false
      }));
      return { lines, height: lines.length * L, maxLineWidth: lines.length ? lines[0].width : 0 };
    }
  };
  const fixture = P.fixtures().find(item => item.name === "single-column-report");
  const fitted = FitModel.createModelFitter({ measurer: fake }).fitDocument(fixture.expected, { mode: "source" });
  assert.ok(calls.prepare > 0 && calls.layout > 0);
  assert.equal(fitted.pages.length, fixture.expected.pages.length);
});

test("fit-model: helpers", () => {
  const { gallopingGrow, collapseRuns } = FitModel._internal;
  assert.deepEqual(gallopingGrow(5, 10, 1, value => value > 7.5).value, 7);
  assert.deepEqual(collapseRuns([{ type: "text", text: "  a \n b " }, { type: "text", text: " c" }]), [{ type: "text", text: "a b c" }]);
  assert.throws(() => FitModel.createModelFitter({}), /measurer/);
});

test.after(() => {
  if (!summary.length) return;
  const lines = ["fit-model vs browser snapshots (Firefox, Source Han Serif):",
    "fixture/mode                                body font browser -> model   max |dFont|  max |dLine|  nodes"];
  for (const row of summary) {
    lines.push(`${`${row.fixture}/${row.mode}`.padEnd(44)}${`${row.browserBody} -> ${row.modelBody}`.padEnd(29)}${row.maxFont.toFixed(3).padStart(11)}${row.maxLine.toFixed(3).padStart(13)}${String(row.nodes).padStart(7)}`);
  }
  console.log(lines.join("\n"));
});
