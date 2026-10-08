// Taxonomy of math-delimiter usage in the retain-pdf corpus and failures of a
// content pipeline. Usage: node analyze.js [--field translated|source] [--examples N] [--failures N]
"use strict";
const path = require("node:path");
const { buildCorpus } = require("./corpus");
const Text = require("../../src/text/measurer");
const { texToSVG, renderMathBox } = require("../../src/text/mathjax-node");

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const pipelineName = opt("--pipeline", "new");
const field = opt("--field", "translated");
const exampleCount = Number(opt("--examples", 3));

// Production scanner (src/text/measurer.js). failedMath "box" keeps failed
// formulas as math runs flagged `fallback` so they can be counted here; the
// default path turns them into plain text.
const pipelines = {
  new: text => Text.contentFromText(text, { renderMathBox, failedMath: "box" })
};

const PATTERNS = {
  "display $$..$$": /\$\$[^$]+?\$\$/g,
  "adjacent inline $a$$b$": /(?<![\\$])\$[^$\n]+?\$\$[^$\n]+?\$(?!\$)/g,
  "padded inline $ x $": /(?<![\\$])\$[ \t]+[^$\n]*?\$|(?<![\\$])\$[^$\n]*?[ \t]+\$(?!\$)/g,
  "\\(..\\)": /\\\([\s\S]+?\\\)/g,
  "\\[..\\]": /\\\[[\s\S]+?\\\]/g,
  "double-escaped \\\\( or \\\\[": /\\\\[([]/g,
  "escaped \\$": /\\\$/g,
  "currency-like $<digit> outside math": /(?:US|HK|C|A)?\$\d[\d,.]*(?!\S*\$)/g,
  "citation $^{[n]}$": /\$\s*\^\s*\{?\s*\[[^\]]+\]\s*\}?\s*\$/g,
  "citation placeholder [[n]]": /\[\[[^\]]+\]\]/g,
  "math with newline inside $..$": /(?<![\\$])\$[^$]*\n[^$]*\$/g,
  "\\text{} inside math": /\\text\{/g
};

function unescapedDollarCount(text) {
  return (text.replace(/\\\$/g, "").match(/\$/g) || []).length;
}

const corpus = buildCorpus("/Users/virtualized/Code/retain-pdf/data/jobs");
const entries = field === "source" ? corpus.source : corpus.translated;
const withMath = entries.filter(entry => /\$|\\\(|\\\[/.test(entry.text));
const taxonomy = {};
for (const [name, pattern] of Object.entries(PATTERNS)) {
  let texts = 0, occurrences = 0;
  const examples = [];
  for (const entry of withMath) {
    const found = entry.text.match(pattern);
    if (found) { texts += 1; occurrences += found.length; if (examples.length < exampleCount) examples.push(found[0].slice(0, 80)); }
  }
  taxonomy[name] = { texts, occurrences, examples };
}
const oddDollar = withMath.filter(entry => unescapedDollarCount(entry.text) % 2 === 1);
taxonomy["odd number of unescaped $"] = { texts: oddDollar.length, examples: oddDollar.slice(0, exampleCount).map(e => e.text.slice(0, 120)) };

const run = pipelines[pipelineName];
const failures = { literalDelimiter: [], visibleEscape: [], mathjaxError: [] };
let mathRuns = 0;
const { scanMath } = require("./delimiters");
for (const entry of withMath) {
  const runs = run(entry.text);
  for (const r of runs) {
    if (r.type === "text" && /\\\$/.test(r.text)) failures.visibleEscape.push({ where: entry.where, text: r.text.slice(0, 160) });
    if (r.type === "text" && pipelineName === "current" && /(?<!\\)\$|\\\(|\\\)|\\\[|\\\]/.test(r.text)) failures.literalDelimiter.push({ where: entry.where, text: r.text.slice(0, 160) });
    if (r.type === "math") {
      mathRuns += 1;
      if (r.fallback) failures.mathjaxError.push({ where: entry.where, tex: r.tex.slice(0, 120), error: texToSVG(r.tex, r.display).error });
    }
  }
  if (pipelineName === "new") {
    // Unescaped dollars the scanner left as text (an opening that did not close).
    const consumed = scanMath(entry.text).filter(s => s.type === "math");
    const inside = index => consumed.some(s => index >= s.start && index < s.end);
    for (let i = 0; i < entry.text.length; i++) {
      if (entry.text[i] !== "$") continue;
      let k = 0; for (let j = i - 1; j >= 0 && entry.text[j] === "\\"; j--) k++;
      if (k % 2 === 0 && !inside(i)) failures.literalDelimiter.push({ where: entry.where, text: entry.text.slice(Math.max(0, i - 40), i + 60) });
    }
  }
}
const textsWithLiteral = new Set(failures.literalDelimiter.map(f => f.where)).size;
const textsWithError = new Set(failures.mathjaxError.map(f => f.where)).size;
const result = {
  pipeline: pipelineName, field, jobs: corpus.jobs, uniqueTexts: entries.length, textsWithMath: withMath.length,
  mathRuns, literalDelimiterRuns: failures.literalDelimiter.length, textsWithLiteral,
  mathjaxErrorRuns: failures.mathjaxError.length, textsWithMathjaxError: textsWithError, visibleBackslashDollar: failures.visibleEscape.length
};
console.log(JSON.stringify(result));
if (args.includes("--taxonomy")) console.log(JSON.stringify(taxonomy, null, 1));
if (args.includes("--failures")) {
  console.log("--- literal delimiter examples");
  for (const f of failures.literalDelimiter.slice(0, Number(opt("--failures", 15)))) console.log(f.where.split("/").slice(-2).join("/"), "|", JSON.stringify(f.text));
  console.log("--- visible \\$ examples");
  for (const f of failures.visibleEscape.slice(0, 5)) console.log(f.where.split("/").slice(-2).join("/"), "|", JSON.stringify(f.text));
  console.log("--- mathjax error examples");
  const byError = {};
  for (const f of failures.mathjaxError) (byError[f.error] ||= []).push(f.tex);
  for (const [error, list] of Object.entries(byError)) console.log(list.length, error, "|", list.slice(0, 5).map(t => JSON.stringify(t)).join("  "));
}
