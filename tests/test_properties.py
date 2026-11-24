"""The non-battery numbers, and the ways they go wrong.

Every case here is a sentence the extractor read incorrectly at some point, or
one that proves a bound. Textbook values are included on purpose: if graphene's
thermal conductivity stops coming out near 5,000 W/mK, something upstream broke.
"""
import unittest

import extract_properties as X
import properties as P


def one(sentence, title="graphene paper", abstract=""):
    rows = X.rows_for_sentence(sentence, title, abstract or sentence)
    return {r["property_key"]: r for r in rows}


class TestNumbers(unittest.TestCase):
    def test_space_grouped_thousands_are_one_number(self):
        """"68 000" matched "000" and stored a mobility of zero."""
        self.assertEqual(P._n("68 000"), 68000.0)
        self.assertEqual(P._n("280,000"), 280000.0)

    def test_scientific_notation(self):
        self.assertAlmostEqual(P._n("1.5 x 10 4"), 15000.0)
        self.assertAlmostEqual(P._n("5 × 10 -4"), 0.0005)

    def test_a_lone_comma_with_two_decimals_is_a_decimal_point(self):
        self.assertEqual(P._n("1,5"), 1.5)
        self.assertEqual(P._n("2,630"), 2630.0)


class TestKnownValues(unittest.TestCase):
    def test_graphene_thermal_conductivity(self):
        r = one("Thermal conductivity of single-layer graphene was up to "
                "5200 W/mK at room temperature.")
        self.assertIn("thermal_conductivity", r)
        self.assertEqual(r["thermal_conductivity"]["value"], 5200.0)
        self.assertEqual(r["thermal_conductivity"]["unit"], "W/mK")

    def test_a_modulus_in_tpa_becomes_gpa(self):
        r = one("Nanoindentation gives an in-plane Young's modulus of 1.0 TPa.")
        self.assertEqual(r["youngs_modulus"]["value"], 1000.0)

    def test_conductivity_in_s_per_cm_becomes_s_per_m(self):
        r = one("The film shows an electrical conductivity of 1.5 S cm-1.")
        self.assertEqual(r["electrical_conductivity"]["value"], 150.0)


class TestAmbiguity(unittest.TestCase):
    def test_modulus_and_strength_in_one_sentence_yield_neither(self):
        """Both are in GPa; nothing says which figure belongs to which."""
        r = one("The film shows a Young's modulus of 1.0 TPa and a tensile "
                "strength of 130 GPa.")
        self.assertNotIn("youngs_modulus", r)
        self.assertNotIn("tensile_strength", r)

    def test_a_strength_and_a_conductivity_do_not_block_each_other(self):
        """Different units, so each figure has exactly one home."""
        r = one("The graphene framework exhibits remarkable tensile strength "
                "(34.8 MPa) and high electrical conductivity (1.6 x 10 4 S m-1).")
        self.assertEqual(r["tensile_strength"]["value"], 34.8)
        self.assertEqual(r["electrical_conductivity"]["value"], 16000.0)

    def test_ionic_conductivity_is_not_electrical_conductivity(self):
        r = one("The ionic conductivity of the hybrid electrolyte reaches "
                "1.54 x 10 -5 S cm-1 at 24 C.")
        self.assertIn("ionic_conductivity", r)
        self.assertNotIn("electrical_conductivity", r)

    def test_a_bare_percentage_is_not_a_transmittance(self):
        r = one("The electrode retained 92% of its capacity after 500 cycles.")
        self.assertNotIn("transmittance", r)

    def test_an_absorbance_percentage_is_not_a_transmittance(self):
        r = one("Peak absorbance is tuned from 24.3% to near 100% while the "
                "transmittance window stays open.")
        self.assertNotIn("transmittance", r)

    def test_specific_shielding_in_db_cm2_g_is_a_different_quantity(self):
        r = one("The film shows an absolute shielding effectiveness of "
                "20906 dB cm2 g-1.")
        self.assertNotIn("emi_shielding", r)

    def test_plain_shielding_in_db_is_kept(self):
        r = one("The composite reaches a shielding effectiveness of 62 dB in "
                "the X-band.")
        self.assertEqual(r["emi_shielding"]["value"], 62.0)


class TestFlags(unittest.TestCase):
    def test_above_the_single_sheet_area_is_flagged_not_dropped(self):
        r = one("A specific surface area of 3200 m2 g-1 was measured by BET.")
        self.assertEqual(r["surface_area"]["confidence"], "flagged")
        self.assertIn("2630", r["surface_area"]["flags"])

    def test_a_modelled_figure_is_flagged(self):
        r = one("Molecular dynamics predicts a thermal conductivity of "
                "3200 W/mK for the sheet.")
        self.assertEqual(r["thermal_conductivity"]["confidence"], "flagged")
        self.assertIn("modelled_not_measured", r["thermal_conductivity"]["flags"])

    def test_a_modelling_word_far_from_the_figure_does_not_flag_it(self):
        r = one("Theoretical calculations confirmed the hybrid's affinity for "
                "sodium ions, and the electrodes were then measured in a "
                "three-electrode cell where the specific capacitance reached "
                "338.1 F g-1 at 1 A g-1 with good rate capability throughout.")
        self.assertEqual(r["capacitance"]["confidence"], "verified")


