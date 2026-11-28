"""Tests for the extraction rules the product's credibility rests on."""
import os
import shutil
import sqlite3
import sys
import tempfile
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



class SymbolsAreCaseSensitive(unittest.TestCase):
    """Matched case-insensitively, \\bGO\\b matches the verb "go"."""

    def test_the_verb_go_is_not_graphene_oxide(self):
        self.assertIsNone(E._first_match(
            E.GRAPHENE_FORMS, "we then go on to measure the sample"))

    def test_graphene_oxide_is_still_found_by_its_symbol(self):
        self.assertEqual(E._first_match(
            E.GRAPHENE_FORMS, "the GO suspension was reduced at 90 C"),
            "graphene oxide")

    def test_shielding_effectiveness_is_not_selenium(self):
        self.assertIsNone(E._first_match(
            E.PARTNERS, "shielding effectiveness (SE) of the film is 42.5 dB"))

    def test_selenium_is_still_found_by_name_and_by_symbol(self):
        self.assertEqual(E._first_match(
            E.PARTNERS, "a Selenium cathode was prepared"), "Se")
        self.assertEqual(E._first_match(
            E.PARTNERS, "the Se cathode delivered 600 mAh/g"), "Se")


class SeparatedThousands(unittest.TestCase):
    """A pattern that cannot span a thousands separator matches the trailing
    group on its own. "after 10,000 cycles" captured "000", so 314 rows in the
    library carried a cycle count of zero beside a real retention figure."""

    def test_a_cycle_count_survives_its_separator(self):
        for text, want in (
            ("The electrode retained 92% of capacity after 10 000 cycles.", 10000),
            ("The electrode retained 92% of capacity after 10,000 cycles.", 10000),
            ("The electrode retained 92% of capacity after 10000 cycles.", 10000),
            ("Zn cells retain 77.3% of capacity after 2,000 cycles at 30 C.", 2000),
            ("The cell retained 90% of capacity after 500 cycles.", 500),
        ):
            row = E.extract_from_sentence(text, "t", text, "abstract")
            self.assertIsNotNone(row, text)
            self.assertEqual(row["cycle_count"], want, text)

    def test_no_row_reports_a_retention_after_no_cycles(self):
        text = "The supercapacitor retained 92% of capacity after 10 000 cycles."
        row = E.extract_from_sentence(text, "t", text, "abstract")
        self.assertNotEqual(row["cycle_count"], 0)

    def test_a_capacity_survives_its_separator(self):
        for text, want in (
            ("The anode delivered 1,206.9 mAh g -1 at 0.2C after 100 cycles.", 1206.9),
            ("A capacity of 1 675 mAh g -1 was reached for the cathode.", 1675.0),
            ("The anode delivered 372 mAh g -1 at 100 mA g -1 .", 372.0),
        ):
            row = E.extract_from_sentence(text, "t", text, "abstract")
            self.assertAlmostEqual(row["specific_capacity_mah_g"], want, places=1)


