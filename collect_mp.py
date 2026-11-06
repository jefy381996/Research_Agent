#!/usr/bin/env python3
"""Pull Materials Project electrode data for carbon and graphite entries.

Needs MP_API_KEY and network access to the Materials Project. Without either,
the script says so and exits cleanly: the rest of the product does not depend
on this table, and the calculator simply shows no reference comparison.
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone

import requests

import db

ENDPOINT = "https://api.materialsproject.org/materials/insertion_electrodes/"
FORMULAE = ["C", "LiC6", "LiFePO4", "Li4Ti5O12", "Si", "Li15Si4", "S", "Na"]


def load_env(path=".env"):
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                os.environ.setdefault(key.strip(), value.strip())


def main():
    parser = argparse.ArgumentParser(description="Load Materials Project references.")
    parser.add_argument("--db", default=None)
    args = parser.parse_args()

    load_env()
    key = os.environ.get("MP_API_KEY", "").strip()
    if not key:
        print("MP_API_KEY is not set, so no Materials Project data was loaded.")
        print("This table is optional: the calculator omits its reference column.")
        return 0

    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    conn = db.init(args.db)
    session = requests.Session()
    session.headers.update({"X-API-KEY": key, "Accept": "application/json"})

    added, errors = 0, []
    for formula in FORMULAE:
        try:
            response = session.get(
                ENDPOINT, timeout=45,
                params={"formula": formula, "_limit": 40,
                        "_fields": ("battery_id,battery_formula,working_ion,"
                                    "average_voltage,capacity_grav,capacity_vol,"
                                    "energy_grav,max_delta_volume")})
            response.raise_for_status()
            for item in response.json().get("data", []):
                conn.execute(
                    "INSERT INTO mp_reference(material_id, formula, working_ion,"
                    " average_voltage, gravimetric_capacity, volumetric_capacity,"
                    " energy_density, max_volume_change, source)"
                    " VALUES(?,?,?,?,?,?,?,?,?)"
                    " ON CONFLICT(material_id) DO UPDATE SET"
                    " formula=excluded.formula, working_ion=excluded.working_ion,"
                    " average_voltage=excluded.average_voltage,"
                    " gravimetric_capacity=excluded.gravimetric_capacity,"
                    " volumetric_capacity=excluded.volumetric_capacity,"
                    " energy_density=excluded.energy_density,"
                    " max_volume_change=excluded.max_volume_change",
                    (item.get("battery_id"), item.get("battery_formula"),
                     item.get("working_ion"), item.get("average_voltage"),
                     item.get("capacity_grav"), item.get("capacity_vol"),
                     item.get("energy_grav"), item.get("max_delta_volume"),
                     "materials-project"))
                added += 1
            conn.commit()
            print(f"  {formula}: loaded")
        except Exception as exc:          # one formula never stops the run
            errors.append({"formula": formula, "reason": f"{type(exc).__name__}: {exc}"})
            print(f"  {formula}: failed, {type(exc).__name__}")

    finished = datetime.now(timezone.utc).isoformat(timespec="seconds")
    db.log_run(conn, "collect_mp", started, finished, added, 0, errors)
    total = conn.execute("SELECT count(*) FROM mp_reference").fetchone()[0]
    print(f"\nReference rows written : {added}")
    print(f"Total in mp_reference  : {total}")
    if errors:
        print(f"Formulae that failed   : {len(errors)}")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
