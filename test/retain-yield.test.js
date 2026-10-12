"use strict";

// yieldFromAbove (passes/retain-body.js): a paragraph that collides even at the 4.8 pt floor
// because the paragraph above spilled into its first line gets the room back from that
// paragraph instead of collapsing to the floor.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fitInput } = require("../src/retain/measured.js");
const { MathStore } = require("../src/output/math-store.js");
const { outputViolations } = require("./helpers/output-path");

function fitFixture(fitOptions = {}) {
  const input = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/retain-yield/stacked-exercises.json"), "utf8"));
  const maths = new MathStore(fs.mkdtempSync(path.join(os.tmpdir(), "rpr-yield-")), { files: false });
  return fitInput(input, { maths, fitOptions }).fitted;
}

test("retain: a paragraph hit by the spill of the one above is not crushed to the floor", () => {
  const yields = [];
  const fitted = fitFixture({ retainTrace: (id, stage, data) => { if (stage === "yield") yields.push({ id, ...data }); } });
  const text = fitted.pages.flatMap(page => page.nodes).filter(node => node.textRects && node.textRects.length);
  const font = id => text.find(node => node.id === id)?.fontSize;

  // Before: all three at 4.8 pt (each collided with the spill above at every size).
  for (const id of ["p015-b0008", "p015-b0016", "p015-b0018"]) {
    assert.ok(font(id) > 7, `${id} at ${font(id)} pt`);
  }
  assert.deepEqual(text.filter(node => node.fontSize <= 4.8).map(node => node.id), []);

  // The paragraphs above gave the room back, but only a little and never below 85 %.
  assert.ok(yields.length > 0, "something yielded");
  for (const y of yields) assert.ok(y.to >= y.from * 0.85 - 1e-6, JSON.stringify(y));

  // Giving room back must not create overlaps or push text off the page.
  const violations = outputViolations(fitted);
  assert.equal(violations.lineOverlaps.length, 0, JSON.stringify(violations.lineOverlaps.slice(0, 2)));
  assert.equal(violations.outside.length, 0);
});