class WhichMaterialWasMeasured(unittest.TestCase):
    """A label is the one axis the value audits kept catching in passing: 14
    of 18 verified rows carried the right material, and the slice whose label
    came from the abstract alone ran 8 of 12. In every wrong case the name was
    the counter-electrode or a line of background, and was said once."""

    def partner_of(self, title, abstract, sentence):
        material, form, _, _, _ = E.classify(title, abstract, sentence)
        if material is None:
            return None
        if "/" in material:
            return material.split("/")[0]
        return None if material == form else material

    def test_a_name_said_once_in_the_abstract_is_not_the_label(self):
        # "In Zn||MnO2 full batteries": MnO2 is the other electrode.
        self.assertIsNone(self.partner_of(
            "Binder-Free 3D Zn-Graphene Anode from Zinc Powders and Graphene Oxide",
            "A Zn-graphene anode was built. In Zn||MnO 2 full batteries,"
            " Zn_G enhances the gravimetric energy density.",
            "The anode delivered 400 mAh g -1 after 200 cycles."))
        # "with a Cu2Se anode": the paper's material is the NVPF cathode.
        self.assertIsNone(self.partner_of(
            "Microwave Synthesis of Na3V2(PO4)2F3 Nanocuboid@Reduced Graphene Oxide",
            "The cathode was made. The full battery with a Cu 2 Se anode"
            " represents a capacity of 116 mAh g -1 .",
            "The cathode delivered 120 mAh g -1 after 100 cycles."))
        # Background about other people's silicon electrodes.
        self.assertIsNone(self.partner_of(
            "Sustainable Hybrid MOF/Silica Electrodes for Lithium-ion Batteries",
            "Silica are among the motivations for the evolution of"
            " silicon-based electrodes. In this work, a MOF composite.",
            "The electrode delivered 500 mAh g -1 after 100 cycles."))

    def test_a_name_in_the_title_is_the_papers_subject(self):
        # Once in the title is enough; once in the abstract is not. Note the
        # title has to name it in a form the vocabulary can see - "SnS" gives
        # \bSn\b no word boundary to end on, which is why this one spells it.
        self.assertEqual(self.partner_of(
            "Mechanochemical synthesis of tin sulfide anodes for sodium ion"
            " batteries",
            "Orthorombic tin (II) sulfide was synthesized by a simple route.",
            "The anode delivered 500 mAh g -1 after 100 cycles."), "Sn")

    def test_once_in_the_abstract_and_absent_from_the_title_is_dropped(self):
        self.assertIsNone(self.partner_of(
            "Mechanochemical synthesis of SnS anodes for sodium ion batteries",
            "Orthorombic tin (II) sulfide was synthesized by a simple route.",
            "The anode delivered 500 mAh g -1 after 100 cycles."))

    def test_a_name_said_twice_in_the_abstract_is_meant(self):
        self.assertEqual(self.partner_of(
            "Graphene/Carbon Black Co-modified Separator for Batteries",
            "The sulfur cathode with high S loading was built, and sulfur"
            " utilisation improved markedly.",
            "The cell delivered 1000 mAh g -1 after 100 cycles."), "S")

    def test_the_sentences_own_material_always_wins(self):
        self.assertEqual(self.partner_of(
            "A paper about something else entirely",
            "No materials are named here at all.",
            "The SnO 2 /graphene anode delivered 800 mAh g -1 ."), "SnO2")

    def test_a_row_keeps_the_label_it_can_support(self):
        # Losing an unsupported partner leaves the graphene form, which is
        # less specific and still true.
        material, form, _, _, _ = E.classify(
            "Binder-Free 3D Zn-Graphene Anode from Zinc Powders and Graphene Oxide",
            "A Zn-graphene anode. In Zn||MnO 2 full batteries, Zn_G helps.",
            "The anode delivered 400 mAh g -1 after 200 cycles.")
        self.assertEqual(material, form)
        self.assertIsNotNone(form)


class AnotherFieldsCyclingTest(unittest.TestCase):

    def test_gas_adsorption_cycling_is_not_battery_cycling(self):
        text = ("This work evaluates the CO2-adsorption relevance and cycling"
                " stability of graphene oxide-silica, retaining 92% after 20"
                " cycles.")
        self.assertIsNone(E.extract_from_sentence(text, "t", text, "abstract"))

    def test_a_real_capacity_retention_is_unaffected(self):
        text = "The electrode retained 92% of its capacity after 500 cycles."
        row = E.extract_from_sentence(text, "t", text, "abstract")
        self.assertAlmostEqual(row["capacity_retention_pct"], 92.0, places=1)


