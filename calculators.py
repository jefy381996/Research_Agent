"""Battery and materials calculators, basic through advanced.

Every function returns the formula, the inputs with units, and the result, so
the interface can show how a number was produced rather than only the number.
Each entry carries a short note saying what the result means and where the
formula comes from, because a calculator a researcher cannot audit is useless
to them.

Nothing here guesses. A calculation that needs a quantity the caller did not
supply raises rather than assuming a default, except where a default is a
stated convention (the Scherrer shape factor, a packing fraction).
"""

from __future__ import annotations

import math

import units

# Physical constants (CODATA).
F = 96485.332          # Faraday constant, C/mol
R = 8.314462           # gas constant, J/(mol K)
T0 = 298.15            # standard temperature, K


def _pos(**kw):
    for name, value in kw.items():
        if value is None:
            raise ValueError(f"{name.replace('_', ' ')} is required")
        if value <= 0:
            raise ValueError(f"{name.replace('_', ' ')} must be positive, got {value}")


def _out(formula, inputs, result, unit, note=""):
    return {"formula": formula, "inputs": inputs, "result": round(result, 6),
            "unit": unit, "note": note}


# ── capacity and charge ─────────────────────────────────────────────────────

def theoretical_capacity(electrons: float, molar_mass_g_mol: float) -> dict:
    """Theoretical gravimetric capacity of a material, from Faraday's law."""
    _pos(electrons=electrons, molar_mass_g_mol=molar_mass_g_mol)
    value = electrons * F / (3.6 * molar_mass_g_mol)
    return _out("capacity (mAh/g) = n x F / (3.6 x M)",
                {"electrons n": electrons, "molar mass M (g/mol)": molar_mass_g_mol,
                 "Faraday constant F (C/mol)": F},
                value, "mAh/g",
                "The ceiling for a material, assuming every electron is used. "
                "Graphite as LiC6 (n=1, M=72.06) gives 372 mAh/g.")


def specific_capacity(current_ma: float, time_h: float, mass_g: float) -> dict:
    """Gravimetric capacity measured from a galvanostatic discharge."""
    _pos(current_ma=current_ma, time_h=time_h, mass_g=mass_g)
    return _out("capacity (mAh/g) = current (mA) x time (h) / mass (g)",
                {"current (mA)": current_ma, "time (h)": time_h, "mass (g)": mass_g},
                current_ma * time_h / mass_g, "mAh/g",
                "Use the active material mass, not the electrode mass.")


def areal_capacity(capacity_mah_g: float, loading_mg_cm2: float) -> dict:
    """Capacity per unit electrode area."""
    _pos(capacity_mah_g=capacity_mah_g, loading_mg_cm2=loading_mg_cm2)
    return _out("areal capacity (mAh/cm2) = capacity (mAh/g) x loading (mg/cm2) / 1000",
                {"capacity (mAh/g)": capacity_mah_g, "loading (mg/cm2)": loading_mg_cm2},
                capacity_mah_g * loading_mg_cm2 / 1000.0, "mAh/cm2",
                "A commercial cell needs roughly 3-4 mAh/cm2. Lab papers often "
                "report high gravimetric capacity at loadings ten times lower.")


def volumetric_capacity(capacity_mah_g: float, density_g_cm3: float) -> dict:
    """Capacity per unit electrode volume."""
    _pos(capacity_mah_g=capacity_mah_g, density_g_cm3=density_g_cm3)
    return _out("volumetric capacity (mAh/cm3) = capacity (mAh/g) x density (g/cm3)",
                {"capacity (mAh/g)": capacity_mah_g, "density (g/cm3)": density_g_cm3},
                capacity_mah_g * density_g_cm3, "mAh/cm3",
                "Graphene electrodes are often porous, so a high gravimetric "
                "capacity can still give a poor volumetric one.")


def capacity_retention(initial_mah_g: float, final_mah_g: float) -> dict:
    """How much capacity is left after cycling."""
    _pos(initial_mah_g=initial_mah_g)
    if final_mah_g < 0:
        raise ValueError("final capacity must not be negative")
    return _out("retention (%) = final / initial x 100",
                {"initial (mAh/g)": initial_mah_g, "final (mAh/g)": final_mah_g},
                final_mah_g / initial_mah_g * 100.0, "%",
                "Always quote the cycle number and the rate alongside it.")


