"use strict";

// Simplified fitter on top of Typst measurements. Not a port of src/fit.js:
// it keeps the decisions that matter for feasibility (one shared body font
// for the whole document, local line-height backoff, shared caption /
// reference / heading groups, growth only into free space below a node) and
// works purely from numbers returned by one batched `typst eval`.

const ladder = (from, to, step) => {
  const values = [];
  for (let value = from; value <= to + 1e-9; value += step) values.push(Math.round(value * 100) / 100);
  return values;
};

const BODY_SIZES = ladder(4.8, 13, 0.1);
const TITLE_SIZES = ladder(6, 28, 0.25);
const BODY_MIN_LINE_RATIO = 1.02;
const TOLERANCE = 0.5;

function sizesFor(node) {
  if (node.group === "title" || node.group === "main_title") return TITLE_SIZES;
  return BODY_SIZES;
}

// measurements: [{ id: uid, para, size, h0, h1, natural }]
function indexMeasurements(values) {
  const index = new Map();
  for (const value of values) {
    const key = `${value.id}|${value.size.toFixed(2)}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key)[value.para] = value;
  }
  return index;
}

function nodeMetrics(index, node, size) {
  const paragraphs = index.get(`${node.uid}|${size.toFixed(2)}`);
  if (!paragraphs || paragraphs.length !== node.paragraphs.length || paragraphs.some(p => !p)) return null;
  return paragraphs.map(p => ({
    h0: p.h0,
    // Single-line nodes are laid out unwrapped (box), always one line.
    lines: node.single ? 1 : Math.max(1, Math.round(p.h1 - p.h0) + 1),
    natural: p.natural
  }));
}

// CSS-equivalent height of the paragraph stack at font `size` and ratio `r`:
// n lines of r*size each (h0 = n*size for 1em lines; taller inline formulas
// are already inside h0) plus paragraph gaps.
function stackHeight(node, metrics, size, ratio) {
  if (node.single) return Math.max(...metrics.map(m => m.h0 - m.lines * size)) + ratio * size;
  const gap = Math.max(0, node.paragraphGap || 0) * size;
  return metrics.reduce((sum, m) => sum + m.h0 + m.lines * (ratio - 1) * size, 0) + gap * (metrics.length - 1);
}

function stackWidth(metrics) {
  return Math.max(...metrics.map(m => m.natural));
}

// Space a node may grow into: down to the first other node below that
// overlaps it horizontally, or the page bottom.
function freeHeight(node, pageNodes, pageHeight) {
  const [x0, y0, x1] = node.bbox;
  let bottom = pageHeight;
  for (const other of pageNodes) {
    if (other === node) continue;
    const [ox0, oy0, ox1] = other.bbox;
    if (Math.min(x1, ox1) - Math.max(x0, ox0) <= 2) continue;
    if (oy0 <= y0 + 1) continue;
    bottom = Math.min(bottom, oy0);
  }
  return bottom - y0;
}

function fits(node, metrics, size, ratio, allowed) {
  if (!metrics) return false;
  const width = node.contentBox[2] - node.contentBox[0];
  if (node.single && stackWidth(metrics) > width + TOLERANCE) return false;
  return stackHeight(node, metrics, size, ratio) <= allowed + TOLERANCE;
}

// Largest size on the ladder for which every node fits. Binary search
// (height grows with size); the step above the result is verified and the
// search walks up while it still fits, since greedy line breaking can make
// the height locally non-monotonic.
function largestSize(nodes, sizes, ok) {
  if (!sizes.length) return null;
  const memo = new Map();
  const allFit = index => {
    if (!memo.has(index)) memo.set(index, nodes.every(node => ok(node, sizes[index])));
    return memo.get(index);
  };
  if (!allFit(0)) return sizes[0];
  let low = 0;
  let high = sizes.length - 1;
  if (allFit(high)) low = high;
  else {
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (allFit(middle)) low = middle;
      else high = middle;
    }
  }
  while (low + 1 < sizes.length && allFit(low + 1)) low += 1;
  return sizes[low];
}

// measurements: the Typst query's records, or a function
// metricsAt(node, size) -> [{ h0, lines, natural }] that measures lazily.
function solveStyles(nodesByPage, pages, measurements, modelStyles) {
  const index = typeof measurements === "function" ? null : indexMeasurements(measurements);
  const all = nodesByPage.flat().filter(node => node.paragraphs?.length && node.render !== "formula");
  const allowedOf = new Map();
  nodesByPage.forEach((nodes, pageIndex) => {
    for (const node of nodes) {
      const strict = node.bbox[3] - node.bbox[1];
      const free = freeHeight(node, nodes, pages[pageIndex].height);
      const grows = ["body", "body_inherited", "list", "text", "title", "main_title"].includes(node.group);
      allowedOf.set(node.uid, grows ? Math.max(strict, free) : strict);
    }
  });
  const styles = new Map();
  const decisions = {};
  const metricsAt = index ? (node, size) => nodeMetrics(index, node, size) : measurements;

  // Body: one size for every non-inherited body stream, never above the
  // model's solved document style; each stream then gets the largest line
  // ratio <= its base ratio that still fits (local backoff, as in fit.js).
  const body = all.filter(node => node.group === "body");
  const bodyCap = Number(modelStyles?.bodyText?.fontSize) || 13;
  const bodySize = largestSize(body, BODY_SIZES.filter(size => size <= bodyCap + 1e-9), (node, size) =>
    fits(node, metricsAt(node, size), size, BODY_MIN_LINE_RATIO, allowedOf.get(node.uid)));
  decisions.bodySize = bodySize;
  for (const node of all.filter(node => node.group === "body" || node.group === "body_inherited")) {
    const metrics = metricsAt(node, bodySize);
    const allowed = allowedOf.get(node.uid);
    let ratio = node.lineRatio;
    if (metrics && !fits(node, metrics, bodySize, ratio, allowed)) {
      const low = stackHeight(node, metrics, bodySize, 1);
      const high = stackHeight(node, metrics, bodySize, 2);
      ratio = Math.max(BODY_MIN_LINE_RATIO, Math.min(node.lineRatio, 1 + (allowed - low) / Math.max(1e-6, high - low)));
    }
    styles.set(node.uid, { size: bodySize, lineRatio: Math.round(ratio * 1000) / 1000, gap: node.paragraphGap });
  }

  // Shared groups with fixed line ratio.
  const groups = new Map();
  for (const node of all) {
    if (node.group === "refs" || node.group === "title" || node.group?.startsWith("caption:")) {
      if (!groups.has(node.group)) groups.set(node.group, []);
      groups.get(node.group).push(node);
    }
  }
  for (const [group, nodes] of groups) {
    const caps = group === "refs" ? [4.8, 12] : group === "title" ? [6, 28] : [5.2, 10.5];
    const sizes = sizesFor(nodes[0]).filter(size => size >= caps[0] && size <= caps[1]);
    const size = largestSize(nodes, sizes, (node, s) => fits(node, metricsAt(node, s), s, node.lineRatio, allowedOf.get(node.uid)));
    decisions[group] = size;
    for (const node of nodes) styles.set(node.uid, { size, lineRatio: node.lineRatio, gap: node.paragraphGap || 0 });
  }

  // Everything else individually: main title, list/text streams, furniture.
  for (const node of all) {
    if (styles.has(node.uid) || node.render === "table" || node.render === "code") continue;
    const cap = node.group === "furniture" ? node.fontSize : node.group === "main_title" ? 28 : 13;
    const sizes = sizesFor(node).filter(size => size <= cap + 1e-9);
    const size = largestSize([node], sizes, (n, s) => fits(n, metricsAt(n, s), s, n.lineRatio, allowedOf.get(n.uid)));
    styles.set(node.uid, { size, lineRatio: node.lineRatio, gap: node.paragraphGap || 0 });
  }
  for (const node of nodesByPage.flat()) {
    if (node.render === "table") styles.set(node.uid, { size: 7, lineRatio: 1.1 });
    if (node.render === "code") styles.set(node.uid, { size: 7, lineRatio: 1.1 });
  }

  // Final geometry for the report: content rectangles and conflicts.
  const conflicts = [];
  nodesByPage.forEach((nodes, pageIndex) => {
    const rects = nodes.map(node => {
      const style = styles.get(node.uid);
      if (!style || !node.paragraphs?.length) return { node, rect: node.bbox };
      const metrics = metricsAt(node, style.size);
      const height = metrics ? stackHeight(node, metrics, style.size, style.lineRatio) : node.bbox[3] - node.bbox[1];
      const width = node.single && metrics ? Math.min(stackWidth(metrics), node.contentBox[2] - node.contentBox[0]) : node.contentBox[2] - node.contentBox[0];
      node.lines = metrics ? metrics.reduce((sum, m) => sum + m.lines, 0) : null;
      node.renderedHeight = height;
      return { node, rect: [node.contentBox[0], node.contentBox[1], node.contentBox[0] + width, node.contentBox[1] + height] };
    });
    for (let i = 0; i < rects.length; i++) {
      if (rects[i].rect[3] > pages[pageIndex].height + TOLERANCE) conflicts.push({ page: pageIndex + 1, type: "page-overflow", node: rects[i].node.key });
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i].rect;
        const b = rects[j].rect;
        const overlapX = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
        const overlapY = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
        if (overlapX > 1.5 && overlapY > 1.5) {
          conflicts.push({ page: pageIndex + 1, type: "overlap", a: rects[i].node.key, b: rects[j].node.key, overlapY: Math.round(overlapY * 10) / 10 });
        }
      }
    }
  });
  return { styles, decisions, conflicts };
}

module.exports = { solveStyles, sizesFor, BODY_SIZES, TITLE_SIZES };
