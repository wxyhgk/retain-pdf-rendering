#!/usr/bin/env node
"use strict";

// node experiments/overlay/run.js <retain-pdf job dir> [--out DIR] [--pages N]
//                                 [--png 1,3,5] [--no-drift-check]
//
// Reads a retain-pdf job directory (never writes into it), fits the
// translated blocks with src/fit-model.js (output-path configuration), emits
// a transparent Typst overlay, compiles it once and merges it onto
// retain-pdf's text-stripped source PDF with pikepdf.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const FitModel = require("../../src/fit-model.js");
const Text = require("../../src/text/measurer");
const { defaultFontTable } = require("../../src/index.js");
const { MathStore } = require("../typst/emit");
const { flatten } = require("../typst/emit-model");
const typst = require("../typst/typst");
const { outputViolations } = require("../../test/helpers/output-path");
const { loadJob, buildModel, detachBody } = require("./adapter");
const { overlayDocument } = require("./emit-overlay");

const PYTHON = process.env.RPR_PYTHON || path.resolve(__dirname, "../../../retain-pdf/backend/.venv/bin/python");

// `--preset retain`: the full retain-pdf-style configuration in one flag.
// Flags given after it override individual settings.
const PRESETS = {
  retain: { typography: "retain", seed: "geometry", vectorObstacles: true, tightenObstacles: true, boldTitles: true, faithful: true }
};

function parseArgs(argv) {
  const options = { job: "", out: "", pages: Infinity, png: [], driftCheck: true, inheritBelow: 0.85, limiterRounds: 0, bodyMaxFactor: 1, strictSourceFit: true, bodyLineHeight: 1.25, fontCaps: true, stamps: true };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--out") options.out = argv[++i];
    else if (value === "--pages") options.pages = Number(argv[++i]);
    else if (value === "--png") options.png = argv[++i].split(",").map(Number).filter(Number.isFinite);
    else if (value === "--no-drift-check") options.driftCheck = false;
    else if (value === "--no-stamps") options.stamps = false;
    else if (value === "--no-tighten-obstacles") options.tightenObstacles = false;
    // Retain-profile ablations (all on by default in the preset).
    else if (value === "--no-smoothing") options.retainSmoothing = false;
    else if (value === "--no-region-expansion") options.retainRegionExpansion = false;
    else if (value === "--no-push-lift") options.retainPushLowerFirstLine = false;
    else if (value === "--inherit-below") options.inheritBelow = Number(argv[++i]);
    else if (value === "--limiter-rounds") options.limiterRounds = Number(argv[++i]);
    else if (value === "--body-max-factor") options.bodyMaxFactor = Number(argv[++i]);
    else if (value === "--allow-spill") options.strictSourceFit = false;
    else if (value === "--body-line-height") options.bodyLineHeight = Number(argv[++i]);
    else if (value === "--preset") {
      const preset = PRESETS[argv[++i]];
      if (!preset) throw new Error(`unknown preset ${argv[i]} (known: ${Object.keys(PRESETS).join(", ")})`);
      Object.assign(options, preset);
    }
    else if (value === "--typography") options.typography = argv[++i];
    else if (value === "--seed") options.seed = argv[++i];
    else if (value === "--retain-band-fit") options.retainBandFit = true;
    else if (value === "--font-caps") options.fontCaps = true;
    else if (value === "--no-font-caps") options.fontCaps = false;
    else if (value === "--vector-obstacles") options.vectorObstacles = true;
    else if (value === "--no-vector-obstacles") options.vectorObstacles = false;
    else if (value === "--bold-titles") options.boldTitles = true;
    else if (value === "--no-bold-titles") options.boldTitles = false;
    else if (value === "--no-retain-titles") options.retainTitles = false;
    else if (value === "--faithful") options.faithful = true;
    else if (value === "--no-faithful") options.faithful = false;
    else if (value === "--leading-first") options.leadingFirst = true;
    else if (value === "--no-leading-first") options.leadingFirst = false;
    else if (!options.job) options.job = value;
  }
  if (!options.job) throw new Error("usage: run.js <jobDir> [--out DIR] [--pages N] [--png 1,3] [--no-drift-check]");
  options.job = path.resolve(options.job);
  options.out = path.resolve(options.out || path.join(__dirname, "output", path.basename(options.job)));
  return options;
}

