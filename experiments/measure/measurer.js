"use strict";

// Measurement for the prototype pipeline on top of the production text
// measurer (src/text). Two shapes:
//   createProvider(nodes, maths) — lazy: the fitter asks metricsAt(node, size)
//                                  and only those sizes are laid out (cached)
//   measureJobs(jobs, maths)     — eager: every size of every node's ladder,
//                                  as { id, para, size, h0, h1, natural }
//                                  records (same shape as the Typst query),
//                                  for --measurer both comparisons
// node.prepared keeps [{ prepared, options }] per paragraph so the output
// is emitted with exactly the measured line breaks.

const fs = require("node:fs");
const path = require("node:path");
const Text = require("../../src/text/measurer");
const { FALLBACK_BOX } = require("./shared");

const DEFAULT_TABLE = path.resolve(__dirname, "../../data/fonts/source-han-serif-sc-regular.json");

function loadMeasurer(table = process.env.RPR_METRICS_TABLE || DEFAULT_TABLE) {
  return Text.createMeasurer({ metrics: JSON.parse(fs.readFileSync(table, "utf8")) });
}

// Formula boxes with the exact sizes the emitter gives Typst (fmt: 3 decimals).
function fmt3(value) {
  return Number(Number(value).toFixed(3));
}

// Prototype segments ({ type: "text", value } | { type: "math", value }) ->
// measurer content runs. A math run keeps `value` (TeX without delimiters)
// for the emitter.
function contentRuns(segments, maths) {
  return segments.map(segment => {
    if (segment.type !== "math") return { type: "text", text: segment.value };
    const entry = maths.get(segment.value, false);
    const tex = `$${segment.value}$`;
    if (!entry.ok) return { type: "math", tex, value: segment.value, display: false, ...FALLBACK_BOX(tex) };
    return { type: "math", tex, value: segment.value, display: false, widthEm: fmt3(entry.widthEm), heightEm: fmt3(entry.heightEm), depthEm: fmt3(entry.depthEm) };
  });
}

function paragraphOptions(node, paragraph) {
  return node.hangingIndent
    ? { hangingIndentEm: 1.1 }
    : { firstLineIndent: paragraph.indent > 0 ? fmt3(paragraph.indent) : 0 };
}

function prepareNode(node, measurer, maths) {
  if (!node.prepared) {
    node.prepared = node.paragraphs.map(paragraph => ({
      prepared: measurer.prepare(contentRuns(paragraph.segments, maths)),
      options: paragraphOptions(node, paragraph)
    }));
  }
  return node.prepared;
}

// { h0, lines, natural } per paragraph at `size`: h0 is the stacked height
// at leading 0 (the convention of the Typst query; single-line nodes are
// fitted by their unwrapped width).
function paragraphMetrics(node, measurer, size) {
  const width = node.contentBox[2] - node.contentBox[0];
  return node.prepared.map(({ prepared, options }) => {
    const result = measurer.layout(prepared, { ...options, fontSize: size, width, lineHeight: 1 });
    return {
      h0: result.height,
      lines: node.single ? 1 : Math.max(1, result.lines.length),
      natural: node.single ? measurer.naturalWidth(prepared, { ...options, fontSize: size }) : 0,
      count: result.lines.length
    };
  });
}

function createProvider(nodes, maths, measurer = loadMeasurer()) {
  const started = performance.now();
  for (const node of nodes) prepareNode(node, measurer, maths);
  const prepareMs = performance.now() - started;
  const cache = new Map();
  const stats = { layouts: 0, ms: 0, prepareMs };
  const metricsAt = (node, size) => {
    if (!node.prepared) return null;
    const key = `${node.uid}|${size.toFixed(2)}`;
    let value = cache.get(key);
    if (!value) {
      const t0 = performance.now();
      value = paragraphMetrics(node, measurer, size);
      stats.ms += performance.now() - t0;
      stats.layouts += value.length;
      cache.set(key, value);
    }
    return value;
  };
  return { metricsAt, stats, measurer };
}

// jobs: [{ node, sizes }] as built by run.js
function measureJobs(jobs, maths, measurer = loadMeasurer()) {
  const started = performance.now();
  const values = [];
  let layouts = 0;
  for (const { node, sizes } of jobs) {
    prepareNode(node, measurer, maths);
    for (const size of sizes) {
      paragraphMetrics(node, measurer, size).forEach((metrics, para) => {
        layouts += 1;
        values.push({
          id: node.uid,
          para,
          size,
          h0: metrics.h0,
          h1: node.single ? metrics.h0 : metrics.h0 + Math.max(0, metrics.count - 1),
          natural: metrics.natural
        });
      });
    }
  }
  return { values, ms: performance.now() - started, layouts };
}

module.exports = { loadMeasurer, createProvider, measureJobs, prepareNode, contentRuns, paragraphOptions };
