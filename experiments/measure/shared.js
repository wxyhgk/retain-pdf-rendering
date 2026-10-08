"use strict";

const { splitMath } = require("../typst/content");

// Same sentences as experiments/typst/run.js --demo-inline-math.
const DEMO_SENTENCES = [
  "其中冲击阻抗 \\(Z = \\rho_0 u_s\\)，粒子速度 \\(u_p\\) 与压力增量 \\(p - p_0 = \\rho_0 u_s u_p\\) 成正比。",
  "能量守恒给出 \\(E - E_0 = \\frac{1}{2}(p + p_0)(V_0 - V)\\)，残差 \\(\\sum_{i=1}^{n} \\varepsilon_i^2\\) 小于 \\(10^{-3}\\)。",
  "未知宏 \\(\\unknownmacro{x}\\) 应以原文 LaTeX 兜底显示。"
];

function mathSegments(text) {
  return splitMath(text);
}

// A formula MathJax cannot render is emitted as rpr-tex-fallback: raw text
// (DejaVu Sans Mono, 0.602 em advance, at 0.8 em) in one unbreakable box.
// Vertical extent: DejaVu Sans Mono ascender/descender at 0.8 em.
function FALLBACK_BOX(tex) {
  return { widthEm: 0.602 * 0.8 * [...tex].length, heightEm: 0.8 * (0.928 + 0.236), depthEm: 0.8 * 0.236, fallback: true };
}

module.exports = { DEMO_SENTENCES, mathSegments, FALLBACK_BOX };
