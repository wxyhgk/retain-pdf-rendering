"use strict";

// Font metrics for the pure-JS line layout, in em units (1 em = 1 font size).
//
// Two sources with one interface:
//   FontMetrics.fromFont(path)  — reads the OTF/TTF with fontkit (dev/build time;
//                                 pair data is computed lazily on first use)
//   FontMetrics.fromTable(json) — a compact table produced by
//                                 build-advance-table.js, so runtimes need not
//                                 ship or parse the 23 MB font
//
// Shaping model. Typst shapes each text run with rustybuzz, the font's
// default features, language "zh" (from `set text(lang: "zh")`) and the run's
// script guessed as harfbuzz does: the first character with a concrete
// script. Source Han Serif registers its ZHS language system under every
// concrete script (latn, hani, grek, cyrl, kana, hang) and none under DFLT, so
// there are exactly two shaping modes:
//   "zh"   — the run contains a Latin/Han/Greek/Cyrillic/kana/Hangul character:
//            `locl` ZHS applies (— and ― become 1 em, —— 2 em, no kerning
//            around …)
//   "dflt" — the run has only Common characters (punctuation, digits,
//            symbols): default glyphs (—— is the 1692-unit two-em ligature)
// What changes advances, per mode:
//   - per-code-point advance (cmap → hmtx)
//   - pair effects among "Latin-side" characters (< U+2E80: Latin, Greek,
//     Cyrillic, general punctuation, symbols): GPOS kerning and contextual
//     substitutions are captured together as the pair's width delta, and a
//     pair that shapes to ONE glyph is a ligature (fi, fl, ff, ——, …);
//     three-character ligatures (ffi, ffl) are probed when a pair ligates
// CJK ideographs, kana and CJK punctuation never kern or ligate in this font.
//
// Vertical metrics follow the Typst emitter's top-edge "ascender" /
// bottom-edge "descender", which Typst reads from OS/2 typo metrics (880 /
// -120 for Source Han Serif: a line of text is exactly 1 em tall).

