#!/usr/bin/env node
"use strict";

// node experiments/typst/run.js <fixture> [--mode translation|source] [--demo-inline-math] [--out DIR]
//                               [--measurer typst|js|both] [--fitter prototype|model]
//
// --fitter model   fit with src/fit-model.js (the DOM fitter's rule set on
//                  data, JS measurer) and emit every line at the position it
//                  computed (emit-model.js); --measurer is then always js
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
const emitters = require("./emit");
const { fittedDocument, flatten } = require("./emit-model");

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
  const options = { fixture: "", mode: "", demoInlineMath: false, out: "", measurer: "typst", noPng: false, fitter: "prototype" };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--mode") options.mode = argv[++i];
    else if (value === "--demo-inline-math") options.demoInlineMath = true;
    else if (value === "--out") options.out = argv[++i];
    else if (value === "--measurer") options.measurer = argv[++i];
    else if (value === "--fitter") options.fitter = argv[++i];
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

const { injectDemoMath } = require("./demo-math");

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
  if (options.fitter === "model") return runModelFitter({ options, fixture, model, mode, out, maths, nodesByPage, injected });

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

function driftCheck(out, expected) {
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
                    continue
                for ch in sp["chars"]:
                    x, y = ch["origin"]
                    if e["x0"] - 1 <= x <= e["x1"] + 1 and e["y0"] - 0.5 <= y <= e["y1"] + 0.5:
                        baselines.append(y)
    baselines.sort()
    rows = []
    for y in baselines:
        if not rows or y - rows[-1] > e["size"] * 0.5:
            rows.append(y)
    if len(rows) != e["lines"]:
        bad.append({"key": e["key"], "page": e["page"] + 1, "expected": e["lines"], "rendered": len(rows)})
print(json.dumps({"nodes": len(expected), "mismatch": bad}))
`, path.join(out, "doc.pdf"), path.join(out, "expected-lines.json")], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return check.status === 0 ? JSON.parse(check.stdout) : { error: check.stderr };
}

// --fitter model: src/fit-model.js + RetainPdfRendering.Text (src/text, Typst
// line breaking and line geometry: lineModel "measurer"), every line emitted
// where the fitter placed it.
function runModelFitter({ options, fixture, model, mode, out, maths, nodesByPage, injected }) {
  const FitModel = require("../../src/fit-model.js");
  const Text = require("../../src/text/measurer");
  const { defaultFontTable } = require("../../src/index.js");
  const timings = {};
  const base = Text.createMeasurer({ metrics: defaultFontTable() });
  let layouts = 0;
  const measurer = { ...base, layout(prepared, layoutOptions) { layouts += 1; return base.layout(prepared, layoutOptions); } };
  const renderMathBox = (tex, display) => {
    const entry = maths.get(tex, display);
    if (entry.ok) return { widthEm: entry.widthEm, heightEm: entry.heightEm, depthEm: entry.depthEm };
    return Text.fallbackMathBox(display ? `$$${tex}$$` : `$${tex}$`);
  };
  const fitter = FitModel.createModelFitter({
    measurer,
    lineModel: "measurer",
    contentFor: FitModel.defaultContentFor({ renderMathBox })
  });
  let started = performance.now();
  const mathBefore = maths.stats.ms;
  const fitted = fitter.fitDocument(model, { mode });
  timings.fitModelMs = Math.round(performance.now() - started - (maths.stats.ms - mathBefore));
  timings.measurerLayouts = layouts;

  started = performance.now();
  const doc = fittedDocument(fitted, nodesByPage, maths, emitters);
  timings.emitOutputMs = Math.round(performance.now() - started);
  fs.writeFileSync(path.join(out, "doc.typ"), doc);
  const compiled = typst.compile("doc.typ", "doc.pdf", out);
  timings.typstCompileMs = Math.round(compiled.ms);
  timings.mathjaxMs = Math.round(maths.stats.ms);

  // Drift: every emitted line must render as exactly one text line.
  let drift = null;
  if (!options.noDriftCheck) {
    started = performance.now();
    const expected = [];
    fitted.pages.forEach((page, pageIndex) => {
      for (const node of page.nodes) {
        if (node.formula || node.code || node.tocRows || !node.paragraphs) continue;
        const lines = node.lines.filter(line => {
          const flat = flatten(node.paragraphs[line.paragraph]?.runs);
          return line.end > line.start && flat.text.slice(line.start, line.end).replace(/[\s\u2028]/g, "").length > 0;
        });
        if (!lines.length) continue;
        expected.push({
          page: pageIndex,
          key: node.label,
          lines: lines.length,
          x0: Math.min(...lines.map(line => line.x)),
          x1: Math.max(...lines.map(line => line.x + line.width)),
          y0: Math.min(...lines.map(line => line.baseline)),
          y1: Math.max(...lines.map(line => line.baseline)),
          size: node.fontSize
        });
      }
    });
    drift = driftCheck(out, expected);
    timings.driftCheckMs = Math.round(performance.now() - started);
  }

  const py = options.noPng ? { status: 0 } : spawnSync(PYTHON, ["-c", `
import fitz, sys
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
  const bodyFonts = [...new Set(fitted.pages.flatMap(page => page.nodes)
    .filter(node => node.kind === "stream" && node.styleKind === "body_text" && node.flowKind === "text")
    .map(node => node.fontSize))].sort((a, b) => a - b);
  const report = {
    fixture: fixture.name, mode, fitter: "model", demoInlineMathSentences: injected,
    typst: { binary: typst.TYPST, fonts: typst.FONT_DIR, invocations: typst.invocations },
    timings, drift, bodyFonts,
    formulas: { rendered: maths.stats.formulas, failed: maths.stats.failed, copiedOutOfPdf: formulasInText },
    nodes: fitted.pages.flatMap(page => page.nodes.map(node => ({ page: page.index, node: node.label, fontSize: node.fontSize, lineHeight: node.styleLineHeight, lines: node.lines.length, fit: node.fit })))
  };
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, fitter: "model", timings, invocations: typst.invocations.length, bodyFonts, drift: drift && (drift.error ? drift : { nodes: drift.nodes, mismatch: drift.mismatch.length, examples: drift.mismatch.slice(0, 5) }), formulasFailed: maths.stats.failed.length, formulasCopied: formulasInText.length }, null, 2));
}

main();
