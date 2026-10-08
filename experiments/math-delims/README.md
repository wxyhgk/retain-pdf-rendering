# Math delimiter scanner

The scanner now lives in production: `Text.scanMath`, `Text.normalizeTeX` and
`Text.contentFromText` (src/text/measurer.js), a left-to-right scanner
modelled on retain-pdf's `render/layout/text_tokens.py` plus a small TeX
normalizer. A formula that still cannot render becomes plain text (its TeX,
no delimiters) in the body font. `delimiters.js` is a thin alias kept for the
tools below.

- `node analyze.js --field translated|source [--taxonomy] [--failures N]`
  measures failures on every retain-pdf job under `../retain-pdf/data/jobs`
  (read-only): unescaped `$` left as text, visible `\$`, MathJax failures.
- `node taxonomy.js translated|source` counts delimiter usage via the scanner.

Results (31 jobs, 2,259 unique translated texts, 1,199 with math):

| | literal `$` runs | visible `\$` | MathJax failures |
|---|---|---|---|
| current (`tightenMath` + `contentFromText`) | 4 (3 texts) | 2 | 24 (12 texts) |
| scanner + `normalizeTeX` | 0 | 0 | 0 |

Source texts (2,779): the 3 remaining literal `$` are genuinely unpaired
(OCR garble); the 3 MathJax failures are OCR garbage and two `\begin{align*}`
bodies (MathJax renders them, but the helper reports "no size" for them).
