"use strict";

// Text.scanMath / normalizeTeX / contentFromText (src/text/measurer.js).
// Cases are taken from retain-pdf translation payloads (31 jobs, 2,259
// unique texts; experiments/math-delims).
const test = require("node:test");
const assert = require("node:assert/strict");
const Text = require("../src/text/measurer");
const { scanMath, normalizeTeX } = Text;
const contentFromMarkedText = (text, options) => Text.contentFromText(text, options);

const math = text => scanMath(text).filter(s => s.type === "math").map(s => [s.tex, s.display]);
const prose = text => scanMath(text).filter(s => s.type === "text").map(s => s.text).join("|");

test("math-delimiters: adjacent inline formulas are two formulas", () => {
  assert.deepEqual(math(String.raw`肥胖:BMI $\geq 30.0\text{kg/m}^2$$^{[83]}$。过去`),
    [[String.raw`\geq 30.0\text{kg/m}^2`, false], ["^{[83]}", false]]);
  assert.deepEqual(math(String.raw`$\mathrm{Mn}(\mathrm{dpm})_3$$^{24}$ 和`),
    [[String.raw`\mathrm{Mn}(\mathrm{dpm})_3`, false], ["^{24}", false]]);
});

test("math-delimiters: escaped dollars", () => {
  assert.deepEqual(math(String.raw`总反应成本约为 $\$1.4$。简单`), [[String.raw`\$1.4`, false]]);
  assert.equal(prose(String.raw`商业价格为 \$368/8 g，或者`), "商业价格为 $368/8 g，或者");
});

test("math-delimiters: padded inline math is trimmed, empty is literal", () => {
  assert.deepEqual(math(String.raw`或 $ \geq $ 150min/week`), [[String.raw`\geq`, false]]);
  assert.deepEqual(math("a $ $ b"), []);
  assert.equal(prose("a $ $ b"), "a $ $ b");
});

test("math-delimiters: display forms and inline followed by display", () => {
  assert.deepEqual(math("$$E=mc^2$$"), [["E=mc^2", true]]);
  assert.deepEqual(math("$a$$$b$$"), [["a", false], ["b", true]]);
  assert.deepEqual(math(String.raw`x \(y_1\) z \[w\]`), [["y_1", false], ["w", true]]);
});

test("math-delimiters: newline or unbalanced dollars stay text", () => {
  assert.deepEqual(math("a $x\ny$ b"), []);
  // Odd count: the currency dollar is literal, the formula still parses.
  assert.deepEqual(math("costs US$5 and $x^2$ here"), [["x^2", false]]);
  assert.equal(prose("costs US$5 and $x^2$ here"), "costs US$5 and | here");
});

test("math-delimiters: braces and backslashes inside math never close it", () => {
  assert.deepEqual(math(String.raw`$\{a\}\$ b$ c`), [[String.raw`\{a\}\$ b`, false]]);
});

test("math-delimiters: normalizeTeX repairs macros MathJax lacks", () => {
  assert.equal(normalizeTeX(String.raw`2.5\ \text{\AA}`), String.raw`2.5\ \text{Å}`);
  assert.equal(normalizeTeX(String.raw`\L{}`), "Ł");
  assert.equal(normalizeTeX(String.raw`S'_{rs}' = \langle \chi'_r | \chi'_s \rangle`), String.raw`S'_{rs}{}' = \langle \chi'_r | \chi'_s \rangle`);
  assert.equal(normalizeTeX(String.raw`\left( \label{x} \lambda \right)`), String.raw`\left( \label{x} \lambda \right)`);
});

test("math-delimiters: corpus cases render with MathJax", { skip: !hasMathJax() && "mathjax-full missing" }, () => {
  const { renderMathBox } = require("../src/text/mathjax-node");
  for (const text of [
    String.raw`BMI $\geq 30.0\text{kg/m}^2$$^{[83]}$。`,
    String.raw`约为 $\$1.4$。`,
    String.raw`距离 $2.5\ \text{\AA}$`,
    String.raw`$S'_{rs}' = \delta_{rs}$`
  ]) {
    const runs = contentFromMarkedText(text, { renderMathBox });
    assert.ok(runs.filter(r => r.type === "math").length > 0, text);
    assert.ok(runs.filter(r => r.type === "text").every(r => !/\$/.test(r.text)), text);
  }
});

test("math-delimiters: a formula that cannot render becomes plain text without delimiters", () => {
  const runs = Text.contentFromText("前 $\\badmacro{x}$ 后 $y$", { renderMathBox: tex => (tex === "y" ? { widthEm: 1, heightEm: .8, depthEm: .2 } : null) });
  assert.deepEqual(runs.map(r => r.type === "math" ? ["math", r.tex] : [r.type, r.text]),
    [["text", "前 "], ["text", "\\badmacro{x}"], ["text", " 后 "], ["math", "y"]]);
  const noRenderer = Text.contentFromText("a $x$ b");
  assert.ok(noRenderer.every(r => r.type === "text"), "without a renderer every formula is text");
  const box = Text.contentFromText("a $x$", { failedMath: "box" }).find(r => r.type === "math");
  assert.equal(box.fallback, true, "failedMath: box keeps the raw-LaTeX box as an explicit opt-in");
});

function hasMathJax() {
  try { require.resolve("mathjax-full/js/mathjax.js"); return true; } catch { return false; }
}
