"""One interface to several model providers.

Which provider answers is a single environment variable, so swapping Groq for
Gemini or Claude is a deployment change and not a code change. Groq is the
default because it is the cheapest way to run an agent that calls tools.

    LLM_PROVIDER = groq | openai | gemini | anthropic      (default groq)
    LLM_MODEL    = a model id for that provider            (optional)
    GROQ_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / ANTHROPIC_API_KEY

Every provider is normalised to one shape, so the agent never has to know
which one it is talking to:

    reply = chat(messages, tools) -> {"text", "tool_calls", "usage", "model"}
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

import requests

TIMEOUT = 120
MAX_RETRIES = 5

PROVIDERS = {
    "groq": {
        "url": "https://api.groq.com/openai/v1/chat/completions",
        "key_env": "GROQ_API_KEY",
        "default_model": "openai/gpt-oss-120b",
        "style": "openai",
    },
    "openai": {
        "url": "https://api.openai.com/v1/chat/completions",
        "key_env": "OPENAI_API_KEY",
        "default_model": "gpt-4o-mini",
        "style": "openai",
    },
    "anthropic": {
        "url": "https://api.anthropic.com/v1/messages",
        "key_env": "ANTHROPIC_API_KEY",
        "default_model": "claude-sonnet-5-5",
        "style": "anthropic",
    },
    "gemini": {
        "url": ("https://generativelanguage.googleapis.com/v1beta/models/"
                "{model}:generateContent"),
        "key_env": "GEMINI_API_KEY",
        "default_model": "gemini-2.5-flash",
        "style": "gemini",
    },
}


class LLMUnavailable(RuntimeError):
    """No provider is configured, or the one configured will not answer."""


def provider_name() -> str:
    return (os.environ.get("LLM_PROVIDER") or "groq").strip().lower()


def model_name() -> str:
    spec = PROVIDERS.get(provider_name()) or PROVIDERS["groq"]
    return (os.environ.get("LLM_MODEL") or spec["default_model"]).strip()


def configured() -> bool:
    spec = PROVIDERS.get(provider_name())
    return bool(spec and os.environ.get(spec["key_env"], "").strip())


def status() -> dict:
    spec = PROVIDERS.get(provider_name())
    return {
        "provider": provider_name(),
        "model": model_name(),
        "configured": configured(),
        "key_variable": spec["key_env"] if spec else None,
        "providers": sorted(PROVIDERS),
    }


def chat(messages: list[dict], tools: list[dict] | None = None,
         temperature: float = 0.0, max_tokens: int = 4000) -> dict:
    """One turn. Returns text, any tool calls, and what it cost."""
    name = provider_name()
    spec = PROVIDERS.get(name)
    if not spec:
        raise LLMUnavailable(f"unknown provider {name!r}; "
                             f"choose one of {sorted(PROVIDERS)}")
    key = os.environ.get(spec["key_env"], "").strip()
    if not key:
        raise LLMUnavailable(
            f"{spec['key_env']} is not set, so the agent cannot think. "
            f"Set it on the server, or set LLM_PROVIDER to one that is.")

    style = spec["style"]
    builder = {"openai": _openai, "anthropic": _anthropic, "gemini": _gemini}[style]
    url, headers, body = builder(spec, key, messages, tools, temperature, max_tokens)

    last = ""
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = requests.post(url, headers=headers, json=body, timeout=TIMEOUT)
        except requests.RequestException as exc:
            last = f"{type(exc).__name__}: {exc}"
        else:
            if response.status_code == 200:
                return {"openai": _read_openai, "anthropic": _read_anthropic,
                        "gemini": _read_gemini}[style](response.json())
            last = f"HTTP {response.status_code}: {response.text[:220]}"
            if response.status_code == 429:
                wait = float(response.headers.get("retry-after") or 3 * attempt)
                time.sleep(min(wait, 45))
                continue
            if response.status_code == 413:
                detail = ""
                try:
                    detail = response.json()["error"]["message"]
                except Exception:
                    pass
                if "tokens per minute" in detail or "TPM" in detail:
                    raise LLMUnavailable(
                        "The provider's per-minute token allowance is too small "
                        "to run an agent. " + detail.split("Need more tokens")[0].strip()
                        + " A tool-calling agent re-reads the whole conversation "
                          "every round, so it needs several thousand tokens per "
                          "question. Raise the limit on the provider, or set "
                          "LLM_PROVIDER to one with room.")
                raise LLMUnavailable(
                    "the conversation grew past what this model can read at once. "
                    "Ask something narrower, or set LLM_MODEL to one with a "
                    "bigger context. " + detail[:200])
            if response.status_code < 500:
                raise LLMUnavailable(last)
        if attempt < MAX_RETRIES:
            time.sleep(1.5 * attempt)
    if "rate limit" in last.lower() or "429" in last:
        raise LLMUnavailable(
            "the model provider is rate limiting this key. On Groq's free tier "
            "that happens quickly; wait a minute, or add billing, or point "
            "LLM_PROVIDER at another provider.")
    raise LLMUnavailable(f"the model did not answer after {MAX_RETRIES} attempts. {last}")


# ── request shapes ─────────────────────────────────────────────────────────

def _openai(spec, key, messages, tools, temperature, max_tokens):
    body: dict[str, Any] = {"model": model_name(), "messages": messages,
                            "temperature": temperature, "max_tokens": max_tokens}
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    return spec["url"], {"Authorization": f"Bearer {key}",
                         "Content-Type": "application/json"}, body


def _anthropic(spec, key, messages, tools, temperature, max_tokens):
    system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
    turns = []
    for m in messages:
        if m["role"] == "system":
            continue
        if m["role"] == "tool":
            turns.append({"role": "user", "content": [{
                "type": "tool_result", "tool_use_id": m.get("tool_call_id"),
                "content": m["content"]}]})
        elif m.get("tool_calls"):
            blocks = [{"type": "text", "text": m.get("content") or "."}]
            for call in m["tool_calls"]:
                blocks.append({"type": "tool_use", "id": call["id"],
                               "name": call["function"]["name"],
                               "input": json.loads(call["function"]["arguments"] or "{}")})
            turns.append({"role": "assistant", "content": blocks})
        else:
            turns.append({"role": m["role"], "content": m["content"]})
    body = {"model": model_name(), "system": system, "messages": turns,
            "max_tokens": max_tokens, "temperature": temperature}
    if tools:
        body["tools"] = [{"name": t["function"]["name"],
                          "description": t["function"]["description"],
                          "input_schema": t["function"]["parameters"]} for t in tools]
    return spec["url"], {"x-api-key": key, "anthropic-version": "2023-06-01",
                         "Content-Type": "application/json"}, body


def _gemini(spec, key, messages, tools, temperature, max_tokens):
    system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
    contents = []
    for m in messages:
        if m["role"] == "system":
            continue
        if m["role"] == "tool":
            contents.append({"role": "user", "parts": [{"functionResponse": {
                "name": m.get("name", "tool"),
                "response": {"result": m["content"]}}}]})
        elif m.get("tool_calls"):
            contents.append({"role": "model", "parts": [
                {"functionCall": {"name": c["function"]["name"],
                                  "args": json.loads(c["function"]["arguments"] or "{}")}}
                for c in m["tool_calls"]]})
        else:
            contents.append({"role": "user" if m["role"] == "user" else "model",
                             "parts": [{"text": m["content"]}]})
    body: dict[str, Any] = {
        "contents": contents,
        "generationConfig": {"temperature": temperature,
                             "maxOutputTokens": max_tokens}}
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    if tools:
        body["tools"] = [{"functionDeclarations": [
            {"name": t["function"]["name"],
             "description": t["function"]["description"],
             "parameters": t["function"]["parameters"]} for t in tools]}]
    url = spec["url"].format(model=model_name())
    return url, {"x-goog-api-key": key, "Content-Type": "application/json"}, body


# ── response shapes ────────────────────────────────────────────────────────

def _read_openai(data):
    choice = (data.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    calls = []
    for call in message.get("tool_calls") or []:
        fn = call.get("function") or {}
        calls.append({"id": call.get("id") or fn.get("name"),
                      "name": fn.get("name"),
                      "arguments": _loads(fn.get("arguments"))})
    # Reasoning models put their working in a separate field and spend real
    # tokens on it. Keep it: the interface shows it as the agent's thinking,
    # and a token budget that ignores it starves the actual answer.
    return {"text": message.get("content") or "",
            "reasoning": message.get("reasoning") or "",
            "tool_calls": calls,
            "usage": data.get("usage") or {}, "model": data.get("model")}


def _read_anthropic(data):
    text, calls = [], []
    for block in data.get("content") or []:
        if block.get("type") == "text":
            text.append(block.get("text") or "")
        elif block.get("type") == "tool_use":
            calls.append({"id": block.get("id"), "name": block.get("name"),
                          "arguments": block.get("input") or {}})
    usage = data.get("usage") or {}
    return {"text": "".join(text), "reasoning": "", "tool_calls": calls,
            "usage": {"prompt_tokens": usage.get("input_tokens"),
                      "completion_tokens": usage.get("output_tokens")},
            "model": data.get("model")}


def _read_gemini(data):
    cand = (data.get("candidates") or [{}])[0]
    parts = ((cand.get("content") or {}).get("parts")) or []
    text, calls = [], []
    for part in parts:
        if "text" in part:
            text.append(part["text"])
        elif "functionCall" in part:
            fc = part["functionCall"]
            calls.append({"id": fc.get("name"), "name": fc.get("name"),
                          "arguments": fc.get("args") or {}})
    usage = data.get("usageMetadata") or {}
    return {"text": "".join(text), "reasoning": "", "tool_calls": calls,
            "usage": {"prompt_tokens": usage.get("promptTokenCount"),
                      "completion_tokens": usage.get("candidatesTokenCount")},
            "model": model_name()}


def _loads(raw):
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
