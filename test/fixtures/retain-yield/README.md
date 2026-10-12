# retain-yield

`stacked-exercises.json`：一页习题（rpr_fit 输入，`rpr_fit_input_v1`，只含这一页的 document / translations /
visual_profile / drawings）。来自 retain-pdf 一次真实任务（Paddle OCR）；文字已替换（汉字一律换成「文」、
英文字母换成 x / X），公式、标点和全部几何原样保留——汉字等宽，替换不改变排版。

用途见 `test/retain-yield.test.js`：上一题译文的下标伸进下一题框里，以前下一题第一行在任何字号都碰到它，
被压到 4.8 pt 的地板。
