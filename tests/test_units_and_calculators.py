"""Unit tests for every conversion and calculator path."""
import unittest

import calculators
import units


class TestCapacityUnits(unittest.TestCase):
    def test_mah_per_g_is_identity(self):
        self.assertEqual(units.capacity_to_mah_g(372, "mAh/g")["result"], 372)

    def test_ah_per_kg_equals_mah_per_g(self):
        self.assertEqual(units.capacity_to_mah_g(170, "Ah/kg")["result"], 170)

    def test_ah_per_g_scales_by_one_thousand(self):
        self.assertEqual(units.capacity_to_mah_g(1.2, "Ah/g")["result"], 1200)

    def test_mah_per_mg_scales_by_one_thousand(self):
        self.assertEqual(units.capacity_to_mah_g(1.5, "mAh/mg")["result"], 1500)

    def test_superscript_and_spaced_spellings(self):
        for spelling in ("mAh g-1", "mA h g-1", "mA h/g", "MAH/G"):
            self.assertEqual(units.capacity_to_mah_g(500, spelling)["result"], 500)

    def test_unknown_unit_raises_rather_than_guessing(self):
        with self.assertRaises(ValueError):
            units.capacity_to_mah_g(100, "F/g")

    def test_result_carries_its_working(self):
        out = units.capacity_to_mah_g(1.2, "Ah/g")
        self.assertIn("formula", out)
        self.assertEqual(out["inputs"]["factor"], 1000.0)
        self.assertEqual(out["unit"], "mAh/g")


class TestCurrentUnits(unittest.TestCase):
    def test_ma_per_g_identity(self):
        self.assertEqual(units.current_to_ma_g(100, "mA/g")["result"], 100)

    def test_a_per_g_scales(self):
        self.assertEqual(units.current_to_ma_g(0.05, "A/g")["result"], 50)

    def test_a_per_kg_equals_ma_per_g(self):
        self.assertEqual(units.current_to_ma_g(200, "A/kg")["result"], 200)

    def test_unknown_raises(self):
        with self.assertRaises(ValueError):
            units.current_to_ma_g(1, "mA/cm2")


class TestLoadingUnits(unittest.TestCase):
    def test_mg_cm2_identity(self):
        self.assertEqual(units.loading_to_mg_cm2(2.5, "mg/cm2")["result"], 2.5)

    def test_g_cm2_scales(self):
        self.assertEqual(units.loading_to_mg_cm2(0.002, "g/cm2")["result"], 2.0)


class TestRateConversions(unittest.TestCase):
    def test_c_rate_to_current_round_trip(self):
        current = units.c_rate_to_current(0.5, 372)["result"]
        self.assertEqual(current, 186)
        self.assertEqual(units.current_to_c_rate(186, 372)["result"], 0.5)

    def test_zero_capacity_refused(self):
        with self.assertRaises(ValueError):
            units.current_to_c_rate(100, 0)


class TestEnergy(unittest.TestCase):
    def test_gravimetric_energy(self):
        self.assertEqual(units.gravimetric_energy(3.7, 1000)["result"], 3.7)

    def test_volumetric_needs_a_density_and_will_not_invent_one(self):
        self.assertEqual(units.volumetric_energy(250, 2.0)["result"], 500)
        with self.assertRaises(ValueError):
            units.volumetric_energy(250, 0)