class WhatTheSecondAuditFound(unittest.TestCase):
    """The library was widened to 104,649 papers and audited again. Accuracy
    fell from 66 of 73 to 61 of 73, because the new papers compare materials
    far more than the graphene ones did - and a sentence that compares is full
    of numbers that are not the paper's own result. Every case here is one of
    the twelve rows judged wrong."""

    def cap(self, text):
        row = E.extract_from_sentence(text, "A graphene anode", text, "abstract")
        return None if row is None else row["specific_capacity_mah_g"]

    # --- a bound is not a measurement ---------------------------------

    def test_a_less_than_bound_is_not_a_capacity(self):
        # "<3 mAh/g" is a ceiling on an electrode that did not work.
        self.assertIsNone(self.cap(
            "The electrode with FEC-included electrolyte only exhibited the"
            " specific capacity of <3 mA h g -1 at 100 mA g -1 ."))

    def test_a_measured_minimum_is_still_a_measurement(self):
        # "down to" and "as low as" are results, not bounds.
        self.assertAlmostEqual(self.cap(
            "The electrodes showed a capacity down to 330 mAh g -1 at 1 C."),
            330.0, places=1)

    # --- a figure held up as a failure --------------------------------

    def test_the_control_the_paper_is_arguing_against(self):
        self.assertIsNone(self.cap(
            "However, the bare PTCDI cathode performed an inferior rate"
            " capability and only gained a low discharge capacity of 48"
            " mAh g -1 ."))

    def test_a_capacity_that_faded_away_is_not_the_result(self):
        self.assertIsNone(self.cap(
            "Although the cell based on conductive carbon initially delivered"
            " a high capacity, its capacity faded gradually to ~30 mAh g -1"
            " after 1000 cycles."))

    # --- somebody else's figure, in more wordings ---------------------

    def test_and_coworkers_is_a_credit_like_et_al(self):
        self.assertIsNone(self.cap(
            "Wang and coworkers reported that the pure Bi electrode exhibited"
            " low-temperature behaviour (370 mAh g -1 at 0.02 A g -1 )."))

    def test_a_credit_is_scoped_to_its_sentence_not_a_window(self):
        # Ninety characters sat between the credit and the figure, which is
        # why a window missed it.
        text = ("Zhang and co-workers reported that a similar composite built"
                " from ordinary precursors reached 820 mAh g -1 .")
        self.assertIsNone(self.cap(text))

    def test_the_paper_claiming_the_figure_keeps_it(self):
        # Without this escape the guard eats real results.
        for text in (
            "Unlike previously reported values, our anode delivered 617"
            " mAh g -1 at 100 mA g -1 .",
            "Although Wang et al. reported poor stability, we obtained a"
            " capacity of 820 mAh g -1 after 200 cycles.",
            "In this work the electrode delivered 540 mAh g -1 , higher than"
            " the reported 400 mAh g -1 .",
        ):
            self.assertIsNotNone(self.cap(text), text[:50])

    # --- other fields have retention too ------------------------------

    def test_a_supercapacitor_by_its_abbreviation(self):
        text = ("Excellent cycling stability with a capacity retention of"
                " 90.07% after 3000 cycles proves it is a promising electrode"
                " for SCs.")
        self.assertIsNone(E.extract_from_sentence(text, "t", text, "abstract"))

    def test_a_biosensors_storage_stability_in_days(self):
        text = ("The impedimetric response can retain 92% of their original"
                " activity after 15 d of storage, respectively.")
        self.assertIsNone(E.extract_from_sentence(text, "t", text, "abstract"))

    def test_a_desalination_cell_is_not_a_battery(self):
        text = ("The capacitive deionisation cell retained 60% of its"
                " performance after 100 cycles.")
        self.assertIsNone(E.extract_from_sentence(text, "t", text, "abstract"))

    def test_real_battery_cycling_is_untouched(self):
        for text in (
            "The cell retained 97.1% capacity after 500 cycles at 1 C.",
            "The anode delivered 617 mAh g -1 at 100 mA g -1 after 100 cycles.",
            "C-LIG demonstrates a specific capacity of 330 mA h g -1 at 0.1 A g -1 .",
        ):
            self.assertIsNotNone(
                E.extract_from_sentence(text, "t", text, "abstract"), text[:50])


