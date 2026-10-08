"use strict";

// Tests the typesetting engine (src/typeset) on its own, on a real retain-pdf
// job (read-only): every translated block is set at the size retain-pdf
// actually used (retain_sizes.py, read from its rendered PDF), so the result
// says nothing about sizing — only whether the engine sets text correctly.
//
//   node experiments/typeset/run-retain.js <job dir> [--out DIR] [--drift] [--png 1,3]
//
// Inputs: ocr/normalized/document.v1.json (boxes), translated/*.json (text),
// artifacts/render_prewarm/visual_profile.v1.json (cover and text colours,
// retain-pdf's own sampling of the page image), the base page (retain-pdf's
// text-stripped PDF, or the source itself for image-only PDFs, whose original
// text the covers hide). No PDF structure is read for layout.
// Output: overlay.typ / overlay.pdf / final.pdf / report.json in <out>.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Text = require("../../src/text/measurer");
const Typeset = require("../../src/typeset");
const { defaultFontTable } = require("../../src/index.js");
const { MathStore } = require("../typst/emit");
const { flatten } = require("../typst/emit-model");
const typst = require("../typst/typst");
const { loadJob } = require("../overlay/adapter");
const { overlayDocument } = require("../overlay/emit-overlay");

const PYTHON = process.env.RPR_PYTHON || path.resolve(__dirname, "../../../retain-pdf/backend/.venv/bin/python");
// Retain-pdf's body leading 0.56 em on a 0.729 em cap-height line box.
const DEFAULT_LINE_HEIGHT = 1.289;
const JUSTIFY_CAP = 0.15;

function parseArgs(argv) {
  const options = { job: "", out: "", drift: false, png: [] };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--out") options.out = path.resolve(argv[++i]);
    else if (value === "--drift") options.drift = true;
    else if (value === "--png") options.png = argv[++i].split(",").map(Number).filter(Number.isFinite);
    else if (!options.job) options.job = path.resolve(value);
    else throw new Error(`unknown argument ${value}`);
  }
  if (!options.job) throw new Error("usage: run-retain.js <job dir> [--out DIR] [--drift] [--png 1,3]");
  if (!options.out) options.out = path.join(__dirname, "output", path.basename(options.job));
  return options;
}

