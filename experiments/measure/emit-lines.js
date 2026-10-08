"use strict";

// Output with the JS line breaks: every line is emitted as its own
// single-line paragraph, so Typst cannot break differently from the
// measurement. Lines are stacked with the paragraph leading, paragraphs with
// the paragraph spacing — the same vertical rhythm as one Typst paragraph.
//
// A forced justified break (linebreak(justify: true)) changes two Typst rules
// for the line before it: closing CJK punctuation at its end keeps its blank
// half, and CJK–Latin spacing at its end stays. The measured width excludes
// both, so such a line gets exactly that much extra room; justified to it,
// every glyph lands where Typst's own layout would put it (the blank half
// simply extends past the column edge, as it does in Typst).

const { typstString } = require("../typst/content");
const { lineEndAdjustEm, OBJECT, LINE_SEPARATOR } = require("../../src/text/linebreak");
const { loadMeasurer } = require("./measurer");

let measurer = null;

function fmt(value) {
  return Number(value).toFixed(3).replace(/\.?0+$/, "") || "0";
}

function isSpace(c) {
  return c === " " || c === "\t" || c === " " || c === "　";
}

// Typst content for units [start, end) of a prepared paragraph.
function lineContent(prepared, start, end, maths) {
  const pieces = [];
  let text = "";
  const flush = () => { if (text) pieces.push(typstString(text)); text = ""; };
  for (let i = start; i < end; i++) {
    const c = prepared.text[i];
    if (c === LINE_SEPARATOR) continue;
    if (c !== OBJECT) { text += c; continue; }
    flush();
    const segment = prepared.boxes.get(i).run;
    const entry = maths.get(segment.value, false);
    const tex = `$${segment.value}$`;
    pieces.push(entry.ok
      ? `rpr-math(${typstString(entry.file)}, ${fmt(entry.widthEm)}em, ${fmt(entry.heightEm)}em, ${fmt(entry.depthEm)}em, ${typstString(tex)})`
      : `rpr-tex-fallback(${typstString(tex)})`);
  }
  flush();
  return pieces.length ? `[#${pieces.join("#")}]` : "[]";
}

// Extra room (em) a line needs when it ends in a forced justified break:
// the line-end adjustment Typst no longer applies there.
function forcedBreakExtraEm(prepared, start, end) {
  let e = end;
  while (e > start && (isSpace(prepared.text[e - 1]) || prepared.text[e - 1] === LINE_SEPARATOR)) e -= 1;
  return lineEndAdjustEm(prepared, start, e);
}

function explicitParagraphStack(node, maths, style) {
  const { size, lineRatio, gap = 0 } = style;
  const leading = Math.max(0, (lineRatio - 1) * size);
  const spacing = leading + Math.max(0, gap) * size;
  const width = node.contentBox[2] - node.contentBox[0];
  const justify = node.align === "justify";
  const hang = node.hangingIndent ? 1.1 * size : 0;
  measurer = measurer || loadMeasurer();
  const paragraphs = node.prepared.map(({ prepared, options }) => {
    const { lines } = measurer.layout(prepared, { ...options, fontSize: size, width });
    const indentPt = Number(options.firstLineIndent) || 0;
    const blocks = lines.map((line, index) => {
      const last = index === lines.length - 1;
      const forced = line.forced;
      let end = line.end;
      if (!forced) while (end > line.start && isSpace(prepared.text[end - 1])) end -= 1;
      const indent = index === 0 && indentPt > 0 ? `#h(${fmt(indentPt)}pt)` : "";
      const body = lineContent(prepared, line.start, end, maths);
      const lineWidth = index === 0 ? width : width - hang;
      // Justify every line that Typst would justify: not the last one, not
      // one ending in a forced (non-justified) break.
      const justified = justify && !last && !forced;
      const extra = justified ? Math.max(0, forcedBreakExtraEm(prepared, line.start, line.end)) * size : 0;
      const content = justified
        ? `{ set par(justify: true); [${indent}#${body}#linebreak(justify: true)] }`
        : `[${indent}#${body}]`;
      const blockWidth = node.align === "center" ? "auto" : `${fmt(lineWidth + extra)}pt`;
      const block = `block(width: ${blockWidth}, ${content})`;
      return index > 0 && hang ? `pad(left: ${fmt(hang)}pt, ${block})` : block;
    });
    return `stack(spacing: ${fmt(leading)}pt, ${blocks.join(", ")})`;
  });
  // Text may grow past its fixed-height frame into free space below (fitter
  // rule). A breakable stack would be split into a "next region" that Typst
  // draws over the first one; an unbreakable block just overflows like a
  // paragraph does.
  const stack = `block(breakable: false, stack(spacing: ${fmt(spacing)}pt, ${paragraphs.join(", ")}))`;
  return `{ set text(size: ${fmt(size)}pt); set par(linebreaks: "simple"); ${node.align === "center" ? `align(center, ${stack})` : stack} }`;
}

module.exports = { explicitParagraphStack, lineContent };
