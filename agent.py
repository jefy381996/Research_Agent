"""The agent: plan, call tools, answer, and be checked.

The model decides what to do. It does not decide what is true. Every figure in
the finished answer is matched back against what the tools actually returned,
and anything that cannot be matched is marked rather than quietly shown. That
check is what makes a cheap, fast, open model safe to put in front of a
scientist: it is allowed to reason, not to invent.
"""

from __future__ import annotations

import json
import re
import time

import agent_cache
import agent_tools
import llm

import os

MAX_ROUNDS = int(os.environ.get("AGENT_MAX_ROUNDS", "8"))
# Roughly four characters to a token. Groq's free tier allows 8,000 tokens a
# MINUTE across everything, so the default here is deliberately small; raise
# it with AGENT_CONTEXT_CHARS once the provider's limits allow.
MAX_TOOL_CHARS = int(os.environ.get("AGENT_TOOL_CHARS", "2600"))
MAX_TRANSCRIPT_CHARS = int(os.environ.get("AGENT_CONTEXT_CHARS", "18000"))

SYSTEM = """You are the research agent for a graphene library covering the whole \
field: batteries, electronics, sensors, membranes, composites, coatings, thermal \
transport, photonics, catalysis, biomedicine, toxicity and production. You are \
talking to a working scientist. Be exact and brief. No flattery, no preamble, \
no restating the question.

WHAT YOU MAY SAY
Only what a tool returned in THIS conversation. You have no knowledge of your \
own here; anything you "remember" about graphene is not evidence. If the \
tools come back empty, say so plainly, say what you searched, and stop. Never \
fill a gap.

HOW TO WORK
- Plan first, then call tools. Two to four rounds is normal. The moment you have enough to answer, ANSWER. Do not keep looking for more; an answer with its limits stated beats another search.
- search_measurements for battery numbers - capacity, retention, cycles, rate, \
efficiency; compare_materials to rank; trend_by_year for change over time.
- search_properties for everything else measurable: thermal conductivity, \
electrical and ionic conductivity, sheet resistance, carrier mobility, Young's \
modulus, tensile strength, surface area, specific capacitance, transmittance, \
water permeance, EMI shielding. Call list_properties first if unsure which key \
to use. Its ids look like P123 and are cited exactly like E ids.
- search_literature for mechanism; knowledge_lookup for what a term means; \
compound_lookup for chemical identity.
- sql_query for anything those cannot express. Call describe_library first so \
you know the real columns and values.
- run_analysis when the question needs statistics, correlation or a chart that \
no tool provides. Print what you want to see; call save_plot() for a figure.
- live_search when the library may simply be out of date. Label those results \
as leads, not library evidence.
- NEVER do arithmetic yourself. Call calculate, and quote the formula it returns.

CITATIONS
Every number you state must be followed by an id the tool returned, in square \
brackets. Measurement ids look like E1234 and appear as "id" in rows and as \
"example_ids" in groups; paper ids look like PW4388464547.

  Right:  Si/graphene nanosheets reach a median 1639 mAh/g [E8821][E9104].
  Right:  Graphene composites reach 1791 W/mK [P412].
  Wrong:  Si/graphene nanosheets reach a median 1639 mAh/g [compare_materials].
  Wrong:  Si/graphene nanosheets reach a median 1639 mAh/g.

Never cite a tool name, and never invent an id. A sentence containing a number \
and no id is struck by the checker before the scientist sees it.

HONESTY
Give the spread, not just the middle. Say how many measurements and how many \
papers. Say when most rows do not report a field. Say how many are flagged and \
why. Never present a flagged number as settled.

FORMAT - match the depth to the question
Markdown. Always lead with the answer in one sentence, cited.

A simple question ("what is X", "median capacity of Y") gets that sentence and \
at most three short bullets. Under 120 words. No headings.

A technical or multi-part question - comparisons, trade-offs, mechanisms, \
anything asking why or how, anything needing a calculation - gets the full \
working, in this order and nothing else:

  1. The answer, one sentence, cited.
  2. A markdown table of the numbers, with their conditions and ids.
  3. Any calculation, as the formula the tool returned, its inputs, its result.
  4. What the evidence does not settle: missing fields, flagged rows, spread.

Never restate the question. Never add a closing summary. Never pad."""


