"""A body is not a longer abstract.

Read with the abstract extractors unchanged, twenty-two full-text rows were
judged by hand and about a third were wrong - not wrong numbers, wrong owners.
Every sentence below is one of those twenty-two, verbatim from a collected
paper. The half that must survive matters as much as the half that must not:
a guard that refuses everything would pass a one-sided test.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import extract_fulltext as F
import extract_properties as P
import extract_evidence as E

TITLE = "Graphene oxide composites for energy storage"


def rows(sentence, guard=True):
    """What one sentence contributes, guards on or off."""
    ev, pr, refused = F.findings("W1", TITLE, sentence, cap=30, guard=guard)
    return ev, pr, refused


class NotThisPapersMeasurement(unittest.TestCase):
    """Each of these produced a row that a researcher would call wrong."""

    def assertRefused(self, sentence):
        ev, pr, refused = rows(sentence)
        self.assertEqual(
            (ev, pr), ([], []),
            f"kept a row it should have refused: {sentence[:90]}")

    def test_a_typical_upper_bound_is_not_a_measurement(self):
        self.assertRefused(
            "The thermal conductivity of isostatically compressed carbon-based"
            " building blocks is typically less than 200 W m -1 K -1 , which"
            " limits their directional heat-transfer capability.")

    def test_a_standards_minimum_is_not_a_measurement(self):
        self.assertRefused(
            "The use of light aggregate made the splitting tensile strength of"
            " the mixture lower than that of ordinary weight concrete, but it"
            " conformed to the requirement of ASTM C330, stating that the"
            " minimum splitting tensile strength shall be 2 MPa.")

    def test_a_list_of_known_virtues_is_not_an_experiment(self):
        self.assertRefused(
            "It has some unique properties such as an electron mobility"
            " exceeding (15000 cm 2 V -1 s -1 ) at room temperature, thermal"
            " conductivity about (5000 W m -1 K -1 ) and a high surface area"
            " (2630 m 2 g -1 ) which this surface is higher than others.")

    def test_another_materials_modulus_from_an_introduction(self):
        self.assertRefused(
            "As one of the third hardest materials known in nature, boron"
            " carbide (B 4 C) is often prized for its eminent physical and"
            " mechanical properties, including extreme hardness (27.4 to 37.7"
            " GPa), and high elastic modulus (460 GPa) ( - ).")

    def test_a_figure_credited_to_another_group(self):
        self.assertRefused(
            "In 2012, Komaba et al. pioneered the work of examining the"
            " electrochemical performance of Sn as anode for SIBs, which"
            " delivered a high capacity of 500 mAh g -1 .")

    def test_the_before_value_of_a_comparison(self):
        self.assertRefused(
            "The results confirmed that the total shielding effectiveness"
            " increased from 17 dB to 30 dB, 37 dB, 42 dB and 46 dB for the"
            " samples containing 4, 8, 12, 16 and 20 wt% of RGO-2.")

    def test_the_control_samples_strength(self):
        self.assertRefused(
            "For the PG scaffold, the tensile strength and modulus increased"
            " from 6.3 MPa and 509.5 MPa for the PLLA scaffold to 8.4 MPa and"
            " 1186.8 MPa, respectively.")


class ThisPapersMeasurement(unittest.TestCase):
    """Each of these is a real result and has to come through."""

    def assertKept(self, sentence, key=None, value=None):
        ev, pr, refused = rows(sentence)
        self.assertTrue(ev or pr,
                        f"refused a real measurement: {sentence[:90]}")
        if key:
            got = [r for r in pr if r["property_key"] == key]
            self.assertEqual(len(got), 1, f"{key} from {sentence[:70]}")
            if value is not None:
                self.assertAlmostEqual(got[0]["value"], value, places=2)

    def test_a_measured_capacitance(self):
        self.assertKept(
            "The sample had a capacitance of 230 F g -1 at a current density"
            " of 1 A g -1 and a high energy density of 62.6 W h kg -1 .",
            "capacitance", 230.0)

    def test_a_measured_capacitance_with_no_separator(self):
        self.assertKept(
            "The obtained material displayed 264 Fg -1 at a current density"
            " of 0.4 A g -1 in 0.1 M LiClO 4 .", "capacitance", 264.0)

    def test_a_measured_hall_mobility(self):
        self.assertKept(
            "The Hall mobility at 300 K was calculated as ~58,000 cm 2 V -1"
            " s -1 , and the carrier concentration was about 8.4 x 10 10 cm"
            " -2 , indicating excellent electrical properties of graphene.",
            "carrier_mobility", 58000.0)

    def test_a_measured_sheet_resistance_at_the_top_of_a_range(self):
        self.assertKept(
            "For PMMA-transferred graphene, the measured sheet resistances"
            " varied broadly from 446 to 916 Ohm per square (average = 600"
            " +- 95 Ohm per square).", "sheet_resistance")

    def test_the_after_value_of_a_comparison(self):
        # The same from-to shape as the refused tests, read from the other end.
        self.assertKept(
            "When the specific surface area was divided into micropores and"
            " external pores, the surface area of the micropores increased"
            " from 115.2 to 367.2 m 2 /g after the second activation.",
            "surface_area", 367.2)

    def test_two_properties_in_one_sentence_is_ordinary(self):
        self.assertKept(
            "The sw-GS/PW composites displayed high cross-plane and in-plane"
            " thermal conductivities of 2.58 and 1.78 W m -1 K -1 ,"
            " respectively, at a low filler loading of 2.25 vol%.",
            "thermal_conductivity")

    def test_a_measured_capacity_with_its_conditions(self):
        ev, pr, _ = rows(
            "For the K+ storage performance, within the 0.001-3 V window,"
            " KTNO/rGO-12 achieved a first charge of 128.1 mAh g -1 and a"
            " second discharge capacity of 125.7 mAh g -1 at 20 mA g -1 .")
        self.assertEqual(len(ev), 1)
        self.assertAlmostEqual(ev[0]["specific_capacity_mah_g"], 128.1, places=1)

    def test_a_measured_capacity_with_rate_and_retention(self):
        ev, pr, _ = rows(
            "As a result, the Sb PHMS anode delivered a high reversible"
            " capacity of 617 mAh g -1 at 100 mA g -1 and remained a capacity"
            " of 97.2% at 100 mA g -1 after 100 cycles.")
        self.assertEqual(len(ev), 1)
        self.assertAlmostEqual(ev[0]["specific_capacity_mah_g"], 617.0, places=1)


class QuotedRatherThanMeasured(unittest.TestCase):
    """Second audit of twenty guarded rows found six more wrong. These are
    those six, and the rows that had to keep coming through alongside them."""

    def test_graphenes_textbook_surface_area_is_flagged_not_trusted(self):
        text = ("The enormous surface area of graphene roughly 2630 m 2 /g"
                " improves its ability to interact with other molecules .")
        _, pr, _ = rows(text)
        self.assertEqual(len(pr), 1)
        # Kept, because a real activated carbon can measure near it - but
        # flagged, and the answer path serves verified rows only.
        self.assertEqual(pr[0]["confidence"], "flagged")
        self.assertIn("quoted_textbook_value", pr[0]["flags"])

    def test_graphenes_textbook_mobility_is_flagged_not_trusted(self):
        text = ("Graphene has an ultra-fast migration speed (up to 200,000"
                " cm 2 /V s) at room temperature and a high surface area.")
        _, pr, _ = rows(text)
        self.assertEqual([r["confidence"] for r in pr], ["flagged"])

    def test_a_measured_mobility_is_not_marked_as_quoted(self):
        # Every property row read from a body is flagged - the audits put them
        # at about two thirds right - so what separates them is the reason.
        # A measured figure must not be marked as one the field quotes.
        text = ("The device demonstrated hole and electron mobilities of 3584"
                " and 3132 cm 2 V -1 s -1 , respectively.")
        _, pr, _ = rows(text)
        self.assertEqual(len(pr), 1)
        self.assertNotIn("quoted_textbook_value", pr[0]["flags"])
        self.assertIn("read_from_paper_body", pr[0]["flags"])

    def test_every_property_row_from_a_body_is_flagged(self):
        # The answer path serves verified rows only, so this is what keeps a
        # two-thirds-right row out of an answer.
        for text in (
            "M-TiO 2 @rGO presented a specific surface area of 174 m 2 g -1 .",
            "The BJH surface area was measured to be about 617 m 2 /g.",
            "The obtained material displayed 264 F g -1 at 0.4 A g -1 .",
        ):
            _, pr, _ = rows(text)
            self.assertTrue(pr, text)
            self.assertEqual([r["confidence"] for r in pr], ["flagged"], text)

    def test_a_battery_finding_from_a_body_can_still_be_verified(self):
        # The same audits put these at about seven eighths right, so they are
        # not flagged wholesale: plausibility decides, as it does for an
        # abstract.
        ev, _, _ = rows(
            "As a result, the Sb PHMS anode delivered a high reversible"
            " capacity of 617 mAh g -1 at 100 mA g -1 .")
        self.assertEqual(len(ev), 1)
        self.assertNotEqual(ev[0].get("confidence"), "flagged")

    def test_the_neat_resins_modulus_is_not_the_composites(self):
        # Caught by the property reader now rather than here: the guard moved
        # into the shared module when the audit found the same class in rows
        # read from abstracts. What matters is that the row does not come
        # through; which layer refuses it is an implementation detail.
        ev, pr, _ = rows(
            "The tensile modulus of neat epoxy is 2.89 GPa, while for"
            " epoxy/GNP nanocomposites it varies between 2.65 and 3.36 GPa.")
        self.assertEqual((ev, pr), ([], []))

    def test_an_optical_filters_transmittance_is_not_the_materials(self):
        ev, pr, refused = rows(
            "5 mW laser power at 532 nm attenuated by using a neutral density"
            " filter of 50% transmittance at the objective was used.")
        self.assertEqual((ev, pr), ([], []))
        self.assertIn("instrument", refused[0][0])

    def test_laser_induced_graphene_is_a_material_not_an_instrument(self):
        # "Laser" is not in the instrument vocabulary for exactly this reason.
        self.assertTrue(rows(
            "The sheet resistance decreased from 340 to 20 Ohm per square"
            " with the increase in laser fluence.")[1])


class StrippedCitationsAndControls(unittest.TestCase):
    """A fourth audit found five more wrong, three of them marked by nothing
    but an empty bracket where the citation used to be."""

    def test_an_empty_bracket_is_a_stripped_citation(self):
        ev, pr, refused = rows(
            "The transmittance of the Ag NW/PDMS film reaches 76.8%, and"
            " shielding effectiveness of that is 42.5 dB [ ].")
        self.assertEqual((ev, pr), ([], []))
        self.assertIn("citation", refused[0][0])

    def test_the_specimen_without_the_filler_is_the_control(self):
        for text in (
            "The specimens without GO obtained an elastic modulus of 19.88"
            " GPa, which was lower than normal weight concrete.",
            "The film without graphene nanosheets reached a tensile strength"
            " of 12 MPa only.",
        ):
            ev, pr, _ = rows(text)
            self.assertEqual((ev, pr), ([], []), text[:60])

    def test_leaving_out_a_binder_is_not_a_control(self):
        # The thing left out has to be the paper's own subject, or every
        # binder-free electrode in the library would be read as a control.
        self.assertTrue(rows(
            "The electrode was measured without any binder and reached a"
            " capacitance of 320 F g -1 .")[1])

    def test_a_figure_compared_away_from_is_a_baseline(self):
        ev, pr, _ = rows(
            "The significantly increased specific surface area from GO (832"
            " m 2 /g) to RGO has facilitated the MB adsorption.")
        self.assertEqual((ev, pr), ([], []))


class MaterialComesFromTheSentence(unittest.TestCase):
    """The whole-body fallback is what mislabelled rows in the first place."""

    def test_a_sentence_naming_no_material_does_not_inherit_from_the_body(self):
        body = ("Silicon anodes are widely studied. " * 40
                + "The obtained material displayed 264 F g -1 in KOH.")
        _, pr, _ = F.findings("W1", TITLE, body, cap=30)
        got = [r for r in pr if r["property_key"] == "capacitance"]
        self.assertEqual(len(got), 1)
        # Read as an abstract, "Si" would be picked up from 40 mentions of
        # silicon elsewhere in the body and filed as this row's material.
        self.assertNotIn("Si", (got[0]["material"] or ""))

    def test_the_guards_can_be_turned_off_for_comparison(self):
        # --no-guards turns off the guards in this pass. The ones that moved
        # into the shared reader stay on, because a control sample or a bound
        # is wrong in an abstract too - which is what the audit showed.
        # A sentence only this pass's guards catch. "typically less than 200
        # W/mK" no longer serves: it is a general claim and a bound, and the
        # bound guard is one of the shared ones, so it goes either way.
        sentence = ("As one of the hardest materials known, boron carbide is"
                    " often prized for its properties, including a high"
                    " elastic modulus of 460 GPa.")
        self.assertEqual(rows(sentence, guard=True)[1], [])
        self.assertTrue(rows(sentence, guard=False)[1])

    def test_a_shared_guard_stays_on_either_way(self):
        sentence = ("All samples improved compared to pure rGO and MoS 2 ,"
                    " which were 82.5 Ohm/sq and 48.9 Ohm/sq.")
        self.assertEqual(rows(sentence, guard=False)[1], [])


if __name__ == "__main__":
    unittest.main()
