// retain-pdf-rendering/model
// Host-agnostic: never reference Zotero, LitMTrans or plugin globals here.
// Host services (preferences, hashing, abort signals, asset lookup, markdown
// rendering) are passed in by the caller.
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else {
    const namespace = root.RetainPdfRendering = root.RetainPdfRendering || {};
    namespace.Model = api;
  }
})(typeof this === "object" && this ? this : globalThis, function (root) {
  "use strict";

  return {};
});
