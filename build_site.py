"""Copy the public website into dist/, ready to upload.

Run from the repository root:   python3 build_site.py

Only the page files and the seven data files the map loads go in.
The workbook and export.py stay out, so they never end up on the public site.
"""
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"

PAGES = ["index.html", "app.js", "style.css"]
DATA = ["places.geojson", "records.json", "sources.json", "relations.json",
        "meta.json", "footprints.geojson", "archives.json"]

if DIST.exists():
    shutil.rmtree(DIST)
(DIST / "data").mkdir(parents=True)

for f in PAGES:
    shutil.copy2(ROOT / f, DIST / f)
for f in DATA:
    shutil.copy2(ROOT / "data" / f, DIST / "data" / f)

files = [p for p in DIST.rglob("*") if p.is_file()]
size_mb = sum(p.stat().st_size for p in files) / 1e6
print(f"dist/ built: {len(files)} files, {size_mb:.1f} MB")
