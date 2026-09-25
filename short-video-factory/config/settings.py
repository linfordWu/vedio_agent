# SPDX-License-Identifier: GPL-3.0-only
"""Runtime configuration: endpoints and paths, all env-overridable."""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("SVF_DATA_DIR", BASE_DIR / "data"))
ASSET_ROOT = Path(os.environ.get("SVF_ASSET_ROOT", DATA_DIR / "assets"))
DB_PATH = Path(os.environ.get("SVF_DB", DATA_DIR / "factory.db"))

COMFY_BASE = os.environ.get("COMFY_BASE", "http://localhost:8188")
# Ollama sidecar (gemma3:4b, multimodal) in the compose network
TEXT_MODEL_BASE = os.environ.get("TEXT_MODEL_BASE", "http://172.19.0.2:11434/v1")
TEXT_MODEL_NAME = os.environ.get("TEXT_MODEL_NAME", "gemma3:4b")
# Same OpenAI-compatible endpoint serves vision judging (gemma3:4b accepts images)
VISION_MODEL_BASE = os.environ.get("VISION_MODEL_BASE", TEXT_MODEL_BASE)
VISION_MODEL_NAME = os.environ.get("VISION_MODEL_NAME", TEXT_MODEL_NAME)
# llama-server hosting OpenJev (structured one-answer decisions)
OPENJEV_BASE = os.environ.get("OPENJEV_BASE", "http://localhost:8091/v1")
OPENJEV_NAME = os.environ.get("OPENJEV_NAME", "openjev")

LAYA_MODEL_DIR = os.environ.get("LAYA_MODEL_DIR", "/home/wlf/models/laya/weights")
LAYA_PYTHON = os.environ.get("LAYA_PYTHON", "/home/wlf/models/laya/.venv/bin/python")

# Frozen ComfyUI workflow templates
WORKFLOWS_DIR = Path(os.environ.get("SVF_WORKFLOWS_DIR", BASE_DIR / "workflows"))
H3_SHOT_WORKFLOW = WORKFLOWS_DIR / "h3_shot_render.api.json"
QWEN_IMAGE_WORKFLOW = WORKFLOWS_DIR / "qwen_image.api.json"

DEFAULT_SEED = int(os.environ.get("SVF_SEED", "2026"))
RENDER_TIMEOUT_S = int(os.environ.get("SVF_RENDER_TIMEOUT", "7200"))
MAX_REPAIRS = int(os.environ.get("SVF_MAX_REPAIRS", "2"))

for d in (DATA_DIR, ASSET_ROOT):
    d.mkdir(parents=True, exist_ok=True)
