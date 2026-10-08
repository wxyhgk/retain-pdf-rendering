"use strict";

// Corpus regression for the overlay route: runs experiments/overlay/run.js on
// every complete retain-pdf job (read-only) and summarises one row per job,
// ordered by severity.
//
//   node experiments/overlay/corpus.js [--jobs DIR] [--out DIR] [--preset retain]
//        [--only ID,ID] [--timeout SECONDS] [--no-drift-check] [--png 1,2]
//
// Writes <out>/summary.json and <out>/summary.md; each job's own output stays
// in <out>/<job>/ (report.json, final.pdf, ...). A job is complete when it has
// ocr/normalized/document.v1.json, translated/translation-manifest.json, a
// source PDF and retain-pdf's text-stripped prewarm PDF.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function parseArgs(argv) {
  const options = {
    jobs: path.resolve(__dirname, "../../../retain-pdf/data/jobs"),
    out: path.resolve(__dirname, "output/corpus"),
    preset: "retain",
    only: null,
    timeout: 600,
    driftCheck: true,
    png: ""
  };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--jobs") options.jobs = path.resolve(argv[++i]);
    else if (value === "--out") options.out = path.resolve(argv[++i]);
    else if (value === "--preset") options.preset = argv[++i];
    else if (value === "--only") options.only = new Set(argv[++i].split(","));
    else if (value === "--timeout") options.timeout = Number(argv[++i]);
    else if (value === "--no-drift-check") options.driftCheck = false;
    else if (value === "--png") options.png = argv[++i];
    else throw new Error(`unknown argument ${value}`);
  }
  return options;
}

function completeJobs(root) {
  const has = (dir, test) => fs.existsSync(dir) && fs.readdirSync(dir).some(test);
  return fs.readdirSync(root).filter(name => !name.startsWith("_")).sort().filter(name => {
    const job = path.join(root, name);
    return fs.existsSync(path.join(job, "ocr/normalized/document.v1.json"))
      && fs.existsSync(path.join(job, "translated/translation-manifest.json"))
      && has(path.join(job, "source"), file => file.endsWith(".pdf"))
      && has(path.join(job, "artifacts/render_prewarm"), file => file.endsWith("source-bbox-text-stripped.pdf"));
  });
}

const quantile = (sorted, q) => (sorted.length ? sorted[Math.floor(q * (sorted.length - 1))] : null);

// Same-column vertically adjacent text items (body + other text) whose fitted
// sizes differ: for every item, the next item below whose box overlaps it
// horizontally by more than half of the narrower width.
function adjacency(report, boxes) {
  const byPage = new Map();
  for (const entry of report.fontSizes || []) {
    if (!(entry.kind === "body_text" || entry.kind === "text") || !boxes[entry.id]) continue;
    if (!byPage.has(entry.page)) byPage.set(entry.page, []);
    byPage.get(entry.page).push({ size: entry.ours, box: boxes[entry.id] });
  }
  const diffs = [];
  for (const items of byPage.values()) {
    items.sort((a, b) => a.box[1] - b.box[1]);
    items.forEach((item, index) => {
      const next = items.slice(index + 1).find(other => {
        const overlap = Math.min(item.box[2], other.box[2]) - Math.max(item.box[0], other.box[0]);
        return overlap > 0.5 * Math.min(item.box[2] - item.box[0], other.box[2] - other.box[0]);
      });
      if (next) diffs.push(Math.abs(item.size - next.size));
    });
  }
  diffs.sort((a, b) => a - b);
  return { pairs: diffs.length, over1pt: diffs.filter(value => value > 1).length, p90: quantile(diffs, 0.9), max: diffs.length ? diffs[diffs.length - 1] : null };
}

function summarise(name, jobDir, report) {
  const doc = JSON.parse(fs.readFileSync(path.join(jobDir, "ocr/normalized/document.v1.json"), "utf8"));
  const boxes = {};
  for (const page of doc.pages || []) for (const block of page.blocks || []) boxes[block.block_id] = block.bbox;
  const body = (report.fontSizes || []).filter(entry => entry.kind === "body_text").map(entry => entry.ours).sort((a, b) => a - b);
  const titleRatios = (report.fontSizes || []).filter(entry => entry.kind === "title" && entry.retainPdf > 0)
    .map(entry => entry.ours / entry.retainPdf).sort((a, b) => a - b);
  const inv = report.invariants || {};
  const sourceBody = report.adapter && Number(report.adapter.sourceBodyFont);
  // Relative to the document's own body size (slides set at 9 pt are not
  // "small"), and any text shrunk to near-illegibility.
  const tiny = (report.fontSizes || []).filter(entry => entry.ours > 0 && entry.ours < 6);
  const sizes = report.sizes || {};
  return {
    job: name,
    status: "ok",
    pages: report.pages,
    nodes: report.paintedNodes,
    overlaps: inv.lineOverlaps ?? null,
    outside: inv.outside ?? null,
    order: inv.order ?? null,
    obstacleHits: inv.obstacleHits ?? null,
    vectorHits: report.vectorHits ? report.vectorHits.lines : null,
    drift: report.drift ? report.drift.mismatch : null,
    driftNodes: report.drift ? report.drift.nodes : null,
    formulas: report.formulas ? report.formulas.rendered : null,
    formulasFailed: report.formulas ? report.formulas.failed : null,
    stampFallbacks: report.stamps ? report.stamps.fallbacks : null,
    bodyCount: body.length,
    bodyMedian: quantile(body, 0.5),
    bodyMin: body.length ? body[0] : null,
    sourceBody: Number.isFinite(sourceBody) && sourceBody > 0 ? sourceBody : null,
    bodySmall: Number.isFinite(sourceBody) && sourceBody > 0 ? body.filter(value => value < 0.85 * sourceBody).length : null,
    tinyText: tiny.length,
    tinyExamples: tiny.slice(0, 5).map(entry => `p${entry.page} ${entry.id} ${entry.kind} ${entry.ours}`),
    retainBodyMedian: report.bodyFont && report.bodyFont.retainPdf ? report.bodyFont.retainPdf.median : null,
    titleRatioMin: titleRatios.length ? titleRatios[0] : null,
    titleRatioMedian: quantile(titleRatios, 0.5),
    adjacency: adjacency(report, boxes),
    fillBelow60: report.bodyFill ? report.bodyFill.below60 : null,
    spillOver2pt: report.spillBelowBox ? report.spillBelowBox.over2pt : null,
    spillMax: report.spillBelowBox && report.spillBelowBox.examples && report.spillBelowBox.examples.length
      ? Math.max(...report.spillBelowBox.examples.map(entry => entry.by)) : 0,
    finalKB: sizes.finalPdf ? Math.round(sizes.finalPdf / 1024) : null,
    retainKB: sizes.retainPdfRendered ? Math.round(sizes.retainPdfRendered / 1024) : null,
    sourceKB: sizes.sourcePdf ? Math.round(sizes.sourcePdf / 1024) : null,
    ms: report.timings ? Object.entries(report.timings).filter(([key]) => key.endsWith("Ms") && key !== "mergeInnerMs").reduce((sum, [, value]) => sum + (Number(value) || 0), 0) : null
  };
}

