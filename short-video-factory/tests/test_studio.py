# SPDX-License-Identifier: GPL-3.0-only
"""六步工作室后端测试：项目进度聚合、shot PATCH、参考图移除、
Range 请求(206)、plan force 重新规划。全部 mock，离线。
"""
from __future__ import annotations

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

from svf.apps.api.app import create_app  # noqa: E402
from svf.domain.repositories.store import Store  # noqa: E402
from svf.domain.schemas.core import Run, Scene, Shot, ShotSpec, new_id  # noqa: E402

from tests.test_api import FakeAssetStore, FakeJudge, FakeTextModel, wait_for  # noqa: E402
from tests.test_director import make_image_asset, make_project  # noqa: E402


# ------------------------------------------------------------------- helpers --
@pytest.fixture()
def env(tmp_path):
    store = Store(tmp_path / "factory.db")
    asset_store = FakeAssetStore(tmp_path / "assets")
    app = create_app(store, asset_store, renderer=None, judge=FakeJudge(),
                     decision=None, text_model=FakeTextModel(),
                     data_dir=str(tmp_path / "data"), start_worker=False)
    client = TestClient(app)
    yield client, store, asset_store, app
    app.state.engine.shutdown()
    store.close()


def make_shot(store, pid: str, order: int = 0, **spec_kw) -> Shot:
    if store.get("scenes", "sc_1") is None:
        store.put("scenes", Scene(scene_id="sc_1", project_id=pid, order=0))
    shot_id = new_id("shot")
    action = spec_kw.pop("action", "女主走近")
    shot = Shot(shot_id=shot_id, scene_id="sc_1", project_id=pid, order=order,
                spec=ShotSpec(shot_id=shot_id, action=action, **spec_kw))
    store.put("shots", shot)
    return shot


# ----------------------------------------------------------------- progress --
def test_list_projects_progress(env):
    client, store, asset_store, _ = env
    pid_a = make_project(client)
    pid_b = make_project(client)

    # A：1 场景 1 镜头（已验收）1 run、2 角色（1 有定妆照）、1 个 derived 视频
    shot = make_shot(store, pid_a)
    run = Run(shot_id=shot.shot_id, project_id=pid_a, state="ACCEPTED")
    store.put("runs", run)
    shot.accepted_run_id = run.run_id
    store.put("shots", shot)
    img = make_image_asset(store, asset_store, pid_a)
    client.post(f"/projects/{pid_a}/characters",
                json={"name": "艾米", "kind": "character",
                      "asset_id": img.asset_id})
    client.post(f"/projects/{pid_a}/characters",
                json={"name": "咖啡馆", "kind": "location"})
    export = asset_store.save_bytes(b"final", pid_a, "video", "final.mp4",
                                    source="derived")
    store.put("assets", export)

    r = client.get("/projects")
    assert r.status_code == 200
    items = {p["project_id"]: p for p in r.json()["projects"]}
    # 项目字段保持在顶层（向后兼容），progress 附加
    assert items[pid_a]["title"] == "雨夜重逢"
    pa = items[pid_a]["progress"]
    assert pa == {"scenes": 1, "shots": 1, "runs": 1, "accepted": 1,
                  "characters": 1, "locations": 1, "portraits": 1,
                  "props": 0, "exports": 1}
    pb = items[pid_b]["progress"]
    assert pb == {"scenes": 0, "shots": 0, "runs": 0, "accepted": 0,
                  "characters": 0, "locations": 0, "portraits": 0,
                  "props": 0, "exports": 0}


