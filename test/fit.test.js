"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Fit = require("../src/fit");

test("fit loads without a DOM and exposes createFitter", () => {
  assert.equal(typeof globalThis.document, "undefined");
  assert.equal(typeof Fit.createFitter, "function");
  const fitter = Fit.createFitter();
  for (const name of [
    "fitLayoutPages", "fitLayoutFormulas", "runLayoutParityEngine", "demoteFalseSingleLineText",
    "clampTranslatedOverflow", "clampTranslatedCodeOverflow", "refreshLayoutPageScales",
    "layoutPageCoordinateScale", "restoreFitCache", "saveFitCache"
  ]) assert.equal(typeof fitter[name], "function", name);
});

test("fitter instances do not share functions or state", () => {
  const first = Fit.createFitter();
  const second = Fit.createFitter();
  assert.notEqual(first.runLayoutParityEngine, second.runLayoutParityEngine);
  assert.notEqual(first._internal.gallopingGrow, second._internal.gallopingGrow);
});

test("package source stays host-agnostic", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "fit.js"), "utf8");
  // Strip the header banner, which names the forbidden hosts on purpose.
  const body = source.slice(source.indexOf("function (root) {"));
  for (const forbidden of [/LitMTrans/, /Zotero/, /\bstate\./, /\bels\[/, /\bU\./]) {
    assert.doesNotMatch(body, forbidden);
  }
});

test("gallopingGrow finds the largest non-colliding tick", () => {
  const { gallopingGrow } = Fit.createFitter()._internal;
  const probed = [];
  const result = gallopingGrow(8, 13, 0.25, (value) => { probed.push(value); return value > 10.6; });
  assert.equal(result.value, 10.5);
  assert.ok(result.probes === probed.length);
  assert.ok(result.probes < 20, "galloping search must beat the 20-tick linear scan");
  // Every probe stays inside [start, max].
  for (const value of probed) assert.ok(value > 8 && value <= 13);
});

test("gallopingGrow returns max when nothing collides and start when already at max", () => {
  const { gallopingGrow } = Fit.createFitter()._internal;
  assert.deepEqual(gallopingGrow(10, 10, 0.25, () => true), { value: 10, probes: 0 });
  assert.equal(gallopingGrow(8, 13, 0.25, () => false).value, 13);
  // Non-power-of-two tick count: the endpoint must be probed explicitly.
  const tail = gallopingGrow(0, 23, 1, (value) => value === 23);
  assert.equal(tail.value, 22);
  // Immediate collision keeps the start value.
  assert.equal(gallopingGrow(8, 13, 0.25, () => true).value, 8);
});

test("rect helpers detect overlap and union", () => {
  const { rectsOverlap, rectUnion, horizontalBoxesOverlap, layoutRectsOverlap, layoutRectUnion, medianValueLocal } = Fit.createFitter()._internal;
  const a = { left: 0, top: 0, right: 10, bottom: 10 };
  const b = { left: 9, top: 9, right: 20, bottom: 20 };
  const c = { left: 30, top: 0, right: 40, bottom: 5 };
  assert.equal(rectsOverlap(a, b, 0), true);
  assert.equal(rectsOverlap(a, b, 1.5), false);
  assert.equal(rectsOverlap(a, c, 0), false);
  assert.equal(layoutRectsOverlap(a, b, 0), true);
  assert.equal(layoutRectsOverlap(a, b), false);
  assert.equal(horizontalBoxesOverlap(a, b), true);
  assert.equal(horizontalBoxesOverlap(a, c), false);
  for (const union of [rectUnion, layoutRectUnion]) {
    assert.deepEqual(union([a, null, c]), { left: 0, top: 0, right: 40, bottom: 10 });
    assert.equal(union([]), null);
    assert.equal(union(null), null);
  }
  assert.equal(medianValueLocal([3, 1, 2]), 2);
  assert.equal(medianValueLocal([4, 1, 3, 2]), 2.5);
});

test("fit cache reads and writes go through the injected storage", () => {
  const store = new Map([["other:scope:x", "1"]]);
  const storage = {
    get length() { return store.size; },
    key: (index) => [...store.keys()][index] ?? null,
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key)
  };
  const body = { dataset: { layoutCacheKey: "fp", layoutCacheScope: "doc" }, classList: { contains: () => false } };
  const fakeDocument = { body, querySelectorAll: () => [] };
  const { fitCacheVersion } = Fit.createFitter()._internal;
  const key = `${fitCacheVersion}:doc:fp`;
  store.set(`${fitCacheVersion}:doc:stale`, "{}");
  const fitter = Fit.createFitter({ document: fakeDocument, window: {}, getStorage: () => storage });
  fitter.saveFitCache();
  assert.equal(store.has(`${fitCacheVersion}:doc:stale`), false, "stale keys in the same scope are pruned");
  assert.equal(store.get("other:scope:x"), "1");
  assert.deepEqual(JSON.parse(store.get(key)).count, 0);
  // Unavailable storage disables the cache instead of throwing.
  const broken = Fit.createFitter({ document: fakeDocument, window: {}, getStorage: () => { throw new Error("denied"); } });
  assert.doesNotThrow(() => broken.saveFitCache());
  assert.equal(broken.restoreFitCache(), false);
});
