"use strict";

// Pure-JS paragraph layout that reproduces Typst's `linebreaks: "simple"`
// for the text the layout pipeline emits, so the fitter can measure without
// running Typst.
//
// Mirrored Typst behaviour (crates/typst-layout/src/inline):
//   shaping.rs  add_cjk_latin_spacing  — +1/4 em between a Han/kana glyph and an
//                                        adjacent Latin/Greek/Cyrillic letter or digit
//               calculate_adjustability — consecutive CJK punctuation shares half
//                                        a glyph width (GB style for lang "zh")
//   line.rs     adjust_cj_at_line_boundaries — opening punctuation at a line
//                                        start / closing at a line end lose their
//                                        blank half; CJK–Latin spacing at a line
//                                        boundary is removed
//               trailing whitespace does not count toward the line width
//   linebreak.rs linebreak_simple       — greedy: keep the last attempt that fit
//               hanging indent           — lines after the first get region - hang
// Break opportunities (linebreak.rs breakpoints): UAX #14 from the `linebreak`
// package (older UAX #14 tables), adjusted to what Typst's ICU segmenter does
// (all verified against Typst by compare-typst.js):
//   - inline boxes (U+FFFC, class CB) allow a break on both sides (LB20); the
//     package resolves CB to a letter class, so boxes are analysed as an ideograph
//   - a Latin letter/digit may break before an East Asian opening bracket
//     (current LB30 only blocks non-East-Asian OP; the package blocks all)
//   - double quotes “ ” behave like brackets (break before “, also after
//     Latin punctuation; break after ”), except that ” never breaks before a
//     non-East-Asian character such as a Latin word; single quotes ‘ ’ keep
//     the strict quotation rule (never break next to them, even between Han
//     characters)
// Added on top:
//   - Typst's link special case: after "://" (or at "www.") the URL is broken
//     at letter/digit/other transitions (linebreak_link) and UAX #14
//     opportunities inside it are dropped
//   - a first-line or hanging indent is a spacing item that Typst puts into
//     the paragraph text as a space: it adds a break opportunity right after
//     the indent, and the first line no longer "starts with" punctuation, so
//     no line-start adjustment applies to it
//
// Everything that does not depend on the font size is computed once per
// paragraph (prepare); a layout at one size/width is a single greedy pass.

const LineBreaker = require("linebreak");

const OBJECT = "\uFFFC";        // an inline box (formula), like Typst's OBJ_REPLACE
const LINE_SEPARATOR = "\u2028"; // forced break (emitter: linebreak())

const BEGIN_PUNCT = new Set("“‘《〈（『「【〖〔［｛");
const END_PUNCT = new Set("”’，．。、：；》〉）』」】〗〕］｝？！");
const LEFT_ALIGNED = new Set("，。．、：；》）』」】〗〕〉］｝？！”’"); // GB style
const RIGHT_ALIGNED = new Set("《（『「【〖〔〈［｛“‘");
const CENTER_ALIGNED = new Set("・·");

const CJ_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const LETTER_OR_NUMBER = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Nd}#$%&]/u;

const EPS = 1e-4; // Typst Abs::fits tolerance (pt)

