# Typst 后端可行性实验

问题：能否不用浏览器，改用 Typst 完成测量与 PDF 输出；公式用 MathJax SVG 显示，叠一层透明 LaTeX 文字保证可复制？

结论：**可以。** 在现有 golden 模型上端到端跑通，换行与浏览器逐段一致，公式复制出来是 LaTeX，3 页文档总耗时约 1 秒、只调用 2 次 Typst。

本目录是实验代码，不影响 `src/`。

## 运行

依赖：`npm install`（含 `mathjax-full`）、Typst 0.15（默认 `~/.local/bin/typst`，可用 `TYPST_BIN` 覆盖）、retain-pdf 打包的思源宋体（默认 `../retain-pdf/resources/fonts`，可用 `RPR_FONT_DIR` 覆盖）。PNG 与文字提取用 retain-pdf 虚拟环境里的 PyMuPDF（`RPR_PYTHON` 覆盖）。

```sh
node experiments/typst/run.js two-column-article [--mode translation|source] [--demo-inline-math]
# → experiments/typst/output/<fixture>-<mode>[-math]/{doc.typ,doc.pdf,measure.typ,page-N.png,text.txt,report.json}

RPR_TEST_FONT=/path/SourceHanSerifCN-Regular.ttf \
  node experiments/typst/compare-lines.js two-column-article --mode source
# → 同一字号下浏览器（Playwright Firefox）与 Typst 的逐段行数对比
```

`--demo-inline-math` 往几段正文译文里追加含行内公式的句子（上下标、分式、求和、一个 MathJax 不认识的宏），因为 golden fixture 本身没有行内公式。

## 流水线

| 文件 | 作用 |
|---|---|
| `math-svg.js` | MathJax 3（liteAdaptor，无浏览器）把 LaTeX 转成自包含 SVG（`fontCache: 'none'`）。尺寸单位是 MathJax 自己字体的 ex，按 `font.params.x_height`（0.442）换算成周围文字的 em。解析错误（merror）和未知宏（`noundefined` 输出的红色 mtext）都判为失败，不抛异常。 |
| `content.js` | 排版模型 → 定位文字节点。取文策略与 `src/render.js` 一致（译文 / 原文 HTML / 原文文本的优先级、part 拼接、段落、`<br>` 强制换行）。 |
| `emit.js` | 生成 Typst：测量文档与输出文档共用前导（`rpr-math` 等）。普通文字一律以字符串字面量输出，不会被当作 Typst 标记解析。 |
| `typst.js` | 调用 `typst eval 'query(<rpr-measure>)…'` 与 `typst compile`，固定 `--font-path` + `--ignore-system-fonts`。 |
| `fit.js` | 简化拟合器（不是 `src/fit.js` 的移植）：全文共享正文字号（不超过模型求出的统一字号）、逐块回退行距（下限 1.02）、题注/参考文献/标题分组共享字号、只向下方空白处生长。 |
| `run.js` | 串起来：一次批量测量 → 拟合 → 一次编译 → PNG/文字提取 → 与浏览器快照对比。 |

### 度量映射

- 思源宋体的 ascender + descender 恰好 1em。设 `text(top-edge: "ascender", bottom-edge: "descender")` 后，CSS 行高比 r 对应 `par(leading: (r-1)·size)`；CSS 首行上方、末行下方各有半个行距，输出时用 block inset 补上。实测 n 行高度 = n·size，与推导一致。
- 每个段落在每个候选字号下测两次（leading 0 与 1pt），差值即行数 − 1；任意行高比下的高度由此解析算出，无需再测。
- 段落间距：`par(spacing: (r-1)·size + gap·size)`，对应 CSS 的 `margin-bottom: var(--para-gap)`。

### 行内公式

```typst
#let rpr-math(src, w, h, depth, tex) = box(baseline: depth, width: w, height: h, {
  place(top + left, image(src, width: w, height: h))           // 看得见的公式
  place(bottom + left, dy: -depth, context { …透明文字 tex… })  // 复制/搜索用
})
```

两个子元素都用 `place`，盒子没有自己的文字行，基线就是底边；`baseline: depth` 再把它下移公式的下沉量，公式与正文基线对齐。透明文字的基线也放在正文基线上，所以 PDF 文字提取时它与前后文字在同一行（早先把文字放在流里时，盒子基线跑到了顶部，公式整体偏低）。透明文字字号按 SVG 宽度缩放，选中高亮与公式大致重合。MathJax 失败时显示红色原文 LaTeX，整页仍能编译。

## 结果（two-column-article，3 页）

**换行一致性**（同字号 10px，Firefox 157 + 思源宋体 vs Typst）：

| fixture / 模式 | 段落行数一致 |
|---|---|
| two-column-article 原文 | 32/32 |
| two-column-article 译文 | 32/32 |
| single-column-report 原文 | 9/9 |
| single-column-report 译文 | 9/9 |

