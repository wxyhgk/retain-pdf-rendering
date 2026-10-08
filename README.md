# retain-pdf-rendering

译文排版引擎，从 LitMTrans-Zotero 的 `src/layout.js` 与 `src/workbench.js` 中抽离，供 LitMTrans-Zotero、retain-pdf 和独立桌面版共用。

| 模块 | 职责 | 运行环境 |
|---|---|---|
| `model` | 结构还原：MinerU 版面几何 → 流式块 / 绝对块 / 全文统一字号 | 纯函数，无 DOM，Node 可测 |
| `render` | 把排版模型画成绝对定位的页面节点 | 需要 DOM；Markdown 渲染、图片解析由调用方注入 |
| `fit` | 实测字形矩形、碰撞检测、迭代调整字号与行距 | 需要 DOM 布局 |
| `text` | 不依赖浏览器和 Typst 的文字测量：字宽表 + 与 Typst 一致的断行 | 纯 JS，无 DOM；Node、浏览器、Zotero 均可 |

## 约定

- 包内代码与宿主无关：不得引用 Zotero、`LitMTrans` 或插件全局对象，宿主能力（偏好、哈希、取消信号、资源解析、Markdown 渲染）由调用方以参数传入。
- 每个模块同时支持两种加载方式：CommonJS（`require("retain-pdf-rendering")`），以及作为普通脚本加载后挂在 `globalThis.RetainPdfRendering.{Model,Render,Fit,Text}`。

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

### `Text`（无 DOM，无浏览器）

文字测量：从字体提取的字宽表 + 复刻 Typst 0.15.1 `linebreaks: "simple"` 的贪心断行（`lang: "zh"`、`top-edge: "ascender"`、`bottom-edge: "descender"`）。测量出的断行可以逐行交给 Typst 输出，测量与成品不会漂移。

```js
const { Text, defaultFontTable } = require("retain-pdf-rendering");
const measurer = Text.createMeasurer({ metrics: defaultFontTable() });   // 或 Text.createMetrics(table)
const { renderMathBox } = require("retain-pdf-rendering/src/text/mathjax-node");  // 仅 Node；需要可选依赖 mathjax-full
const prepared = measurer.prepare(Text.contentFromText("其中 \\(Z = \\rho_0 u_s\\) 成正比。", { renderMathBox }));
measurer.layout(prepared, { fontSize: 10, lineHeight: 1.2, width: 240, firstLineIndent: 20, align: "justify" });
measurer.fitFontSize(prepared, { width: 240, maxHeight: 80, lineHeight: 1.2, minFont: 4.8, maxFont: 13, step: 0.1 });
```

- `prepare(content)`：`content` 为 run 数组——`{ type: "text", text }`、`{ type: "math", tex, display, widthEm, heightEm, depthEm }`（不可拆分的行内盒，单位为所在字号的 em）、`{ type: "break" }`（强制换行；文本中的 `\n` 也视为强制换行）。与字号、栏宽无关的工作（分段、字宽、断点）只做一次，结果可在不同字号、栏宽下复用。
- `layout(prepared, { fontSize, lineHeight = 1, width, firstLineIndent = 0, hangingIndent = 0, firstLineIndentEm?, hangingIndentEm?, align = "justify" | "left" | "center" | "right" })`
  → `{ lines: [{ start, end, width, x, top, baseline, ascent, descent, glyphTop, glyphBottom, justified, available, forced }], height, maxLineWidth, leading }`。长度单位与版面模型一致（源页面 px = Typst pt）。`glyphTop` / `glyphBottom` 是该行字形（含行内公式盒）的上下沿，供碰撞检查使用。
- `fitFontSize(prepared, { width, maxHeight, maxWidth?, lineHeight, minFont, maxFont, step = 0.1, ...layout 选项 })` → `{ fontSize, layout, fits, probes }`：步进阶梯上能放下的最大字号。二分查找假定高度随字号单调不减；贪心断行可能局部违反这一点，因此结果的上一级会再验证一次，若仍能放下则继续向上走。随机测试中平均每段 6.8 次排版（全扫约 83 次）。
- `naturalWidth(prepared, { fontSize, ... })`：不折行时的宽度（单行节点）。`lineRuns(prepared, start, end)`：某一行的 run，供输出端逐行绘制。
- `contentFromText(text, { renderMathBox })`：识别 `\(..\)`、`\[..\]`、`$$..$$`、`$..$`（`\$` 不算公式）。`renderMathBox(tex, display)` 返回 `{ widthEm, heightEm, depthEm }`；返回 null 或抛出异常时使用原文 LaTeX 兜底盒（等宽 0.8em，与参考 Typst 输出一致）。

