#!/usr/bin/env node
"use strict";

// Parity: our JS line layout vs Typst's own `linebreaks: "simple"` layout.
//
// node experiments/measure/compare-typst.js [--sizes 7,8.5,10,11.5] [--out DIR] [--verbose]
//
// Every paragraph of every golden fixture (source and translation modes, plus
// the demo inline-math sentences) is laid out at several font sizes in its
// real column width. Typst renders each probe on its own page; PyMuPDF reads
// the glyphs back and groups them into lines by baseline. A probe matches
// when every line holds exactly the same characters in both layouts.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pageNodes } = require("../typst/content");
const { PREAMBLE, MathStore, FONT_FAMILY } = require("../typst/emit");
const typst = require("../typst/typst");
const { FontMetrics } = require("./font-metrics");
const { prepare, layout, OBJECT, LINE_SEPARATOR } = require("./linebreak");
const { mathSegments, DEMO_SENTENCES, FALLBACK_BOX } = require("./shared");

const PYTHON = process.env.RPR_PYTHON || path.resolve(__dirname, "../../../retain-pdf/backend/.venv/bin/python");
const FONT = path.join(typst.FONT_DIR, "SourceHanSerifSC-Regular.otf");

function parseArgs(argv) {
  const options = { sizes: [7, 8.5, 10, 11.5], out: path.resolve(__dirname, "output/compare"), verbose: false, table: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--sizes") options.sizes = argv[++i].split(",").map(Number);
    else if (argv[i] === "--out") options.out = path.resolve(argv[++i]);
    else if (argv[i] === "--verbose") options.verbose = true;
    else if (argv[i] === "--table") options.table = path.resolve(argv[++i]);
    else if (argv[i] === "--only") options.only = argv[++i];
  }
  return options;
}

function fmt(value) {
  return Number(value).toFixed(4).replace(/\.?0+$/, "") || "0";
}

function typstString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/[\u0000-\u0008\u000b-\u001f]/g, "")}"`;
}

function collectProbes(sizes) {
  const dir = path.resolve(__dirname, "../../test/fixtures/model-golden");
  const seen = new Set();
  const probes = [];
  for (const name of fs.readdirSync(dir).filter(file => file.endsWith(".json")).sort()) {
    const fixture = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    const model = fixture.expected;
    const hasTranslation = model.pages.some(page => (page.blocks || []).some(block => block.translatedText));
    for (const mode of hasTranslation ? ["source", "translation"] : ["source"]) {
      for (const page of model.pages) {
        for (const node of pageNodes(page, mode)) {
          if (!node.paragraphs?.length || node.render === "formula") continue;
          const width = node.contentBox[2] - node.contentBox[0];
          if (width < 8) continue;
          node.paragraphs.forEach((paragraph, index) => {
            const key = JSON.stringify([paragraph.segments, paragraph.indent, width, node.align, node.hangingIndent]);
            if (seen.has(key)) return;
            seen.add(key);
            for (const size of sizes) probes.push({ fixture: fixture.name, mode, node: node.key, para: index, paragraph, width, size, justify: node.align === "justify", hanging: node.hangingIndent });
          });
        }
      }
    }
  }
  // Inline formulas: the fixtures have none, so add the demo sentences
  // (alone and embedded in body text) in a typical column width.
  const body = "冲击波在水中的传播并比较测量结果与数值模拟之间的差异本研究采用合成数据分析。";
  DEMO_SENTENCES.forEach((sentence, index) => {
    for (const text of [sentence, body + sentence + body]) {
      for (const size of sizes) {
        probes.push({ fixture: "demo-math", mode: "translation", node: `demo#${index}`, para: 0, paragraph: { indent: 9, segments: mathSegments(text) }, width: 240, size, justify: true, hanging: false });
      }
    }
  });
  if (STRESS) probes.push(...stressProbes(sizes));
  return probes;
}

