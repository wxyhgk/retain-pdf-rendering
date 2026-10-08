"""Typesetting parameters retain-pdf actually used, read from its rendered PDF.

Input data for testing the typesetting engine on its own: the engine is given
these sizes and only has to set the text correctly. Deciding sizes is not part
of what is tested.

    python retain_sizes.py <job dir>  ->  JSON on stdout:
    { "<block_id>": { "fontSize", "lineHeight", "firstBaseline", "bold", "lines" } }

For every translated block, the overlay text retain-pdf painted inside the
block's box (spans in a Source Han Serif face; formula and source fonts are
ignored) is grouped into lines by baseline. fontSize is the median span size,
lineHeight the median baseline step over fontSize (em), firstBaseline the
first baseline below the box top (pt). Blocks with no such text are omitted.
"""

import glob
import json
import os
import statistics
import sys

import fitz


def main(job):
    doc = json.load(open(os.path.join(job, "ocr/normalized/document.v1.json"), encoding="utf-8"))
    rendered = glob.glob(os.path.join(job, "rendered", "*.pdf"))
    if not rendered:
        print("{}")
        return
    pdf = fitz.open(rendered[0])
    manifest = json.load(open(os.path.join(job, "translated/translation-manifest.json"), encoding="utf-8"))
    translated = set()
    for entry in manifest.get("pages", []):
        for item in json.load(open(os.path.join(job, "translated", entry["path"]), encoding="utf-8")):
            if item.get("policy_translate") and str(item.get("translated_text") or "").strip():
                translated.add((item.get("page_idx"), item.get("block_idx")))
    out = {}
    for page_data in doc.get("pages", []):
        index = page_data["page_index"]
        if index >= len(pdf):
            continue
        page = pdf[index]
        spans = []
        for block in page.get_text("dict")["blocks"]:
            for line in block.get("lines", []):
                for span in line["spans"]:
                    if span["text"].strip() and "SourceHanSerif" in span["font"]:
                        spans.append(span)
        for block in page_data.get("blocks", []):
            number = int(str(block["block_id"]).rsplit("-b", 1)[-1])
            if (index, number) not in translated:
                continue
            box = fitz.Rect(block["bbox"])
            inside = [s for s in spans if box.contains(fitz.Point((s["bbox"][0] + s["bbox"][2]) / 2, s["origin"][1]))]
            if not inside:
                continue
            size = statistics.median(s["size"] for s in inside)
            baselines = []
            for y in sorted(s["origin"][1] for s in inside):
                if not baselines or y - baselines[-1] > 0.3 * size:
                    baselines.append(y)
            steps = [b - a for a, b in zip(baselines, baselines[1:])]
            out[block["block_id"]] = {
                "fontSize": round(size, 3),
                "lineHeight": round(statistics.median(steps) / size, 4) if steps else None,
                "firstBaseline": round(baselines[0] - box.y0, 3),
                "bold": sum("Bold" in s["font"] for s in inside) > len(inside) / 2,
                "lines": len(baselines),
            }
    print(json.dumps(out))


if __name__ == "__main__":
    main(sys.argv[1])
