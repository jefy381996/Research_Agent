/* Calculator arithmetic, mirroring calculators.py.
   The catalogue (names, inputs, formulas, notes) is generated from the Python
   module and shipped as data, so only the arithmetic lives in both places.
   tests/test_calc_parity.py runs every one of these against the Python
   implementation on the same inputs and fails on any disagreement. */

const F_CONST = 96485.332;
const R_CONST = 8.314462;

const CALC_FN = {
  theoretical_capacity: (i) => i.electrons * F_CONST / (3.6 * i.molar_mass_g_mol),
  specific_capacity: (i) => i.current_ma * i.time_h / i.mass_g,
  areal_capacity: (i) => i.capacity_mah_g * i.loading_mg_cm2 / 1000,
  volumetric_capacity: (i) => i.capacity_mah_g * i.density_g_cm3,
  capacity_retention: (i) => i.final_mah_g / i.initial_mah_g * 100,
  capacity_fade_per_cycle: (i) =>
    (i.initial_mah_g - i.final_mah_g) / i.initial_mah_g / i.cycles * 100,
  cycles_to_threshold: (i) => (100 - i.threshold_pct) / i.fade_pct_per_cycle,
  coulombic_efficiency: (i) => i.discharge_mah_g / i.charge_mah_g * 100,

  c_rate: (i) => i.current_ma_g / i.capacity_mah_g,
  current_from_c_rate: (i) => i.c_rate_value * i.capacity_mah_g,
  discharge_time: (i) => 1 / i.c_rate_value,
  areal_current_density: (i) => i.current_ma_g * i.loading_mg_cm2 / 1000,

  energy_density: (i) => i.voltage_v * i.capacity_mah_g / 1000,
  volumetric_energy_density: (i) => i.voltage_v * i.capacity_mah_g * i.density_g_cm3,
  specific_power: (i) => i.energy_wh_kg * i.c_rate_value,
  energy_efficiency: (i) => i.discharge_energy_wh / i.charge_energy_wh * 100,
  cell_to_pack: (i) => i.cell_wh_kg * (i.pack_fraction ?? 0.75),

  nernst_potential: (i) => i.standard_potential_v
    - (R_CONST * (i.temperature_c + 273.15) / (i.electrons * F_CONST))
      * Math.log(i.reaction_quotient),
  ohmic_drop: (i) => i.current_a * i.resistance_ohm,
  tafel_exchange_current: (i) => Math.pow(10, -i.intercept_v / i.tafel_slope_v_dec),
  randles_sevcik_diffusion: (i) => Math.pow(
    i.peak_current_a / (2.69e5 * Math.pow(i.electrons, 1.5) * i.area_cm2
      * i.concentration_mol_cm3 * Math.sqrt(i.scan_rate_v_s)), 2),

  scherrer_crystallite: (i) => (i.shape_factor ?? 0.9) * i.wavelength_nm
    / ((i.fwhm_deg * Math.PI / 180) * Math.cos(i.theta_deg * Math.PI / 180)),
  raman_crystallite_size: (i) => 2.4e-10 * Math.pow(i.laser_nm ?? 532, 4) / i.id_ig_ratio,
  sheet_resistance: (i) => (Math.PI / Math.LN2) * i.voltage_v / i.current_a,
  conductivity_from_sheet: (i) =>
    1 / (i.sheet_resistance_ohm_sq * (i.thickness_nm * 1e-7)),

  n_p_ratio: (i) => i.anode_areal_mah_cm2 / i.cathode_areal_mah_cm2,
  electrode_thickness: (i) =>
    (i.loading_mg_cm2 / 1000) / (i.density_g_cm3 * (1 - (i.porosity ?? 0.35))) * 1e4,
  active_mass_fraction: (i) =>
    i.active_g / (i.active_g + i.binder_g + i.carbon_g) * 100,
};

/* Inputs that may legitimately be zero or negative; everything else must be
   a positive number, matching the Python guard. */
const CALC_SIGNED = new Set(["standard_potential_v", "intercept_v", "final_mah_g",
  "temperature_c", "binder_g", "carbon_g", "porosity"]);

function calcRun(name, raw, spec) {
  const fn = CALC_FN[name];
  if (!fn) throw new Error(`unknown calculation ${name}`);
  const vals = {};
  for (const inp of spec.inputs) {
    const given = raw[inp.name];
    if (given === "" || given === null || given === undefined) {
      if (inp.default !== null && inp.default !== undefined) { vals[inp.name] = inp.default; continue; }
      throw new Error(`${inp.label} is required`);
    }
    const n = Number(given);
    if (!Number.isFinite(n)) throw new Error(`${inp.label} must be a number`);
    if (!CALC_SIGNED.has(inp.name) && n <= 0)
      throw new Error(`${inp.label} must be positive`);
    vals[inp.name] = n;
  }
  const result = fn(vals);
  if (!Number.isFinite(result)) throw new Error("the inputs give no finite result");
  return { name, formula: spec.formula, inputs: vals,
    result: Math.round(result * 1e6) / 1e6, unit: spec.unit, note: spec.note };
}

if (typeof module !== "undefined") module.exports = { CALC_FN, calcRun };