def capacity_fade_per_cycle(initial_mah_g: float, final_mah_g: float,
                            cycles: float) -> dict:
    """Average capacity loss per cycle, as a percentage of the start."""
    _pos(initial_mah_g=initial_mah_g, cycles=cycles)
    if final_mah_g < 0:
        raise ValueError("final capacity must not be negative")
    return _out("fade (%/cycle) = (initial - final) / initial / cycles x 100",
                {"initial (mAh/g)": initial_mah_g, "final (mAh/g)": final_mah_g,
                 "cycles": cycles},
                (initial_mah_g - final_mah_g) / initial_mah_g / cycles * 100.0,
                "%/cycle",
                "Below about 0.01 %/cycle is needed for a thousand-cycle life.")


def cycles_to_threshold(initial_mah_g: float, fade_pct_per_cycle: float,
                        threshold_pct: float = 80.0) -> dict:
    """How many cycles until capacity reaches a threshold, at a constant fade."""
    _pos(initial_mah_g=initial_mah_g, fade_pct_per_cycle=fade_pct_per_cycle,
         threshold_pct=threshold_pct)
    if threshold_pct >= 100:
        raise ValueError("threshold must be below 100 %")
    return _out("cycles = (100 - threshold) / fade per cycle",
                {"threshold (%)": threshold_pct,
                 "fade (%/cycle)": fade_pct_per_cycle},
                (100.0 - threshold_pct) / fade_pct_per_cycle, "cycles",
                "Assumes linear fade, which real cells rarely follow late in life.")


def coulombic_efficiency(discharge_mah_g: float, charge_mah_g: float) -> dict:
    """Charge returned against charge put in, for one cycle."""
    _pos(discharge_mah_g=discharge_mah_g, charge_mah_g=charge_mah_g)
    return _out("efficiency (%) = discharge / charge x 100",
                {"discharge (mAh/g)": discharge_mah_g, "charge (mAh/g)": charge_mah_g},
                discharge_mah_g / charge_mah_g * 100.0, "%",
                "A thousand cycles at 99.9 % still loses a third of the capacity.")


# ── rate and current ────────────────────────────────────────────────────────

def c_rate(current_ma_g: float, capacity_mah_g: float) -> dict:
    """C-rate from a gravimetric current density."""
    _pos(current_ma_g=current_ma_g, capacity_mah_g=capacity_mah_g)
    return units.current_to_c_rate(current_ma_g, capacity_mah_g) | {
        "note": "1C means the full capacity in one hour."}


def current_from_c_rate(c_rate_value: float, capacity_mah_g: float) -> dict:
    """Current density needed for a given C-rate."""
    _pos(c_rate_value=c_rate_value, capacity_mah_g=capacity_mah_g)
    return units.c_rate_to_current(c_rate_value, capacity_mah_g) | {
        "note": "Quote the capacity the rate refers to; papers often do not."}


def discharge_time(c_rate_value: float) -> dict:
    """How long a full discharge takes at a given C-rate."""
    _pos(c_rate_value=c_rate_value)
    return _out("time (h) = 1 / C-rate", {"C-rate": c_rate_value},
                1.0 / c_rate_value, "h",
                "Ideal case. Real cells deliver less than full capacity at high rate.")


def areal_current_density(current_ma_g: float, loading_mg_cm2: float) -> dict:
    """Current per unit area, from a gravimetric current and a loading."""
    _pos(current_ma_g=current_ma_g, loading_mg_cm2=loading_mg_cm2)
    return _out("areal current (mA/cm2) = current (mA/g) x loading (mg/cm2) / 1000",
                {"current (mA/g)": current_ma_g, "loading (mg/cm2)": loading_mg_cm2},
                current_ma_g * loading_mg_cm2 / 1000.0, "mA/cm2",
                "The number that governs polarisation and plating risk.")


# ── energy and power ────────────────────────────────────────────────────────

def energy_density(voltage_v: float, capacity_mah_g: float) -> dict:
    """Specific energy of an electrode."""
    _pos(voltage_v=voltage_v, capacity_mah_g=capacity_mah_g)
    return units.gravimetric_energy(voltage_v, capacity_mah_g) | {
        "note": "Electrode level. A full cell is roughly a third of this once "
                "the counter electrode, electrolyte and casing are included."}


