"""Physical plausibility, consistency, outlier and unit-sanity checks.

These checks flag rows. They never delete one, and they never change a stored
value. What they cannot do is stated plainly in the product: they cannot tell
whether a plausible number was measured under the conditions a row claims,
they cannot catch a paper that is itself wrong, and they cannot judge whether
a comparison is scientifically fair.
"""

from __future__ import annotations

import statistics
from collections import defaultdict

# Theoretical gravimetric capacities, mAh/g, for reference and unit sanity.
THEORETICAL = {
    "graphite": 372.0,
    "silicon": 4200.0,
    "lithium metal": 3860.0,
    "sulfur": 1675.0,
    "sodium metal": 1166.0,
    "tin": 994.0,
    "LFP": 170.0,
    "NMC": 280.0,
    "LCO": 274.0,
}

CAPACITY_HARD_MAX = 5000.0      # above this, almost certainly a unit error
CAPACITY_HARD_MIN = 1.0
CYCLE_HARD_MAX = 100_000
RETENTION_HARD_MAX = 100.0
CE_HARD_MAX = 100.0
TEMP_MIN, TEMP_MAX = -40.0, 200.0
VOLTAGE_MIN, VOLTAGE_MAX = 0.0, 5.0
# A plain standard deviation is masked by the very values this check exists to
# find: one 90,000 mAh/g entry inflates sigma so far that it no longer sits
# three sigma from its own group. The median absolute deviation is not moved by
# the outlier, so the check works on the cases that matter. 3.5 on the modified
# z-score is the conventional equivalent of 3 sigma.
OUTLIER_SIGMA = 3.5
OUTLIER_MIN_GROUP = 5
MAD_SCALE = 0.6745


def check_bounds(row: dict) -> list[str]:
    """Check B: hard physical limits."""
    flags = []
    cap = _num(row.get("specific_capacity_mah_g"))
    if cap is not None:
        if cap > CAPACITY_HARD_MAX:
            # Lithium-air cathodes are conventionally reported per gram of
            # carbon and legitimately exceed this bound, so the reason says so
            # rather than asserting an error the chemistry does not support.
            if (row.get("battery_type") or "") == "lithium-air":
                flags.append(
                    f"capacity_above_{CAPACITY_HARD_MAX:.0f}_mah_g: {cap:g}. "
                    "Lithium-air cathode capacities are normally quoted per gram "
                    "of carbon, not per gram of electrode, so this may be correct "
                    "by that convention and is not comparable with the rest")
            else:
                flags.append(
                    f"capacity_above_{CAPACITY_HARD_MAX:.0f}_mah_g: {cap:g} exceeds "
                    "any known electrode; likely an F/g supercapacitor value or a "
                    "unit error")
        elif cap < CAPACITY_HARD_MIN:
            flags.append(f"capacity_implausibly_low: {cap:g} mAh/g")

    ret = _num(row.get("capacity_retention_pct"))
    if ret is not None and ret > RETENTION_HARD_MAX:
        flags.append(f"retention_above_100pct: {ret:g}%")

    cyc = _num(row.get("cycle_count"))
    if cyc is not None and cyc > CYCLE_HARD_MAX:
        flags.append(f"cycle_count_above_{CYCLE_HARD_MAX}: {cyc:g}")

    temp = _num(row.get("temperature_c"))
    if temp is not None and not (TEMP_MIN <= temp <= TEMP_MAX):
        flags.append(f"temperature_outside_{TEMP_MIN:g}_to_{TEMP_MAX:g}C: {temp:g}")

    ce = _num(row.get("first_cycle_ce_pct"))
    if ce is not None and ce > CE_HARD_MAX:
        flags.append(f"first_cycle_ce_above_100pct: {ce:g}%")

    lo, hi = _voltage_window(row.get("voltage_window_v"))
    if lo is not None and hi is not None:
        if lo < VOLTAGE_MIN or hi > VOLTAGE_MAX:
            flags.append(
                f"voltage_window_outside_{VOLTAGE_MIN:g}_to_{VOLTAGE_MAX:g}V: "
                f"{lo:g}-{hi:g}")
        if lo >= hi:
            flags.append(f"voltage_window_inverted: {lo:g}-{hi:g}")
    return flags


