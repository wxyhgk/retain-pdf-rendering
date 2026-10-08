"use strict";

// LaTeX -> self-contained SVG via MathJax 3: the implementation moved to
// src/text/mathjax-node.js; this keeps the prototype's interface.

const { createMathRenderer } = require("../../src/text/mathjax-node");

const renderer = createMathRenderer();

module.exports = {
  texToSVG: renderer.texToSVG,
  get X_HEIGHT() { return renderer.xHeight; }
};