**行高换算**：Typst 输出中一行文字在基线上方占 `ascender`、下方占 `descender`（思源宋体合计 1em），行内公式盒可撑高该行，相邻行之间是 `par(leading)`。CSS 式行高比例换算为 `leading = max(0, (lineHeight - 1) × fontSize)`，因此 n 行纯文字段落高 `n × fontSize + (n - 1) × leading`，比 CSS 少一个 leading（CSS 在首行上方、末行下方各多留半个）。`height` 是 Typst 块高度。

**字宽表**：`data/fonts/source-han-serif-sc-regular.json`（405 KB，gzip 66 KB，brotli 23 KB）由 `npm run build:advance-table` 从 retain-pdf 打包的 `SourceHanSerifSC-Regular.otf`（23 MB）提取：每个码位的字宽、两种塑形模式（含拉丁/汉字等强书写系统的 `zh` 与只含标点数字的 `dflt`）下拉丁侧字符的字偶距与连字，以及 ascender / descender / cap-height / x-height。运行时只需要这张表，不需要字体文件或字体解析器；浏览器、Zotero 宿主自行加载 JSON 后传给 `createMeasurer`。只有最终用 Typst 编译 PDF 的一端需要完整字体。

**断点**：`src/text/uax14-data.js`（25 KB，gzip 8 KB）是由 `npm run build:uax14` 从 `linebreak` 包（MIT）导出的 UAX #14 字符类与配对表，`src/text/linebreak.js` 移植了它的状态机，再按 Typst（ICU）的实际行为调整：行内盒前后按 LB20 断开、`”` 按非东亚闭括号处理（不与后随拉丁词/数字断开，但可在 `“`、`(`、`—` 前断开）、东亚开括号前的拉丁字母可断、URL 按 Typst 的链接规则断开、首行/悬挂缩进带来的断点。CJK 规则：汉字与拉丁字母/数字相邻时加 1/4 em、连续标点挤压（GB 风格）、行首开括号与行尾闭括号去掉空白的半边、行尾空白不计宽度。

**已验证范围与局限**：与 Typst 0.15.1 的自身断行逐段对比（`npm run test:typst`）：夹具段落、行内公式示例、随机压力文本（5 组种子各 2156 例）和公式盒/引号定向用例，共 13,501 例全部一致。覆盖的文字是中文、英文、希腊字母、URL、中西文标点与行内公式，字体只有思源宋体 SC。**未测试**：日文假名（规则里有，但未与 Typst 对比）、韩文、拉丁扩展 A 以外的带变音拉丁字母、从右向左书写的文字、emoji、其它字体。断点规则是对 Typst 实际行为的复刻而非完整的 ICU 实现；要支持更多书写系统时，建议改用 ICU4X（WASM）计算断点。

`src/text/mathjax-node.js`（仅 Node）用 MathJax 3 把公式渲染为 SVG 并给出盒尺寸，供 `contentFromText` 与输出端使用。`mathjax-full` 是可选的 peer 依赖：只在调用时加载，浏览器/Zotero 宿主用自己的 MathJax/KaTeX，不需要它。

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

- `npm test`：Node 单元测试（`test/*.test.js`），不需要浏览器，也不需要 Typst。`test/text.test.js` 用 `test/fixtures/text-parity/typst-lines.json`（Typst 自身断行的离线记录，1196 例）检查断行一致性。
- `npm run test:typst`：与 Typst 现场对比断行（`experiments/measure/compare-typst.js`，含公式盒与引号定向用例，共 2721 例）。需要 `typst`（`TYPST_BIN`）、retain-pdf 的字体目录（`RPR_FONT_DIR`）与装有 PyMuPDF 的 Python（`RPR_PYTHON`），缺任何一项时跳过。`npm run test:typst -- --export` 同时刷新离线记录。
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
