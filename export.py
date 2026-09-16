#!/usr/bin/env python3
"""Turn the relational workbook into the JSON the map reads.

Input is canal-zone-relational-model.xlsx (sheets: places, sources, attestations,
Coordinates, Corpus, relations), plus data/footprints.geojson, which
holds the extents traced by hand in QGIS. Those are checked here and passed through
to the map untouched.

Output goes to data/: places.geojson (one feature per place that has a coordinate),
records.json (every place, located or not), sources.json, relations.json,
archives.json, meta.json.

A place record carries no coordinates of its own. Geometry comes from the workbook's
Coordinates sheet where one has been typed, otherwise from the coordinates the sources
themselves state, otherwise the place stays unlocated.

Every run prints a data health report, so drift in the workbook turns up here rather
than quietly on the map.
"""
import json
import re
import sys
import os
import math
from datetime import date

import pandas as pd

XLSX = sys.argv[1] if len(sys.argv) > 1 else "canal-zone-relational-model.xlsx"


def norm(c):
    """'place_id (PK)' -> 'place_id', 'page / plate' -> 'page_plate'."""
    c = str(c).lower().strip()
    c = re.sub(r"\s*\((pk|fk|auto)\)", "", c)
    c = c.replace(" / ", "_").replace("/", "_").replace(" ", "_")
    return c


def load(sheet):
    df = pd.read_excel(XLSX, sheet_name=sheet)
    df.columns = [norm(c) for c in df.columns]
    return df


def years(start, end):
    """Rough years out of messy strings: 'pre-1850?', '1911-1914', 'c.1880s'."""
    def first(s):
        m = re.findall(r"\d{4}", str(s))
        return int(m[0]) if m else None

    def last(s):
        m = re.findall(r"\d{4}", str(s))
        return int(m[-1]) if m else None

    return first(start), last(end)


def render_as(sp, n_claims=0):
    if n_claims >= 2:
        return "Candidate points"
    lookup = {
        "High": "Solid point",
        "Medium": "Point + buffer",
        "Low": "Translucent area",
        "Disputed": "Candidate points",
        "Unknown": "Unplotted",
    }
    return lookup.get(str(sp).strip(), "Unplotted")


