"use strict";

// Real-browser check of render + fit + layout.css, with no host application.
//
// For every model-golden fixture this builds the page DOM with createRenderer,
// fits it with createFitter in a real browser engine, and asserts:
//   1. every glyph rect of every layout node stays inside its page;
//   2. no glyph rects of two different layout nodes collide;
//   3. all non-inherited body streams share one font size;
//   4. the fit runs to completion and is deterministic (two runs, same result);
//   5. per-node fitted fontSize / lineHeight match the stored snapshot.
//
// Environment:
//   RPR_BROWSER=firefox|chromium  engine (default: firefox if installed)
//   RPR_TEST_FONT=/path/to.ttf    serve as "LitMTrans Source Han Serif"
//   UPDATE_SNAPSHOTS=1            rewrite snapshots

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { startHarness, FONT_FAMILY } = require("./harness");

const root = path.join(__dirname, "..", "..");
const fixtureDir = path.join(root, "test", "fixtures", "model-golden");
const snapshotDir = path.join(__dirname, "__snapshots__");
const updateSnapshots = process.env.UPDATE_SNAPSHOTS === "1";

// Invariant failures the unchanged fitter is known to leave behind, keyed by
// `${fixture}/${mode}/${invariant}`. A listed failure in one of the listed
// browsers is reported as a todo instead of failing the run; the snapshot is
// still written and compared.
const KNOWN_ISSUES = {};

const fixtures = fs.readdirSync(fixtureDir)
  .filter(name => name.endsWith(".json"))
  .sort()
  .map(name => JSON.parse(fs.readFileSync(path.join(fixtureDir, name), "utf8")));

function hasTranslation(model) {
  return (model.pages || []).some(page => (page.blocks || []).some(block => block.translatable && block.translatedText));
}

// Asset URLs in the goldens use the plugin's resource:// scheme; serve a
// placeholder image from the harness instead.
function browserModel(fixture) {
  return JSON.parse(JSON.stringify(fixture.expected).replace(/resource:\/\/litmtrans-data\//g, "/asset/"));
}

let harness = null;
let skipReason = "";

test.before(async () => {
  try {
    harness = await startHarness();
  }
  catch (error) {
    skipReason = error.skipReason || "";
    if (!skipReason) throw error;
  }
});

test.after(async () => {
  await harness?.close();
});

function checkInvariant(t, id, ok, message, details) {
  if (ok) return;
  const entry = KNOWN_ISSUES[id];
  const known = entry && entry.browsers.includes(harness.browserName) ? entry.reason : "";
  const text = `${message}\n${JSON.stringify(details, null, 2)}`;
  if (known) {
    t.todo(`known issue ${id}: ${known}\n${text}`);
    return;
  }
  assert.fail(text);
}

for (const fixture of fixtures) {
  const model = browserModel(fixture);
  const modes = hasTranslation(model) ? ["source", "translation"] : ["source"];

  test(`fit invariants: ${fixture.name}`, async t => {
    if (!harness) {
      t.skip(skipReason);
      return;
    }
    const snapshot = { key: harness.snapshotKey, modes: {} };
    for (const mode of modes) {
      await t.test(mode, async st => {
        const useTranslation = mode === "translation";
        const first = await harness.run(model, useTranslation);
        const second = await harness.run(model, useTranslation);
        const id = name => `${fixture.name}/${mode}/${name}`;

        assert.ok(first.pageCount > 0, "renderer produced pages");
        checkInvariant(st, id("engine-completed"), first.engineCompleted,
          "runLayoutParityEngine did not reach its final step (exception swallowed outside layout-debug)", {});
        checkInvariant(st, id("page-overflow"), first.overflows.length === 0,
          "glyph rects outside their page", first.overflows);
        checkInvariant(st, id("collision"), first.collisions.length === 0,
          "glyph rects collide with another layout node (fitter final-audit predicate)", first.collisions);
        if (first.lineBoxOverlaps.length) {
          st.diagnostic(`${first.lineBoxOverlaps.length} line-box overlap(s) between nodes, tolerated by the fitter ` +
            `(Range rects include ascent/descent): ${first.lineBoxOverlaps.map(o => `p${o.page} ${o.a} x ${o.b}`).join("; ")}`);
        }
        checkInvariant(st, id("uniform-body-font"), first.bodyFonts.length <= 1,
          "non-inherited body streams have different font sizes", first.bodyFonts);
        assert.deepEqual(second.records, first.records, "fit is deterministic across runs");
        snapshot.modes[mode] = first.records;
      });
    }
    // A mode records its styles only after all of its assertions passed.
    if (Object.keys(snapshot.modes).length !== modes.length) {
      t.diagnostic("snapshot not written or compared: an invariant failed");
      return;
    }

    const file = path.join(snapshotDir, `${fixture.name}.${harness.snapshotName}.json`);
    const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    const keyMatches = existing && JSON.stringify(existing.key) === JSON.stringify(snapshot.key);
    if (updateSnapshots || !existing) {
      fs.mkdirSync(snapshotDir, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 1)}\n`);
      t.diagnostic(`wrote snapshot ${path.relative(root, file)}`);
    }
    else if (!keyMatches) {
      t.diagnostic(`snapshot ${path.relative(root, file)} was recorded with ${JSON.stringify(existing.key)}; ` +
        `current run is ${JSON.stringify(snapshot.key)}. Not compared (UPDATE_SNAPSHOTS=1 to re-record).`);
    }
    else {
      assert.deepEqual(snapshot.modes, existing.modes, `fitted styles match ${path.relative(root, file)}`);
    }
  });
}

test("invariant probes detect an oversized, unfitted stream", async t => {
  if (!harness) return t.skip(skipReason);
  const fixture = fixtures.find(item => item.name === "two-column-article");
  const result = await harness.page.evaluate(
    data => window.__rprHarness.runUnfittedWithOversizedText(data, false),
    browserModel(fixture)
  );
  assert.ok(result.collisions.length > 0, "a 40px body stream must collide with its neighbours");
  assert.ok(result.overflows.length > 0, "a 40px body stream must leave its page");
  assert.ok(result.bodyFonts.length > 1, "one inflated body stream breaks the shared body font");
});

test("harness serves the font family it is told to", { skip: !process.env.RPR_TEST_FONT }, async t => {
  if (!harness) return t.skip(skipReason);
  assert.equal(await harness.page.evaluate(family => window.__rprHarness.loadFont(family), FONT_FAMILY), true);
});
