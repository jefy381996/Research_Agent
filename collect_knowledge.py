#!/usr/bin/env python3
"""Collect reference knowledge: concepts from Wikipedia, compounds from PubChem.

The measurement library answers "how much". It could not answer "what is
graphene", because a corpus of research abstracts assumes its fundamentals.
This fills that gap from two open sources that can be checked by the reader:

  * Wikipedia  - encyclopedic definitions, CC BY-SA 4.0, every entry stored
                 with its canonical URL so the claim can be followed.
  * PubChem    - chemical identity and properties, public domain, from the
                 US National Library of Medicine.

Neither needs a key. Both are rate limited from a shared address, so requests
are paced and retried. A topic that fails is skipped and counted; one failure
never stops the run. Re-running updates in place rather than duplicating.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.parse
from collections import Counter
from datetime import datetime, timezone

import requests

import db

WIKI = "https://en.wikipedia.org/api/rest_v1/page/summary/"
PUBCHEM = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/"
UA = ("GrapheneBatteryResearchAgent/1.0 (research tool; "
      "+https://github.com/jefy381996/Research_Agent)")
PACE = 1.1          # seconds between requests, to stay inside the shared limit
MAX_RETRY = 4

TOPICS = {
    "Graphene and carbon materials": [
        "Graphene", "Graphite", "Graphene oxide", "Carbon nanotube", "Fullerene",
        "Carbon", "Allotropes of carbon", "Hard carbon", "Activated carbon",
        "Carbon black", "Graphene nanoribbon", "Bilayer graphene",
        "Graphene quantum dot", "Graphane", "Graphyne", "Carbon fiber",
        "Diamond", "Carbon nanofoam", "Carbide-derived carbon", "Graphene foam",
        "Two-dimensional materials", "MXenes", "Hexagonal boron nitride",
        "Molybdenum disulfide", "Van der Waals heterostructure", "Nanomaterials",
        "Nanocomposite", "Aerogel",
    ],
    "Properties and physics": [
        "Thermal conductivity", "Electrical resistivity and conductivity",
        "Young's modulus", "Ultimate tensile strength", "Specific surface area",
        "BET theory", "Electron mobility", "Quantum Hall effect",
        "Ballistic conduction", "Band gap", "Work function", "Dirac equation",
        "Phonon", "Density of states", "Percolation threshold",
        "Specific heat capacity", "Diffusion", "Fick's laws of diffusion",
        "Arrhenius equation", "Activation energy", "Ohm's law",
    ],
    "Making and processing": [
        "Chemical vapor deposition", "Exfoliation joint", "Hummers' method",
        "Epitaxy", "Ball mill", "Spin coating", "Electrospinning",
        "Hydrothermal synthesis", "Sol–gel process", "Pyrolysis",
        "Annealing (materials science)", "Sputter deposition",
        "Atomic layer deposition", "Roll-to-roll processing", "Freeze-drying",
        "Calcination", "Doping (semiconductor)", "Spray pyrolysis",
    ],
    "Battery fundamentals": [
        "Electric battery", "Lithium-ion battery", "Anode", "Cathode",
        "Electrode", "Electrolyte", "Separator (electricity)",
        "Current collector", "Electrochemical cell", "Galvanic cell",
        "Half-cell", "Electrochemistry", "Redox",
        "Faraday's laws of electrolysis", "Nernst equation",
        "Standard electrode potential", "State of charge", "Depth of discharge",
        "Open-circuit voltage", "Internal resistance", "Energy density",
        "Specific energy", "Power density", "Rechargeable battery",
        "Battery pack", "Battery management system", "Electric vehicle battery",
    ],
    "Battery chemistries": [
        "Lithium iron phosphate battery", "Lithium cobalt oxide",
        "Lithium nickel manganese cobalt oxides", "Lithium titanate",
        "Lithium–sulfur battery", "Sodium-ion battery", "Potassium-ion battery",
        "Zinc-ion battery", "Magnesium battery", "Aluminium-ion battery",
        "Lithium–air battery", "Solid-state battery", "Flow battery",
        "Supercapacitor", "Lead–acid battery", "Nickel–metal hydride battery",
        "Lithium polymer battery", "Sodium–sulfur battery",
        "Lithium vanadium phosphate battery",
    ],
    "Electrode materials": [
        "Silicon", "Tin", "Lithium", "Sulfur", "Selenium", "Titanium dioxide",
        "Iron(III) oxide", "Iron(II,III) oxide", "Cobalt(II,III) oxide",
        "Manganese dioxide", "Vanadium(V) oxide", "Niobium pentoxide",
        "Tin dioxide", "Antimony", "Bismuth", "Germanium", "Black phosphorus",
        "Nickel(II) oxide", "Copper(II) oxide", "Zinc oxide", "Prussian blue",
        "Lithium iron phosphate", "Silicon dioxide",
    ],
    "Electrolytes and interfaces": [
        "Solid electrolyte interphase", "Lithium hexafluorophosphate",
        "Ethylene carbonate", "Dimethyl carbonate", "Diethyl carbonate",
        "Propylene carbonate", "Ionic liquid", "Fast ion conductor",
        "Polymer electrolyte", "NASICON", "Dendrite (crystal)",
        "Double layer (surface science)", "Pseudocapacitance",
        "Intercalation (chemistry)", "Overpotential", "Butler–Volmer equation",
        "Passivation (chemistry)",
    ],
    "Degradation and safety": [
        "Thermal runaway", "Battery recycling", "Short circuit", "Corrosion",
        "Fatigue (material)", "Creep (deformation)", "Self-discharge",
        "Memory effect",
    ],
    "Measuring and characterisation": [
        "X-ray crystallography", "Raman spectroscopy",
        "Scanning electron microscope", "Transmission electron microscopy",
        "X-ray photoelectron spectroscopy", "Atomic force microscopy",
        "Cyclic voltammetry", "Dielectric spectroscopy",
        "Thermogravimetric analysis", "Four-terminal sensing",
        "Energy-dispersive X-ray spectroscopy", "Powder diffraction",
        "Nuclear magnetic resonance spectroscopy", "Ultraviolet–visible spectroscopy",
    ],
}

COMPOUNDS = [
    "lithium hexafluorophosphate", "lithium bis(trifluoromethanesulfonyl)imide",
    "lithium perchlorate", "lithium tetrafluoroborate", "sodium perchlorate",
    "sodium hexafluorophosphate", "ethylene carbonate", "dimethyl carbonate",
    "diethyl carbonate", "propylene carbonate", "ethyl methyl carbonate",
    "1,3-dioxolane", "1,2-dimethoxyethane", "fluoroethylene carbonate",
    "vinylene carbonate", "lithium iron phosphate", "lithium cobalt oxide",
    "lithium titanate", "lithium sulfide", "sulfur", "silicon", "graphite",
    "tin dioxide", "titanium dioxide", "manganese dioxide",
    "iron(III) oxide", "cobalt(II,III) oxide", "molybdenum disulfide",
    "vanadium pentoxide", "zinc sulfate", "potassium hydroxide",
    "sulfuric acid", "N-methyl-2-pyrrolidone", "polyvinylidene fluoride",
    "carboxymethyl cellulose", "styrene-butadiene rubber", "sodium alginate",
    "lithium nitrate", "zinc oxide", "nickel(II) oxide",
]

PROPS = ("MolecularFormula,MolecularWeight,CanonicalSMILES,IUPACName,"
         "XLogP,ExactMass,Charge")


def get(session, url, params=None):
    """One request, paced and retried. Returns the response or None."""
    for attempt in range(1, MAX_RETRY + 1):
        try:
            r = session.get(url, params=params, timeout=40)
        except requests.RequestException:
            time.sleep(PACE * attempt)
            continue
        if r.status_code == 200:
            return r
        if r.status_code == 404:
            return None
        if r.status_code in (429, 503):
            wait = float(r.headers.get("Retry-After") or (PACE * 3 * attempt))
            time.sleep(min(wait, 30))
            continue
        return None
    return None


def collect_concepts(conn, session, only=None):
    added = updated = 0
    failures = Counter()
    existing = {r[0] for r in conn.execute("SELECT slug FROM concepts")}
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    for category, titles in TOPICS.items():
        if only and category not in only:
            continue
        for title in titles:
            slug = urllib.parse.quote(title.replace(" ", "_"), safe="")
            r = get(session, WIKI + slug)
            time.sleep(PACE)
            if r is None:
                failures[title] = 1
                print(f"  miss  {title}", flush=True)
                continue
            try:
                d = r.json()
            except ValueError:
                failures[title] = 1
                continue
            if d.get("type") == "disambiguation" or not d.get("extract"):
                failures[title] = 1
                continue
            key = d.get("titles", {}).get("canonical") or slug
            row = {
                "slug": key,
                "title": d.get("title") or title,
                "category": category,
                "summary": d.get("extract") or "",
                "description": d.get("description") or "",
                "url": (d.get("content_urls", {}).get("desktop", {}).get("page")
                        or f"https://en.wikipedia.org/wiki/{slug}"),
                "source": "wikipedia",
                "licence": "CC BY-SA 4.0",
                "fetched_at": now,
            }
            conn.execute(
                "INSERT INTO concepts(slug,title,category,summary,description,"
                "url,source,licence,fetched_at) VALUES(?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(slug) DO UPDATE SET title=excluded.title,"
                " category=excluded.category, summary=excluded.summary,"
                " description=excluded.description, url=excluded.url,"
                " fetched_at=excluded.fetched_at",
                [row[k] for k in ("slug", "title", "category", "summary",
                                  "description", "url", "source", "licence",
                                  "fetched_at")])
            if key in existing:
                updated += 1
            else:
                added += 1
                existing.add(key)
            conn.commit()          # per topic: a long transaction locks the
            print(f"  ok    {row['title']}", flush=True)   # database for everyone else
    return added, updated, failures


def collect_compounds(conn, session):
    added = 0
    failures = Counter()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for name in COMPOUNDS:
        url = PUBCHEM + urllib.parse.quote(name) + f"/property/{PROPS}/JSON"
        r = get(session, url)
        time.sleep(0.4)
        if r is None:
            failures[name] = 1
            print(f"  miss  {name}", flush=True)
            continue
        try:
            props = r.json()["PropertyTable"]["Properties"][0]
        except (ValueError, KeyError, IndexError):
            failures[name] = 1
            continue
        cid = props.get("CID")
        conn.execute(
            "INSERT INTO compounds(cid,name,formula,molecular_weight,smiles,"
            "iupac_name,exact_mass,charge,url,source,licence,fetched_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(cid) DO UPDATE SET name=excluded.name,"
            " formula=excluded.formula, molecular_weight=excluded.molecular_weight,"
            " smiles=excluded.smiles, iupac_name=excluded.iupac_name,"
            " fetched_at=excluded.fetched_at",
            (cid, name, props.get("MolecularFormula"),
             props.get("MolecularWeight"), props.get("CanonicalSMILES"),
             props.get("IUPACName"), props.get("ExactMass"), props.get("Charge"),
             f"https://pubchem.ncbi.nlm.nih.gov/compound/{cid}",
             "pubchem", "public domain", now))
        conn.commit()
        added += 1
        print(f"  ok    {name}  {props.get('MolecularFormula')}", flush=True)
    return added, failures


def main():
    ap = argparse.ArgumentParser(description="Collect reference knowledge.")
    ap.add_argument("--db", default=None)
    ap.add_argument("--concepts-only", action="store_true")
    ap.add_argument("--compounds-only", action="store_true")
    args = ap.parse_args()

    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    conn = db.init(args.db)
    session = requests.Session()
    session.headers.update({"User-Agent": UA, "Accept": "application/json"})

    c_add = c_upd = p_add = 0
    c_fail = p_fail = Counter()
    if not args.compounds_only:
        print(f"Concepts: {sum(len(v) for v in TOPICS.values())} topics")
        c_add, c_upd, c_fail = collect_concepts(conn, session)
    if not args.concepts_only:
        print(f"\nCompounds: {len(COMPOUNDS)} names")
        p_add, p_fail = collect_compounds(conn, session)

    finished = datetime.now(timezone.utc).isoformat(timespec="seconds")
    db.log_run(conn, "collect_knowledge", started, finished, c_add + p_add, c_upd,
               [{"topic": t} for t in list(c_fail) + list(p_fail)][:200])

    total_c = conn.execute("SELECT count(*) FROM concepts").fetchone()[0]
    total_p = conn.execute("SELECT count(*) FROM compounds").fetchone()[0]
    print(f"\nConcepts added {c_add}, updated {c_upd}, missed {len(c_fail)}")
    print(f"Compounds stored {p_add}, missed {len(p_fail)}")
    print(f"Totals: {total_c} concepts, {total_p} compounds")
    if c_fail:
        print("Missed topics: " + ", ".join(list(c_fail)[:25]))
    conn.close()


if __name__ == "__main__":
    main()