def metres_between(a, b):
    la1, ln1 = a
    la2, ln2 = b
    r = 6371000.0
    p1 = math.radians(la1)
    p2 = math.radians(la2)
    dp = math.radians(la2 - la1)
    dl = math.radians(ln2 - ln1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def num(v):
    if pd.notna(v) and str(v).strip() != "":
        return float(v)
    return None


def visibility(n_sources):
    if n_sources >= 9:
        return "High"
    if n_sources >= 3:
        return "Medium"
    if n_sources >= 1:
        return "Low"
    return "None"


ORIGIN_LABEL = {
    "US corporate (PRR)": "Panama Railroad Company (US-owned)",
    "PRR company": "Panama Railroad Company (US-owned)",
    "French company": "French canal company",
    "French state survey": "French government survey",
    "US commercial": "US commercial publisher",
    "Mixed": "Mixed origins",
    "Secondary": "Later scholarship",
}


def plain_origin(txt):
    # origins say who produced the source. Older workbook rows still carry a
    # "Colonial power" / "Colonized" prefix, so strip that off and expand the rest.
    t = re.sub(r"^\s*(Colonial power|Colonized)\s*[—–-]\s*", "", str(txt))
    return ORIGIN_LABEL.get(t, t)


PLAIN = [
    (r"\bLOC\b", "Library of Congress"),
    (r"\bNARA\b", "National Archives"),
    (r"\bICC\b", "Isthmian Canal Commission"),
    (r"\bPRR\b", "Panama Railroad"),
    (r"\bGovt\b", "Government"),
    (r"\bPhil\. Trans\.", "Philosophical Transactions"),
    (r"\bpub\.", "published"),
    (r"\brev\.", "revision"),
    (r"\bn\.d\.", "undated"),
    (r"\bMt\. ", "Mount "),
    (r"\bSt\. ", "Saint "),
    (r"\bCo\.", "Company"),
    (r"\bc\.(?=\d)", "circa "),
    (r"\(c\.\)", "(circa)"),
    (r"(?<=\d)\s?ft/in\b", " feet per inch"),
    (r"IIIF-downloadable", "downloadable in full resolution"),
    (r"\bOSM\b", "OpenStreetMap"),
    (r"\bU\.S\.(?= administration)", "US"),
    (r"\(PI-91 place index\)", "(1956 National Archives map inventory, place index)"),
    (r"\(OCR: ", "(appears as: "),
    (r"\bED sheet annotation", "census district map annotation"),
    (r"\bED (?=\d)", "census district "),
    (r"\bUNESCO\b", "United Nations (Educational, Scientific and Cultural Organization)"),
]

NAME_NOTES = [
    (r"\(PI-91 place index\)", "(1956 National Archives map inventory, place index)"),
    (r"\(OCR: ", "(appears as: "),
    (r"\bED sheet annotation", "census district map annotation"),
    (r"\bED (?=\d)", "census district "),
]


def plain_name(txt):
    t = str(txt)
    for pat, rep in NAME_NOTES:
        t = re.sub(pat, rep, t)
    return t


def plain_text(txt):
    if txt is None or (isinstance(txt, float) and pd.isna(txt)):
        t = ""
    else:
        t = str(txt)
    for pat, rep in PLAIN:
        t = re.sub(pat, rep, t)
    return t


places = load("places")
sources = load("sources").set_index("source_id")
atts = load("attestations")
rels = load("relations")

name_by_id = {}
for _, p in places.iterrows():
    if isinstance(p.get("place_id"), str):
        name_by_id[str(p["place_id"])] = str(p.get("preferred_name", ""))
place_ids = set(name_by_id)

warns = []


for _, a in atts.iterrows():
    pid = a.get("place_id")
    sid = a.get("source_id")
    if not isinstance(pid, str) or not pid.strip():
        continue
    label = str(a.get("attestation_id") or f"attestation for {pid}")
    if pid not in place_ids:
        warns.append(f"{label}: place_id '{pid}' not on the places sheet")
    if sid not in sources.index:
        warns.append(f"{label}: source_id '{sid}' not on the sources sheet")
    ws = a.get("when_start")
    if pd.notna(ws) and str(ws).strip() and years(ws, None)[0] is None:
        warns.append(f"{label}: when_start '{ws}' has no readable 4-digit year")

for _, r in rels.iterrows():
    rid = r.get("relation_id")
    if not isinstance(rid, str) or not rid.strip():
        continue
    for col in ("place_id", "related_id"):
        v = r.get(col)
        if v not in place_ids:
            warns.append(f"relation {rid}: {col} '{v}' not on the places sheet")

FOOTPRINTS = "data/footprints.geojson"
if os.path.exists(FOOTPRINTS):
    try:
        fps = json.load(open(FOOTPRINTS))
        for i, f in enumerate(fps.get("features", [])):
            props = f.get("properties") or {}
            fpid = props.get("place_id")
            gtype = (f.get("geometry") or {}).get("type")
            if fpid not in place_ids:
                warns.append(f"footprint #{i}: place_id '{fpid}' not on the places sheet")
            if gtype not in ("Polygon", "MultiPolygon"):
                warns.append(f"footprint #{i} ({fpid}): geometry is {gtype}, expected Polygon")
            if not props.get("source"):
                warns.append(f"footprint #{i} ({fpid}): no 'source' property - every traced "
                             "extent must say which map it was digitised from")
    except Exception as e:
        warns.append(f"footprints.geojson unreadable: {e}")


coords = {}
try:
    cdf = pd.read_excel(XLSX, sheet_name="Coordinates", header=1)   # row 1 is a title note
    cdf.columns = [norm(c) for c in cdf.columns]
    has_id = cdf["place_id"].apply(lambda v: isinstance(v, str) and bool(v.strip()))
    orphan_coords = int((cdf["lat"].notna() & cdf["lng"].notna() & ~has_id).sum())
    if orphan_coords:
        warns.append(f"Coordinates sheet: {orphan_coords} typed lat/lng row(s) have a blank place_id - "
                     f"the workbook needs an Excel recalculation (open, let it recalc, save) before this export is trustworthy")
    for _, row in cdf.iterrows():
        pid = row.get("place_id")
        lat = row.get("lat")
        lng = row.get("lng")
        if isinstance(pid, str) and pid.strip() and pd.notna(lat) and pd.notna(lng):
            coords[pid] = (float(lat), float(lng), str(row.get("status") or "set"))
            if pid not in place_ids:
                warns.append(f"Coordinates sheet: place_id '{pid}' not on the places sheet")
except Exception:
    pass


features = []
records = []

for _, p in places.iterrows():
    pid = p.get("place_id")
    if not isinstance(pid, str) or not pid.strip():
        continue
    if str(p.get("shortlist_status", "")).strip() in ("Duplicate", "Declined"):
        continue
    rows = atts[atts["place_id"] == pid]

    evidence = []
    neg_evidence = []
    geom_claims = []
    n_name = 0
    n_type = 0
    att_sy = None    
    att_ey = None

    for _, a in rows.iterrows():
        if "RETRACTED" in str(a.get("transcript_note") or ""):
            continue
        sid = a.get("source_id")
        src = sources.loc[sid] if sid in sources.index else None
        origin = plain_origin(src["source_origin"]) if src is not None else "?"
        title = plain_text(src["title"]) if src is not None else "?"
        atype = str(a.get("attestation_type", ""))
        wsy, wey = years(a.get("when_start"), a.get("when_end"))
        item = {
            "type": atype,
            "name": plain_name(a.get("name_as_recorded", "")),
            "source": title,
            "origin": origin,
            "source_id": str(sid),
            "year": wsy,
        }

        alat = num(a.get("att_lat"))
        alng = num(a.get("att_lng"))
        if alat is not None and alng is not None:
            geom_claims.append({
                "lat": alat,
                "lng": alng,
                "source": title,
                "origin": origin,
                "source_id": str(sid),
                "method": plain_text(a.get("positional_method") or "unstated"),
                "uncertainty_m": num(a.get("positional_uncertainty_m")),
                "confidence": str(a.get("confidence") or ""),
            })

        if atype.startswith("Negative"):
            neg_evidence.append(item)
            continue
        evidence.append(item)

        if wsy is not None and atype != "Name":
            wey = wey if wey is not None else wsy
            att_sy = wsy if att_sy is None else min(att_sy, wsy)
            att_ey = wey if att_ey is None else max(att_ey, wey)
        if atype == "Name":
            n_name += 1
        if atype == "Type":
            n_type += 1

    erasure = str(p.get("erasure_type", ""))
    extant = erasure.startswith("Persists")
    traces = len(evidence)
    n_sources = len({a["source_id"] for a in evidence})
    neg = len(neg_evidence)
    sp = str(p.get("spatial_certainty", "Unknown")).strip()
    sy, ey = years(p.get("start_date"), p.get("end_date"))


    lifespan_absent = []
    if sy is not None and (ey is not None or erasure.startswith("Persists")):
        cutoff = ey if ey is not None else 9999
        lifespan_absent = sorted({e["source_id"] for e in neg_evidence
                                  if e["year"] is not None and sy <= e["year"] <= cutoff})


    spread = 0.0
    discord = False
    for i in range(len(geom_claims)):
        for j in range(i + 1, len(geom_claims)):
            a = geom_claims[i]
            b = geom_claims[j]
            d = metres_between((a["lat"], a["lng"]), (b["lat"], b["lng"]))
            spread = max(spread, d)
            ua = a.get("uncertainty_m") or 250
            ub = b.get("uncertainty_m") or 250
            if d > ua + ub:
                discord = True


    population_type = "" if pd.isna(p.get("population_type", "")) else str(p.get("population_type"))


    rec = {
        "id": pid,
        "name": str(p.get("preferred_name", "")),
        "place_type": str(p.get("place_type", "")),
        "scale": str(p.get("scale", "")),
        "parent": name_by_id.get(str(p.get("parent_id", "")), ""),
        "theme": plain_text(p.get("historical_theme", "")),
        "population_type": population_type,
        "erasure_type": str(p.get("erasure_type", "")),
        "spatial_certainty": sp,
        "render_as": render_as(sp, 2 if discord else 0),
        "uncertainty_radius_m": num(p.get("uncertainty_radius_m")),
        "geometry_claims": geom_claims,
        "claim_spread_m": round(spread) if spread else 0,
        "sources_disagree": discord,
        "date_certainty": str(p.get("date_certainty", "")),
        "start_year": sy, "end_year": ey,
        "attested_start": att_sy, "attested_end": att_ey,
        "traces": traces, "n_sources": n_sources,
        "archival_visibility": visibility(n_sources),
        "name_claims": n_name, "type_claims": n_type,
        "negative_traces": neg, "extant": extant,
        "lifespan_absent": len(lifespan_absent),
        "evidence": evidence, "neg_evidence": neg_evidence,
    }


    if att_sy is not None and sy is not None:
        if att_sy < sy or (ey is not None and att_ey > ey):
            warns.append(f"{pid}: attested {att_sy}-{att_ey} falls outside claimed lifespan {sy}-{ey}")


    card = p.get("card_note")
    if isinstance(card, str) and card.strip():
        rec["note"] = plain_text(card.strip())
    records.append(rec)

   
    lat = None
    lng = None
    cstatus = None
    if pid in coords:
        lat, lng, st = coords[pid]
        cstatus = "surveyed" if "survey" in st.lower() else "placeholder"
    elif geom_claims:
        lat = sum(c["lat"] for c in geom_claims) / len(geom_claims)
        lng = sum(c["lng"] for c in geom_claims) / len(geom_claims)
        cstatus = "from sources"

    if lat is not None:
        f = dict(rec)
        f["coord_status"] = cstatus
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lng, lat]},
            "properties": f,
        })


