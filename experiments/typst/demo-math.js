"use strict";

// The golden fixtures contain no inline TeX. --demo-inline-math appends
// sentences with inline formulas (sub/superscripts, a fraction, a sum, a
// command MathJax does not know) to a few body translations so the inline
// path, baseline alignment and copy-out can be inspected.
const DEMO_SENTENCES = [
  "其中冲击阻抗 \\(Z = \\rho_0 u_s\\)，粒子速度 \\(u_p\\) 与压力增量 \\(p - p_0 = \\rho_0 u_s u_p\\) 成正比。",
  "能量守恒给出 \\(E - E_0 = \\frac{1}{2}(p + p_0)(V_0 - V)\\)，残差 \\(\\sum_{i=1}^{n} \\varepsilon_i^2\\) 小于 \\(10^{-3}\\)。",
  "未知宏 \\(\\unknownmacro{x}\\) 应以原文 LaTeX 兜底显示。"
];

function injectDemoMath(model) {
  let count = 0;
  for (const page of model.pages) {
    for (const stream of page.restoration?.streams || []) {
      if (stream.styleKind !== "body_text" || count >= DEMO_SENTENCES.length) continue;
      const item = stream.items?.[0];
      if (!item) continue;
      // Items keep separate copies of their parts under paragraphs[].parts.
      const lastParagraph = item.paragraphs?.length ? item.paragraphs[item.paragraphs.length - 1] : null;
      const parts = lastParagraph?.parts?.length ? lastParagraph.parts : (item.parts?.length ? item.parts : [item]);
      const part = parts[parts.length - 1];
      const sentence = DEMO_SENTENCES[count++];
      part.translatedText = `${part.translatedText || part.text}${sentence}`;
      part.text = `${part.text} ${sentence.replace(/[一-鿿，。、]+/g, " ")}`;
    }
  }
  return count;
}

module.exports = { DEMO_SENTENCES, injectDemoMath };