// East_Asian_Width F/W/H (plus inline boxes, which ICU treats like CB).
const EAST_ASIAN_OR_BOX = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\uFFFC\uD840-\uD87F]/;
const EA_OPEN = new Set("（【《「『〔〖〈［｛“");
const LETTER_OR_DIGIT_BEFORE_OP = /[A-Za-z0-9\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;

// Typst link_prefix(): the longest URL-looking prefix, minus trailing
// sentence punctuation.
function linkPrefix(text) {
  let end = 0;
  const brackets = [];
  for (const c of text) {
    let ok = /[0-9a-zA-Z!#$%&*+,\-./:;=?@_~']/.test(c);
    if (c === "[" || c === "(") { brackets.push(c); ok = true; }
    else if (c === "]") ok = brackets.pop() === "[";
    else if (c === ")") ok = brackets.pop() === "(";
    if (!ok) break;
    end += c.length;
  }
  while (end > 0 && /[!,.:;?']/.test(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

// Typst linebreak_link(): offsets (relative to the link) where it may break.
function linkBreaks(link) {
  const classOf = c => /\p{Alphabetic}/u.test(c) ? 1 : /\p{N}/u.test(c) ? 2 : (c === "(" || c === "[") ? 3 : 0;
  const out = [];
  let offset = 0;
  let previous = 0;
  let end = 0;
  for (const c of link) {
    const cls = classOf(c);
    if (end > 0 && previous !== 3 && (cls === 0 ? previous === 0 : cls !== previous)) {
      const piece = link.slice(offset, end);
      if (piece.length < 16) { offset = end; out.push(offset); }
      else for (const ch of piece) { offset += ch.length; out.push(offset); }
    }
    previous = cls;
    end += c.length;
  }
  return out;
}

// `lead`: the paragraph starts with an indent spacing item (Typst text " ").
function breakOpportunities(text, lead) {
  const n = text.length;
  const uax = [];
  const shift = lead ? 1 : 0;
  const analysed = text.replace(/[“”\uFFFC]/g, c => (c === "“" ? "（" : c === "”" ? "）" : "中"));
  const breaker = new LineBreaker((lead ? " " : "") + analysed);
  for (let bk; (bk = breaker.nextBreak());) {
    const position = bk.position - shift;
    if (position > 0 || (lead && position === 0)) uax.push({ position, mandatory: Boolean(bk.required) });
  }
  // ” followed by a non-East-Asian character (a Latin word): no break.
  for (let i = uax.length - 1; i >= 0; i--) {
    const k = uax[i].position;
    if (uax[i].mandatory || k <= 0 || k >= n) continue;
    const before = text[k - 1];
    const after = text[k];
    // A break after a space (LB18) precedes LB19a and always stays.
    if (isSpace(before)) continue;
    if (before === "”" && !EAST_ASIAN_OR_BOX.test(after)) uax.splice(i, 1);
  }
  // Current LB30: (AL | HL | NU) × OP applies only to non-East-Asian OP.
  const known = new Set(uax.map(b => b.position));
  for (let k = 1; k < n; k++) {
    if (!known.has(k) && EA_OPEN.has(text[k]) && LETTER_OR_DIGIT_BEFORE_OP.test(text[k - 1])) uax.push({ position: k, mandatory: false });
  }
  uax.sort((a, b) => a.position - b.position);

  // Typst's breakpoints() loop with the link special case.
  const out = [];
  let last = 0;
  let index = 0;
  while (true) {
    const head = text.slice(0, last);
    const tail = text.slice(last);
    if (head.endsWith("://") || tail.startsWith("www.")) {
      const link = linkPrefix(tail);
      for (const offset of linkBreaks(link)) out.push({ position: last + offset, mandatory: false });
      const end = last + link.length;
      while (index < uax.length && uax[index].position < end) index += 1;
    }
    if (index >= uax.length) break;
    const point = uax[index++];
    out.push({ position: point.position, mandatory: point.mandatory || point.position === n });
    last = point.position;
  }
  // Link breaks can coincide with UAX #14 ones; keep order, drop duplicates.
  const seen = new Set();
  return out.filter(b => (b.position > 0 || (lead && b.position === 0)) && !seen.has(b.position) && seen.add(b.position));
}

function isSpace(c) {
  return c === " " || c === "\t" || c === " " || c === "　";
}

// segments: [{ type: "text", value } | { type: "math", widthEm, heightEm, depthEm, ok }]
// options: { indentPt = 0, hangingIndentEm = 0 }
function prepare(segments, metrics, options = {}) {
  let text = "";
  const boxes = new Map(); // unit index -> { widthEm, heightEm, depthEm }
  for (const segment of segments) {
    if (segment.type === "math") {
      boxes.set(text.length, segment);
      text += OBJECT;
    }
    else text += segment.value;
  }
  const n = text.length;
  const adv = new Float64Array(n);
  const shrinkL = new Float64Array(n);
  const shrinkR = new Float64Array(n);
  const spaceL = new Float64Array(n); // CJK–Latin spacing on the left (x_offset)
  const spaceR = new Float64Array(n); // CJK–Latin spacing on the right
  const kernR = new Float64Array(n);  // pair delta toward the following glyph
  const glyph = new Uint8Array(n);    // 1 where a glyph starts
  const cj = new Uint8Array(n);
  const punct = new Uint8Array(n);    // 1 left-, 2 right-, 3 center-aligned CJK punctuation

  // Shape text runs (split at boxes and forced breaks, like Typst items).
  let runStart = 0;
  const flushRun = end => {
    if (end > runStart) {
      const run = text.slice(runStart, end);
      const kern = new Float64Array(run.length);
      const shaped = metrics.shape(run, undefined, undefined, kern);
      for (let i = 0; i < shaped.length; i++) { adv[runStart + i] = shaped[i]; kernR[runStart + i] = kern[i]; }
      shapeRunAdjustments(runStart, end);
    }
  };
  const shapeRunAdjustments = (start, end) => {
    const glyphs = [];
    for (let i = start; i < end;) {
      const cp = text.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      const width = cp > 0xffff ? 2 : 1;
      const continuation = i > start && adv[i] === 0 && !isSpace(ch); // ligature tail
      if (!continuation) {
        glyph[i] = 1;
        glyphs.push(i);
        cj[i] = CJ_SCRIPT.test(ch) ? 1 : 0;
        if (LEFT_ALIGNED.has(ch)) { punct[i] = 1; shrinkR[i] = adv[i] / 2; }
        else if (RIGHT_ALIGNED.has(ch)) { punct[i] = 2; shrinkL[i] = adv[i] / 2; }
        else if (CENTER_ALIGNED.has(ch)) { punct[i] = 3; shrinkL[i] = shrinkR[i] = adv[i] / 4; }
      }
      i += width;
    }
    // CJK–Latin spacing.
    const letter = index => LETTER_OR_NUMBER.test(String.fromCodePoint(text.codePointAt(index)));
    for (let k = 0; k < glyphs.length; k++) {
      const i = glyphs[k];
      if (!cj[i]) continue;
      if (k + 1 < glyphs.length && letter(glyphs[k + 1])) { adv[i] += 0.25; spaceR[i] = 0.25; }
      if (k > 0 && letter(glyphs[k - 1])) { adv[i] += 0.25; spaceL[i] = 0.25; }
    }
    // Consecutive CJK punctuation compression.
    for (let k = 0; k + 1 < glyphs.length; k++) {
      const i = glyphs[k];
      const j = glyphs[k + 1];
      if (!punct[i] || !punct[j]) continue;
      const delta = adv[i] / 2;
      if (shrinkR[i] + shrinkL[j] >= delta) {
        const left = Math.min(shrinkR[i], delta);
        adv[i] -= left; shrinkR[i] -= left;
        adv[j] -= delta - left; shrinkL[j] -= delta - left;
      }
    }
  };
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (c === OBJECT || c === LINE_SEPARATOR) {
      flushRun(i);
      if (c === OBJECT) { adv[i] = boxes.get(i).widthEm; glyph[i] = 1; }
      runStart = i + 1;
    }
  }
  flushRun(n);

  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + adv[i];

  const lead = Number(options.indentPt) > 0 || Number(options.hangingIndentEm) > 0;
  const breaks = breakOpportunities(text, lead);
  if (!breaks.length || breaks[breaks.length - 1].position !== n) breaks.push({ position: n, mandatory: true });

  return {
    text, n, adv, prefix, shrinkL, shrinkR, spaceL, spaceR, kernR, glyph, cj, punct, boxes, breaks,
    lead,
    indentPt: Number(options.indentPt) || 0,
    hangingIndentEm: Number(options.hangingIndentEm) || 0,
    hasText: [...text].some(c => c !== OBJECT && c !== LINE_SEPARATOR && !isSpace(c))
  };
}

// Typst Breakpoint::trim: a normal break trims trailing whitespace; a
// mandatory one (paragraph end, linebreak()) trims only the separator, so
// trailing spaces before it still take width.
function trimmedEnd(p, start, end, mandatory = false) {
  let e = end;
  while (e > start && (p.text[e - 1] === LINE_SEPARATOR || p.text[e - 1] === "\n")) e -= 1;
  if (!mandatory) while (e > start && isSpace(p.text[e - 1])) e -= 1;
  return e;
}

function lastGlyph(p, start, end) {
  for (let i = end - 1; i >= start; i--) if (p.glyph[i]) return i;
  return -1;
}

// Natural width (em) of text[start, end) as one Typst line.
function lineWidthEm(p, start, end, mandatory = false) {
  const e = trimmedEnd(p, start, end, mandatory);
  if (e <= start) return 0;
  let width = p.prefix[e] - p.prefix[start];
  const first = p.text[start];
  if (!(p.lead && start === 0) && (BEGIN_PUNCT.has(first) || p.cj[start])) {
    if (p.punct[start] === 2) width -= p.shrinkL[start];
    else if (p.cj[start] && p.spaceL[start] > 0) width -= p.spaceL[start];
  }
  // The run is reshaped at the break: no pair delta toward the next line.
  if (e < p.n) {
    const g = lastGlyph(p, start, e);
    if (g >= 0) width -= p.kernR[g];
  }
  return width - lineEndAdjustEm(p, start, e);
}

// adjust_cj_at_line_end: closing CJK punctuation at the (trimmed) line end
// loses its blank half; trailing CJK–Latin spacing is removed. Typst tests
// the line text after trailing whitespace is trimmed.
function lineEndAdjustEm(p, start, e) {
  if (e <= start) return 0;
  const lastChar = String.fromCodePoint(p.text.codePointAt(e - 1 - (e >= 2 && /[\uDC00-\uDFFF]/.test(p.text[e - 1]) ? 1 : 0)));
  if (!END_PUNCT.has(lastChar) && !CJ_SCRIPT.test(lastChar)) return 0;
  const g = lastGlyph(p, start, e);
  if (g < 0) return 0;
  if (p.punct[g] === 1) return p.shrinkR[g];
  if (p.cj[g] && p.spaceR[g] > 0) return p.spaceR[g];
  return 0;
}

// Greedy layout at `sizePt` in a region `widthPt` wide.
// Returns { lines: [{ start, end, widthPt }], heightPt (leading 0), naturalPt }.
function layout(p, sizePt, widthPt, { asc = 0.88, desc = 0.12 } = {}) {
  const lines = [];
  const indent = p.indentPt;
  const hang = p.hangingIndentEm * sizePt;
  const lineWidth = (start, end, first, mandatory) => lineWidthEm(p, start, end, mandatory) * sizePt + (first ? indent : 0);
  const available = first => first ? widthPt : widthPt - hang;
  let start = 0;
  let last = null; // { end, width }
  for (const bk of p.breaks) {
    const first = lines.length === 0;
    let width = lineWidth(start, bk.position, first, bk.mandatory);
    if (width > available(first) + EPS && last) {
      lines.push({ start, end: last.end, widthPt: last.width });
      start = last.end;
      last = null;
      width = lineWidth(start, bk.position, lines.length === 0, bk.mandatory);
    }
    if (bk.mandatory || width > available(lines.length === 0) + EPS) {
      lines.push({ start, end: bk.position, widthPt: width });
      start = bk.position;
      last = null;
    }
    else last = { end: bk.position, width };
  }
  if (last) lines.push({ start, end: last.end, widthPt: last.width });

  let heightPt = 0;
  for (const line of lines) {
    let top = 0;
    let bottom = 0;
    let text = false;
    for (let i = line.start; i < line.end; i++) {
      const box = p.boxes.get(i);
      if (box) {
        top = Math.max(top, (box.heightEm - box.depthEm) * sizePt);
        bottom = Math.max(bottom, box.depthEm * sizePt);
      }
      else if (!isSpace(p.text[i]) && p.text[i] !== LINE_SEPARATOR) text = true;
    }
    if (text || !top) { top = Math.max(top, asc * sizePt); bottom = Math.max(bottom, desc * sizePt); }
    line.topPt = top;
    line.bottomPt = bottom;
    heightPt += top + bottom;
  }
  return { lines, heightPt };
}

// Width of the whole paragraph laid out unwrapped (Typst `box(body)`).
function naturalWidthPt(p, sizePt) {
  let max = 0;
  let start = 0;
  for (const bk of p.breaks) {
    if (!bk.mandatory) continue;
    max = Math.max(max, lineWidthEm(p, start, bk.position, true) * sizePt + (start === 0 ? p.indentPt : 0));
    start = bk.position;
  }
  return max;
}

module.exports = { prepare, layout, naturalWidthPt, lineWidthEm, lineEndAdjustEm, OBJECT, LINE_SEPARATOR };