def _tool_text(result: dict) -> str:
    figures = result.pop("_figures", None) if isinstance(result, dict) else None
    text = json.dumps(result, default=str)
    if len(text) > MAX_TOOL_CHARS:
        text = text[:MAX_TOOL_CHARS] + ' ... [truncated; narrow the query]"}'
    return text, figures


# A digit attached to a letter is a label - Q1, CO2, E204 - not a figure the
# agent is claiming.
_NUM = re.compile(r"(?<![A-Za-z0-9])-?\d[\d,]*\.?\d*(?![A-Za-z])")


_GROUPED = re.compile(r"(?<=\d)[\s\u00a0\u2009\u202f\u2007](?=\d{3}\b)")


def _numbers(text: str) -> set[str]:
    # Models write large figures with a thin space as the thousands separator
    # ("2 150.8"). Left alone that reads as two numbers, and the checker then
    # flags a figure the tools really did return.
    text = _GROUPED.sub("", text or "")
    out = set()
    for raw in _NUM.findall(text):
        clean = raw.replace(",", "").rstrip(".")
        if not clean or clean in "-":
            continue
        try:
            value = float(clean)
        except ValueError:
            continue
        out.add(f"{value:g}")
    return out


def _is_supported(value: float, pool: set[float]) -> bool:
    """A figure counts as supported if a tool returned it, or returned
    something that rounds to it. A scientist writing 'about 1000' from 1021 is
    rounding, not inventing; writing 1600 from 1021 is not."""
    for known in pool:
        if known == value:
            return True
        if known != 0 and abs(known - value) / abs(known) <= 0.01:
            return True
        for digits in (0, 1, 2, -1, -2):
            if round(known, digits) == value:
                return True
    return False


_CITE_ANY = re.compile(r"[\[\(\u3010\uff08]\s*((?:[EP]W?\d+)(?:\s*[,;]\s*[EP]W?\d+)*)"
                       r"\s*[\]\)\u3011\uff09]")


def _normalise_citations(text: str) -> str:
    def swap(m):
        ids = re.split(r"[,;]\s*", m.group(1))
        return "".join(f"[{i.strip()}]" for i in ids if i.strip())
    return _CITE_ANY.sub(swap, text)


def verify(answer: str, tool_outputs: list[str], valid_ids: set[str]) -> dict:
    """Check the answer against what the tools actually said."""
    pool = {float(n) for n in _numbers(" ".join(tool_outputs))}
    # A citation marker is a reference, not a claim: [E204] must not be read
    # as the agent asserting the number 204.
    # Models substitute bracket styles freely, so normalise before reading
    # citations: 【E204】 and (E204) mean exactly what [E204] means.
    answer = _normalise_citations(answer or "")
    prose = re.sub(r"\[[EP]W?\d+\]", " ", answer)
    stated = sorted(_numbers(prose), key=lambda s: float(s))
    unsupported = [s for s in stated if not _is_supported(float(s), pool)]

    cited = set(re.findall(r"\[([EP]W?\d+)\]", answer))
    invented = sorted(cited - valid_ids)
    cleaned = answer
    for bad in invented:
        cleaned = cleaned.replace(f"[{bad}]", "")

    sentences = [s for s in re.split(r"(?<=[.!?])\s+", cleaned) if s.strip()]
    uncited = [s.strip()[:140] for s in sentences
               if _NUM.search(s) and not re.search(r"\[[EP]W?\d+\]", s)]

    return {"answer": cleaned,
            "numbers_stated": len(stated),
            "numbers_unsupported": unsupported,
            "citations_invented": invented,
            "sentences_with_numbers_uncited": uncited,
            "clean": not unsupported and not invented and not uncited}


