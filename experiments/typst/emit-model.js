"use strict";

// Typst output for src/fit-model.js results: every text line is placed at the
// baseline the model fitter computed (absolute page coordinates), so the PDF
// cannot drift from the fit. Justified lines are stretched by Typst to the
// line width the fitter measured (linebreak(justify: true)); the break points
// are ours, never Typst's.

const { typstString } = require("./content");
const { PREAMBLE, FONT_FAMILY } = require("./emit");

const OBJECT = "￼";
const LINE_SEPARATOR = " ";

function fmt(value) {
  return Number(value).toFixed(3).replace(/\.?0+$/, "") || "0";
}

function isSpace(c) {
  return c === " " || c === "\t" || c === " " || c === "　";
}

// The measurer's text for a paragraph: text runs as-is, a formula as one
// OBJECT unit, a forced break as LINE_SEPARATOR. Line start/end index it.
function flatten(runs) {
  let text = "";
  const boxes = new Map();
  for (const run of runs || []) {
    if (run.type === "break") text += LINE_SEPARATOR;
    else if (run.type === "math") { boxes.set(text.length, run); text += OBJECT; }
    else if (run.text) text += run.text;
  }
  return { text, boxes };
}

function mathCall(maths, tex, display, size) {
  const entry = maths.get(tex, display);
  const source = display ? `$$${tex}$$` : `$${tex}$`;
  if (!entry.ok) return `rpr-tex-fallback(${typstString(source)})`;
  return `rpr-math(${typstString(entry.file)}, ${fmt(entry.widthEm * size)}pt, ${fmt(entry.heightEm * size)}pt, ${fmt(entry.depthEm * size)}pt, ${typstString(source)})`;
}

function lineBody(flat, start, end, maths, size) {
  const pieces = [];
  let text = "";
  const flush = () => { if (text) pieces.push(typstString(text)); text = ""; };
  for (let i = start; i < end; i++) {
    const c = flat.text[i];
    if (c === LINE_SEPARATOR) continue;
    if (c !== OBJECT) { text += c; continue; }
    flush();
    pieces.push(mathCall(maths, flat.boxes.get(i).tex, false, size));
  }
  flush();
  return pieces.length ? `[#${pieces.join("#")}]` : "[]";
}

// One fitted line -> a placed, baseline-anchored block.
function emitLine(node, line, flat, maths) {
  const size = node.fontSize;
  let end = line.end;
  const forced = flat.text[end - 1] === LINE_SEPARATOR || end === flat.text.length;
  if (!forced) while (end > line.start && isSpace(flat.text[end - 1])) end -= 1;
  const body = lineBody(flat, line.start, end, maths, size);
  const content = line.justified
    ? `block(width: ${fmt(line.width)}pt, { set par(justify: true, linebreaks: "simple"); [#${body}#linebreak(justify: true)] })`
    : `box(${body})`;
  // With top-edge "baseline" text adds nothing above the baseline, but an
  // inline formula box still does: the placed frame's top is the tallest
  // box's top, so lift the frame by that much to keep the baseline exact.
  let boxAscent = 0;
  for (let i = line.start; i < end; i++) {
    const box = flat.boxes.get(i);
    // The raw-LaTeX fallback is text set with the same top-edge: it adds
    // nothing above the baseline; only formula SVG boxes do.
    if (box && maths.get(box.tex, false).ok) boxAscent = Math.max(boxAscent, (Number(box.heightEm) - Number(box.depthEm)) * size);
  }
  return `#place(top + left, dx: ${fmt(line.x)}pt, dy: ${fmt(line.baseline - boxAscent)}pt, { set text(size: ${fmt(size)}pt, top-edge: "baseline", bottom-edge: "baseline"); ${content} })`;
}

function emitTextNode(node, maths) {
  const out = [];
  const flats = (node.paragraphs || []).map(paragraph => flatten(paragraph.runs));
  for (const line of node.lines) {
    if (line.toc) continue;
    const flat = flats[line.paragraph];
    if (!flat || line.end <= line.start) continue;
    out.push(emitLine(node, line, flat, maths));
  }
  return out;
}

