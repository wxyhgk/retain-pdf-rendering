"use strict";

const path = require("node:path");

module.exports = {
  Model: require("./model"),
  Render: require("./render"),
  Fit: require("./fit"),
  Text: require("./text/measurer"),
  // Advance table of the default face (Source Han Serif SC Regular), for
  // Text.createMeasurer({ metrics }). Browser/Zotero hosts load the same
  // JSON file themselves.
  defaultFontTable() {
    return require(path.join(__dirname, "..", "data", "fonts", "source-han-serif-sc-regular.json"));
  }
};
