// retain-pdf-rendering/typeset
// Host-agnostic: never reference the host application or plugin globals here.
//
// The typesetting engine. It sets text exactly as it is told: every block
// comes with its box, content, font size, line height, alignment and weight,
// and the engine breaks the lines, justifies them and places every line. It
// never changes a size to make something fit; deciding sizes is a separate
// policy (e.g. retain-pdf's own rules, or src/fit-model as one such policy).
// Instead it reports what it finds: lines that leave their box or the page,
// and ink that overlaps another block or a preserved element.
//
//   const engine = Typeset.createTypesetter({ measurer, measurers: { bold } });
//   const result = engine.typeset(document);
//
// document.pages[]: { index, width, height, blocks[], obstacles[] }
//   block:    { id, box: [x0, y0, x1, y1], paragraphs: [{ runs }],
//               fontSize (pt), lineHeight (em, baseline to baseline),
//               paragraphSpacing (em, extra between paragraphs, default 0),
//               firstBaseline (pt below box top, default ascender * fontSize),
//               align: "justify" | "left" | "center" | "right",
//               firstLineIndent (em, default 0), fontWeight: "regular" | "bold",
//               justifyCap (em of stretch per justifiable gap, default none) }
//   obstacle: { id, box } — content kept from the source page (figures,
//               formulas, tables, untranslated text) that text must not cover.
//   runs: Text content runs ({type:"text"}, {type:"math", widthEm, ...}, {type:"break"}).
//
// result.pages[].nodes[]: { id, bbox, fontSize, fontWeight, align,
//   paragraphs, lines: [{ paragraph, start, end, x, baseline, width,
//   justified, glyphTop, glyphBottom }], textRects }
// result.report: { blocks: { [id]: { lines, overflowBottom, overflowRight,
//   outsidePage } }, collisions: [{ page, a, b, kind, overlap, insideOwnBox }] }
//
// Vertical model: line n's baseline is firstBaseline + n * lineHeight *
// fontSize from the box top (plus paragraphSpacing between paragraphs); a
// line holding an inline formula taller than the font's ascender (or deeper
// than its descender) pushes itself and everything below down by the
// difference. Ink of a line spans ascender..descender of the font, widened
// by any formula box.
(function (root, factory) {
  "use strict";
  const isNode = typeof module === "object" && module && module.exports;
  const namespace = isNode ? null : (root.RetainPdfRendering || {});
  const linebreak = isNode ? require("../text/linebreak") : namespace.TextLinebreak;
  const api = factory(linebreak);
  if (isNode) module.exports = api;
  else (root.RetainPdfRendering = root.RetainPdfRendering || {}).Typeset = api;
})(typeof this === "object" && this ? this : globalThis, function (Linebreak) {
  "use strict";

  if (!Linebreak) throw new Error("retain-pdf-rendering/typeset: load text/linebreak.js first");

  const EPS = 1e-6;

  function overlap(a, b) {
    const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return x > EPS && y > EPS ? { x, y } : null;
  }

  function toRect(box) {
    return { left: box[0], top: box[1], right: box[2], bottom: box[3] };
  }

  function createTypesetter(config = {}) {
    const measurer = config.measurer;
    if (!measurer || typeof measurer.layout !== "function") throw new TypeError("createTypesetter needs a Text measurer");
    const measurers = config.measurers || {};
    const measurerFor = weight => (weight === "bold" && measurers.bold) || measurer;

    function setBlock(block) {
      const using = measurerFor(block.fontWeight);
      const metrics = using.metrics || {};
      const fontSize = Number(block.fontSize);
      const lineHeight = Number(block.lineHeight);
      if (!(fontSize > 0) || !(lineHeight > 0)) throw new RangeError(`block ${block.id}: fontSize and lineHeight must be positive`);
      const [x0, y0, x1, y1] = block.box.map(Number);
      const width = Math.max(1, x1 - x0);
      const ascent = (Number(metrics.ascender) || 0.88) * fontSize;
      const descent = (Number(metrics.descender) || 0.12) * fontSize;
      const firstBaseline = Number.isFinite(Number(block.firstBaseline)) ? Number(block.firstBaseline) : ascent;
      const pitch = lineHeight * fontSize;
      const spacing = (Number(block.paragraphSpacing) || 0) * fontSize;
      const align = block.align || "justify";
      const cap = Number.isFinite(Number(block.justifyCap)) && Number(block.justifyCap) >= 0 ? Number(block.justifyCap) : null;

      const paragraphs = (block.paragraphs || []).map(paragraph => ({ runs: paragraph.runs || [] }));
      const lines = [];
      let baseline = y0 + firstBaseline;
      let first = true;
      let carry = 0; // how far the previous line's formula reached below the descender
      paragraphs.forEach((paragraph, index) => {
        const prepared = using.prepare(paragraph.runs);
        const indentEm = Number((block.paragraphs[index] || {}).firstLineIndent ?? block.firstLineIndent) || 0;
        const laid = using.layout(prepared, { fontSize, lineHeight: 1, width, align, firstLineIndentEm: indentEm });
        if (!first && laid.lines.length) baseline += spacing;
        for (const line of laid.lines) {
          const above = Math.max(ascent, Number(line.ascent) || 0);
          const below = Math.max(descent, Number(line.descent) || 0);
          // A formula taller than the font (or one deeper than the descender
          // on the line above) pushes this line and everything below down.
          const extraAbove = above - ascent;
          baseline += first ? extraAbove : pitch + extraAbove + carry;
          carry = below - descent;
          first = false;
          let painted = line.width;
          let justified = Boolean(line.justified);
          if (justified) {
            const available = Number.isFinite(line.available) ? line.available : line.width;
            painted = available;
            if (cap !== null) {
              const gaps = Linebreak.justifiableGaps(prepared, line.start, line.end);
              const capped = line.width + gaps * cap * fontSize;
              if (capped < available - EPS) { painted = capped; justified = gaps > 0; }
            }
          }
          lines.push({
            paragraph: index, start: line.start, end: line.end,
            x: x0 + line.x, baseline, width: painted, naturalWidth: line.width, justified,
            glyphTop: baseline - above, glyphBottom: baseline + below
          });
        }
      });
      const textRects = lines.map(line => ({ left: line.x, right: line.x + line.width, top: line.glyphTop, bottom: line.glyphBottom }));
      return {
        node: {
          id: String(block.id), bbox: [x0, y0, x1, y1], fontSize, lineHeight, fontWeight: block.fontWeight || "regular",
          align, paragraphs, lines, textRects
        },
        width
      };
    }

    function typeset(document) {
      const pages = [];
      const blocks = {};
      const collisions = [];
      for (const page of document.pages || []) {
        const nodes = (page.blocks || []).map(block => setBlock(block).node);
        for (const node of nodes) {
          const [x0, y0, x1, y1] = node.bbox;
          const inkBottom = node.textRects.reduce((v, r) => Math.max(v, r.bottom), -Infinity);
          const inkRight = node.textRects.reduce((v, r) => Math.max(v, r.right), -Infinity);
          blocks[node.id] = {
            page: page.index,
            lines: node.lines.length,
            overflowBottom: node.lines.length ? Math.max(0, inkBottom - y1) : 0,
            overflowRight: node.lines.length ? Math.max(0, inkRight - x1) : 0,
            outsidePage: node.textRects.some(r => r.left < -EPS || r.top < -EPS || r.right > page.width + EPS || r.bottom > page.height + EPS)
          };
        }
        // Ink against ink of every other block, and against preserved elements.
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            let worst = null;
            for (const a of nodes[i].textRects) for (const b of nodes[j].textRects) {
              const o = overlap(a, b);
              if (o && (!worst || o.y * o.x > worst.y * worst.x)) worst = o;
            }
            if (worst) collisions.push({ page: page.index, a: nodes[i].id, b: nodes[j].id, kind: "text", overlap: worst });
          }
          for (const obstacle of page.obstacles || []) {
            const box = toRect(obstacle.box.map(Number));
            const own = toRect(nodes[i].bbox);
            let worst = null;
            let outside = false;
            for (const r of nodes[i].textRects) {
              const o = overlap(r, box);
              if (!o) continue;
              if (!worst || o.y * o.x > worst.y * worst.x) worst = o;
              const part = { left: Math.max(r.left, box.left), top: Math.max(r.top, box.top), right: Math.min(r.right, box.right), bottom: Math.min(r.bottom, box.bottom) };
              if (!(part.left >= own.left - EPS && part.right <= own.right + EPS && part.top >= own.top - EPS && part.bottom <= own.bottom + EPS)) outside = true;
            }
            // insideOwnBox: every overlapping part lies inside the block's own
            // box, i.e. the boxes already overlapped in the source.
            if (worst) collisions.push({ page: page.index, a: nodes[i].id, b: String(obstacle.id), kind: "obstacle", overlap: worst, insideOwnBox: !outside });
          }
        }
        pages.push({ index: page.index, width: page.width, height: page.height, nodes });
      }
      return { pages, report: { blocks, collisions } };
    }

    return { typeset, setBlock: block => setBlock(block).node };
  }

  return { createTypesetter };
});
