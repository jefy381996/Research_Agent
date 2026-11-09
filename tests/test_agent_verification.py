"""The citation checker is what makes a cheap model safe to ship.

The agent may reason freely; it may not assert a figure no tool returned. These
tests pin that gate, because every one of them is a mistake a model actually
made during development.
"""
import unittest

import agent


class TestNumberExtraction(unittest.TestCase):
    def test_a_digit_inside_a_label_is_not_a_claim(self):
        self.assertEqual(agent._numbers("Q1 = 613 and Q3 = 1438"), {"613", "1438"})

    def test_thin_space_thousands_separators_read_as_one_number(self):
        self.assertIn("2150.8", agent._numbers("reaches 2 150.8 mAh/g"))
        self.assertIn("1639", agent._numbers("median 1 639"))


class TestSupport(unittest.TestCase):
    def test_exact_and_rounded_figures_are_supported(self):
        pool = {1021.3}
        for value in (1021.3, 1021, 1000):
            self.assertTrue(agent._is_supported(value, pool), value)

    def test_an_invented_figure_is_not(self):
        self.assertFalse(agent._is_supported(5500, {1021.3, 94.0}))


class TestCitations(unittest.TestCase):
    def test_every_bracket_style_is_accepted(self):
        out = agent._normalise_citations("a 【E1】 b (E2) c [E3] d （PW9）")
        for want in ("[E1]", "[E2]", "[E3]", "[PW9]"):
            self.assertIn(want, out)

    def test_several_ids_in_one_bracket_are_split(self):
        self.assertEqual(agent._normalise_citations("[E1, E2; E3]"), "[E1][E2][E3]")


class TestVerificationGate(unittest.TestCase):
    TOOLS = ['{"median": 1021.3, "retention": 94.0, "papers": 7}']
    IDS = {"E204"}

    def test_a_clean_answer_passes(self):
        report = agent.verify("Median 1021 mAh/g [E204] across 7 papers [E204].",
                              self.TOOLS, self.IDS)
        self.assertTrue(report["clean"], report)

    def test_an_invented_number_is_caught(self):
        report = agent.verify("Capacity reaches 5500 mAh/g [E204].",
                              self.TOOLS, self.IDS)
        self.assertIn("5500", report["numbers_unsupported"])
        self.assertFalse(report["clean"])

    def test_an_invented_citation_is_struck_from_the_answer(self):
        report = agent.verify("Retention is 94% [E999].", self.TOOLS, self.IDS)
        self.assertEqual(report["citations_invented"], ["E999"])
        self.assertNotIn("E999", report["answer"])

    def test_a_number_with_no_citation_is_reported(self):
        report = agent.verify("Capacity is 1021 mAh/g.", self.TOOLS, self.IDS)
        self.assertTrue(report["sentences_with_numbers_uncited"])
        self.assertFalse(report["clean"])

    def test_a_tool_name_is_not_a_citation(self):
        report = agent.verify("Median 1021 mAh/g [compare_materials].",
                              self.TOOLS, self.IDS)
        self.assertFalse(report["clean"])
        self.assertTrue(report["sentences_with_numbers_uncited"])

    def test_prose_with_no_numbers_needs_no_citation(self):
        report = agent.verify("Nothing in the library covers that.",
                              self.TOOLS, self.IDS)
        self.assertTrue(report["clean"])


class TestTranscriptTrimming(unittest.TestCase):
    def test_an_oversized_conversation_is_brought_back_under_the_limit(self):
        messages = [{"role": "system", "content": "s"}]
        for i in range(12):
            messages.append({"role": "assistant", "content": "thinking"})
            messages.append({"role": "tool", "name": f"t{i}", "content": "x" * 6000})
        agent._trim(messages)
        total = sum(len(m["content"]) for m in messages)
        self.assertLessEqual(total, agent.MAX_TRANSCRIPT_CHARS,
                             "trimming must bring the transcript inside the window")
        self.assertEqual(messages[0]["content"], "s", "the system prompt is never cut")


class TestToolGuards(unittest.TestCase):
    def test_sql_refuses_anything_that_writes(self):
        import agent_tools
        for bad in ("DROP TABLE evidence", "DELETE FROM papers",
                    "SELECT 1; DROP TABLE papers", "PRAGMA table_info(papers)",
                    "ATTACH DATABASE '/tmp/x' AS y"):
            with self.subTest(sql=bad):
                self.assertIn("error", agent_tools.sql_query(bad))

    def test_sql_allows_a_plain_select(self):
        import agent_tools
        out = agent_tools.sql_query("SELECT count(*) AS n FROM evidence")
        self.assertNotIn("error", out)
        self.assertEqual(out["row_count"], 1)

    def test_row_limits_are_clamped_however_many_are_asked_for(self):
        import agent_tools
        out = agent_tools.search_measurements(material="graphene", limit=5000)
        self.assertLessEqual(len(out.get("rows", [])), agent_tools.MAX_ROWS)


if __name__ == "__main__":
    unittest.main()


class TestPropertyCitations(unittest.TestCase):
    """Property ids look like P123; paper ids like PW4388464547. The gate must
    accept both and still reject one the tools never issued."""

    def test_a_property_id_is_a_valid_citation(self):
        report = agent.verify("Graphene composites reach 1791 W/mK [P412].",
                              ['{"id": "P412", "value": 1791}'], {"P412"})
        self.assertEqual(report["citations_invented"], [])
        self.assertEqual(report["numbers_unsupported"], [])

    def test_a_paper_id_still_works_beside_it(self):
        report = agent.verify("Heat moves along the plane [PW4388464547].",
                              ['{"openalex_id": "W4388464547"}'], {"PW4388464547"})
        self.assertEqual(report["citations_invented"], [])

    def test_an_unissued_property_id_is_struck(self):
        report = agent.verify("Graphene reaches 5300 W/mK [P999].",
                              ['{"id": "P412", "value": 5300}'], {"P412"})
        self.assertEqual(report["citations_invented"], ["P999"])

    def test_a_property_id_is_not_read_as_a_claimed_number(self):
        """[P412] must not be heard as the agent asserting the number 412."""
        report = agent.verify("Thermal conductivity is 1791 W/mK [P412].",
                              ['{"value": 1791}'], {"P412"})
        self.assertEqual(report["numbers_unsupported"], [])
