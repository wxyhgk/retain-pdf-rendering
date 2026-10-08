# retain-pdf-rendering

译文排版引擎，从 LitMTrans-Zotero 的 `src/layout.js` 与 `src/workbench.js` 中抽离，供 LitMTrans-Zotero、retain-pdf 和独立桌面版共用。

| 模块 | 职责 | 运行环境 |
|---|---|---|
| `model` | 结构还原：MinerU 版面几何 → 流式块 / 绝对块 / 全文统一字号 | 纯函数，无 DOM，Node 可测 |
| `render` | 把排版模型画成绝对定位的页面节点 | 需要 DOM；Markdown 渲染、图片解析由调用方注入 |
| `fit` | 实测字形矩形、碰撞检测、迭代调整字号与行距 | 需要 DOM 布局 |

## 约定

- 包内代码与宿主无关：不得引用 Zotero、`LitMTrans` 或插件全局对象，宿主能力（偏好、哈希、取消信号、资源解析、Markdown 渲染）由调用方以参数传入。
- 每个模块同时支持两种加载方式：CommonJS（`require("retain-pdf-rendering")`），以及作为普通脚本加载后挂在 `globalThis.RetainPdfRendering.{Model,Render,Fit}`。

## API

### `Model`（无 DOM）

- `restoreLayoutDocument({ pages, modelPages, resolveAsset, translations, formulaMap, translatableTypes, singleColumnBodyPromotion = true, checkpoint })`
  → `Promise<{ styles, pages: [{ index, width, height, blocks, restoration: { streams, absoluteBlocks, ocrBoxes } }] }>`。
  `checkpoint(index)` 在每个逐页循环开头被调用，宿主可在其中检查取消信号、让出事件循环。
- `flattenLayoutPage(page, pageIndex, resolveAsset, translatableTypes)`
- `configure({ renderTeX, escapeHTML })` — 注入 TeX 渲染与 HTML 转义；未配置时使用内置的转义和 `\(..\)` 文本回退。
- 其余结构还原辅助函数以原名导出（`validBBox`、`solveUniformStreamStyle`、`inferSingleColumnProfile` 等）。

### `Render`（需要 DOM）

- `createRenderer({ document, renderInline, renderTeX, resolveImage?, normalizeEscapedTeXDelimiters?, normalizeBareTeXFragments?, setElementHTML?, escapeHTML?, escapeAttribute?, parseTocTextRows?, debug?, awaitingOverlayHTML?, onPagesBuilt? })`
  → `{ buildLayoutDocument(model, useTranslation, options), buildAbsoluteLayoutNode, buildFlowStreamNode, layoutBlockHTML, ... }`。
  `onPagesBuilt(pageNodes)` 是渲染完成后的钩子，宿主在这里调度拟合；`render` 本身不依赖 `fit`。
- `splitTeXEquationTag(tex)`

### `Fit`（需要真实排版）

- `createFitter({ document, window, getStorage?, isDevelopmentMode? })`
  → `{ fitLayoutPages, fitLayoutFormulas, runLayoutParityEngine, demoteFalseSingleLineText, clampTranslatedOverflow, clampTranslatedCodeOverflow, refreshLayoutPageScales, layoutPageCoordinateScale, restoreFitCache, saveFitCache }`。
  拟合状态（当前页范围、迭代轮次）按实例隔离；拟合缓存通过 `getStorage()` 读写，存储不可用时自动停用缓存。

## 测试

- `npm run test:rendering`（仓库根目录）运行本包测试。
- `test/fixtures/model-golden/`、`test/fixtures/render-golden/` 是抽离前由原代码生成的基准输出，用来保证抽离不改变行为。重新生成模型基准：`UPDATE_MODEL_GOLDEN=1 npm run test:runtime`。
- `fit` 依赖浏览器真实排版，Node 中只测纯函数；完整效果需在 Zotero 中或通过 `scripts/layout-parity-test.mjs` 验证。

## 在 LitMTrans-Zotero 中

`npm run sync-vendor` 把 `src/{model,render,fit}.js` 复制到 `assets/vendor/retain-pdf-rendering/` 随插件打包；`npm run validate` 会检查复制件与包源码一致。
