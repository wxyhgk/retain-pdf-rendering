"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { texToSVG } = require("./math-svg");
const { typstString, LINE_BREAK } = require("./content");

const FONT_FAMILY = "Source Han Serif SC";
// Greedy ("simple") breaking matches the browser's line breaks exactly on the
// fixtures (Typst's default Knuth-Plass "optimized" mode packs justified
// English tighter, one line fewer in 5/32 paragraphs). RPR_LINEBREAKS=optimized
// switches back.
const LINEBREAKS = JSON.stringify(process.env.RPR_LINEBREAKS || "simple");

// Typst preamble shared by the measurement and the output documents.
//
// Line metrics: with top-edge/bottom-edge = ascender/descender a Source Han
// Serif line is exactly 1em tall, so a CSS line-height ratio r maps to
// par(leading: (r - 1) * size). CSS also puts half of that leading above the
// first and below the last line; the output adds it as block inset.
//
// rpr-math: the visible formula is the MathJax SVG; on top of it, inside the
// same fixed-size box, the LaTeX source is set as fully transparent text
// scaled to the SVG's width. PDF text extraction / copy / search therefore
// yield the LaTeX, while the box (not the text) decides layout.
const PREAMBLE = `#let rpr-math(src, w, h, depth, tex) = box(baseline: depth, width: w, height: h, {
  // Only placed children: the box has no text line of its own, so its
  // baseline is its bottom edge and baseline: depth lowers it by the
  // formula's depth below the surrounding baseline.
  place(top + left, image(src, width: w, height: h))
  place(bottom + left, dy: -depth, context {
    let (wa, ha) = (w.to-absolute(), h.to-absolute())
    let natural = measure(text(size: 10pt, tex)).width
    let size = if natural > 0pt { calc.min(10pt * (wa / natural), ha) } else { ha }
    text(fill: rgb(0, 0, 0, 0), size: size, top-edge: "ascender", bottom-edge: "baseline", tex)
  })
})
// MathJax failure: the raw LaTeX in red, as one unbreakable box (Typst raw
// text is DejaVu Sans Mono at 0.8 em: 0.4816 em per character).
#let rpr-tex-fallback(tex) = box(text(fill: rgb("#8a1c1c"), raw(tex)))
`;

function fmt(value) {
  return Number(value).toFixed(3).replace(/\.?0+$/, "") || "0";
}

class MathStore {
  constructor(outDir) {
    this.outDir = outDir;
    this.dir = path.join(outDir, "math");
    fs.mkdirSync(this.dir, { recursive: true });
    this.stats = { formulas: 0, failed: [], ms: 0 };
    this.written = new Map();
  }

  // Returns { ok, file (relative to outDir), widthEm, heightEm, depthEm }.
  get(tex, display) {
    const key = `${display ? "D" : "I"}:${tex}`;
    if (this.written.has(key)) return this.written.get(key);
    const started = performance.now();
    const result = texToSVG(tex, display);
    this.stats.ms += performance.now() - started;
    this.stats.formulas += 1;
    let entry;
    if (!result.ok) {
      this.stats.failed.push({ tex, error: result.error });
      entry = { ok: false, tex };
    }
    else {
      const name = `${crypto.createHash("sha1").update(key).digest("hex").slice(0, 16)}.svg`;
      fs.writeFileSync(path.join(this.dir, name), result.svg);
      entry = { ok: true, tex, file: `math/${name}`, widthEm: result.widthEm, heightEm: result.heightEm, depthEm: result.depthEm };
    }
    this.written.set(key, entry);
    return entry;
  }
}

// Inline content (text + inline formulas) as Typst code-mode expressions.
function inlineContent(segments, maths) {
  const pieces = [];
  for (const segment of segments || []) {
    if (segment.type === "text") {
      segment.value.split(LINE_BREAK).forEach((chunk, index) => {
        if (index) pieces.push("linebreak()");
        if (chunk) pieces.push(typstString(chunk));
      });
      continue;
    }
    const entry = maths.get(segment.value, false);
    const tex = `$${segment.value}$`;
    pieces.push(entry.ok
      ? `rpr-math(${typstString(entry.file)}, ${fmt(entry.widthEm)}em, ${fmt(entry.heightEm)}em, ${fmt(entry.depthEm)}em, ${typstString(tex)})`
      : `rpr-tex-fallback(${typstString(tex)})`);
  }
  return pieces.length ? `[#${pieces.join("#")}]` : "[]";
}

