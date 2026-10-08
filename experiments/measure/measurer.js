"use strict";

// Drop-in replacement for the Typst measurement query of the prototype
// pipeline: produces the same { id, para, size, h0, h1, natural } records
// (h0 = paragraph height at leading 0, h1 = at leading 1pt, natural = width
// unwrapped) with the pure-JS line layout, and keeps the prepared paragraphs
// so the output can be emitted with exactly these line breaks.

const fs = require("node:fs");
const path = require("node:path");
const { FontMetrics } = require("./font-metrics");
const { prepare, layout, naturalWidthPt, OBJECT } = require("./linebreak");
const { FALLBACK_BOX } = require("./shared");

const DEFAULT_TABLE = path.resolve(__dirname, "data/source-han-serif-sc-regular.json");

function loadMetrics(table = process.env.RPR_METRICS_TABLE || DEFAULT_TABLE) {
  if (fs.existsSync(table)) return FontMetrics.fromTable(JSON.parse(fs.readFileSync(table, "utf8")));
  const fontDir = process.env.RPR_FONT_DIR || path.resolve(__dirname, "../../../retain-pdf/resources/fonts");
  return FontMetrics.fromFont(path.join(fontDir, "SourceHanSerifSC-Regular.otf"));
}

// Formula boxes with the exact sizes the emitter gives Typst (fmt: 3 decimals).
function fmt3(value) {
  return Number(Number(value).toFixed(3));
}

function boxSegments(segments, maths) {
  return segments.map(segment => {
    if (segment.type !== "math") return segment;
    const entry = maths.get(segment.value, false);
    const tex = `$${segment.value}$`;
    if (!entry.ok) return { ...segment, tex, ...FALLBACK_BOX(tex) };
    return { ...segment, tex, widthEm: fmt3(entry.widthEm), heightEm: fmt3(entry.heightEm), depthEm: fmt3(entry.depthEm) };
  });
}

function prepareNode(node, metrics, maths) {
  return node.paragraphs.map(paragraph => {
    const segments = boxSegments(paragraph.segments, maths);
    const prepared = prepare(segments, metrics, {
      indentPt: !node.hangingIndent && paragraph.indent > 0 ? Number(Number(paragraph.indent).toFixed(3)) : 0,
      hangingIndentEm: node.hangingIndent ? 1.1 : 0
    });
    prepared.segments = segments;
    return prepared;
  });
}

// jobs: [{ node, sizes }] as built by run.js
function measureJobs(jobs, maths, metrics = loadMetrics()) {
  const started = performance.now();
  const values = [];
  let layouts = 0;
  for (const { node, sizes } of jobs) {
    node.prepared = prepareNode(node, metrics, maths);
    const width = node.contentBox[2] - node.contentBox[0];
    node.prepared.forEach((prepared, para) => {
      for (const size of sizes) {
        const result = layout(prepared, size, width, { asc: metrics.ascender, desc: metrics.descender });
        layouts += 1;
        const lines = result.lines.length;
        values.push({
          id: node.uid,
          para,
          size,
          h0: result.heightPt,
          // Same convention as the Typst query: single-line nodes are fitted
          // by their unwrapped width, h1 = h0.
          h1: node.single ? result.heightPt : result.heightPt + Math.max(0, lines - 1),
          natural: node.single ? naturalWidthPt(prepared, size) : 0
        });
      }
    });
  }
  return { values, ms: performance.now() - started, layouts };
}

module.exports = { loadMetrics, measureJobs, prepareNode, boxSegments, OBJECT };
