#!/usr/bin/env node
"use strict";

// node experiments/typst/run.js <fixture> [--mode translation|source] [--demo-inline-math] [--out DIR]
//                               [--measurer typst|js|both]
//
// --measurer js    pure-JS line layout (experiments/measure) instead of a Typst
//                  query; the output then emits exactly those line breaks
// --measurer both  JS for fitting/output, plus the Typst query for comparison
//
// Fixture: a name under test/fixtures/model-golden (e.g. two-column-article)
// or a path to such a JSON file. Writes <out>/doc.typ, doc.pdf, measure.typ,
// page-N.png, text.txt and report.json.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pageNodes } = require("./content");
const { MathStore, measureDocument, outputDocument } = require("./emit");
const { solveStyles, sizesFor } = require("./fit");
const typst = require("./typst");
const jsMeasurer = require("../measure/measurer");
const { explicitParagraphStack } = require("../measure/emit-lines");

// JS vs Typst measurements of the same (node, paragraph, size).
function compareMeasurements(js, viaTypst) {
  const key = v => `${v.id}|${v.para}|${Number(v.size).toFixed(2)}`;
  const index = new Map(viaTypst.map(v => [key(v), v]));
  let compared = 0;
  let lineMismatch = 0;
  let maxHeightDiff = 0;
  let maxNaturalDiff = 0;
  const examples = [];
  for (const v of js) {
    const t = index.get(key(v));
    if (!t) continue;
    compared += 1;
    const linesJs = Math.round(v.h1 - v.h0) + 1;
    const linesTypst = Math.round(t.h1 - t.h0) + 1;
    if (linesJs !== linesTypst) {
      lineMismatch += 1;
      if (examples.length < 10) examples.push({ id: v.id, para: v.para, size: v.size, linesJs, linesTypst });
    }
    else maxHeightDiff = Math.max(maxHeightDiff, Math.abs(v.h0 - t.h0));
    maxNaturalDiff = Math.max(maxNaturalDiff, Math.abs(v.natural - t.natural));
  }
  return { compared, lineMismatch, maxHeightDiffPt: Number(maxHeightDiff.toFixed(4)), maxNaturalDiffPt: Number(maxNaturalDiff.toFixed(4)), examples };
}

const PYTHON = process.env.RPR_PYTHON || path.resolve(__dirname, "../../../retain-pdf/backend/.venv/bin/python");

function parseArgs(argv) {
  const options = { fixture: "", mode: "", demoInlineMath: false, out: "", measurer: "typst", noPng: false };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--mode") options.mode = argv[++i];
    else if (value === "--demo-inline-math") options.demoInlineMath = true;
    else if (value === "--out") options.out = argv[++i];
    else if (value === "--measurer") options.measurer = argv[++i];
    else if (value === "--no-png") options.noPng = true;
    else if (value === "--no-drift-check") options.noDriftCheck = true;
    else if (!options.fixture) options.fixture = value;
  }
  if (!options.fixture) throw new Error("usage: run.js <fixture> [--mode translation|source] [--demo-inline-math] [--out DIR]");
  return options;
}

