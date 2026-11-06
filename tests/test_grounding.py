"""The library must answer what it holds and refuse what it does not.

This is the brief's rule 4 as an executable check: a question the corpus does
not cover has to return "not found" rather than a plausible-sounding guess.
"""
import unittest

import answer
import db
import search

IN_SCOPE = [
    "What capacity do silicon graphene anodes reach in lithium-ion batteries?",
    "capacity retention of sulfur rGO cathodes in lithium-sulfur",
    "How many cycles do sodium-ion graphene anodes survive?",
    "coulombic efficiency of silicon graphene anodes",
    "Do graphene separators stop lithium dendrites?",
]
OUT_OF_SCOPE = [
    "What is the melting point of tungsten?",
    "Who won the 2022 football world cup?",
    "What is the best pizza topping?",
    "How do I file a UK tax return?",
    "What is the capital of Mongolia?",
    "Write me a poem about the sea.",
]


class TestGrounding(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.conn = db.connect()
        if cls.conn.execute("SELECT count(*) FROM evidence").fetchone()[0] == 0:
            raise unittest.SkipTest("database is empty; run the pipeline first")

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def test_in_scope_questions_are_answered_from_the_library(self):
        for question in IN_SCOPE:
            with self.subTest(question=question):
                result = answer.answer(question, conn=self.conn)
                self.assertEqual(result["status"], "answered")
                self.assertTrue(result["citations"],
                                "an answer must cite the sentences behind it")

    def test_out_of_scope_questions_are_refused(self):
        for question in OUT_OF_SCOPE:
            with self.subTest(question=question):
                result = answer.answer(question, conn=self.conn)
                self.assertEqual(result["status"], "not_found")
                self.assertEqual(result["citations"], [])
                self.assertIn("not found", result["summary"].lower())

    def test_every_cited_number_appears_in_its_own_quote(self):
        """A cited figure must be findable in the sentence beside it.

        Where the stored value is a unit conversion the citation carries the
        paper's own wording as "(reported as 0.2 A g-1)", and it is that
        wording which has to appear in the quote.
        """
        import re
        for question in IN_SCOPE[:3]:
            result = answer.answer(question, conn=self.conn)
            for citation in result["citations"]:
                quote = citation["quote"] or ""
                for label, value in citation["values"].items():
                    reported = re.search(r"\(reported as (.+)\)$", value)
                    digits = (reported.group(1) if reported else value).split()[0]
                    whole = digits.split(".")[0]
                    self.assertTrue(
                        digits in quote or whole in quote,
                        f"{label} {value} is absent from its quote: {quote[:120]}")

    def test_a_non_quantitative_question_does_not_return_a_number(self):
        result = answer.answer("Do graphene separators stop lithium dendrites?",
                               conn=self.conn)
        self.assertEqual(result["statistics"], {},
                         "a mechanism question must not be answered with a median")

    def test_retrieval_returns_nothing_for_vocabulary_the_corpus_lacks(self):
        self.assertEqual(search.search("zzzzqqq nonexistentterm", conn=self.conn), [])


class TestStoredEvidenceIntegrity(unittest.TestCase):
    """Properties that must hold across every stored row, not a sample."""

    @classmethod
    def setUpClass(cls):
        cls.conn = db.connect()
        cls.rows = cls.conn.execute(
            "SELECT * FROM evidence").fetchall()
        if not cls.rows:
            raise unittest.SkipTest("database is empty; run the pipeline first")

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def test_every_row_has_a_source_quote(self):
        self.assertFalse([r for r in self.rows if not (r["source_quote"] or "").strip()])

    def test_every_capacity_digit_is_present_in_its_quote(self):
        bad = []
        for row in self.rows:
            value = row["specific_capacity_mah_g"]
            if value is None:
                continue
            reported = row["capacity_as_reported"] or ""
            quote = row["source_quote"] or ""
            candidates = {f"{value:g}", str(int(value)) if float(value).is_integer()
                          else f"{value:g}"}
            if any(c in quote for c in candidates):
                continue
            if reported and reported.split()[0] in quote:
                continue        # stored value is a documented unit conversion
            bad.append((row["id"], value))
        self.assertEqual(bad, [], f"{len(bad)} capacities absent from their quote")

    def test_confidence_is_always_one_of_three_values(self):
        allowed = {"verified", "flagged", "unverified"}
        self.assertTrue(all(r["confidence"] in allowed for r in self.rows))

    def test_flagged_rows_always_say_why(self):
        import json
        for row in self.rows:
            if row["confidence"] == "flagged":
                self.assertTrue(json.loads(row["flags"] or "[]"),
                                f"row {row['id']} is flagged with no reason")

    def test_no_capacity_is_negative(self):
        self.assertFalse([r for r in self.rows
                          if (r["specific_capacity_mah_g"] or 0) < 0])


if __name__ == "__main__":
    unittest.main()
