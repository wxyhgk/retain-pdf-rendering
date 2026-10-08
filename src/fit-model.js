// retain-pdf-rendering/fit-model
// Host-agnostic: never reference the host application or plugin globals here.
//
// Data-driven port of the glyph-measured fitter in fit.js. Instead of a DOM it
// fits the layout model directly: every text node is laid out by an injected
// measurer (line breaks, line boxes and glyph rectangles in source-page
// units), and the result is pure data — per node font size, line height and
// absolutely positioned lines — that a Typst emitter or a DOM renderer can
// paint without measuring again.
//
//   createModelFitter({ measurer, contentFor?, options? })
//     .fitDocument(model, { mode, strictSourceFit, userBodyFontPt, translatedClamp })
//
// The rule set is runLayoutParityEngine() / fitLayoutFormulas() /
// fitLayoutPages() from fit.js, ported step by step with the same option
// sets, iteration order, rounding (applyGroup's toFixed) and tolerances. Node
// classification follows the selectors fit.js uses on the DOM render.js
// builds; the predicates below name the selector they replace.
//
// Deviations from the DOM fitter (things a data model cannot reproduce):
//   1. Fonts. The measurer has one face (Source Han Serif). layout.css sets
//      titles, page headers/footers/numbers and table/chart/image captions in
//      Arial / "Microsoft YaHei UI", code in a monospace face, equation numbers
//      in Times New Roman, and level-0 TOC rows bold; all of them are measured
//      with the serif metrics (code: a fixed 0.6 em / 1 em CJK advance).
//   2. Glyph rectangles are per line (one rect from the line's start to end x,
//      font content area tall), not per DOM text node. Inline formula boxes
//      enlarge the rect/line box as CSS inline-blocks would.
//   3. Tables and images are opaque boxes: their rendered content rectangle is
//      the block box (a table's natural height is not modelled), and table
//      cell text is not a collision source.
//   4. Formula blocks: the formula is one box (measured natural width, content
//      height) scaled about its centre/left edge like the CSS transform; the
//      equation number is a text box anchored at --equation-number-right.
//   5. TOC rows: label and page number rects only (no leader, no bold), row
//      height = line height, gap rows .40 em.
//   6. Browser-only behaviour with no data equivalent is skipped: the fit
//      cache, debug overlays/labels (stop reasons are returned instead),
//      body-iteration inspection, overflow-wrap:anywhere inside long words.
//   7. clampTranslatedOverflow() only runs with `translatedClamp: true`: on
//      the DOM it is gated by body.layout-translated, which no host sets.
//   8. userBodyFontPt is converted to source units (pt * 4/3): on the DOM the
//      override is written as `${pt}pt`.
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else {
    const namespace = root.RetainPdfRendering = root.RetainPdfRendering || {};
    namespace.FitModel = api;
  }
})(typeof this === "object" && this ? this : globalThis, function (root) {
  "use strict";

  const OBJECT = "￼";
  const LINE_SEPARATOR = " ";
  const STREAM_PADDING_LEFT = 2;  // .layout-flow-stream { padding: 0 4px 0 2px }
  const STREAM_PADDING_RIGHT = 4;
  const CODE_PADDING_X = 7;       // .layout-code { padding: 5px 7px }
  const CODE_PADDING_Y = 5;
  const CAPTION_TYPES = ["table_caption", "table_footnote", "chart_caption", "image_caption", "image_footnote"];
  // A narrow transition may back off without changing the shared body font.
  const ALLOW_INHERITED_BODY_FONT_BACKOFF = true;
  // Content areas (hhea ascent/descent, em) of the faces layout.css names for
  // nodes the measurer's own face does not render: Arial for titles, page
  // furniture and table/chart/image captions; Times New Roman for equation
  // numbers and plain-text formulas (.layout-equation-text). Glyph rectangles
  // and therefore collisions depend on them; advances stay the measurer's.
  // Arial has no CJK, so Chinese in a sans node is drawn by the platform
  // fallback (measured in Firefox on macOS: ascent 1.06 em, descent .34 em,
  // baseline still from the Arial strut).
  const DEFAULT_CONTENT_AREAS = Object.freeze({
    sans: Object.freeze({
      ascent: 1854 / 2048,
      descent: 434 / 2048,
      fallback: Object.freeze({ ascent: 1.06, descent: .34, pattern: /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/ })
    }),
    math: Object.freeze({ ascent: 1825 / 2048, descent: 443 / 2048 })
  });
  const SANS_TYPES = new Set(["title", "header", "page_header", "footer", "page_footer", "page_number",
    "table_caption", "table_footnote", "chart_caption", "image_caption"]);

  function renderModule() {
    if (typeof module === "object" && module && module.exports && typeof require === "function") {
      try { return require("./render.js"); } catch (_error) { /* fall through */ }
    }
    return root.RetainPdfRendering ? root.RetainPdfRendering.Render : null;
  }

  // ---------------------------------------------------------------------------
  // Content: which text each node shows (mirrors render.js).
  // ---------------------------------------------------------------------------

  function decodeEntities(text) {
    return String(text || "")
      .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  }

  function stripControl(text) {
    return [...String(text || "")].filter(character => {
      const code = character.codePointAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && !(code >= 0xD800 && code <= 0xDFFF));
    }).join("");
  }

  // Default text -> runs: TeX spans become math boxes when renderMathBox
  // returns a box, otherwise they stay as their TeX source text.
  function textToRuns(text, renderMathBox) {
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

  // HTML fragments (source html, stubbed TeX markup) -> runs; <br> is a
  // forced break, tags are dropped, <tex>/.katex content follows renderMathBox.
  function htmlToRuns(html, renderMathBox) {
    const source = String(html || "");
    const runs = [];
    const pattern = /<br\s*\/?>|<tex data-display="([01])">([\s\S]*?)<\/tex>/gi;
    let last = 0;
    const pushText = value => {
      const text = decodeEntities(value.replace(/<[^>]+>/g, ""));
      if (text) runs.push(...textToRuns(text, renderMathBox));
    };
    for (const match of source.matchAll(pattern)) {
      pushText(source.slice(last, match.index));
      if (match[0].toLowerCase().startsWith("<br")) runs.push({ type: "break" });
      else {
        const tex = decodeEntities(match[2]);
        const box = renderMathBox ? renderMathBox(tex, match[1] === "1") : null;
        runs.push(box ? { type: "math", tex, display: false, ...box } : { type: "text", text: tex });
      }
      last = match.index + match[0].length;
    }
    pushText(source.slice(last));
    return runs;
  }

  // CSS white-space: normal — collapse whitespace, drop it at paragraph and
  // forced-break edges.
  function collapseRuns(runs) {
    const out = [];
    let pendingSpace = false;
    let atLineStart = true;
    for (const run of runs) {
      if (run.type === "break") {
        out.push(run);
        pendingSpace = false;
        atLineStart = true;
        continue;
      }
      if (run.type === "math") {
        if (pendingSpace && !atLineStart) out.push({ type: "text", text: " " });
        pendingSpace = false;
        atLineStart = false;
        out.push(run);
        continue;
      }
      const parts = String(run.text).split(/[ \t\r\n\f]+/);
      parts.forEach((part, index) => {
        if (index > 0) pendingSpace = true;
        if (!part) return;
        out.push({ type: "text", text: (pendingSpace && !atLineStart ? " " : "") + part });
        pendingSpace = false;
        atLineStart = false;
      });
    }
    // Merge adjacent text runs.
    const merged = [];
    for (const run of out) {
      const previous = merged[merged.length - 1];
      if (run.type === "text" && previous && previous.type === "text") previous.text += run.text;
      else merged.push({ ...run });
    }
    return merged;
  }

  function defaultContentFor(options = {}) {
    const renderMathBox = typeof options.renderMathBox === "function" ? options.renderMathBox : null;
    const parseTocTextRows = typeof options.parseTocTextRows === "function" ? options.parseTocTextRows : null;
    const Render = renderModule();
    const splitTag = Render && Render.splitTeXEquationTag
      ? Render.splitTeXEquationTag
      : (value => ({ body: String(value || ""), number: "" }));

    const translatedRuns = text => collapseRuns(textToRuns(stripControl(text), renderMathBox));
    const sourceTextRuns = text => collapseRuns(textToRuns(stripControl(text), renderMathBox));

    function partRuns(part, useTranslation) {
      const translated = String(part?.translatedText || "");
      if (useTranslation && translated) return textToRuns(stripControl(translated), renderMathBox);
      if (!useTranslation && part?.html) return htmlToRuns(String(part.html), renderMathBox);
      return textToRuns(String(part?.text || ""), renderMathBox);
    }

    return function contentFor(node, mode) {
      const useTranslation = mode === "translation";
      if (node.kind === "stream") {
        const stream = node.source;
        if (node.toc) {
          const sourceTocRows = (stream.items || []).flatMap(item => Array.isArray(item.tocRows) ? item.tocRows : []);
          const translatedTocText = (stream.items || []).map(item => String(item.translatedText || "")).filter(Boolean).join("\n");
          const rows = useTranslation ? (parseTocTextRows ? parseTocTextRows(translatedTocText) : null) : sourceTocRows;
          return { tocRows: rows || [] };
        }
        const paragraphs = (stream.items || []).flatMap(item =>
          Array.isArray(item.paragraphs) && item.paragraphs.length
            ? item.paragraphs
            : [{ parts: item.parts || [item], indent: item.indent || 0 }]);
        return {
          paragraphs: paragraphs.map(paragraph => {
            const parts = Array.isArray(paragraph.parts) ? paragraph.parts : [];
            const runs = [];
            parts.forEach((part, index) => {
              const previous = parts[index - 1];
              if (index && !/[-−–]\s*$/.test(String(previous?.text || ""))) runs.push({ type: "text", text: " " });
              runs.push(...partRuns(part, useTranslation));
            });
            return { runs: collapseRuns(runs), indent: Number(paragraph.indent || 0) };
          })
        };
      }
      const block = node.source;
      if (block.kind === "image") return { image: true };
      if (block.kind === "table" && block.tableHTML) return { table: true };
      if (block.kind === "code") return { code: String(block.text || "") };
      if (block.kind === "formula") {
        const formula = block.formulas?.[0] || block.text || "";
        const equation = splitTag(formula);
        const tex = equation.body || formula;
        const box = renderMathBox ? renderMathBox(tex, true) : null;
        return {
          formula: box ? [{ type: "math", tex, display: true, ...box }] : collapseRuns([{ type: "text", text: tex }]),
          number: equation.number ? `(${equation.number})` : ""
        };
      }
      const translated = useTranslation ? String(block.translatedText || "") : "";
      const text = useTranslation
        ? (translated || (block.sourceOnly && block.sourceHTML ? "" : String(block.text || "")))
        : (block.sourceHTML ? "" : String(block.text || ""));
      if (!translated && block.sourceHTML) return { paragraphs: [{ runs: collapseRuns(htmlToRuns(block.sourceHTML, renderMathBox)), indent: 0 }] };
      return { paragraphs: [{ runs: useTranslation ? translatedRuns(text) : sourceTextRuns(text), indent: 0 }] };
    };
  }

  // ---------------------------------------------------------------------------
  // Geometry helpers (fit.js equivalents).
  // ---------------------------------------------------------------------------

  function rectsOverlap(a, b, padding) {
    return a.left < b.right - padding &&
      a.right > b.left + padding &&
      a.top < b.bottom - padding &&
      a.bottom > b.top + padding;
  }

  function layoutRectsOverlap(first, second, tolerance = 1.5) {
    return (
      Math.min(first.right, second.right) - Math.max(first.left, second.left) > tolerance
      && Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > tolerance
    );
  }

  // Conservative broad-phase envelope for rendered text rectangles. All
  // candidates still reach the exact per-rectangle test below, so this can
  // only avoid unnecessary work; it cannot hide a real glyph collision.
  function rectUnion(rects) {
    if (!rects || !rects.length) return null;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const rect of rects) {
      if (!rect) continue;
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }
    return Number.isFinite(left) ? { left, top, right, bottom } : null;
  }

  function horizontalBoxesOverlap(a, b, padding = 0) {
    return a.left < b.right - padding && a.right > b.left + padding;
  }

  // Monotone collision-constrained growth: find the largest value in
  // [start, max] (stepped by `step`) at which `collides(value)` is still false.
  // Chromium line breaks are only weakly monotone, so recheck the tick above
  // the bisected boundary. `collides` leaves the node at the probed value.
  function gallopingGrow(start, max, step, collides) {
    if (start >= max) return { value: start, probes: 0 };
    const ticks = Math.floor((max - start) / step + 1e-6);
    if (ticks <= 0) return { value: start, probes: 0 };
    const at = (t) => Math.min(max, start + t * step);
    let probes = 0;
    let lastOk = 0;
    let firstBad = -1;
    let jump = 1;
    while (lastOk + jump <= ticks) {
      const t = lastOk + jump;
      probes += 1;
      if (collides(at(t))) { firstBad = t; break; }
      lastOk = t;
      jump *= 2;
    }
    // A doubling jump can pass the final tick (for example 1, 3, 7, 15 on a
    // 23-tick search).  Probe that endpoint before declaring max feasible;
    // otherwise a collision in the unvisited tail can be accepted as max.
    if (firstBad === -1 && lastOk < ticks) {
      probes += 1;
      if (collides(at(ticks))) firstBad = ticks;
      else lastOk = ticks;
    }
    if (firstBad === -1) {
      return { value: at(ticks), probes, lastProbed: at(ticks) };
    }
    let lo = lastOk;
    let hi = firstBad;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      probes += 1;
      if (collides(at(mid))) hi = mid; else lo = mid;
    }
    let best = lo;
    for (let t = lo + 1; t <= Math.min(ticks, lo + 1); t += 1) {
      probes += 1;
      if (collides(at(t))) break;
      best = t;
    }
    return { value: at(best), probes, lastProbed: at(Math.min(ticks, best + 1)) };
  }

  // ---------------------------------------------------------------------------
  // The fitter.
  // ---------------------------------------------------------------------------

  function createModelFitter(config = {}) {
    const measurer = config.measurer;
    if (!measurer || typeof measurer.prepare !== "function" || typeof measurer.layout !== "function") {
      throw new Error("createModelFitter requires a measurer with prepare() and layout()");
    }
    const contentFor = typeof config.contentFor === "function"
      ? config.contentFor
      : defaultContentFor(config.options || {});
    const contentAreas = { ...DEFAULT_CONTENT_AREAS, ...(config.contentAreas || {}) };
    // Optional per-role measurers ({ sans, sansBold }) for faces whose
    // advances differ from the main measurer's; missing roles use `measurer`.
    const roleMeasurers = config.measurers || {};
    // Optional diagnostics: trace(event, details) at every stop decision.
    const trace = typeof config.trace === "function" ? config.trace : null;

    function fitDocument(model, fitOptions = {}) {
      const mode = fitOptions.mode === "translation" ? "translation" : "source";
      const state = buildDocument(model, mode);
      runFit(state, fitOptions);
      return serialize(state, mode);
    }

    // ----- document construction (render.js buildLayoutDocument) -----

    function buildDocument(model, mode) {
      const useTranslation = mode === "translation";
      const pages = [];
      const nodes = [];
      for (const page of model?.pages || []) {
        const pageState = {
          index: page.index,
          width: Number(page.width) || 1,
          height: Number(page.height) || 1,
          nodes: []
        };
        pages.push(pageState);
        const blocks = Array.isArray(page?.blocks) ? page.blocks : [];
        const hasTranslatableBlocks = blocks.some(block => Boolean(block?.translatable));
        const hasPageTranslation = blocks.some(block => Boolean(block?.translatable && block?.translatedText));
        // An untranslated page renders only the awaiting overlay.
        if (useTranslation && hasTranslatableBlocks && !hasPageTranslation) continue;
        const restoration = page.restoration;
        if (restoration?.streams?.length || restoration?.absoluteBlocks?.length) {
          for (const stream of restoration.streams || []) pageState.nodes.push(streamNode(stream, pageState));
          for (const block of restoration.absoluteBlocks || []) pageState.nodes.push(blockNode(block, pageState));
        }
        else {
          for (const block of page.blocks || []) pageState.nodes.push(blockNode(block, pageState));
        }
        for (const node of pageState.nodes) {
          node.order = nodes.length;
          nodes.push(node);
          node.content = prepareContent(node, contentFor(node, mode));
        }
      }
      return { pages, nodes, mode };
    }

    function streamNode(stream, page) {
      const roles = String(stream.debugRole || "text").replace(/[^a-z0-9_-]+/gi, "-");
      const fromList = (stream.items || []).some(item => item.fromList || item.parts?.some(part => part.fromList));
      const sourceTocRows = (stream.items || []).flatMap(item => Array.isArray(item.tocRows) ? item.tocRows : []);
      const originalLineCount = (stream.items || []).reduce((sum, item) =>
        sum + Number(item.originalLineCount || item.parts?.reduce((partSum, part) => partSum + Number(part.originalLineCount || 0), 0) || 0), 0);
      const paragraphCount = (stream.items || []).reduce((sum, item) =>
        sum + (Array.isArray(item.paragraphs) && item.paragraphs.length ? item.paragraphs.length : 1), 0);
      const isTocCandidate = Boolean(sourceTocRows.length);
      const [left, top, right, bottom] = stream.bbox || [0, 0, 0, 0];
      const symmetry = Math.abs(left - (page.width - right)) / Math.max(1, right - left) <= .07;
      const baseFont = Math.max(4, Number(stream.fontSize || 7.6));
      const baseLineRatio = Math.max(1, Number(stream.lineHeight || 1.16));
      const node = {
        kind: "stream",
        source: stream,
        page,
        id: String(stream.items?.[0]?.id || stream.items?.[0]?.parts?.[0]?.id || ""),
        debugRole: roles,
        refs: Boolean(stream.refsOnly),
        fromList,
        equationDense: Boolean(stream.equationDense),
        tocCandidate: isTocCandidate,
        toc: false, // decided once content is known (needs rows in this mode)
        flowKind: stream.refsOnly ? "ref_text" : "text",
        styleKind: stream.styleKind || "text",
        bodyInherited: Boolean(stream.bodyInherited),
        originalLines: "multi",
        singleLineAlign: "left",
        columnKey: String(stream.columnKey || ""),
        bbox: [left, top, right, bottom],
        baseFont,
        baseLineRatio,
        lineRatio: baseLineRatio,
        paragraphGap: Math.max(0, Number(stream.paragraphGap || .16)),
        pageHeight: Math.max(1, page.height),
        fitBandRatio: null,
        style: { fontSize: null, lineRatio: baseLineRatio, width: null, nowrap: false },
        formula: null,
        fit: null
      };
      node.originalLinesSeed = { originalLineCount, paragraphCount, items: (stream.items || []).length, symmetry };
      return node;
    }

    function blockNode(block, page) {
      const type = String(block.type || "unknown");
      const safeType = type.replace(/[^a-z0-9_-]+/gi, "-");
      const baseFont = Math.max(4, Number(block.fontSize || 8));
      const originalLineCount = Math.max(1, Number(block.lineCount || 1));
      const node = {
        kind: "block",
        source: block,
        page,
        id: String(block.id || ""),
        type: safeType,
        blockKind: type,
        layoutKind: String(block.kind || "text"),
        mainTitle: Boolean(block.mainTitle),
        title: type === "title",
        caption: /caption|footnote/.test(type),
        flowKind: "",
        styleKind: "",
        bodyInherited: false,
        originalLines: null,
        singleLineAlign: null,
        columnKey: "",
        bbox: (block.bbox || [0, 0, 1, 1]).map(Number),
        baseFont,
        baseLineRatio: Math.max(1, Number(block.lineHeight || 1.12)),
        lineRatio: Math.max(1, Number(block.lineHeight || 1.12)),
        pageHeight: Math.max(1, page.height),
        fitBandRatio: CAPTION_TYPES.slice(0, 5).includes(type) && /^(?:table_caption|table_footnote|chart_caption|image_caption|image_footnote)$/i.test(type) ? 0.12 : null,
        style: { fontSize: null, lineRatio: null, width: null, nowrap: false },
        formula: null,
        fit: null
      };
      if (type.toLowerCase() === "text") {
        node.originalLines = originalLineCount > 1 ? "multi" : "single";
        const [left, , right] = node.bbox;
        const symmetric = Math.abs(left - (page.width - right)) / Math.max(1, right - left) <= .07;
        node.singleLineAlign = node.originalLines === "single" && symmetric ? "center" : "left";
      }
      if (String(block.kind || "").toLowerCase() === "code") {
        // Code blocks are positioned frames, not flowing content. Keep the
        // pre/code line box tied to the parent so the translated fit pass can
        // compact the frame without changing the geometry of following blocks.
        const codeLineRatio = Math.max(.95, Number(block.lineHeight || 1.18));
        node.baseLineRatio = codeLineRatio;
        node.lineRatio = codeLineRatio;
        node.style.lineRatio = codeLineRatio;
      }
      if (block.kind === "formula") {
        const numberRight = Number(block.numberRight);
        node.formula = {
          scale: 1,
          numberRight: Number.isFinite(numberRight) && Array.isArray(block.bbox) ? Number((numberRight - Number(block.bbox[0] || 0)).toFixed(2)) : null
        };
      }
      return node;
    }

    function prepareContent(node, content) {
      const prepared = { raw: content || {} };
      const measurer = measurerFor(node);
      if (node.kind === "stream") {
        const rows = content?.tocRows || null;
        node.toc = Boolean(node.tocCandidate && rows && rows.length);
        if (node.toc) {
          prepared.tocRows = rows.map(row => {
            if (row?.gap) return { gap: true };
            if (!row?.page) return { unparsed: true, label: measurer.prepare([{ type: "text", text: String(row?.text || "") }]) };
            const level = Math.max(0, Math.min(8, Number(row.level || 0)));
            const label = `${String(row.number || "")} ${String(row.title || "")}`;
            return {
              level,
              label: measurer.prepare([{ type: "text", text: label }]),
              page: measurer.prepare([{ type: "text", text: String(row.page || "") }])
            };
          });
          prepared.paragraphs = [];
        }
        else {
          prepared.paragraphs = (content?.paragraphs || []).map(paragraph => ({
            runs: paragraph.runs || [],
            indent: Number(paragraph.indent || 0),
            prepared: measurer.prepare(paragraph.runs || [])
          }));
        }
        const seed = node.originalLinesSeed;
        const paragraphCount = node.toc ? seed.paragraphCount : Math.max(seed.paragraphCount, 0);
        node.originalLines = node.toc || seed.items > 1 || paragraphCount > 1 || seed.originalLineCount > 1 ? "multi" : "single";
        node.singleLineAlign = node.originalLines === "single" && node.debugRole === "text" && seed.symmetry ? "center" : "left";
      }
      else if (content?.formula) {
        prepared.formula = measurer.prepare(content.formula);
        prepared.formulaRuns = content.formula;
        prepared.formulaIsText = !content.formula.some(run => run.type === "math");
        prepared.number = content.number ? measurer.prepare([{ type: "text", text: content.number }]) : null;
        prepared.numberText = content.number || "";
      }
      else if (typeof content?.code === "string") {
        prepared.code = content.code;
      }
      else if (content?.image || content?.table) {
        prepared.opaque = true;
      }
      else {
        prepared.paragraphs = (content?.paragraphs || []).map(paragraph => ({
          runs: paragraph.runs || [],
          indent: 0,
          prepared: measurer.prepare(paragraph.runs || [])
        }));
      }
      return prepared;
    }

    // ----- node state accessors (dataset/style equivalents) -----

    function isStream(node) { return node.kind === "stream"; }
    function isBlock(node) { return node.kind === "block"; }
    function hasClassDebugText(node) { return isStream(node) && node.debugRole === "text"; }

    function cssLineRatio(node) {
      if (isStream(node)) return node.baseLineRatio;
      const type = String(node.type || "").toLowerCase();
      if (type === "ref_text") return 1.06;
      if (["table_caption", "table_footnote", "chart_caption", "image_caption"].includes(type)) return 1.2;
      return 1.12;
    }

    // .layout-flow-stream.equation-dense { line-height: 1.04 !important }
    function effectiveLineRatio(node) {
      if (node.equationDense) return 1.04;
      return node.style.lineRatio ?? cssLineRatio(node);
    }

    // layoutControlFontSize(): the applied size, else dataset.baseFont.
    function layoutControlFontSize(node, fallback = 8) {
      const rendered = node.style.fontSize;
      return Number.isFinite(rendered) && rendered > 0 ? rendered : (Number(node.baseFont) || fallback);
    }

    // parseFloat(node.style.lineHeight || node.dataset.lineRatio || fallback)
    function controlLineRatio(node, fallback = 1.1) {
      const value = node.style.lineRatio ?? node.lineRatio;
      return Number.isFinite(value) && value > 0 ? value : fallback;
    }

    function applyGroup(nodes, fontSize, lineRatio) {
      for (const node of nodes) {
        if (!node) continue;
        node.style.fontSize = Number(fontSize.toFixed(2));
        node.style.lineRatio = Number(lineRatio.toFixed(3));
      }
    }

    function nodeBox(node) {
      const [left, top, right, bottom] = node.bbox;
      const width = node.style.width ?? Math.max(.1, right - left);
      return { left, top, right: left + width, bottom: top + Math.max(.1, bottom - top) };
    }

    // ----- geometry -----

    const geometryCache = new Map();

    function geometryKey(node) {
      return [
        layoutControlFontSize(node),
        effectiveLineRatio(node),
        node.style.width ?? "",
        node.style.nowrap ? 1 : 0,
        node.originalLines || "",
        node.formula ? `${node.formula.scale}|${node.formula.numberRight}` : ""
      ].join("|");
    }

    function geometry(node) {
      let entry = geometryCache.get(node);
      const key = geometryKey(node);
      if (entry && entry.key === key) return entry.value;
      const value = computeGeometry(node);
      geometryCache.set(node, { key, value });
      return value;
    }

    function contentArea(role) {
      const area = role ? contentAreas[role] : null;
      if (!area) return {};
      const out = { contentAscent: area.ascent, contentDescent: area.descent };
      if (area.fallback) {
        out.fallbackAscent = area.fallback.ascent;
        out.fallbackDescent = area.fallback.descent;
        out.fallbackPattern = area.fallback.pattern;
      }
      return out;
    }

    function fontRole(node) {
      return isBlock(node) && SANS_TYPES.has(String(node.type || "").toLowerCase()) ? "sans" : null;
    }

    // layout.css: titles 700, page headers 600 (both render bold); the other
    // sans nodes are regular.
    function measurerFor(node) {
      if (fontRole(node) !== "sans") return measurer;
      const type = String(node.type || "").toLowerCase();
      const bold = type === "title" || type === "header" || type === "page_header";
      return (bold ? roleMeasurers.sansBold : roleMeasurers.sans) || measurer;
    }

    function textAlign(node) {
      if (isStream(node)) {
        if (node.refs || node.fromList || hasClassDebugText(node) || node.toc) return "left";
        return "justify";
      }
      const type = String(node.type || "").toLowerCase();
      if (node.mainTitle) return "center";
      if (type === "title" || type === "page_number" || type === "ref_text") return "left";
      if (["page_header", "header", "footer", "page_footer", "page_footnote"].includes(type)) return "center";
      if (["table_caption", "table_footnote", "chart_caption", "image_caption"].includes(type)) return "left";
      return "justify";
    }

    function pushLineRects(rects, lines, originX, originY, paragraph) {
      for (const line of lines) {
        const record = {
          paragraph,
          start: line.start,
          end: line.end,
          x: originX + line.x,
          top: originY + line.top,
          baseline: originY + line.baseline,
          width: line.width,
          glyphTop: originY + line.glyphTop,
          glyphBottom: originY + line.glyphBottom,
          justified: Boolean(line.justified)
        };
        rects.lines.push(record);
        if (line.width <= .5 || record.glyphBottom - record.glyphTop <= .5) continue;
        if (line.end > line.start || line.width > .5) {
          rects.text.push({ left: record.x, right: record.x + line.width, top: record.glyphTop, bottom: record.glyphBottom });
        }
      }
    }

    function naturalWidth(prepared, fontSize, ratio, role = null, using = measurer) {
      const result = using.layout(prepared, { fontSize, lineHeight: ratio, width: 1e9, nowrap: true, align: "left", ...contentArea(role) });
      const line = result.lines[0];
      return {
        width: result.maxLineWidth,
        height: line ? line.glyphBottom - line.glyphTop : 0,
        lines: result.lines
      };
    }

    function computeGeometry(node) {
      const measurer = measurerFor(node);
      const box = nodeBox(node);
      const fontSize = layoutControlFontSize(node);
      const ratio = effectiveLineRatio(node);
      const out = { box, lines: [], text: [], visual: [], contentHeight: 0, scrollWidth: box.right - box.left };
      const clientHeight = box.bottom - box.top;
      const content = node.content || {};
      if (isStream(node)) {
        const contentLeft = box.left + STREAM_PADDING_LEFT;
        const contentRight = box.right - STREAM_PADDING_RIGHT;
        const width = Math.max(0, contentRight - contentLeft);
        let y = 0;
        if (node.toc) {
          const L = fontSize * ratio;
          (content.tocRows || []).forEach((row, index) => {
            if (row.gap) { y += .40 * fontSize; return; }
            const indent = row.unparsed ? 0 : row.level * .82 * fontSize;
            const label = naturalWidth(row.label, fontSize, ratio, null, measurer);
            const lineTop = box.top + y;
            const glyph = label.lines[0];
            const glyphTop = lineTop + (glyph ? glyph.glyphTop : 0);
            const glyphBottom = lineTop + (glyph ? glyph.glyphBottom : L);
            let pageWidth = 0;
            if (row.page) {
              pageWidth = naturalWidth(row.page, fontSize, ratio, null, measurer).width;
              out.text.push({ left: contentRight - pageWidth, right: contentRight, top: glyphTop, bottom: glyphBottom });
            }
            // .toc-label is clipped (overflow: hidden) to its grid track.
            const labelMax = row.unparsed ? width : Math.max(0, width - indent - pageWidth - 12 - .74 * fontSize);
            const labelWidth = Math.min(label.width, labelMax);
            if (labelWidth > .5) out.text.push({ left: contentLeft + indent, right: contentLeft + indent + labelWidth, top: glyphTop, bottom: glyphBottom });
            out.lines.push({ paragraph: index, toc: true, x: contentLeft + indent, top: lineTop, baseline: lineTop + (glyph ? glyph.baseline : L), width: labelWidth, pageWidth, glyphTop, glyphBottom });
            y += L;
          });
        }
        else {
          const paragraphs = content.paragraphs || [];
          const singleNowrap = hasClassDebugText(node) && node.originalLines === "single";
          const align = singleNowrap ? "left" : textAlign(node);
          paragraphs.forEach((paragraph, index) => {
            const result = measurer.layout(paragraph.prepared, {
              fontSize,
              lineHeight: ratio,
              width,
              align,
              nowrap: singleNowrap || node.style.nowrap,
              firstLineIndent: node.refs || singleNowrap ? 0 : Math.max(0, paragraph.indent || 0),
              hangingIndent: node.refs ? 1.1 * fontSize : 0
            });
            let originX = contentLeft;
            if (singleNowrap && node.singleLineAlign === "center") {
              originX = contentLeft + width / 2 - result.maxLineWidth / 2;
            }
            pushLineRects(out, result.lines, originX, box.top + y, index);
            out.scrollWidth = Math.max(out.scrollWidth, originX + result.maxLineWidth + STREAM_PADDING_RIGHT - box.left);
            y += result.height;
            if (index < paragraphs.length - 1) y += node.paragraphGap * fontSize;
          });
        }
        out.contentHeight = y;
      }
      else if (content.formula) {
        const scale = node.formula ? node.formula.scale : 1;
        const natural = naturalWidth(content.formula, fontSize, ratio, node.content.formulaIsText ? "math" : null, measurer);
        const hasNumber = Boolean(content.number);
        const cy = (box.top + box.bottom) / 2;
        const formulaHeight = natural.height || fontSize;
        let left;
        if (hasNumber) left = box.left; // .has-number: justify-content flex-start, origin left
        else left = (box.left + box.right) / 2 - natural.width * scale / 2;
        const formulaRect = {
          left,
          right: left + natural.width * scale,
          top: cy - formulaHeight * scale / 2,
          bottom: cy + formulaHeight * scale / 2
        };
        out.formulaNatural = { width: natural.width, height: formulaHeight };
        out.formulaRect = formulaRect;
        if (natural.width > .5) out.text.push(formulaRect);
        if (hasNumber) {
          const number = naturalWidth(content.number, fontSize, ratio, "math", measurer);
          const anchor = node.formula && Number.isFinite(node.formula.numberRight)
            ? node.formula.numberRight
            : box.right - box.left; // var(--equation-number-right, 100%)
          const right = box.left + anchor;
          const numberRect = { left: right - number.width, right, top: cy - number.height / 2, bottom: cy + number.height / 2 };
          out.numberRect = numberRect;
          out.text.push(numberRect);
        }
        out.contentHeight = clientHeight;
      }
      else if (typeof content.code === "string") {
        // Monospace stand-in: 0.6 em per character, 1 em for wide characters;
        // pre-wrap breaks anywhere once a line is full.
        const L = fontSize * ratio;
        const innerLeft = box.left + CODE_PADDING_X;
        const innerWidth = Math.max(1, box.right - box.left - 2 * CODE_PADDING_X);
        const halfLeading = (L - 1.437 * fontSize) / 2;
        let y = CODE_PADDING_Y;
        for (const sourceLine of content.code.split("\n")) {
          let lineWidth = 0;
          const flush = () => {
            if (lineWidth > .5) out.text.push({ left: innerLeft, right: innerLeft + lineWidth, top: box.top + y + halfLeading, bottom: box.top + y + halfLeading + 1.437 * fontSize });
            y += L;
            lineWidth = 0;
          };
          for (const character of [...sourceLine]) {
            const advance = (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(character) ? 1 : .6) * fontSize;
            if (lineWidth + advance > innerWidth + 1e-6 && lineWidth > 0) flush();
            lineWidth += advance;
          }
          flush();
        }
        out.codeScrollHeight = y + CODE_PADDING_Y;
        out.codeClientHeight = clientHeight;
        out.contentHeight = clientHeight;
      }
      else if (content.opaque) {
        out.visual.push({ left: box.left, top: box.top, right: box.right, bottom: box.bottom });
        out.contentHeight = clientHeight;
      }
      else {
        const paragraphs = content.paragraphs || [];
        const width = Math.max(0, box.right - box.left);
        const align = textAlign(node);
        let y = 0;
        paragraphs.forEach((paragraph, index) => {
          const result = measurer.layout(paragraph.prepared, {
            fontSize,
            lineHeight: ratio,
            width,
            align: node.style.nowrap ? "left" : align,
            nowrap: node.style.nowrap,
            firstLineIndent: 0,
            hangingIndent: 0,
            ...contentArea(fontRole(node))
          });
          pushLineRects(out, result.lines, box.left, box.top + y, index);
          out.scrollWidth = Math.max(out.scrollWidth, result.maxLineWidth);
          y += result.height;
        });
        out.contentHeight = y;
      }
      out.clientHeight = clientHeight;
      out.scrollHeight = Math.max(clientHeight, out.contentHeight);
      return out;
    }

    function textRectsInPage(node) {
      return geometry(node).text;
    }

    // 正文专用的内容几何：文字取每个可见行的 Range rect；公式取 MathJax
    // 完成排版后的容器；图片和表格取实际元素的渲染矩形。没有可测内容时回退到块框。
    function renderedContentRectsInPage(node) {
      const value = geometry(node);
      const rects = value.text.concat(value.visual);
      return rects.length ? rects : [elementBoxInPage(node)];
    }

    function elementBoxInPage(node) {
      return nodeBox(node);
    }

    function measureTextBand(node) {
      const value = geometry(node);
      const top = value.box.top;
      let firstTop = null;
      let lastBottom = 0;
      let hasText = false;
      for (const rect of value.text) {
        const rectTop = rect.top - top;
        const bottom = rect.bottom - top;
        if (firstTop === null || rectTop < firstTop) firstTop = rectTop;
        if (bottom > lastBottom) lastBottom = bottom;
        hasText = true;
      }
      return { hasText, firstTop: firstTop ?? 0, lastBottom };
    }

    function blockDebugName(node) {
      if (!node) return "unknown";
      const box = elementBoxInPage(node);
      return [
        node.styleKind || node.flowKind || node.type || "block",
        node.id ? `#${node.id}` : "",
        `@${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.right - box.left)}x${Math.round(box.bottom - box.top)}`
      ].filter(Boolean).join(" ");
    }

    // ----- selectors -----

    const Select = {
      body: node => isStream(node) && node.styleKind === "body_text" && node.flowKind === "text" && !node.bodyInherited,
      bodyInherited: node => isStream(node) && node.styleKind === "body_text" && node.flowKind === "text" && node.bodyInherited,
      mainTitle: node => isBlock(node) && node.type === "title" && node.mainTitle,
      otherTitle: node => isBlock(node) && node.type === "title" && !node.mainTitle,
      anyTitle: node => isBlock(node) && node.type === "title",
      list: node => isStream(node) && node.fromList && node.flowKind === "text",
      debugTextMulti: node => hasClassDebugText(node) && node.flowKind === "text" && node.originalLines === "multi",
      textBlockMulti: node => isBlock(node) && node.type === "text" && node.originalLines === "multi",
      captionType: type => node => isBlock(node) && node.type === type,
      refs: node => isStream(node) && node.flowKind === "ref_text",
      finalAudit: node => isStream(node) && (node.flowKind === "text" || node.flowKind === "ref_text"),
      falseSingle: node => (hasClassDebugText(node) && node.flowKind === "text" && node.originalLines === "single")
        || (isBlock(node) && node.type === "text" && node.originalLines === "single"),
      code: node => isBlock(node) && node.type === "code",
      formula: node => isBlock(node) && node.layoutKind === "formula",
      columnCandidate: node => isStream(node) || (isBlock(node) && node.type === "text")
    };

    // ----- the fit run -----

    function runFit(doc, fitOptions) {
      const all = doc.nodes;
      const scopedNodes = predicate => all.filter(predicate);
      const strictSourceFit = Boolean(fitOptions.strictSourceFit);

      function singleLineTextExceedsPage(node, tolerance = 1.5) {
        const pageWidth = node.page.width;
        if (pageWidth <= 0) return false;
        const textRects = textRectsInPage(node);
        if (!textRects.length) return false;
        return textRects.some((rect) => rect.left < -tolerance || rect.right > pageWidth + tolerance);
      }

      function demoteFalseSingleLineText() {
        for (const node of scopedNodes(Select.falseSingle)) {
          if (!singleLineTextExceedsPage(node)) continue;
          node.originalLines = "multi";
          node.singleLineAlign = "left";
          node.fitLabel = node.fitLabel || "DEMOTED single->multi";
        }
      }

      function textCollisionDetails(nodes, options = {}) {
        const nodeSet = new Set(nodes);
        const includeGroupPeers = Boolean(options.includeGroupPeers);
        const ignoreTopOverflow = Boolean(options.ignoreTopOverflow);
        const checkAllTextForCollisions = Boolean(options.checkAllTextForCollisions);
        const avoidPageOverflow = Boolean(options.avoidPageOverflow);
        const bodyColumnIndependentFit = Boolean(options.bodyColumnIndependentFit);
        for (const node of nodes) {
          const page = node.page;
          const own = elementBoxInPage(node);
          const sharedEdgeTolerance = Number.isFinite(options.sharedEdgeTolerance)
            ? options.sharedEdgeTolerance
            : 0;
          const sharedHorizontalEdgeTolerance = Number.isFinite(options.sharedHorizontalEdgeTolerance)
            ? options.sharedHorizontalEdgeTolerance
            : 0;
          const ignoreNodeTopOverflow = ignoreTopOverflow || (
            Boolean(options.ignoreBodyTopOverflow) && node.styleKind === "body_text"
          );
          const sourceIsBodyText = node.styleKind === "body_text";
          // 每个文本源都逐行检测自身实际文字。区别仅在障碍物：正文迭代以实际
          // 内容为障碍；其它文本迭代以布局边框为障碍。
          const sourceRects = textRectsInPage(node).filter((rect) => {
            return checkAllTextForCollisions || rect.bottom > own.bottom + 1 ||
              (!ignoreNodeTopOverflow && rect.top < own.top - 1) ||
              rect.left < own.left - 1 ||
              rect.right > own.right + 1;
          });
          if (!sourceRects.length) continue;
          // 正文迭代：正文实际文字对所有块的实际内容；其它文本迭代：自己的
          // 实际文字对所有块的边框。这样正文不受空白边框的保守限制，而题注、
          // 标题等仍以稳定的布局边框作为外部约束。
          const barrierUsesTextGeometry = Boolean(options.bodyTextCollisionGeometry) && sourceIsBodyText;
          const barriers = page.nodes
            .filter((candidate) => candidate !== node && (includeGroupPeers || !nodeSet.has(candidate)))
            .map((element) => {
              const box = elementBoxInPage(element);
              if (!barrierUsesTextGeometry) return { element, box, contentRects: [box], contentBounds: box };
              const rects = renderedContentRectsInPage(element);
              return { element, box, contentRects: rects, contentBounds: rectUnion(rects) || box };
            });
          for (const rect of sourceRects) {
            if (avoidPageOverflow && (
              rect.left < -1.5 || rect.top < -1.5 ||
              rect.right > page.width + 1.5 || rect.bottom > page.height + 1.5
            )) {
              return { source: node, blocker: null, rect, sourceName: blockDebugName(node), blockerName: "page-boundary" };
            }
            const hit = barriers.find((barrier) => {
              // 正文的字号填充只受同列（或原始框已相互侵入）的块约束。
              // 并列栏即使处于同一高度，也不应互相压低字号；页面左右越界仍由
              // avoidPageOverflow 单独保护。这里按源框投影而非文字墨迹判断，故仍能
              // 捕获错误扩宽的正文框和向下增长压到同列块的情形。
              if (bodyColumnIndependentFit && node.styleKind === "body_text" &&
                  !horizontalBoxesOverlap(own, barrier.box, 1.5)) {
                return false;
              }
              if (!rectsOverlap(rect, barrier.contentBounds, 1.5)) return false;
              const contentHit = barrier.contentRects.some((contentRect) => rectsOverlap(rect, contentRect, 1.5));
              if (!contentHit) return false;
              // Adjacent source bboxes can overlap by a rounding pixel. Ignore only
              // that upper shared edge for body text; horizontal and lower-edge
              // collisions from the same first line are still enforced.
              if (ignoreNodeTopOverflow && rect.top < own.top && barrier.box.bottom <= own.top + 1.5) {
                return false;
              }
              // Inline math and justified CJK glyphs can overhang a column edge by
              // a few pixels even though the line box itself remains in-column.
              // Treat only a shallow overhang across an exactly shared vertical
              // edge as optical ink; any deeper intrusion remains a collision.
              const sharesRightEdge = Math.abs(own.right - barrier.box.left) <= 1.5;
              const sharesLeftEdge = Math.abs(own.left - barrier.box.right) <= 1.5;
              if (sharedEdgeTolerance > 0 && (
                (sharesRightEdge && rect.right <= own.right + sharedEdgeTolerance) ||
                (sharesLeftEdge && rect.left >= own.left - sharedEdgeTolerance)
              )) {
                return false;
              }
              const sharesBottomEdge = Math.abs(own.bottom - barrier.box.top) <= 1.5;
              const sharesTopEdge = Math.abs(own.top - barrier.box.bottom) <= 1.5;
              if (sharedHorizontalEdgeTolerance > 0 && (
                (sharesBottomEdge && rect.bottom <= own.bottom + sharedHorizontalEdgeTolerance) ||
                (sharesTopEdge && rect.top >= own.top - sharedHorizontalEdgeTolerance)
              )) {
                return false;
              }
              return true;
            });
            if (hit) {
              return { source: node, blocker: hit.element, rect, sourceName: blockDebugName(node), blockerName: blockDebugName(hit.element) };
            }
          }
        }
        return null;
      }

      function measureGroup(nodes) {
        let overflow = false;
        let allReachedBand = true;
        let maxBottomGap = 0;
        const details = [];
        for (const node of nodes) {
          if (!node) continue;
          const value = geometry(node);
          const clientHeight = value.clientHeight;
          const pageHeight = node.pageHeight || 792;
          const band = Number.isFinite(node.fitBandRatio)
            ? Math.max(1.0, clientHeight * node.fitBandRatio)
            : pageHeight * 0.02;
          const metrics = measureTextBand(node);
          const overflowTolerance = 1.5;
          const bottomGap = Math.max(0, clientHeight - metrics.lastBottom);
          const overflowAmount = Math.max(
            0,
            metrics.lastBottom - clientHeight - overflowTolerance,
            node.styleKind === "body_text" ? 0 : -metrics.firstTop - overflowTolerance
          );
          maxBottomGap = Math.max(maxBottomGap, bottomGap);
          if (overflowAmount > 0.5) overflow = true;
          if (!metrics.hasText || bottomGap > band) allReachedBand = false;
          details.push({ node, hasText: metrics.hasText, bottomGap, band, overflowAmount, reachedBand: metrics.hasText && bottomGap <= band });
        }
        return { overflow, allReachedBand, maxBottomGap, details };
      }

      function wouldCollideWithBlocks(nodes, options) {
        if (!options.avoidBlockOverlap) return false;
        return Boolean(textCollisionDetails(nodes, options));
      }

      function tuneNodes(nodes, options) {
        if (!nodes.length) return null;
        const baseFont = Math.max(...nodes.map((node) => Number(node.baseFont || 8)));
        const baseLineRatio = Math.max(...nodes.map((node) => Number(node.lineRatio || 1.1)));
        let fontSize = baseFont;
        let lineRatio = baseLineRatio;
        const minFont = Number.isFinite(options.minFont) ? options.minFont : Math.max(4.8, fontSize * 0.55);
        const minLineRatio = Number.isFinite(options.minLineRatio) ? options.minLineRatio : 1.0;
        if (options.coupleFontAndLine) {
          lineRatio = Math.max(minLineRatio, Math.min(options.maxLineRatio, lineRatio));
        }
        if (options.startFromMinimum) {
          fontSize = minFont;
          lineRatio = minLineRatio;
        }
        let stopReason = "unknown";
        let lastCollision = null;
        applyGroup(nodes, fontSize, lineRatio);
        let safety = 0;
        while (safety < 120 && (!options.allowOverflow || options.enforceInitialCollisionBackoff)) {
          safety += 1;
          const groupState = !options.allowOverflow ? measureGroup(nodes) : null;
          const collision = options.enforceInitialCollisionBackoff
            ? wouldCollideWithBlocks(nodes, options)
            : null;
          const blockingOverflow = Boolean(groupState && groupState.overflow) && !options.allowOverflow;
          if (!blockingOverflow && !collision) break;
          if (trace) trace("initial-backoff", { pass: options.label, fontSize, lineRatio, collision: collision ? textCollisionDetails(nodes, options) : null, overflow: blockingOverflow });
          let changed = false;
          if (!options.coupleFontAndLine && lineRatio > minLineRatio) {
            lineRatio = Math.max(minLineRatio, lineRatio - options.lineStep);
            changed = true;
          } else if (fontSize > minFont) {
            fontSize = Math.max(minFont, fontSize - options.step);
            changed = true;
          }
          applyGroup(nodes, fontSize, lineRatio);
          if (!changed) {
            stopReason = collision ? "min-block-overlap" : "min-overflow";
            break;
          }
        }
        safety = 0;
        const needFillState = options.stopWhenFilled !== false;
        // Purely collision-constrained growth (generic per-node text): the stop
        // condition is a monotone "first colliding tick", with no overflow or fill
        // early-out that would need per-tick measurement. Bracket-and-bisect that
        // boundary instead of probing every tick. Restricted to SINGLE-node groups
        // with a wide remaining range and no initial-backoff anchor (titles); those
        // collide just above baseFont and are better served by the linear scan.
        const remainingTicks = (options.maxFont - fontSize) / options.step;
        const monotoneFontSearch = options.gallop !== false &&
          options.allowOverflow && !needFillState &&
          options.avoidBlockOverlap && !options.coupleFontAndLine &&
          !options.enforceInitialCollisionBackoff &&
          nodes.length === 1 && remainingTicks >= 8;
        if (monotoneFontSearch && fontSize < options.maxFont) {
          const grown = gallopingGrow(fontSize, options.maxFont, options.step, (value) => {
            applyGroup(nodes, value, lineRatio);
            return Boolean(textCollisionDetails(nodes, options));
          });
          fontSize = grown.value;
          applyGroup(nodes, fontSize, lineRatio);
          stopReason = fontSize >= options.maxFont - 1e-6 ? "max-font" : "block-overlap";
        } else {
          while (safety < 80) {
            safety += 1;
            const groupState = (!options.allowOverflow || needFillState) ? measureGroup(nodes) : null;
            if (groupState && groupState.overflow && !options.allowOverflow) {
              stopReason = "overflow";
              break;
            }
            if (needFillState && groupState && groupState.allReachedBand) {
              stopReason = "filled";
              break;
            }
            const nextFont = fontSize + options.step;
            if (nextFont > options.maxFont) {
              stopReason = "max-font";
              break;
            }
            applyGroup(nodes, nextFont, lineRatio);
            const nextState = !options.allowOverflow ? measureGroup(nodes) : null;
            const collision = options.avoidBlockOverlap ? textCollisionDetails(nodes, options) : null;
            if (collision) {
              if (trace) trace("font-grow-collision", { pass: options.label, fontSize: nextFont, lineRatio, collision });
              applyGroup(nodes, fontSize, lineRatio);
              stopReason = "block-overlap";
              lastCollision = collision;
              break;
            }
            if (nextState && nextState.overflow && !options.allowOverflow) {
              applyGroup(nodes, fontSize, lineRatio);
              stopReason = "font-overflow";
              break;
            }
            fontSize = nextFont;
          }
        }
        safety = 0;
        while (!options.coupleFontAndLine && safety < 80 && !(options.skipLineExpansionAfterFontCollision && stopReason === "block-overlap")) {
          safety += 1;
          const groupState = (!options.allowOverflow || needFillState) ? measureGroup(nodes) : null;
          if ((groupState && groupState.overflow && !options.allowOverflow) || (needFillState && groupState && groupState.allReachedBand)) {
            stopReason = groupState && groupState.overflow && !options.allowOverflow ? "overflow" : "filled";
            break;
          }
          const nextRatio = lineRatio + options.lineStep;
          if (nextRatio > options.maxLineRatio) {
            stopReason = "max-line";
            break;
          }
          applyGroup(nodes, fontSize, nextRatio);
          const nextState = !options.allowOverflow ? measureGroup(nodes) : null;
          const collision = options.avoidBlockOverlap ? textCollisionDetails(nodes, options) : null;
          if (collision) {
            applyGroup(nodes, fontSize, lineRatio);
            stopReason = "block-overlap";
            lastCollision = collision;
            break;
          }
          if (nextState && nextState.overflow && !options.allowOverflow) {
            applyGroup(nodes, fontSize, lineRatio);
            stopReason = "line-overflow";
            break;
          }
          lineRatio = nextRatio;
        }
        for (const node of nodes) {
          node.fit = {
            pass: options.label || "",
            stopReason,
            limiter: lastCollision ? lastCollision.source === node : false,
            blocker: lastCollision && lastCollision.source === node ? lastCollision.blockerName : ""
          };
        }
        return { fontSize, lineRatio, stopReason, collision: lastCollision };
      }

      // 正文二次迭代必须始终保持统一字号：所有正文同步增大字号，
      // 发生碰撞时只压缩碰撞源的行距；如果行距降到下限仍无法消除碰撞，
      // 则撤销本轮所有正文的字号增长并结束二次迭代，绝不单独缩小某个正文块。
      function continueUnderfilledNodes(nodes, options) {
        const targetFill = Number.isFinite(options.minTextFillRatio) ? options.minTextFillRatio : 0.85;
        const bodyNodes = (nodes || []).filter(Boolean);
        const fillRatio = (node) => {
          const metrics = measureTextBand(node);
          const clientHeight = geometry(node).clientHeight;
          if (!metrics.hasText || clientHeight <= 0) return 0;
          return Math.min(1, Math.max(0, metrics.lastBottom) / clientHeight);
        };
        if (!bodyNodes.length || !bodyNodes.some((node) => fillRatio(node) < targetFill)) return;
        const minLineRatio = Number.isFinite(options.collisionMinLineRatio) ? options.collisionMinLineRatio : 1.02;
        const snapshotStyles = () => bodyNodes.map((node) => ({
          node,
          fontSize: layoutControlFontSize(node),
          lineRatio: controlLineRatio(node, 1.1)
        }));
        const restoreStyles = (snapshots) => {
          for (const snapshot of snapshots) applyGroup([snapshot.node], snapshot.fontSize, snapshot.lineRatio);
        };
        const recoverCollisionByLineRatio = (source, initialCollision) => {
          let collision = initialCollision;
          const fontSize = layoutControlFontSize(source);
          let lineRatio = controlLineRatio(source, 1.1);
          // 正文碰撞只允许降低碰撞源自己的行距，最低保持 1.02 倍字号；字号
          // 仍属于全文共享状态，禁止任何正文块单独缩小字号。
          for (let safety = 0; collision && safety < 80 && lineRatio > minLineRatio + 0.001; safety += 1) {
            lineRatio = Math.max(minLineRatio, lineRatio - options.lineStep);
            applyGroup([source], fontSize, lineRatio);
            collision = textCollisionDetails([source], options);
          }
          return { collision, fontSize, lineRatio };
        };
        for (let safety = 0; safety < 320; safety += 1) {
          if (!bodyNodes.some((node) => fillRatio(node) < targetFill)) return;
          const snapshots = snapshotStyles();
          const currentFont = Math.min(...snapshots.map((snapshot) => snapshot.fontSize));
          const nextFont = currentFont + options.step;
          if (!Number.isFinite(nextFont) || nextFont > options.maxFont + 0.0001) return;
          // 每个正文块保留自己的行距，但所有正文统一应用同一个候选字号。
          for (const snapshot of snapshots) applyGroup([snapshot.node], nextFont, snapshot.lineRatio);
          let collision = options.avoidBlockOverlap ? textCollisionDetails(bodyNodes, options) : null;
          while (collision) {
            const source = collision.source;
            const recovery = recoverCollisionByLineRatio(source, collision);
            if (trace) trace("shared-grow-collision", { pass: options.label, fontSize: nextFont, collision, recovered: !recovery.collision });
            if (recovery.collision) {
              // 行距已经降到可读下限仍发生碰撞：撤销整组本轮增长并终止，保持正文统一字号。
              restoreStyles(snapshots);
              source.fit = { ...(source.fit || {}), pass: "body-shared", stopReason: "line-backoff-exhausted", limiter: true, blocker: recovery.collision.blockerName };
              return;
            }
            collision = options.avoidBlockOverlap ? textCollisionDetails(bodyNodes, options) : null;
          }
        }
      }

      function tuneGroup(predicate, options) {
        const nodes = scopedNodes(predicate);
        if (!nodes.length) return;
        tuneNodes(nodes, options);
        if (options.continueUnderfilledNodes) continueUnderfilledNodes(nodes, options);
      }

      function tuneEach(predicate, options) {
        for (const node of scopedNodes(predicate)) tuneNodes([node], options);
      }

      // Short single-column transitions inherit the shared body font, then back
      // off locally during the final collision audit if necessary.
      function syncInheritedBodyFontToBodyGroup() {
        const bodyNodes = scopedNodes(Select.body);
        const inheritedNodes = scopedNodes(Select.bodyInherited);
        if (!bodyNodes.length || !inheritedNodes.length) return;
        const fontSize = Math.min(...bodyNodes
          .map((node) => layoutControlFontSize(node, 0))
          .filter((value) => Number.isFinite(value) && value > 0));
        if (!Number.isFinite(fontSize) || fontSize <= 0) return;
        for (const node of inheritedNodes) applyGroup([node], fontSize, controlLineRatio(node, 1.1));
      }

      function titleFrameFill(node) {
        const own = elementBoxInPage(node);
        const ownWidth = Math.max(1, own.right - own.left);
        const ownHeight = Math.max(1, own.bottom - own.top);
        const ink = rectUnion(textRectsInPage(node));
        if (!ink) return { area: 0, width: 0, height: 0 };
        const usedWidth = Math.max(0, Math.min(own.right, ink.right) - Math.max(own.left, ink.left));
        const usedHeight = Math.max(0, Math.min(own.bottom, ink.bottom) - Math.max(own.top, ink.top));
        const width = Math.min(1, usedWidth / ownWidth);
        const height = Math.min(1, usedHeight / ownHeight);
        return { area: width * height, width, height };
      }

      function expandUnderfilledTitles(predicate, options) {
        const areaThreshold = Number.isFinite(options.titleFillAreaThreshold) ? options.titleFillAreaThreshold : 0.42;
        const dimensionThreshold = Number.isFinite(options.titleFillDimensionThreshold) ? options.titleFillDimensionThreshold : 0.72;
        for (const node of scopedNodes(predicate)) {
          const initialFill = titleFrameFill(node);
          if (initialFill.area >= areaThreshold || (
            initialFill.width >= dimensionThreshold && initialFill.height >= dimensionThreshold
          )) continue;
          let fontSize = layoutControlFontSize(node);
          const lineRatio = controlLineRatio(node, 1.12);
          for (let safety = 0; safety < 136 && fontSize + options.step <= options.maxFont; safety += 1) {
            const nextFont = fontSize + options.step;
            applyGroup([node], nextFont, lineRatio);
            if (textCollisionDetails([node], options)) {
              applyGroup([node], fontSize, lineRatio);
              break;
            }
            fontSize = nextFont;
            const fill = titleFrameFill(node);
            if (fill.area >= areaThreshold || (
              fill.width >= dimensionThreshold && fill.height >= dimensionThreshold
            )) break;
          }
        }
      }

      function clusterTitleFontSizes(predicate, maxDifference = 1.0) {
        const nodes = scopedNodes(predicate)
          .map((node) => ({ node, fontSize: layoutControlFontSize(node, 0) }))
          .filter((entry) => entry.fontSize > 0)
          .sort((left, right) => left.fontSize - right.fontSize);
        let cluster = [];
        let clusterMinimum = 0;
        const applyCluster = () => {
          if (cluster.length < 2) return;
          for (const entry of cluster) applyGroup([entry.node], clusterMinimum, controlLineRatio(entry.node, 1.12));
        };
        for (const entry of nodes) {
          if (!cluster.length || entry.fontSize - clusterMinimum <= maxDifference + 0.001) {
            cluster.push(entry);
            if (cluster.length === 1) clusterMinimum = entry.fontSize;
            continue;
          }
          applyCluster();
          cluster = [entry];
          clusterMinimum = entry.fontSize;
        }
        applyCluster();
      }

      function renderedTextLineCount(node, topTolerance = 1.5) {
        const tops = [];
        const rects = textRectsInPage(node).slice().sort((left, right) => (left.top - right.top || left.left - right.left));
        for (const rect of rects) {
          if (!tops.some((top) => Math.abs(top - rect.top) <= topTolerance)) tops.push(rect.top);
        }
        return tops.length;
      }

      function nodeText(node) {
        return (node.content.paragraphs || [])
          .map(paragraph => paragraph.runs.map(run => run.type === "text" ? run.text : run.type === "math" ? run.tex : "\n").join(""))
          .join("\n");
      }

      // Keep a short translated title on one line only when a bounded width
      // extension is collision-free. Use rendered lines, not MinerU's label.
      function keepShortTitlesOnOneLine(predicate, options = {}) {
        const maxCharacters = Number.isFinite(options.maxCharacters) ? options.maxCharacters : 12;
        const maxBorrowPx = Number.isFinite(options.maxBorrowPx) ? options.maxBorrowPx : 18;
        const maxWidthRatio = Number.isFinite(options.maxWidthRatio) ? options.maxWidthRatio : 1.35;
        for (const node of scopedNodes(predicate)) {
          const text = nodeText(node).replace(/\s+/g, " ").trim();
          if (Array.from(text).length < 2 || Array.from(text).length > maxCharacters) continue;
          if (renderedTextLineCount(node) <= 1) continue;
          const originalWidth = node.style.width;
          const originalNowrap = node.style.nowrap;
          const own = elementBoxInPage(node);
          const ownWidth = Math.max(1, own.right - own.left);
          node.style.nowrap = true;
          const ink = rectUnion(textRectsInPage(node));
          if (!ink || renderedTextLineCount(node) !== 1) {
            node.style.width = originalWidth;
            node.style.nowrap = originalNowrap;
            continue;
          }
          const requiredWidth = Math.max(ownWidth, ink.right - own.left + 0.75);
          const borrowedWidth = requiredWidth - ownWidth;
          if (ink.left < own.left - 1.5 || borrowedWidth > maxBorrowPx || requiredWidth / ownWidth > maxWidthRatio) {
            node.style.width = originalWidth;
            node.style.nowrap = originalNowrap;
            continue;
          }
          node.style.width = Number(requiredWidth.toFixed(2));
          const collision = textCollisionDetails([node], {
            avoidBlockOverlap: true,
            avoidPageOverflow: true,
            checkAllTextForCollisions: true
          });
          if (collision) {
            node.style.width = originalWidth;
            node.style.nowrap = originalNowrap;
            continue;
          }
          node.shortTitleNoWrap = true;
        }
      }

      function clampTranslatedOverflow() {
        for (const node of scopedNodes(Select.refs)) {
          let fontSize = layoutControlFontSize(node);
          let lineRatio = controlLineRatio(node, 1.1);
          const isRef = node.flowKind === "ref_text";
          const minFont = isRef ? 4.8 : 5.0;
          const minLineRatio = isRef ? 0.98 : 1.0;
          applyGroup([node], fontSize, lineRatio);
          const overflowing = () => geometry(node).scrollHeight > geometry(node).clientHeight + 1;
          for (let i = 0; i < 120 && overflowing() && (fontSize > minFont || lineRatio > minLineRatio); i += 1) {
            if (lineRatio > minLineRatio) lineRatio = Math.max(minLineRatio, lineRatio - 0.025);
            else fontSize = Math.max(minFont, fontSize - 0.25);
            applyGroup([node], fontSize, lineRatio);
          }
          node.baseFont = Number(fontSize.toFixed(2));
          node.lineRatio = Number(lineRatio.toFixed(3));
        }
      }

      // A translated code block owns a fixed source frame. Let its text become
      // denser before exposing an internal scrollbar; never let the pre silently
      // clip the tail of the translation while the following blocks keep their
      // original positions.
      function clampTranslatedCodeOverflow() {
        if (doc.mode !== "translation") return false;
        let changed = false;
        for (const node of scopedNodes(Select.code)) {
          if (typeof node.content.code !== "string") continue;
          const minFont = 7.0;
          const minLineRatio = 1.10;
          const requestedFont = layoutControlFontSize(node, 10);
          const requestedLineRatio = controlLineRatio(node, 1.18);
          let fontSize = Math.max(minFont, requestedFont);
          let lineRatio = Math.max(minLineRatio, requestedLineRatio);
          if (fontSize !== requestedFont || lineRatio !== requestedLineRatio) changed = true;
          applyGroup([node], fontSize, lineRatio);
          const overflowing = () => geometry(node).codeScrollHeight > geometry(node).codeClientHeight + 1;
          for (let i = 0; i < 160 && overflowing()
            && (lineRatio > minLineRatio + 0.001 || fontSize > minFont + 0.001); i += 1) {
            if (lineRatio > minLineRatio + 0.001) lineRatio = Math.max(minLineRatio, lineRatio - 0.025);
            else fontSize = Math.max(minFont, fontSize - 0.25);
            applyGroup([node], fontSize, lineRatio);
            changed = true;
          }
          // The fallback is explicit and local to the code frame, so it cannot
          // cover or push any content below the positioned block.
          node.codeFit = overflowing() ? "scroll" : "fit";
          node.baseFont = Number(fontSize.toFixed(2));
          node.lineRatio = Number(lineRatio.toFixed(3));
        }
        return changed;
      }

      // All groups are tuned independently, so perform one final glyph-level
      // audit after every style mutation. Unlike the iteration probes, this checks
      // every visible glyph against every layout box, including cross-group cases
      // such as body text beside references. Only a detected source is backed off.
      function enforceFinalTextCollisionSafety() {
        const nodes = scopedNodes(Select.finalAudit);
        const exhausted = new Set();
        const repairCounts = new Map();
        // Covers the full 42px-to-4.8px backoff range with a small margin.
        const MAX_FINAL_COLLISION_REPAIRS_PER_NODE = 192;
        const options = FINAL_AUDIT_OPTIONS;
        // The legacy loop restarted from node zero after every backoff.  That is
        // quadratic. Recheck the changed source, then continue in source order.
        let scanIndex = 0;
        while (scanIndex < nodes.length) {
          const candidate = nodes[scanIndex];
          if (!candidate || exhausted.has(candidate)) {
            scanIndex += 1;
            continue;
          }
          const collision = textCollisionDetails([candidate], options);
          if (!collision) {
            scanIndex += 1;
            continue;
          }
          const source = collision.source;
          const repairs = (repairCounts.get(source) || 0) + 1;
          repairCounts.set(source, repairs);
          if (repairs > MAX_FINAL_COLLISION_REPAIRS_PER_NODE) {
            // The fallback is deliberately local. The rest of the paper still
            // receives an exact audit, and an exceptional source cannot freeze
            // the host by repeatedly restarting the entire document scan.
            exhausted.add(source);
            source.fitLabel = "FINAL collision guard";
            scanIndex += 1;
            continue;
          }
          let fontSize = layoutControlFontSize(source);
          let lineRatio = controlLineRatio(source, 1.1);
          const minFont = source.flowKind === "ref_text" ? 4.8 : 4.8;
          // Short single-column transitions inherit the body baseline but must
          // never constrain its document-wide fit. They can still back off here
          // if a translated sentence genuinely cannot fit its source band.
          const isInheritedBodyText = source.styleKind === "body_text" && source.bodyInherited;
          const isBodyText = source.styleKind === "body_text"
            && (!isInheritedBodyText || !ALLOW_INHERITED_BODY_FONT_BACKOFF);
          const minLineRatio = isBodyText ? 1.02 : 0.98;
          const ownBox = elementBoxInPage(source);
          const firstLineTopCollision = !isBodyText
            && collision.rect
            && collision.rect.top < ownBox.top - 1;
          // Increase leading when first-line ink crosses the source box's top edge.
          if (ALLOW_INHERITED_BODY_FONT_BACKOFF && isInheritedBodyText && fontSize > minFont + 0.001) {
            // The shared body font is restored first. If this one narrow
            // transition cannot fit, only this source may give back font size.
            fontSize = Math.max(minFont, fontSize - 0.25);
          } else if (firstLineTopCollision && lineRatio < 1.85 - 0.001) {
            lineRatio = Math.min(1.85, lineRatio + 0.025);
          } else if (lineRatio > minLineRatio + 0.001) {
            lineRatio = Math.max(minLineRatio, lineRatio - 0.025);
          } else if (isBodyText) {
            // 最终安全检查同样禁止单独缩小正文。行距到底仍冲突时放弃处理该正文块，
            // 避免最后一道检查重新破坏二次迭代已经保证的统一字号。
            exhausted.add(source);
            scanIndex += 1;
            continue;
          } else if (fontSize > minFont + 0.001) {
            fontSize = Math.max(minFont, fontSize - 0.25);
          } else {
            exhausted.add(source);
            scanIndex += 1;
            continue;
          }
          applyGroup([source], fontSize, lineRatio);
          source.fitLabel = "FINAL collision backoff";
        }
      }

      // ----- formulas (fitLayoutFormulas) -----

      function collectPageColumnRights(page) {
        const pageWidth = page.width || 612;
        const nodes = page.nodes.filter(Select.columnCandidate);
        if (!nodes.length) return null;
        const columns = [];
        for (const node of nodes) {
          if (node.refs || node.toc || node.caption || node.title) continue;
          const box = elementBoxInPage(node);
          const left = box.left;
          const width = box.right - box.left;
          const right = left + width;
          if (width > pageWidth * 0.82 || width < 20) continue;
          const key = String(node.columnKey || "");
          if (key === "full") continue;
          let col = key
            ? columns.find(c => c.key === key)
            : columns.find(c => Math.abs(c.anchor - left) < 28);
          if (!col) {
            col = { key: key || `col-${columns.length}`, anchor: left, minLeft: left, maxRight: right };
            columns.push(col);
          } else {
            col.minLeft = Math.min(col.minLeft, left);
            col.maxRight = Math.max(col.maxRight, right);
          }
        }
        return columns.length ? columns : null;
      }

      function calibrateEquationNumberRight(node, columns) {
        const box = elementBoxInPage(node);
        const blockLeft = box.left;
        const blockWidth = box.right - box.left;
        const blockRight = blockLeft + blockWidth;
        let bestCol = null;
        let minDist = Infinity;
        for (const col of columns) {
          const dist = Math.abs(blockLeft - col.anchor);
          if (dist < minDist) {
            minDist = dist;
            bestCol = col;
          }
        }
        if (!bestCol) return;
        let targetRight = bestCol.maxRight;
        const colWidth = Math.max(1, bestCol.maxRight - bestCol.minLeft);
        if (blockWidth >= colWidth * 1.25 || blockRight > bestCol.maxRight + 15) {
          const spanningCols = columns.filter(col => col.maxRight >= blockLeft && col.minLeft <= blockRight + 15);
          if (spanningCols.length > 1) targetRight = Math.max(...spanningCols.map(c => c.maxRight));
        }
        const desiredNumberRightPx = targetRight - blockLeft;
        if (desiredNumberRightPx > 20) {
          const currentVal = Number(node.formula.numberRight || 0);
          if (!currentVal || desiredNumberRightPx > currentVal + 4) {
            node.formula.numberRight = Number(desiredNumberRightPx.toFixed(2));
          }
        }
      }

      function formulaGrowthCollides(page, node) {
        const formulaBox = geometry(node).formulaRect;
        if (!formulaBox || formulaBox.right - formulaBox.left <= 0 || formulaBox.bottom - formulaBox.top <= 0) return false;
        for (const other of page.nodes) {
          if (other === node) continue;
          for (const rect of textRectsInPage(other)) {
            if (layoutRectsOverlap(formulaBox, rect)) return true;
          }
        }
        return false;
      }

      // Binary-search the largest scale in (fitted, wanted] that keeps the formula
      // clear of neighbouring glyphs; the fitted scale is the safe floor.
      function largestClearFormulaScale(page, node, fitted, wanted) {
        let low = fitted;
        let high = wanted;
        for (let step = 0; step < 8 && high - low > 0.005; step += 1) {
          const middle = (low + high) / 2;
          node.formula.scale = roundScale(middle);
          if (formulaGrowthCollides(page, node)) high = middle;
          else low = middle;
        }
        node.formula.scale = roundScale(low);
        return low;
      }

      // style.transform = scale(x.toFixed(4)), or none within 0.005 of 1.
      function roundScale(scale) {
        return Math.abs(scale - 1) > 0.005 ? Number(scale.toFixed(4)) : 1;
      }

      function fitLayoutFormulas({ expand = false } = {}) {
        for (const page of doc.pages) {
          const formulas = page.nodes.filter(node => Select.formula(node) && node.content.formula);
          if (!formulas.length) continue;
          const columns = expand ? collectPageColumnRights(page) : null;
          for (const node of formulas) {
            const hasNumber = Boolean(node.content.number);
            if (expand && hasNumber && columns) calibrateEquationNumberRight(node, columns);
            node.formula.scale = 1;
            const value = geometry(node);
            const blockRect = value.box;
            const blockWidth = blockRect.right - blockRect.left;
            const blockHeight = blockRect.bottom - blockRect.top;
            const formulaRect = value.formulaRect;
            const formulaWidth = formulaRect.right - formulaRect.left;
            const formulaHeight = formulaRect.bottom - formulaRect.top;
            if (blockWidth <= 0 || formulaWidth <= 0) continue;
            const availableWidth = Math.max(1, blockWidth - 4);
            let maxFormulaWidth = availableWidth;
            if (hasNumber && value.numberRect) {
              if (value.numberRect.left > formulaRect.left) {
                const spaceBeforeNumber = value.numberRect.left - formulaRect.left - 8;
                if (spaceBeforeNumber > 10) maxFormulaWidth = Math.min(maxFormulaWidth, spaceBeforeNumber);
              }
            }
            const scaleW = maxFormulaWidth / Math.max(1, formulaWidth);
            // The shrink-only scale is what the text fitter measured against.
            const fittedScale = Math.min(1, scaleW);
            let scale = fittedScale;
            if (expand && blockHeight > 0 && formulaHeight > 0) {
              const targetHeight = blockHeight * 0.92;
              const scaleH = targetHeight / formulaHeight;
              scale = Math.min(scaleW, Math.max(0.7, scaleH), 1.35);
            }
            node.formula.scale = roundScale(scale);
            // This pass runs after text fitting, so neighbouring text cannot move
            // out of the way any more. Growth beyond the fitted scale must stay
            // clear of every other block's glyphs.
            if (expand && scale > fittedScale + 0.005 && formulaGrowthCollides(page, node)) {
              scale = largestClearFormulaScale(page, node, fittedScale, scale);
            }
            node.formula.fitted = scale < .999;
          }
        }
      }

      // ----- runLayoutParityEngine -----

      // Both parsed-source and translated reading views should start compact,
      // then fill until actual glyphs collide. The explicit strict-source view
      // remains an opt-in no-overflow inspection mode.
      const collisionFirstTextFit = !strictSourceFit;

      demoteFalseSingleLineText();
      // Initial pass: shrink-only so oversized un-fitted formulas do not become
      // false body-text barriers during shared font iteration.
      fitLayoutFormulas();

      const titleFitOptions = {
        label: "title",
        step: 0.25,
        minFont: 6.0,
        maxFont: 28.0,
        lineStep: 0.025,
        minLineRatio: 0.98,
        maxLineRatio: 1.35,
        // MinerU title boxes commonly describe the source ink band and are
        // only 10-12px tall.  Let translated headings extend beyond that box;
        // their actual glyphs are still checked against every other block's
        // bbox and against the page boundary below.
        allowOverflow: true,
        stopWhenFilled: false,
        avoidBlockOverlap: true,
        avoidPageOverflow: true,
        checkAllTextForCollisions: true,
        enforceInitialCollisionBackoff: true
      };
      // Article titles retain their own scale.  Every other heading shares one
      // document-wide font/line-height pair, limited by the first heading that
      // reaches another block.  Group peers remain barriers so adjacent
      // section/subsection headings cannot overlap each other.
      tuneEach(Select.mainTitle, { ...titleFitOptions, label: "main-title" });
      tuneGroup(Select.otherTitle, { ...titleFitOptions, includeGroupPeers: true });
      expandUnderfilledTitles(Select.otherTitle, {
        ...titleFitOptions,
        maxFont: 42.0,
        titleFillAreaThreshold: 0.42,
        titleFillDimensionThreshold: 0.72
      });
      clusterTitleFontSizes(Select.anyTitle, 1.0);
      keepShortTitlesOnOneLine(Select.otherTitle, { maxCharacters: 12, maxBorrowPx: 18, maxWidthRatio: 1.35 });
      tuneGroup(Select.body, {
        label: "body",
        step: 0.5,
        minFont: collisionFirstTextFit ? 4.8 : undefined,
        minLineRatio: collisionFirstTextFit ? 1.12 : undefined,
        maxFont: 13,
        lineStep: 0.04,
        maxLineRatio: 1.45,
        // 以原始可读字号作为统一基线。后续二次迭代只允许整组正文同步增大字号，
        // 避免从最小字号起步时被邻近表格或题注不必要地压缩正文。
        allowOverflow: !strictSourceFit,
        avoidBlockOverlap: true,
        avoidPageOverflow: collisionFirstTextFit,
        includeGroupPeers: collisionFirstTextFit,
        // 两栏正文由各自的框宽决定换行；相邻栏的文字不再成为全篇字号上限。
        // 同列上下块、重叠源框及页面边界仍照常保护。
        bodyColumnIndependentFit: true,
        // 只有正文按逐行实际文字检测；其余文本类型保持按布局边框判定。
        bodyTextCollisionGeometry: true,
        // 首轮统一字号本身也可能碰撞，因此先对整组字号做全局安全回退，
        // 再进入“统一字号、局部调行距”的正文二次迭代。
        enforceInitialCollisionBackoff: collisionFirstTextFit,
        // 标题与正文的边界经常完全相邻，首行字形顶部允许少量光学悬出；
        // 正文向下增长，因此仍严格保护底边和左右边界。
        ignoreTopOverflow: collisionFirstTextFit,
        sharedEdgeTolerance: 4.0,
        sharedHorizontalEdgeTolerance: 3.0,
        // 对未填满正文执行二次迭代，但所有正文始终共享同一个字号。
        continueUnderfilledNodes: collisionFirstTextFit,
        minTextFillRatio: 0.85,
        collisionMinLineRatio: 1.02,
        // 首轮共享增长只改字号；二次迭代发生碰撞时，仅允许碰撞源局部降低行距，
        // 禁止任何正文块单独降低字号。
        coupleFontAndLine: true,
        // 首轮字体碰撞后不再对整组放大行距，正文二次迭代会单独处理碰撞源行距。
        skipLineExpansionAfterFontCollision: true
      });
      syncInheritedBodyFontToBodyGroup();
      const genericTextOptions = {
        step: 0.35,
        minFont: collisionFirstTextFit ? 4.8 : undefined,
        minLineRatio: collisionFirstTextFit ? 0.98 : undefined,
        maxFont: 13,
        lineStep: 0.035,
        maxLineRatio: 1.85,
        allowOverflow: !strictSourceFit,
        avoidBlockOverlap: true,
        avoidPageOverflow: collisionFirstTextFit,
        ignoreTopOverflow: collisionFirstTextFit,
        startFromMinimum: collisionFirstTextFit,
        stopWhenFilled: !collisionFirstTextFit
      };
      tuneGroup(Select.list, { ...genericTextOptions, label: "list", includeGroupPeers: collisionFirstTextFit });
      // A recognized contents stream owns its row grid, indentation and page
      // column.  Treating it as generic multi-line prose lets the fitter
      // change its fixed 8.2px/1.22 baseline and can clip a dense directory.
      tuneEach(Select.debugTextMulti, { ...genericTextOptions, label: "text" });
      tuneEach(Select.textBlockMulti, { ...genericTextOptions, label: "text-block" });
      const captionOptions = {
        step: 0.25,
        minFont: 5.2,
        maxFont: 10.5,
        lineStep: 0.025,
        minLineRatio: 1.0,
        maxLineRatio: 1.55,
        allowOverflow: false,
        avoidBlockOverlap: true
      };
      for (const type of ["table_caption", "table_footnote", "chart_caption", "image_caption", "image_footnote"]) {
        tuneGroup(Select.captionType(type), { ...captionOptions, label: `caption:${type}` });
      }
      tuneGroup(Select.refs, {
        label: "refs",
        step: 0.25,
        minFont: 4.8,
        maxFont: 12,
        lineStep: 0.025,
        minLineRatio: 0.98,
        maxLineRatio: 1.65,
        allowOverflow: false,
        avoidBlockOverlap: true
      });
      if (fitOptions.translatedClamp) clampTranslatedOverflow();
      clampTranslatedCodeOverflow();
      enforceFinalTextCollisionSafety();
      // A document may save a manual body-font override. Re-fitting must
      // retain it, with line height scaled alongside the font.
      const userBodyFontPt = Number(fitOptions.userBodyFontPt);
      if (Number.isFinite(userBodyFontPt) && userBodyFontPt > 0) {
        for (const node of all) {
          if (isStream(node) && node.styleKind === "body_text" && node.flowKind === "text") {
            node.style.fontSize = Number((userBodyFontPt * 4 / 3).toFixed(2));
            node.userBodyFontPt = Number(userBodyFontPt.toFixed(2));
          }
        }
      }
      // Post-pass: adapt formulas to bbox and right-align equation numbers.
      fitLayoutFormulas({ expand: true });
    }

    // ----- output -----

    function serialize(doc, mode) {
      return {
        mode,
        pages: doc.pages.map(page => ({
          index: page.index,
          width: page.width,
          height: page.height,
          nodes: page.nodes.map(node => {
            const value = geometry(node);
            const box = value.box;
            const out = {
              id: node.id,
              label: nodeLabel(node),
              kind: node.kind,
              type: node.type || "",
              styleKind: node.styleKind || "",
              flowKind: node.flowKind || "",
              bbox: [box.left, box.top, box.right, box.bottom],
              fontSize: layoutControlFontSize(node),
              lineHeight: effectiveLineRatio(node),
              styleLineHeight: node.style.lineRatio,
              align: textAlign(node),
              lines: value.lines,
              textRects: value.text,
              // Rendered content (text plus opaque media; the box when empty):
              // the geometry body text is tested against.
              contentRects: renderedContentRectsInPage(node),
              fit: node.fit,
              fitLabel: node.fitLabel || ""
            };
            if (node.content.paragraphs) out.paragraphs = node.content.paragraphs.map(paragraph => ({ runs: paragraph.runs, indent: paragraph.indent }));
            if (node.toc) out.tocRows = node.content.raw.tocRows;
            if (node.formula) {
              out.formula = {
                scale: node.formula.scale,
                numberRight: node.formula.numberRight,
                runs: node.content.formulaRuns || [],
                number: node.content.numberText || "",
                rect: value.formulaRect || null,
                numberRect: value.numberRect || null
              };
            }
            if (typeof node.content.code === "string") out.code = { text: node.content.code, fit: node.codeFit || "" };
            if (node.shortTitleNoWrap) out.nowrap = true;
            if (node.userBodyFontPt) out.userBodyFontPt = node.userBodyFontPt;
            return out;
          })
        }))
      };
    }

    function nodeLabel(node) {
      const kind = isStream(node) ? `stream:${node.styleKind || ""}/${node.flowKind || ""}` : `block:${node.blockKind || ""}`;
      return `${kind}#${node.id || "?"}`;
    }

    return { fitDocument };
  }

  const FINAL_AUDIT_OPTIONS = Object.freeze({
    avoidBlockOverlap: true,
    avoidPageOverflow: true,
    includeGroupPeers: true,
    checkAllTextForCollisions: true,
    ignoreTopOverflow: false,
    ignoreBodyTopOverflow: true,
    bodyColumnIndependentFit: true,
    bodyTextCollisionGeometry: true,
    sharedEdgeTolerance: 4.0,
    sharedHorizontalEdgeTolerance: 3.0
  });

  return {
    createModelFitter,
    defaultContentFor,
    FINAL_AUDIT_OPTIONS,
    OBJECT,
    LINE_SEPARATOR,
    // Pure helpers exposed for unit tests; not a stable API.
    _internal: { gallopingGrow, rectsOverlap, rectUnion, layoutRectsOverlap, horizontalBoxesOverlap, collapseRuns, textToRuns, htmlToRuns }
  };
});
