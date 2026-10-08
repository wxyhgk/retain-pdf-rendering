"use strict";

// Deterministic stand-ins for the host services the renderer needs. The
// golden fixtures were produced by the original workbench code wired to these
// same stubs, so any output difference is caused by the renderer itself.

const { createFakeDocument } = require("./fake-dom");

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHTML(value).replace(/`/g, "&#96;");
}

function resolveImage(target) {
  return `resolved:${String(target || "")}`;
}

const markdown = {
  renderInline(text, options = {}) {
    const source = String(text ?? "");
    const image = source.match(/!\[[^\]]*\]\(([^)]+)\)/);
    const resolved = image && typeof options.resolveImage === "function" ? options.resolveImage(image[1]) : "";
    return `<span class="md-inline"${resolved ? ` data-image="${escapeAttribute(resolved)}"` : ""}>${escapeHTML(source)}</span>`;
  },
  renderTeX(tex, display) {
    return `<span class="katex${display ? " katex-display" : ""}">${escapeHTML(String(tex ?? ""))}</span>`;
  },
  normalizeEscapedTeXDelimiters(text) {
    return String(text).replace(/\\\\\(/g, "\\(").replace(/\\\\\)/g, "\\)");
  },
  normalizeBareTeXFragments(text) {
    return String(text).replace(/\\sigma _ \{ t \}/g, "\\(\\sigma_{t}\\)");
  }
};

function parseTocTextRows(text) {
  return String(text || "").split("\n").map(line => {
    if (!line.trim()) return { gap: true };
    const match = line.match(/^(\S+)\s+(.+?)\s+(\d+)$/);
    if (!match) return { text: line };
    return { number: match[1], title: match[2], page: match[3], level: match[1].split(".").length - 1 };
  });
}

function setElementHTML(target, html) {
  target.innerHTML = String(html || "");
  return true;
}

function createHost(options = {}) {
  const document = createFakeDocument();
  const frames = [];
  return {
    document,
    frames,
    escapeHTML,
    escapeAttribute,
    resolveImage,
    markdown,
    parseTocTextRows,
    setElementHTML,
    debug: Boolean(options.debug),
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; }
  };
}

module.exports = { createHost };