archives = []
try:
    adf = pd.read_excel(XLSX, sheet_name="Corpus", header=2)   # rows 1-2 are a title note
    adf.columns = [norm(c) for c in adf.columns]

    def s(v):
        return "" if pd.isna(v) else str(v).strip()

    for _, a in adf.iterrows():
        aid = s(a.get("archive_id"))
        if not aid.startswith("ARC"):
            continue
        # 'Registry only' is a future target kept on the Corpus sheet but not searched
        # yet, so it has no business in the web section's list of archives searched
        if s(a.get("in_scope")).startswith("Registry only"):
            continue
        rec = {
            "id": aid,
            "name": plain_text(s(a.get("name"))),
            "repository": plain_text(s(a.get("repository"))),
            "scope": s(a.get("in_scope")),
            "period": plain_text(s(a.get("period_covered"))),
            "formats": plain_text(s(a.get("formats"))),
            "access": plain_text(s(a.get("access"))),
            "digitization": plain_text(s(a.get("digitization"))),
            "affiliation": plain_origin(s(a.get("affiliation"))),
            "holdings": plain_text(s(a.get("holdings_display"))),
            "institution": plain_text(s(a.get("institution"))),
        }
        if not rec["affiliation"] or not rec["holdings"]:
            warns.append(f"Corpus {aid}: missing affiliation/holdings_display - fill it on the Corpus sheet")
        if not rec["institution"]:
            warns.append(f"Corpus {aid}: no institution on the Corpus sheet")
        archives.append(rec)