# --------------------------------------------------------------- shot patch --
def test_patch_shot(env):
    client, store, _, _ = env
    pid = make_project(client)
    shot = make_shot(store, pid, dialogue="旧台词", duration_s=5)

    # 只改台词：其他字段不动
    r = client.patch(f"/shots/{shot.shot_id}", json={"dialogue": "新台词"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["spec"]["dialogue"] == "新台词"
    assert body["spec"]["action"] == "女主走近"
    assert body["spec"]["duration_s"] == 5

    # 改时长 + 运镜
    r = client.patch(f"/shots/{shot.shot_id}",
                     json={"duration_s": 8, "camera": {"movement": "pan"}})
    assert r.status_code == 200
    assert r.json()["spec"]["duration_s"] == 8
    assert r.json()["spec"]["camera"] == {"movement": "pan"}
    # 落库
    fresh = store.get("shots", shot.shot_id)
    assert fresh.spec.dialogue == "新台词" and fresh.spec.duration_s == 8

    assert client.patch("/shots/shot_nope", json={"action": "x"}).status_code == 404


# ------------------------------------------------------------- references ----
def test_remove_shot_reference(env):
    client, store, _, _ = env
    pid = make_project(client)
    shot = make_shot(store, pid, reference_assets=["asset_a", "asset_b"])

    r = client.delete(f"/shots/{shot.shot_id}/references/asset_a")
    assert r.status_code == 200, r.text
    assert r.json()["spec"]["reference_assets"] == ["asset_b"]
    assert store.get("shots", shot.shot_id).spec.reference_assets == ["asset_b"]

    # 移除不存在的：幂等不动
    r = client.delete(f"/shots/{shot.shot_id}/references/asset_zzz")
    assert r.status_code == 200
    assert r.json()["spec"]["reference_assets"] == ["asset_b"]

    assert client.delete("/shots/shot_nope/references/asset_a").status_code == 404


# ------------------------------------------------------------------- range ---
def test_asset_file_range(env):
    client, store, asset_store, _ = env
    pid = make_project(client)
    data = bytes(range(256)) * 4                     # 1024 字节假视频
    video = asset_store.save_bytes(data, pid, "video", "clip.mp4",
                                   source="generated")
    store.put("assets", video)

    # 全量：200
    r = client.get(f"/assets/{video.asset_id}/file")
    assert r.status_code == 200 and r.content == data
    assert r.headers.get("accept-ranges") == "bytes"

    # Range：206 + Content-Range
    r = client.get(f"/assets/{video.asset_id}/file",
                   headers={"Range": "bytes=100-199"})
    assert r.status_code == 206, r.text
    assert r.content == data[100:200]
    assert r.headers["content-range"] == "bytes 100-199/1024"


# ------------------------------------------------------------- force replan --
def test_plan_force_replan(env):
    client, store, _, _ = env
    pid = make_project(client)

    r = client.post(f"/projects/{pid}/plan")
    assert r.status_code == 202
    assert wait_for(lambda: len(store.all("shots", project_id=pid)) == 1)
    old_shot = store.all("shots", project_id=pid)[0]
    old_scene = store.all("scenes", project_id=pid)[0]
    old_events = len(store.events_since(pid))

    # 非 force：幂等返回 planned，不删旧数据
    r = client.post(f"/projects/{pid}/plan")
    assert r.json()["status"] == "planned"
    assert store.get("shots", old_shot.shot_id) is not None

    # 给旧镜头建个 run（QUEUED），force 后应被取消
    r = client.post(f"/shots/{old_shot.shot_id}/runs", json={"command_id": "c1"})
    old_run_id = r.json()["run_id"]

    r = client.post(f"/projects/{pid}/plan", params={"force": "true"})
    assert r.status_code == 202 and r.json()["status"] == "planning"
    assert wait_for(
        lambda: len(store.all("shots", project_id=pid)) == 1
        and store.all("shots", project_id=pid)[0].shot_id != old_shot.shot_id,
        timeout=10)

    # 旧 scenes/shots 已删
    assert store.get("scenes", old_scene.scene_id) is None
    # 旧 run 已取消（worker 未启动时停在 CANCEL_REQUESTED）
    assert store.get("runs", old_run_id).state in ("CANCEL_REQUESTED", "CANCELLED")
    # events 保留且新增 plan.reset
    events = store.events_since(pid)
    assert len(events) > old_events
    assert any(e.type == "plan.reset" for e in events)
    assert any(e.type == "project.created" for e in events)
