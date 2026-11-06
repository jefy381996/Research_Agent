"""Tests for the extraction rules the product's credibility rests on."""
import unittest

import extract_evidence as E
import plausibility


def row_for(sentence, title="Si graphene anode for lithium-ion batteries"):
    return E.extract_from_sentence(sentence, title, sentence, "abstract")


class TestTheoreticalValues(unittest.TestCase):
    """A theoretical limit is a textbook constant, never a measurement."""

    def test_plain_theoretical_claim_is_rejected(self):
        self.assertIsNone(row_for(
            "The theoretical capacity of pristine silicon can reach up to "
            "4200 mAh g-1, however volume expansion limits application."))

    def test_theoretical_phrasing_without_a_verb_is_rejected(self):
        self.assertIsNone(row_for(
            "Silicon has a high theoretical specific capacity of 4200 mAh g-1."))

    def test_a_measurement_beside_a_theoretical_citation_survives(self):
        row = row_for("Far exceeding the theoretical capacity of graphite "
                      "(372 mAh g-1), the anode delivered 1250 mAh g-1 after "
                      "200 cycles with 92% retention.")
        self.assertEqual(row["specific_capacity_mah_g"], 1250.0)
        self.assertEqual(row["cycle_count"], 200)
        self.assertEqual(row["capacity_retention_pct"], 92.0)

    def test_contrastive_phrasing_survives(self):
        row = row_for("Although the theoretical value is 4200 mAh g-1, our "
                      "electrode exhibited 1100 mAh g-1 over 300 cycles.")
        self.assertEqual(row["specific_capacity_mah_g"], 1100.0)


class TestNoInference(unittest.TestCase):
    def test_two_capacities_are_not_read_as_a_start_and_an_end(self):
        row = row_for("The composite exhibits rate capability of 285.4 mAh g-1 "
                      "at 0.05 A g-1 and 141.6 mAh g-1 at 5 A g-1.")
        self.assertEqual(row["specific_capacity_mah_g"], 285.4)
        self.assertIsNone(row["initial_capacity_mah_g"])
        self.assertTrue(any("multiple_capacities" in f for f in row["flags"]))

    def test_an_explicit_pair_is_recorded_as_a_pair(self):
        row = row_for("Capacity decreased from 1200 mAh g-1 to 900 after "
                      "500 cycles.")
        self.assertEqual(row["initial_capacity_mah_g"], 1200.0)
        self.assertEqual(row["specific_capacity_mah_g"], 900.0)

    def test_absent_values_stay_absent(self):
        row = row_for("The anode delivered 980 mAh g-1 over 500 cycles.")
        for field in ("first_cycle_ce_pct", "temperature_c",
                      "areal_loading_mg_cm2", "voltage_window_v"):
            self.assertIsNone(row[field], f"{field} should be None")


class TestUnitDerivation(unittest.TestCase):
    def test_amps_per_gram_converts_and_verifies_against_the_source_string(self):
        sentence = "The electrode delivered 980 mAh g-1 at 0.05 A g-1."
        row = row_for(sentence)
        self.assertEqual(row["current_density_ma_g"], 50.0)
        rejections, ok = E.verify_text(row, sentence)
        self.assertTrue(ok)
        self.assertEqual(rejections, [],
                         "a correctly converted value must not be rejected")
        self.assertEqual(row["current_density_ma_g"], 50.0)


class TestTemperature(unittest.TestCase):
    def test_synthesis_temperature_is_not_a_test_condition(self):
        row = row_for("The composite annealed at 800 C delivered 950 mAh g-1 "
                      "over 100 cycles.")
        self.assertIsNone(row["temperature_c"])

    def test_a_real_test_temperature_is_kept(self):
        row = row_for("At 55 \u00b0C the cell delivered 950 mAh g-1 over 100 cycles.")
        self.assertEqual(row["temperature_c"], 55.0)


