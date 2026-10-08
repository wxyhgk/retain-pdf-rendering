"use strict";

// Runs src/fit-model.js on the golden layout models and lines the result up
// with the browser fitter's snapshots (test/browser/__snapshots__).

const fs = require("node:fs");
const path = require("node:path");
const FitModel = require("../../src/fit-model.js");
const { createMeasurer, compositeMetrics } = require("./model-measurers");

const FIXTURES = path.resolve(__dirname, "../fixtures/model-golden");
const SNAPSHOTS = path.resolve(__dirname, "../browser/__snapshots__");

// Same stand-in the browser page host uses for translated TOC text.
function parseTocTextRows(text) {
  return String(text || "").split("\n").map(line => {
    if (!line.trim()) return { gap: true };
    const match = line.match(/^(\S+)\s+(.+?)\s+(\d+)$/);
    if (!match) return { text: line };
    return { number: match[1], title: match[2], page: match[3], level: match[1].split(".").length - 1 };
  });
}

function fixtures() {
  return fs.readdirSync(FIXTURES).filter(name => name.endsWith(".json")).sort()
    .map(name => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8")));
}

function snapshotFor(name, browser = "firefox", font = "SourceHanSerifCN-Regular") {
  const file = path.join(SNAPSHOTS, `${name}.${browser}${font ? `.${font}` : ""}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

// The browser renders titles, page furniture and captions in Arial (CJK via
// the platform fallback, measured ~1.021 em wide in Firefox on macOS). Use the
// system Arial for those nodes when it is installed.
const ARIAL = "/System/Library/Fonts/Supplemental/Arial.ttf";
const ARIAL_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf";
const CJK_FALLBACK_SCALE = 1.021;
let sansCache = null;
function sansMeasurers(spacing = "browser") {
  if (!fs.existsSync(ARIAL) || !fs.existsSync(ARIAL_BOLD)) return null;
  if (!sansCache) {
    sansCache = {
      regular: compositeMetrics(ARIAL, undefined, CJK_FALLBACK_SCALE),
      bold: compositeMetrics(ARIAL_BOLD, undefined, CJK_FALLBACK_SCALE)
    };
  }
  return {
    sans: createMeasurer({ spacing, metrics: sansCache.regular }),
    sansBold: createMeasurer({ spacing, metrics: sansCache.bold })
  };
}

// The browser oracle's geometry: CSS line boxes, Gecko's whole-pixel content
// areas. spacing "browser" (Firefox) or "typst" (the measurer unchanged).
function createFitter(spacing = "browser", { sans = true } = {}) {
  return FitModel.createModelFitter({
    measurer: createMeasurer({ spacing }),
    measurers: sans ? (sansMeasurers(spacing) || undefined) : undefined,
    options: { parseTocTextRows },
    lineModel: "css",
    cssPixelRounding: true
  });
}

function category(label) {
  if (label.startsWith("stream:body_text/")) return "body";
  if (label.startsWith("stream:")) return label.includes("/ref_text") ? "refs" : "stream-text";
  if (label.startsWith("block:title")) return "title";
  if (/^block:(table_caption|table_footnote|chart_caption|image_caption|image_footnote)/.test(label)) return "caption";
  return "block";
}

function compare(fitted, expected) {
  const rows = [];
  for (const page of fitted.pages) {
    const want = expected.filter(entry => entry.page === page.index);
    page.nodes.forEach((node, index) => {
      const entry = want[index];
      if (!entry) { rows.push({ page: page.index, label: node.label, missing: "snapshot" }); return; }
      const expectedLine = entry.lineHeight === "" ? null : Number(entry.lineHeight);
      rows.push({
        page: page.index,
        label: node.label,
        snapshotLabel: entry.node,
        category: category(node.label),
        browserFont: entry.fontSize,
        modelFont: node.fontSize,
        dFont: node.fontSize - entry.fontSize,
        browserLine: expectedLine,
        modelLine: node.styleLineHeight ?? null,
        dLine: expectedLine === null || node.styleLineHeight == null ? 0 : node.styleLineHeight - expectedLine,
        node
      });
    });
    if (want.length > page.nodes.length) rows.push({ page: page.index, missing: "model", count: want.length - page.nodes.length });
  }
  return rows;
}

module.exports = { fixtures, snapshotFor, createFitter, compare, category, parseTocTextRows, sansMeasurers };
