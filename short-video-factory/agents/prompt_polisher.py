# SPDX-License-Identifier: GPL-3.0-only
"""Prompt polisher: ShotSpec (+ past failures) -> final English H3 prompt.

Dialogue lines are embedded as <d>[Chinese] ...</d> so the H3 renderer speaks
them verbatim.
"""
from __future__ import annotations

from ..domain.schemas.core import ShotSpec

_SCHEMA_HINT = '{"prompt": str}'


class PromptPolisherAgent:
    def __init__(self, text_model, store=None):
        self.text_model = text_model
        self.store = store

    def polish(self, spec: ShotSpec,
               failures: list[dict] | None = None) -> str:
        instructions = (
            "You write prompts for the MiniMax H3 reference-to-video model. "
            "Output ONE vivid English prompt describing subject, action, scene, "
            "camera and style. Keep every Chinese dialogue line verbatim, each "
            "wrapped as <d>[Chinese] line</d>. Never translate or drop dialogue. "
            "Address the past failure notes if any are given."
        )
        camera = ", ".join(f"{k}: {v}" for k, v in spec.camera.items())
        payload = {
            "action": spec.action,
            "dialogue": spec.dialogue,
            "camera": camera,
            "characters": spec.characters,
            "acceptance_required": spec.acceptance.required,
            "acceptance_forbidden": spec.acceptance.forbidden,
            "past_failures": failures or [],
        }
        out = self.text_model.chat_json(instructions, payload, _SCHEMA_HINT)
        prompt = str(out.get("prompt", "")).strip()
        if spec.dialogue and "<d>" not in prompt:
            prompt += f'\n<d>[Chinese] {spec.dialogue}</d>'
        return prompt