def run(question: str, history: list[dict] | None = None,
        max_rounds: int = MAX_ROUNDS, fresh: bool = False):
    """Drive one question to an answer, yielding events as it goes.

    A question asked before replays its stored run exactly, unless `fresh` is
    set. Replay costs nothing and, more importantly, means two people asking
    the same thing see the same answer.
    """
    # The cache is consulted before the model gate on purpose. A stored run is
    # a finished answer: replaying it needs no key, no network and no quota, so
    # a question asked once still answers when the key is removed or its quota
    # is spent. Only a question never asked before needs a working model.
    #
    # Only a standalone question is cacheable: a follow-up means something
    # different depending on what came before it.
    cacheable = not history
    if cacheable and not fresh:
        stored = agent_cache.get(question, llm.provider_name(), llm.model_name())
        if stored:
            # Mark every event, not only the answer. A replay arrives in one
            # burst, and an interface that renders it as fast as it reads it
            # shows the viewer nothing at all - the research it is meant to
            # display is over before the first frame. The flag lets the client
            # pace the playback to the speed the work originally took.
            for event in stored:
                yield dict(event, replayed=True)
            return

    if not llm.configured():
        yield {"type": "error", "code": "no_model",
               "message": ("No model is configured, so the agent cannot reason. "
                           f"Set {llm.status()['key_variable']} on the server.")}
        return

    captured: list[dict] = []
    messages = [{"role": "system", "content": SYSTEM}]
    for turn in (history or [])[-6:]:
        if turn.get("role") in ("user", "assistant") and turn.get("content"):
            messages.append({"role": turn["role"], "content": turn["content"][:4000]})
    messages.append({"role": "user", "content": question})

    tools = agent_tools.tool_specs()
    outputs, valid_ids, figures = [], set(), []
    corrected = False
    started, usage_in, usage_out = time.time(), 0, 0

    def emit(event):
        captured.append(event)
        return event

    yield emit({"type": "start", "provider": llm.provider_name(),
                "model": llm.model_name()})

    for round_no in range(1, max_rounds + 1):
        _trim(messages)
        try:
            reply = llm.chat(messages, tools=tools)
        except llm.LLMUnavailable as exc:
            yield emit({"type": "error", "code": "model_unavailable", "message": str(exc)})
            return
        usage = reply.get("usage") or {}
        usage_in += usage.get("prompt_tokens") or 0
        usage_out += usage.get("completion_tokens") or 0

        if reply.get("reasoning"):
            yield emit({"type": "thinking", "round": round_no,
                        "text": reply["reasoning"][:900]})

        calls = reply.get("tool_calls") or []
        if not calls:
            final = reply.get("text") or ""
            report = verify(final, outputs, valid_ids)

            # One chance to put it right. A weaker model often cites the tool
            # rather than the row, which is a formatting slip, not a lie; it is
            # cheaper to say so than to strike a correct sentence.
            if not report["clean"] and not corrected and round_no < max_rounds:
                corrected = True
                problems = []
                if report["citations_invented"]:
                    problems.append("These ids were never returned by any tool: "
                                    + ", ".join(report["citations_invented"]))
                if report["numbers_unsupported"]:
                    problems.append("No tool returned these figures: "
                                    + ", ".join(report["numbers_unsupported"])
                                    + ". Remove them or call a tool that supports them.")
                if report["sentences_with_numbers_uncited"]:
                    problems.append("These sentences state a number with no id: "
                                    + " | ".join(report["sentences_with_numbers_uncited"][:4]))
                yield emit({"type": "correcting", "round": round_no,
                            "problems": problems})
                messages.append({"role": "assistant", "content": final})
                messages.append({"role": "user", "content":
                    "Your answer failed the citation check.\n- "
                    + "\n- ".join(problems)
                    + "\n\nRewrite it. Cite every number with an id a tool "
                      "returned, like [E1234] or [PW123]. Never cite a tool name. "
                      "Drop any figure you cannot support. Reply with the "
                      "corrected answer only."})
                continue

            answer_event = emit({
                "type": "answer", "text": report["answer"], "verification": report,
                "figures": figures, "rounds": round_no,
                "seconds": round(time.time() - started, 1),
                "tokens": {"in": usage_in, "out": usage_out}})
            if cacheable:
                agent_cache.put(question, llm.provider_name(), llm.model_name(),
                                captured)
            yield answer_event
            return

        messages.append({"role": "assistant", "content": reply.get("text") or "",
                         "tool_calls": [{"id": c["id"], "type": "function",
                                         "function": {"name": c["name"],
                                                      "arguments": json.dumps(c["arguments"])}}
                                        for c in calls]})
        for call in calls:
            yield emit({"type": "tool_call", "round": round_no,
                        "name": call["name"], "arguments": call["arguments"]})
            result = agent_tools.run_tool(call["name"], call["arguments"])
            text, figs = _tool_text(result if isinstance(result, dict) else {"result": result})
            if figs:
                figures.extend(figs)
            outputs.append(text)
            for found in re.findall(r'"(E\d+|PW?\d+)"', text):
                valid_ids.add(found)
            for found in re.findall(r'"openalex_id":\s*"(W\d+)"', text):
                valid_ids.add("P" + found)
            yield emit({"type": "tool_result", "round": round_no,
                        "name": call["name"],
                        "summary": _summary(call["name"], result),
                        "bytes": len(text)})
            messages.append({"role": "tool", "tool_call_id": call["id"],
                             "name": call["name"], "content": text})

    yield emit({"type": "error", "code": "too_many_rounds",
                "message": (f"The agent used all {max_rounds} rounds without "
                            "settling on an answer. Ask something narrower.")})


