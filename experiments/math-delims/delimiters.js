// The scanner and TeX normalizer now live in src/text/measurer.js
// (Text.scanMath, Text.normalizeTeX, Text.contentFromText). Kept as a thin
// alias so analyze.js / taxonomy.js read like before.
"use strict";
const Text = require("../../src/text/measurer");

function contentFromMarkedText(input, options = {}) {
  return Text.contentFromText(input, options);
}

module.exports = { scanMath: Text.scanMath, normalizeTeX: Text.normalizeTeX, contentFromMarkedText };