class TestCalculators(unittest.TestCase):
    def test_specific_capacity_from_a_discharge(self):
        out = calculators.specific_capacity(current_ma=100, time_h=2, mass_g=0.5)
        self.assertEqual(out["result"], 400)
        self.assertEqual(out["unit"], "mAh/g")

    def test_coulombic_efficiency(self):
        self.assertEqual(
            calculators.coulombic_efficiency(discharge_mah_g=950,
                                             charge_mah_g=1000)["result"], 95.0)

    def test_capacity_retention(self):
        self.assertEqual(
            calculators.capacity_retention(initial_mah_g=1000,
                                           final_mah_g=820)["result"], 82.0)

    def test_fade_per_cycle(self):
        out = calculators.capacity_fade_per_cycle(initial_mah_g=1000,
                                                  final_mah_g=800, cycles=500)
        self.assertAlmostEqual(out["result"], 0.04, places=6)

    def test_cell_to_pack(self):
        self.assertEqual(
            calculators.cell_to_pack(cell_wh_kg=250, pack_fraction=0.75)["result"],
            187.5)

    def test_pack_fraction_must_be_a_fraction(self):
        with self.assertRaises(ValueError):
            calculators.cell_to_pack(cell_wh_kg=250, pack_fraction=1.4)

    def test_negative_and_zero_inputs_are_refused(self):
        for bad in (0, -1):
            with self.assertRaises(ValueError):
                calculators.energy_density(voltage_v=bad, capacity_mah_g=1000)

    def test_every_registered_calculator_shows_its_working(self):
        """Driven by the module's own sample inputs, so a new calculator is
        covered the moment it is added rather than when someone remembers."""
        samples = calculators._SAMPLES
        self.assertEqual(set(samples), set(calculators.REGISTRY),
                         "every calculator needs an entry in _SAMPLES")
        for name, fn in calculators.REGISTRY.items():
            out = fn(**samples[name])
            for key in ("formula", "inputs", "result", "unit"):
                self.assertIn(key, out, f"{name} is missing {key}")
            self.assertTrue(out["formula"], f"{name} has an empty formula")
            self.assertIsInstance(out["result"], (int, float), name)

    def test_every_calculator_is_in_exactly_one_group(self):
        grouped = [n for names in calculators.GROUPS.values() for n in names]
        self.assertEqual(sorted(grouped), sorted(calculators.REGISTRY),
                         "a calculator is missing from GROUPS, or listed twice")


class TestKnownValues(unittest.TestCase):
    """Textbook values a battery scientist would check first."""

    def assertClose(self, got, want, tol=0.005):
        self.assertLess(abs(got - want) / want, tol, f"{got} is not ~{want}")

    def test_theoretical_capacities_match_the_literature(self):
        cases = [
            ("graphite as LiC6", 1, 72.06, 372),
            ("silicon as Li15Si4", 3.75, 28.085, 3579),
            ("lithium metal", 1, 6.941, 3861),
            ("sulfur to Li2S", 2, 32.06, 1672),
            ("LiFePO4", 1, 157.76, 170),
            ("sodium metal", 1, 22.99, 1166),
        ]
        for label, n, mass, expected in cases:
            with self.subTest(material=label):
                self.assertClose(
                    calculators.theoretical_capacity(n, mass)["result"], expected)

    def test_nernst_prefactor_is_25_7_mv_at_room_temperature(self):
        shift = (calculators.nernst_potential(0.0, 1, 1)["result"]
                 - calculators.nernst_potential(0.0, 1, 10)["result"])
        self.assertClose(shift * 1000, 59.16, tol=0.01)   # one decade

    def test_scherrer_on_a_known_peak(self):
        self.assertClose(
            calculators.scherrer_crystallite(0.15406, 0.5, 13.0)["result"], 16.3, 0.01)

    def test_four_point_probe_geometric_factor(self):
        self.assertClose(
            calculators.sheet_resistance(1.0, 1.0)["result"], 4.5324, 0.001)

    def test_c_rate_round_trip(self):
        current = calculators.current_from_c_rate(0.5, 372)["result"]
        self.assertClose(calculators.c_rate(current, 372)["result"], 0.5)

    def test_cycles_to_threshold_agrees_with_the_fade_it_came_from(self):
        fade = calculators.capacity_fade_per_cycle(1000, 800, 500)["result"]
        self.assertClose(
            calculators.cycles_to_threshold(1000, fade, 80.0)["result"], 500)

    def test_areal_capacity_is_in_the_commercial_range(self):
        self.assertClose(calculators.areal_capacity(350, 10)["result"], 3.5)


if __name__ == "__main__":
    unittest.main()
