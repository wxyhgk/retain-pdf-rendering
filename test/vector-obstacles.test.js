"use strict";

// experiments/overlay/vector-obstacles.js: vector graphics without an OCR
// block become obstacles only where text could overflow into them.
const test = require("node:test");
const assert = require("node:assert/strict");
const V = require("../experiments/overlay/vector-obstacles.js");

const page = drawings => ({ width: 600, height: 800, drawings });
const line = (x0, y0, x1, y1, extra = {}) => ({ rect: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)], type: "s", width: 1, fill: null, stroke: [0, 0, 0], polylines: [[[x0, y0], [x1, y1]]], ...extra });
const rectPath = (x0, y0, x1, y1) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];

test("vector obstacles: a frame around a text box constrains only its edges", () => {
  const frame = { rect: [50, 50, 550, 300], type: "s", width: 0.5, fill: null, stroke: [0, 0.8, 0.6], polylines: rectPath(50, 50, 550, 300) };
  const { obstacles } = V.vectorObstacles(page([frame]), [[60, 60, 540, 290]], []);
  assert.ok(obstacles.length >= 4);
  for (const o of obstacles) {
    const insideInterior = o.bbox[0] > 52 && o.bbox[2] < 548 && o.bbox[1] > 52 && o.bbox[3] < 298;
    assert.equal(insideInterior, false, `edge strip ${o.bbox} must not cover the frame interior`);
  }
});

test("vector obstacles: geometry inside a repainted text box is cut away", () => {
  const rule = line(0, 100, 600, 100);
  const { obstacles } = V.vectorObstacles(page([rule]), [[100, 90, 300, 110]], []);
  assert.ok(obstacles.length === 2, JSON.stringify(obstacles));
  for (const o of obstacles) assert.ok(o.bbox[2] <= 100 + 1e-9 || o.bbox[0] >= 300 - 1e-9);
});

test("vector obstacles: clip paths and white masks hide geometry", () => {
  const clipped = line(400, -20, 400, 300, { clip: [300, 60, 500, 180] });
  const hidden = line(100, 400, 300, 400);
  const mask = { rect: [50, 350, 350, 450], type: "f", width: 0, fill: [1, 1, 1], stroke: null, polylines: rectPath(50, 350, 350, 450) };
  const { obstacles, counts } = V.vectorObstacles(page([clipped, hidden, mask]), [], []);
  assert.equal(counts.masks, 1);
  for (const o of obstacles) {
    assert.ok(o.bbox[1] >= 60 - 1e-9 && o.bbox[3] <= 180 + 1e-9, `clipped stroke must stay inside its clip: ${o.bbox}`);
  }
});

test("vector obstacles: page backgrounds and drawings inside OCR obstacles are ignored", () => {
  const background = { rect: [0, 0, 600, 800], type: "f", width: 0, fill: [0.9, 0.9, 0.8], stroke: null, polylines: rectPath(0, 0, 600, 800) };
  const figureLine = line(110, 110, 190, 190);
  const { obstacles, counts } = V.vectorObstacles(page([background, figureLine]), [], [[100, 100, 200, 200]]);
  assert.equal(counts.background, 1);
  assert.equal(counts.insideObstacle, 1);
  assert.equal(obstacles.length, 0);
});

test("vector obstacles: a coloured panel behind a text box contributes its outline", () => {
  const panel = { rect: [50, 80, 550, 110], type: "f", width: 0, fill: [0, 0.8, 0.6], stroke: null, polylines: rectPath(50, 80, 550, 110) };
  const { obstacles, counts } = V.vectorObstacles(page([panel]), [[60, 85, 120, 105]], []);
  assert.equal(counts.panels, 1);
  assert.ok(obstacles.every(o => o.kind === "panel-edge"));
  assert.ok(!obstacles.some(o => o.bbox[0] < 120 && o.bbox[2] > 60 && o.bbox[1] < 105 && o.bbox[3] > 85), "nothing inside the text box");
});
