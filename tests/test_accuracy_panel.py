"""The one claim on the screen that a reader can check without trusting anyone.

Every research tool says it is accurate. This one prints how accurate, how
big the sample was and when it was measured, and ships the tool that draws
the sample so the figure can be reproduced. These tests hold that honest:
the sample size travels with the figure, and the size of the library does
not appear, because the screen deliberately never states it.
"""
import io
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import audit_accuracy
import db

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class RecordingAnAudit(unittest.TestCase):

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "library.db")
        conn = db.init(self.path)
        audit_accuracy.ensure(conn)
        for i in range(40):
            conn.execute(
                "INSERT INTO papers(openalex_id, title, year) VALUES(?,?,?)",
                (f"W{i}", f"Paper {i}", 2024))
            conn.execute(
                "INSERT INTO evidence(openalex_id, material_system,"
                " specific_capacity_mah_g, source_quote, confidence, row_hash)"
                " VALUES(?,?,?,?,?,?)",
                (f"W{i}", "Si/graphene", 600 + i, f"It delivered {600+i} mAh/g.",
                 "verified", f"h{i}"))
        conn.commit()
        self.conn = conn

    def tearDown(self):
        self.conn.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_the_same_seed_draws_the_same_rows(self):
        # An auditor hands the seed to somebody else and they check the same
        # twenty rows. Without that the figure cannot be reproduced.
        _, _, a = audit_accuracy.draw(self.conn, "battery", 10, 42)
        _, _, b = audit_accuracy.draw(self.conn, "battery", 10, 42)
        _, _, c = audit_accuracy.draw(self.conn, "battery", 10, 43)
        self.assertEqual([r["row_hash"] for r in a], [r["row_hash"] for r in b])
        self.assertNotEqual([r["row_hash"] for r in a], [r["row_hash"] for r in c])

    def test_a_verdict_is_stored_with_its_sample_size(self):
        # A count on its own is a claim; a count out of a sample is a measurement.
        self.conn.execute(
            "INSERT INTO accuracy_audit(population, label, rows_total, sample,"
            " right_, unclear, audited_at, judged_by)"
            " VALUES('battery','Battery findings',40,20,19,0,'2026-11-24','hand')")
        self.conn.commit()
        row = self.conn.execute("SELECT * FROM accuracy_audit").fetchone()
        self.assertEqual(row["sample"], 20)
        self.assertEqual(row["right_"], 19)
        self.assertTrue(row["audited_at"])

    def test_every_population_names_a_table_that_exists(self):
        for name, spec in audit_accuracy.POPULATIONS.items():
            self.conn.execute(
                f"SELECT count(*) FROM {spec['table']} WHERE {spec['where']}")


class WhatTheScreenSays(unittest.TestCase):

    def read(self, name):
        return io.open(os.path.join(ROOT, name), encoding="utf-8").read()

    def test_the_panel_prints_the_sample_size_beside_the_figure(self):
        js = self.read("web/app.js")
        self.assertIn("${head.right} of ${head.sample}", js)
        self.assertIn("a.right} of ${a.sample}", js)

    def test_the_panel_does_not_print_the_size_of_the_library(self):
        # The screen states no figure for how much is in the library. The
        # accuracy panel is the one place that could have leaked one.
        js = self.read("web/app.js")
        start = js.index("function paintAccuracy()")
        end = js.index("function setMode(")
        panel = js[start:end]
        self.assertNotIn("a.rows", panel,
                         "the panel is about to print the size of the library")

    def test_the_panel_says_the_sample_is_small(self):
        js = self.read("web/app.js")
        self.assertIn("small sample", js)

    def test_the_panel_says_how_to_repeat_it(self):
        js = self.read("web/app.js")
        self.assertIn("same seed gives the same rows", js)


if __name__ == "__main__":
    unittest.main()
