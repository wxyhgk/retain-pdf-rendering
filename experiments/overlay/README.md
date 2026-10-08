# Overlay prototype on real retain-pdf jobs

Paints translations onto the original PDF the way retain-pdf does (keep the
source page, replace only the translated text blocks), but with this
package's pure-JS measurer and data-driven fitter instead of Typst
`measure()` + mitex.

```
node experiments/overlay/run.js <retain-pdf job dir> --preset retain   # full retain-pdf-style configuration
node experiments/overlay/run.js <retain-pdf job dir> [--png 1,2,5] [--out DIR]
     [--no-drift-check] [--pages N] [--limiter-rounds N] [--body-max-factor F]
     [--body-line-height R] [--inherit-below F] [--allow-spill] [--no-font-caps]
     [--typography retain [--seed geometry] [--retain-band-fit]]
```

The job directory is only read. Output (gitignored) goes to
`experiments/overlay/output/<job>/`: `overlay.typ`, `overlay.pdf` (the
transparent overlay), `final.pdf` (merged), `math/*.svg`, `text.txt`,
`compare-pN.png` (ours left, retain-pdf's rendered PDF right), `report.json`.

Needs: Typst 0.15 (`~/.local/bin/typst`), retain-pdf's fonts
(`../retain-pdf/resources/fonts`, `--ignore-system-fonts`), and retain-pdf's
venv Python (PyMuPDF for reading the source PDF and checks, pikepdf for the
merge).

## Pipeline

1. **Inputs** (`adapter.js`, read-only): `ocr/normalized/document.v1.json`,
   `translated/translation-manifest.json` + `page-NNN-*.json`
   (`translated_text`, matched by `page_idx` + `block_idx`),
   `artifacts/render_prewarm/visual_profile.v1.json` (per-item cover bbox,
   `background_rgb`, `text_rgb` — retain-pdf's own colour sampling), and the
   base page `artifacts/render_prewarm/*.source-bbox-text-stripped.pdf`
   (retain-pdf already removed the translatable source text from it).
2. **Size seeds**: median span size of the source PDF's text layer inside
   each block (PyMuPDF on `source/*.pdf`); OCR line pitch only as fallback.
3. **Fit**: `src/fit-model.js` in the output-path configuration (Text
   measurer, `lineModel: "measurer"`, strict collisions), MathJax boxes for
   inline formulas, `strictSourceFit: true`, `bodyMaxFont` = source body size.
4. **Emit** (`emit-overlay.js`): one Typst page per source page, `fill: none`;
   per translated block a cover rectangle in the sampled background colour,
   then the fitted lines placed at their computed baselines (reusing
   `experiments/typst/emit-model.js`), inline formulas as MathJax SVG +
   transparent LaTeX. One `typst compile` for the whole document.
5. **Merge** (`merge.py`): pikepdf `Page.add_overlay` onto the stripped base.

## Mapping decisions

| document.v1 block | becomes | why |
|---|---|---|
| `text/body`, translated | body stream (`styleKind: body_text`) | shares one body font, like the reader |
| `text/body`, box too tight for the shared size | multi-line `text` block | sized on its own (see below) |
| `text/title` | `title` block, `mainTitle` | |
| `text/heading` | `title` block | |
| `text/figure_caption`, `image_caption` | `image_caption` block | caption group |
| `text/table_caption`, `image_footnote`, `table_footnote`, `chart_caption` | caption block of that type | |
| other translated text | `text` block | |
| display formulas, formula numbers, images, tables, headers, page numbers, any untranslated block | opaque obstacle (`kind: image`), never painted | the source page keeps them; they block collisions |

Choices that differ from the reader (the plugin's DOM layout):

- **Text stays inside its source box (`strictSourceFit`).** The overlay cannot
  see vector graphics that are not OCR blocks (frame rules, boxes, figure
  parts). With the reader's "grow into free space" rule a URL in a framed
  box ran 28 pt out of the frame; with strict fit every spill is < 2 pt.
- **Body ceiling = source body size (`bodyMaxFont`, the one hook added to
  `src/fit-model.js`).** Without it the shared body font grew to 12 pt on a
  9.8 pt paper.
- **Tight paragraphs leave the shared group.** The reader never lets a body
  paragraph shrink alone, so one tight OCR box (a one-line box holding a
  translation with tall inline formulas) dragged a whole book to 5.5 pt.
  Paragraphs whose standalone fit is < 0.85 × the median become individually
  fitted multi-line text blocks; then, while the shared body is below the
  ceiling, the paragraph the fitter names as limiter (collision stop) or with
  the least room left (overflow stop) is detached too, up to 10 rounds.
  Inherited body (`bodyInherited`) was tried first and rejected: it backs off
  only on collisions, so it spilled out of its box.
- **Over-stretched justified lines are painted unjustified** (> 0.25 em extra
  per gap; greedy breaking leaves e.g. 8 characters before a wide formula).
- **retain-pdf's `$ x_{2} $`** (padded inline math) is tightened to
  `$x_{2}$` before `Text.contentFromText`.

## Findings (Typst 0.15.1, Apple M1)

| | 量子化学-14 (34 p, single column, 209 display formulas) | SGNT paper (11 p, two columns) |
|---|---|---|
| painted / obstacle blocks | 330 / 422 | 76 / 200 |
| shared body font: ours / source / retain-pdf median | 9.0 / 10.0 / 10.9 | 9.8 / 9.8 / 10.35 |
| individually fitted body blocks | 28 (median 9.0) | 23 (median 7.5) |
| line overlaps / outside page / text on preserved elements | 0 / 0 / 0 | 1 (0.19 pt) / 0 / 0 |
| spills > 2 pt below own box | 0 | 0 |
| drift (emitted line ≠ one rendered line) | 0 / 330 nodes | 0 / 76 nodes |
| inline formulas rendered / MathJax failures | 451 / 2 | 67 / 0 |
| fit / MathJax / compile / merge (ms) | 393 / 249 / 263 / 294 | 116 / 162 / 59 / 112 |
| wall time (incl. reading source sizes, text extraction) | 2.3 s | 0.9 s |
| final PDF / retain-pdf PDF / source PDF | 2.44 MB / 1.59 MB / 1.45 MB | 0.93 MB / 0.90 MB / 0.80 MB |

- **Formula size cost.** Of the 1.52 MB 量子化学 overlay, ~1.1 MB is the 450
  MathJax SVGs (`fontCache: 'none'`: every SVG carries its own glyph paths;
  mitex shares one subsetted math font). Without formulas the overlay is
  ~0.35 MB.
- **The fitter's 0.19 pt overlap** (SGNT p7): a heading spills its descent out
  of its box, and a text block fitted later touches it. In strict mode ink
  outside a node's own box is not a barrier for nodes fitted after it, and
  the final collision audit only covers streams. A fit-model rule gap, not
  an adapter one.
- **Body one step below the source on 量子化学** (9.0 vs 10): many paragraphs
  are just too tight for 10 pt at line ratio 1.25 in strict mode (1.15 gives
  9.5). retain-pdf sizes each block between its own min/max instead (6.65–11.72).
- **Where retain-pdf's output is wrong and ours is not**: overprinted lines
  (量子化学 p16 bottom, p24 top) and the SGNT abstract repeated three times.
- **Known issues**: headings are regular weight (the measurer has no bold
  metrics; retain-pdf sets them bold); adjacent inline formulas `$a$$b$` are
  read as `$$` and print literally (SGNT p3 `$^{[83]}$`); a lone `$` (e.g.
  `$5`) can mispair in the tightening step; two MathJax failures fall back to
  red LaTeX (`\text{\AA}`, a doubled prime); `text.txt` also contains the
  base PDF's leftover text (display formulas, a few unstripped fragments),
  as in retain-pdf's output.

## Plugging into retain-pdf's render flow

The pieces retain-pdf already has stay: route selection, pikepdf text strip,
prewarm colour profile, pikepdf overlay merge, chunked compile for big books.
What would replace its `layout/` + `output/typst` block fitting:

1. A Node step (or long-lived worker) that takes `document.v1.json`, the
   translation payloads, the visual profile and source span sizes and returns
   the overlay Typst (this prototype's `adapter.js` + fit + `emit-overlay.js`),
   or the fitted lines as JSON for retain-pdf's own emitter.
2. MathJax in that worker for inline formulas (or a cheaper formula path for
   size: shared font glyphs instead of per-SVG paths).
3. retain-pdf compiles with the same fonts and `--ignore-system-fonts`, then
   merges as today.

## Body font size (per-paragraph caps)

One shared body size used to stop at the tightest paragraph of the whole
document (量子化学-14: 9.0 pt for a 10 pt source). Measured standalone, at
the source line pitch (1.20 em), the median paragraph fits 10.9 pt in its own
box, but 51 of 309 do not fit 10 pt, and the old detach-the-limiter rounds
could not keep up. `bodyNodeFontCaps` (fit-model, on by default here) gives
each body paragraph that cannot reach the ceiling inside its box a cap: first
the loosest line ratio down to 1.12, then the largest size that fits. Capped
paragraphs no longer limit the group, so everything else reaches the source
size.

| job | before | now (cap = source) | `--body-max-factor 1.1` | retain-pdf |
|---|---|---|---|---|
| 量子化学-14 | 9.0 | 10.0 (285/291 at 10, min 9.3) | 10.0 | 10.9 |
| SGNT (2-col) | 9.8 | 9.8 (34/36, min 9.55) | 10.3 | 10.31 |

Both jobs: 0 line overlaps, 0 text on preserved content, 0 outside the page,
0 drift. Two strict-mode audit fixes were needed for this: text blocks are
audited too (not only streams), with every other node's full ink as a
barrier; and when a collision sits on a node's first line with text above it,
the node above is repaired (a tighter line ratio cannot lift the first line of
the lower one: OCR boxes of tightly set paragraphs overlap by a fraction of a
point). That second fix is verified on these real jobs only; a synthetic unit
test could not reproduce the overlapping-box case yet.

## `--typography retain`

Fits with the fitter's "retain" typography profile (src/fit-model/README.md):
retain-pdf's body size and leading rules plus our ink collision safety net.
The adapter then keeps every paragraph's own seed (no source-size clamp, no
detach rounds) and hands the fitter each block's source line pitch (text-layer
line spacing, else OCR line centres).

- `--seed geometry` ignores the PDF text layer and seeds sizes the way
  retain-pdf does, from OCR line boxes of the translation payload items
  (glyph height x 0.98 x 0.9215, page baseline from candidates with >= 3 lines,
  >= 40 characters, >= 0.6 x the page's median text width).
- `--retain-band-fit` additionally keeps each body paragraph's Typst band
  inside its box.

`report.json` gains `bodyFill` (ink height / box height per painted body
paragraph: count below 0.6, median).

## Vector obstacles (`--vector-obstacles`)

Text that runs past its own box was only checked against OCR blocks. Rules,
frames, table lines, coloured panels, logos and glyphs drawn as paths have no
OCR block, stay on the base PDF, and were invisible to the fitter.
`vector-obstacles.js` reads them with PyMuPDF (`get_drawings(extended=True)`)
and turns what is visible into obstacle nodes:

- strokes: thin strips along every path segment (curves flattened, long
  diagonals split), so a frame's interior stays free and enclosed text stays
  inside it;
- fills that enclose a repainted box (coloured panels): outline strips only;
- other visible fills (bars, logos, path glyphs): rectangles, small
  same-coloured pieces merged;
- ignored: page-sized backgrounds, white / transparent fills, drawings inside
  an OCR obstacle;
- clipped to their clip path's scissor box, and cut out where a later white
  mask is painted over them (knockout behind titles);
- cut away inside every repainted text box (our cover fill paints over it).

The runner always reports `vectorHits` (painted lines touching vector
content); the flag feeds the obstacles to the fitter.

| job | drawings | obstacles | hits without flag | with flag | size changes |
|---|---|---|---|---|---|
| 量子化学-14 | 350 (280 clipped away) | 368 | 0 | 0 | none |
| SGNT | 91 | 177 | 3 (panel edge, table rule, advert frame) | 0 | p011-b0042 7.8 → 7.45 |

Before clip paths and masks were honoured, 量子化学 showed 8 hits; all were
invisible geometry (hatching clipped to a figure, chapter-opener circles
under a white knockout). retain-pdf itself uses drawings only for source
cleanup (cover-only on vector-heavy pages, glyphs drawn as paths), not to
constrain layout.

## `--preset retain`

One flag for the full retain-pdf-style configuration:
`--typography retain --seed geometry --vector-obstacles --bold-titles --faithful`.
Flags after it override single settings (`--seed calibrated`,
`--no-vector-obstacles`, `--no-bold-titles`, `--no-retain-titles`,
`--no-faithful`, `--no-leading-first`).

- Typography "retain" (src/fit-model, see its README): retain-pdf's body,
  non-body, annotation and heading rules with the ink safety net; capped
  justification and post-fit balanced breaking.
- `--seed geometry` (default in the preset): retain-pdf's seed estimate from
  OCR line geometry (`estimate_font_size_pt`, `local_font_size_pt` for
  non-body). `--seed calibrated`: the text-layer size × the document's median
  geometry / text-layer ratio (body blocks).
- `--faithful`: retain-pdf's `is_body_text_candidate` (short or narrow
  `text/body` blocks are non-body).
- `--vector-obstacles`: vector graphics without an OCR block become
  obstacles (vector-obstacles.js).
- `--bold-titles`: headings measured with the Bold advance table and painted
  bold.
- Math: `Text.contentFromText` scans delimiters left to right; a formula
  MathJax cannot render stays as plain text in the body font.

Results on the two reference jobs (`report.json`): body median 10.6 / 10.34
(retain-pdf 10.9 / 10.25), headings 0.96–0.99 × retain-pdf, justification
≤ 0.15 em per gap, 0 failed formulas, 0 vector hits, invariants 0, drift 0.