class TestTextVerification(unittest.TestCase):
    def test_a_number_absent_from_the_quote_is_nulled_and_logged(self):
        sentence = "The anode delivered 980 mAh g-1 over 500 cycles."
        row = row_for(sentence)
        row["capacity_retention_pct"] = 77.0          # never in the sentence
        rejections, ok = E.verify_text(row, sentence)
        self.assertTrue(ok)
        self.assertIsNone(row["capacity_retention_pct"])
        self.assertTrue(any(r["field"] == "capacity_retention_pct"
                            for r in rejections))

    def test_a_quote_absent_from_the_source_fails_the_whole_row(self):
        row = row_for("The anode delivered 980 mAh g-1 over 500 cycles.")
        _, ok = E.verify_text(row, "an unrelated body of text")
        self.assertFalse(ok)


class TestClassification(unittest.TestCase):
    def test_en_dash_chemistry_is_recognised(self):
        self.assertEqual(
            E._first_match(E.BATTERY_TYPES,
                           E.normalise("Lithium–Sulfur Batteries")),
            "lithium-sulfur")

    def test_spaced_subscripts_are_recognised(self):
        self.assertEqual(
            E._first_match(E.PARTNERS, E.normalise("a MoS 2 /graphene hybrid")),
            "MoS2")


class TestIdentity(unittest.TestCase):
    def test_hash_is_stable_and_separates_rows_with_null_fields(self):
        a = {"openalex_id": "W1", "source_quote": "q", "specific_capacity_mah_g": None}
        b = {"openalex_id": "W1", "source_quote": "q", "specific_capacity_mah_g": 100}
        self.assertEqual(E.row_hash(a), E.row_hash(dict(a)))
        self.assertNotEqual(E.row_hash(a), E.row_hash(b))


class TestPlausibility(unittest.TestCase):
    def test_capacity_above_the_hard_ceiling_is_flagged_not_deleted(self):
        row = {"specific_capacity_mah_g": 6100, "material_system": "CNT/graphene"}
        flags = plausibility.check_bounds(row)
        self.assertTrue(any("capacity_above" in f for f in flags))
        self.assertEqual(row["specific_capacity_mah_g"], 6100)

    def test_lithium_air_ceiling_names_the_convention(self):
        row = {"specific_capacity_mah_g": 9000, "battery_type": "lithium-air"}
        self.assertTrue(any("per gram" in f for f in plausibility.check_bounds(row)))

    def test_retention_above_one_hundred_is_flagged(self):
        self.assertTrue(any("retention_above_100pct" in f for f in
                            plausibility.check_bounds({"capacity_retention_pct": 118})))

    def test_temperature_and_voltage_bounds(self):
        self.assertTrue(any("temperature_outside" in f for f in
                            plausibility.check_bounds({"temperature_c": 950})))
        self.assertTrue(any("voltage_window_outside" in f for f in
                            plausibility.check_bounds({"voltage_window_v": "0.01-9.0 V"})))

    def test_arithmetic_mismatch_is_caught(self):
        flags = plausibility.check_consistency({
            "initial_capacity_mah_g": 1000, "specific_capacity_mah_g": 500,
            "capacity_retention_pct": 90})
        self.assertTrue(any("retention_arithmetic_mismatch" in f for f in flags))

    def test_consistent_arithmetic_is_not_flagged(self):
        self.assertEqual(plausibility.check_consistency({
            "initial_capacity_mah_g": 1000, "specific_capacity_mah_g": 900,
            "capacity_retention_pct": 90}), [])

    def test_group_outliers_need_five_members(self):
        small = [{"material_system": "Si/rGO", "specific_capacity_mah_g": v}
                 for v in (100, 9000)]
        self.assertEqual(plausibility.check_outliers(small), {})
        # One extreme value masks itself under a plain standard deviation;
        # the robust estimator still finds it.
        big = [{"material_system": "Si/rGO", "specific_capacity_mah_g": v}
               for v in (1000, 1010, 1020, 1030, 1040, 90000)]
        self.assertIn(5, plausibility.check_outliers(big))

    def test_assess_keeps_extractor_notes_and_sets_confidence(self):
        rows = [{"specific_capacity_mah_g": 900, "flags": ["a_note: kept"]}]
        plausibility.assess(rows)
        self.assertIn("a_note: kept", rows[0]["flags"])
        self.assertEqual(rows[0]["confidence"], "flagged")
        clean = [{"specific_capacity_mah_g": 900, "flags": []}]
        plausibility.assess(clean)
        self.assertEqual(clean[0]["confidence"], "verified")


if __name__ == "__main__":
    unittest.main()
