"use strict";

// Stand-in for the production measurer (src/text, built separately) on top of
// the experiment's pure-JS line layout (experiments/measure). It implements
// the agreed interface so src/fit-model.js can be developed and tested now:
//
//   createMeasurer({ metrics, profile, contentAscent, contentDescent })
//   measurer.prepare(runs) -> prepared
//   measurer.layout(prepared, { fontSize, lineHeight, width, firstLineIndent,
//                               hangingIndent, align, nowrap })
//     -> { lines: [{ start, end, width, x, top, baseline, ascent, descent,
//                    glyphTop, glyphBottom, justified }], height, maxLineWidth }
//   measurer.fitFontSize(prepared, { width, maxHeight, lineHeight, minFont,
//                                    maxFont, step, ...layoutOptions })
//   contentFromText(text, { renderMathBox })
//
// Vertical model (CSS, what the fitter's browser oracle uses): `lineHeight`
// is a ratio of the font size; every line box is fontSize * lineHeight tall
// unless an inline box (formula) needs more, and the glyph rectangle of a
// line is the font's content area (hhea ascent + descent) centred on the line
// box (half-leading), exactly as Range#getClientRects reports it. Lengths are
// unit-agnostic (the layout model uses source-page units throughout).
//
// profile "typst" (default) keeps the experiment's Typst-matching spacing;
// profile "browser" removes what Firefox does not do: CJK-Latin autospacing,
// CJK punctuation compression and line-edge punctuation trimming.

const path = require("node:path");
const { FontMetrics } = require("../../experiments/measure/font-metrics");
const linebreak = require("../../experiments/measure/linebreak");

const DEFAULT_TABLE = path.resolve(__dirname, "../../experiments/measure/data/source-han-serif-sc-regular.json");
// Source Han Serif (SC OTF and CN TTF share the ratio): hhea 1151/-286 per 1000.
const HHEA_ASCENT = 1.151;
const HHEA_DESCENT = 0.286;

let cachedMetrics = null;
function loadMetrics() {
  if (!cachedMetrics) cachedMetrics = FontMetrics.fromTable(require(DEFAULT_TABLE));
  return cachedMetrics;
}

function toSegments(runs) {
  const segments = [];
  for (const run of runs || []) {
    if (!run) continue;
    if (run.type === "break") segments.push({ type: "text", value: linebreak.LINE_SEPARATOR });
    else if (run.type === "math") {
      segments.push({
        type: "math",
        value: String(run.tex || ""),
        widthEm: Number(run.widthEm) || 0,
        heightEm: Number(run.heightEm) || 0,
        depthEm: Number(run.depthEm) || 0
      });
    }
    else if (run.text) segments.push({ type: "text", value: String(run.text) });
  }
  return segments;
}

// Re-shape without Typst's CJK adjustments (see header).
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
    if (c === linebreak.OBJECT || c === linebreak.LINE_SEPARATOR) {
      flush(i);
      if (c === linebreak.OBJECT) adv[i] = p.boxes.get(i).widthEm;
      runStart = i + 1;
    }
  }
  flush(n);
  p.shrinkL.fill(0); p.shrinkR.fill(0); p.spaceL.fill(0); p.spaceR.fill(0); p.punct.fill(0);
  for (let i = 0; i < n; i++) p.prefix[i + 1] = p.prefix[i] + adv[i];
  return p;
}

