# Mapping Erasure

A historical geographic-information-system map of places erased during the building of the
Panama Canal: the settlements that were flooded, depopulated, relocated, or renamed, the
features inside them, and what stands on the same ground now. Live at www.mappingerasure.com.

This repository holds the complete project: the research data, the script that publishes
it, and the website that reads it. There is no server-side code and no database.

## Contents

The source of truth:

```
canal-zone-relational-model.xlsx   the research data — places, sources, attestations,
                                   relations, coordinates, and the corpus of institutions
export.py                          reads that workbook and writes the six JSON files below,
                                   then prints a data-health report of broken cross-sheet
                                   links and unreadable dates
```

The website:

```
index.html                         the page
app.js                             the map application
style.css                          the styling
build_site.py                      copies the public files into dist/ for publishing
```

What the website loads, generated from the workbook by `export.py`:

```
data/places.geojson                the places, with coordinates and lifespans
data/records.json                  the attestations — every reading of every source
data/sources.json                  the sources those readings come from
data/archives.json                 the institutions and collections holding those sources
data/relations.json                the dated relations between places
data/meta.json                     build date and record counts
```

And one file that is **not** generated and cannot be regenerated:

```
data/footprints.geojson            building outlines traced by hand from georeferenced
                                   historical maps. This is primary work product. Keep it.
```

## Why both the workbook and the generated files are here

A web browser cannot read a spreadsheet. The map reads the seven files in `data/`, so
those have to be committed for the site to work at all. The workbook and `export.py` are
committed so the data is inspectable and the map is reproducible, rather than a set of
JSON files with no stated origin.

## Rebuilding the data

Once, to install the two libraries it needs:

```bash
python3 -m pip install pandas openpyxl
```

Then, from the repository root:

```bash
python3 export.py
```

One caution: if the workbook was last written by a script rather than saved from Excel,
open it in Excel and save it before exporting. Scripted edits drop the cached results of
the spreadsheet's own formulas, and exporting in that state produces empty columns.

## Running the site locally

The page fetches its data files, so it must be served over a web address rather than
opened from the file system:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Publishing

Publish `index.html`, `app.js`, `style.css`, and `data/` — **not** the workbook and not
`export.py`. A static host serves every file it is given, so deploying the repository
whole would put the research workbook on the public web as a downloadable file.

The site is hosted on Cloudflare Pages (project `mapping-erasure`).

Once per computer: install Node.js (https://nodejs.org), then sign in to Cloudflare. This
opens a browser window.

```bash
npx wrangler login
```

To publish, from the repository root, first copy the public files into `dist/`:

```bash
python3 build_site.py
```

Then upload that folder:

```bash
npx wrangler pages deploy dist --project-name mapping-erasure --branch main
```

This uploads the files on your computer, so changes do not need to be committed first.
Always deploy `dist/`, never the repository folder, and do not connect this repository to
Cloudflare's automatic Git deploys: both would publish the workbook.

If the page looks unchanged after publishing, raise the `?v=` numbers on `style.css` and
`app.js` in `index.html`, so browsers fetch the new files instead of old saved copies.

## Saving changes to GitHub

Publishing and saving to GitHub are separate. After editing, from the repository root:

```bash
git add -A
git commit -m "Describe the change"
git push
```

`dist/` is listed in `.gitignore`, so the built copy is never committed.

## Full update, start to finish

After editing the workbook (skip the first command if only the page files changed):

```bash
python3 export.py
python3 build_site.py
npx wrangler pages deploy dist --project-name mapping-erasure --branch main
git add -A
git commit -m "Describe the change"
git push
```

## Requires an internet connection

The mapping library (Leaflet), the display typeface, and the background map tiles are
loaded from the open web rather than bundled here.
