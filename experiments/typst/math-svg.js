"use strict";

// LaTeX -> self-contained SVG via MathJax 3 (lite DOM, no browser).
//
// Units: MathJax's SVG output sizes the <svg> in `ex`, where 1ex is the
// x-height of MathJax's own TeX font (font.params.x_height, 0.442em for the
// default font). We render with em = 16 and ex = 16 * x_height so MathJax's
// scale factor is exactly 1; then a length in ex converts to em of the
// surrounding text as `ex * x_height`. The value is read from the output jax
// rather than hard-coded.

const { mathjax } = require("mathjax-full/js/mathjax.js");
const { TeX } = require("mathjax-full/js/input/tex.js");
const { SVG } = require("mathjax-full/js/output/svg.js");
const { liteAdaptor } = require("mathjax-full/js/adaptors/liteAdaptor.js");
const { RegisterHTMLHandler } = require("mathjax-full/js/handlers/html.js");
const { AllPackages } = require("mathjax-full/js/input/tex/AllPackages.js");

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

const svgOutput = new SVG({ fontCache: "none" });
const texInput = new TeX({ packages: AllPackages.filter(name => name !== "bussproofs") });
const html = mathjax.document("", { InputJax: texInput, OutputJax: svgOutput });

const EM = 16;
const X_HEIGHT = svgOutput.font.params.x_height;
const EX = EM * X_HEIGHT;

const cache = new Map();

function exValue(value) {
  const match = /^(-?[\d.]+)ex$/.exec(String(value || "").trim());
  return match ? Number(match[1]) : NaN;
}

// Returns { ok, svg, widthEm, heightEm, depthEm, error } for one formula.
// heightEm is the full box height, depthEm how far it reaches below the
// baseline (MathJax's negative vertical-align). Never throws: unparsable or
// unsupported input yields ok:false and the caller falls back to text.
function texToSVG(tex, display = false) {
  const key = `${display ? "D" : "I"}:${tex}`;
  if (cache.has(key)) return cache.get(key);
  let result;
  try {
    const node = html.convert(String(tex || ""), { display, em: EM, ex: EX, containerWidth: 80 * EM });
    const svg = adaptor.firstChild(node);
    const markup = adaptor.outerHTML(svg);
    // Parse errors become <merror>; unknown macros are kept by the
    // `noundefined` package as red <mtext>. Both mean "not really rendered".
    const error = adaptor.getAttribute(svg, "data-mjx-error")
      || (markup.includes('data-mml-node="merror"') ? "merror" : "")
      || (/data-mml-node="mtext" fill="red"/.test(markup) ? "undefined macro" : "");
    const widthEx = exValue(adaptor.getAttribute(svg, "width"));
    const heightEx = exValue(adaptor.getAttribute(svg, "height"));
    const style = adaptor.getAttribute(svg, "style") || "";
    const valign = /vertical-align:\s*(-?[\d.]+)ex/.exec(style);
    const depthEx = valign ? -Number(valign[1]) : 0;
    if (error || !Number.isFinite(widthEx) || !Number.isFinite(heightEx)) {
      result = { ok: false, error: error || "no size", tex };
    }
    else {
      adaptor.setAttribute(svg, "xmlns", "http://www.w3.org/2000/svg");
      result = {
        ok: true,
        tex,
        svg: adaptor.outerHTML(svg),
        widthEm: widthEx * X_HEIGHT,
        heightEm: heightEx * X_HEIGHT,
        depthEm: depthEx * X_HEIGHT
      };
    }
  }
  catch (error) {
    result = { ok: false, error: String(error?.message || error), tex };
  }
  cache.set(key, result);
  return result;
}

module.exports = { texToSVG, X_HEIGHT };