function createMeasurer(options = {}) {
  const metrics = options.metrics || loadMetrics();
  const profile = options.profile || "typst";
  const contentAscent = Number.isFinite(options.contentAscent) ? options.contentAscent : HHEA_ASCENT;
  const contentDescent = Number.isFinite(options.contentDescent) ? options.contentDescent : HHEA_DESCENT;
  // Gecko rounds a face's ascent and descent up to whole device pixels before
  // it builds content areas; Range rects are therefore integer-tall.
  const roundContentArea = options.roundContentArea ?? (profile === "browser");
  const pixels = value => roundContentArea ? Math.ceil(value - 1e-9) : value;

  function prepare(runs) {
    return { segments: toSegments(runs), variants: new Map() };
  }

  function variant(prepared, indent, hangEm) {
    const key = `${indent}|${hangEm}`;
    let p = prepared.variants.get(key);
    if (!p) {
      p = linebreak.prepare(prepared.segments, metrics, { indentPt: indent, hangingIndentEm: hangEm });
      if (profile === "browser") stripCjkAdjustments(p, metrics);
      prepared.variants.set(key, p);
    }
    return p;
  }

  function layout(prepared, opts = {}) {
    const fontSize = Number(opts.fontSize) || 10;
    const ratio = Number(opts.lineHeight) || 1.2;
    const width = opts.nowrap ? 1e9 : Math.max(0, Number(opts.width) || 0);
    const indent = Math.max(0, Number(opts.firstLineIndent) || 0);
    const hang = Math.max(0, Number(opts.hangingIndent) || 0);
    const align = opts.align || "left";
    const p = variant(prepared, Number(indent.toFixed(3)), hang ? hang / fontSize : 0);
    if (!p.n) return { lines: [], height: 0, maxLineWidth: 0 };
    const result = linebreak.layout(p, fontSize, width, { asc: contentAscent, desc: contentDescent });
    const L = fontSize * ratio;
    // Per-call content area override (em): the face the host CSS really
    // renders this node in, when it is not the measured one.
    const asc = pixels((Number.isFinite(opts.contentAscent) ? opts.contentAscent : contentAscent) * fontSize);
    const desc = pixels((Number.isFinite(opts.contentDescent) ? opts.contentDescent : contentDescent) * fontSize);
    // Glyphs the primary face lacks (fallbackPattern) come from a fallback
    // face: same baseline (the primary strut), its own ascent/descent.
    const fallback = opts.fallbackPattern instanceof RegExp && Number.isFinite(opts.fallbackAscent)
      ? { pattern: opts.fallbackPattern, asc: pixels(opts.fallbackAscent * fontSize), desc: pixels((opts.fallbackDescent || 0) * fontSize) }
      : null;
    const lines = [];
    let y = 0;
    let maxLineWidth = 0;
    result.lines.forEach((line, index) => {
      const first = index === 0;
      const last = index === result.lines.length - 1;
      const startX = first ? indent : hang;
      const available = first ? width - indent : width - hang;
      let lineWidth = line.widthPt - (first ? indent : 0);
      const justified = align === "justify" && !last && !opts.nowrap;
      if (justified) lineWidth = Math.max(lineWidth, available);
      let x = startX;
      if (align === "center" && !opts.nowrap) x = startX + (available - lineWidth) / 2;
      // Inline boxes may need a taller line box than the strut.
      // Text sits in the strut (content area + half-leading = exactly L);
      // only an inline box that sticks out of the strut grows the line box.
      let above = 0;
      let below = 0;
      for (let i = line.start; i < line.end; i++) {
        const box = p.boxes.get(i);
        if (!box) continue;
        above = Math.max(above, (box.heightEm - box.depthEm) * fontSize);
        below = Math.max(below, box.depthEm * fontSize);
      }
      const halfLeading = (L - (asc + desc)) / 2;
      const strutAbove = asc + halfLeading;
      const strutBelow = desc + halfLeading;
      const lineAbove = Math.max(strutAbove, above);
      const lineBelow = Math.max(strutBelow, below);
      const baseline = y + lineAbove;
      const lineText = p.text.slice(line.start, line.end);
      const hasText = lineText.replace(/[\s\u2028\uFFFC]/g, "").length > 0;
      const glyphAsc = fallback && fallback.pattern.test(lineText) ? Math.max(asc, fallback.asc) : asc;
      const glyphDesc = fallback && fallback.pattern.test(lineText) ? Math.max(desc, fallback.desc) : desc;
      lines.push({
        start: line.start,
        end: line.end,
        width: lineWidth,
        x,
        top: y,
        baseline,
        ascent: asc,
        descent: desc,
        glyphTop: baseline - (hasText ? Math.max(glyphAsc, above) : above),
        glyphBottom: baseline + (hasText ? Math.max(glyphDesc, below) : below),
        justified
      });
      maxLineWidth = Math.max(maxLineWidth, x + lineWidth);
      y += lineAbove + lineBelow;
    });
    return { lines, height: y, maxLineWidth };
  }

  function fitFontSize(prepared, opts = {}) {
    const step = Number(opts.step) || 0.25;
    const minFont = Number(opts.minFont) || 4;
    const maxFont = Number(opts.maxFont) || minFont;
    let best = minFont;
    let bestLayout = layout(prepared, { ...opts, fontSize: minFont });
    for (let size = minFont + step; size <= maxFont + 1e-9; size += step) {
      const result = layout(prepared, { ...opts, fontSize: size });
      if (result.height > opts.maxHeight + 1e-6) break;
      best = size;
      bestLayout = result;
    }
    return { fontSize: best, layout: bestLayout };
  }

  return { prepare, layout, fitFontSize, profile };
}

// Plain text -> runs. `\( \)`, `\[ \]` and `$ $` spans become math boxes when
// renderMathBox(tex, display) returns { widthEm, heightEm, depthEm }, else
// stay as the TeX source text (the browser harness renders TeX as text).
function contentFromText(text, { renderMathBox = null } = {}) {
  const source = String(text ?? "");
  const runs = [];
  const pattern = /\\\((.+?)\\\)|\\\[(.+?)\\\]|\$([^$\n]+?)\$/gs;
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > last) runs.push({ type: "text", text: source.slice(last, match.index) });
    const tex = match[1] ?? match[2] ?? match[3];
    const box = renderMathBox ? renderMathBox(tex, match[2] !== undefined) : null;
    runs.push(box ? { type: "math", tex, display: false, ...box } : { type: "text", text: tex });
    last = match.index + match[0].length;
  }
  if (last < source.length) runs.push({ type: "text", text: source.slice(last) });
  return runs;
}

// Metrics for a host face such as Arial: its own advances and kerning for the
// code points it covers, the fallback metrics (scaled) for the rest, e.g. CJK
// that the platform draws with a fallback face.
function compositeMetrics(fontPath, fallback = loadMetrics(), fallbackScale = 1) {
  const primary = FontMetrics.fromFont(fontPath);
  const font = primary.font;
  const covered = new Map();
  const has = cp => {
    let value = covered.get(cp);
    if (value === undefined) { value = font.hasGlyphForCodePoint(cp); covered.set(cp, value); }
    return value;
  };
  primary.layoutArgs = () => [undefined, undefined];
  const ownAdvance = primary.advanceUnits.bind(primary);
  primary.advanceUnits = (cp, mode) => has(cp)
    ? ownAdvance(cp, mode)
    : fallback.advanceUnits(cp, mode) / fallback.unitsPerEm * primary.unitsPerEm * fallbackScale;
  const ownPair = primary.pair.bind(primary);
  primary.pair = (a, b, mode) => (has(a) && has(b) ? ownPair(a, b, mode) : null);
  return primary;
}

module.exports = { createMeasurer, contentFromText, loadMetrics, compositeMetrics, HHEA_ASCENT, HHEA_DESCENT };
