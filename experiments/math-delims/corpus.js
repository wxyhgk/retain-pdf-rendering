// Builds a de-duplicated corpus of translated (and source) texts from every
// retain-pdf job under data/jobs (read-only).
"use strict";
const fs = require("node:fs");
const path = require("node:path");

function buildCorpus(jobsRoot) {
  const translated = new Map();
  const source = new Map();
  let jobs = 0;
  let items = 0;
  for (const job of fs.readdirSync(jobsRoot).sort()) {
    const dir = path.join(jobsRoot, job, "translated");
    if (!fs.existsSync(dir)) continue;
    const pages = fs.readdirSync(dir).filter(name => /^page-\d+.*\.json$/.test(name));
    if (!pages.length) continue;
    jobs += 1;
    for (const name of pages) {
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { continue; }
      for (const item of Array.isArray(data) ? data : []) {
        items += 1;
        const where = `${job}/${name}#${item.item_id || ""}`;
        const t = String(item.translated_text || "");
        if (t && !translated.has(t)) translated.set(t, where);
        const s = String(item.source_text || "");
        if (s && !source.has(s)) source.set(s, where);
      }
    }
  }
  return { jobs, items, translated: [...translated].map(([text, where]) => ({ text, where })), source: [...source].map(([text, where]) => ({ text, where })) };
}

module.exports = { buildCorpus };
