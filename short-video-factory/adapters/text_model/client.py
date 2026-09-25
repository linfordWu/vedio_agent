# SPDX-License-Identifier: GPL-3.0-only
"""OpenAI-compatible chat client (ollama gemma3:4b by default).

Stdlib-only HTTP via urllib; chat_json asks the model for bare JSON and
extracts the first {...} block with a regex, retrying once on parse failure.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Optional

from ...config import settings

_JSON_BLOCK = re.compile(r"\{.*\}", re.DOTALL)

_JSON_INSTRUCTION = (
    "Respond with ONE valid JSON object only. No markdown fences, no prose, "
    "no explanation before or after. Required shape:\n{schema_hint}"
)

_RETRY_INSTRUCTION = (
    "Your previous reply was not valid JSON. Reply with ONLY the corrected "
    "JSON object, nothing else. Required shape:\n{schema_hint}"
)


def extract_json(text: str) -> dict:
    """Pull the first JSON object out of a model reply."""
    m = _JSON_BLOCK.search(text or "")
    if not m:
        raise ValueError(f"no JSON object in model reply: {text[:200]!r}")
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError as e:
        raise ValueError(f"invalid JSON in model reply: {e}") from e


class TextModelClient:
    """TextModel protocol implementation."""

    def __init__(self, base: Optional[str] = None, model: Optional[str] = None,
                 timeout: float = 120.0):
        self.base = (base or settings.TEXT_MODEL_BASE).rstrip("/")
        self.model = model or settings.TEXT_MODEL_NAME
        self.timeout = timeout

    # ---------------------------------------------------------------- http --
    def _post(self, path: str, body: dict) -> dict:
        req = urllib.request.Request(
            self.base + path,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    # ---------------------------------------------------------------- chat --
    def chat(self, messages: list[dict], max_tokens: int = 2048,
             temperature: float = 0.7) -> str:
        body = {"model": self.model, "messages": messages,
                "max_tokens": max_tokens, "temperature": temperature}
        data = self._post("/chat/completions", body)
        return data["choices"][0]["message"]["content"]

    def chat_json(self, instructions: str, payload: dict,
                  schema_hint: str, max_tokens: int = 2048) -> dict:
        def _messages(instr: str) -> list[dict]:
            return [
                {"role": "system", "content":
                    instr + "\n\n" + _JSON_INSTRUCTION.format(schema_hint=schema_hint)},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ]

        reply = self.chat(_messages(instructions), max_tokens=max_tokens)
        try:
            return extract_json(reply)
        except ValueError:
            pass
        # One retry with a stricter instruction and the bad reply as context.
        retry = _messages(instructions + "\n\n" +
                          _RETRY_INSTRUCTION.format(schema_hint=schema_hint))
        retry.append({"role": "assistant", "content": reply})
        retry.append({"role": "user", "content": "Fix it: output the JSON only."})
        reply = self.chat(retry, max_tokens=max_tokens, temperature=0.2)
        return extract_json(reply)
