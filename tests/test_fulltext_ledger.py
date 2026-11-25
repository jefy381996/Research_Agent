"""The record of what was asked for has to outlive the container.

Collecting full text is days of work against somebody else's server. The
bodies it fetches are large and do not need keeping - they are read into
measurements in the same run and the measurements are what ship - so the file
holding them is not committed. The ledger of which papers were tried, and what
came back, is a few hundred kilobytes and is the only record of that work.

Kept inside the uncommitted file, as it was, a reclaimed container threw away
three thousand attempts and the next run asked Europe PMC for all of them
again. These tests hold the ledger separate and durable.
"""
import gzip
import io
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import collect_fulltext as cf


class TheLedger(unittest.TestCase):

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.ledger = os.path.join(self.dir, "tried.csv.gz")
        self.store = sqlite3.connect(os.path.join(self.dir, "fulltext.db"))
        cf.ensure_table(self.store)

    def tearDown(self):
        self.store.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def tried(self, store=None):
        store = store or self.store
        return {r[0] for r in store.execute(
            "SELECT openalex_id FROM fulltext_tried")}

    def add(self, *pairs):
        self.store.executemany(
            "INSERT OR REPLACE INTO fulltext_tried(openalex_id, outcome,"
            " tried_at) VALUES(?,?,?)",
            [(w, o, "2026-11-25T00:00:00Z") for w, o in pairs])
        self.store.commit()

    def test_what_is_written_comes_back(self):
        self.add(("W1", "got"), ("W2", "no-record"), ("W3", "server-error"))
        self.assertEqual(cf.save_ledger(self.store, self.ledger), 3)
        fresh = sqlite3.connect(os.path.join(self.dir, "other.db"))
        cf.ensure_table(fresh)
        self.assertEqual(cf.load_ledger(fresh, self.ledger), 3)
        self.assertEqual(self.tried(fresh), {"W1", "W2", "W3"})
        outcomes = dict(fresh.execute(
            "SELECT openalex_id, outcome FROM fulltext_tried"))
        self.assertEqual(outcomes["W3"], "server-error")
        fresh.close()

    def test_a_container_with_no_bodies_still_knows_what_was_asked(self):
        # The case this exists for: the text file is gone, the ledger is not.
        self.add(*[(f"W{i}", "got") for i in range(50)])
        cf.save_ledger(self.store, self.ledger)
        fresh = sqlite3.connect(os.path.join(self.dir, "rebuilt.db"))
        cf.ensure_table(fresh)
        self.assertEqual(
            fresh.execute("SELECT count(*) FROM paper_fulltext").fetchone()[0], 0)
        cf.load_ledger(fresh, self.ledger)
        self.assertEqual(len(self.tried(fresh)), 50)
        fresh.close()

    def test_loading_does_not_overwrite_a_newer_attempt(self):
        # The run in progress knows more than the committed copy.
        self.add(("W1", "server-error"))
        cf.save_ledger(self.store, self.ledger)
        self.add(("W1", "got"))
        cf.load_ledger(self.store, self.ledger)
        self.assertEqual(self.store.execute(
            "SELECT outcome FROM fulltext_tried WHERE openalex_id='W1'"
        ).fetchone()[0], "got")

    def test_no_ledger_is_not_an_error(self):
        self.assertEqual(cf.load_ledger(self.store, self.ledger), 0)

    def test_a_broken_ledger_costs_requests_not_correctness(self):
        with open(self.ledger, "wb") as fh:
            fh.write(b"this is not a gzip file")
        self.assertEqual(cf.load_ledger(self.store, self.ledger), 0)

    def test_it_is_written_atomically(self):
        # A run cut off mid-write must not leave a truncated ledger behind.
        self.add(("W1", "got"))
        cf.save_ledger(self.store, self.ledger)
        self.assertFalse(os.path.exists(self.ledger + ".tmp"))
        with gzip.open(self.ledger, "rt", encoding="utf-8") as fh:
            self.assertIn("W1", fh.read())

    def test_it_stays_small_enough_to_commit(self):
        self.add(*[(f"W{i}", "no-record") for i in range(36_000)])
        cf.save_ledger(self.store, self.ledger)
        size = os.path.getsize(self.ledger)
        self.assertLess(size, 5_000_000,
                        f"{size/1e6:.1f} MB is too big to keep committing")


class TheShippedLedger(unittest.TestCase):

    def test_the_real_ledger_is_present_and_small(self):
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        path = os.path.join(root, cf.LEDGER)
        if not os.path.exists(path):
            self.skipTest("no collection has run in this checkout")
        self.assertLess(os.path.getsize(path), 5_000_000)


if __name__ == "__main__":
    unittest.main()