function python(script, args) {
  const result = spawnSync(PYTHON, ["-c", script, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`python failed: ${result.stderr}`);
  return result.stdout;
}

function fileSize(file) {
  return file && fs.existsSync(file) ? fs.statSync(file).size : null;
}

// Retain-pdf's own per-block sizes, read from its overlay Typst source
// (max_size of pdftr_fit_* calls or the fixed `set text(size:)`), for the
// font-size comparison.
// Justification stretch per justified line, the way Typst distributes it:
// extra width goes to the justifiable gaps (spaces and CJK characters; Latin
// letters and formula boxes are not stretched). Reported in em per gap.
const CJK_JUSTIFIABLE = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;
function justifyStats(fitted, paint, base) {
  const rows = [];
  for (const page of fitted.pages) {
    for (const node of page.nodes) {
      if (!paint[node.id] || !node.paragraphs) continue;
      for (const line of node.lines) {
        if (!line.justified) continue;
        const flat = flatten(node.paragraphs[line.paragraph]?.runs);
        let text = "";
        const runs = [];
        for (let i = line.start; i < line.end; i++) {
          const box = flat.boxes.get(i);
          if (box) runs.push(box);
          else if (flat.text[i] !== "\u2028") runs.push({ type: "text", text: flat.text[i] });
          text += flat.text[i] === "\u2028" ? "" : flat.text[i];
        }
        const natural = base.naturalWidth(base.prepare(runs), { fontSize: node.fontSize });
        const body = text.replace(/\s+$/, "");
        let gaps = 0;
        for (let i = 0; i < body.length - 1; i++) {
          if (/\s/.test(body[i]) || CJK_JUSTIFIABLE.test(body[i])) gaps += 1;
        }
        const slack = Math.max(0, line.width - natural);
        const perGapEm = gaps ? slack / gaps / node.fontSize : (slack > 0.01 ? Infinity : 0);
        rows.push({ page: page.index + 1, node: node.id, perGapEm: Number(perGapEm.toFixed(3)), slackEm: Number((slack / node.fontSize).toFixed(2)), gaps, text: body.replace(/\uFFFC/g, "▢") });
      }
    }
  }
  const values = rows.map(row => row.perGapEm).filter(Number.isFinite).sort((a, b) => a - b);
  const q = p => values.length ? values[Math.min(values.length - 1, Math.floor(p * (values.length - 1)))] : 0;
  return {
    lines: rows.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: values.length ? values[values.length - 1] : 0,
    over015: rows.filter(row => row.perGapEm > 0.1501).length, over025: rows.filter(row => row.perGapEm > 0.25).length,
    worst: rows.sort((a, b) => b.perGapEm - a.perGapEm).slice(0, 8)
  };
}

function retainPdfSizes(jobDir) {
  const file = path.join(jobDir, "rendered/typst/book-overlays/book-overlay.typ");
  if (!fs.existsSync(file)) return null;
  const source = fs.readFileSync(file, "utf8");
  // Items are named p<page>_item_<i>_<j> in translated-item order per page.
  const byPage = {};
  for (const match of source.matchAll(/#let p(\d+)_item_(\d+)_\d+_body = block\([^\n]*?(?:max_size: ([\d.]+)pt|set text\(size: ([\d.]+)pt)/g)) {
    (byPage[match[1]] ||= []).push({ item: Number(match[2]), size: Number(match[3] || match[4]) });
  }
  for (const list of Object.values(byPage)) list.sort((a, b) => a.item - b.item);
  return byPage;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(options.out, { recursive: true });
  const timings = {};

  let started = performance.now();
  const job = loadJob(options.job);
  // Source font sizes: the text layer of the original PDF (span size + bbox).
  const sourceSizes = job.sourcePdf ? JSON.parse(python(`
import fitz, json, sys
doc = fitz.open(sys.argv[1]); out = {}
for i, page in enumerate(doc):
    spans = []
    for b in page.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            for s in l["spans"]:
                if s["text"].strip(): spans.append({"bbox": [round(v, 2) for v in s["bbox"]], "size": round(s["size"], 2)})
    out[str(i)] = spans
print(json.dumps(out))
`, [job.sourcePdf])) : {};
  timings.sourceSizesMs = Math.round(performance.now() - started);

  const maths = new MathStore(options.out, { stamps: options.stamps });
  const renderMathBox = (tex, display) => {
    const entry = maths.get(tex, display);
    if (entry.ok) return { widthEm: entry.widthEm, heightEm: entry.heightEm, depthEm: entry.depthEm };
    // A formula MathJax cannot render: Text.contentFromText keeps it as
    // plain text in the body font.
    return null;
  };
  const base = Text.createMeasurer({ metrics: defaultFontTable() });
  const runsForText = text => Text.contentFromText(text, { renderMathBox })
    .map(run => (run.type === "math" ? { ...run, display: false } : run));
  started = performance.now();
  const drawings = job.sourcePdf ? require("./vector-obstacles").extractDrawings(job.sourcePdf) : null;
  const { model, paint, stats, vectors } = buildModel(job, {
    drawings,
    vectorObstacles: Boolean(options.vectorObstacles),
    tightenObstacles: Boolean(options.tightenObstacles),
    maxPages: options.pages,
    typography: options.typography,
    // retain-pdf's is_body_text_candidate (on with --preset retain / --faithful).
    retainBodyClassify: Boolean(options.faithful),
    seed: options.seed,
    sourceSizes,
    inheritBelow: options.inheritBelow,
    bodyLineHeight: options.bodyLineHeight,
    // Largest size a body paragraph reaches inside its own box on its own
    // (stream padding 2 + 4, the fitter's body line ratio).
    standaloneFit: stream => base.fitFontSize(base.prepare(runsForText(stream.items[0].translatedText)), {
      width: Math.max(1, stream.bbox[2] - stream.bbox[0] - 6), maxHeight: stream.bbox[3] - stream.bbox[1],
      lineHeight: stream.lineHeight, minFont: 4, maxFont: 16, step: 0.1
    }).fontSize
  });
  timings.adapterMs = Math.round(performance.now() - started - maths.stats.ms);
  let layouts = 0;
  const measurer = { ...base, layout(prepared, layoutOptions) { layouts += 1; return base.layout(prepared, layoutOptions); } };
  const defaults = FitModel.defaultContentFor({ renderMathBox });
  // Translations keep LaTeX in $...$ / $$...$$: Text.contentFromText splits
  // them into runs (display formulas inside a paragraph become inline boxes).
  const runsFor = runsForText;
  const contentFor = (node, mode) => {
    if (node.kind === "stream") {
      return { paragraphs: (node.source.items || []).map(item => ({ runs: runsFor(item.translatedText || item.text), indent: 0 })) };
    }
    if (node.source.kind === "text" && node.source.translatedText) {
      return { paragraphs: [{ runs: runsFor(node.source.translatedText), indent: 0 }] };
    }
    return defaults(node, mode);
  };
  const retain = options.typography === "retain";
  // --bold-titles (in --preset retain): headings are measured with the Bold
  // advance table, and the fitter then marks them fontWeight "bold" (like
  // retain-pdf's resolve_font_weight).
  const boldBase = options.boldTitles ? Text.createMeasurer({ metrics: defaultFontTable("bold") }) : null;
  const measurers = boldBase ? { bold: { ...boldBase, layout(prepared, layoutOptions) { layouts += 1; return boldBase.layout(prepared, layoutOptions); } } } : undefined;
  const fitter = FitModel.createModelFitter({ measurer, lineModel: "measurer", contentFor, ...(measurers ? { measurers } : {}), ...(retain ? { typography: "retain" } : {}) });
  started = performance.now();
  const mathBefore = maths.stats.ms;
  // The shared body font stops at the first paragraph that cannot grow
  // (fit.limiter). Detach that paragraph into an individually fitted block
  // and refit, a few rounds at most, until the source body size is reached.
  const bodyMaxFont = Number.isFinite(stats.sourceBodyFont) && options.bodyMaxFactor > 0
    ? Number((stats.sourceBodyFont * options.bodyMaxFactor).toFixed(2)) : undefined;
  stats.bodyMaxFont = bodyMaxFont ?? null;
  // strictSourceFit: text must stay inside its own source box. The overlay
  // cannot see vector rules or frames that are not OCR blocks, so growing
  // into "free" space below a box is not safe here.
  // Profile "retain" defaults (engine): retain-pdf's own block fit
  // (retainFaithfulSchedule) and leading-before-font repair
  // (retainLeadingFirstRepair); --no-faithful / --no-leading-first turn them off.
  const fitOptions = { mode: "translation", bodyMaxFont, strictSourceFit: options.strictSourceFit, bodyNodeFontCaps: Boolean(options.fontCaps), ...(options.retainBandFit ? { retainBandFit: true } : {}), ...(options.retainTitles === false ? { retainTitles: false } : {}), ...(options.faithful === false ? { retainFaithfulSchedule: false } : {}), ...(options.leadingFirst === false ? { retainLeadingFirstRepair: false } : {}), ...(options.retainSmoothing === false ? { retainSmoothing: false } : {}), ...(options.retainRegionExpansion === false ? { retainRegionExpansion: false } : {}), ...(options.retainPushLowerFirstLine === false ? { retainPushLowerFirstLine: false } : {}) };
  // RPR_RETAIN_TRACE=file: per body paragraph decision trace of the retain profile.
  const retainTraceRows = [];
  if (process.env.RPR_RETAIN_TRACE) fitOptions.retainTrace = (id, stage, data) => retainTraceRows.push({ id, stage, ...data });
  process.on("exit", () => { if (process.env.RPR_RETAIN_TRACE) fs.writeFileSync(process.env.RPR_RETAIN_TRACE, JSON.stringify(retainTraceRows)); });
  let fitted = fitter.fitDocument(model, fitOptions);
  const limiterRounds = [];
  for (let round = 0; round < (retain ? 0 : options.limiterRounds); round++) {
    const body = fitted.pages.flatMap(page => page.nodes)
      .filter(node => node.kind === "stream" && node.styleKind === "body_text" && node.textRects.length);
    // Collision stop: the fitter names the limiter. Overflow stop (strict
    // source fit): every member reports font-overflow, so take the paragraph
    // with the least room left below its last line.
    const slack = node => node.bbox[3] - Math.max(...node.textRects.map(rect => rect.bottom));
    const limiter = body.find(node => node.fit?.limiter)
      || (body.some(node => node.fit?.stopReason === "font-overflow")
        ? body.reduce((best, node) => (!best || slack(node) < slack(best) ? node : best), null)
        : null);
    if (!limiter || (bodyMaxFont && limiter.fontSize >= bodyMaxFont - 0.25)) break;
    detachBody(model, limiter.id);
    limiterRounds.push({ id: limiter.id, bodyFont: limiter.fontSize, reason: limiter.fit?.limiter ? `collision ${limiter.fit.blocker}` : "least slack" });
    fitted = fitter.fitDocument(model, fitOptions);
  }
  stats.limiterRounds = limiterRounds;
  timings.fitMs = Math.round(performance.now() - started - (maths.stats.ms - mathBefore));
  timings.measurerLayouts = layouts;

  // Over-stretched justified lines. With the retain typography the engine
  // handles this (line model: stretch capped per Typst-justifiable gap;
  // passes/justify.js: balanced breaking after the fit), so nothing is
  // changed here. Legacy path (no retain typography): a justified line whose
  // slack per character exceeds 0.25 em is painted unjustified at its
  // natural width.
  let unjustified = 0;
  for (const node of retain ? [] : fitted.pages.flatMap(page => page.nodes)) {
    if (!paint[node.id] || !node.paragraphs) continue;
    for (const line of node.lines) {
      if (!line.justified) continue;
      const flat = flatten(node.paragraphs[line.paragraph]?.runs);
      const runs = [];
      for (let i = line.start; i < line.end; i++) {
        const box = flat.boxes.get(i);
        if (box) runs.push(box);
        else if (flat.text[i] !== "\u2028") runs.push({ type: "text", text: flat.text[i] });
      }
      const natural = base.naturalWidth(base.prepare(runs), { fontSize: node.fontSize });
      const gaps = Math.max(1, runs.length - 1);
      if ((line.width - natural) / gaps > 0.25 * node.fontSize) {
        line.justified = false;
        line.width = natural;
        unjustified += 1;
      }
    }
  }
  stats.unjustifiedLines = unjustified;
  stats.justify = justifyStats(fitted, paint, base);

  started = performance.now();
  const { source, painted } = overlayDocument(fitted, paint, maths);
  timings.emitMs = Math.round(performance.now() - started);
  fs.writeFileSync(path.join(options.out, "overlay.typ"), source);
  const stamped = maths.prepareStamps(typst);
  fs.writeFileSync(path.join(options.out, "math", "formulas.json"), JSON.stringify(maths.manifest()));
  timings.stampsCompileMs = stamped ? Math.round(stamped.ms) : 0;
  const compiled = typst.compile("overlay.typ", "overlay.pdf", options.out);
  timings.typstCompileMs = Math.round(compiled.ms);
  timings.mathjaxMs = Math.round(maths.stats.ms);

  const finalPdf = path.join(options.out, "final.pdf");
  started = performance.now();
  const merged = JSON.parse(python(fs.readFileSync(path.join(__dirname, "merge.py"), "utf8"), [job.basePdf, path.join(options.out, "overlay.pdf"), finalPdf]));
  timings.mergeMs = Math.round(performance.now() - started);
  timings.mergeInnerMs = merged.ms;

  // Invariants on the fitted output: text vs text (output-path helper) and
  // text vs every preserved source element (obstacle boxes).
  const violations = outputViolations(fitted);
  const vectorHitList = require("./vector-obstacles").vectorHits(fitted, vectors, paint);
  const isObstacle = label => /^block:image#/.test(label);
  const textOrder = violations.order.filter(entry => !isObstacle(entry.upper) && !isObstacle(entry.lower));
  // Painted text that runs past its own source box (allowed by the fitter's
  // rules when nothing collides, but it covers stripped, not filled, area).
  const spills = [];
  for (const page of fitted.pages) {
    for (const node of page.nodes.filter(node => paint[node.id] && node.textRects.length)) {
      const bottom = Math.max(...node.textRects.map(rect => rect.bottom));
      if (bottom > node.bbox[3] + 1) spills.push({ page: page.index + 1, node: node.label, by: +(bottom - node.bbox[3]).toFixed(2), fontSize: node.fontSize, fit: node.fit });
    }
  }
  const obstacleHits = [];
  for (const page of fitted.pages) {
    const obstacles = page.nodes.filter(node => !paint[node.id]);
    for (const node of page.nodes.filter(node => paint[node.id])) {
      for (const rect of node.textRects) {
        for (const obstacle of obstacles) {
          const [x0, y0, x1, y1] = obstacle.bbox;
          const ox = Math.min(rect.right, x1) - Math.max(rect.left, x0);
          const oy = Math.min(rect.bottom, y1) - Math.max(rect.top, y0);
          if (ox > 0.01 && oy > 0.01) obstacleHits.push({ page: page.index + 1, node: node.label, obstacle: obstacle.id, overlapY: +oy.toFixed(2) });
        }
      }
    }
  }

  // Drift: each emitted line renders as exactly one line in the overlay PDF.
  // (A line starting with full-width opening punctuation has its blank half
  // trimmed by Typst: the glyph origin sits up to 0.5 em left of line.x.)
  let drift = null;
  if (options.driftCheck) {
    const expected = [];
    fitted.pages.forEach((page, pageIndex) => {
      for (const node of page.nodes) {
        if (!paint[node.id] || !node.paragraphs) continue;
        const lines = node.lines.filter(line => {
          const flat = flatten(node.paragraphs[line.paragraph]?.runs);
          return line.end > line.start && flat.text.slice(line.start, line.end).replace(/[\s\u2028]/g, "").length > 0;
        });
        if (!lines.length) continue;
        expected.push({ page: pageIndex, key: node.label, lines: lines.length, size: node.fontSize,
          x0: Math.min(...lines.map(line => line.x)), x1: Math.max(...lines.map(line => line.x + line.width)),
          y0: Math.min(...lines.map(line => line.baseline)), y1: Math.max(...lines.map(line => line.baseline)) });
      }
    });
    fs.writeFileSync(path.join(options.out, "expected-lines.json"), JSON.stringify(expected));
    drift = JSON.parse(python(`
import fitz, json, sys
doc = fitz.open(sys.argv[1]); expected = json.load(open(sys.argv[2])); bad = []
for e in expected:
    page = doc[e["page"]]; ys = []
    for b in page.get_text("rawdict")["blocks"]:
        for l in b.get("lines", []):
            for s in l["spans"]:
                ox, oy = s["origin"]
                if s["text"].strip() if "text" in s else any(c["c"].strip() for c in s.get("chars", [])):
                    if e["x0"] - e["size"] * 0.6 <= ox <= e["x1"] + 2 and e["y0"] - e["size"] * 0.4 <= oy <= e["y1"] + e["size"] * 0.4 and s["size"] > e["size"] * 0.5 and s["size"] < e["size"] * 1.5:
                        ys.append(oy)
    ys.sort(); rows = []
    for y in ys:
        if not rows or y - rows[-1] > e["size"] * 0.5: rows.append(y)
    if len(rows) != e["lines"]: bad.append({"key": e["key"], "page": e["page"] + 1, "expected": e["lines"], "rendered": len(rows)})
print(json.dumps({"nodes": len(expected), "mismatch": bad}))
`, [path.join(options.out, "overlay.pdf"), path.join(options.out, "expected-lines.json")]));
  }

  // Screenshots (ours vs retain-pdf) and extracted text of final.pdf.
  python(`
import fitz, sys, json
final = fitz.open(sys.argv[1]); ref = fitz.open(sys.argv[2]) if sys.argv[2] else None
out = sys.argv[3]; pages = json.loads(sys.argv[4])
open(f"{out}/text.txt", "w").write("\\n\\f\\n".join(p.get_text() for p in final))
for n in pages:
    if n - 1 >= len(final): continue
    a = final[n - 1].get_pixmap(dpi=90)
    if ref:
        b = ref[n - 1].get_pixmap(dpi=90)
        pix = fitz.Pixmap(a.colorspace, fitz.IRect(0, 0, a.width + b.width + 12, max(a.height, b.height)), False)
        pix.set_rect(pix.irect, (128, 128, 128))
        pix.copy(a, a.irect)
        b.set_origin(a.width + 12, 0); pix.copy(b, b.irect)
        pix.save(f"{out}/compare-p{n}.png")
    else:
        a.save(f"{out}/final-p{n}.png")
`, [finalPdf, job.renderedPdf || "", options.out, JSON.stringify(options.png)]);

  // Font sizes: ours per node vs retain-pdf's per block.
  const reference = retainPdfSizes(options.job) || {};
  const comparisons = [];
  for (const page of fitted.pages) {
    const ours = page.nodes.filter(node => paint[node.id])
      .sort((a, b) => Number(String(a.id).match(/-b0*(\d+)$/)?.[1]) - Number(String(b.id).match(/-b0*(\d+)$/)?.[1]));
    const theirs = reference[String(page.index)] || [];
    // Paired by order only when both sides painted the same number of items.
    ours.forEach((node, index) => comparisons.push({
      page: page.index + 1, id: node.id, kind: node.styleKind || node.type, ours: node.fontSize, fit: node.fit,
      retainPdf: theirs.length === ours.length ? theirs[index].size : null
    }));
  }
  const bodyOurs = comparisons.filter(c => c.kind === "body_text").map(c => c.ours);
  const bodyRef = comparisons.filter(c => c.kind === "body_text" && c.retainPdf).map(c => c.retainPdf);
  const summary = list => list.length ? { min: Math.min(...list), max: Math.max(...list), median: list.slice().sort((a, b) => a - b)[Math.floor(list.length / 2)] } : null;

  const text = fs.readFileSync(path.join(options.out, "text.txt"), "utf8");
  const report = {
    job: path.basename(options.job),
    pages: fitted.pages.length,
    adapter: stats,
    paintedNodes: painted,
    timings,
    sizes: { sourcePdf: fileSize(job.sourcePdf), retainPdfRendered: fileSize(job.renderedPdf), basePdf: fileSize(job.basePdf), overlayPdf: fileSize(path.join(options.out, "overlay.pdf")), finalPdf: fileSize(finalPdf) },
    // order: text-vs-text only; text vs preserved source elements is the
    // exact rectangle test obstacleHits (the order check compares vertical
    // extents of whole nodes and flags text beside, not over, a formula).
    invariants: { lineOverlaps: violations.lineOverlaps.length, outside: violations.outside.length, order: textOrder.length, obstacleHits: obstacleHits.length },
    vectorHits: {
      lines: vectorHitList.length,
      overflowLines: vectorHitList.filter(hit => hit.overflowLine).length,
      byKind: vectorHitList.reduce((acc, hit) => ({ ...acc, [hit.kind]: (acc[hit.kind] || 0) + 1 }), {}),
      examples: vectorHitList.slice(0, 8)
    },
    spillBelowBox: { count: spills.length, over2pt: spills.filter(entry => entry.by > 2).length, examples: spills.sort((a, b) => b.by - a.by).slice(0, 5) },
    examples: { lineOverlaps: violations.lineOverlaps.slice(0, 5), outside: violations.outside.slice(0, 5), order: textOrder.slice(0, 5), obstacleHits: obstacleHits.slice(0, 8) },
    drift: drift && { nodes: drift.nodes, mismatch: drift.mismatch.length, examples: drift.mismatch.slice(0, 5) },
    formulas: { rendered: maths.stats.formulas, failed: maths.stats.failed.length, failedExamples: maths.stats.failed.slice(0, 5), copiedOutOfPdf: [...text.matchAll(/\$[^$\n]{1,80}\$/g)].length },
    stamps: maths.stamps ? { formulas: maths.stamps.stats.formulas, fallbacks: maths.stamps.stats.fallbacks.length, fallbackExamples: maths.stamps.stats.fallbacks.slice(0, 5), glyphDraws: maths.stamps.stats.draws, rules: maths.stamps.stats.rects, outlines: maths.stamps.list.length } : null,
    bodyFont: { ours: summary(bodyOurs), retainPdf: summary(bodyRef), oursIndividual: summary(comparisons.filter(c => c.kind === "text").map(c => c.ours)) },
    // Fill of each painted body paragraph: ink height over its box height.
    bodyFill: (() => {
      const fills = fitted.pages.flatMap(page => page.nodes)
        .filter(node => paint[node.id] && node.styleKind === "body_text" && node.textRects.length)
        .map(node => (Math.max(...node.textRects.map(rect => rect.bottom)) - Math.min(...node.textRects.map(rect => rect.top))) / Math.max(1, node.bbox[3] - node.bbox[1]));
      const sorted = fills.slice().sort((a, b) => a - b);
      return { count: fills.length, below60: fills.filter(fill => fill < 0.6).length, median: sorted.length ? Number(sorted[sorted.length >> 1].toFixed(3)) : null };
    })(),
    fontSizes: comparisons
  };
  fs.writeFileSync(path.join(options.out, "report.json"), JSON.stringify(report, null, 2));
  const { fontSizes, examples, ...brief } = report;
  console.log(JSON.stringify({ ...brief, examples }, null, 2));
}

main();
