# SPDX-License-Identifier: GPL-3.0-only
"""seedance 提示词工程波次测试：ShotSpec 序列/节拍字段、密度负载分、
_compose_prompt 注入（三桶/多人/参考图/观测态）、judge 新 verdict、
engine 验收对账（accept_with_deviation / 低置信转人工 / 末态写回）。
全部 mock，不碰真实 LLM/渲染。
"""
from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if "svf" not in sys.modules:
    pkg = types.ModuleType("svf")
    pkg.__path__ = [str(ROOT)]
    sys.modules["svf"] = pkg

from fastapi.testclient import TestClient  # noqa: E402

import svf.adapters.vision_judge.judge as judge_mod  # noqa: E402
from svf.adapters.vision_judge.judge import GemmaVisionJudge  # noqa: E402
from svf.apps.api.app import _compose_prompt, create_app  # noqa: E402
from svf.domain.repositories.store import Store  # noqa: E402
from svf.domain.schemas.core import (  # noqa: E402
    Project, Scene, ScoreReport, Shot, ShotSpec, new_id,
)
from svf.quality.density import density_score, emotion_hits  # noqa: E402

from tests.test_api import (  # noqa: E402
    FakeAssetStore, FakeJudge, FakeRenderer, FakeTextModel, wait_for,
)
from tests.test_director import make_project  # noqa: E402


# ------------------------------------------------------------------- helpers --
def make_shot(store, pid: str, order: int = 0, **spec_kw) -> Shot:
    if store.get("scenes", "sc_1") is None:
        store.put("scenes", Scene(scene_id="sc_1", project_id=pid, order=0))
    shot_id = new_id("shot")
    action = spec_kw.pop("action", "女主走近")
    shot = Shot(shot_id=shot_id, scene_id="sc_1", project_id=pid, order=order,
                spec=ShotSpec(shot_id=shot_id, action=action, **spec_kw))
    store.put("shots", shot)
    return shot


# ------------------------------------------------------------- schema 兼容 ---
def test_shotspec_new_fields_backward_compatible():
    """无新字段的旧 JSON 能正常 model_validate，新字段取默认值。"""
    old_spec = {"shot_id": "shot_1", "action": "走近", "dialogue": "你好",
                "duration_s": 5, "camera": {"shot_size": "close-up"}}
    spec = ShotSpec.model_validate(old_spec)
    assert spec.sequence_relation == "standalone"
    assert spec.beats == {} and spec.observed_end_state == ""
    assert spec.felt_intent == "" and spec.extension_depth == 0

    old_shot = {"shot_id": "shot_1", "scene_id": "sc", "project_id": "p",
                "order": 0, "spec": old_spec}
    shot = Shot.model_validate_json(json.dumps(old_shot))
    assert shot.spec.sequence_relation == "standalone"

    old_report = {"run_id": "r1", "verdict": "accept"}
    report = ScoreReport.model_validate(old_report)
    assert report.observation_confidence == "high"
    assert report.observed_end_state == "" and report.deviation == ""


# ------------------------------------------------------------- density 分数 ---
def test_density_score():
    base = dict(shot_id="s")
    # 台词每句 +1
    spec = ShotSpec(**base, dialogue="你还好吗。我很好！你呢？")
    assert density_score(spec) == 3.0
    # 每个角色 +1
    spec = ShotSpec(**base, characters=[{"name": "a"}, {"name": "b"}])
    assert density_score(spec) == 2.0
    # 运镜非静态 +0.5；景别不算运镜；固定运镜不计
    assert density_score(ShotSpec(**base, camera={"movement": "pan"})) == 0.5
    assert density_score(ShotSpec(**base, camera={"shot_size": "close-up"})) == 0.0
    assert density_score(ShotSpec(**base, camera={"运镜": "固定"})) == 0.0
    # 切入新场景 +2
    assert density_score(ShotSpec(**base, sequence_relation="sequence_first")) == 2.0
    assert density_score(ShotSpec(**base, sequence_relation="next_shot")) == 0.0
    # 组合
    spec = ShotSpec(**base, dialogue="你好。", characters=[{"name": "a"}],
                    camera={"movement": "dolly"},
                    sequence_relation="sequence_first")
    assert density_score(spec) == 4.5