def check_consistency(row: dict) -> list[str]:
    """Check C: where start, end and retention are all present, check the sum."""
    flags = []
    start = _num(row.get("initial_capacity_mah_g"))
    end = _num(row.get("specific_capacity_mah_g"))
    ret = _num(row.get("capacity_retention_pct"))
    if None in (start, end, ret) or start <= 0:
        return flags
    implied = end / start * 100.0
    if abs(implied - ret) > 5.0:
        flags.append(
            f"retention_arithmetic_mismatch: stated {ret:g}% but "
            f"{end:g}/{start:g} implies {implied:.1f}%")
    return flags


def check_unit_sanity(row: dict) -> list[str]:
    """Check E: magnitudes that suggest a unit mix-up."""
    flags = []
    cap = _num(row.get("specific_capacity_mah_g"))
    reported = (row.get("capacity_as_reported") or "").lower()
    if cap is not None:
        if "f/g" in reported or "f g" in reported:
            flags.append("unit_mixup_farads_read_as_capacity: source reports F/g")
        if 5000 < cap <= 20000:
            flags.append(
                f"magnitude_suggests_unit_error: {cap:g} mAh/g is in the range "
                "typical of F/g capacitance values")
    cur = _num(row.get("current_density_ma_g"))
    if cur is not None and cur > 100_000:
        flags.append(f"current_density_implausible: {cur:g} mA/g")
    return flags


def check_outliers(rows: list[dict]) -> dict[int, list[str]]:
    """Check D: values more than three sigma from their material-system group.

    Only groups with five or more entries are considered.
    """
    groups = defaultdict(list)
    for idx, row in enumerate(rows):
        cap = _num(row.get("specific_capacity_mah_g"))
        key = (row.get("material_system") or "").strip().lower()
        if cap is not None and key:
            groups[key].append((idx, cap))

    out = defaultdict(list)
    for key, members in groups.items():
        if len(members) < OUTLIER_MIN_GROUP:
            continue
        values = [v for _, v in members]
        centre = statistics.median(values)
        deviations = [abs(v - centre) for v in values]
        mad = statistics.median(deviations)
        if mad > 0:
            scale, label = mad / MAD_SCALE, "robust sigma"
        else:
            # Every value identical but for the outlier: fall back to spread.
            try:
                scale = statistics.stdev(values)
            except statistics.StatisticsError:
                continue
            label = "sigma"
            if scale == 0:
                continue
        for idx, value in members:
            score = abs(value - centre) / scale
            if score > OUTLIER_SIGMA:
                out[idx].append(
                    f"group_outlier: {value:g} mAh/g is {score:.1f} {label} from "
                    f"the {key!r} median of {centre:.0f} (n={len(values)})")
    return out


def assess(rows: list[dict]) -> list[dict]:
    """Run every check. Sets `confidence` and fills `flags` in place."""
    outliers = check_outliers(rows)
    for idx, row in enumerate(rows):
        flags = list(row.get("flags") or [])      # keep the extractor's notes
        flags += check_bounds(row)
        flags += check_consistency(row)
        flags += check_unit_sanity(row)
        flags += outliers.get(idx, [])
        row["flags"] = flags
        if row.get("confidence") == "unverified":
            pass                       # text verification already failed
        elif flags:
            row["confidence"] = "flagged"
        else:
            row["confidence"] = "verified"
    return rows


def _num(value):
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _voltage_window(text):
    if not text:
        return None, None
    cleaned = str(text).replace("–", "-").replace("—", "-").replace("~", "")
    parts = [p for p in cleaned.replace("V", "").split("-") if p.strip()]
    if len(parts) != 2:
        return None, None
    try:
        return float(parts[0]), float(parts[1])
    except ValueError:
        return None, None
