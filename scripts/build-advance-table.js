#!/usr/bin/env node
"use strict";

// Extracts everything the JS line layout needs from a font into a compact
// JSON table, so runtimes (plugin, retain-pdf, browser) need neither the
// 23 MB OTF nor a font parser.
//
// node scripts/build-advance-table.js [font.otf] [out.json]
//
// Contents (units of unitsPerEm):
//   ranges     advance of every cmap code point (default shaping), as
//              [first, count, advance] runs — CJK compresses to a few runs
//   modes.zh   / modes.dflt (see src/text/metrics.js for the two shaping modes):
//     advances   code points whose advance differs from `ranges` in that mode
//     kern       { left: [right, delta, right, delta, ...] } pair deltas
//                (GPOS kerning and contextual substitutions)
//     ligatures  { "a,b": units, "a,b,c": units } sequences shaping to one glyph
// Pairs are probed by shaping every pair of the "Latin-side" repertoire
// below; CJK ideographs, kana and CJK punctuation neither kern nor ligate in
// Source Han Serif.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const fontkit = require("fontkit");

const FONT = process.argv[2] || path.resolve(__dirname, "../../retain-pdf/resources/fonts/SourceHanSerifSC-Regular.otf");
const OUT = process.argv[3] || path.resolve(__dirname, "../data/fonts/source-han-serif-sc-regular.json");

const PAIR_BLOCKS = [
  [0x20, 0x7e], [0xa0, 0xff], [0x100, 0x17f],            // Latin
  [0x370, 0x3ff], [0x400, 0x45f],                        // Greek, Cyrillic
  [0x2000, 0x206f], [0x2070, 0x209f], [0x20a0, 0x20bf],  // punctuation, super/subscripts, currency
  [0x2100, 0x214f], [0x2150, 0x218f], [0x2190, 0x21ff], [0x2200, 0x22ff] // letterlike, numbers, arrows, math
];

const MODES = { zh: ["latn", "ZHS "], dflt: [undefined, undefined] };

function main() {
  const started = performance.now();
  const font = fontkit.openSync(FONT);
  const os2 = font["OS/2"];
  const cmap = [...font.characterSet].sort((a, b) => a - b);
  const width = (text, mode) => font.layout(text, undefined, ...MODES[mode]);

  // Base advances: default shaping of each code point alone.
  const base = new Map(cmap.map(cp => [cp, width(String.fromCodePoint(cp), "dflt").positions.reduce((s, p) => s + p.xAdvance, 0)]));
  const ranges = [];
  for (const cp of cmap) {
    const advance = base.get(cp);
    const last = ranges[ranges.length - 1];
    if (last && last[0] + last[1] === cp && last[2] === advance) last[1] += 1;
    else ranges.push([cp, 1, advance]);
  }

  const repertoire = [];
  for (const [first, last] of PAIR_BLOCKS) for (let cp = first; cp <= last; cp++) if (font.hasGlyphForCodePoint(cp)) repertoire.push(cp);

  const modes = {};
  for (const mode of Object.keys(MODES)) {
    const advances = {};
    const advanceOf = new Map();
    for (const cp of cmap) {
      const advance = width(String.fromCodePoint(cp), mode).positions.reduce((s, p) => s + p.xAdvance, 0);
      advanceOf.set(cp, advance);
      if (advance !== base.get(cp)) advances[cp] = advance;
    }
    const kern = {};
    const ligatures = {};
    for (const a of repertoire) {
      for (const b of repertoire) {
        const run = width(String.fromCodePoint(a, b), mode);
        const total = run.positions.reduce((s, p) => s + p.xAdvance, 0);
        if (run.glyphs.length === 1) {
          ligatures[`${a},${b}`] = total;
          for (const c of repertoire) {
            const triple = width(String.fromCodePoint(a, b, c), mode);
            if (triple.glyphs.length === 1) ligatures[`${a},${b},${c}`] = triple.positions[0].xAdvance;
          }
          continue;
        }
        const delta = total - advanceOf.get(a) - advanceOf.get(b);
        if (delta) (kern[a] ||= []).push(b, delta);
      }
    }
    modes[mode] = { advances, kern, ligatures };
  }

  const table = {
    font: path.basename(FONT),
    sha256: crypto.createHash("sha256").update(fs.readFileSync(FONT)).digest("hex"),
    unitsPerEm: font.unitsPerEm,
    ascender: os2.typoAscender,
    descender: os2.typoDescender,
    capHeight: os2.capHeight,
    xHeight: os2.xHeight,
    defaultAdvance: font.unitsPerEm,
    repertoire: PAIR_BLOCKS,
    ranges,
    modes
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const json = JSON.stringify(table);
  fs.writeFileSync(OUT, json);
  const gzip = zlib.gzipSync(json, { level: 9 }).length;
  const brotli = zlib.brotliCompressSync(json).length;
  const stats = {
    out: OUT,
    seconds: Math.round((performance.now() - started) / 100) / 10,
    cmapCodePoints: cmap.length,
    ranges: ranges.length,
    repertoire: repertoire.length,
    zh: { advanceOverrides: Object.keys(modes.zh.advances).length, kernPairs: Object.values(modes.zh.kern).reduce((s, v) => s + v.length / 2, 0), ligatures: Object.keys(modes.zh.ligatures).length },
    dflt: { advanceOverrides: Object.keys(modes.dflt.advances).length, kernPairs: Object.values(modes.dflt.kern).reduce((s, v) => s + v.length / 2, 0), ligatures: Object.keys(modes.dflt.ligatures).length },
    bytes: json.length,
    gzipBytes: gzip,
    brotliBytes: brotli
  };
  console.log(JSON.stringify(stats, null, 2));
}

main();
