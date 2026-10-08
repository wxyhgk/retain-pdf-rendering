// Delimiter usage taxonomy over the corpus, from the scanner's segments.
"use strict";
const { buildCorpus } = require("./corpus");
const { scanMath } = require("./delimiters");
const field = process.argv[2] || "translated";
const c = buildCorpus("/Users/virtualized/Code/retain-pdf/data/jobs");
const entries = c[field];
const counts = {};
const bump = (key, where) => { const e = counts[key] ||= { occurrences: 0, texts: new Set() }; e.occurrences += 1; e.texts.add(where); };
for (const { text, where } of entries) {
  const segs = scanMath(text);
  segs.forEach((s, i) => {
    if (s.type !== "math") return;
    const raw = s.raw;
    if (raw.startsWith("$$")) bump("display $$..$$", where);
    else if (raw.startsWith("\\[")) bump("display \\[..\\]", where);
    else if (raw.startsWith("\\(")) bump("inline \\(..\\)", where);
    else bump("inline $..$", where);
    if (raw.startsWith("$") && !raw.startsWith("$$") && /^\$\s|\s\$$/.test(raw)) bump("  padded inline $ x $", where);
    const prev = segs[i - 1];
    if (prev && prev.type === "math" && prev.end === s.start) bump("  adjacent to previous formula ($a$$b$)", where);
    if (/\\\$/.test(s.tex)) bump("  escaped \\$ inside math", where);
    if (/^\^\s*\{?\s*\[[^\]]*\]\s*\}?$|^\^\s*\{[\d,\s\-–a-z]+\}$/.test(s.tex)) bump("  citation superscript $^{..}$", where);
    if (/\\(AA|aa|L|l)(?![A-Za-z])/.test(s.tex)) bump("  \\AA / \\L macros", where);
    if (/\\begin\{/.test(s.tex)) bump("  \\begin{..} environment", where);
    if (s.tex.length > 300) bump("  long (>300 chars)", where);
  });
  if (/\[\[\d+\]\]/.test(text)) bump("citation placeholder [[n]] (no math)", where);
  const outsideEscaped = segs.filter(s => s.type === "text").length && /\\\$/.test(text.replace(/\$[^$]*\$/g, "")) ;
  if (outsideEscaped) bump("escaped \\$ in prose", where);
}
const out = {};
for (const [k, v] of Object.entries(counts)) out[k] = { texts: v.texts.size, occurrences: v.occurrences };
console.log(field, "unique texts", entries.length);
console.table(out);
