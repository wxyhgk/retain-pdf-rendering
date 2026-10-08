"use strict";

// Starts a tiny local HTTP server for the package files and a Playwright
// browser page that loads layout.css, render.js, fit.js and page-host.js.

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const FONT_FAMILY = "LitMTrans Source Han Serif";
// 1x1 transparent PNG for model image URLs.
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);
const STATIC_FILES = {
  "/src/layout.css": ["src/layout.css", "text/css"],
  "/src/render.js": ["src/render.js", "text/javascript"],
  "/src/fit.js": ["src/fit.js", "text/javascript"],
  "/test/browser/page-host.js": ["test/browser/page-host.js", "text/javascript"]
};

function skip(reason) {
  const error = new Error(reason);
  error.skipReason = reason;
  return error;
}

function pageHTML(fontPath) {
  const fontFace = fontPath
    ? `<style>@font-face { font-family: "${FONT_FAMILY}"; src: url("/font/test${path.extname(fontPath)}"); font-style: normal; font-weight: 400; }</style>`
    : "";
  // The inline style stands in for the host page chrome that layout.css
  // assumes (LitMTrans-Zotero's workbench.css base rules).
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; background: #fff; }
body { font: 13px/1.45 sans-serif; }
</style>
${fontFace}
<link rel="stylesheet" href="/src/layout.css">
<script src="/src/render.js"></script>
<script src="/src/fit.js"></script>
<script src="/test/browser/page-host.js"></script>
</head>
<body>
<div id="source-layout" class="layout-document" hidden="hidden"></div>
<div id="translation-layout" class="layout-document" hidden="hidden"></div>
</body>
</html>
`;
}

function createServer(fontPath) {
  const html = pageHTML(fontPath);
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const send = (status, type, body) => {
      response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      response.end(body);
    };
    if (url.pathname === "/") return send(200, "text/html; charset=utf-8", html);
    if (STATIC_FILES[url.pathname]) {
      const [file, type] = STATIC_FILES[url.pathname];
      return send(200, `${type}; charset=utf-8`, fs.readFileSync(path.join(root, file)));
    }
    if (url.pathname.startsWith("/asset/")) return send(200, "image/png", PLACEHOLDER_PNG);
    if (fontPath && url.pathname === `/font/test${path.extname(fontPath)}`) {
      return send(200, "font/ttf", fs.readFileSync(fontPath));
    }
    return send(404, "text/plain", "not found");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function pickBrowser(playwright) {
  const installed = name => {
    try { return fs.existsSync(playwright[name].executablePath()); }
    catch (_) { return false; }
  };
  const requested = String(process.env.RPR_BROWSER || "").trim().toLowerCase();
  if (requested) {
    if (!["firefox", "chromium"].includes(requested)) throw new Error(`RPR_BROWSER must be firefox or chromium, got ${requested}`);
    if (!installed(requested)) throw skip(`RPR_BROWSER=${requested} but it is not installed (npx playwright install ${requested})`);
    return requested;
  }
  if (installed("firefox")) return "firefox";
  if (installed("chromium")) return "chromium";
  throw skip("no Playwright browser installed (npx playwright install firefox)");
}

async function startHarness() {
  let playwright;
  try { playwright = require("playwright"); }
  catch (_) { throw skip("playwright is not installed (npm install)"); }

  const fontPath = process.env.RPR_TEST_FONT ? path.resolve(process.env.RPR_TEST_FONT) : "";
  if (fontPath && !fs.existsSync(fontPath)) throw new Error(`RPR_TEST_FONT does not exist: ${fontPath}`);

  const browserName = pickBrowser(playwright);
  const server = await createServer(fontPath);
  let browser = null;
  try {
    browser = await playwright[browserName].launch();
    const page = await browser.newPage({ viewport: { width: 1000, height: 1300 }, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => Boolean(window.__rprHarness && window.RetainPdfRendering?.Fit));
    if (fontPath) {
      const loaded = await page.evaluate(family => window.__rprHarness.loadFont(family), FONT_FAMILY);
      if (!loaded) throw new Error(`RPR_TEST_FONT ${fontPath} did not load in ${browserName}`);
    }
    const version = browser.version();
    const fontKey = fontPath ? path.basename(fontPath, path.extname(fontPath)) : "system-fonts";
    return {
      page,
      browserName,
      version,
      snapshotKey: {
        browser: browserName,
        major: Number.parseInt(version, 10),
        platform: process.platform,
        font: fontKey
      },
      // System-font and real-font runs never share a snapshot file.
      snapshotName: fontPath ? `${browserName}.${fontKey}` : browserName,
      async run(model, useTranslation) {
        const result = await page.evaluate(
          ([data, translated]) => window.__rprHarness.run(data, translated),
          [model, useTranslation]
        );
        if (pageErrors.length) throw pageErrors.shift();
        return result;
      },
      async close() {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
      }
    };
  }
  catch (error) {
    await browser?.close();
    server.close();
    throw error;
  }
}

module.exports = { startHarness, FONT_FAMILY };