def _trim(messages: list[dict]) -> None:
    """Keep the conversation inside the model's window.

    Older tool results are replaced with a note rather than dropped, so the
    model still knows a step happened and does not repeat it, but stops paying
    to re-read it every round.
    """
    total = sum(len(m.get("content") or "") for m in messages)
    if total <= MAX_TRANSCRIPT_CHARS:
        return
    for message in messages[1:-2]:
        if message.get("role") == "tool" and len(message.get("content") or "") > 400:
            message["content"] = ('{"note": "earlier result from '
                                  + str(message.get("name", "a tool"))
                                  + ', dropped to stay inside the context window. '
                                    'Call it again if you still need it."}')
            total = sum(len(m.get("content") or "") for m in messages)
            if total <= MAX_TRANSCRIPT_CHARS:
                return
    # Still too big: the newest tool result is itself oversized, so clip it.
    for message in reversed(messages):
        if message.get("role") == "tool" and len(message.get("content") or "") > 1200:
            message["content"] = message["content"][:1200] + ' ...[clipped]"}'
            if sum(len(m.get("content") or "") for m in messages) <= MAX_TRANSCRIPT_CHARS:
                return


def _summary(name: str, result) -> str:
    if not isinstance(result, dict):
        return str(result)[:120]
    if result.get("error"):          # the key is always present; only a
        return f"error: {str(result['error'])[:110]}"   # non-empty value is a failure
    for key in ("matched", "row_count", "found"):
        if key in result:
            return f"{result[key]} results"
    if "groups" in result:
        return f"{len(result['groups'])} groups"
    if "years" in result:
        return f"{len(result['years'])} years"
    if "result" in result and "formula" in result:
        return f"{result['result']} {result.get('unit', '')}".strip()
    if "entries" in result:
        return f"{len(result['entries'])} entries"
    if "properties" in result:
        return f"{len(result['properties'])} properties available"
    if "ok" in result:
        return ("analysis ran" if result["ok"] else "analysis failed") + \
               (f", {result.get('figures_produced', 0)} figure(s)" if result.get("ok") else "")
    if "tables" in result:
        return f"{len(result['tables'])} tables described"
    return "done"
