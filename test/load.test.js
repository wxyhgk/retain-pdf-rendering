"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("package exposes Model, Render and Fit", () => {
  const api = require("..");
  for (const name of ["Model", "Render", "Fit"]) assert.equal(typeof api[name], "object", name);
});
