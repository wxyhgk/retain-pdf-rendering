"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const Text = require("../src/text/measurer");
const Linebreak = require("../src/text/linebreak");
const table = require("../data/fonts/source-han-serif-sc-regular.json");

const measurer = Text.createMeasurer({ metrics: table });
const metrics = measurer.metrics;
const em = (text, mode) => Array.from(metrics.shape(text, undefined, mode)).reduce((sum, value) => sum + value, 0);
const lineText = (prepared, line) => prepared.text.slice(line.start, line.end);
const box = (widthEm, heightEm = 0.9, depthEm = 0.2) => ({ widthEm, heightEm, depthEm });

test("Typst parity: committed line breaks from Typst (1196 probes)", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "text-parity", "typst-lines.json"), "utf8"));
  let probes = 0;
  const mismatches = [];
  for (const paragraph of fixture.paragraphs) {
    const prepared = measurer.prepare(paragraph.content);
    for (const [size, expected] of Object.entries(paragraph.typst)) {
      probes += 1;
      const { lines } = measurer.layout(prepared, { ...paragraph.options, fontSize: Number(size), width: paragraph.width });
      const ours = lines.map(line => {
        let out = "";
        for (let i = line.start; i < line.end; i++) {
          const run = prepared.boxes.get(i);
          out += run ? run.run.tex : prepared.text[i];
        }
        return [...out.replace(/[\s\u2028]+/g, "")].length;
      }).filter(Boolean);
      if (JSON.stringify(ours) !== JSON.stringify(expected)) mismatches.push({ id: paragraph.id, size, expected, ours });
    }
  }
  assert.equal(probes, fixture.summary.probes);
  assert.deepEqual(mismatches.slice(0, 5), [], `${mismatches.length} of ${probes} probes break differently from Typst`);
});

test("UAX #14 port reproduces the linebreak package", t => {
  let LineBreaker;
  try { LineBreaker = require("linebreak"); }
  catch (_) { t.skip("linebreak (dev dependency) not installed"); return; }
  const reference = string => {
    const breaker = new LineBreaker(string);
    const out = [];
    for (let bk; (bk = breaker.nextBreak());) out.push(`${bk.position}${bk.required ? "!" : ""}`);
    return out.join(",");
  };
  const ours = string => Linebreak.uax14Breaks(string).map(bk => `${bk.position}${bk.required ? "!" : ""}`).join(",");
  let seed = 11;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pool = ["abc def", "中文测试，标点。", "（括号）「引号」", "“双”‘单’", "http://x.org/a-b?c=1", "3.5% 10–20", "\u2028", "\n", "\r\n", " ", "—…·", "ﬁ", "😀👍🏽", "한국어", "カタカナ", "α-β", "­​⁠", "-/!?$€", "￼"];
  for (let k = 0; k < 3000; k++) {
    let string = "";
    for (let i = 0, n = 1 + Math.floor(random() * 10); i < n; i++) {
      const piece = pool[Math.floor(random() * pool.length)];
      const start = Math.floor(random() * piece.length);
      string += piece.slice(start, start + 1 + Math.floor(random() * 4));
    }
    assert.equal(ours(string), reference(string), JSON.stringify(string));
  }
});

test("inline boxes follow ICU's LB20, and ” keeps a Latin word or number but breaks before “, ( or —", () => {
  const OBJ = Linebreak.OBJECT;
  const positions = text => Linebreak.breakOpportunities(text, false).map(bk => bk.position);
  // Verified against Typst 0.15.1 (experiments/measure/probes/box-and-quote.json).
  for (const after of ["；", "：", "・", "々", "ー", "％", "%", "°", "-", "‐", "–", "…"]) {
    assert.ok(positions(`前${OBJ}${after}后`).includes(2), `break between a box and ${after}`);
  }
  for (const after of ["。", "，", "、", "）", "！", "?", ".", ","]) {
    assert.ok(!positions(`前${OBJ}${after}后`).includes(2), `no break between a box and ${after}`);
  }
  for (const before of ["$", "¥", "€", "＄", "±"]) {
    assert.ok(positions(`前${before}${OBJ}后`).includes(2), `break between ${before} and a box`);
  }
  for (const after of ["“", "(", "[", "—"]) assert.ok(positions(`的”${after}后`).includes(2), `break between ” and ${after}`);
  for (const after of ["a", "1", "’", "”"]) assert.ok(!positions(`的”${after}后`).includes(2), `no break between ” and ${after}`);
});

