"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("package exposes Model, Render and Fit", () => {
  const api = require("..");
  for (const name of ["Model", "Render", "Fit"]) assert.equal(typeof api[name], "object", name);
});

test("package ships the layout stylesheet without a font binary", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const css = fs.readFileSync(path.join(__dirname, "..", "src", "layout.css"), "utf8");
  for (const selector of [".layout-page-wrap", ".layout-page {", ".layout-block {", ".layout-flow-stream {", ".layout-equation-number", ".layout-awaiting-overlay"]) {
    assert.ok(css.includes(selector), `layout.css styles ${selector}`);
  }
  assert.doesNotMatch(css, /@font-face\s*\{/, "hosts declare the font face");
  assert.doesNotMatch(css, /\.markdown-body|#translation-pane|\.ai-sidebar/, "no workbench chrome");
});
