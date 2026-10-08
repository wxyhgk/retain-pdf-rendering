# src/fit-model

The data fitter: the rule set of `src/fit.js` (`runLayoutParityEngine`,
`fitLayoutFormulas`, `fitLayoutPages`) run on a layout model instead of a DOM.
`src/fit-model.js` is the public entry (`createModelFitter`,
`defaultContentFor`, …) and documents the behaviour and the deviations from the
DOM fitter; this directory holds the implementation.

## Modules

| File | Lines | Responsibility |
|---|---|---|
| `constants.js` | 88 | CSS paddings and ratios the DOM rules rely on, face content areas, ink extents, `FINAL_AUDIT_OPTIONS`. |
| `rects.js` | 113 | Pure rectangle tests and `gallopingGrow`. |
| `content.js` | 215 | Which text a node shows, as measurer runs (`defaultContentFor`). Pure. |
| `document.js` | 344 | Node building from a layout model, node accessors (`layoutControlFontSize`, `applyGroup`, `nodeBox`, …), the `Select` predicates. |
| `line-models/base.js` | 41 | What both line models share: measuring a paragraph, painted line width. |
| `line-models/measurer.js` | 94 | Typst geometry with ink-safe line spacing (what the Typst output paints). |
| `line-models/css.js` | 102 | CSS line boxes around the measurer's breaks (what a browser measures). |
| `line-models/index.js` | 29 | Picks the line model from `ctx.lineModel`. |
| `geometry.js` | 357 | Per-node geometry (lines, glyph rects, formula and code boxes), strict barriers, the geometry caches. |
| `collision.js` | 213 | `textCollisionDetails` (one scan, strict or tolerant policy), `measureGroup`, `wouldCollideWithBlocks`. |
| `tuning.js` | 308 | `tuneNodes`, the body's second iteration, `capBodyNodes`, `tuneGroup` / `tuneEach`, inherited-body sync. |
| `passes/titles.js` | 178 | False single-line demotion, underfilled titles, title size clusters, short titles on one line. |
| `passes/clamps.js` | 87 | Overflow clamps for translated references and code frames. |
| `passes/final-audit.js` | 134 | The final glyph-level collision audit. |
| `passes/formulas.js` | 178 | Formula shrink/expand and equation-number alignment. |
| `run.js` | 190 | The pass order with its option sets — the recipe. |
| `serialize.js` | 92 | The result as plain data. |
| `index.js` | 109 | `createModelFitter`: builds `ctx`, wires the parts. |

## Dependencies

Module-level (`DEPENDENCIES` in each file's header; `←` lists what each
module loads). Every part is a leaf except `index`, which wires them:

```
constants              (none)
rects                  (none)
content                (none)
document               ← constants
line-models/base       (none)
line-models/measurer   ← line-models/base
line-models/css        ← line-models/base
line-models/index      ← line-models/measurer, line-models/css
geometry               ← constants, rects, document
collision              ← rects
tuning                 ← rects, document
passes/titles          ← rects, document
passes/clamps          ← document
passes/final-audit     ← constants, document
passes/formulas        ← rects, document
run                    ← document
serialize              ← document
index                  ← constants, content, rects, document, line-models/index, geometry, collision, tuning, passes/titles, passes/clamps, passes/final-audit, passes/formulas, run, serialize
```

Object-level (who receives what at runtime):

```
createModelFitter(config)
  ctx (frozen) ───────────────────────────────────────────────┐
  lines      = createLineModel(ctx)                           │
  geometry   = createGeometry(ctx, lines)          per fitter  │ ctx
  collision  = createCollision(ctx, geometry)                 │
  builder    = createDocumentBuilder(ctx)                     │
  serializer = createSerializer(ctx, geometry)                │
  fitDocument(model, fitOptions)                              │
    run = { doc, fitOptions, all, scopedNodes, strictSourceFit }
    tuning / titles / clamps / finalAudit / formulas = create…(ctx, run, { geometry, collision })
    runFit(run, { tuning, titles, clamps, finalAudit, formulas })   ← run.js
```

Rules (checked by `test/fit-model-modules.test.js`): a part resolves other
parts only in its header; no part except `index.js` reads `config`; only
`index.js` (and `line-models/index.js`) create parts; nothing references a
host (DOM, Zotero, LitMTrans).

## ctx and run

`ctx` is created once per fitter and frozen: `measurer`, `roleMeasurers`,
`contentFor`, `contentAreas`, `lineModel` (`"measurer"` or `"css"`),
`inkExtents`, `strict` (strict collisions), `pixelRound`, `trace`.

`run` is created per `fitDocument` call: `doc` (pages, nodes, mode),
`fitOptions`, `all` (`doc.nodes`), `scopedNodes(predicate)`,
`strictSourceFit`.

The geometry caches live on the geometry part, so they persist for the
fitter's lifetime (as before the split).

## Node fields written during a fit

Nodes are plain objects built by `document.js`. Besides their source fields
the fit writes:

- `style.fontSize`, `style.lineRatio`, `style.width`, `style.nowrap` — the
  applied style (`applyGroup`, title passes).
- `fit` (stop reason, limiter, blocker), `fitLabel` — diagnostics.
- `fontCap`, `lineRatioCap` — per-paragraph body caps (`bodyNodeFontCaps`).
- `originalLines`, `singleLineAlign` — changed by the false single-line demotion.
- `shortTitleNoWrap`, `codeFit`, `userBodyFontPt` — pass results.
- `baseFont`, `lineRatio` — rewritten by the clamps.
- `formula.scale`, `formula.numberRight`, `formula.fitted` — formula passes.
- `_geometryLast`, `_box` — geometry fast-path caches (private to `geometry.js`
  and `document.js`'s `nodeBox`).

## Browser load order

Load as plain scripts (each attaches to
`RetainPdfRendering.FitModelParts`), after `src/render.js` (optional, for
equation tags) and before `src/fit-model.js`:

```
fit-model/constants.js
fit-model/rects.js
fit-model/content.js
fit-model/document.js
fit-model/line-models/base.js
fit-model/line-models/measurer.js
fit-model/line-models/css.js
fit-model/line-models/index.js
fit-model/geometry.js
fit-model/collision.js
fit-model/tuning.js
fit-model/passes/titles.js
fit-model/passes/clamps.js
fit-model/passes/final-audit.js
fit-model/passes/formulas.js
fit-model/run.js
fit-model/serialize.js
fit-model/index.js
fit-model.js
```

A part loaded before one of its dependencies throws an error naming the file
to load first.

## Changing the fitter

Behaviour-preserving changes (refactors) should leave
`scripts/fit-model-equivalence.js` byte-identical:

```
node scripts/fit-model-equivalence.js generate /tmp/before [--large FILE] [--job DIR]...
# change code
node scripts/fit-model-equivalence.js check /tmp/before [--large FILE] [--job DIR]...
```