前提是 `par(linebreaks: "simple")`。Typst 默认的 Knuth-Plass（`optimized`）在两端对齐的英文段落里会压缩词距、多塞几个词，原文模式 5/32 段少一行；现在默认 simple，`RPR_LINEBREAKS=optimized` 可切回。

**拟合结果对比**（Firefox 快照，思源宋体）：

| | Typst | 浏览器 |
|---|---|---|
| 正文统一字号（译文） | 10.5 | 10.58 |
| 正文统一字号（原文） | 10.2 | 10.08 |
| 正文逐块行高比最大差 | 0.056 / 0.036 | — |

字号阶梯步长 0.1，所以译文的 10.58 落在 10.5。标题、题注、单行文字流差别较大（+1 到 +5pt），原因是简化拟合器对这些组用"放大到空间允许"的规则，而 `src/fit.js` 有自己的起点、碰撞和聚类规则，这部分没有移植，与测量无关。

**复制**：PyMuPDF 提取 `--demo-inline-math` 输出，行内公式按阅读顺序原样出现在句子里，例如
`其中冲击阻抗 $Z = \rho_0 u_s$，粒子速度 $u_p$ 与压力增量 $p - p_0 = \rho_0 u_s u_p$ 成正比。`
行间公式为 `$$…$$`，表格单元格里的公式也一样。

**耗时**（Apple M1）：

| 步骤 | 译文 | 原文 |
|---|---|---|
| MathJax（5 个公式） | 12 ms | 12 ms |
| 批量测量 `typst eval`（4180 个探测点） | 714 ms | 1007 ms |
| 拟合 | 5 ms | 5 ms |
| 编译 PDF | 31 ms | 34 ms |
| Typst 调用次数 | 2 | 2 |

其余 fixture 全部跑通、0 冲突、0 公式失败（原先两个公式带双重转义的 `\\[…\\]` 外壳，已按插件的做法去壳）。

## 发现的问题 / 限制

1. **拿不到逐行几何。** `measure` 只给块的宽高；`src/fit.js` 的正文碰撞是逐行字形检测。本实验改为按块高度 + 下方空白判断。要逐行几何，可以在测量文档里对每行放 `metadata` + `here().position()`，或干脆让拟合只依赖块高度（Typst 输出里不存在浏览器那种行框溢出到别的块的情况）。
2. **测量量大。** 每段 × 每个候选字号都测一次（正文阶梯 83 档、标题 89 档）。改成粗细两轮（0.5 步长定位，再 0.1 细化）可以把探测点减到约 1/4，代价是多一次 Typst 调用。也可以直接用 typst.ts 在进程内调用，省掉进程启动和重复解析。
3. **英文连字符。** 文档 `lang: "zh"`，英文段落不断词，两端对齐时词距偏大（浏览器侧同样因为 `lang="zh-CN"` 不断词，所以行数一致）。真正排版时应按段落语言设 `lang`。
4. **字体变体。** 浏览器快照用插件的 SourceHanSerifCN（TTF），Typst 用 retain-pdf 的 SourceHanSerifSC（OTF）。两者拉丁字母与常用汉字字宽一致，行数完全对上；个别区域字形可能不同。
5. **公式字体与正文字体不同**（MathJax TeX 字体 vs 思源宋体），与浏览器里 KaTeX 的情况相同。
6. **很长的行内公式不能在内部折行**（是一整张 SVG）。
7. **透明文字的选中高亮**按 SVG 宽度缩放，长 LaTeX 源码对应窄公式时字号会很小，选区高度变低，但复制内容不受影响。

## 建议的下一步

1. 把"测量"抽成接口：`src/fit.js` 的分组/共享字号/行距回退逻辑保持不变，测量后端可选浏览器或 Typst，并用 `compare-lines.js` 这类对比测试守住一致性。
2. 测量改成粗细两轮或进程内 typst.ts，目标 3 页 < 300 ms。
3. 输出端直接用 Typst 生成译文 PDF，替换插件里的 `print()` 路径；retain-pdf 也可以共用这套 Typst 生成与公式方案，摆脱 mitex。

## Update: JS measurer

`run.js --measurer js` replaces the Typst measurement query with the pure-JS
line layout in `experiments/measure` (see its README: 100 % line-break parity
with Typst, 300 pages measured in ~6 s instead of ~111 s) and emits those line
breaks explicitly. `--measurer both` runs both and compares them.

Fix found while doing so: in Typst ≥ 0.13 inline content alone in a `block` is
not a paragraph and ignores `hanging-indent`, so reference entries measured
alone had no hanging indent while the output (entries joined by `parbreak()`)
had one. Every paragraph is now wrapped in `par[...]` in both documents.