class AControlsRetention(unittest.TestCase):
    """The failure-and-control guard ran on the capacity and not on the
    retention, so a paper's poor baseline kept its percentage while its
    capacity was correctly refused. Both rows the third full-text audit found
    wrong were this one gap."""

    def test_a_poor_controls_rate_retention_is_not_a_result(self):
        text = ("However, as the current density increased, the PVDF"
                " electrode exhibited poor rate performance, showing a rate"
                " retention of 49% at 1.0 C relative to 0.1 C.")
        self.assertIsNone(E.extract_from_sentence(text, "t", text, "abstract"))

    def test_a_contrasted_failure_keeps_neither_figure(self):
        # The capacity was already refused here; the retention was not.
        text = ("In stark contrast, the Li/P(VDF-TrFE)/NCM712 cells only"
                " exhibited an initial capacity of 80 mAh g -1 , with rapid"
                " capacity decay after just 40 cycles, reaching a retention"
                " rate of 45% at 200 cycles.")
        self.assertIsNone(E.extract_from_sentence(text, "t", text, "abstract"))

    def test_a_decay_mentioned_beside_a_real_result_keeps_the_result(self):
        # The sentence says what it reached and what it fell to. The first is
        # the measurement; only the second is refused.
        text = ("The discharge capacity reached 48 mAh g -1 and gradually"
                " decayed to 36 mAh g -1 with the capacity retention of 75%"
                " over 150 cycles.")
        row = E.extract_from_sentence(text, "t", text, "abstract")
        self.assertAlmostEqual(row["specific_capacity_mah_g"], 48.0, places=1)
        self.assertAlmostEqual(row["capacity_retention_pct"], 75.0, places=1)

    def test_ordinary_retentions_are_untouched(self):
        for text in (
            "The cell retained 97.1% capacity after 500 cycles at 1 C.",
            "The LFP-SWCNT electrode shows a higher specific capacity"
            " retention of 87.4% after 200 cycles at 2 C.",
            "AOH-VO retains 98% of its capacity after 5,000 cycles, with only"
            " a 0.4% decay per 1,000 cycles.",
        ):
            row = E.extract_from_sentence(text, "t", text, "abstract")
            self.assertIsNotNone(row, text[:50])
            self.assertIsNotNone(row["capacity_retention_pct"], text[:50])


class AnAdsorbentIsRegeneratedNotCycled(unittest.TestCase):

    def test_a_regeneration_study_is_not_battery_cycling(self):
        # A copper-adsorption paper, found in the material-label audit.
        text = ("Regeneration studies demonstrated superior reusability of"
                " MGO, which retained ~64% efficiency after five cycles"
                " compared to ~52% for GO.")
        self.assertIsNone(E.extract_from_sentence(text, "t", text, "abstract"))

    def test_recyclability_is_the_same_thing(self):
        text = ("The adsorbent showed good recyclability, retaining 88% of"
                " its capacity after 5 cycles.")
        self.assertIsNone(E.extract_from_sentence(text, "t", text, "abstract"))


class ASupercapacitorByAnyWording(unittest.TestCase):

    def test_capacitive_characteristics_is_a_supercapacitor(self):
        # The guard matched "capacitance" and "supercapacitor" but not this.
        text = ("The electrodes showed the best capacitive characteristics"
                " with 100% capacity retention after 15,000 cycles.")
        row = E.extract_from_sentence(text, "t", text, "abstract")
        if row is not None:
            self.assertTrue(any("capacitance_not_capacity" in f
                                for f in row["flags"]), row["flags"])

    def test_a_battery_retention_is_still_clean(self):
        text = "The cell retained 97.1% capacity after 500 cycles at 1 C."
        row = E.extract_from_sentence(text, "t", text, "abstract")
        self.assertFalse(any("capacitance_not_capacity" in f
                             for f in row["flags"]), row["flags"])