// Deterministic random paragraphs mixing what is most likely to disagree:
// consecutive CJK punctuation, quotes/brackets at line edges, CJK–Latin
// adjacency (with and without spaces), numbers/percent/units, hyphens and
// slashes, inline formulas, varied widths.
const STRESS = !process.argv.includes("--no-stress");
function stressProbes(sizes) {
  let seed = Number(process.env.RPR_STRESS_SEED || 20261007);
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = list => list[Math.floor(random() * list.length)];
  const han = "冲击波在水中的传播并比较测量结果与数值模拟之间差异本研究采用合成数据分析压力密度温度速度能量守恒方程";
  const words = ["shock", "Hugoniot", "pressure", "water", "density", "MinerU", "PDF", "LaTeX", "ρ0", "u_s", "3.5%", "10–20", "km/s", "e.g.", "state-of-the-art", "http://example.org/a/b", "Fig.", "(a)", "[12]", "Eq. (3)", "GPa", "1.25×10³", "α-β"];
  const punct = ["，", "。", "、", "：", "；", "！", "？", "……", "——", "”，", "）。", "」、", "》，", "。”", "？！"];
  const open = ["“", "（", "《", "「", "【", "‘"];
  const close = ["”", "）", "》", "」", "】", "’"];
  const maths = ["\\(x_i\\)", "\\(E = mc^2\\)", "\\(\\frac{a}{b}\\)", "\\(\\rho_0 u_s u_p\\)", "\\(10^{-3}\\)"];
  const probes = [];
  for (let k = 0; k < Number(process.env.RPR_STRESS_COUNT || 160); k++) {
    let text = "";
    const length = 20 + Math.floor(random() * 120);
    while ([...text].length < length) {
      const r = random();
      if (r < 0.45) { const n = 1 + Math.floor(random() * 8); for (let i = 0; i < n; i++) text += han[Math.floor(random() * han.length)]; }
      else if (r < 0.62) text += (random() < 0.5 ? " " : "") + pick(words) + (random() < 0.5 ? " " : "");
      else if (r < 0.78) text += pick(punct);
      else if (r < 0.9) { const i = Math.floor(random() * open.length); text += open[i] + han.slice(0, 2 + Math.floor(random() * 6)) + close[i]; }
      else text += (random() < 0.5 ? " " : "") + pick(maths) + (random() < 0.5 ? " " : "");
    }
    const width = 60 + Math.floor(random() * 420);
    const justify = random() < 0.7;
    const indent = random() < 0.4 ? Math.round(random() * 20) : 0;
    const hanging = random() < 0.15;
    for (const size of sizes) probes.push({ fixture: "stress", mode: "translation", node: `stress#${k}`, para: 0, paragraph: { indent, segments: mathSegments(text) }, width, size, justify, hanging });
  }
  return probes;
}

function inlineTypst(segments, maths) {
  const pieces = [];
  for (const segment of segments) {
    if (segment.type === "text") {
      segment.value.split(LINE_SEPARATOR).forEach((chunk, index) => {
        if (index) pieces.push("linebreak()");
        if (chunk) pieces.push(typstString(chunk));
      });
      continue;
    }
    const entry = maths.get(segment.value, false);
    const tex = `$${segment.value}$`;
    pieces.push(entry.ok
      ? `rpr-math(${typstString(entry.file)}, ${fmt(entry.widthEm)}em, ${fmt(entry.heightEm)}em, ${fmt(entry.depthEm)}em, ${typstString(tex)})`
      : `rpr-tex-fallback(${typstString(tex)})`);
  }
  return pieces.length ? `[#${pieces.join("#")}]` : "[]";
}

// Inline formula boxes for our layout (same sizes the emitter gives Typst).
function measuredSegments(segments, maths) {
  return segments.map(segment => {
    if (segment.type !== "math") return segment;
    const entry = maths.get(segment.value, false);
    const tex = `$${segment.value}$`;
    if (!entry.ok) return { type: "math", tex, ...FALLBACK_BOX(tex) };
    return { type: "math", tex, widthEm: Number(fmt(entry.widthEm)), heightEm: Number(fmt(entry.heightEm)), depthEm: Number(fmt(entry.depthEm)) };
  });
}

function normalize(text) {
  return text.replace(/[\s\u2028]+/g, "");
}

function ourLines(probe, metrics, maths) {
  const segments = measuredSegments(probe.paragraph.segments, maths);
  const prepared = prepare(segments, metrics, { indentPt: probe.hanging ? 0 : probe.paragraph.indent, hangingIndentEm: probe.hanging ? 1.1 : 0 });
  const result = layout(prepared, probe.size, probe.width);
  const maths$ = [];
  segments.forEach(segment => { if (segment.type === "math") maths$.push(segment.tex); });
  let mathIndex = 0;
  const mathAt = new Map();
  for (let i = 0; i < prepared.text.length; i++) if (prepared.text[i] === OBJECT) mathAt.set(i, maths$[mathIndex++]);
  return result.lines.map(line => {
    let out = "";
    for (let i = line.start; i < line.end; i++) out += prepared.text[i] === OBJECT ? mathAt.get(i) : prepared.text[i];
    return normalize(out);
  }).filter(Boolean);
}

function typstDocument(probes, maths) {
  const lines = [
    `#set text(font: "${FONT_FAMILY}", top-edge: "ascender", bottom-edge: "descender", lang: "zh")`,
    PREAMBLE
  ];
  for (const probe of probes) {
    const indent = !probe.hanging && probe.paragraph.indent > 0 ? `#h(${fmt(probe.paragraph.indent)}pt)` : "";
    // Right margin: Typst hangs line-final punctuation into it (overhang);
    // a page exactly as wide as the column would clip it from extraction.
    lines.push(`#page(width: ${fmt(probe.width + 24)}pt, height: auto, margin: (left: 0pt, top: 0pt, bottom: 0pt, right: 24pt))[#{ set text(size: ${fmt(probe.size)}pt); set par(leading: 0.8em, justify: ${probe.justify}, linebreaks: "simple"${probe.hanging ? ", hanging-indent: 1.1em" : ""}); [${indent}#${inlineTypst(probe.paragraph.segments, maths)}] }]`);
  }
  return lines.join("\n") + "\n";
}