test("kinsoku: no line starts with closing or ends with opening CJK punctuation", () => {
  const noStart = new Set("，。、：；？！）」』】》”");
  const noEnd = new Set("（「『【《“");
  let seed = 3;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const han = "冲击波在水中的传播并比较测量结果与数值模拟";
  const punct = ["，", "。", "、", "：", "？！", "）。", "」，", "》、"];
  const open = ["（", "「", "《", "“"];
  let lines = 0;
  for (let k = 0; k < 200; k++) {
    let text = "";
    while ([...text].length < 80) {
      const r = random();
      if (r < 0.6) text += han[Math.floor(random() * han.length)];
      else if (r < 0.85) text += punct[Math.floor(random() * punct.length)];
      else text += open[Math.floor(random() * open.length)];
    }
    const prepared = measurer.prepare([{ type: "text", text }]);
    for (const width of [41, 63, 97, 131]) {
      const result = measurer.layout(prepared, { fontSize: 10, width });
      result.lines.forEach((line, index) => {
        const value = lineText(prepared, line).trim();
        if (!value) return;
        lines += 1;
        if (index > 0) assert.ok(!noStart.has(value[0]), `line starts with ${value[0]}: ${value}`);
        if (index < result.lines.length - 1) assert.ok(!noEnd.has(value[value.length - 1]), `line ends with ${value[value.length - 1]}: ${value}`);
      });
    }
  }
  assert.ok(lines > 1000);
});

test("CJK–Latin spacing: a quarter em between adjacent Han and Latin glyphs, none across a space", () => {
  const size = 10;
  const natural = text => measurer.naturalWidth(measurer.prepare([{ type: "text", text }]), { fontSize: size });
  const han = em("中");
  const a = em("a");
  assert.ok(Math.abs(natural("中a") - (han + a + 0.25) * size) < 1e-9);
  assert.ok(Math.abs(natural("a中") - (a + han + 0.25) * size) < 1e-9);
  assert.ok(Math.abs(natural("中 a") - (han + em(" ") + a) * size) < 1e-9);
  // Consecutive CJK punctuation shares half a glyph: "）。" is 1.5 em wide,
  // minus the closing half of "。" at the paragraph end.
  assert.ok(Math.abs(natural("中）。") - (han + 1.5 - 0.5) * size) < 1e-9);
});

test("math runs are atomic boxes and raise the line", () => {
  const content = [
    { type: "text", text: "能量满足" },
    { type: "math", tex: "$E = mc^2$", ...box(3.2, 1.6, 0.5) },
    { type: "text", text: "且守恒。" }
  ];
  const prepared = measurer.prepare(content);
  for (const width of [20, 35, 50, 80, 200]) {
    const result = measurer.layout(prepared, { fontSize: 10, width });
    const holders = result.lines.filter(line => lineText(prepared, line).includes(Linebreak.OBJECT));
    assert.equal(holders.length, 1, "the formula sits on exactly one line");
    const line = holders[0];
    assert.ok(line.ascent >= (1.6 - 0.5) * 10 - 1e-9 && line.descent >= 0.5 * 10 - 1e-9);
    assert.equal(line.glyphBottom - line.glyphTop, line.ascent + line.descent);
  }
  // Narrower than the box: the box overflows on its own line instead of splitting.
  const narrow = measurer.layout(prepared, { fontSize: 10, width: 10 });
  assert.ok(narrow.lines.some(line => lineText(prepared, line) === Linebreak.OBJECT && line.width > 10));
});

test("forced breaks end a line, are never justified, and newline text becomes a break", () => {
  const runs = Text.contentFromText("第一行文字\n第二行文字");
  assert.deepEqual(runs.map(run => run.type), ["text", "break", "text"]);
  const prepared = measurer.prepare(runs);
  const result = measurer.layout(prepared, { fontSize: 10, width: 500, lineHeight: 1.5 });
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0].forced, true);
  assert.equal(result.lines[0].justified, false);
  assert.ok(Math.abs(result.height - (2 * 10 + 5)) < 1e-9, "two 1 em lines plus one leading of (1.5 - 1) em");
  assert.ok(Math.abs(result.lines[1].top - 15) < 1e-9);
});