function python(script, args) {
  const result = spawnSync(PYTHON, [script.endsWith(".py") ? script : "-c", ...(script.endsWith(".py") ? [] : [script]), ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`python failed: ${result.stderr}`);
  return result.stdout;
}

const blockNumber = id => Number((String(id).match(/-b0*(\d+)$/) || [])[1]);
const fileSize = file => (file && fs.existsSync(file) ? fs.statSync(file).size : null);

function main() {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(options.out, { recursive: true });
  const timings = {};
  let started = Date.now();
  const job = loadJob(options.job);
  const sizes = JSON.parse(python(path.join(__dirname, "retain_sizes.py"), [options.job]));
  timings.sizesMs = Date.now() - started;
  const lineHeights = Object.values(sizes).map(s => s.lineHeight).filter(Number.isFinite).sort((a, b) => a - b);
  const fallbackLineHeight = lineHeights.length ? lineHeights[Math.floor(lineHeights.length / 2)] : DEFAULT_LINE_HEIGHT;

  const maths = new MathStore(options.out, { stamps: true });
  const renderMathBox = (tex, display) => {
    const entry = maths.get(tex, display);
    return entry.ok ? { widthEm: entry.widthEm, heightEm: entry.heightEm, depthEm: entry.depthEm } : null;
  };

  // Engine input: boxes and text from document.v1, sizes from retain-pdf.
  started = Date.now();
  const paint = {};
  const input = { pages: [] };
  const stats = { translated: 0, set: 0, noRetainSize: 0, obstacles: 0 };
  for (const page of job.document.pages || []) {
    const pageIndex = page.page_index;
    const profilePage = job.profile.pages?.[String(pageIndex)] || {};
    const blocks = [];
    const obstacles = [];
    for (const block of page.blocks || []) {
      const box = (block.bbox || []).map(Number);
      if (box.length !== 4 || box.some(v => !Number.isFinite(v))) continue;
      const id = String(block.block_id);
      const item = job.translations.get(`${pageIndex}:${blockNumber(id)}`);
      const translated = block.type === "text" && item && item.policy_translate ? String(item.translated_text || "").trim() : "";
      if (!translated) { obstacles.push({ id, box }); stats.obstacles += 1; continue; }
      stats.translated += 1;
      const size = sizes[id];
      if (!size) { stats.noRetainSize += 1; obstacles.push({ id, box }); continue; }
      const visual = profilePage.items?.[item.item_id] || null;
      paint[id] = {
        cover: visual && Array.isArray(visual.bbox) ? visual.bbox : box,
        fill: visual?.background_rgb || profilePage.background_rgb || [1, 1, 1],
        text: visual?.text_rgb || [0.07, 0.07, 0.07]
      };
      const title = /title|heading/.test(String(block.sub_type || ""));
      blocks.push({
        id, box,
        paragraphs: [{ runs: Text.contentFromText(translated, { renderMathBox }).map(run => (run.type === "math" ? { ...run, display: false } : run)) }],
        fontSize: size.fontSize,
        lineHeight: Number.isFinite(size.lineHeight) ? size.lineHeight : fallbackLineHeight,
        firstBaseline: size.firstBaseline,
        fontWeight: size.bold ? "bold" : "regular",
        align: title ? "left" : "justify",
        justifyCap: JUSTIFY_CAP
      });
      stats.set += 1;
    }
    input.pages.push({ index: pageIndex, width: Number(page.width), height: Number(page.height), blocks, obstacles });
  }
  timings.inputMs = Date.now() - started - maths.stats.ms;

  started = Date.now();
  const engine = Typeset.createTypesetter({
    measurer: Text.createMeasurer({ metrics: defaultFontTable() }),
    measurers: { bold: Text.createMeasurer({ metrics: defaultFontTable("bold") }) }
  });
  const result = engine.typeset(input);
  timings.typesetMs = Date.now() - started;

  started = Date.now();
  const { source } = overlayDocument(result, paint, maths);
  fs.writeFileSync(path.join(options.out, "overlay.typ"), source);
  maths.prepareStamps(typst);
  typst.compile("overlay.typ", "overlay.pdf", options.out);
  timings.compileMs = Date.now() - started;
  timings.mathjaxMs = Math.round(maths.stats.ms);

  started = Date.now();
  const finalPdf = path.join(options.out, "final.pdf");
  python(fs.readFileSync(path.join(__dirname, "../overlay/merge.py"), "utf8"), [job.basePdf, path.join(options.out, "overlay.pdf"), finalPdf]);
  timings.mergeMs = Date.now() - started;

  // Optional check that Typst drew every engine line as exactly one line.
  let drift = null;
  if (options.drift) {
    started = Date.now();
    // Lines are counted by position on the page, so a block whose ink
    // overlaps another block's ink cannot be checked this way (the other
    // block's lines fall into its rows). Those are listed as unchecked; the
    // collision report already names them.
    const overlapping = new Set();
    for (const c of result.report.collisions) if (c.kind === "text") { overlapping.add(c.a); overlapping.add(c.b); }
    const expected = [];
    let unchecked = 0;
    result.pages.forEach((page, pageIndex) => {
      for (const node of page.nodes) {
        if (overlapping.has(node.id)) { unchecked += 1; continue; }
        // Only lines holding text: a formula-only line draws no text glyphs at
        // the block's size (its copyable LaTeX layer is sized to the formula).
        const OBJECT = String.fromCharCode(0xfffc);
        const lines = node.lines.filter(line => flatten(node.paragraphs[line.paragraph].runs).text.slice(line.start, line.end).replace(/[\s\u2028]/g, "").split(OBJECT).join("").length > 0);
        if (!lines.length) continue;
        // Rows closer than half a line are one row, unless the block's own
        // pitch is tighter than that.
        const pitch = Math.min(...lines.slice(1).map((line, k) => line.baseline - lines[k].baseline), Infinity);
        expected.push({ page: pageIndex, key: node.id, lines: lines.length, size: node.fontSize, gap: Math.min(node.fontSize * 0.5, pitch * 0.5),
          x0: Math.min(...lines.map(l => l.x)), x1: Math.max(...lines.map(l => l.x + l.width)),
          y0: Math.min(...lines.map(l => l.baseline)), y1: Math.max(...lines.map(l => l.baseline)) });
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
                if any(c["c"].strip() for c in s.get("chars", [])):
                    if e["x0"] - e["size"] * 0.6 <= ox <= e["x1"] + 2 and e["y0"] - e["size"] * 0.4 <= oy <= e["y1"] + e["size"] * 0.4 and abs(s["size"] - e["size"]) <= e["size"] * 0.03:
                        ys.append(oy)
    ys.sort(); rows = []
    for y in ys:
        if not rows or y - rows[-1] > e["gap"]: rows.append(y)
    if len(rows) != e["lines"]: bad.append({"key": e["key"], "page": e["page"] + 1, "expected": e["lines"], "rendered": len(rows)})
print(json.dumps({"nodes": len(expected), "mismatch": bad}))
`, [path.join(options.out, "overlay.pdf"), path.join(options.out, "expected-lines.json")]));
    drift.unchecked = unchecked;
    timings.driftMs = Date.now() - started;
  }

  if (options.png.length) {
    python(`
import fitz, sys, json
from PIL import Image
final = fitz.open(sys.argv[1]); ref = fitz.open(sys.argv[2]) if sys.argv[2] else None
for n in json.loads(sys.argv[4]):
    imgs = []
    for d in [final] + ([ref] if ref else []):
        pix = d[n - 1].get_pixmap(dpi=90); imgs.append(Image.frombytes("RGB", (pix.width, pix.height), pix.samples))
    w = sum(i.width for i in imgs) + 20 * (len(imgs) - 1); out = Image.new("RGB", (w, max(i.height for i in imgs)), (120, 120, 120)); x = 0
    for i in imgs: out.paste(i, (x, 0)); x += i.width + 20
    out.save(f"{sys.argv[3]}/compare-p{n}.png")
`, [finalPdf, job.renderedPdf || "", options.out, JSON.stringify(options.png)]);
  }

  // Summary of the engine's own report.
  const blocks = Object.values(result.report.blocks);
  const collisions = result.report.collisions;
  const report = {
    job: path.basename(options.job),
    baseIsSource: Boolean(job.baseIsSource),
    stats,
    overflow: {
      over1pt: blocks.filter(b => b.overflowBottom > 1).length,
      over5pt: blocks.filter(b => b.overflowBottom > 5).length,
      right: blocks.filter(b => b.overflowRight > 1).length,
      outsidePage: blocks.filter(b => b.outsidePage).length
    },
    collisions: {
      text: collisions.filter(c => c.kind === "text").length,
      obstacleOutsideOwnBox: collisions.filter(c => c.kind === "obstacle" && !c.insideOwnBox).length,
      obstacleInsideOwnBox: collisions.filter(c => c.kind === "obstacle" && c.insideOwnBox).length,
      examples: collisions.filter(c => !(c.kind === "obstacle" && c.insideOwnBox)).slice(0, 8)
    },
    drift: drift && { nodes: drift.nodes, mismatch: drift.mismatch.length, uncheckedOverlapping: drift.unchecked, examples: drift.mismatch.slice(0, 5) },
    formulas: { rendered: maths.stats.formulas, failed: maths.stats.failed.length },
    sizes: { finalPdf: fileSize(finalPdf), retainPdf: fileSize(job.renderedPdf), sourcePdf: fileSize(job.sourcePdf) },
    timings
  };
  fs.writeFileSync(path.join(options.out, "report.json"), JSON.stringify({ ...report, engineReport: result.report }, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main();