function emitToc(node, rows) {
  const out = [];
  const size = node.fontSize;
  const parsed = (rows || []).filter(row => !row?.gap);
  node.lines.forEach((line, index) => {
    const row = parsed[index];
    if (!row) return;
    const label = row.page ? `${row.number || ""} ${row.title || ""}` : String(row.text || "");
    out.push(`#place(top + left, dx: ${fmt(line.x)}pt, dy: ${fmt(line.baseline)}pt, { set text(size: ${fmt(size)}pt, top-edge: "baseline", bottom-edge: "baseline"); box(width: ${fmt(Math.max(1, line.width))}pt, clip: true, ${typstString(label)}) })`);
    if (row.page) {
      const right = node.bbox[2] - 4;
      out.push(`#place(top + left, dx: ${fmt(right - line.pageWidth)}pt, dy: ${fmt(line.baseline)}pt, { set text(size: ${fmt(size)}pt, top-edge: "baseline", bottom-edge: "baseline"); ${typstString(String(row.page))} })`);
    }
  });
  return out;
}

function emitFormula(node, maths) {
  const formula = node.formula;
  const rect = formula.rect;
  if (!rect) return [];
  const runs = formula.runs || [];
  const size = node.fontSize * formula.scale;
  const out = [];
  if (runs.length === 1 && runs[0].type === "math") {
    const call = mathCall(maths, runs[0].tex, true, size);
    out.push(`#place(top + left, dx: ${fmt(rect.left)}pt, dy: ${fmt(rect.top)}pt, box(width: ${fmt(rect.right - rect.left)}pt, height: ${fmt(rect.bottom - rect.top)}pt, align(center + horizon, ${call})))`);
  }
  else {
    const text = runs.map(run => run.text || run.tex || "").join("");
    out.push(`#place(top + left, dx: ${fmt(rect.left)}pt, dy: ${fmt(rect.top)}pt, box(width: ${fmt(rect.right - rect.left)}pt, height: ${fmt(rect.bottom - rect.top)}pt, align(center + horizon, text(size: ${fmt(size)}pt, ${typstString(text)}))))`);
  }
  if (formula.number && formula.numberRect) {
    const n = formula.numberRect;
    out.push(`#place(top + left, dx: ${fmt(n.left)}pt, dy: ${fmt(n.top)}pt, box(width: ${fmt(n.right - n.left)}pt, height: ${fmt(n.bottom - n.top)}pt, align(right + horizon, text(size: ${fmt(node.fontSize)}pt, ${typstString(formula.number)}))))`);
  }
  return out;
}

// fitted: fitDocument() result. prototypeNodes: content.js pageNodes() per
// page (same order as the fitted nodes) for tables, code and images.
function fittedDocument(fitted, prototypeNodes, maths, emitters) {
  const lines = [
    `#set text(font: "${FONT_FAMILY}", lang: "zh", fill: rgb("#111111"))`,
    PREAMBLE
  ];
  fitted.pages.forEach((page, pageIndex) => {
    lines.push(`#page(width: ${fmt(page.width)}pt, height: ${fmt(page.height)}pt, margin: 0pt)[`);
    const prototypes = prototypeNodes[pageIndex] || [];
    page.nodes.forEach((node, index) => {
      const prototype = prototypes[index];
      if (prototype && prototype.render === "image") {
        lines.push(emitters.placed(prototype, `rect(width: 100%, height: 100%, fill: luma(232), stroke: 0.4pt + luma(180))`));
        return;
      }
      if (prototype && prototype.render === "table") { lines.push(emitters.tableBlock(prototype, maths, node.fontSize)); return; }
      if (node.code) { lines.push(emitters.codeBlock(prototype, node.fontSize)); return; }
      if (node.formula) { lines.push(...emitFormula(node, maths)); return; }
      if (node.tocRows) { lines.push(...emitToc(node, node.tocRows)); return; }
      lines.push(...emitTextNode(node, maths));
    });
    lines.push("]");
  });
  return lines.join("\n") + "\n";
}

module.exports = { fittedDocument, flatten };