def volumetric_energy_density(voltage_v: float, capacity_mah_g: float,
                              density_g_cm3: float) -> dict:
    """Energy per unit volume."""
    _pos(voltage_v=voltage_v, capacity_mah_g=capacity_mah_g, density_g_cm3=density_g_cm3)
    return _out("energy (Wh/L) = voltage (V) x capacity (mAh/g) x density (g/cm3)",
                {"voltage (V)": voltage_v, "capacity (mAh/g)": capacity_mah_g,
                 "density (g/cm3)": density_g_cm3},
                voltage_v * capacity_mah_g * density_g_cm3, "Wh/L",
                "The limit that matters for vehicles and phones, not Wh/kg.")


def specific_power(energy_wh_kg: float, c_rate_value: float) -> dict:
    """Power per unit mass at a given rate."""
    _pos(energy_wh_kg=energy_wh_kg, c_rate_value=c_rate_value)
    return _out("power (W/kg) = energy (Wh/kg) x C-rate",
                {"energy (Wh/kg)": energy_wh_kg, "C-rate": c_rate_value},
                energy_wh_kg * c_rate_value, "W/kg",
                "Energy and power trade against each other in the same cell.")


def energy_efficiency(discharge_energy_wh: float, charge_energy_wh: float) -> dict:
    """Round-trip energy efficiency, which includes voltage losses."""
    _pos(discharge_energy_wh=discharge_energy_wh, charge_energy_wh=charge_energy_wh)
    return _out("efficiency (%) = discharge energy / charge energy x 100",
                {"discharge (Wh)": discharge_energy_wh, "charge (Wh)": charge_energy_wh},
                discharge_energy_wh / charge_energy_wh * 100.0, "%",
                "Always lower than coulombic efficiency, because of the voltage gap.")


def cell_to_pack(cell_wh_kg: float, pack_fraction: float = 0.75) -> dict:
    """Pack-level specific energy from cell level."""
    _pos(cell_wh_kg=cell_wh_kg)
    if not 0 < pack_fraction <= 1:
        raise ValueError("packing fraction must be between 0 and 1")
    return _out("pack (Wh/kg) = cell (Wh/kg) x packing fraction",
                {"cell (Wh/kg)": cell_wh_kg, "packing fraction": pack_fraction},
                cell_wh_kg * pack_fraction, "Wh/kg",
                "0.7 to 0.8 is typical for an automotive pack.")


# ── electrochemistry ────────────────────────────────────────────────────────

def nernst_potential(standard_potential_v: float, electrons: float,
                     reaction_quotient: float, temperature_c: float = 25.0) -> dict:
    """Cell potential away from standard conditions."""
    _pos(electrons=electrons, reaction_quotient=reaction_quotient)
    temp_k = temperature_c + 273.15
    if temp_k <= 0:
        raise ValueError("temperature must be above absolute zero")
    value = standard_potential_v - (R * temp_k / (electrons * F)) * math.log(reaction_quotient)
    return _out("E = E0 - (RT / nF) x ln(Q)",
                {"E0 (V)": standard_potential_v, "electrons n": electrons,
                 "Q": reaction_quotient, "temperature (C)": temperature_c},
                value, "V",
                "At 25 C the prefactor RT/F is 25.7 mV.")


def ohmic_drop(current_a: float, resistance_ohm: float) -> dict:
    """Voltage lost across the cell's internal resistance."""
    _pos(current_a=current_a, resistance_ohm=resistance_ohm)
    return _out("IR drop (V) = current (A) x resistance (ohm)",
                {"current (A)": current_a, "resistance (ohm)": resistance_ohm},
                current_a * resistance_ohm, "V",
                "Subtract this before reading a polarisation curve.")


def tafel_exchange_current(tafel_slope_v_dec: float, intercept_v: float) -> dict:
    """Exchange current density from a Tafel fit."""
    _pos(tafel_slope_v_dec=tafel_slope_v_dec)
    return _out("i0 = 10^(-a / b)",
                {"Tafel slope b (V/decade)": tafel_slope_v_dec,
                 "intercept a (V)": intercept_v},
                10.0 ** (-intercept_v / tafel_slope_v_dec), "A/cm2",
                "Measures how readily the reaction proceeds at equilibrium.")


