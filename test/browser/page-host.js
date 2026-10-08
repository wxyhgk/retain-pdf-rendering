// Browser-side host for the fit harness. Loaded as a classic script after
// src/render.js and src/fit.js; exposes window.__rprHarness.
//
// It plays the role LitMTrans-Zotero's workbench plays in production: supplies
// deterministic Markdown/TeX stand-ins, mounts pages in a `.layout-document`
// container, and runs the same uncached fit sequence as the workbench's
// ensureLayoutFit(). The invariant probes mirror the fitter's own geometry
// helpers (textRectsInPage, rectsOverlap) and tolerances.
(function () {
  "use strict";

  const R = window.RetainPdfRendering;
  const BODY_SELECTOR = '.layout-flow-stream[data-style-kind="body_text"][data-flow-kind="text"]:not([data-body-inherited="1"])';
  // Same tolerance as the fitter's final audit (avoidPageOverflow and the
  // rectsOverlap padding in textCollisionDetails), in source-page units.
  const TOLERANCE = 1.5;

  function escapeHTML(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Plain-text TeX stand-in. `.katex` is the class the fitter and layout.css
  // treat as rendered math, so formula scaling still exercises its paths.
  function renderTeX(tex, display) {
    return `<span class="katex${display ? " katex-display" : ""}">${escapeHTML(String(tex ?? ""))}</span>`;
  }

  // Escapes text and renders \( \) / \[ \] / $ $ spans with renderTeX.
  function renderInline(text) {
    const source = String(text ?? "");
    const pattern = /\\\((.+?)\\\)|\\\[(.+?)\\\]|\$([^$\n]+?)\$/gs;
    let html = "";
    let last = 0;
    for (const match of source.matchAll(pattern)) {
      html += escapeHTML(source.slice(last, match.index));
      html += renderTeX(match[1] ?? match[2] ?? match[3], false);
      last = match.index + match[0].length;
    }
    return html + escapeHTML(source.slice(last));
  }

  function parseTocTextRows(text) {
    return String(text || "").split("\n").map(line => {
      if (!line.trim()) return { gap: true };
      const match = line.match(/^(\S+)\s+(.+?)\s+(\d+)$/);
      if (!match) return { text: line };
      return { number: match[1], title: match[2], page: match[3], level: match[1].split(".").length - 1 };
    });
  }

  function containers(useTranslation) {
    const active = document.getElementById(useTranslation ? "translation-layout" : "source-layout");
    const inactive = document.getElementById(useTranslation ? "source-layout" : "translation-layout");
    return { active, inactive };
  }

  async function buildAndFit(model, useTranslation) {
    const { active, inactive } = containers(useTranslation);
    for (const container of [active, inactive]) container.replaceChildren();
    inactive.hidden = true;
    active.hidden = false;
    let pages = null;
    const renderer = R.Render.createRenderer({
      document,
      renderInline,
      renderTeX,
      resolveImage: target => target,
      parseTocTextRows,
      onPagesBuilt: built => { pages = built; }
    });
    active.appendChild(renderer.buildLayoutDocument(model, useTranslation));
    // The workbench marks the document root while fitting so that
    // `content-visibility: auto` on page wraps cannot hide off-screen glyphs.
    active.classList.add("layout-fit-measuring");
    try { await document.fonts.ready; } catch (_) {}
    const fitter = R.Fit.createFitter({ document, window, getStorage: () => null });
    // Same order as the workbench's uncached ensureLayoutFit() path (minus the
    // host-only user body-font override).
    fitter.demoteFalseSingleLineText(pages);
    fitter.fitLayoutPages(pages);
    fitter.fitLayoutFormulas(pages, { expand: true });
    return pages;
  }

  function fitNodes(page) {
    return [...page.querySelectorAll(":scope > .layout-flow-stream, :scope > .layout-block")];
  }

  function fittedFontPx(node) {
    const rendered = parseFloat(node.style.fontSize || "");
    const scale = Number(node.dataset.layoutFontScale || 1);
    return Number.isFinite(rendered) && rendered > 0
      ? rendered / Math.max(.0001, scale)
      : parseFloat(node.dataset.baseFont || "0") || 0;
  }

  function nodeLabel(node) {
    const kind = node.classList.contains("layout-flow-stream")
      ? `stream:${node.dataset.styleKind || ""}/${node.dataset.flowKind || ""}`
      : `block:${node.dataset.blockKind || ""}`;
    return `${kind}#${node.dataset.blockID || "?"}`;
  }

  // Mirror of fit.js textRectsInPage(): visible text glyph rectangles in
  // source-page coordinates.
  function textRectsInPage(el, page) {
    const pageRect = page.getBoundingClientRect();
    const scaleX = page.offsetWidth > 0 ? pageRect.width / page.offsetWidth : 1;
    const scaleY = page.offsetHeight > 0 ? pageRect.height / page.offsetHeight : 1;
    const sourceWidth = Number(page.dataset.sourceWidth || 0);
    const coordinateScale = sourceWidth > 0 && page.offsetWidth > 0 ? page.offsetWidth / sourceWidth : 1;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest(".mjx-assistive-mml, .katex-mathml, .layout-line-debug-box, .layout-collision-debug-layer")) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest('[aria-hidden="true"]') && !parent.closest(".katex-html")) return NodeFilter.FILTER_REJECT;
        const style = getComputedStyle(parent);
        return style.display !== "none" && style.visibility !== "hidden"
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    });
    const range = document.createRange();
    const rects = [];
    let node;
    while ((node = walker.nextNode())) {
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width <= .5 || rect.height <= .5) continue;
        rects.push({
          left: (rect.left - pageRect.left) / scaleX / coordinateScale,
          top: (rect.top - pageRect.top) / scaleY / coordinateScale,
          right: (rect.right - pageRect.left) / scaleX / coordinateScale,
          bottom: (rect.bottom - pageRect.top) / scaleY / coordinateScale,
          text: node.textContent.trim().slice(0, 24)
        });
      }
    }
    return rects;
  }

  // Mirror of fit.js rectsOverlap().
  function rectsOverlap(a, b, padding) {
    return a.left < b.right - padding && a.right > b.left + padding &&
      a.top < b.bottom - padding && a.bottom > b.top + padding;
  }

  function boxInPage(el, page) {
    const sourceWidth = Number(page.dataset.sourceWidth || 0);
    const coordinateScale = sourceWidth > 0 && page.offsetWidth > 0 ? page.offsetWidth / sourceWidth : 1;
    return {
      left: el.offsetLeft / coordinateScale,
      top: el.offsetTop / coordinateScale,
      right: (el.offsetLeft + el.offsetWidth) / coordinateScale,
      bottom: (el.offsetTop + el.offsetHeight) / coordinateScale
    };
  }

  // Mirror of fit.js renderedContentRectsInPage(): text rects plus rendered
  // media; the block box when nothing is measurable.
  function renderedContentRects(entry, page) {
    const rects = entry.rects.slice();
    const pageRect = page.getBoundingClientRect();
    const scaleX = page.offsetWidth > 0 ? pageRect.width / page.offsetWidth : 1;
    const scaleY = page.offsetHeight > 0 ? pageRect.height / page.offsetHeight : 1;
    const sourceWidth = Number(page.dataset.sourceWidth || 0);
    const coordinateScale = sourceWidth > 0 && page.offsetWidth > 0 ? page.offsetWidth / sourceWidth : 1;
    for (const node of new Set(entry.node.querySelectorAll("mjx-container, img, table, svg, canvas"))) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = node.getBoundingClientRect();
      if (rect.width <= .5 || rect.height <= .5) continue;
      rects.push({
        left: (rect.left - pageRect.left) / scaleX / coordinateScale,
        top: (rect.top - pageRect.top) / scaleY / coordinateScale,
        right: (rect.right - pageRect.left) / scaleX / coordinateScale,
        bottom: (rect.bottom - pageRect.top) / scaleY / coordinateScale
      });
    }
    return rects.length ? rects : [entry.box];
  }

  // Collision predicate of the fitter's final audit (enforceFinalTextCollision
  // Safety -> textCollisionDetails with checkAllTextForCollisions,
  // includeGroupPeers, bodyColumnIndependentFit, bodyTextCollisionGeometry,
  // ignoreBodyTopOverflow, sharedEdgeTolerance 4.0,
  // sharedHorizontalEdgeTolerance 3.0, rectsOverlap padding 1.5). Body text
  // is tested glyph-against-rendered-content of same-column blocks; any other
  // text is tested glyph-against-layout-box. Applied here to every layout node
  // with text, not just the flow streams the audit itself repairs.
  function fitterCollision(source, entries, page) {
    const own = source.box;
    for (const barrier of entries) {
      if (barrier === source) continue;
      if (source.isBody && !(own.left < barrier.box.right - 1.5 && own.right > barrier.box.left + 1.5)) continue;
      barrier.content ||= renderedContentRects(barrier, page);
      const geometry = source.isBody ? barrier.content : [barrier.box];
      for (const rect of source.rects) {
        const hit = geometry.find(other => rectsOverlap(rect, other, TOLERANCE));
        if (!hit) continue;
        if (source.isBody && rect.top < own.top && barrier.box.bottom <= own.top + 1.5) continue;
        const sharesRightEdge = Math.abs(own.right - barrier.box.left) <= 1.5;
        const sharesLeftEdge = Math.abs(own.left - barrier.box.right) <= 1.5;
        if ((sharesRightEdge && rect.right <= own.right + 4.0) || (sharesLeftEdge && rect.left >= own.left - 4.0)) continue;
        const sharesBottomEdge = Math.abs(own.bottom - barrier.box.top) <= 1.5;
        const sharesTopEdge = Math.abs(own.top - barrier.box.bottom) <= 1.5;
        if ((sharesBottomEdge && rect.bottom <= own.bottom + 3.0) || (sharesTopEdge && rect.top >= own.top - 3.0)) continue;
        return {
          source: source.label,
          blocker: barrier.label,
          sourceBox: roundRect(own),
          blockerBox: roundRect(barrier.box),
          rect: roundRect(rect),
          blockerRect: roundRect(hit)
        };
      }
    }
    return null;
  }

  // Strict line-box overlap between two nodes' text rects, for diagnostics
  // only: Range rects span the font's ascent+descent, not ink, so the fitter
  // deliberately does not treat these as collisions.
  function lineBoxOverlap(a, b) {
    for (const ra of a.rects) {
      const rb = b.rects.find(other => rectsOverlap(ra, other, TOLERANCE));
      if (rb) return { a: a.label, b: b.label, rectA: roundRect(ra), rectB: roundRect(rb) };
    }
    return null;
  }

  const round = (value, digits = 2) => Number(Number(value).toFixed(digits));
  const roundRect = rect => ({
    left: round(rect.left), top: round(rect.top), right: round(rect.right), bottom: round(rect.bottom), text: rect.text
  });

  function inspect(pages) {
    const records = [];
    const overflows = [];
    const collisions = [];
    const lineBoxOverlaps = [];
    let bodyNodes = 0;
    let bodyLabelled = 0;
    for (const page of pages) {
      const pageIndex = Number(page.closest(".layout-page-wrap")?.dataset.page ?? -1);
      const width = Number(page.dataset.sourceWidth || 0);
      const height = Number(page.dataset.sourceHeight || 0);
      const entries = fitNodes(page).map(node => ({
        node,
        label: nodeLabel(node),
        rects: textRectsInPage(node, page),
        box: boxInPage(node, page),
        isBody: node.dataset.styleKind === "body_text"
      }));
      for (const { node, label, rects } of entries) {
        records.push({
          page: pageIndex,
          node: label,
          fontSize: round(fittedFontPx(node), 3),
          lineHeight: node.style.lineHeight || "",
          body: node.matches(BODY_SELECTOR)
        });
        if (node.matches(BODY_SELECTOR)) {
          bodyNodes++;
          if (String(node.dataset.fitLabel || "").startsWith("正文迭代")) bodyLabelled++;
        }
        const outside = rects.find(rect =>
          rect.left < -TOLERANCE || rect.top < -TOLERANCE ||
          rect.right > width + TOLERANCE || rect.bottom > height + TOLERANCE);
        if (outside) overflows.push({ page: pageIndex, node: label, rect: roundRect(outside), pageSize: [width, height] });
      }
      for (const entry of entries) {
        if (!entry.rects.length) continue;
        const hit = fitterCollision(entry, entries, page);
        if (hit) collisions.push({ page: pageIndex, ...hit });
      }
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const hit = lineBoxOverlap(entries[i], entries[j]);
          if (hit) lineBoxOverlaps.push({ page: pageIndex, ...hit });
        }
      }
    }
    const bodyFonts = [...new Set(records.filter(record => record.body).map(record => record.fontSize))].sort((a, b) => a - b);
    return {
      records: records.map(({ body, ...record }) => record),
      overflows,
      collisions,
      lineBoxOverlaps,
      bodyFonts,
      // publishBodyIterationInspection() labels every body node as the last
      // step of runLayoutParityEngine; the engine swallows exceptions outside
      // the debug view, so a missing label means the fit aborted.
      engineCompleted: bodyNodes === bodyLabelled,
      pageCount: pages.length
    };
  }

  async function run(model, useTranslation) {
    const pages = await buildAndFit(model, useTranslation);
    return inspect(pages);
  }

  // Builds without fitting and inflates one text node far beyond its frame,
  // so tests can prove the probes are not vacuous.
  // The inflated node is the first non-inherited body stream.
  async function runUnfittedWithOversizedText(model, useTranslation) {
    const { active, inactive } = containers(useTranslation);
    for (const container of [active, inactive]) container.replaceChildren();
    inactive.hidden = true;
    active.hidden = false;
    let pages = null;
    const renderer = R.Render.createRenderer({
      document, renderInline, renderTeX, parseTocTextRows, onPagesBuilt: built => { pages = built; }
    });
    active.appendChild(renderer.buildLayoutDocument(model, useTranslation));
    active.classList.add("layout-fit-measuring");
    const target = pages.flatMap(page => [...page.querySelectorAll(BODY_SELECTOR)])[0];
    if (target) target.style.fontSize = "40px";
    return inspect(pages);
  }

  async function loadFont(family) {
    await document.fonts.load(`16px "${family}"`, "中文Aa");
    return [...document.fonts].some(face => face.family.replace(/"/g, "") === family && face.status === "loaded");
  }

  window.__rprHarness = { run, runUnfittedWithOversizedText, loadFont };
})();
