# retain-obstacle-cut

`flowchart-footnote.json`：一页带流程图的教材页（rpr_fit 输入，只含这一页）。流程图左下角印着一条脚注；OCR 把整张
流程图框成一个图片块，范围连脚注也框了进去，脚注又单独识别成文字块，两者重叠约 12 pt。来自 retain-pdf 一次真实
任务（Paddle OCR）；文字已替换（汉字一律「文」、字母 x / X），公式与几何原样保留。

用途见 `test/retain-obstacle-cut.test.js`。