// Paragraph stack of a text node at one style. `leading`/`spacing` already in pt.
function paragraphStack(node, maths, style) {
  const { size, lineRatio, gap = 0 } = style;
  const leading = Math.max(0, (lineRatio - 1) * size);
  const spacing = leading + Math.max(0, gap) * size;
  const justify = node.align === "justify";
  const settings = [
    `set text(size: ${fmt(size)}pt)`,
    `set par(leading: ${fmt(leading)}pt, spacing: ${fmt(spacing)}pt, justify: ${justify}, linebreaks: ${LINEBREAKS}${node.hangingIndent ? ", hanging-indent: 1.1em" : ""})`
  ];
  const paragraphs = (node.paragraphs || []).map(paragraph => {
    const indent = !node.hangingIndent && paragraph.indent > 0 ? `#h(${fmt(paragraph.indent)}pt)` : "";
    const body = inlineContent(paragraph.segments, maths);
    // Typst >= 0.13: inline content alone in a block is not a paragraph and
    // ignores hanging-indent; par() makes every paragraph a real one.
    return node.single ? `box(${body})` : `par[${indent}#${body}]`;
  });
  return `{ ${settings.join("; ")}; ${paragraphs.join(node.single ? "; " : "; parbreak(); ")} }`;
}

// ---------------------------------------------------------------------------
// Measurement document: for every (node, paragraph, size) emit the paragraph
// height at leading 0 and at leading 1pt (their difference is the line count
// minus one), plus the natural width for single-line nodes. One `typst eval`
// call returns everything.

function measureDocument(jobs, maths) {
  const lines = [
    `#set page(width: 2000pt, height: auto, margin: 0pt)`,
    `#set text(font: "${FONT_FAMILY}", top-edge: "ascender", bottom-edge: "descender", lang: "zh")`,
    PREAMBLE,
    `#let rpr-probe(id, para, size, width, single, body) = context {`,
    `  let h0 = measure(block(width: width, { set text(size: size); set par(leading: 0pt); body })).height`,
    `  let h1 = if single { h0 } else { measure(block(width: width, { set text(size: size); set par(leading: 1pt); body })).height }`,
    `  let natural = if single { measure({ set text(size: size); box(body) }).width } else { 0pt }`,
    `  [#metadata((id: id, para: para, size: size.pt(), h0: h0.pt(), h1: h1.pt(), natural: natural.pt())) <rpr-measure>]`,
    `}`
  ];
  for (const job of jobs) {
    const { node, sizes } = job;
    const width = node.contentBox[2] - node.contentBox[0];
    node.paragraphs.forEach((paragraph, index) => {
      const indent = !node.hangingIndent && paragraph.indent > 0 ? `#h(${fmt(paragraph.indent)}pt)` : "";
      const justify = node.align === "justify";
      const body = `{ set par(justify: ${justify}, linebreaks: ${LINEBREAKS}${node.hangingIndent ? ", hanging-indent: 1.1em" : ""}); par[${indent}#${inlineContent(paragraph.segments, maths)}] }`;
      lines.push(`#let rpr-body = ${body}`);
      for (const size of sizes) {
        lines.push(`#rpr-probe(${typstString(node.uid)}, ${index}, ${fmt(size)}pt, ${fmt(width)}pt, ${Boolean(node.single)}, rpr-body)`);
      }
    });
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Output document.

// autoHeight: no fixed frame height. Needed for explicit line stacks: Typst
// squeezes the children of a `stack` that exceeds a fixed-height region
// (the last lines pile up at the frame's bottom edge), whereas text is meant
// to overflow into the free space below its source frame.
function placed(node, inner, extra = "", { autoHeight = false } = {}) {
  const [x0, y0, x1, y1] = node.contentBox;
  const height = autoHeight ? "" : `, height: ${fmt(y1 - y0)}pt`;
  return `#place(top + left, dx: ${fmt(x0)}pt, dy: ${fmt(y0)}pt, block(width: ${fmt(x1 - x0)}pt${height}${extra}, ${inner}))`;
}

function formulaBlock(node, maths) {
  const [x0, y0, x1, y1] = node.bbox;
  const width = x1 - x0;
  const height = y1 - y0;
  const entry = maths.get(node.tex, true);
  const numberSize = Math.min(node.fontSize, 11);
  const numberSpace = node.number ? numberSize * 2.6 : 0;
  if (!entry.ok) {
    return placed(node, `align(horizon, rpr-tex-fallback(${typstString(node.tex)}))`);
  }
  // Same rule as fit.js fitLayoutFormulas({ expand: true }): grow toward 92%
  // of the frame height (at most 1.35x), never wider than the frame.
  const base = node.fontSize;
  const naturalW = entry.widthEm * base;
  const naturalH = entry.heightEm * base;
  const scaleW = Math.max(0.05, (width - 4 - numberSpace) / Math.max(1, naturalW));
  const scaleH = height * 0.92 / Math.max(1, naturalH);
  const scale = Math.min(scaleW, Math.max(0.7, scaleH), 1.35);
  const em = base * scale;
  const tex = `$$${node.tex}$$`;
  const formula = `rpr-math(${typstString(entry.file)}, ${fmt(entry.widthEm * em)}pt, ${fmt(entry.heightEm * em)}pt, ${fmt(entry.depthEm * em)}pt, ${typstString(tex)})`;
  const parts = [`align(center + horizon, ${formula})`];
  if (node.number) {
    const right = node.numberRight != null ? node.numberRight - x0 : width;
    parts.push(`place(top + left, dx: ${fmt(right)}pt - 4em, dy: 0pt, block(width: 4em, height: ${fmt(height)}pt, align(right + horizon, text(size: ${fmt(numberSize)}pt, ${typstString(`(${node.number})`)}))))`);
  }
  node.formulaScale = scale;
  return placed(node, `{ ${parts.join("; ")} }`);
}

function tableBlock(node, maths, size) {
  const columns = Math.max(...node.rows.map(row => row.length));
  const cells = node.rows.flatMap(row => {
    const padded = [...row, ...Array(columns - row.length).fill([])];
    return padded.map(cell => inlineContent(cell, maths));
  });
  return placed(node, `{ set text(size: ${fmt(size)}pt); table(columns: ${columns}, stroke: 0.4pt, inset: 2pt, ${cells.join(", ")}) }`);
}

// Code keeps its newlines, unlike prose strings.
function typstCodeString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\r?\n/g, "\\n")}"`;
}

