# SPDX-License-Identifier: GPL-3.0-only
"""Vision judge: score a rendered clip against its ShotSpec.

Uses the multimodal ollama endpoint (gemma3:4b). Without ffmpeg on the host
(frames cannot be extracted) it degrades to file-level hard checks only and
marks the report uncertain.
"""
from __future__ import annotations

import base64
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Optional

from ...config import settings
from ...domain.schemas.core import ScoreReport, ShotSpec
from ..asset_store.local import FFMPEG, FFPROBE, _probe_ffprobe
from ..text_model.client import TextModelClient, extract_json

N_FRAMES = 4
ACCEPT_MIN = 0.75
REPAIR_MAX = 0.6

_JUDGE_INSTRUCTIONS = """\
You are a strict video quality judge for short drama shots.
You are given {n} evenly sampled frames from one generated clip.

The shot must satisfy ALL of these required points:
{required}

It must NOT contain any of these forbidden elements:
{forbidden}

Score each dimension from 0.0 to 1.0:
- identity: characters match their reference / description
- action: the required action actually happens
- scene: setting/background matches the spec
- text_ok: no garbled/extra on-screen text

Also report:
- verdict: "accept" | "accept_with_deviation" | "repair" | "reject" —
  use accept_with_deviation when the clip basically matches but has an
  acceptable deviation, and explain the deviation in "deviation"
- observation_confidence: "high" | "medium" | "low" — how clearly you
  can actually see the frames (low = blurry/dark/too short to judge)
- observed_end_state: one sentence describing the FINAL frame — character
  positions, posture, props, facing direction (used to chain the next shot)

Respond with ONE JSON object only:
{{"identity": 0-1, "action": 0-1, "scene": 0-1, "text_ok": 0-1,
  "verdict": "accept|accept_with_deviation|repair|reject",
  "deviation": "str",
  "observation_confidence": "high|medium|low",
  "observed_end_state": "str",
  "issues": ["short failure tags"]}}"""


class GemmaVisionJudge:
    """VisionJudge protocol implementation."""

    def __init__(self, asset_store, base: Optional[str] = None,
                 model: Optional[str] = None, timeout: float = 300.0):
        self.asset_store = asset_store
        self.client = TextModelClient(
            base=base or settings.VISION_MODEL_BASE,
            model=model or settings.VISION_MODEL_NAME, timeout=timeout)

    # ------------------------------------------------------------ frames ---
    def _extract_frames(self, video_path: str, duration: float) -> list[Path]:
        frames: list[Path] = []
        tmpdir = Path(tempfile.mkdtemp(prefix="svf_frames_"))
        span = duration if duration > 0 else 4.0
        for i in range(N_FRAMES):
            t = span * (i + 0.5) / N_FRAMES
            out = tmpdir / f"frame_{i}.png"
            try:
                subprocess.run(
                    [FFMPEG, "-y", "-v", "error", "-ss", f"{t:.2f}",
                     "-i", video_path, "-frames:v", "1", str(out)],
                    capture_output=True, timeout=60, check=True)
                frames.append(out)
            except (subprocess.SubprocessError, OSError):
                break
        return frames

    # ------------------------------------------------------------- score ---
    def score_video(self, video_key: str, spec: ShotSpec) -> ScoreReport:
        rubric = spec.acceptance.rubric_version
        path = Path(self.asset_store.path_for(video_key))
        exists = path.exists() and path.stat().st_size > 0
        hard: dict[str, bool] = {"decodable": bool(exists)}
        if not exists:
            return ScoreReport(run_id="", verdict="repair", hard_checks=hard,
                               uncertain=False, rubric_version=rubric,
                               evidence=[{"tag": "missing_file"}])

        probe: dict[str, Any] = {}
        if FFPROBE:
            probe = _probe_ffprobe(path)
            if probe.get("duration"):
                hard["duration_ok"] = abs(probe["duration"] - spec.duration_s) <= 1.0
            if probe.get("width"):
                hard["resolution_ok"] = probe["width"] >= 512

        if not FFMPEG:
            # No frame extraction on this host: hard checks only, semantics unknown.
            return ScoreReport(run_id="", verdict="uncertain", hard_checks=hard,
                               scores={}, uncertain=True, rubric_version=rubric,
                               evidence=[{"tag": "no_ffmpeg_semantics_skipped"}])

        duration = float(probe.get("duration") or spec.duration_s)
        frames = self._extract_frames(str(path), duration)
        if not frames:
            hard["decodable"] = False
            return ScoreReport(run_id="", verdict="repair", hard_checks=hard,
                               uncertain=False, rubric_version=rubric,
                               evidence=[{"tag": "frame_extract_failed"}])

        content: list[dict] = [{"type": "text", "text":
                                _JUDGE_INSTRUCTIONS.format(
                                    n=len(frames),
                                    required="\n".join(f"- {r}" for r in spec.acceptance.required) or "- (none)",
                                    forbidden="\n".join(f"- {f}" for f in spec.acceptance.forbidden) or "- (none)",
                                )}]
        for frame in frames:
            b64 = base64.b64encode(frame.read_bytes()).decode("ascii")
            content.append({"type": "image_url", "image_url":
                            {"url": f"data:image/png;base64,{b64}"}})

        scores: dict[str, float] = {}
        issues: list[str] = []
        parse_failed = False
        model_verdict = ""
        deviation = ""
        obs_confidence = "high"
        observed_end_state = ""
        try:
            reply = self.client.chat([{"role": "user", "content": content}],
                                     max_tokens=512, temperature=0.1)
            parsed = extract_json(reply)
            for key in ("identity", "action", "scene", "text_ok"):
                scores[key] = max(0.0, min(1.0, float(parsed.get(key, 0.0))))
            issues = [str(i) for i in parsed.get("issues") or []]
            model_verdict = str(parsed.get("verdict") or "")
            deviation = str(parsed.get("deviation") or "")
            obs_confidence = str(parsed.get("observation_confidence") or "high")
            if obs_confidence not in ("low", "medium", "high"):
                obs_confidence = "high"
            observed_end_state = str(parsed.get("observed_end_state") or "")
        except (ValueError, KeyError, TypeError):
            parse_failed = True

        hard_passed = all(hard.values())
        if not hard_passed:
            verdict = "repair"
        elif parse_failed:
            verdict = "uncertain"
        elif model_verdict == "accept_with_deviation" \
                and all(v >= REPAIR_MAX for v in scores.values()):
            # 基本符合但有可接受偏差：放行但记录偏差说明
            verdict = "accept_with_deviation"
        elif any(v < REPAIR_MAX for v in scores.values()):
            verdict = "repair"
        elif all(v >= ACCEPT_MIN for v in scores.values()):
            verdict = "accept"
        else:
            verdict = "uncertain"

        evidence = [{"tag": t} for t in issues]
        return ScoreReport(run_id="", verdict=verdict, hard_checks=hard,
                           scores=scores, evidence=evidence,
                           uncertain=(verdict == "uncertain"),
                           rubric_version=rubric,
                           deviation=deviation,
                           observation_confidence=obs_confidence,
                           observed_end_state=observed_end_state)
