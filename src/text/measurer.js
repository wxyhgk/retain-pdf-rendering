// retain-pdf-rendering/text/measurer
// Host-agnostic: never reference the host application or plugin globals here.
//
// Text measurement without a browser or Typst: paragraph layout from font
// metrics (text/metrics.js) and a Typst-compatible greedy line breaker
// (text/linebreak.js). Exposed as RetainPdfRendering.Text.
//
//   const measurer = Text.createMeasurer({ metrics });  // metrics: Text.createMetrics(table) or the table itself
//   const prepared = measurer.prepare(content);           // once per paragraph
//   measurer.layout(prepared, { fontSize, lineHeight, width, ... });
//   measurer.fitFontSize(prepared, { width, maxHeight, lineHeight, minFont, maxFont, step });
//
// content: array of runs
//   { type: "text", text }
//   { type: "math", tex, display, widthEm, heightEm, depthEm }  atomic inline box, em of the run font
//   { type: "break" }                                           forced line break
//
// Units: fontSize, widths, indents and every returned length are in the
// layout model's units (CSS px of the source page == Typst pt).
//
// Vertical model (what the Typst output emits): a text line extends
// `ascender` above and `descender` below its baseline (top-edge "ascender",
// bottom-edge "descender": 1 em for Source Han Serif), an inline formula box
// can make a line taller, and consecutive lines are separated by Typst's
// `par(leading)`. A CSS-style line-height ratio maps to
//     leading = max(0, (lineHeight - 1) * fontSize)
// so a paragraph of n plain lines is n * fontSize + (n - 1) * leading tall —
// one leading shorter than CSS, which also puts half a leading above the
// first and below the last line. `height` is the Typst block height.
(function (root, factory) {
  "use strict";
  const isNode = typeof module === "object" && module && module.exports;
  const namespace = isNode ? null : (root.RetainPdfRendering || {});
  const metrics = isNode ? require("./metrics") : namespace.TextMetrics;
  const linebreak = isNode ? require("./linebreak") : namespace.TextLinebreak;
  const api = factory(metrics, linebreak);
  if (isNode) module.exports = api;
  else {
    const target = root.RetainPdfRendering = root.RetainPdfRendering || {};
    target.Text = api;
  }
})(typeof this === "object" && this ? this : globalThis, function (Metrics, Linebreak) {
  "use strict";

  if (!Metrics || !Linebreak) {
    throw new Error("retain-pdf-rendering/text/measurer: load text/uax14-data.js, text/metrics.js and text/linebreak.js first");
  }

  const { LINE_SEPARATOR, isSpace } = Linebreak;
  const FIT_EPSILON = 1e-6;

  // A formula the host could not render is set as its raw LaTeX in one
  // unbreakable box (the reference Typst emitter uses DejaVu Sans Mono at
  // 0.8 em: 0.602 em advance, ascender 0.928, descender 0.236).
  function fallbackMathBox(tex) {
    const characters = [...String(tex || "")].length;
    return { widthEm: 0.602 * 0.8 * characters, heightEm: 0.8 * (0.928 + 0.236), depthEm: 0.8 * 0.236, fallback: true };
  }

  function toSegments(content) {
    const segments = [];
    for (const run of Array.isArray(content) ? content : []) {
      if (!run || typeof run !== "object") continue;
      if (run.type === "break") segments.push({ type: "text", value: LINE_SEPARATOR });
      else if (run.type === "math") {
        const box = [run.widthEm, run.heightEm, run.depthEm].every(Number.isFinite) ? run : { ...run, ...fallbackMathBox(run.tex) };
        segments.push({ type: "math", run, widthEm: Number(box.widthEm), heightEm: Number(box.heightEm), depthEm: Number(box.depthEm) });
      }
      else {
        const text = String(run.text ?? "").replace(/\r\n?|\n/g, LINE_SEPARATOR);
        if (text) segments.push({ type: "text", value: text });
      }
    }
    return segments;
  }

  function stepLadder(minFont, maxFont, step) {
    const values = [];
    const count = Math.floor((maxFont - minFont) / step + 1e-9);
    for (let k = 0; k <= count; k++) values.push(Math.round((minFont + k * step) * 1e6) / 1e6);
    return values;
  }

  function createMeasurer(options = {}) {
    const fontMetrics = options.metrics instanceof Metrics.FontMetrics
      ? options.metrics
      : Metrics.createMetrics(options.metrics);

    function prepare(content) {
      const prepared = Linebreak.prepare(toSegments(content), fontMetrics);
      prepared.content = content;
      return prepared;
    }

    function resolveIndents(layoutOptions, fontSize) {
      const first = Number(layoutOptions.firstLineIndent) || 0;
      const hang = Number(layoutOptions.hangingIndent) || 0;
      return {
        indent: first + (Number(layoutOptions.firstLineIndentEm) || 0) * fontSize,
        hang: hang + (Number(layoutOptions.hangingIndentEm) || 0) * fontSize
      };
    }

    function layout(prepared, layoutOptions = {}) {
      const fontSize = Number(layoutOptions.fontSize);
      const width = Number(layoutOptions.width);
      if (!(fontSize > 0) || !Number.isFinite(width)) throw new RangeError("layout needs a positive fontSize and a finite width");
      const lineHeight = Number.isFinite(Number(layoutOptions.lineHeight)) ? Number(layoutOptions.lineHeight) : 1;
      const align = layoutOptions.align || "justify";
      const { indent, hang } = resolveIndents(layoutOptions, fontSize);
      const core = Linebreak.layout(prepared, fontSize, width, { indent, hang });
      const leading = Math.max(0, (lineHeight - 1) * fontSize);
      const lines = [];
      let y = 0;
      let maxLineWidth = 0;
      core.lines.forEach((line, index) => {
        const first = index === 0;
        const last = index === core.lines.length - 1;
        const offset = first ? indent : hang;
        const contentWidth = Math.max(0, line.width - (first ? indent : 0));
        const available = Math.max(0, (first ? width : width - hang) - (first ? indent : 0));
        const forced = line.mandatory && line.end < prepared.n;
        const justified = align === "justify" && !last && !forced;
        let x = offset;
        if (align === "center") x = offset + (available - contentWidth) / 2;
        else if (align === "right") x = offset + available - contentWidth;
        const top = y;
        const baseline = top + line.top;
        lines.push({
          start: line.start,
          end: line.end,
          width: contentWidth,
          x,
          top,
          baseline,
          ascent: line.top,
          descent: line.bottom,
          glyphTop: top,
          glyphBottom: baseline + line.bottom,
          justified,
          // Optional extras: room on this line, and whether it ends in a
          // forced break (content "break" run or paragraph end).
          available,
          forced: line.mandatory
        });
        maxLineWidth = Math.max(maxLineWidth, x + (justified ? available : contentWidth));
        y = baseline + line.bottom + (last ? 0 : leading);
      });
      return { lines, height: y, maxLineWidth, leading };
    }

    // Largest size on the ladder minFont, minFont + step, ... <= maxFont whose
    // layout fits maxHeight (and maxWidth when given, e.g. for single-line
    // nodes measured unwrapped). Binary search assumes the height grows with
    // the font size; greedy breaking can violate that locally, so the step
    // above the result is verified and, if it also fits, the search walks up
    // until a size fails.
    function fitFontSize(prepared, fitOptions = {}) {
      const minFont = Number(fitOptions.minFont);
      const maxFont = Number(fitOptions.maxFont);
      const step = Number(fitOptions.step) > 0 ? Number(fitOptions.step) : 0.1;
      if (!(minFont > 0) || !(maxFont >= minFont)) throw new RangeError("fitFontSize needs 0 < minFont <= maxFont");
      const maxHeight = Number(fitOptions.maxHeight);
      const maxWidth = Number.isFinite(Number(fitOptions.maxWidth)) ? Number(fitOptions.maxWidth) : Infinity;
      const ladder = stepLadder(minFont, maxFont, step);
      let probes = 0;
      const cache = new Map();
      const attempt = index => {
        if (cache.has(index)) return cache.get(index);
        probes += 1;
        const result = layout(prepared, { ...fitOptions, fontSize: ladder[index] });
        const ok = result.height <= maxHeight + FIT_EPSILON && result.maxLineWidth <= maxWidth + FIT_EPSILON;
        const entry = { ok, result };
        cache.set(index, entry);
        return entry;
      };
      if (!attempt(0).ok) return { fontSize: ladder[0], layout: attempt(0).result, fits: false, probes };
      let low = 0;
      let high = ladder.length - 1;
      if (attempt(high).ok) low = high;
      else {
        while (high - low > 1) {
          const middle = (low + high) >> 1;
          if (attempt(middle).ok) low = middle;
          else high = middle;
        }
      }
      while (low + 1 < ladder.length && attempt(low + 1).ok) low += 1;
      return { fontSize: ladder[low], layout: attempt(low).result, fits: true, probes };
    }

    function naturalWidth(prepared, layoutOptions = {}) {
      const fontSize = Number(layoutOptions.fontSize);
      return Linebreak.naturalWidth(prepared, fontSize, resolveIndents(layoutOptions, fontSize));
    }

    // Text of units [start, end) with formula placeholders replaced by their
    // runs — what the output emitter draws for one line.
    function lineRuns(prepared, start, end) {
      const runs = [];
      let text = "";
      const flush = () => { if (text) runs.push({ type: "text", text }); text = ""; };
      for (let i = start; i < end; i++) {
        const c = prepared.text[i];
        if (c === LINE_SEPARATOR) continue;
        const box = prepared.boxes.get(i);
        if (box) { flush(); runs.push(box.run); }
        else text += c;
      }
      flush();
      return runs;
    }

    return { metrics: fontMetrics, prepare, layout, fitFontSize, naturalWidth, lineRuns };
  }

  const MATH_PATTERN = /\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$|(?<![\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$/g;

  // "text \(x\) more\nnext line" -> runs. renderMathBox(tex, display) returns
  // { widthEm, heightEm, depthEm } (or null / throws for an unrenderable
  // formula, which then gets the raw-LaTeX fallback box).
  function contentFromText(input, options = {}) {
    const text = String(input ?? "");
    const renderMathBox = typeof options.renderMathBox === "function" ? options.renderMathBox : null;
    const runs = [];
    const pushText = value => {
      const parts = value.split(/\r\n?|\n|\u2028/);
      parts.forEach((part, index) => {
        if (index) runs.push({ type: "break" });
        if (part) runs.push({ type: "text", text: part });
      });
    };
    let last = 0;
    for (const match of text.matchAll(MATH_PATTERN)) {
      if (match.index > last) pushText(text.slice(last, match.index));
      const display = match[2] !== undefined || match[3] !== undefined;
      const tex = match[1] ?? match[2] ?? match[3] ?? match[4];
      let box = null;
      if (renderMathBox) {
        try { box = renderMathBox(tex, display); }
        catch (_) { box = null; }
      }
      const valid = box && [box.widthEm, box.heightEm, box.depthEm].every(value => Number.isFinite(Number(value)));
      runs.push({
        type: "math",
        tex,
        display,
        ...(valid
          ? { widthEm: Number(box.widthEm), heightEm: Number(box.heightEm), depthEm: Number(box.depthEm) }
          : fallbackMathBox(display ? `$$${tex}$$` : `$${tex}$`))
      });
      last = match.index + match[0].length;
    }
    if (last < text.length) pushText(text.slice(last));
    return runs;
  }

  return {
    createMeasurer,
    createMetrics: Metrics.createMetrics,
    contentFromText,
    fallbackMathBox,
    isSpace,
    _internal: { Linebreak, Metrics, stepLadder }
  };
});
