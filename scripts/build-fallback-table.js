#!/usr/bin/env node
"use strict";

// Adds the advance widths of characters the primary font lacks to an advance
// table (data/fonts/*.json), as Typst actually sets them.
//
// node scripts/build-fallback-table.js [table.json ...]
//
// Source Han Serif has no glyph for many characters that do occur in papers:
// most of Latin Extended-A (ą č ę ğ ł ń ş ź ż — Polish, Czech, Turkish names),
// much of Greek and the math operators. Typst draws those with a fallback
// font; without this table the measurer would count each as 1 em (the
// table's defaultAdvance). Typst itself measures every assigned, non-mark,
// non-control code point in BLOCKS that the font's cmap lacks, set in the
// table's family and weight with the same flags as the emitter
// (--font-path <retain-pdf fonts> --ignore-system-fonts, so the fallback is
// one of Typst's embedded fonts and the same on every machine).
//
// Result: table.fallback = { typst, ranges: [[first, count, advance], ...],
// decompose: [[code point, base], ...], alias: [[code point, equivalent], ...] }
// in the table's units. Characters no
// font covers keep defaultAdvance.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TYPST = process.env.TYPST_BIN || path.join(os.homedir(), ".local/bin/typst");
const FONT_DIR = process.env.RPR_FONT_DIR || path.resolve(__dirname, "../../retain-pdf/resources/fonts");
const TABLES = process.argv.slice(2).length ? process.argv.slice(2) : [
  path.resolve(__dirname, "../data/fonts/source-han-serif-sc-regular.json"),
  path.resolve(__dirname, "../data/fonts/source-han-serif-sc-bold.json")
];

const BLOCKS = [
  [0x20, 0x24f],     // Latin, Latin-1, Latin Extended-A/B
  [0x250, 0x2ff],    // IPA, spacing modifier letters
  [0x370, 0x52f],    // Greek, Cyrillic
  [0x1e00, 0x1fff],  // Latin Extended Additional, Greek Extended
  [0x2000, 0x2bff],  // punctuation, super/subscripts, currency, letterlike,
                     // number forms, arrows, math, technical, shapes, symbols
  [0xfb00, 0xfb06],  // Latin ligatures
  [0x1d400, 0x1d7ff] // mathematical alphanumeric symbols
];
const SKIP = /[\p{M}\p{C}\p{Zl}\p{Zp}]/u; // marks, controls, line/paragraph separators
const ASSIGNED = /\p{Assigned}/u;

function typst(args, cwd) {
  const result = spawnSync(TYPST, [...args, "--font-path", FONT_DIR, "--ignore-system-fonts"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`typst ${args[0]} failed:\n${result.stderr}`);
  return result.stdout;
}

function family(table) {
  // "SourceHanSerifSC-Bold.otf" -> family "Source Han Serif SC", weight "bold"
  const name = String(table.font || "");
  if (!/^SourceHanSerifSC-/.test(name)) throw new Error(`unknown font ${name}; extend family()`);
  return { family: "Source Han Serif SC", weight: /Bold/.test(name) ? "bold" : "regular" };
}

function runs(entries) {
  const out = [];
  for (const [cp, advance] of entries) {
    const last = out[out.length - 1];
    if (last && last[0] + last[1] === cp && last[2] === advance) last[1] += 1;
    else out.push([cp, 1, advance]);
  }
  return out;
}

function build(file) {
  const table = JSON.parse(fs.readFileSync(file, "utf8"));
  const { family: name, weight } = family(table);
  const covered = new Set();
  for (const [first, count] of table.ranges) for (let i = 0; i < count; i++) covered.add(first + i);
  const candidates = [];
  for (const [first, last] of BLOCKS) {
    for (let cp = first; cp <= last; cp++) {
      const ch = String.fromCodePoint(cp);
      if (!covered.has(cp) && ASSIGNED.test(ch) && !SKIP.test(ch)) candidates.push(cp);
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpr-fallback-"));
  try {
    const size = table.unitsPerEm; // 1 pt per font unit
    const source = [
      `#set text(font: "${name}", weight: "${weight}", size: ${size}pt, lang: "zh")`,
      `#let cps = (${candidates.join(", ")},)`,
      `#context [#metadata(cps.map(cp => measure(str.from-unicode(cp)).width.pt())) <rpr-fallback>]`
    ].join("\n");
    fs.writeFileSync(path.join(dir, "fallback.typ"), source);
    const widths = JSON.parse(typst(["query", "fallback.typ", "<rpr-fallback>", "--field", "value", "--one"], dir));
    const entries = [];
    candidates.forEach((cp, index) => {
      const advance = Math.round(widths[index] * 1000) / 1000;
      // Nothing covers it: Typst draws the primary font's .notdef, which is
      // what defaultAdvance already says.
      if (advance !== table.defaultAdvance) entries.push([cp, advance]);
    });
    // Precomposed letters the font lacks but whose canonical decomposition
    // it has (č = c + U+030C) are drawn by Typst in the font itself as base +
    // mark; kerning then applies to the base letter: [code point, base].
    // HarfBuzz decomposes a character the font lacks pairwise and
    // recursively (Ǟ -> Ä + U+0304, Ä kept if the font has it) and uses the
    // pieces only if the font has all of them; otherwise the whole character
    // goes to the fallback font (ğ: no U+0306 in Source Han). A letter drawn
    // this way kerns with the glyph before it as its base (decompose). A
    // singleton equivalent (U+037E -> ;, U+212A -> K) is that character
    // outright and kerns on both sides (alias).
    const has = cp => covered.has(cp);
    const pieces = cp => {
      if (has(cp)) return [cp];
      const parts = [...String.fromCodePoint(cp).normalize("NFD")].map(ch => ch.codePointAt(0));
      if (parts.length === 1) return parts[0] !== cp && has(parts[0]) ? [parts[0]] : null;
      const first = [...String.fromCodePoint(...parts.slice(0, -1)).normalize("NFC")];
      if (first.length !== 1) return null;
      const head = pieces(first[0].codePointAt(0));
      const mark = parts[parts.length - 1];
      return head && has(mark) ? [...head, mark] : null;
    };
    const decompose = [];
    const alias = [];
    for (const cp of candidates) {
      const drawn = pieces(cp);
      if (!drawn) continue;
      if (drawn.length === 1) alias.push([cp, drawn[0]]);
      else decompose.push([cp, drawn[0]]);
    }
    const version = spawnSync(TYPST, ["--version"], { encoding: "utf8" }).stdout.trim();
    table.fallback = { typst: version, flags: "--ignore-system-fonts (embedded fallback fonts)", ranges: runs(entries), decompose, alias };
    fs.writeFileSync(file, JSON.stringify(table));
    console.log(JSON.stringify({ table: path.basename(file), weight, candidates: candidates.length, fallback: entries.length, ranges: table.fallback.ranges.length, decompose: decompose.length, alias: alias.length }));
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const file of TABLES) build(file);
