"""Unit conversions for battery electrode quantities.

Every function returns a dict carrying the formula, the inputs with their
units, and the result, so a caller can show its working. Nothing here guesses:
a conversion that needs a quantity the caller did not supply raises.
"""

from __future__ import annotations

# Gravimetric capacity. 1 mAh/g is numerically identical to 1 Ah/kg.
CAPACITY_TO_MAH_G = {
    "mah/g": 1.0, "mah g-1": 1.0, "mah g−1": 1.0, "mahg-1": 1.0,
    "mah/gm": 1.0, "ma h/g": 1.0, "ma h g-1": 1.0, "ma h g−1": 1.0,
    "ah/kg": 1.0, "ah kg-1": 1.0, "ah kg−1": 1.0,
    "ah/g": 1000.0, "ah g-1": 1000.0, "ah g−1": 1000.0,
    "mah/mg": 1000.0, "mah mg-1": 1000.0,
}

# Gravimetric current density, to mA/g.
CURRENT_TO_MA_G = {
    "ma/g": 1.0, "ma g-1": 1.0, "ma g−1": 1.0, "mag-1": 1.0,
    "a/kg": 1.0, "a kg-1": 1.0, "a kg−1": 1.0,
    "a/g": 1000.0, "a g-1": 1000.0, "a g−1": 1000.0, "ag-1": 1000.0,
    "ma/mg": 1000.0, "ma mg-1": 1000.0,
}

# Areal loading, to mg/cm2.
LOADING_TO_MG_CM2 = {
    "mg/cm2": 1.0, "mg cm-2": 1.0, "mg cm−2": 1.0, "mgcm-2": 1.0,
    "mg/cm²": 1.0, "g/cm2": 1000.0, "g cm-2": 1000.0,
}


def _norm(unit: str) -> str:
    return (unit or "").strip().lower().replace(" ", " ").replace("·", " ")


def capacity_to_mah_g(value: float, unit: str) -> dict:
    """Normalise a gravimetric capacity to mAh/g."""
    key = _norm(unit)
    if key not in CAPACITY_TO_MAH_G:
        raise ValueError(f"unrecognised capacity unit: {unit!r}")
    factor = CAPACITY_TO_MAH_G[key]
    return {
        "formula": "capacity_mAh_g = value x factor",
        "inputs": {"value": value, "unit": unit, "factor": factor},
        "result": round(value * factor, 4),
        "unit": "mAh/g",
    }


def current_to_ma_g(value: float, unit: str) -> dict:
    """Normalise a gravimetric current density to mA/g."""
    key = _norm(unit)
    if key not in CURRENT_TO_MA_G:
        raise ValueError(f"unrecognised current density unit: {unit!r}")
    factor = CURRENT_TO_MA_G[key]
    return {
        "formula": "current_mA_g = value x factor",
        "inputs": {"value": value, "unit": unit, "factor": factor},
        "result": round(value * factor, 4),
        "unit": "mA/g",
    }


def loading_to_mg_cm2(value: float, unit: str) -> dict:
    key = _norm(unit)
    if key not in LOADING_TO_MG_CM2:
        raise ValueError(f"unrecognised areal loading unit: {unit!r}")
    factor = LOADING_TO_MG_CM2[key]
    return {
        "formula": "loading_mg_cm2 = value x factor",
        "inputs": {"value": value, "unit": unit, "factor": factor},
        "result": round(value * factor, 4),
        "unit": "mg/cm2",
    }


def c_rate_to_current(c_rate: float, capacity_mah_g: float) -> dict:
    """C-rate to gravimetric current density, given the capacity it refers to."""
    if capacity_mah_g <= 0:
        raise ValueError("capacity must be positive")
    return {
        "formula": "current_mA_g = C_rate x capacity_mAh_g",
        "inputs": {"C_rate": c_rate, "capacity_mAh_g": capacity_mah_g},
        "result": round(c_rate * capacity_mah_g, 4),
        "unit": "mA/g",
    }


def current_to_c_rate(current_ma_g: float, capacity_mah_g: float) -> dict:
    """Gravimetric current density to C-rate, given the reference capacity."""
    if capacity_mah_g <= 0:
        raise ValueError("capacity must be positive")
    return {
        "formula": "C_rate = current_mA_g / capacity_mAh_g",
        "inputs": {"current_mA_g": current_ma_g, "capacity_mAh_g": capacity_mah_g},
        "result": round(current_ma_g / capacity_mah_g, 4),
        "unit": "C",
    }


def gravimetric_energy(voltage_v: float, capacity_mah_g: float) -> dict:
    """Specific energy in Wh/kg from average voltage and gravimetric capacity."""
    return {
        "formula": "energy_Wh_kg = voltage_V x capacity_mAh_g / 1000",
        "inputs": {"voltage_V": voltage_v, "capacity_mAh_g": capacity_mah_g},
        "result": round(voltage_v * capacity_mah_g / 1000.0, 4),
        "unit": "Wh/kg",
    }


def volumetric_energy(energy_wh_kg: float, density_g_cm3: float) -> dict:
    """Wh/L from Wh/kg and electrode density. Needs a density; will not assume one."""
    if density_g_cm3 <= 0:
        raise ValueError("density must be positive")
    return {
        "formula": "energy_Wh_L = energy_Wh_kg x density_g_cm3",
        "inputs": {"energy_Wh_kg": energy_wh_kg, "density_g_cm3": density_g_cm3},
        "result": round(energy_wh_kg * density_g_cm3, 4),
        "unit": "Wh/L",
    }


ALL_CAPACITY_UNITS = sorted(CAPACITY_TO_MAH_G)
ALL_CURRENT_UNITS = sorted(CURRENT_TO_MA_G)
