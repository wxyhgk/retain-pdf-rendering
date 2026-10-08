"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Render = require("../src/render");
const { createHost } = require("./helpers/render-host");
const { serialize } = require("./helpers/fake-dom");
const model = require("./fixtures/render-golden/model");

const goldenDir = path.join(__dirname, "fixtures/render-golden");

function createTestRenderer(host) {
  return Render.createRenderer({
    document: host.document,
    renderInline: host.markdown.renderInline,
    renderTeX: host.markdown.renderTeX,
    normalizeEscapedTeXDelimiters: host.markdown.normalizeEscapedTeXDelimiters,
    normalizeBareTeXFragments: host.markdown.normalizeBareTeXFragments,
    resolveImage: host.resolveImage,
    setElementHTML: host.setElementHTML,
    escapeHTML: host.escapeHTML,
    escapeAttribute: host.escapeAttribute,
    parseTocTextRows: host.parseTocTextRows,
    debug: () => host.debug,
    onPagesBuilt: pages => host.frames.push(pages)
  });
}

// The golden files were produced by the pre-extraction workbench.js render
// code with the same host stubs; `<section` starts a new line for diffability.
const variants = {
  "source.html": { useTranslation: false, debug: false },
  "translation.html": { useTranslation: true, debug: false },
  "source-debug.html": { useTranslation: false, debug: true },
  "translation-debug.html": { useTranslation: true, debug: true }
};

for (const [name, { useTranslation, debug }] of Object.entries(variants)) {
  test(`buildLayoutDocument matches golden DOM: ${name}`, () => {
    const host = createHost({ debug });
    const renderer = createTestRenderer(host);
    const fragment = renderer.buildLayoutDocument(model, useTranslation);
    const html = `${serialize(fragment).replace(/<section /g, "\n<section ").trim()}\n`;
    assert.equal(html, fs.readFileSync(path.join(goldenDir, name), "utf8"));
  });
}

test("buildLayoutDocument hands every page node to onPagesBuilt once", () => {
  const host = createHost();
  const renderer = createTestRenderer(host);
  renderer.buildLayoutDocument(model, true);
  assert.equal(host.frames.length, 1);
  assert.equal(host.frames[0].length, model.pages.length);
  for (const pageNode of host.frames[0]) assert.equal(pageNode.className, "layout-page");

  const perCall = [];
  renderer.buildLayoutDocument(model, false, { onPagesBuilt: pages => perCall.push(pages) });
  assert.equal(perCall.length, 1, "per-call hook overrides the configured one");
  assert.equal(host.frames.length, 1);
});

test("splitTeXEquationTag separates a trailing \\tag", () => {
  assert.deepEqual(Render.splitTeXEquationTag("\\[ E = mc^2 \\tag{3} \\]"), { body: "E = mc^2", number: "3" });
  assert.deepEqual(Render.splitTeXEquationTag("$$a$$"), { body: "a", number: "" });
});

test("createRenderer validates required host services", () => {
  const host = createHost();
  assert.throws(() => Render.createRenderer({ renderInline() {}, renderTeX() {} }), TypeError);
  assert.throws(() => Render.createRenderer({ document: host.document }), TypeError);
});

test("render module stays host-agnostic", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/render.js"), "utf8");
  for (const forbidden of ["LitMTrans", "Zotero", "state.", "els[", "U.", "Markdown.", "window."]) {
    assert.ok(!source.includes(forbidden), `render.js must not reference ${forbidden}`);
  }
});