except Exception as e:
    warns.append(f"Corpus sheet unreadable ({e}) - archives section will be empty")


arc_ids = {a["id"] for a in archives}
src_list = []
for sid, s_row in sources.iterrows():
    if not (isinstance(sid, str) and sid.strip()):
        continue
    aid = s_row.get("archive_id")
    aid = str(aid).strip() if pd.notna(aid) else ""
    if not aid:
        warns.append(f"{sid}: no archive_id on the sources sheet - link it to a Corpus archive (or '-' for none)")
    elif aid != "-" and aid not in arc_ids:
        warns.append(f"{sid}: archive_id '{aid}' not on the Corpus sheet")
    src_list.append({
        "id": str(sid),
        "title": plain_text(s_row.get("title", "")),
        "origin": plain_origin(s_row.get("source_origin", "")),
        "date": plain_text(s_row.get("source_date", "")),
        "medium": str(s_row.get("medium", "")),
        "reliability": str(s_row.get("reliability", "")),
        "archive": "" if aid == "-" else aid,
    })


relations = []
for _, r in rels.iterrows():
    rid = r.get("relation_id")
    if not isinstance(rid, str) or not rid.strip():
        continue
    rsy, rey = years(r.get("when_start"), r.get("when_end"))
    note = plain_text(re.sub(r"\s*\[[^\]]*\]", "", str(r.get("note") or ""))).strip()
    relations.append({
        "id": rid,
        "from": str(r.get("place_id")),
        "type": str(r.get("relation_type", "")),
        "to": str(r.get("related_id")),
        "start": rsy,
        "end": rey,
        "note": note,
    })


meta = {
    "generated": date.today().isoformat(),
    "n_places": len(records),
    "n_located": len(features),
    "n_attestations": int(atts["place_id"].notna().sum()),
    "n_sources": len(src_list),
    "n_relations": len(relations),
    "n_archives": len(archives),
}

os.makedirs("data", exist_ok=True)
json.dump({"type": "FeatureCollection", "features": features},
          open("data/places.geojson", "w"), indent=1)
json.dump(records, open("data/records.json", "w"), indent=1)
json.dump(src_list, open("data/sources.json", "w"), indent=1)
json.dump(relations, open("data/relations.json", "w"), indent=1)
json.dump(archives, open("data/archives.json", "w"), indent=1)
json.dump(meta, open("data/meta.json", "w"), indent=1)

print(f"wrote {len(features)} located features and {len(records)} records")
print(f"  located:   {len(features)}")
print(f"  unlocated: {len(records) - len(features)}")
print(f"  sources: {len(src_list)}   relations: {len(relations)}")
if warns:
    print(f"DATA HEALTH - {len(warns)} issue(s) to look at:")
    for w in warns:
        print("  !", w)
else:
    print("DATA HEALTH - no issues found")
