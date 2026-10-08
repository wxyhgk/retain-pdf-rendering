"use strict";

// Measurers for the fit-model tests, all on RetainPdfRendering.Text
// (src/text):
//   createMeasurer()                     the production measurer (Typst spacing)
//   createMeasurer({ spacing: "browser" }) the same, with prepared paragraphs
//       reshaped without what Firefox does not do: CJK-Latin autospacing,
//       CJK punctuation compression and line-edge punctuation trimming
//   compositeMetrics(fontPath, ...)      metrics for a host face such as Arial
//       (dev-only: reads the font with fontkit), falling back to Source Han
//       Serif for code points it lacks (CJK drawn by a platform fallback)

const Text = require("../../src/text/measurer");
const table = require("../../data/fonts/source-han-serif-sc-regular.json");

const { OBJECT, LINE_SEPARATOR } = Text._internal.Linebreak;
let defaultMetrics = null;
function sourceHanSerif() {
  if (!defaultMetrics) defaultMetrics = Text.createMetrics(table);
  return defaultMetrics;
}

function stripCjkAdjustments(p, metrics) {
  const { text, n, adv } = p;
  let runStart = 0;
  const flush = end => {
    if (end <= runStart) return;
    const shaped = metrics.shape(text.slice(runStart, end), undefined, undefined, p.kernR.subarray(runStart, end));
    for (let i = 0; i < shaped.length; i++) adv[runStart + i] = shaped[i];
  };
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (c === OBJECT || c === LINE_SEPARATOR) {
      flush(i);
      if (c === OBJECT) adv[i] = p.boxes.get(i).widthEm;
      runStart = i + 1;
    }
  }
  flush(n);
  p.shrinkL.fill(0); p.shrinkR.fill(0); p.spaceL.fill(0); p.spaceR.fill(0); p.punct.fill(0);
  for (let i = 0; i < n; i++) p.prefix[i + 1] = p.prefix[i] + adv[i];
  return p;
}

function createMeasurer({ spacing = "typst", metrics = null } = {}) {
  const base = Text.createMeasurer({ metrics: metrics || sourceHanSerif() });
  if (spacing !== "browser") return base;
  return { ...base, spacing, prepare(content) { return stripCjkAdjustments(base.prepare(content), base.metrics); } };
}

function compositeMetrics(fontPath, fallback = sourceHanSerif(), fallbackScale = 1) {
  const fontkit = require("fontkit");
  const font = fontkit.openSync(fontPath);
  const { FontMetrics } = Text._internal.Metrics;
  const mode = () => ({ advances: new Map(), pairs: new Map(), triples: new Map() });
  const metrics = new FontMetrics({
    unitsPerEm: font.unitsPerEm,
    ascender: font["OS/2"].typoAscender,
    descender: font["OS/2"].typoDescender,
    defaultAdvance: font.unitsPerEm,
    modes: { zh: mode(), dflt: mode() },
    font: font.postscriptName
  });
  const covered = new Map();
  const has = cp => {
    if (!covered.has(cp)) covered.set(cp, font.hasGlyphForCodePoint(cp));
    return covered.get(cp);
  };
  const advances = new Map();
  metrics.advanceUnits = (cp, shapingMode) => {
    if (!has(cp)) return fallback.advanceUnits(cp, shapingMode) / fallback.unitsPerEm * font.unitsPerEm * fallbackScale;
    if (!advances.has(cp)) advances.set(cp, font.glyphForCodePoint(cp).advanceWidth);
    return advances.get(cp);
  };
  const pairs = new Map();
  metrics.pair = (a, b) => {
    if (!has(a) || !has(b)) return null;
    const key = `${a},${b}`;
    if (!pairs.has(key)) {
      const run = font.layout(String.fromCodePoint(a, b));
      const total = run.positions.reduce((sum, position) => sum + position.xAdvance, 0);
      let value = null;
      if (run.glyphs.length === 1) value = { lig: total };
      else {
        const delta = total - metrics.advanceUnits(a) - metrics.advanceUnits(b);
        if (delta) value = { kern: delta };
      }
      pairs.set(key, value);
    }
    return pairs.get(key);
  };
  metrics.triple = () => null;
  return metrics;
}

module.exports = { createMeasurer, compositeMetrics, sourceHanSerif, Text };