class TheTopOfTheList(unittest.TestCase):
    """The measurements screen sorts by capacity, so the biggest numbers are
    the first a visitor sees - and the biggest numbers are where theoretical
    ceilings, other people's figures and computed predictions collect. Three
    of the top five cards were one of those. A random row was 19 of 20; the
    top of the sort was 2 of 5, because the sort selects for the error."""

    def test_a_capability_is_a_ceiling_not_a_result(self):
        text = ("The cycling stability of high-capacity silicon (Si) anodes"
                " capable of 3579 mAh g-1 in lithium-ion batteries is"
                " hindered by SEI instability.")
        row = E.extract_from_sentence(text, "t", text, "abstract")
        if row is not None:
            self.assertIsNone(row["specific_capacity_mah_g"])

    def test_a_figure_credited_to_another_paper_is_not_taken(self):
        text = ("The cathode exhibits much higher discharge capacity than"
                " that of the reported Mg-MOF-74 (4560 mAh g-1) at the same"
                " current density.")
        row = E.extract_from_sentence(text, "t", text, "abstract")
        if row is not None:
            self.assertIsNone(row["specific_capacity_mah_g"])

    def test_a_computed_capacity_is_flagged(self):
        text = ("We propose that porous 2D materials with planar structure"
                " are promising anodes, following which the B 7 P 2 monolayer"
                " is identified with an ultrahigh capacity of 3117 mA h g-1 .")
        row = E.extract_from_sentence(text, "t", text, "abstract")
        self.assertIsNotNone(row)
        self.assertTrue(any("modelled_not_measured" in f for f in row["flags"]),
                        row["flags"])

    def test_a_measured_figure_beside_a_theoretical_one_survives(self):
        # The escape that keeps the guard from eating real results.
        text = ("Exceeding the theoretical capacity of graphite (372 mAh"
                " g-1), the anode delivered 1250 mAh g-1 at 100 mA g-1 .")
        row = E.extract_from_sentence(text, "t", text, "abstract")
        self.assertAlmostEqual(row["specific_capacity_mah_g"], 1250.0, places=1)

    def test_a_large_but_real_capacity_is_untouched(self):
        # Li-O2 capacities really are thousands of mAh/g.
        text = ("When the current density is increased to 200 mA/g, the"
                " discharge capacity of the Tz-Mg-MOF-74 cathode decreases"
                " to 4907 mAh g-1 .")
        row = E.extract_from_sentence(text, "t", text, "abstract")
        self.assertAlmostEqual(row["specific_capacity_mah_g"], 4907.0, places=1)
        self.assertFalse(any("modelled" in f for f in row["flags"]))


class ASettingIsNotAResult(unittest.TestCase):
    """A capacity can be the number the experimenter chose. "cycle stability
    estimated with a cutoff specific capacity of 600 mAh/g" and "55 cycles at
    a limited capacity of 1000 mAh g-1" are protocol: the cell never reached
    them. Same reasoning as the theoretical-claim guard beside it."""

    def test_a_cutoff_capacity_is_not_stored(self):
        for text in (
            "Furthermore, the cycle stability of the battery was estimated"
            " with a cutoff specific capacity of 600 mAh/g at 200 mA/g.",
            "The catalyst performed appreciable cycle stability up to 55"
            " cycles at a limited capacity of 1000 mAh g-1.",
        ):
            row = E.extract_from_sentence(text, "t", text, "abstract")
            if row is not None:
                self.assertIsNone(row["specific_capacity_mah_g"], text[:60])

    def test_the_retention_beside_a_setting_still_stands(self):
        text = ("At a fixed capacity of 500 mAh g-1, the cell retained 90%"
                " of capacity after 200 cycles.")
        row = E.extract_from_sentence(text, "t", text, "abstract")
        self.assertIsNotNone(row)
        self.assertIsNone(row["specific_capacity_mah_g"])
        self.assertAlmostEqual(row["capacity_retention_pct"], 90.0, places=1)

    def test_a_delivered_capacity_is_unaffected(self):
        for text, want in (
            ("The anode delivered a reversible capacity of 617 mAh g -1 at"
             " 100 mA g -1 after 100 cycles.", 617.0),
            ("It can maintain the reversible capacity of 134 mAh g -1 after"
             " 1000 cycles at 1.0 A g -1 .", 134.0),
            ("The graphite anode has a theoretical capacity of 372 mAh g -1"
             " but delivered 350 mAh g -1 .", 350.0),
        ):
            row = E.extract_from_sentence(text, "t", text, "abstract")
            self.assertAlmostEqual(row["specific_capacity_mah_g"], want, places=1)

    def test_a_density_retention_is_flagged(self):
        text = ("A prototype pouch cell exhibits a high initial energy"
                " density of 401.0 Wh kg -1 with 95.3% retention after 120"
                " cycles.")
        row = E.extract_from_sentence(text, "t", text, "abstract")
        self.assertIsNotNone(row)
        self.assertTrue(any("retention_of_another_quantity" in f
                            for f in row["flags"]), row["flags"])

    def test_a_capacity_retention_beside_a_density_is_not_flagged(self):
        text = ("The cell showed a capacity retention of 87.1% after 1500"
                " cycles and a high energy density of 300 Wh kg -1 .")
        row = E.extract_from_sentence(text, "t", text, "abstract")
        self.assertFalse(any("retention_of_another_quantity" in f
                             for f in row["flags"]), row["flags"])


