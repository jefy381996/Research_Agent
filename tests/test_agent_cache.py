"""A stored run is a finished answer, so replaying it must not need a model.

The demo is run on a free tier, and a free tier runs out. These tests pin the
two halves of that promise: a question asked once keeps answering when the key
is gone, and a question never asked still fails honestly rather than inventing
something.
"""
import os
import unittest
from unittest import mock

import agent
import agent_cache


ANSWER = [
    {"type": "start", "question": "q"},
    {"type": "thinking", "text": "looking"},
    {"type": "answer", "text": "The median is 969 mAh/g [E1].", "citations": ["E1"]},
]


class TestNormalisation(unittest.TestCase):
    def test_spacing_and_trailing_punctuation_collapse_to_one_question(self):
        a = agent_cache.normalise("  What is   the median capacity?  ")
        b = agent_cache.normalise("What is the median capacity")
        self.assertEqual(a, b)

    def test_the_key_separates_provider_and_model(self):
        q = "same question"
        self.assertNotEqual(agent_cache.key(q, "groq", "m1"),
                            agent_cache.key(q, "groq", "m2"))
        self.assertNotEqual(agent_cache.key(q, "groq", "m"),
                            agent_cache.key(q, "openai", "m"))


class TestWhatIsStored(unittest.TestCase):
    def test_a_run_that_errored_is_never_stored(self):
        """A transient rate limit must not become a permanent answer."""
        events = ANSWER + [{"type": "error", "code": "rate_limit"}]
        with mock.patch.object(agent_cache, "db") as fake_db:
            agent_cache.put("q", "groq", "m", events)
            fake_db.connect.assert_not_called()

    def test_a_run_with_no_answer_is_never_stored(self):
        with mock.patch.object(agent_cache, "db") as fake_db:
            agent_cache.put("q", "groq", "m", ANSWER[:2])
            fake_db.connect.assert_not_called()


class TestReplayWithoutAModel(unittest.TestCase):
    """The cache is read before the model gate, on purpose."""

    def test_a_stored_run_replays_with_no_key_set(self):
        with mock.patch.object(agent.llm, "configured", return_value=False), \
             mock.patch.object(agent.agent_cache, "get", return_value=ANSWER):
            events = list(agent.run("anything"))
        self.assertEqual([e["type"] for e in events],
                         ["start", "thinking", "answer"])
        self.assertTrue(events[-1]["replayed"])

    def test_an_unseen_question_with_no_key_fails_honestly(self):
        with mock.patch.object(agent.llm, "configured", return_value=False), \
             mock.patch.object(agent.agent_cache, "get", return_value=None):
            events = list(agent.run("never asked before"))
        self.assertEqual([e["type"] for e in events], ["error"])
        self.assertEqual(events[0]["code"], "no_model")

    def test_fresh_skips_the_cache_and_so_still_needs_a_model(self):
        with mock.patch.object(agent.llm, "configured", return_value=False), \
             mock.patch.object(agent.agent_cache, "get", return_value=ANSWER) as g:
            events = list(agent.run("anything", fresh=True))
        g.assert_not_called()
        self.assertEqual(events[0]["code"], "no_model")

    def test_a_follow_up_is_never_served_from_the_cache(self):
        """The same words mean something different after a different question."""
        history = [{"role": "user", "content": "and silicon?"}]
        with mock.patch.object(agent.llm, "configured", return_value=False), \
             mock.patch.object(agent.agent_cache, "get", return_value=ANSWER) as g:
            events = list(agent.run("what about that", history=history))
        g.assert_not_called()
        self.assertEqual(events[0]["code"], "no_model")


if __name__ == "__main__":
    unittest.main()


class TestPropertyToolsInTheLoop(unittest.TestCase):
    """No key is needed to prove the loop wires a property tool to a citation.

    The model is stubbed: round one calls search_properties, round two answers
    with an id that tool issued. What is under test is everything between -
    dispatch, id harvesting, the citation gate.
    """

    def test_a_property_id_survives_from_tool_call_to_clean_answer(self):
        tool_result = {
            "matched": 2, "papers": 2, "flagged": 0,
            "spread": {"n": 2, "median": 1791.0, "min": 1791.0, "max": 1791.0,
                       "p25": 1791.0, "p75": 1791.0, "unit": "W/mK"},
            "rows": [{"id": "P412", "property": "Thermal conductivity",
                      "value": 1791.0, "unit": "W/mK", "quote": "1791.1 W/m K"}],
        }
        turns = iter([
            {"text": "", "reasoning": "", "usage": {},
             "tool_calls": [{"id": "c1", "name": "search_properties",
                             "arguments": {"property_key": "thermal_conductivity"}}]},
            {"text": "Graphene reaches a median 1791 W/mK [P412].",
             "reasoning": "", "usage": {}, "tool_calls": []},
        ])
        with mock.patch.object(agent.llm, "configured", return_value=True), \
             mock.patch.object(agent.llm, "chat", side_effect=lambda *a, **k: next(turns)), \
             mock.patch.object(agent.agent_cache, "get", return_value=None), \
             mock.patch.object(agent.agent_cache, "put"), \
             mock.patch.object(agent.agent_tools, "run_tool", return_value=tool_result):
            events = list(agent.run("thermal conductivity of graphene"))

        kinds = [e["type"] for e in events]
        self.assertIn("tool_call", kinds)
        self.assertIn("answer", kinds)
        answer = events[-1]
        self.assertIn("[P412]", answer["text"])
        self.assertEqual(answer["verification"]["citations_invented"], [])
        self.assertEqual(answer["verification"]["numbers_unsupported"], [])
        self.assertTrue(answer["verification"]["clean"])

    def test_an_id_no_tool_issued_is_struck_before_the_reader_sees_it(self):
        tool_result = {"matched": 1, "papers": 1, "flagged": 0,
                       "rows": [{"id": "P412", "value": 1791.0, "unit": "W/mK"}]}
        turns = iter([
            {"text": "", "reasoning": "", "usage": {},
             "tool_calls": [{"id": "c1", "name": "search_properties",
                             "arguments": {"property_key": "thermal_conductivity"}}]},
            {"text": "Graphene reaches 1791 W/mK [P999].",
             "reasoning": "", "usage": {}, "tool_calls": []},
            {"text": "Graphene reaches 1791 W/mK [P412].",
             "reasoning": "", "usage": {}, "tool_calls": []},
        ])
        with mock.patch.object(agent.llm, "configured", return_value=True), \
             mock.patch.object(agent.llm, "chat", side_effect=lambda *a, **k: next(turns)), \
             mock.patch.object(agent.agent_cache, "get", return_value=None), \
             mock.patch.object(agent.agent_cache, "put"), \
             mock.patch.object(agent.agent_tools, "run_tool", return_value=tool_result):
            events = list(agent.run("thermal conductivity of graphene"))

        answer = events[-1]
        self.assertNotIn("P999", answer["text"])