def test_emotion_hits():
    spec = ShotSpec(shot_id="s", action="她很紧张地坐下")
    assert emotion_hits(spec) == ["紧张"]
    spec = ShotSpec(shot_id="s", action="走近", felt_intent="an epic reveal")
    assert emotion_hits(spec) == ["epic"]
    assert emotion_hits(ShotSpec(shot_id="s", action="撑伞走近")) == []


# -------------------------------------------------------- _compose_prompt ----
def _project():
    return Project(title="t", style="写实", brief="b")


def test_compose_prompt_beats_and_multi_character():
    spec = ShotSpec(
        shot_id="s", action="艾米坐下", dialogue="好久不见",
        characters=[{"name": "艾米", "description": "黑发"}, {"name": "陈默"}],
        beats={"already_happened": ["两人曾在车站分别"],
               "this_clip_only": ["坐下"],
               "reserved_for_later": ["陈默掏出戒指"]})
    prompt = _compose_prompt(_project(), Shot(shot_id="s", scene_id="sc",
                                              project_id="p", spec=spec))
    assert "以下情节已发生，不要重演: 两人曾在车站分别" in prompt
    assert "不要提前出现: 陈默掏出戒指" in prompt
    assert "只有焦点角色执行主要动作" in prompt          # 多人约束
    assert "felt_intent" not in prompt                  # 内部意图不进提示词
    assert prompt.endswith("画面中不出现任何文字、字幕、水印、logo、标识")


def test_compose_prompt_single_character_no_multi_constraint():
    spec = ShotSpec(shot_id="s", action="坐下",
                    characters=[{"name": "艾米"}])
    prompt = _compose_prompt(_project(), Shot(shot_id="s", scene_id="sc",
                                              project_id="p", spec=spec))
    assert "非焦点人物" not in prompt


def test_compose_prompt_reference_carries_state():
    spec = ShotSpec(shot_id="s", action="走近", reference_assets=["asset_1"])
    prompt = _compose_prompt(_project(), Shot(shot_id="s", scene_id="sc",
                                              project_id="p", spec=spec))
    assert "参考图已包含角色外观与场景，请严格保持，文字仅描述动作与变化" in prompt


def test_compose_prompt_observed_end_state_continuation():
    prev = Shot(shot_id="s0", scene_id="sc", project_id="p", order=0,
                spec=ShotSpec(shot_id="s0", action="a",
                              observed_end_state="艾米站在门口，背对镜头"))
    cur = Shot(shot_id="s1", scene_id="sc", project_id="p", order=1,
               spec=ShotSpec(shot_id="s1", action="艾米转身"))
    prompt = _compose_prompt(_project(), cur, prev_shot=prev)
    assert "开场接续上一镜实际末态: 艾米站在门口，背对镜头" in prompt
    # 无观测态的前一镜不注入
    prev2 = Shot(shot_id="s0", scene_id="sc", project_id="p", order=0,
                 spec=ShotSpec(shot_id="s0", action="a"))
    assert "开场接续" not in _compose_prompt(_project(), cur, prev_shot=prev2)


