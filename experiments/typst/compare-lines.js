#!/usr/bin/env node
"use strict";

// Line-breaking parity: render a fixture in the browser harness and in Typst
// at the same font size and compare per-paragraph line counts of every
// multi-line flow stream.
//
//   RPR_TEST_FONT=/path/SourceHanSerifCN-Regular.ttf \
//     node experiments/typst/compare-lines.js two-column-article [--mode source|translation] [--size 10]

const fs = require("node:fs");
const path = require("node:path");
const { startHarness } = require("../../test/browser/harness");
const { pageNodes } = require("./content");
const { MathStore, measureDocument } = require("./emit");
const typst = require("./typst");

async function main() {
  const args = process.argv.slice(2);
  const name = args.find(arg => !arg.startsWith("--")) || "two-column-article";
  const mode = args.includes("--mode") ? args[args.indexOf("--mode") + 1] : "source";
  const size = args.includes("--size") ? Number(args[args.indexOf("--size") + 1]) : 10;
  const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../test/fixtures/model-golden", `${name}.json`), "utf8"));
  const model = JSON.parse(JSON.stringify(fixture.expected).replace(/resource:\/\/litmtrans-data\//g, "/asset/"));

  const harness = await startHarness();
  let browserLines;
  try {
    await harness.run(model, mode === "translation");
    browserLines = await harness.page.evaluate(fontSize => {
      const result = {};
      const container = document.querySelector(".layout-document:not([hidden])");
      for (const node of container.querySelectorAll(".layout-flow-stream:not(.toc-stream)")) {
        if (node.dataset.originalLines === "single") continue;
        node.style.fontSize = `${fontSize}px`;
        node.style.lineHeight = "1.2";
        const id = node.dataset.blockID;
        result[id] = [...node.querySelectorAll(".flow-para, .flow-ref")].map(paragraph => {
          const range = document.createRange();
          range.selectNodeContents(paragraph);
          const tops = [];
          for (const rect of range.getClientRects()) {
            if (rect.width < .5 || rect.height < .5) continue;
            if (!tops.some(top => Math.abs(top - rect.top) < fontSize * .5)) tops.push(rect.top);
          }
          return tops.length;
        });
      }
      return result;
    }, size);
    var browserInfo = `${harness.browserName} ${harness.version}`;
  }
  finally {
    await harness.close();
  }

  const out = path.join(__dirname, "output", `lines-${name}-${mode}`);
  fs.mkdirSync(out, { recursive: true });
  const maths = new MathStore(out);
  const nodes = model.pages.flatMap((page, pageIndex) => pageNodes(page, mode).map((node, index) => ({ ...node, uid: `p${pageIndex + 1}-${index}` })))
    .filter(node => node.nodeKind === "stream" && !node.single && browserLines[node.id]);
  fs.writeFileSync(path.join(out, "measure.typ"), measureDocument(nodes.map(node => ({ node, sizes: [size] })), maths));
  const { values } = typst.queryMeasurements("measure.typ", out);

  const rows = [];
  let same = 0;
  let total = 0;
  for (const node of nodes) {
    const typstLines = node.paragraphs.map((_, index) => {
      const value = values.find(v => v.id === node.uid && v.para === index);
      return value ? Math.round(value.h1 - value.h0) + 1 : null;
    });
    const browser = browserLines[node.id];
    browser.forEach((lines, index) => {
      total += 1;
      if (lines === typstLines[index]) same += 1;
    });
    rows.push({ node: node.key, browser, typst: typstLines });
  }
  const report = { fixture: name, mode, size, browser: browserInfo, typstFonts: typst.FONT_DIR, paragraphs: total, identicalLineCounts: same, rows };
  fs.writeFileSync(path.join(out, "lines.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, rows: rows.map(row => `${row.node}  browser=${row.browser.join(",")}  typst=${row.typst.join(",")}`) }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