// Higher = look first. Hard failures dominate; then visible defects.
function severity(row) {
  if (row.status !== "ok") return 1e9;
  const hard = (row.overlaps || 0) + (row.outside || 0) + (row.order || 0) + (row.obstacleHits || 0) + (row.vectorHits || 0) + (row.drift || 0) + (row.formulasFailed || 0);
  return hard * 1000 + (row.tinyText || 0) * 50 + (row.bodySmall || 0) * 5 + (row.adjacency ? row.adjacency.over1pt : 0) * 2 + (row.spillOver2pt || 0)
    + (row.titleRatioMin !== null && row.titleRatioMin < 0.85 ? 20 : 0);
}

function markdown(rows) {
  const fmt = value => (value === null || value === undefined ? "–" : (typeof value === "number" && !Number.isInteger(value) ? value.toFixed(2) : String(value)));
  const header = ["job", "status", "pages", "overlaps/outside/order/obst/vector", "drift", "math fail", "body med (retain) [source]", "body <85% src", "text <6pt", "adj >1pt", "title min ratio", "fill<0.6", "spill>2pt (max)", "final/retain/source KB", "ms"];
  const lines = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`];
  for (const row of rows) {
    if (row.status !== "ok") {
      lines.push(`| ${row.job} | **${row.status}** | ${row.error ? row.error.replace(/\|/g, "/").slice(0, 120) : ""} |${" |".repeat(header.length - 3)}`);
      continue;
    }
    lines.push(`| ${[
      row.job, "ok", row.pages,
      [row.overlaps, row.outside, row.order, row.obstacleHits, row.vectorHits].map(fmt).join("/"),
      `${fmt(row.drift)}/${fmt(row.driftNodes)}`,
      `${fmt(row.formulasFailed)}/${fmt(row.formulas)}`,
      `${fmt(row.bodyMedian)} (${fmt(row.retainBodyMedian)}) [${fmt(row.sourceBody)}]`,
      `${fmt(row.bodySmall)}/${fmt(row.bodyCount)}`,
      fmt(row.tinyText),
      `${fmt(row.adjacency.over1pt)}/${fmt(row.adjacency.pairs)}`,
      fmt(row.titleRatioMin),
      fmt(row.fillBelow60),
      `${fmt(row.spillOver2pt)} (${fmt(row.spillMax)})`,
      `${fmt(row.finalKB)}/${fmt(row.retainKB)}/${fmt(row.sourceKB)}`,
      fmt(row.ms)
    ].join(" | ")} |`);
  }
  return lines.join("\n") + "\n";
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(options.out, { recursive: true });
  const jobs = completeJobs(options.jobs).filter(name => !options.only || options.only.has(name));
  const rows = [];
  for (const name of jobs) {
    const jobDir = path.join(options.jobs, name);
    const out = path.join(options.out, name);
    const args = [path.join(__dirname, "run.js"), jobDir, "--preset", options.preset, "--out", out];
    if (!options.driftCheck) args.push("--no-drift-check");
    if (options.png) args.push("--png", options.png);
    const started = Date.now();
    const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: options.timeout * 1000, maxBuffer: 256 * 1024 * 1024 });
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "run.log"), `${result.stdout || ""}\n--- stderr ---\n${result.stderr || ""}`);
    let row;
    if (result.error || result.status !== 0) {
      const message = result.error ? String(result.error.message || result.error)
        : String(result.stderr || "").split("\n").find(line => /Error|error/.test(line)) || `exit ${result.status}`;
      row = { job: name, status: result.error && result.error.code === "ETIMEDOUT" ? "timeout" : "crash", error: message.trim() };
    }
    else {
      try { row = summarise(name, jobDir, JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8"))); }
      catch (error) { row = { job: name, status: "crash", error: `summary: ${error.message}` }; }
    }
    row.wallMs = Date.now() - started;
    rows.push(row);
    process.stderr.write(`${name} ${row.status} ${row.wallMs} ms\n`);
  }
  rows.sort((a, b) => severity(b) - severity(a) || a.job.localeCompare(b.job));
  fs.writeFileSync(path.join(options.out, "summary.json"), JSON.stringify(rows, null, 2));
  fs.writeFileSync(path.join(options.out, "summary.md"), markdown(rows));
  process.stdout.write(markdown(rows));
}

main();
