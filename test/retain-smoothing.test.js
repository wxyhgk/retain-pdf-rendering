"use strict";

// Typography profile "retain": retain-pdf's neighbour-consistency rules
// (typography-retain.js helpers used by passes/retain-body.js and
// passes/retain-smoothing.js). Expected numbers follow the retain-pdf
// sources cited next to the constants.

const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../src/fit-model/typography-retain.js");

const box = (left, top, right, bottom) => ({ left, top, right, bottom });

test("short region expansion: a narrow one-liner under two body anchors widens by 30%, capped at the anchors", () => {
  const items = [
    { id: "a1", anchor: true, box: box(39, 100, 398, 160) },
    { id: "a2", anchor: true, box: box(39, 165, 398, 225) },
    { id: "short", anchor: false, box: box(39, 230, 174, 241) },   // 135 wide, 11 tall
    { id: "wide", anchor: false, box: box(39, 245, 330, 256) }     // 291 > 0.78 x 359 -> not expanded
  ];
  const out = T.shortRegionExpansion(items, 553);
  assert.equal(out.get("short"), 174 + 135 * 0.30);
  assert.equal(out.has("wide"), false);
  // never past the anchors' right edge
  const near = T.shortRegionExpansion([...items.slice(0, 2), { id: "s", anchor: false, box: box(39, 230, 380, 241) }], 553);
  assert.equal(near.has("s"), false, "380 wide is not narrow (> 0.78 x median width)");
  const capped = T.shortRegionExpansion([...items.slice(0, 2), { id: "s", anchor: false, box: box(39, 230, 300, 241) }], 553);
  assert.equal(capped.get("s"), 378.3, "300 + 0.30 x 261, below the anchors' right edge 398");
  const atAnchor = T.shortRegionExpansion([...items.slice(0, 2), { id: "s", anchor: false, box: box(94, 230, 364, 241) }], 553);
  assert.equal(atAnchor.get("s"), 398, "364 + 0.30 x 270 = 445 is capped at the anchors' right edge");
  const farLeft = T.shortRegionExpansion([...items.slice(0, 2), { id: "s", anchor: false, box: box(120, 230, 340, 241) }], 553);
  assert.equal(farLeft.size, 0, "left edge 81 pt from the anchors exceeds max(18, 0.10 x page width)");
});

test("short region expansion: needs two same-column anchors above, and only touches non-anchors", () => {
  const oneAnchor = [{ id: "a", anchor: true, box: box(39, 100, 398, 160) }, { id: "s", anchor: false, box: box(39, 170, 174, 181) }, { id: "b", anchor: true, box: box(39, 190, 398, 250) }];
  assert.equal(T.shortRegionExpansion(oneAnchor, 553).size, 0, "the second anchor is below, not above");
  const otherColumn = [
    { id: "a1", anchor: true, box: box(300, 100, 520, 160) },
    { id: "a2", anchor: true, box: box(300, 165, 520, 225) },
    { id: "a3", anchor: true, box: box(39, 100, 260, 225) },
    { id: "s", anchor: false, box: box(39, 230, 120, 241) }
  ];
  assert.equal(T.shortRegionExpansion(otherColumn, 553).size, 0, "anchors in another column do not count");
});

test("short body inheritance: decreases freely, grows by at most 1.8 pt", () => {
  assert.equal(T.shortBodyTargetFont(10.6, 10.0), 10);
  assert.equal(T.shortBodyTargetFont(8.2, 10.53), 10);     // 8.2 + 1.8
  assert.equal(T.shortBodyTargetFont(9.9, 10.53), 10.53);
  assert.equal(T.shortBodyTargetFont(0, 10), 0);
});

test("adjacent smoothing: excess over 0.24 pt (0.34 relaxed) is 60% grown, the rest shrunk", () => {
  // delta 1.5, excess 1.26: smaller may grow 0.756 -> 9.86; larger stays 10.6
  assert.deepEqual(T.smoothFontPair({ smallerFont: 9.1, largerFont: 10.6, relaxed: false }), { smaller: 9.86, larger: 10.1 });
  // growth blocked (safety or density): the larger one gives up the whole excess
  assert.deepEqual(T.smoothFontPair({ smallerFont: 9.1, largerFont: 10.6, relaxed: false, growCap: 9.1 }), { smaller: 9.1, larger: 9.34 });
  // relaxed threshold
  assert.deepEqual(T.smoothFontPair({ smallerFont: 10.0, largerFont: 10.3, relaxed: true }), { smaller: 10.0, larger: 10.3 });
  assert.deepEqual(T.smoothFontPair({ smallerFont: 10.0, largerFont: 10.3, relaxed: false }), { smaller: 10.04, larger: 10.28 });
  // floor 6.4
  assert.equal(T.smoothFontPair({ smallerFont: 4.8, largerFont: 9, relaxed: false, growCap: 4.8 }).larger, 6.4);
});

test("long paragraph harmonizing clamps to median ± band", () => {
  assert.equal(T.harmonizeBand(10.9, 10.6, 0.14), 10.74);
  assert.equal(T.harmonizeBand(10.2, 10.6, 0.14), 10.46);
  assert.equal(T.harmonizeBand(10.65, 10.6, 0.14), 10.65);
});
