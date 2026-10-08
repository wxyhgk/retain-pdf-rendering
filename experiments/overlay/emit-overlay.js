"use strict";

// Overlay Typst for fit-model results: one transparent page per source page;
// each repainted node gets a filled cover rectangle (the source's background
// colour from retain-pdf's visual profile) and its fitted lines placed at the
// computed baselines. Obstacles (formulas, figures, headers ...) are never
// painted: the source PDF keeps them.

const { PREAMBLE, FONT_FAMILY } = require("../typst/emit");
const { emitTextNode, fmt } = require("../typst/emit-model");

function rgb(values) {
  const [r, g, b] = (values || [1, 1, 1]).map(value => Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 255));
  return `rgb(${r}, ${g}, ${b})`;
}

function overlayDocument(fitted, paint, maths) {
  const out = [
    `#set text(font: "${FONT_FAMILY}", lang: "zh")`,
    PREAMBLE
  ];
  let painted = 0;
  fitted.pages.forEach((page, index) => {
    if (index) out.push("#pagebreak()");
    out.push(`#set page(width: ${fmt(page.width)}pt, height: ${fmt(page.height)}pt, margin: 0pt, fill: none)`);
    const nodes = page.nodes.filter(node => paint[node.id] && node.lines && node.lines.length);
    // Covers first, then text, so no cover hides another node's overflow.
    for (const node of nodes) {
      const cover = paint[node.id].cover;
      out.push(`#place(top + left, dx: ${fmt(cover[0])}pt, dy: ${fmt(cover[1])}pt, rect(width: ${fmt(cover[2] - cover[0])}pt, height: ${fmt(cover[3] - cover[1])}pt, fill: ${rgb(paint[node.id].fill)}, stroke: none))`);
    }
    for (const node of nodes) {
      out.push(`#[`, `#set text(fill: ${rgb(paint[node.id].text)})`, ...emitTextNode(node, maths), `]`);
      painted += 1;
    }
    if (!page.nodes.length) out.push("#box()");
  });
  return { source: out.join("\n") + "\n", painted };
}

module.exports = { overlayDocument };