test("indents: first-line indent and hanging indent position lines and reduce their room", () => {
  const prepared = measurer.prepare([{ type: "text", text: "研究采用合成数据分析冲击波在水中的传播并比较测量结果与数值模拟之间的差异。".repeat(2) }]);
  const plain = measurer.layout(prepared, { fontSize: 10, width: 100 });
  const indented = measurer.layout(prepared, { fontSize: 10, width: 100, firstLineIndent: 20 });
  assert.equal(indented.lines[0].x, 20);
  assert.ok(lineText(prepared, indented.lines[0]).length < lineText(prepared, plain.lines[0]).length);
  assert.ok(indented.lines.slice(1).every(line => line.x === 0));
  const hanging = measurer.layout(prepared, { fontSize: 10, width: 100, hangingIndentEm: 1.1 });
  assert.equal(hanging.lines[0].x, 0);
  assert.ok(hanging.lines.slice(1).every(line => Math.abs(line.x - 11) < 1e-9 && line.width <= 100 - 11 + 1e-4));
  const centered = measurer.layout(prepared, { fontSize: 10, width: 400, align: "center" });
  const last = centered.lines[centered.lines.length - 1];
  assert.ok(Math.abs(last.x - (400 - last.width) / 2) < 1e-9);
});

test("fitFontSize: binary search returns a fitting size whose next step does not fit", () => {
  let seed = 5;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const han = "冲击波在水中的传播并比较测量结果与数值模拟之间差异";
  let cases = 0;
  let nonMonotonic = 0;
  for (let k = 0; k < 150; k++) {
    let text = "";
    for (let i = 0, n = 20 + Math.floor(random() * 120); i < n; i++) text += random() < 0.15 ? " shock wave " : random() < 0.1 ? "，" : han[Math.floor(random() * han.length)];
    const prepared = measurer.prepare([{ type: "text", text }]);
    const options = { width: 60 + random() * 300, maxHeight: 20 + random() * 120, lineHeight: 1.2, minFont: 4.8, maxFont: 13, step: 0.1 };
    const fit = measurer.fitFontSize(prepared, options);
    cases += 1;
    const ladder = Text._internal.stepLadder(options.minFont, options.maxFont, options.step);
    const fitsAt = size => measurer.layout(prepared, { ...options, fontSize: size }).height <= options.maxHeight + 1e-6;
    if (!fit.fits) {
      assert.equal(fit.fontSize, options.minFont);
      assert.equal(fitsAt(options.minFont), false);
      continue;
    }
    assert.ok(fitsAt(fit.fontSize));
    const index = ladder.indexOf(fit.fontSize);
    if (index + 1 < ladder.length) assert.equal(fitsAt(ladder[index + 1]), false, "the neighbour step must fail");
    assert.ok(fit.probes <= 12, `binary search used ${fit.probes} layouts`);
    const linear = ladder.filter(fitsAt).pop();
    if (linear !== fit.fontSize) nonMonotonic += 1;
  }
  assert.equal(cases, 150);
  // Greedy breaking is not strictly monotonic; any such case must still have
  // passed the neighbour check above.
  assert.ok(nonMonotonic <= cases * 0.05, `${nonMonotonic} non-monotonic cases`);
});

test("contentFromText: delimiters, display math, escaped dollars and failed formulas", () => {
  const seen = [];
  const runs = Text.contentFromText("a $x$ b \\(y\\) c \\[z\\] d $$w$$ e \\$5 and $ 6", {
    renderMathBox(tex, display) {
      seen.push([tex, display]);
      if (tex === "w") throw new Error("unrenderable");
      return box(1);
    }
  });
  assert.deepEqual(seen, [["x", false], ["y", false], ["z", true], ["w", true]]);
  const maths = runs.filter(run => run.type === "math");
  assert.equal(maths.length, 3, "a throwing renderer leaves the formula as text");
  assert.ok(runs.some(run => run.type === "text" && run.text === "w"), "failed TeX is kept without its delimiters");
  assert.ok(runs[runs.length - 1].text.endsWith("$5 and $ 6"), "\\$ outside math is a literal dollar; a lone $ stays text");
});

test("the text modules run as plain scripts without Node APIs (browser/Zotero path)", () => {
  const context = { console };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ["uax14-data.js", "metrics.js", "linebreak.js", "measurer.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "text", file), "utf8");
    assert.doesNotMatch(source.replace(/^\s*\/\/.*$/gm, "").replace(/isNode \? require\("[^"]+"\)/g, ""), /\brequire\(|\bprocess\.|\bBuffer\b/, `${file} uses a Node API outside the CommonJS branch`);
    vm.runInContext(source, context, { filename: file });
  }
  const Browser = context.RetainPdfRendering.Text;
  const browserMeasurer = Browser.createMeasurer({ metrics: JSON.parse(JSON.stringify(table)) });
  const prepared = browserMeasurer.prepare([{ type: "text", text: "浏览器中同样可以测量 text 宽度。" }]);
  const a = browserMeasurer.layout(prepared, { fontSize: 9, width: 60 });
  const b = measurer.layout(measurer.prepare([{ type: "text", text: "浏览器中同样可以测量 text 宽度。" }]), { fontSize: 9, width: 60 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