function extractLines(pdf) {
  const script = `
import fitz, sys, json
doc = fitz.open(sys.argv[1])
out = []
for page in doc:
    chars = []
    for block in page.get_text("rawdict")["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                for ch in span["chars"]:
                    chars.append((ch["origin"][1], ch["origin"][0], ch["c"], span["size"]))
    # Group by baseline. Transparent formula text sits on the line baseline.
    chars.sort(key=lambda t: (t[0], t[1]))
    lines = []
    for y, x, c, size in chars:
        if lines and abs(lines[-1]["y"] - y) <= max(1.0, 0.3 * size):
            lines[-1]["chars"].append((x, c))
        else:
            lines.append({"y": y, "chars": [(x, c)]})
    out.append(["".join(c for _, c in sorted(line["chars"], key=lambda t: t[0])) for line in lines])
print(json.dumps(out))
`;
  const result = spawnSync(PYTHON, ["-c", script, pdf], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  fs.rmSync(options.out, { recursive: true, force: true });
  fs.mkdirSync(options.out, { recursive: true });
  const metrics = options.table
    ? FontMetrics.fromTable(JSON.parse(fs.readFileSync(options.table, "utf8")))
    : FontMetrics.fromFont(FONT);
  const maths = new MathStore(options.out);
  let probes = collectProbes(options.sizes);
  if (options.only) {
    probes = probes.filter(p => p.node === options.only);
    for (const probe of probes) {
      const segments = measuredSegments(probe.paragraph.segments, maths);
      const prepared = prepare(segments, metrics, { indentPt: probe.hanging ? 0 : probe.paragraph.indent, hangingIndentEm: probe.hanging ? 1.1 : 0 });
      const result = layout(prepared, probe.size, probe.width);
      console.log(`size ${probe.size} width ${probe.width} indent ${probe.paragraph.indent} hanging ${probe.hanging}`);
      console.log("breaks", prepared.breaks.map(b => `${b.position}${b.mandatory ? "!" : ""}`).join(" "));
      for (const line of result.lines) console.log(`  [${line.start},${line.end}) ${line.widthPt.toFixed(2)} ${JSON.stringify(prepared.text.slice(line.start, line.end))}`);
    }
  }
  fs.writeFileSync(path.join(options.out, "probes.typ"), typstDocument(probes, maths));
  typst.compile("probes.typ", "probes.pdf", options.out);
  const typstPages = extractLines(path.join(options.out, "probes.pdf"));
  if (typstPages.length !== probes.length) throw new Error(`expected ${probes.length} pages, got ${typstPages.length}`);

  const results = probes.map((probe, index) => {
    const theirs = typstPages[index].map(normalize).filter(Boolean);
    const ours = ourLines(probe, metrics, maths);
    // Compare lines as character multisets: PyMuPDF splits ligature glyphs
    // (fi, fl) into characters whose x order is not reliable.
    const bag = line => [...line].sort().join("");
    const sameText = bag(theirs.join("")) === bag(ours.join(""));
    const exact = sameText && theirs.length === ours.length && theirs.every((line, i) => bag(line) === bag(ours[i]));
    return { ...probe, paragraph: undefined, typstLines: theirs.length, ourLines: ours.length, sameText, exact, theirs, ours };
  });
  const exact = results.filter(r => r.exact).length;
  const lineCount = results.filter(r => r.typstLines === r.ourLines).length;
  const textMismatch = results.filter(r => !r.sameText).length;
  const summary = {
    probes: results.length,
    paragraphs: new Set(results.map(r => `${r.fixture}|${r.mode}|${r.node}|${r.para}`)).size,
    sizes: options.sizes,
    exactBreaks: exact,
    exactRate: Number((exact / results.length).toFixed(4)),
    sameLineCount: lineCount,
    lineCountRate: Number((lineCount / results.length).toFixed(4)),
    extractionTextMismatch: textMismatch,
    metricsSource: options.table ? "table" : "font"
  };
  const mismatches = results.filter(r => !r.exact).map(r => {
    let firstDiff = 0;
    while (firstDiff < Math.min(r.theirs.length, r.ours.length) && r.theirs[firstDiff] === r.ours[firstDiff]) firstDiff++;
    return {
      fixture: r.fixture, mode: r.mode, node: r.node, para: r.para, size: r.size, width: r.width,
      justify: r.justify, hanging: r.hanging, indent: probes.find(p => p.node === r.node && p.size === r.size)?.paragraph.indent,
      typstLines: r.typstLines, ourLines: r.ourLines, sameText: r.sameText, line: firstDiff,
      typst: r.theirs.slice(firstDiff, firstDiff + 2), ours: r.ours.slice(firstDiff, firstDiff + 2)
    };
  });
  fs.writeFileSync(path.join(options.out, "parity.json"), JSON.stringify({ summary, mismatches }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (options.verbose) for (const m of mismatches.slice(0, 40)) console.log(JSON.stringify(m));
}

main();