def randles_sevcik_diffusion(peak_current_a: float, electrons: float,
                             area_cm2: float, concentration_mol_cm3: float,
                             scan_rate_v_s: float) -> dict:
    """Diffusion coefficient from a cyclic voltammetry peak, at 25 C."""
    _pos(peak_current_a=peak_current_a, electrons=electrons, area_cm2=area_cm2,
         concentration_mol_cm3=concentration_mol_cm3, scan_rate_v_s=scan_rate_v_s)
    denominator = (2.69e5 * electrons ** 1.5 * area_cm2
                   * concentration_mol_cm3 * math.sqrt(scan_rate_v_s))
    value = (peak_current_a / denominator) ** 2
    return _out("D = (ip / (2.69e5 x n^1.5 x A x C x sqrt(v)))^2",
                {"peak current ip (A)": peak_current_a, "electrons n": electrons,
                 "area A (cm2)": area_cm2,
                 "concentration C (mol/cm3)": concentration_mol_cm3,
                 "scan rate v (V/s)": scan_rate_v_s},
                value, "cm2/s",
                "Randles-Sevcik, reversible system at 25 C. Check that peak "
                "current really is linear in the square root of scan rate first.")


# ── materials characterisation ──────────────────────────────────────────────

def scherrer_crystallite(wavelength_nm: float, fwhm_deg: float,
                         theta_deg: float, shape_factor: float = 0.9) -> dict:
    """Crystallite size from an X-ray diffraction peak width."""
    _pos(wavelength_nm=wavelength_nm, fwhm_deg=fwhm_deg, shape_factor=shape_factor)
    beta = math.radians(fwhm_deg)
    cos_theta = math.cos(math.radians(theta_deg))
    if cos_theta <= 0:
        raise ValueError("theta must be below 90 degrees")
    return _out("D = K x lambda / (beta x cos(theta))",
                {"shape factor K": shape_factor, "wavelength (nm)": wavelength_nm,
                 "FWHM (deg)": fwhm_deg, "theta (deg)": theta_deg},
                shape_factor * wavelength_nm / (beta * cos_theta), "nm",
                "Cu K-alpha is 0.15406 nm. Theta is half the 2-theta peak position. "
                "Strain broadening is ignored, so this is an upper bound.")


def raman_crystallite_size(id_ig_ratio: float, laser_nm: float = 532.0) -> dict:
    """In-plane crystallite size of graphitic carbon from the Raman D/G ratio."""
    _pos(id_ig_ratio=id_ig_ratio, laser_nm=laser_nm)
    return _out("La (nm) = 2.4e-10 x lambda^4 / (ID/IG)",
                {"ID/IG": id_ig_ratio, "laser wavelength (nm)": laser_nm},
                2.4e-10 * laser_nm ** 4 / id_ig_ratio, "nm",
                "Cancado's calibration. Valid for nanocrystalline graphite; it "
                "breaks down for heavily amorphous carbon.")


def sheet_resistance(voltage_v: float, current_a: float) -> dict:
    """Sheet resistance from a four-point probe measurement on a thin film."""
    _pos(voltage_v=voltage_v, current_a=current_a)
    return _out("Rs = (pi / ln2) x V / I",
                {"voltage (V)": voltage_v, "current (A)": current_a},
                (math.pi / math.log(2)) * voltage_v / current_a, "ohm/sq",
                "The geometric factor pi/ln2 = 4.532 assumes a thin, "
                "laterally infinite film.")


def conductivity_from_sheet(sheet_resistance_ohm_sq: float,
                            thickness_nm: float) -> dict:
    """Bulk conductivity from sheet resistance and film thickness."""
    _pos(sheet_resistance_ohm_sq=sheet_resistance_ohm_sq, thickness_nm=thickness_nm)
    thickness_cm = thickness_nm * 1e-7
    return _out("sigma (S/cm) = 1 / (Rs x thickness)",
                {"Rs (ohm/sq)": sheet_resistance_ohm_sq, "thickness (nm)": thickness_nm},
                1.0 / (sheet_resistance_ohm_sq * thickness_cm), "S/cm",
                "Monolayer graphene is about 0.335 nm thick.")


