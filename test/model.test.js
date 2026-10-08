"use strict";

// Exercises the structure-restoration entry point in plain Node: no plugin
// globals, no DOM. The golden fixtures were captured from the plugin's
// buildModel() before the restoration layer moved into this package.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Model = require("../src/model");

const goldenDir = path.join(__dirname, "fixtures", "model-golden");
const fixtures = fs.readdirSync(goldenDir)
  .filter(name => name.endsWith(".json"))
  .sort()
  .map(name => JSON.parse(fs.readFileSync(path.join(goldenDir, name), "utf8")));

// Same deterministic stand-in for KaTeX that the plugin-side golden test uses.
const escapeHTML = value => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");
const stubRenderTeX = (source, display = false) =>
  `<tex data-display="${display ? 1 : 0}">${escapeHTML(String(source || ""))}</tex>`;

// Mirrors the plugin's asset lookup (MinerUAsset.normalizeAssetKey + basename
// fallback + storage.resourceURL) for the fixture asset maps.
function normalizeAssetKey(value) {
  let key = String(value || "").trim().replace(/^<|>$/g, "");
  try { key = decodeURIComponent(key); }
  catch (_) {}
  return key.replace(/\\/g, "/").replace(/^\.\//, "").split(/[?#]/)[0].toLowerCase();
}
function resolverFor(fixture) {
  const assetMap = fixture.assetMap || {};
  return target => {
    const key = normalizeAssetKey(target);
    const base = String(key || "").split("/").pop() || "";
    const stored = assetMap[key] || assetMap[normalizeAssetKey(base)] || "";
    return stored ? `resource://litmtrans-data/${fixture.name}/${stored}` : "";
  };
}

function restore(fixture, extra = {}) {
  return Model.restoreLayoutDocument({
    pages: structuredClone(fixture.layout.pdf_info),
    modelPages: structuredClone(fixture.modelPages || []),
    resolveAsset: resolverFor(fixture),
    translations: fixture.translations || {},
    formulaMap: fixture.formulaReplacements || {},
    singleColumnBodyPromotion: fixture.singleColumnBodyPromotion !== false,
    ...extra
  });
}

test("model loads without plugin globals", () => {
  assert.equal(typeof Model.restoreLayoutDocument, "function");
  assert.equal(typeof Model.flattenLayoutPage, "function");
  assert.equal(globalThis.RetainPdfRendering, undefined, "CommonJS loading must not install a global namespace");
  assert.equal(globalThis.LitMTrans, undefined);
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "model.js"), "utf8");
  const code = source.split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /\bLitMTrans\b|\bZotero\b|\bServices\b|\bU\.|\bIOUtils\b|\bPathUtils\b/,
    "model.js must stay host-agnostic");
});

test("default renderers need no host", () => {
  assert.equal(
    Model.layoutLinesToHTML([{ spans: [{ type: "text", content: "a < b" }, { type: "inline_equation", content: "x<1" }] }]),
    "a &lt; b\\(x&lt;1\\)"
  );
});

test("restoreLayoutDocument reproduces the golden buildModel output", async () => {
  Model.configure({ renderTeX: stubRenderTeX });
  assert(fixtures.length >= 6);
  for (const fixture of fixtures) {
    const actual = JSON.parse(JSON.stringify(await restore(fixture)));
    const { documentID, sourceFingerprint, ...expected } = fixture.expected;
    assert.equal(documentID, fixture.name);
    assert.equal(typeof sourceFingerprint, "string");
    assert.deepStrictEqual(actual, expected, `${fixture.name}: restoration drifted from the golden capture`);
  }
});

test("checkpoint runs once per page in every restoration pass and can abort", async () => {
  Model.configure({ renderTeX: stubRenderTeX });
  const fixture = fixtures.find(item => item.name === "single-column-report");
  const pageCount = fixture.layout.pdf_info.length;
  const calls = [];
  await restore(fixture, { checkpoint: async index => { calls.push(index); } });
  assert.equal(calls.length, pageCount * 5, "flatten, provisional, context, restore and title passes");
  assert.deepEqual(calls.slice(0, pageCount), [...Array(pageCount).keys()]);

  let seen = 0;
  await assert.rejects(
    restore(fixture, { checkpoint: () => { if (++seen === 3) throw new Error("stopped"); } }),
    /stopped/
  );
  assert.equal(seen, 3, "an abort must stop restoration at the next page");
});

test("single-column promotion is an injected option", async () => {
  Model.configure({ renderTeX: stubRenderTeX });
  const fixture = fixtures.find(item => item.name === "single-column-report");
  const roles = model => model.pages.flatMap(page => page.restoration.streams.map(stream => stream.debugRole));
  const on = await restore(fixture);
  const off = await restore(fixture, { singleColumnBodyPromotion: false });
  assert(roles(on).includes("body_inherited"));
  assert(!roles(off).includes("body_inherited"));
});

test("flattenLayoutPage assigns stable translation, view and formula IDs", () => {
  const page = {
    page_size: [600, 800],
    preproc_blocks: [
      { type: "title", bbox: [50, 40, 550, 90], lines: [{ spans: [{ type: "text", content: "Title" }] }] },
      { type: "interline_equation", bbox: [100, 100, 500, 130], lines: [{ spans: [{ type: "interline_equation", content: "a=b" }] }] },
      { type: "image", bbox: [100, 140, 500, 400], blocks: [
        { type: "image_body", bbox: [100, 140, 500, 380], lines: [{ spans: [{ type: "image", image_path: "images/a.png" }] }] },
        { type: "image_caption", bbox: [100, 382, 500, 398], lines: [{ spans: [{ type: "text", content: "Fig. 1." }] }] }
      ] }
    ]
  };
  const flat = Model.flattenLayoutPage(page, 1, target => `asset:${target}`);
  assert.deepEqual(flat.blocks.map(block => block.id), ["p002_b0001", "p002_v0002", "p002_v0003", "p002_v0004", "p002_c0002"]);
  assert.equal(flat.blocks[1].kind, "formula");
  assert.equal(flat.blocks[1].formulaItems[0].id, "p002_f0001");
  assert.equal(flat.blocks.find(block => block.type === "image_body").imageURL, "asset:images/a.png");
  const narrowed = Model.flattenLayoutPage(page, 1, () => "", new Set(["title"]));
  assert.equal(narrowed.blocks.filter(block => block.translatable).length, 1);
});