function loadFixture(name) {
  const file = fs.existsSync(name) ? name : path.resolve(__dirname, "../../test/fixtures/model-golden", `${name}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

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

function snapshotKey(node) {
  if (node.nodeKind === "stream") return `stream:${node.styleKind || "text"}/${node.group === "refs" ? "ref_text" : "text"}#${node.id}`;
  return `block:${node.type}#${node.id}`;
}

function loadBrowserSnapshot(fixtureName, mode) {
  const dir = path.resolve(__dirname, "../../test/browser/__snapshots__");
  const result = {};
  for (const variant of ["firefox.SourceHanSerifCN-Regular", "firefox"]) {
    const file = path.join(dir, `${fixtureName}.${variant}.json`);
    if (!fs.existsSync(file)) continue;
    const nodes = JSON.parse(fs.readFileSync(file, "utf8")).modes?.[mode] || [];
    result[variant] = Object.fromEntries(nodes.map(node => [node.node, node]));
  }
  return result;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixture = loadFixture(options.fixture);
  const model = JSON.parse(JSON.stringify(fixture.expected || fixture));
  const hasTranslation = model.pages.some(page => (page.blocks || []).some(block => block.translatedText));
  const mode = options.mode || (hasTranslation ? "translation" : "source");
  const injected = options.demoInlineMath ? injectDemoMath(model) : 0;
  const out = path.resolve(options.out || path.join(__dirname, "output", `${fixture.name || "fixture"}-${mode}${options.demoInlineMath ? "-math" : ""}`));
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const timings = {};
  const maths = new MathStore(out);

  const nodesByPage = model.pages.map(page => pageNodes(page, mode));
  nodesByPage.forEach((nodes, pageIndex) => nodes.forEach((node, index) => {
    node.uid = `p${pageIndex + 1}-${index}`;
  }));

  // 1. One batched measurement of every text node over its size ladder.
  let started = performance.now();
  const jobs = nodesByPage.flat()
    .filter(node => node.paragraphs?.length && node.render !== "formula")
    .map(node => ({ node, sizes: sizesFor(node) }));
  let measured;
  let measureComparison = null;
  if (options.measurer === "js") {
    // Lazy: the fitter lays a paragraph out only at the sizes it probes.
    const mathBefore = maths.stats.ms;
    const provider = jsMeasurer.createProvider(jobs.map(job => job.node), maths);
    timings.jsPrepareMs = Math.round(provider.stats.prepareMs - (maths.stats.ms - mathBefore));
    measured = { values: provider.metricsAt, provider };
  }
  else if (options.measurer === "both") {
    const mathBefore = maths.stats.ms;
    const js = jsMeasurer.measureJobs(jobs, maths);
    timings.jsMeasureMs = Math.round(js.ms - (maths.stats.ms - mathBefore));
    timings.jsLayouts = js.layouts;
    measured = js;
    if (options.measurer === "both") {
      const measureSource = measureDocument(jobs, maths);
      fs.writeFileSync(path.join(out, "measure.typ"), measureSource);
      const viaTypst = typst.queryMeasurements("measure.typ", out);
      timings.typstMeasureMs = Math.round(viaTypst.ms);
      measureComparison = compareMeasurements(js.values, viaTypst.values);
      const byUid = new Map(nodesByPage.flat().map(node => [node.uid, node]));
      const nodes = new Map();
      for (const v of js.values) {
        const t = viaTypst.values.find(x => x.id === v.id && x.para === v.para && Math.abs(x.size - v.size) < 1e-6);
        if (!t || Math.round(v.h1 - v.h0) === Math.round(t.h1 - t.h0)) continue;
        const node = byUid.get(v.id);
        const entry = nodes.get(v.id) || { key: node.key, group: node.group, single: node.single, align: node.align, hanging: node.hangingIndent, width: node.contentBox[2] - node.contentBox[0], sizes: [] };
        entry.sizes.push(v.size);
        nodes.set(v.id, entry);
      }
      measureComparison.nodes = [...nodes.values()].map(n => ({ ...n, sizes: `${Math.min(...n.sizes)}..${Math.max(...n.sizes)} (${n.sizes.length})` }));
    }
  }
  else {
    const measureSource = measureDocument(jobs, maths);
    timings.emitMeasureMs = Math.round(performance.now() - started - maths.stats.ms);
    fs.writeFileSync(path.join(out, "measure.typ"), measureSource);
    measured = typst.queryMeasurements("measure.typ", out);
    timings.typstMeasureMs = Math.round(measured.ms);
  }

  // 2. Fit.
  started = performance.now();
  const { styles, decisions, conflicts } = solveStyles(nodesByPage, model.pages, measured.values, model.styles);
  timings.fitMs = Math.round(performance.now() - started);
  if (measured.provider) {
    // Measurement happens inside the fit; report it separately.
    timings.jsMeasureMs = Math.round(measured.provider.stats.ms);
    timings.jsLayouts = measured.provider.stats.layouts;
    timings.fitMs = Math.max(0, timings.fitMs - timings.jsMeasureMs);
  }

  // 3. Output document + PDF.
  started = performance.now();
  const doc = outputDocument(model.pages, nodesByPage, styles, maths,
    options.measurer === "typst" ? {} : { paragraphStack: explicitParagraphStack });
  timings.emitOutputMs = Math.round(performance.now() - started);
  fs.writeFileSync(path.join(out, "doc.typ"), doc);
  const compiled = typst.compile("doc.typ", "doc.pdf", out);
  timings.typstCompileMs = Math.round(compiled.ms);
  timings.mathjaxMs = Math.round(maths.stats.ms);

  // Drift check (JS measurer): every explicitly emitted line must render as
  // exactly one text line inside its node's column.
  let drift = null;
  if (options.measurer !== "typst" && !options.noDriftCheck) {
    const measurer = jsMeasurer.loadMeasurer();
    const expected = [];
    nodesByPage.forEach((nodes, pageIndex) => {
      for (const node of nodes) {
        const style = styles.get(node.uid);
        if (!node.prepared || node.single || !style) continue;
        const width = node.contentBox[2] - node.contentBox[0];
        const lines = node.prepared.reduce((sum, { prepared, options: layoutOptions }) =>
          sum + measurer.layout(prepared, { ...layoutOptions, fontSize: style.size, width }).lines.length, 0);
        expected.push({ page: pageIndex, key: node.key, lines, x0: node.contentBox[0], x1: node.contentBox[2], y0: node.contentBox[1], y1: node.contentBox[1] + (node.renderedHeight || 0), size: style.size });
      }
    });
    fs.writeFileSync(path.join(out, "expected-lines.json"), JSON.stringify(expected));
    const check = spawnSync(PYTHON, ["-c", `
import fitz, sys, json
doc = fitz.open(sys.argv[1])
expected = json.load(open(sys.argv[2]))
bad = []
for e in expected:
    page = doc[e["page"]]
    baselines = []
    for b in page.get_text("rawdict")["blocks"]:
        for l in b.get("lines", []):
            for sp in l["spans"]:
                if sp["alpha"] == 0 or sp["size"] < e["size"] * 0.75:
                    continue  # transparent LaTeX layer / sub-sized text
                for ch in sp["chars"]:
                    x, y = ch["origin"]
                    # baselines of this node's lines lie above its rendered bottom edge
                    if e["x0"] - 1 <= x <= e["x1"] + 1 and e["y0"] - 1 <= y <= e["y1"] + 0.25 * e["size"]:
                        baselines.append(y)
    baselines.sort()
    rows = []
    for y in baselines:
        if not rows or y - rows[-1] > e["size"] * 0.5:
            rows.append(y)
    if len(rows) != e["lines"]:
        bad.append({"key": e["key"], "page": e["page"] + 1, "expected": e["lines"], "rendered": len(rows)})
print(json.dumps({"nodes": len(expected), "mismatch": bad}))
`, path.join(out, "doc.pdf"), path.join(out, "expected-lines.json")], { encoding: "utf8" });
    drift = check.status === 0 ? JSON.parse(check.stdout) : { error: check.stderr };
  }

  // 4. PNGs + extracted text (PyMuPDF from retain-pdf's venv).
  const py = options.noPng ? { status: 0 } : spawnSync(PYTHON, ["-c", `
import fitz, sys, json
doc = fitz.open(sys.argv[1])
texts = []
for i, page in enumerate(doc):
    page.get_pixmap(dpi=110).save(f"{sys.argv[2]}/page-{i+1}.png")
    texts.append(page.get_text())
open(f"{sys.argv[2]}/text.txt", "w").write("\\n\\f\\n".join(texts))
`, path.join(out, "doc.pdf"), out], { encoding: "utf8" });
  if (py.status !== 0) console.warn(`PyMuPDF step failed: ${py.stderr}`);
  const text = fs.existsSync(path.join(out, "text.txt")) ? fs.readFileSync(path.join(out, "text.txt"), "utf8") : "";
  const formulasInText = [...text.matchAll(/\$\$?[^$]+\$\$?/g)].map(match => match[0]);

  // 5. Compare with the browser fitter's snapshot.
  const browser = loadBrowserSnapshot(fixture.name, mode);
  const comparison = nodesByPage.flat().filter(node => styles.has(node.uid) && node.paragraphs?.length).map(node => {
    const style = styles.get(node.uid);
    const key = snapshotKey(node);
    const row = { page: node.page, node: key, group: node.group, typst: { fontSize: style.size, lineHeight: style.lineRatio, lines: node.lines } };
    for (const [variant, nodes] of Object.entries(browser)) {
      const hit = nodes[key];
      if (hit) row[variant] = { fontSize: hit.fontSize, lineHeight: Number(hit.lineHeight) };
    }
    return row;
  });

  const report = {
    fixture: fixture.name,
    mode,
    demoInlineMathSentences: injected,
    measurer: options.measurer,
    measureComparison,
    drift,
    typst: { binary: typst.TYPST, fonts: typst.FONT_DIR, invocations: typst.invocations },
    timings,
    measurements: measured.provider ? measured.provider.stats.layouts : measured.values.length,
    decisions,
    conflicts,
    formulas: { rendered: maths.stats.formulas, failed: maths.stats.failed, copiedOutOfPdf: formulasInText },
    comparison
  };
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, measurer: options.measurer, measureComparison, drift, timings, invocations: typst.invocations.length, measurements: report.measurements, decisions, conflicts: conflicts.length, formulasFailed: maths.stats.failed.length, formulasCopied: formulasInText.length }, null, 2));
}

main();
