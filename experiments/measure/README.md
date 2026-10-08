# Pure-JS text measurement (experiment)

Replaces the Typst `measure` query of `experiments/typst` with our own line
layout. Typst is only used to typeset the final PDF, and it is told the line
breaks explicitly, so the output cannot drift from the measurement.

```
node experiments/measure/build-advance-table.js           # font -> data/source-han-serif-sc-regular.json
node experiments/measure/compare-typst.js [--table T]     # parity with Typst's own line breaking
node experiments/typst/run.js <fixture> --measurer js     # pipeline: JS measure -> fit -> explicit lines -> Typst
node experiments/typst/run.js <fixture> --measurer both   # also runs the Typst query and compares
```

## Files

| File | Role |
|---|---|
| `font-metrics.js` | Advances, pair deltas (kerning + contextual substitutions), ligatures, per shaping mode. From the font (fontkit, dev) or from the compact table (runtime). |
| `build-advance-table.js` | Extracts that table: 405 KB JSON, 66 KB gzip, 23 KB brotli for Source Han Serif SC Regular (vs 23 MB OTF). 19 s. |
| `linebreak.js` | Typst `linebreaks: "simple"` reproduced: break opportunities, CJK/Latin adjustments, greedy fill, line heights. |
| `measurer.js` | Drop-in for the Typst query: `{ id, para, size, h0, h1, natural }` records for the fitter. |
| `emit-lines.js` | Output with explicit lines (one single-line block per line, stacked with the paragraph leading). |
| `compare-typst.js` | Parity harness: every fixture paragraph (+ demo inline math + random stress paragraphs) at several sizes, Typst vs JS, line by line. |

## What had to match Typst (all verified with `compare-typst.js`)

Shaping (`font-metrics.js`)
- Typst shapes with `lang: "zh"`; harfbuzz picks the run's script from its first
  character with a concrete script. Source Han Serif registers ZHS under every
  concrete script and none under DFLT, so there are two modes: **zh** (`locl`:
  `—` 1 em, `——` 2 em, no kerning around `…`) and **dflt** for runs of only
  punctuation/digits (`——` is the 1692-unit default ligature).
- Pair effects among Latin-side characters (< U+2E80) are taken as "width of the
  shaped pair − both advances" (kerning and contextual substitutions alike); a
  pair shaping to one glyph is a ligature (fi, fl, ff, ffi, ffl, ——, …).

Line widths (`linebreak.js`, from Typst's `shaping.rs` / `line.rs`)
- CJK–Latin autospacing: +¼ em between a Han/kana glyph and an adjacent
  Latin/Greek/Cyrillic letter or digit, removed at line boundaries.
- Consecutive CJK punctuation shares half a glyph (GB style); closing
  punctuation at a line end and opening punctuation at a line start lose their
  blank half. The end test uses the line text after trailing spaces are trimmed.
- A run split by a line break is reshaped: no pair delta toward the next line.
- Trailing spaces: trimmed at a normal break, **kept** at a mandatory one
  (paragraph end, `linebreak()`).
- First-line / hanging indent are a leading space in Typst's paragraph text: a
  break opportunity after the indent, and no line-start adjustment on line 1.

Break opportunities (Typst uses ICU; the `linebreak` package has older tables)
- Inline boxes (U+FFFC, class CB) break on both sides (package resolves CB to a letter class).
- Latin letter/digit before an East Asian opening bracket may break (current LB30).
- `“ ”` behave like brackets (break before `“`, after `”`), except no break
  between `”` and a non-East-Asian character; `‘ ’` keep the strict quote rule
  (never break next to them, even between Han characters).
- URLs: Typst's special case after `://` / at `www.` (`linebreak_link`).

Typst ≥ 0.13 detail found on the way: inline content alone in a `block` is not
a paragraph and ignores `hanging-indent`. The prototype measured each
reference entry alone (no hang) but emitted several joined by `parbreak()`
(hang). `emit.js` now wraps every paragraph in `par[...]`, for both.

## Results

Parity (`compare-typst.js`, sizes 7 / 8.5 / 10 / 11.5 pt):

| Set | Probes | Same line breaks |
|---|---|---|
| fixtures + demo math + 160 stress paragraphs (rules tuned on this) | 1196 | 1196 (100 %) |
| 400 new stress paragraphs, seed 7 | 2156 | 2156 (100 %) |
| 400 new stress paragraphs, seed 99991 | 2156 | 2156 (100 %) |
| 400 new stress paragraphs, seed 424242 (never used while tuning) | 2156 | 2156 (100 %) |
| same, metrics from the compact table instead of the font | 1196 / 2156 / 2156 | 100 % |

Pipeline (`run.js --measurer both`, all fixtures, both modes): 0 line-count
differences between the JS and Typst measurements, heights within 0.044 pt.
Drift check (`--measurer js`: each emitted line renders as exactly one text line
in its column): 0 mismatches over 6 fixtures × 2 modes (132 nodes) and over the
300-page document (3200 nodes).

300 pages (two-column-article × 100, translation, demo inline math; Apple M1):

| | Typst `measure` query | JS measurer |
|---|---|---|
| measurement | 110 978 ms | 6 327 ms (418 000 paragraph layouts) |
| fit | — | 317 ms |
| emit output | — | 118 ms |
| typst compile | — | 685 ms |
| total (no PNG / drift check) | ≈ 113 s | 8.2 s |
| total with 300 PNGs + text extraction | 127.5 s | 71.2 s (PyMuPDF dominates) |
| peak RSS | 1.06 GB | 0.51 GB (lean) / 0.61 GB |

## Limits and next steps

- The stress text uses a fixed vocabulary (Chinese, English, Greek, URLs,
  CJK/ASCII punctuation, formulas). Japanese kana rules, Hangul, accented Latin
  beyond Latin-1/Ext-A, Arabic/Hebrew, emoji and fonts other than Source Han
  Serif SC are untested. The break-opportunity adjustments are empirical
  (observed Typst 0.15.1 behaviour), not a full ICU implementation; a real
  ICU4X segmenter (WASM) would remove that guesswork.
- Pair data covers the "Latin-side" repertoire in `build-advance-table.js`;
  characters outside it get no kerning (none of them kern in this font's CJK range).
- Hyphenation is not modelled (`lang: "zh"` disables it in Typst too).
- Measurement evaluates every size of the fitter's ladder (≈ 85 per paragraph);
  a search over sizes instead of the full ladder would cut it by ~10×.
- MathJax fallback (unknown macro) is a fixed-width monospace box; its width is
  estimated as 0.4816 em per character (DejaVu Sans Mono at 0.8 em).
