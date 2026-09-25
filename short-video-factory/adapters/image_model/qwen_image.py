# SPDX-License-Identifier: GPL-3.0-only
"""Qwen Image text-to-image adapter (placeholder).

The workflow template is not frozen yet, so this raises until
workflows/qwen_image.api.json exists; then it submits it through ComfyUI the
same way the H3 renderer does.
"""
from __future__ import annotations

import copy
import json
import random
from pathlib import Path
from typing import Optional

from ...config import settings
from ..comfyui.adapter import (
    download_output, find_output_file, poll_history, submit_prompt,
)


class QwenImageModel:
    """ImageModel protocol implementation."""

    def __init__(self, asset_store, base: Optional[str] = None,
                 workflow_path: Optional[str | Path] = None,
                 timeout_s: Optional[float] = None,
                 project_id: str = "factory"):
        self.asset_store = asset_store
        self.base = (base or settings.COMFY_BASE).rstrip("/")
        self.workflow_path = Path(workflow_path or settings.QWEN_IMAGE_WORKFLOW)
        self.timeout_s = float(timeout_s or settings.RENDER_TIMEOUT_S)
        self.project_id = project_id

    def _patch(self, workflow: dict, prompt: str, width: int, height: int) -> dict:
        positive_done = False
        for node in workflow.values():
            inputs = node.get("inputs") or {}
            ctype = node.get("class_type", "")
            # First text-encode node is treated as the positive prompt.
            if ctype == "CLIPTextEncode" and "text" in inputs and not positive_done:
                inputs["text"] = prompt
                positive_done = True
            elif ctype in ("EmptyLatentImage", "EmptySD3LatentImage"):
                inputs["width"] = width
                inputs["height"] = height
            if "seed" in inputs:
                inputs["seed"] = random.randint(0, 2**31 - 1)
            if ctype == "SaveImage":
                inputs["filename_prefix"] = "svf/qwen_image"
        return workflow

    def generate(self, prompt: str, out_key: str, width: int = 1080,
                 height: int = 1920) -> str:
        if not self.workflow_path.exists():
            raise RuntimeError("qwen_image workflow not ready")
        workflow = self._patch(
            copy.deepcopy(json.loads(self.workflow_path.read_text(encoding="utf-8"))),
            prompt, width, height)
        prompt_id = submit_prompt(self.base, workflow)
        entry = poll_history(self.base, prompt_id, self.timeout_s)
        item = find_output_file(entry, ("images",))
        data = download_output(self.base, item)
        project_id = out_key.split("/", 1)[0] if "/" in out_key else self.project_id
        asset = self.asset_store.save_bytes(
            data, project_id, "image", item["filename"], source="generated")
        return asset.storage_key