# ── cell and electrode design ───────────────────────────────────────────────

def n_p_ratio(anode_areal_mah_cm2: float, cathode_areal_mah_cm2: float) -> dict:
    """Negative to positive capacity ratio for a full cell."""
    _pos(anode_areal_mah_cm2=anode_areal_mah_cm2,
         cathode_areal_mah_cm2=cathode_areal_mah_cm2)
    return _out("N/P = anode areal capacity / cathode areal capacity",
                {"anode (mAh/cm2)": anode_areal_mah_cm2,
                 "cathode (mAh/cm2)": cathode_areal_mah_cm2},
                anode_areal_mah_cm2 / cathode_areal_mah_cm2, "",
                "1.1 is typical. Below 1 the anode saturates and lithium plates.")


def electrode_thickness(loading_mg_cm2: float, density_g_cm3: float,
                        porosity: float = 0.35) -> dict:
    """Coated electrode thickness from loading, density and porosity."""
    _pos(loading_mg_cm2=loading_mg_cm2, density_g_cm3=density_g_cm3)
    if not 0 <= porosity < 1:
        raise ValueError("porosity must be between 0 and 1")
    thickness_cm = (loading_mg_cm2 / 1000.0) / (density_g_cm3 * (1.0 - porosity))
    return _out("thickness (um) = loading / (density x (1 - porosity)) x 10000",
                {"loading (mg/cm2)": loading_mg_cm2, "density (g/cm3)": density_g_cm3,
                 "porosity": porosity},
                thickness_cm * 1e4, "um",
                "Typical coated electrodes are 50 to 100 um per side.")


def active_mass_fraction(active_g: float, binder_g: float, carbon_g: float) -> dict:
    """Share of the electrode that is active material."""
    _pos(active_g=active_g)
    total = active_g + binder_g + carbon_g
    if total <= 0:
        raise ValueError("total mass must be positive")
    return _out("active fraction (%) = active / (active + binder + carbon) x 100",
                {"active (g)": active_g, "binder (g)": binder_g, "carbon (g)": carbon_g},
                active_g / total * 100.0, "%",
                "A lab electrode at 80 % looks far better per gram of active "
                "material than it does per gram of electrode.")


REGISTRY = {fn.__name__: fn for fn in (
    theoretical_capacity, specific_capacity, areal_capacity, volumetric_capacity,
    capacity_retention, capacity_fade_per_cycle, cycles_to_threshold,
    coulombic_efficiency,
    c_rate, current_from_c_rate, discharge_time, areal_current_density,
    energy_density, volumetric_energy_density, specific_power, energy_efficiency,
    cell_to_pack,
    nernst_potential, ohmic_drop, tafel_exchange_current, randles_sevcik_diffusion,
    scherrer_crystallite, raman_crystallite_size, sheet_resistance,
    conductivity_from_sheet,
    n_p_ratio, electrode_thickness, active_mass_fraction,
)}

GROUPS = {
    "Capacity and charge": ["theoretical_capacity", "specific_capacity",
        "areal_capacity", "volumetric_capacity", "capacity_retention",
        "capacity_fade_per_cycle", "cycles_to_threshold", "coulombic_efficiency"],
    "Rate and current": ["c_rate", "current_from_c_rate", "discharge_time",
        "areal_current_density"],
    "Energy and power": ["energy_density", "volumetric_energy_density",
        "specific_power", "energy_efficiency", "cell_to_pack"],
    "Electrochemistry": ["nernst_potential", "ohmic_drop",
        "tafel_exchange_current", "randles_sevcik_diffusion"],
    "Characterisation": ["scherrer_crystallite", "raman_crystallite_size",
        "sheet_resistance", "conductivity_from_sheet"],
    "Cell and electrode design": ["n_p_ratio", "electrode_thickness",
        "active_mass_fraction"],
}


