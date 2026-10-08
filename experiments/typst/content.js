"use strict";

// Layout model page -> flat list of positioned text nodes for the Typst
// experiment. Mirrors the content decisions of src/render.js (which text a
// stream/block shows in source vs translation mode, paragraph/part joining)
// without any DOM.

const { splitTeXEquationTag } = require("../../src/render.js");

const STREAM_PADDING_LEFT = 2;   // .layout-flow-stream { padding: 0 4px 0 2px }
const STREAM_PADDING_RIGHT = 4;

function decodeEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

// Source parts carry MinerU line breaks; join them the way the browser flows
// them (hyphenated line ends glue, other breaks become spaces).
function joinSourceLines(text) {
  return String(text || "")
    .replace(/([A-Za-z])-\n(?=[a-z])/g, "$1")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

// Split text into [{ type: "text"|"math", value, display }]. Recognises
// \( \), \[ \], $$ $$ and $ $ delimiters and the golden fixtures' stubbed
// <tex data-display="..">..</tex> markup.
function splitMath(input) {
  const text = String(input || "");
  const pattern = /<tex data-display="([01])">([\s\S]*?)<\/tex>|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$|(?<![\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$/g;
  const segments = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) segments.push({ type: "text", value: text.slice(last, match.index) });
    if (match[2] !== undefined) segments.push({ type: "math", value: decodeEntities(match[2]), display: match[1] === "1" });
    else if (match[3] !== undefined) segments.push({ type: "math", value: match[3], display: false });
    else if (match[4] !== undefined) segments.push({ type: "math", value: match[4], display: true });
    else if (match[5] !== undefined) segments.push({ type: "math", value: match[5], display: true });
    else segments.push({ type: "math", value: match[6], display: false });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ type: "text", value: text.slice(last) });
  return segments
    .map(segment => segment.type === "text"
      ? { ...segment, value: decodeEntities(segment.value.replace(/<[^>]+>/g, "")) }
      : segment)
    .filter(segment => segment.type === "math" || segment.value);
}

// Forced line break inside a paragraph (symbol glossaries, <br> in source HTML).
const LINE_BREAK = "\u2028";

// Same precedence as render.js layoutPartHTML(): translation text, else the
// source HTML (which keeps <br> row breaks), else the plain source text.
function partText(part, mode) {
  const translated = String(part?.translatedText || "");
  if (mode === "translation" && translated) return translated.replace(/\s*\n\s*/g, " ");
  if (mode !== "translation" && part?.html) return String(part.html).replace(/\s*<br\s*\/?>\s*/gi, LINE_BREAK).replace(/\s*\n\s*/g, " ");
  return joinSourceLines(part?.text || "");
}

function streamParagraphs(stream, mode) {
  const paragraphs = (stream.items || []).flatMap(item =>
    Array.isArray(item.paragraphs) && item.paragraphs.length
      ? item.paragraphs
      : [{ parts: item.parts || [item], indent: item.indent || 0 }]);
  return paragraphs.map(paragraph => {
    const parts = Array.isArray(paragraph.parts) ? paragraph.parts : [];
    let text = "";
    parts.forEach((part, index) => {
      const previous = parts[index - 1];
      const separator = index && !/[-−–]\s*$/.test(String(previous?.text || "")) ? " " : "";
      text += separator + partText(part, mode);
    });
    return { indent: Number(paragraph.indent || 0), segments: splitMath(text) };
  }).filter(paragraph => paragraph.segments.length);
}

