"use strict";

// Pixel parity of stamped formulas against their whole-formula SVGs.
//
//   node experiments/typst/stamp-parity.js <out dir> [--dpi 600] [--em 24] [--crops N]
//
// <out dir> is an overlay / typst run output with math/formulas.json (written
// by MathStore.manifest()), math/*.svg and math/stamps.pdf. Every stamped
// formula is drawn on its own page twice (old: the SVG; new: the stamps) at
// the same box size, both PDFs are rasterized, and the grayscale images are
// compared pixel by pixel. Writes parity.json and the worst crops.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const typst = require("./typst");
const { PREAMBLE } = require("./emit");
const { stampsValue } = require("./math-stamps");

const PYTHON = process.env.RPR_PYTHON || path.resolve(__dirname, "../../../retain-pdf/backend/.venv/bin/python");

function parseArgs(argv) {
  const options = { dir: "", dpi: 600, em: 24, crops: 6 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dpi") options.dpi = Number(argv[++i]);
    else if (argv[i] === "--em") options.em = Number(argv[++i]);
    else if (argv[i] === "--crops") options.crops = Number(argv[++i]);
    else options.dir = path.resolve(argv[i]);
  }
  if (!options.dir) throw new Error("usage: stamp-parity.js <out dir> [--dpi 600] [--em 24] [--crops N]");
  return options;
}

function fmt(value) {
  return Number(value).toFixed(4).replace(/\.?0+$/, "") || "0";
}

const COMPARE = String.raw`
import sys, json, fitz
from PIL import Image, ImageChops
old_path, new_path, dpi, out_dir, crops = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4], int(sys.argv[5])
old, new = fitz.open(old_path), fitz.open(new_path)
def gray(page):
    pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY, alpha=False)
    return Image.frombytes("L", (pix.width, pix.height), pix.samples)
rows = []
for i in range(len(old)):
    a, b = gray(old[i]), gray(new[i])
    if a.size != b.size: b = b.resize(a.size)
    diff = ImageChops.difference(a, b)
    hist = diff.histogram()
    ink = sum(Image.eval(a, lambda v: 255 if v < 128 else 0).histogram()[255:])
    rows.append({"page": i, "max": max(k for k, n in enumerate(hist) if n), "over64": sum(hist[65:]), "over128": sum(hist[129:]), "ink": ink, "px": a.size[0] * a.size[1]})
worst = sorted(rows, key=lambda r: (r["over64"], r["max"]), reverse=True)[:crops]
for r in worst:
    a, b = gray(old[r["page"]]), gray(new[r["page"]])
    w, h = a.size
    canvas = Image.new("L", (w, h * 2 + 8), 255)
    canvas.paste(a, (0, 0)); canvas.paste(b, (0, h + 8))
    canvas.save(f"{out_dir}/parity-worst-{r['page']}.png")
print(json.dumps(rows))
`;

function main() {
  const options = parseArgs(process.argv.slice(2));
  const formulas = JSON.parse(fs.readFileSync(path.join(options.dir, "math", "formulas.json"), "utf8"));
  const stamped = formulas.filter(entry => entry.items);
  const header = `${PREAMBLE}\n`;
  const page = (entry, visual) => {
    const w = entry.widthEm * options.em, h = entry.heightEm * options.em;
    return `#page(width: ${fmt(w)}pt, height: ${fmt(h)}pt, margin: 0pt, rpr-draw(${visual}, ${fmt(w)}pt, ${fmt(h)}pt))`;
  };
  fs.writeFileSync(path.join(options.dir, "parity-old.typ"), header + stamped.map(entry => page(entry, JSON.stringify(entry.file))).join("\n") + "\n");
  fs.writeFileSync(path.join(options.dir, "parity-new.typ"), header + stamped.map(entry => page(entry, stampsValue("math/stamps.pdf", entry.items))).join("\n") + "\n");
  typst.compile("parity-old.typ", "parity-old.pdf", options.dir);
  typst.compile("parity-new.typ", "parity-new.pdf", options.dir);
  const result = spawnSync(PYTHON, ["-c", COMPARE, path.join(options.dir, "parity-old.pdf"), path.join(options.dir, "parity-new.pdf"), String(options.dpi), options.dir, String(options.crops)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr);
  const rows = JSON.parse(result.stdout).map(row => ({ ...row, tex: stamped[row.page].tex }));
  const summary = {
    formulas: formulas.length,
    stamped: stamped.length,
    unstamped: formulas.length - stamped.length,
    dpi: options.dpi,
    emPt: options.em,
    maxPixelDiff: Math.max(0, ...rows.map(row => row.max)),
    formulasWithPixelsOver64: rows.filter(row => row.over64 > 0).length,
    formulasWithPixelsOver128: rows.filter(row => row.over128 > 0).length,
    worstOver64RatioToInk: Math.max(0, ...rows.map(row => row.over64 / Math.max(1, row.ink))),
    worst: rows.slice().sort((a, b) => b.over64 - a.over64 || b.max - a.max).slice(0, options.crops)
      .map(row => ({ page: row.page, tex: row.tex, max: row.max, over64: row.over64, over128: row.over128, ink: row.ink }))
  };
  fs.writeFileSync(path.join(options.dir, "parity.json"), JSON.stringify({ summary, rows }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main();
