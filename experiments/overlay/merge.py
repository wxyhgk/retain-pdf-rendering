"""Overlay the Typst pages onto retain-pdf's text-stripped source PDF.

Usage: python merge.py BASE.pdf OVERLAY.pdf OUT.pdf
Uses pikepdf (content-stream overlay, like retain-pdf's own merge); reads the
inputs only and writes OUT.pdf.
"""
import json
import sys
import time

import pikepdf

base_path, overlay_path, out_path = sys.argv[1:4]
started = time.perf_counter()
with pikepdf.open(base_path) as base, pikepdf.open(overlay_path) as overlay:
    if len(overlay.pages) > len(base.pages):
        raise SystemExit(f"overlay has {len(overlay.pages)} pages, base {len(base.pages)}")
    for index, page in enumerate(overlay.pages):
        base.pages[index].add_overlay(page)
    base.save(out_path, compress_streams=True, object_stream_mode=pikepdf.ObjectStreamMode.generate)
print(json.dumps({"ms": round((time.perf_counter() - started) * 1000)}))