function streamNode(stream, page, mode) {
  const [x0, y0, x1, y1] = stream.bbox;
  const id = String(stream.items?.[0]?.id || stream.items?.[0]?.parts?.[0]?.id || "");
  const originalLines = (stream.items || []).reduce((sum, item) =>
    sum + Number(item.originalLineCount || item.parts?.reduce((s, p) => s + Number(p.originalLineCount || 0), 0) || 0), 0);
  const paragraphs = streamParagraphs(stream, mode);
  const multi = (stream.items || []).length > 1 || paragraphs.length > 1 || originalLines > 1;
  const symmetric = Math.abs(x0 - (page.width - x1)) / Math.max(1, x1 - x0) <= .07;
  const single = !multi && stream.debugRole === "text";
  const fromList = (stream.items || []).some(item => item.fromList || item.parts?.some(part => part.fromList));
  let group = "text";
  if (stream.refsOnly) group = "refs";
  else if (stream.styleKind === "body_text" && !stream.bodyInherited) group = "body";
  else if (stream.styleKind === "body_text") group = "body_inherited";
  else if (fromList) group = "list";
  return {
    key: `stream:${stream.styleKind || "text"}#${id}`,
    id,
    nodeKind: "stream",
    styleKind: stream.styleKind || "text",
    group,
    page: page.index,
    bbox: [x0, y0, x1, y1],
    contentBox: [x0 + STREAM_PADDING_LEFT, y0, x1 - STREAM_PADDING_RIGHT, y1],
    paragraphs,
    single,
    // layout.css: justify by default; refs, lists and debug-text are left.
    align: single && symmetric ? "center" : (stream.refsOnly || fromList || stream.debugRole === "text" ? "left" : "justify"),
    hangingIndent: Boolean(stream.refsOnly),
    fontSize: Math.max(4, Number(stream.fontSize || 7.6)),
    lineRatio: Math.max(1, Number(stream.lineHeight || 1.16)),
    paragraphGap: Number.isFinite(Number(stream.paragraphGap)) ? Number(stream.paragraphGap) : .16
  };
}

function tableRows(html) {
  const rows = [];
  for (const row of String(html || "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    rows.push([...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell =>
      splitMath(cell[1].replace(/([A-Za-z0-9])<sub>([\s\S]*?)<\/sub>/gi, "\\($1_{$2}\\)"))));
  }
  return rows.filter(row => row.length);
}

// OCR/JSON round trips can leave doubled backslashes and outer display
// delimiters (`\\[a=b\\]`); KaTeX/MathJax need the bare body.
function normalizeDisplayTeX(value) {
  let tex = String(value || "").trim();
  if (/^\\\\[\[(]/.test(tex)) tex = tex.replace(/\\\\(?=[A-Za-z\[\]()])/g, "\\");
  for (const [open, close] of [["$$", "$$"], ["\\[", "\\]"], ["\\(", "\\)"], ["$", "$"]]) {
    if (tex.startsWith(open) && tex.endsWith(close) && tex.length >= open.length + close.length) {
      tex = tex.slice(open.length, -close.length).trim();
    }
  }
  return tex;
}

function blockNode(block, page, mode) {
  const base = {
    key: `block:${block.type}#${block.id}`,
    id: String(block.id || ""),
    nodeKind: "block",
    type: block.type,
    page: page.index,
    bbox: block.bbox,
    contentBox: block.bbox,
    fontSize: Math.max(4, Number(block.fontSize || 8)),
    lineRatio: Math.max(1, Number(block.lineHeight || 1.12)),
    sourceOnly: Boolean(block.sourceOnly)
  };
  if (block.kind === "image") return { ...base, render: "image" };
  if (block.kind === "formula") {
    const tex = normalizeDisplayTeX(block.formulas?.[0] || block.text || "");
    const equation = splitTeXEquationTag(tex);
    return {
      ...base,
      render: "formula",
      tex: equation.body || tex,
      number: equation.number || "",
      numberRight: Number.isFinite(Number(block.numberRight)) ? Number(block.numberRight) : null
    };
  }
  if (block.kind === "table" && block.tableHTML) return { ...base, render: "table", rows: tableRows(block.tableHTML) };
  if (block.kind === "code") return { ...base, render: "code", code: String(block.text || "") };
  const translated = mode === "translation" ? String(block.translatedText || "") : "";
  const text = translated || joinSourceLines(block.text || "");
  let group = "text";
  if (block.type === "title") group = block.mainTitle ? "main_title" : "title";
  else if (/caption|footnote/.test(block.type || "")) group = `caption:${block.type}`;
  else if (block.sourceOnly) group = "furniture";
  return { ...base, render: "text", group, paragraphs: [{ indent: 0, segments: splitMath(text) }], align: "left" };
}

function pageNodes(page, mode) {
  const restoration = page.restoration || {};
  return [
    ...(restoration.streams || []).map(stream => streamNode(stream, page, mode)),
    ...(restoration.absoluteBlocks || []).map(block => blockNode(block, page, mode))
  ];
}

// Typst string literal: content emitted as #"..." is never parsed as markup.
function typstString(value) {
  return `"${String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\r?\n/g, " ")
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, "")}"`;
}

module.exports = { splitMath, pageNodes, typstString, joinSourceLines, LINE_BREAK };
