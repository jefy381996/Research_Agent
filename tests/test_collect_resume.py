"""A collection run that is cut off must keep what it already fetched.

OpenAlex meters requests. A run that pages for twenty minutes and is then
refused used to call sys.exit from inside the page fetcher, which threw away
every paper already in hand: 82,849 of them, on the run that prompted these
tests. The collector now writes what it has and records which searches
finished, so the next run resumes instead of paying for the same pages again.
"""
import csv
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

import collect_papers as cp


def work(n, label_year=2023):
    """The few OpenAlex fields flatten() actually reads."""
    return {
        "id": f"https://openalex.org/W{n}",
        "doi": f"https://doi.org/10.1000/test.{n}",
        "title": f"Graphene paper {n}",
        "publication_year": label_year,
        "publication_date": f"{label_year}-01-01",
        "cited_by_count": 100 - n,
        "type": "article",
        "primary_location": {"source": {"display_name": "Test Journal",
                                        "host_organization_name": "Test Press"}},
        "best_oa_location": {"license": "cc-by", "landing_page_url": "x"},
        "open_access": {"is_oa": True, "oa_status": "gold"},
        "authorships": [{"author": {"display_name": "A Researcher"}}],
        "abstract_inverted_index": {"Graphene": [0], "is": [1], "carbon": [2]},
    }


SEARCHES = [("one", "title.search:a", None),
            ("two", "title.search:b", None),
            ("three", "title.search:c", None)]


class Harness(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.csv = os.path.join(self.dir, "papers.csv")
        self.prog = os.path.join(self.dir, "progress.json")
        self._searches = cp.SEARCHES
        self._fetch = cp.fetch_page
        self._env = cp.load_env
        cp.SEARCHES = SEARCHES
        cp.load_env = lambda *a, **k: None      # never read the real .env
        self.calls = []

    def tearDown(self):
        cp.SEARCHES = self._searches
        cp.fetch_page = self._fetch
        cp.load_env = self._env

    def fetch(self, stop_on=None):
        """One page per search; optionally refuse when a label is reached."""
        def inner(session, query_filter, cursor, key):
            self.calls.append(query_filter)
            if stop_on and stop_on in query_filter:
                raise cp.CollectionStopped("budget exhausted (simulated)")
            n = len(self.calls) * 10
            return {"meta": {"count": 1, "next_cursor": None},
                    "results": [work(n)]}
        return inner

    def run_main(self, extra=()):
        argv = sys.argv
        sys.argv = ["collect_papers.py", "--out", self.csv,
                    "--progress", self.prog, *extra]
        buf = io.StringIO()
        code = None
        try:
            with redirect_stdout(buf):
                cp.main()
        except SystemExit as exc:
            code = exc.code
        finally:
            sys.argv = argv
        return code, buf.getvalue()

    def rows(self):
        if not os.path.exists(self.csv):
            return []
        with open(self.csv, newline="", encoding="utf-8") as fh:
            return list(csv.DictReader(fh))

    def progress(self):
        if not os.path.exists(self.prog):
            return None
        with open(self.prog, encoding="utf-8") as fh:
            return json.load(fh)


class TestStopKeepsWork(Harness):
    def test_a_stop_writes_the_rows_already_collected(self):
        cp.fetch_page = self.fetch(stop_on="title.search:c")
        code, out = self.run_main()
        self.assertIsNotNone(code, "a cut-off run must exit non-zero")
        self.assertIn("STOPPED EARLY", str(code))
        self.assertEqual(len(self.rows()), 2,
                         "the two finished searches' papers must be on disk")

    def test_a_stop_records_only_the_finished_searches(self):
        cp.fetch_page = self.fetch(stop_on="title.search:c")
        self.run_main()
        self.assertEqual(self.progress()["done"], ["one", "two"])

    def test_the_message_says_how_to_resume(self):
        cp.fetch_page = self.fetch(stop_on="title.search:c")
        code, _ = self.run_main()
        self.assertIn("Re-run", str(code))
        self.assertIn("resume", str(code))

    def test_nothing_collected_at_all_still_records_progress(self):
        cp.fetch_page = self.fetch(stop_on="title.search:a")
        code, _ = self.run_main()
        self.assertIn("STOPPED", str(code))
        self.assertEqual(self.progress()["done"], [])


class TestResume(Harness):
    def test_resume_skips_what_was_already_paid_for(self):
        cp.fetch_page = self.fetch(stop_on="title.search:c")
        self.run_main()
        first = len(self.calls)

        self.calls = []
        cp.fetch_page = self.fetch()
        code, out = self.run_main()
        self.assertIsNone(code, f"the resumed run should finish: {out}")
        self.assertTrue(all("title.search:c" in q for q in self.calls),
                        f"only the unfinished search may be fetched: {self.calls}")
        self.assertGreater(first, 0)

    def test_resume_keeps_the_earlier_rows_and_adds_its_own(self):
        cp.fetch_page = self.fetch(stop_on="title.search:c")
        self.run_main()
        cp.fetch_page = self.fetch()
        self.run_main()
        ids = {r["openalex_id"] for r in self.rows()}
        self.assertEqual(len(ids), 3, "two from the first run, one from the second")

    def test_a_finished_run_clears_the_record(self):
        cp.fetch_page = self.fetch()
        code, _ = self.run_main()
        self.assertIsNone(code)
        self.assertIsNone(self.progress(), "a clean finish leaves no progress file")

    def test_restart_ignores_the_record(self):
        cp.fetch_page = self.fetch(stop_on="title.search:c")
        self.run_main()
        self.calls = []
        cp.fetch_page = self.fetch()
        self.run_main(extra=["--restart"])
        self.assertEqual(len(self.calls), 3, "every search runs again")

    def test_an_already_complete_record_is_not_an_error(self):
        cp.fetch_page = self.fetch()
        self.run_main()
        # Simulate being killed after the last search, before the clear.
        cp.save_progress(self.prog, {"one", "two", "three"})
        self.calls = []
        code, out = self.run_main()
        self.assertIsNone(code, f"this must not be an error: {out}")
        self.assertIn("already done", out)
        self.assertEqual(self.calls, [], "and must cost nothing")

    def test_an_unreadable_record_is_ignored_not_fatal(self):
        with open(self.prog, "w", encoding="utf-8") as fh:
            fh.write("{ this is not json")
        cp.fetch_page = self.fetch()
        code, out = self.run_main()
        self.assertIsNone(code, f"a corrupt record must not stop the run: {out}")
        self.assertEqual(len(self.rows()), 3)


class TestStopIsNotAnExit(unittest.TestCase):
    def test_the_fetcher_raises_rather_than_exiting(self):
        """The bug was sys.exit inside fetch_page. Guard against its return."""
        import inspect
        src = inspect.getsource(cp.fetch_page)
        self.assertNotIn("sys.exit", src,
                         "fetch_page must raise CollectionStopped, never exit, "
                         "or a refused request discards the whole run again")
        self.assertIn("CollectionStopped", src)


if __name__ == "__main__":
    unittest.main()