class TestContract(unittest.TestCase):
    def test_every_figure_is_readable_in_its_own_sentence(self):
        s = ("The membranes achieve a water permeance of 2647 L m-2 h-1 bar-1 "
             "while maintaining 99.9% rejection.")
        row = X.rows_for_sentence(s, "t", s)[0]
        row["openalex_id"] = "W1"
        self.assertTrue(X.verify_text(row))
        self.assertIn(row["value_as_reported"].split()[0], row["source_quote"])

    def test_the_same_row_hashes_the_same_twice(self):
        s = "The sheet resistance was 55 ohm/sq."
        a = X.rows_for_sentence(s, "t", s)[0]
        b = X.rows_for_sentence(s, "t", s)[0]
        a["openalex_id"] = b["openalex_id"] = "W1"
        self.assertEqual(X.row_hash(a), X.row_hash(b))

    def test_a_different_value_hashes_differently(self):
        s1 = "The sheet resistance was 55 ohm/sq."
        s2 = "The sheet resistance was 120 ohm/sq."
        a = X.rows_for_sentence(s1, "t", s1)[0]
        b = X.rows_for_sentence(s2, "t", s2)[0]
        a["openalex_id"] = b["openalex_id"] = "W1"
        self.assertNotEqual(X.row_hash(a), X.row_hash(b))

    def test_a_sentence_with_no_property_yields_nothing(self):
        self.assertEqual(
            X.rows_for_sentence("Graphene was prepared by chemical vapour "
                                "deposition on copper foil.", "t", ""), [])

    # --- a femtogram is not a farad ------------------------------------
    #
    # 58 rows in the library were biosensor detection limits filed as
    # specific capacitance: "1.0 fg/mL" read as one farad per gram. The
    # patterns are compiled case-insensitively, and f is the lowercase of F.
    # The separator cannot be the discriminator, because papers really do
    # write "292 Fg-1" with nothing between the F and the g - so these tests
    # run in both directions, and the four that must survive matter as much
    # as the three that must not.

    def test_a_femtogram_per_millilitre_is_not_a_capacitance(self):
        for text in (
            "The dashed lines indicate the response to TNF-alpha (1 fg/ml).",
            "The limit of detection of the immunosensor is 1.0 fg/mL.",
            "Characterised across a concentration range from 1 to 1000 fg/ml.",
            "A detection limit of 21 fg mL -1 over a linear range was found.",
        ):
            rows = [r for r in X.rows_for_sentence(text, "t", text)
                    if r["property_key"] == "capacitance"]
            self.assertEqual(rows, [], text)

    def test_farads_per_gram_still_read_with_no_separator(self):
        for text, want in (
            ("The electrode gave a specific capacitance of 292 Fg-1.", 292.0),
            ("A specific capacitance of 2119.28 Fg -1 was reached.", 2119.28),
            ("The film showed a specific capacitance of 481 F/g in KOH.", 481.0),
            ("Specific capacitance of 467.3 F g-1 at 1 A g-1.", 467.3),
        ):
            rows = [r for r in X.rows_for_sentence(text, "t", text)
                    if r["property_key"] == "capacitance"]
            self.assertEqual(len(rows), 1, text)
            self.assertAlmostEqual(rows[0]["value"], want, places=2)

    def test_a_chemical_formula_is_not_a_surface_area(self):
        # m2/g is lowercase. "Au 4 M 2 /G" is a formula and "2 M" is a
        # molarity; read case-insensitively, the formula came back as four
        # square metres per gram.
        text = ("ENRR was performed with the working electrode (either"
                " Au 4 M 2 (SR) 8 or Au 4 M 2 /G (M = Pt, Pd)).")
        rows = [r for r in X.rows_for_sentence(text, "t", text)
                if r["property_key"] == "surface_area"]
        self.assertEqual(rows, [])

    def test_square_metres_per_gram_still_read_in_every_spelling(self):
        for text, want in (
            ("A high specific surface area of 2630 m 2 g -1 was measured.", 2630.0),
            ("The surface area reached 367.2 m 2 /g after activation.", 367.2),
            ("A BET area of 1520 m2/g was obtained for the aerogel.", 1520.0),
        ):
            rows = [r for r in X.rows_for_sentence(text, "t", text)
                    if r["property_key"] == "surface_area"]
            self.assertEqual(len(rows), 1, text)
            self.assertAlmostEqual(rows[0]["value"], want, places=2)

    # --- a figure may be written without separators ---------------------

    def test_a_five_digit_figure_keeps_its_leading_digit(self):
        # "\d{1,4}(?:[,\s]\d{3})*" read only the separated form, so a mobility
        # of 11900 matched the last four digits and stored 1900.
        for text, want in (
            ("The Hall sensors show mobilities up to 11900 cm2 V-1 s-1.", 11900.0),
            ("The film reached a thermal conductivity of 12500 W m-1 K-1.", 12500.0),
            ("An electrical conductivity of 10524 S m-1 was measured.", 10524.0),
        ):
            rows = X.rows_for_sentence(text, "t", text)
            self.assertEqual(len(rows), 1, text)
            self.assertAlmostEqual(rows[0]["value"], want, places=1)

    def test_a_six_digit_figure_is_not_lost_in_silence(self):
        text = "A carrier mobility of 250000 cm2 V-1 s-1 was measured."
        rows = [r for r in X.rows_for_sentence(text, "t", text)
                if r["property_key"] == "carrier_mobility"]
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(rows[0]["value"], 250000.0, places=1)

    def test_separated_thousands_are_still_read_whole(self):
        for text in ("The mobility reached 11,900 cm2 V-1 s-1 for the device.",
                     "The mobility reached 11 900 cm2 V-1 s-1 for the device."):
            rows = [r for r in X.rows_for_sentence(text, "t", text)
                    if r["property_key"] == "carrier_mobility"]
            self.assertEqual(len(rows), 1, text)
            self.assertAlmostEqual(rows[0]["value"], 11900.0, places=1)

    def test_a_list_of_figures_takes_the_one_at_the_unit(self):
        text = "Surface areas of 285, 261, and 228 m 2 /g were measured."
        rows = [r for r in X.rows_for_sentence(text, "t", text)
                if r["property_key"] == "surface_area"]
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(rows[0]["value"], 228.0, places=1)

    # --- an uncertainty is not a value ----------------------------------

    def test_an_error_bar_is_not_the_measurement(self):
        # "670 +- 5 L m-2 h-1 bar-1" stored 5: the number nearest the unit.
        text = ("PGO membranes show higher water permeance (~670 +- 5 L m -2"
                " h -1 bar -1 ) than pristine GO-based membranes.")
        rows = [r for r in X.rows_for_sentence(text, "t", text)
                if r["property_key"] == "water_permeance"]
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(rows[0]["value"], 670.0, places=1)

    def test_an_error_bar_written_with_the_sign_is_not_the_measurement(self):
        text = ("An electrical conductivity of 1800 \u00b1 40 S/cm was"
                " measured for the film.")
        rows = [r for r in X.rows_for_sentence(text, "t", text)
                if r["property_key"] == "electrical_conductivity"]
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(rows[0]["value"], 180000.0, places=1)

    def test_a_figure_with_no_uncertainty_is_unaffected(self):
        text = "The BET surface area was 224.10 m 2 g -1 for the composite."
        rows = [r for r in X.rows_for_sentence(text, "t", text)
                if r["property_key"] == "surface_area"]
        self.assertAlmostEqual(rows[0]["value"], 224.10, places=2)

    # --- a tiny measurement is not a zero -------------------------------

    def test_a_value_below_a_millionth_survives_storage(self):
        text = "The electronic conductivity is 4.85x10 -11 S cm -1 here."
        rows = [r for r in X.rows_for_sentence(text, "t", text)
                if r["property_key"] == "electrical_conductivity"]
        self.assertEqual(len(rows), 1)
        # 4.85e-11 S/cm is 4.85e-9 S/m. round(x, 6) made that 0.0.
        self.assertGreater(rows[0]["value"], 0.0)
        self.assertAlmostEqual(rows[0]["value"], 4.85e-9, places=12)

    def test_no_row_carries_a_value_of_zero_or_less(self):
        for text in ("The conductivity is 4.85x10 -11 S cm -1.",
                     "A sheet resistance of 55 ohm/sq was measured.",
                     "The thermal conductivity reached 2000 W/mK."):
            for row in X.rows_for_sentence(text, "t", text):
                self.assertGreater(row["value"], 0.0, f"{row['property_key']}"
                                                      f" from {text!r}")

    def test_every_family_has_a_unit_and_a_sane_range(self):
        for fam in P.FAMILIES:
            self.assertTrue(fam["unit"], fam["key"])
            self.assertLess(fam["low"], fam["high"], fam["key"])
            self.assertTrue(fam["aliases"], fam["key"])


if __name__ == "__main__":
    unittest.main()