class TheSourcesOwnMarkers(unittest.TestCase):
    """PubMed leaves a marker where a formula, image or table stood. It is
    shown to whoever reads the source quote, and in one abstract it split
    "10 000 cycles" into "10[Formula: see text]000" and made the count zero."""

    def test_the_marker_is_gone_from_the_stored_sentence(self):
        text = ("After 10[Formula: see text]000 cycles, the 3D CoP/GH keeps a"
                " stable specific capacity retention of 94.11%.")
        stored = E.sentences(text)[0]
        self.assertNotIn("Formula", stored)
        self.assertIn("10 000 cycles", stored)

    def test_a_number_the_marker_split_is_read_whole(self):
        text = ("After 10[Formula: see text]000 cycles, the electrode keeps a"
                " stable specific capacity retention of 94.11%.")
        row = E.extract_from_sentence(E.sentences(text)[0], "t",
                                      E.sentences(text)[0], "abstract")
        self.assertEqual(row["cycle_count"], 10000)
        self.assertAlmostEqual(row["capacity_retention_pct"], 94.11, places=2)

    def test_the_quote_still_verifies_against_the_abstract(self):
        # normalise strips the marker too, so both sides of the check agree.
        abstract = ("We report a composite. After 10[Formula: see text]000"
                    " cycles, the electrode keeps a capacity retention of"
                    " 94.11%. It is promising.")
        rows, _ = E.rows_for_paper(
            {"openalex_id": "W1", "title": "t", "abstract": abstract})
        self.assertTrue(rows)
        self.assertEqual(rows[0]["confidence"] if "confidence" in rows[0]
                         else "verified", rows[0].get("confidence", "verified"))
        self.assertNotIn("Formula", rows[0]["source_quote"])


class RetentionOfWhatAfterWhat(unittest.TestCase):
    """A retention percentage is a battery figure only if what was retained is
    a capacity and what it survived was charge cycling. Three of nineteen
    verified rows in a hand audit were neither: a flexibility test, a solar
    cell's stability, and a stretching test."""

    def assertNoRow(self, text):
        self.assertIsNone(
            E.extract_from_sentence(text, "A graphene anode", text, "abstract"),
            text[:70])

    def test_bending_cycles_are_not_charge_cycles(self):
        self.assertNoRow("The 3D printed MSC exhibits reliable flexibility"
                         " with retention of 90.2% of its original"
                         " capacitance after 500 bending cycles.")
        self.assertNoRow("After 2000 bending cycles the sensor retained 95%"
                         " of its response.")

    def test_a_strain_is_not_a_cycle(self):
        self.assertNoRow("The stretchable MSCs exhibit capacitance retention"
                         " of 77.1% at 50% strain.")
        self.assertNoRow("The device retained 85% of its capacitance at a"
                         " strain of 100%.")

    def test_a_solar_cells_stability_is_not_a_batterys(self):
        self.assertNoRow("The devices exhibit a champion power conversion"
                         " efficiency (PCE) of 24.11% and enhanced UV"
                         " stability, retaining 81% of performance.")

    def test_a_capacitance_retention_is_flagged_not_refused(self):
        # The percentage and the cycle count are a real electrochemical
        # measurement. They are just not a capacity's, and this is the
        # battery table, so the row stays and carries the reason.
        text = ("A symmetric supercapacitor exhibited a volumetric"
                " capacitance of 155 F cm -3 and good stability with ~100%"
                " retention after 10 000 cycles.")
        row = E.extract_from_sentence(text, "t", text, "abstract")
        self.assertIsNotNone(row)
        self.assertEqual(row["capacity_retention_pct"], 100.0)
        self.assertTrue(any("capacitance_not_capacity" in f
                            for f in row["flags"]), row["flags"])

    def test_a_real_capacity_retention_comes_through_clean(self):
        for text in (
            "The electrode retained 97.2% of its capacity after 100 cycles"
            " at 100 mA g -1 .",
            "It achieves cycling stability with nearly 100% capacity"
            " retention over 1100 cycles.",
            "The full cell delivers a capacity retention of 89.7% after 100"
            " cycles at 1C.",
            # The mechanical word is present but is not the kind of cycling.
            "The lattice strain was relieved, and the electrode retained 90%"
            " of its capacity after 500 cycles.",
            "A tensile strain of 2.1% was measured while the anode retained"
            " 88% of its capacity over 300 cycles.",
        ):
            row = E.extract_from_sentence(text, "A graphene anode", text,
                                          "abstract")
            self.assertIsNotNone(row, text[:60])
            self.assertIsNotNone(row["capacity_retention_pct"], text[:60])
            self.assertFalse(any("capacitance_not_capacity" in f
                                 for f in row["flags"]), text[:60])

    def test_a_capacity_in_a_bending_sentence_still_stands(self):
        # Only the retention and the cycle count go; the capacity is real.
        text = ("The anode delivered 617 mAh g -1 and the device survived"
                " 1000 bending cycles.")
        row = E.extract_from_sentence(text, "t", text, "abstract")
        self.assertIsNotNone(row)
        self.assertAlmostEqual(row["specific_capacity_mah_g"], 617.0, places=1)
        self.assertIsNone(row["capacity_retention_pct"])
        self.assertIsNone(row["cycle_count"])


