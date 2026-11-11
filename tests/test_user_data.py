"""A researcher's own data must not touch the server.

This deployment has no login. Anything written to the database would be
readable by everyone holding the link, and unpublished results are exactly
what a researcher would be adding. The extraction endpoints therefore read and
return; they store nothing, and these tests are what keeps that true.

The second property matters just as much: a figure somebody supplied must
never become countable as published evidence. Keeping the server stateless
makes that true by construction, and the counts below prove it.
"""
import unittest

import api
import db


def counts():
    conn = db.connect()
    try:
        return {t: conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
                for t in ("papers", "evidence", "properties", "chunks",
                          "paper_sections", "user_documents")}
    finally:
        conn.close()


SAMPLE = (
    "The Si/rGO composite anode delivered a reversible capacity of 1842 mAh g-1 "
    "at 200 mA g-1 and retained 87% of it after 500 cycles. The electrode showed "
    "a thermal conductivity of 12.6 W/mK and a sheet resistance of 48 ohm/sq."
)


class TestNothingIsStored(unittest.TestCase):
    def test_extraction_writes_nothing_to_the_database(self):
        before = counts()
        result = api._extract(SAMPLE, "someone's unpublished run")
        after = counts()
        self.assertEqual(before, after,
                         "extraction must not write to any table")
        self.assertTrue(result["evidence"] or result["properties"])
        self.assertFalse(result["stored"])

    def test_the_library_totals_do_not_move(self):
        """A supplied figure is never countable as published evidence."""
        before = api.get_stats()
        api._extract(SAMPLE, "run 14")
        after = api.get_stats()
        for key in ("evidence_rows", "property_rows", "papers", "verified"):
            self.assertEqual(before[key], after[key], key)

    def test_no_upload_route_survives_that_would_store_anything(self):
        routes = {getattr(r, "path", "") for r in api.app.routes}
        self.assertNotIn("/api/upload", routes)
        self.assertNotIn("/api/documents", routes)
        self.assertIn("/api/extract/text", routes)
        self.assertIn("/api/extract/pdf", routes)


class TestWhatItReads(unittest.TestCase):
    def test_it_finds_both_kinds_of_figure(self):
        r = api._extract(SAMPLE, "run 14")
        self.assertEqual(len(r["evidence"]), 1)
        self.assertEqual(r["evidence"][0]["specific_capacity_mah_g"], 1842.0)
        self.assertEqual(r["evidence"][0]["cycle_count"], 500)
        keys = {p["property_key"] for p in r["properties"]}
        self.assertIn("thermal_conductivity", keys)
        self.assertIn("sheet_resistance", keys)

    def test_every_figure_arrives_with_the_sentence_it_came_from(self):
        """The same contract the library is held to."""
        r = api._extract(SAMPLE, "run 14")
        for row in r["evidence"]:
            self.assertIn(str(int(row["specific_capacity_mah_g"])),
                          row["source_quote"])
        for row in r["properties"]:
            self.assertTrue(row["source_quote"])
            self.assertIn(row["value_as_reported"].split()[0],
                          row["source_quote"])

    def test_text_too_short_is_refused(self):
        with self.assertRaises(Exception):
            api._extract("too short", "x")

    def test_prose_with_no_figures_yields_nothing_rather_than_guessing(self):
        r = api._extract(
            "Graphene was prepared by chemical vapour deposition on copper foil "
            "and transferred onto a silicon wafer for further study.", "x")
        self.assertEqual(r["evidence"], [])
        self.assertEqual(r["properties"], [])


if __name__ == "__main__":
    unittest.main()