def test_density_warning_event(tmp_path):
    """超限负载 + 裸情绪词：run 创建后记 density.warning 事件，prompt 不减内容。"""
    store = Store(tmp_path / "factory.db")
    asset_store = FakeAssetStore(tmp_path / "assets")
    app = create_app(store, asset_store, renderer=FakeRenderer(asset_store),
                     judge=FakeJudge(), text_model=FakeTextModel(),
                     data_dir=str(tmp_path / "data"), start_worker=False)
    client = TestClient(app)
    try:
        pid = make_project(client)
        shot = make_shot(store, pid, dialogue="你来了。坐吧。喝点东西。我们谈谈。",
                         action="她很紧张地走进来")
        r = client.post(f"/shots/{shot.shot_id}/runs", json={"command_id": "c1"})
        assert r.status_code == 201, r.text
        run_id = r.json()["run_id"]
        # prompt 内容不减
        assert "你来了。坐吧。喝点东西。我们谈谈。" in r.json()["prompt_spec"]
        steps = client.get(f"/runs/{run_id}/steps").json()["steps"]
        warn = [s for s in steps if s["type"] == "density.warning"]
        assert len(warn) == 1
        assert warn[0]["progress"]["load"] == 4.0
        assert warn[0]["progress"]["emotion_words"] == ["紧张"]
        assert "建议拆分镜头" in warn[0]["summary"]
    finally:
        app.state.engine.shutdown()
        store.close()


def test_create_run_injects_prev_observed_end_state(tmp_path):
    """create_run 查同场景前一镜的 observed_end_state 注入 prompt。"""
    store = Store(tmp_path / "factory.db")
    asset_store = FakeAssetStore(tmp_path / "assets")
    app = create_app(store, asset_store, renderer=FakeRenderer(asset_store),
                     judge=FakeJudge(), text_model=FakeTextModel(),
                     data_dir=str(tmp_path / "data"), start_worker=False)
    client = TestClient(app)
    try:
        pid = make_project(client)
        shot0 = make_shot(store, pid, order=0)
        shot0.spec.observed_end_state = "艾米站在门口，背对镜头"
        store.put("shots", shot0)
        shot1 = make_shot(store, pid, order=1)
        r = client.post(f"/shots/{shot1.shot_id}/runs", json={"command_id": "c2"})
        assert "开场接续上一镜实际末态: 艾米站在门口，背对镜头" \
            in r.json()["prompt_spec"]
        # 第一镜（order=0）无前镜，不注入
        r = client.post(f"/shots/{shot0.shot_id}/runs", json={"command_id": "c3"})
        assert "开场接续" not in r.json()["prompt_spec"]
    finally:
        app.state.engine.shutdown()
        store.close()


# ------------------------------------------------------------------- judge ---
class _FakeVisionReply:
    def __init__(self, payload: dict):
        self.payload = payload

    def chat(self, messages, max_tokens=2048, temperature=0.7):
        return json.dumps(self.payload, ensure_ascii=False)


def _judge_with_reply(tmp_path, monkeypatch, payload: dict) -> tuple:
    asset_store = FakeAssetStore(tmp_path / "assets")
    video = asset_store.save_bytes(b"fake-video", "p", "video", "v.mp4",
                                   source="generated")
    judge = GemmaVisionJudge(asset_store)
    judge.client = _FakeVisionReply(payload)
    monkeypatch.setattr(judge_mod, "FFMPEG", "/usr/bin/ffmpeg")
    frame = tmp_path / "f.png"
    frame.write_bytes(b"\x89PNG\r\n\x1a\nfake")
    monkeypatch.setattr(GemmaVisionJudge, "_extract_frames",
                        lambda self, vp, dur: [frame])
    return judge, video.storage_key


def test_judge_accept_with_deviation(tmp_path, monkeypatch):
    judge, video_key = _judge_with_reply(tmp_path, monkeypatch, {
        "identity": 0.9, "action": 0.85, "scene": 0.9, "text_ok": 1.0,
        "verdict": "accept_with_deviation", "deviation": "雨伞颜色偏差",
        "observation_confidence": "medium",
        "observed_end_state": "艾米站在门口，背对镜头"})
    spec = ShotSpec(shot_id="s", duration_s=5)
    report = judge.score_video(video_key, spec)
    assert report.verdict == "accept_with_deviation"
    assert report.deviation == "雨伞颜色偏差"
    assert report.observation_confidence == "medium"
    assert report.observed_end_state == "艾米站在门口，背对镜头"


