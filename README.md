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

## 独立使用

```html
<link rel="stylesheet" href="retain-pdf-rendering/src/layout.css">
<style>
  @font-face {
    font-family: "LitMTrans Source Han Serif";
    src: url("fonts/SourceHanSerifCN-Regular.ttf") format("truetype");
  }
</style>
<script src="retain-pdf-rendering/src/render.js"></script>
<script src="retain-pdf-rendering/src/fit.js"></script>
<div id="translation-layout" class="layout-document"></div>
<script>
  const { Render, Fit } = window.RetainPdfRendering;
  const container = document.getElementById("translation-layout");
  const fitter = Fit.createFitter({ document, window, getStorage: () => localStorage });
  const renderer = Render.createRenderer({
    document, renderInline, renderTeX,           // 宿主提供的 Markdown / TeX 渲染
    onPagesBuilt: pages => {
      // 页面已挂入 DOM 后再拟合：
      requestAnimationFrame(async () => {
        container.classList.add("layout-fit-measuring");
        await document.fonts.ready;
        fitter.demoteFalseSingleLineText(pages);
        fitter.fitLayoutPages(pages);
        container.classList.remove("layout-fit-measuring");
      });
    }
  });
  container.appendChild(renderer.buildLayoutDocument(model, true));  // model 来自 Model.restoreLayoutDocument
</script>
```

`model` 由 `Model.restoreLayoutDocument(...)` 生成（Node 或浏览器均可）。

## 样式表与字体约定

`src/layout.css` 是排版引擎的一部分：拟合依赖真实 CSS 排版，未加载它时测得的字形矩形没有意义。规则逐字复制自 LitMTrans-Zotero `src/workbench.css`（保持原顺序与注释），只含排版页面模型，不含工作台界面。

宿主需要提供：

- **字体**：`layout.css` 不含 `@font-face`，也不随包分发字体文件。宿主须自行声明字体族 `"LitMTrans Source Han Serif"`（LitMTrans-Zotero 使用 SIL OFL 授权的 `SourceHanSerifCN-Regular.ttf`）。未声明时回退到 `"Times New Roman"`、`SimSun`、`serif`，排版结果会随系统字体变化。
- **容器**：页面挂在 `class="layout-document"` 的容器内。拟合期间给容器加 `layout-fit-measuring`（或 `layout-fit-pending`），否则 `.layout-page-wrap` 的 `content-visibility: auto` 会让视口外页面不参与排版，字形矩形全部为空。
- **可选状态类**：`body.layout-debug`（检查视图：调试框、拟合标签、限制源描边）、`body.layout-translated`（译文正文内联公式缩小到 92% / 88%）、`body.layout-source-strict-fit`（原文严格不溢出模式，由 `fit` 读取）。
- **主题变量**：`--sans`、`--muted`（拟合中提示、调试标签、待翻译遮罩使用）。`layout.css` 以零优先级的 `:where(:root)` 给出默认值，宿主在 `:root` 上定义即可覆盖。
- **基础样式**：工作台对全局设置了 `* { box-sizing: border-box; }` 与 `[hidden] { display: none !important; }`；浏览器测试的宿主页同样设置。
- **公式**：`.katex` / `.litmtrans-math` 的基础样式属于宿主的 TeX 渲染器，不在 `layout.css` 中；`layout.css` 只包含 `.layout-block` / `.layout-flow-stream` 内对它们的覆盖。

## 测试

- `npm test`：Node 单元测试（`test/*.test.js`），不需要浏览器。
- `npm run test:browser`：真实浏览器中的渲染 + 拟合测试（`test/browser/`）。首次运行前执行 `npm install` 与 `npx playwright install firefox`（或 `chromium`）。未安装 Playwright 或浏览器时测试会跳过并说明原因。
- `npm run test:all`：两者依次运行。
- `test/fixtures/model-golden/`、`test/fixtures/render-golden/` 是抽离前由原代码生成的基准输出，用来保证抽离不改变行为。

浏览器测试对每个 `model-golden` 夹具（有译文时原文、译文两种模式都测）用 `createRenderer` 生成页面、`createFitter().fitLayoutPages()` 拟合，然后在页面内检查：

1. 每个排版节点的字形矩形都在所属页面内（容差 1.5，源页面坐标）；
2. 字形不与其他排版节点碰撞，判定与 `fit.js` 最终碰撞审计（`textCollisionDetails`）一致：正文对同栏块的实际内容、其它文本对块边框，同样的共享边容差（4.0 / 3.0）与正文首行上沿豁免；
3. 所有非继承正文流（`data-body-inherited` 不为 1）字号相同；
4. 拟合跑完全程（`runLayoutParityEngine` 在非调试模式下会吞掉异常），且连续两次结果相同；
5. 每个节点的 `fontSize` / `lineHeight` 与 `test/browser/__snapshots__/<夹具>.<浏览器>[.<字体>].json` 一致。快照记录浏览器、主版本号、平台和字体；记录不一致时只提示、不比较。

环境变量：

| 变量 | 作用 |
|---|---|
| `RPR_BROWSER=firefox\|chromium` | 选择引擎；默认已安装 Firefox 时用 Firefox（Zotero 基于 Gecko），否则 Chromium |
| `RPR_TEST_FONT=/path/SourceHanSerifCN-Regular.ttf` | 以 `"LitMTrans Source Han Serif"` 加载该字体；快照文件名带字体名，与系统字体的快照分开 |
| `UPDATE_SNAPSHOTS=1` | 重写快照（缺失时总会写入） |

已知问题记在 `test/browser/fit.browser.test.js` 的 `KNOWN_ISSUES` 中，按浏览器生效并报告为 todo。

## 在 LitMTrans-Zotero 中

`npm run sync-vendor` 把 `src/{model,render,fit}.js` 复制到 `assets/vendor/retain-pdf-rendering/` 随插件打包；`npm run validate` 会检查复制件与包源码一致。