def catalogue() -> list[dict]:
    """Every calculator, described for an interface: inputs, units, notes.

    The interface renders from this, so adding a calculator here adds it to
    the product without touching the front end.
    """
    import inspect
    by_name = {}
    for group, names in GROUPS.items():
        for name in names:
            by_name[name] = group
    out = []
    for name, fn in REGISTRY.items():
        sig = inspect.signature(fn)
        sample = _SAMPLES.get(name, {})
        try:
            demo = fn(**sample) if sample else None
        except Exception:
            demo = None
        out.append({
            "name": name,
            "label": name.replace("_", " "),
            "group": by_name.get(name, "Other"),
            "description": (fn.__doc__ or "").strip().split("\n")[0],
            "note": (demo or {}).get("note", ""),
            "formula": (demo or {}).get("formula", ""),
            "unit": (demo or {}).get("unit", ""),
            "inputs": [{
                "name": p.name,
                "label": p.name.replace("_", " "),
                "required": p.default is inspect.Parameter.empty,
                "default": None if p.default is inspect.Parameter.empty else p.default,
                "sample": sample.get(p.name),
            } for p in sig.parameters.values()],
        })
    return sorted(out, key=lambda c: (list(GROUPS).index(c["group"])
                                      if c["group"] in GROUPS else 99, c["name"]))


# Representative inputs, used to show each calculator with its formula filled
# in and to cross-check the browser implementation against this one.
_SAMPLES = {
    "theoretical_capacity": {"electrons": 1, "molar_mass_g_mol": 72.06},
    "specific_capacity": {"current_ma": 100, "time_h": 2, "mass_g": 0.5},
    "areal_capacity": {"capacity_mah_g": 350, "loading_mg_cm2": 10},
    "volumetric_capacity": {"capacity_mah_g": 350, "density_g_cm3": 2.2},
    "capacity_retention": {"initial_mah_g": 1000, "final_mah_g": 820},
    "capacity_fade_per_cycle": {"initial_mah_g": 1000, "final_mah_g": 800, "cycles": 500},
    "cycles_to_threshold": {"initial_mah_g": 1000, "fade_pct_per_cycle": 0.02,
                            "threshold_pct": 80.0},
    "coulombic_efficiency": {"discharge_mah_g": 950, "charge_mah_g": 1000},
    "c_rate": {"current_ma_g": 186, "capacity_mah_g": 372},
    "current_from_c_rate": {"c_rate_value": 0.5, "capacity_mah_g": 372},
    "discharge_time": {"c_rate_value": 0.5},
    "areal_current_density": {"current_ma_g": 200, "loading_mg_cm2": 10},
    "energy_density": {"voltage_v": 3.7, "capacity_mah_g": 350},
    "volumetric_energy_density": {"voltage_v": 3.7, "capacity_mah_g": 350,
                                  "density_g_cm3": 2.2},
    "specific_power": {"energy_wh_kg": 250, "c_rate_value": 2},
    "energy_efficiency": {"discharge_energy_wh": 9.1, "charge_energy_wh": 10.0},
    "cell_to_pack": {"cell_wh_kg": 250, "pack_fraction": 0.75},
    "nernst_potential": {"standard_potential_v": 3.4, "electrons": 1,
                         "reaction_quotient": 10, "temperature_c": 25.0},
    "ohmic_drop": {"current_a": 2.0, "resistance_ohm": 0.03},
    "tafel_exchange_current": {"tafel_slope_v_dec": 0.12, "intercept_v": 0.42},
    "randles_sevcik_diffusion": {"peak_current_a": 1.2e-4, "electrons": 1,
                                 "area_cm2": 0.785, "concentration_mol_cm3": 1e-5,
                                 "scan_rate_v_s": 0.001},
    "scherrer_crystallite": {"wavelength_nm": 0.15406, "fwhm_deg": 0.5,
                             "theta_deg": 13.0, "shape_factor": 0.9},
    "raman_crystallite_size": {"id_ig_ratio": 1.0, "laser_nm": 532.0},
    "sheet_resistance": {"voltage_v": 0.01, "current_a": 0.001},
    "conductivity_from_sheet": {"sheet_resistance_ohm_sq": 450, "thickness_nm": 0.335},
    "n_p_ratio": {"anode_areal_mah_cm2": 3.6, "cathode_areal_mah_cm2": 3.2},
    "electrode_thickness": {"loading_mg_cm2": 10, "density_g_cm3": 2.2, "porosity": 0.35},
    "active_mass_fraction": {"active_g": 8.0, "binder_g": 1.0, "carbon_g": 1.0},
}