const PAIR_LIMIT = 0x2e80;
const STRONG_SCRIPT = /[\p{Script=Latin}\p{Script=Han}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

class FontMetrics {
  constructor({ unitsPerEm, ascender, descender, defaultAdvance, modes, font = null }) {
    this.unitsPerEm = unitsPerEm;
    this.ascender = ascender / unitsPerEm;
    this.descender = -descender / unitsPerEm; // positive, below baseline
    this.defaultAdvance = defaultAdvance;
    // Per shaping mode ("zh" | "dflt"):
    //   advances Map<cp, units>
    //   pairs    Map<"a,b", { lig: units } | { kern: units } | null>
    //   triples  Map<"a,b,c", units | null>  three-character ligatures
    this.modes = modes;
    this.font = font;
  }

  static emptyModes() {
    const mode = () => ({ advances: new Map(), pairs: new Map(), triples: new Map() });
    return { zh: mode(), dflt: mode() };
  }

  layoutArgs(mode) {
    return mode === "zh" ? ["latn", "ZHS "] : [undefined, undefined];
  }

  static fromFont(path) {
    const fontkit = require("fontkit");
    const font = fontkit.openSync(path);
    const os2 = font["OS/2"];
    return new FontMetrics({
      unitsPerEm: font.unitsPerEm,
      ascender: os2.typoAscender,
      descender: os2.typoDescender,
      defaultAdvance: font.unitsPerEm,
      modes: FontMetrics.emptyModes(),
      font
    });
  }

  // Table layout (see build-advance-table.js): advances are shared ranges
  // plus per-mode overrides; kerning and ligatures are per mode. Anything
  // absent has no effect.
  static fromTable(table) {
    const modes = FontMetrics.emptyModes();
    const base = new Map();
    for (const [first, count, advance] of table.ranges) for (let i = 0; i < count; i++) base.set(first + i, advance);
    for (const name of ["zh", "dflt"]) {
      const mode = modes[name];
      const source = table.modes[name];
      mode.advances = new Map(base);
      for (const [cp, advance] of Object.entries(source.advances || {})) mode.advances.set(Number(cp), advance);
      for (const [left, entries] of Object.entries(source.kern || {})) {
        for (let i = 0; i < entries.length; i += 2) mode.pairs.set(`${left},${entries[i]}`, { kern: entries[i + 1] });
      }
      for (const [key, units] of Object.entries(source.ligatures || {})) {
        if (key.split(",").length === 2) mode.pairs.set(key, { lig: units });
        else mode.triples.set(key, units);
      }
    }
    return new FontMetrics({
      unitsPerEm: table.unitsPerEm,
      ascender: table.ascender,
      descender: table.descender,
      defaultAdvance: table.defaultAdvance,
      modes
    });
  }

  advanceUnits(cp, mode = "zh") {
    const advances = this.modes[mode].advances;
    let value = advances.get(cp);
    if (value === undefined) {
      if (this.font) {
        const run = this.font.layout(String.fromCodePoint(cp), undefined, ...this.layoutArgs(mode));
        value = run.positions.reduce((sum, p) => sum + p.xAdvance, 0);
      }
      else value = this.defaultAdvance;
      advances.set(cp, value);
    }
    return value;
  }

  // { lig } | { kern } | null for two adjacent Latin-side code points.
  pair(a, b, mode = "zh") {
    const pairs = this.modes[mode].pairs;
    const key = `${a},${b}`;
    let value = pairs.get(key);
    if (value === undefined) {
      value = null;
      if (this.font) {
        const run = this.font.layout(String.fromCodePoint(a, b), undefined, ...this.layoutArgs(mode));
        const total = run.positions.reduce((sum, p) => sum + p.xAdvance, 0);
        if (run.glyphs.length === 1) value = { lig: total };
        else {
          const delta = total - this.advanceUnits(a, mode) - this.advanceUnits(b, mode);
          if (delta) value = { kern: delta };
        }
      }
      pairs.set(key, value);
    }
    return value;
  }

  triple(a, b, c, mode = "zh") {
    const triples = this.modes[mode].triples;
    const key = `${a},${b},${c}`;
    let value = triples.get(key);
    if (value === undefined) {
      value = null;
      if (this.font) {
        const run = this.font.layout(String.fromCodePoint(a, b, c), undefined, ...this.layoutArgs(mode));
        if (run.glyphs.length === 1) value = run.positions[0].xAdvance;
      }
      triples.set(key, value);
    }
    return value;
  }

  // harfbuzz guess_segment_properties: the first character with a concrete
  // script decides; with only Common characters the run is shaped as DFLT.
  static modeOf(text) {
    return STRONG_SCRIPT.test(text) ? "zh" : "dflt";
  }

  // Advances (em) for every UTF-16 code unit of `text`, as Typst shapes one
  // run: a ligature's width sits on its first unit (the rest get 0), a pair
  // delta is added to the left glyph and also recorded in `kernOut` (Typst
  // reshapes a run split by a line break, which drops that pair delta at the
  // end of the line). Low surrogates get 0.
  shape(text, out = new Float64Array(text.length), mode = FontMetrics.modeOf(text), kernOut = null) {
    this.kernOut = kernOut;
    const unit = this.unitsPerEm;
    let previous = -1;      // last code point of the previous glyph
    let previousIndex = -1; // unit index of the previous glyph
    for (let i = 0; i < text.length;) {
      const cp = text.codePointAt(i);
      const length = cp > 0xffff ? 2 : 1;
      if (cp < PAIR_LIMIT && i + length < text.length) {
        const next = text.codePointAt(i + length);
        if (next < PAIR_LIMIT) {
          const pair = this.pair(cp, next, mode);
          if (pair && pair.lig !== undefined) {
            let span = length + (next > 0xffff ? 2 : 1);
            let units = pair.lig;
            let last = next;
            if (i + span < text.length) {
              const third = text.codePointAt(i + span);
              const triple = third < PAIR_LIMIT ? this.triple(cp, next, third, mode) : null;
              if (triple != null) { units = triple; span += third > 0xffff ? 2 : 1; last = third; }
            }
            if (previous >= 0) this.applyPair(out, previous, previousIndex, cp, mode);
            out[i] = units / unit;
            for (let k = 1; k < span; k++) out[i + k] = 0;
            previous = last;
            previousIndex = i;
            i += span;
            continue;
          }
        }
      }
      out[i] = this.advanceUnits(cp, mode) / unit;
      if (length === 2) out[i + 1] = 0;
      if (previous >= 0) this.applyPair(out, previous, previousIndex, cp, mode);
      previous = cp;
      previousIndex = i;
      i += length;
    }
    return out;
  }

  applyPair(out, left, leftIndex, right, mode) {
    if (left >= PAIR_LIMIT || right >= PAIR_LIMIT) return;
    const pair = this.pair(left, right, mode);
    if (pair && pair.kern) {
      out[leftIndex] += pair.kern / this.unitsPerEm;
      if (this.kernOut) this.kernOut[leftIndex] = pair.kern / this.unitsPerEm;
    }
  }
}

module.exports = { FontMetrics, PAIR_LIMIT };