def test_judge_deviation_with_low_score_stays_repair(tmp_path, monkeypatch):
    judge, video_key = _judge_with_reply(tmp_path, monkeypatch, {
        "identity": 0.4, "action": 0.9, "scene": 0.9, "text_ok": 1.0,
        "verdict": "accept_with_deviation"})
    report = judge.score_video(video_key, ShotSpec(shot_id="s", duration_s=5))
    assert report.verdict == "repair"      # 分数太差不许用偏差名义放行


def test_judge_old_reply_without_new_fields(tmp_path, monkeypatch):
    """旧格式回复（无新字段）容错：置信度默认 high。"""
    judge, video_key = _judge_with_reply(tmp_path, monkeypatch, {
        "identity": 0.9, "action": 0.9, "scene": 0.9, "text_ok": 0.9,
        "issues": []})
    report = judge.score_video(video_key, ShotSpec(shot_id="s", duration_s=5))
    assert report.verdict == "accept"
    assert report.observation_confidence == "high"
    assert report.observed_end_state == ""


# ------------------------------------------------------------------ engine ---
def _run_pipeline(tmp_path, judge_report: ScoreReport):
    """跑通一个 shot 的完整 run，返回 (client, store, pid, shot_id, run_id)。"""
    store = Store(tmp_path / "factory.db")
    asset_store = FakeAssetStore(tmp_path / "assets")

    class _Judge:
        def score_video(self, video_key, spec):
            return judge_report.model_copy()

    app = create_app(store, asset_store, renderer=FakeRenderer(asset_store),
                     judge=_Judge(), decision=None, text_model=FakeTextModel(),
                     data_dir=str(tmp_path / "data"), worker_poll_interval_s=0.05)
    client = TestClient(app)
    pid = make_project(client)
    shot = make_shot(store, pid, dialogue="你还好吗")
    r = client.post(f"/shots/{shot.shot_id}/runs", json={"command_id": "cmd-x"})
    run_id = r.json()["run_id"]
    return app, client, store, pid, shot.shot_id, run_id


def test_engine_accept_with_deviation_writes_end_state(tmp_path):
    report = ScoreReport(run_id="?", verdict="accept_with_deviation",
                         scores={"overall": 0.8}, deviation="雨伞颜色偏差",
                         observation_confidence="high",
                         observed_end_state="艾米站在门口，背对镜头")
    app, client, store, pid, shot_id, run_id = _run_pipeline(tmp_path, report)
    try:
        assert wait_for(lambda: client.get(f"/runs/{run_id}").json()["run"]["state"]
                        in ("ACCEPTED", "HUMAN_REVIEW", "FAILED"))
        run = client.get(f"/runs/{run_id}").json()["run"]
        assert run["state"] == "ACCEPTED"
        shot = store.get("shots", shot_id)
        assert shot.accepted_run_id == run_id
        # 评审观测末态写回 shot.spec
        assert shot.spec.observed_end_state == "艾米站在门口，背对镜头"
    finally:
        app.state.engine.shutdown()
        store.close()


def test_engine_low_observation_confidence_goes_human_review(tmp_path):
    report = ScoreReport(run_id="?", verdict="accept",
                         scores={"overall": 0.9},
                         observation_confidence="low")
    app, client, store, pid, shot_id, run_id = _run_pipeline(tmp_path, report)
    try:
        assert wait_for(lambda: client.get(f"/runs/{run_id}").json()["run"]["state"]
                        in ("ACCEPTED", "HUMAN_REVIEW", "FAILED"))
        run = client.get(f"/runs/{run_id}").json()["run"]
        # 评审器看不清：不许自动通过
        assert run["state"] == "HUMAN_REVIEW"
        assert store.get("shots", shot_id).accepted_run_id is None
    finally:
        app.state.engine.shutdown()
        store.close()
