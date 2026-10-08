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

## 在 LitMTrans-Zotero 中

`npm run sync-vendor` 把 `src/{model,render,fit}.js` 复制到 `assets/vendor/retain-pdf-rendering/` 随插件打包；`npm run validate` 会检查复制件与包源码一致。