class AnUncertaintyIsNotAValue(unittest.TestCase):

    def test_an_error_bar_is_not_the_capacity(self):
        text = ("The anode delivered a reversible capacity of 617 +- 5 mAh"
                " g -1 at 100 mA g -1 .")
        row = E.extract_from_sentence(text, "t", text, "abstract")
        self.assertIsNotNone(row)
        self.assertAlmostEqual(row["specific_capacity_mah_g"], 617.0, places=1)

    def test_a_capacity_with_no_uncertainty_is_unaffected(self):
        text = "The anode delivered 372 mAh g -1 at 100 mA g -1 ."
        row = E.extract_from_sentence(text, "t", text, "abstract")
        self.assertAlmostEqual(row["specific_capacity_mah_g"], 372.0, places=1)


class OneTableTwoReadings(unittest.TestCase):
    """Abstract rows and full-text rows share the evidence table, and only
    source_section tells them apart. The abstract extractor clears the rows
    for the papers it is about to read, so a pattern fix propagates - and that
    clear has to be scoped, or it takes the full-text rows with it. It did:
    440 rows, silently, on the first run after the full-text pass landed."""

    def test_reading_the_abstracts_leaves_the_full_text_rows_alone(self):
        import extract_evidence as mod
        import db as dbmod
        folder = tempfile.mkdtemp()
        path = os.path.join(folder, "library.db")
        conn = dbmod.init(path)
        conn.execute(
            "INSERT INTO papers(openalex_id, title, abstract, year,"
            " citations_per_year) VALUES(?,?,?,?,?)",
            ("W1", "A graphene anode",
             "The anode delivered a reversible capacity of 617 mAh g-1 at"
             " 100 mA g-1 after 100 cycles.", 2024, 5.0))
        conn.execute(
            "INSERT INTO evidence(openalex_id, specific_capacity_mah_g,"
            " source_quote, source_section, confidence, row_hash)"
            " VALUES(?,?,?,?,?,?)",
            ("W1", 128.1, "read from deep inside the paper", "fulltext",
             "verified", "hash-from-full-text"))
        conn.commit()
        conn.close()

        argv = sys.argv
        try:
            sys.argv = ["extract_evidence.py", "--db", path]
            mod.main()
        finally:
            sys.argv = argv

        check = sqlite3.connect(path)
        kept = check.execute(
            "SELECT count(*) FROM evidence WHERE source_section='fulltext'"
        ).fetchone()[0]
        from_abstract = check.execute(
            "SELECT count(*) FROM evidence WHERE source_section='abstract'"
        ).fetchone()[0]
        check.close()
        shutil.rmtree(folder, ignore_errors=True)
        self.assertEqual(kept, 1, "the full-text row was deleted")
        self.assertGreaterEqual(from_abstract, 1, "the abstract was not read")


if __name__ == "__main__":
    unittest.main()