function codeBlock(node, size) {
  return placed(node, `{ set text(size: ${fmt(size)}pt); raw(block: true, ${typstCodeString(node.code)}) }`);
}

// options.paragraphStack(node, maths, style): alternative text emission
// (experiments/measure/emit-lines.js emits the JS-measured lines explicitly).
function outputDocument(pages, nodesByPage, styles, maths, options = {}) {
  const stackOf = options.paragraphStack || paragraphStack;
  const lines = [
    `#set text(font: "${FONT_FAMILY}", top-edge: "ascender", bottom-edge: "descender", lang: "zh", fill: rgb("#111111"))`,
    PREAMBLE
  ];
  pages.forEach((page, index) => {
    lines.push(`#page(width: ${fmt(page.width)}pt, height: ${fmt(page.height)}pt, margin: 0pt)[`);
    for (const node of nodesByPage[index]) {
      if (node.render === "image") {
        lines.push(placed(node, `rect(width: 100%, height: 100%, fill: luma(232), stroke: 0.4pt + luma(180))`));
        continue;
      }
      if (node.render === "formula") { lines.push(formulaBlock(node, maths)); continue; }
      const style = styles.get(node.uid);
      if (node.render === "table") { lines.push(tableBlock(node, maths, style?.size || 7)); continue; }
      if (node.render === "code") { lines.push(codeBlock(node, style?.size || 7)); continue; }
      if (!style || !node.paragraphs?.length) continue;
      const halfLeading = Math.max(0, (style.lineRatio - 1) * style.size / 2);
      const stack = node.single ? paragraphStack(node, maths, style) : stackOf(node, maths, style);
      const aligned = node.align === "center" ? `align(center, ${stack})` : stack;
      const explicit = Boolean(options.paragraphStack) && !node.single;
      lines.push(placed(node, `block(inset: (top: ${fmt(halfLeading)}pt), ${aligned})`, ", clip: false", { autoHeight: explicit }));
    }
    lines.push("]");
  });
  return lines.join("\n") + "\n";
}

module.exports = { PREAMBLE, MathStore, measureDocument, outputDocument, paragraphStack, FONT_FAMILY };
