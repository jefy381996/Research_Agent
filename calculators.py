"""Battery electrode calculators.

Each function returns the formula, the inputs with units, and the result, so
the interface can show how a number was produced rather than only the number.
"""

from __future__ import annotations

import units


def energy_density(voltage_v: float, capacity_mah_g: float) -> dict:
    """Specific energy of an electrode, Wh/kg."""
    _positive(voltage_v=voltage_v, capacity_mah_g=capacity_mah_g)
    return units.gravimetric_energy(voltage_v, capacity_mah_g)


def specific_capacity(current_ma: float, time_h: float, mass_g: float) -> dict:
    """Gravimetric capacity from a galvanostatic discharge, mAh/g."""
    _positive(current_ma=current_ma, time_h=time_h, mass_g=mass_g)
    return {
        "formula": "capacity_mAh_g = current_mA x time_h / mass_g",
        "inputs": {"current_mA": current_ma, "time_h": time_h, "mass_g": mass_g},
        "result": round(current_ma * time_h / mass_g, 4),
        "unit": "mAh/g",
    }


def c_rate(current_ma_g: float, capacity_mah_g: float) -> dict:
    """C-rate from current density and the reference capacity."""
    _positive(current_ma_g=current_ma_g, capacity_mah_g=capacity_mah_g)
    return units.current_to_c_rate(current_ma_g, capacity_mah_g)


def coulombic_efficiency(discharge_mah_g: float, charge_mah_g: float) -> dict:
    """Coulombic efficiency, per cent."""
    _positive(discharge_mah_g=discharge_mah_g, charge_mah_g=charge_mah_g)
    return {
        "formula": "CE_pct = discharge_mAh_g / charge_mAh_g x 100",
        "inputs": {"discharge_mAh_g": discharge_mah_g, "charge_mAh_g": charge_mah_g},
        "result": round(discharge_mah_g / charge_mah_g * 100.0, 4),
        "unit": "%",
    }


def capacity_fade_per_cycle(initial_mah_g: float, final_mah_g: float,
                            cycles: int) -> dict:
    """Mean capacity loss per cycle, per cent of the initial value."""
    _positive(initial_mah_g=initial_mah_g, cycles=cycles)
    if final_mah_g < 0:
        raise ValueError("final_mah_g must not be negative")
    fade = (initial_mah_g - final_mah_g) / initial_mah_g / cycles * 100.0
    return {
        "formula": "fade_pct_per_cycle = (initial - final) / initial / cycles x 100",
        "inputs": {"initial_mAh_g": initial_mah_g, "final_mAh_g": final_mah_g,
                   "cycles": cycles},
        "result": round(fade, 6),
        "unit": "%/cycle",
    }


def capacity_retention(initial_mah_g: float, final_mah_g: float) -> dict:
    """Capacity retention, per cent."""
    _positive(initial_mah_g=initial_mah_g)
    if final_mah_g < 0:
        raise ValueError("final_mah_g must not be negative")
    return {
        "formula": "retention_pct = final_mAh_g / initial_mAh_g x 100",
        "inputs": {"initial_mAh_g": initial_mah_g, "final_mAh_g": final_mah_g},
        "result": round(final_mah_g / initial_mah_g * 100.0, 4),
        "unit": "%",
    }


def cell_to_pack(cell_wh_kg: float, pack_fraction: float = 0.75) -> dict:
    """Pack-level specific energy from cell level and a packing fraction."""
    _positive(cell_wh_kg=cell_wh_kg)
    if not 0 < pack_fraction <= 1:
        raise ValueError("pack_fraction must be in (0, 1]")
    return {
        "formula": "pack_Wh_kg = cell_Wh_kg x pack_fraction",
        "inputs": {"cell_Wh_kg": cell_wh_kg, "pack_fraction": pack_fraction},
        "result": round(cell_wh_kg * pack_fraction, 4),
        "unit": "Wh/kg",
    }


def _positive(**kwargs):
    for name, value in kwargs.items():
        if value is None:
            raise ValueError(f"{name} is required")
        if value <= 0:
            raise ValueError(f"{name} must be positive, got {value}")


REGISTRY = {
    "energy_density": energy_density,
    "specific_capacity": specific_capacity,
    "c_rate": c_rate,
    "coulombic_efficiency": coulombic_efficiency,
    "capacity_fade_per_cycle": capacity_fade_per_cycle,
    "capacity_retention": capacity_retention,
    "cell_to_pack": cell_to_pack,
}
