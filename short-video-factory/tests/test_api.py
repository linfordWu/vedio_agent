# SPDX-License-Identifier: GPL-3.0-only
"""Offline end-to-end API test with fully mocked adapters.

The repo root is not a valid Python package name, so it is aliased as the
``svf`` package (matching how apps/api/__main__.py boots the service).
"""
from __future__ import annotations

import hashlib
import json
import sys
import threading
import time
import types
import uuid
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
from svf.domain.schemas.core import Asset, DecisionAdvice, ScoreReport  # noqa: E402


# ------------------------------------------------------------- fake adapters --
class FakeAssetStore:
    """Filesystem AssetStore stand-in (implements adapters.contracts.AssetStore)."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def save_bytes(self, data, project_id, media_type, filename,
                   source="imported", parent_asset_ids=None):
        key = f"{project_id}/{uuid.uuid4().hex[:8]}_{filename}"
        path = self.root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return Asset(project_id=project_id, source=source, media_type=media_type,
                     sha256=hashlib.sha256(data).hexdigest(), storage_key=key,
                     status="READY", parent_asset_ids=list(parent_asset_ids or []))

    def save_file(self, src_path, project_id, media_type, filename,
                  source="imported", parent_asset_ids=None):
        return self.save_bytes(Path(src_path).read_bytes(), project_id, media_type,
                               filename, source=source,
                               parent_asset_ids=parent_asset_ids)

    def path_for(self, storage_key):
        return str(self.root / storage_key)

    def read_bytes(self, storage_key):
        return (self.root / storage_key).read_bytes()

    def probe(self, storage_key):
        return {"size": (self.root / storage_key).stat().st_size}

    def make_preview(self, asset):
        return ""


class FakeRenderer:
    def __init__(self, asset_store):
        self.asset_store = asset_store
        self.render_calls = 0

    def render_shot(self, prompt_spec, ref_image_keys, seed, duration_s=5,
                    aspect_ratio="9:16", on_progress=None):
        self.render_calls += 1
        if on_progress:
            on_progress(1, 2, "rendering")
            on_progress(2, 2, "done")
        asset = self.asset_store.save_bytes(
            f"fake-video|{prompt_spec}|{seed}".encode(), "proj", "video",
            "render.mp4", source="generated")
        return asset.storage_key

    def normalize_clip(self, source_key, duration_s, aspect_ratio):
        asset = self.asset_store.save_bytes(
            b"normalized|" + self.asset_store.read_bytes(source_key),
            "proj", "video", "normalized.mp4", source="derived")
        return asset.storage_key


class FakeJudge:
    def __init__(self, verdict="accept"):
        self.verdict = verdict

    def score_video(self, video_key, spec):
        return ScoreReport(run_id="?", verdict=self.verdict,
                           scores={"overall": 0.91})


class FakeDecision:
    def advise(self, state, allowed_actions):
        return DecisionAdvice(state_hash="x", allowed_actions=allowed_actions,
                              selected_action=allowed_actions[0], confidence=0.9,
                              accepted_by_policy=True)


class FakeTextModel:
    def chat(self, messages, max_tokens=2048, temperature=0.7):
        return "ok"

    def chat_json(self, instructions, payload, schema_hint, max_tokens=2048):
        if "scenes" in schema_hint:
            return {"scenes": [{"title": "雨夜", "summary": "男女主在雨夜重逢"}]}
        return {"shots": [{"action": "女主撑伞走近", "dialogue": "你还好吗",
                           "duration_s": 5, "aspect_ratio": "9:16",
                           "camera": {"shot_size": "close-up"},
                           "acceptance": {"required": ["雨伞"], "forbidden": []}}]}


# ------------------------------------------------------------------- helpers --
@pytest.fixture()
def env(tmp_path):
    store = Store(tmp_path / "factory.db")
    asset_store = FakeAssetStore(tmp_path / "assets")
    renderer = FakeRenderer(asset_store)
    app = create_app(store, asset_store, renderer=renderer, judge=FakeJudge(),
                     decision=FakeDecision(), text_model=FakeTextModel(),
                     data_dir=str(tmp_path / "data"), worker_poll_interval_s=0.05)
    client = TestClient(app)
    yield client, store, asset_store, renderer, app
    app.state.engine.shutdown()
    store.close()


def wait_for(cond, timeout=15.0, interval=0.05):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cond():
            return True
        time.sleep(interval)
    return False


def flat_shots(detail):
    return [s["shot"] for sc in detail["scenes"] for s in sc["shots"]]


def plan_and_get_shot(client):
    r = client.post("/projects", json={"title": "雨夜重逢", "style": "写实",
                                       "brief": "旧情人雨夜重逢", "duration_target_s": 30})
    assert r.status_code == 201, r.text
    pid = r.json()["project_id"]
    r = client.post(f"/projects/{pid}/plan")
    assert r.status_code == 202, r.text
    assert wait_for(lambda: len(flat_shots(client.get(f"/projects/{pid}").json())) == 1)
    return pid, flat_shots(client.get(f"/projects/{pid}").json())[0]["shot_id"]


def upload_asset(client, pid, filename, data: bytes, chunks=2):
    r = client.post("/assets/uploads", json={
        "project_id": pid, "filename": filename, "total_size": len(data)})
    assert r.status_code == 201, r.text
    uid = r.json()["upload_id"]
    step = (len(data) + chunks - 1) // chunks
    for i in range(chunks):
        part = data[i * step:(i + 1) * step]
        r = client.put(f"/assets/uploads/{uid}/parts/{i}", content=part)
        assert r.status_code == 200, r.text
    # re-send part 0: must be idempotent
    r = client.put(f"/assets/uploads/{uid}/parts/0", content=data[:step])
    assert r.status_code == 200
    sha = hashlib.sha256(data).hexdigest()
    r = client.post(f"/assets/uploads/{uid}/complete", json={"sha256": sha})
    assert r.status_code == 200, r.text
    asset = r.json()
    assert asset["status"] == "READY" and asset["sha256"] == sha
    # complete twice: idempotent, same asset
    r2 = client.post(f"/assets/uploads/{uid}/complete", json={"sha256": sha})
    assert r2.json()["asset_id"] == asset["asset_id"]
    return asset["asset_id"]


# --------------------------------------------------------------------- tests --
def test_full_pipeline(env):
    client, store, asset_store, renderer, app = env
    pid, shot_id = plan_and_get_shot(client)

    asset_id = upload_asset(client, pid, "ref.png", b"fake-image-bytes-" * 100)

    r = client.get("/assets", params={"project_id": pid})
    assert any(a["asset_id"] == asset_id for a in r.json())
    r = client.get(f"/assets/{asset_id}/file")
    assert r.status_code == 200 and r.content == b"fake-image-bytes-" * 100

    r = client.post(f"/shots/{shot_id}/asset-bindings",
                    json={"asset_id": asset_id, "role": "reference"})
    assert r.status_code == 201, r.text

    r = client.post(f"/shots/{shot_id}/runs", json={"command_id": "cmd-1"})
    assert r.status_code == 201, r.text
    run_id = r.json()["run_id"]
    assert r.json()["state"] == "QUEUED"
    # same command_id returns the existing run instead of creating a new one
    r2 = client.post(f"/shots/{shot_id}/runs", json={"command_id": "cmd-1"})
    assert r2.json()["run_id"] == run_id

    assert wait_for(lambda: client.get(f"/runs/{run_id}").json()["run"]["state"]
                    in ("ACCEPTED", "HUMAN_REVIEW", "FAILED", "CANCELLED"))
    detail = client.get(f"/runs/{run_id}").json()
    assert detail["run"]["state"] == "ACCEPTED", detail["run"].get("failure")
    assert renderer.render_calls == 1
    assert detail["score_report"]["verdict"] == "accept"
    assert detail["score_report"]["hard_checks"]["file_readable"] is True

    shot = flat_shots(client.get(f"/projects/{pid}").json())[0]
    assert shot["accepted_run_id"] == run_id

    steps = client.get(f"/runs/{run_id}/steps").json()["steps"]
    types_seen = {s["type"] for s in steps}
    assert {"run.created", "step.queued", "tool.progress"} <= types_seen

    # export: ffmpeg is not installed here -> manifest mode
    r = client.post(f"/projects/{pid}/export")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["clips"] == 1 and body["asset"]["status"] == "READY"
    if body["mode"] == "manifest":
        manifest = json.loads(asset_store.read_bytes(body["asset"]["storage_key"]))
        assert manifest["clips"][0]["run_id"] == run_id


def test_sse_backlog(env):
    """SSE: backlog events are replayed first. TestClient buffers responses
    (starlette 1.7), so the infinite stream is exercised via a real uvicorn
    server on a loopback port (still fully offline)."""
    import socket

    import httpx
    import uvicorn

    client, store, _, _, app = env
    r = client.post("/projects", json={"title": "sse", "brief": "b"})
    pid = r.json()["project_id"]

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port,
                                           log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        assert wait_for(lambda: server.started, timeout=10)
        got = []
        with httpx.Client(base_url=f"http://127.0.0.1:{port}",
                          timeout=10) as http:
            with http.stream("GET", f"/projects/{pid}/events?seq=0") as resp:
                assert resp.status_code == 200
                assert resp.headers["content-type"].startswith("text/event-stream")
                for line in resp.iter_lines():
                    if line.startswith("data:"):
                        got.append(json.loads(line[len("data:"):]))
                        break
        assert got and got[0]["type"] == "project.created"
        assert got[0]["seq"] >= 1
    finally:
        server.should_exit = True
        thread.join(timeout=5)


class BlockingRenderer(FakeRenderer):
    """Render blocks until released, so cancel lands mid-render."""

    def __init__(self, asset_store):
        super().__init__(asset_store)
        self.started = threading.Event()
        self.release = threading.Event()

    def render_shot(self, prompt_spec, ref_image_keys, seed, duration_s=5,
                    aspect_ratio="9:16", on_progress=None):
        self.render_calls += 1
        if on_progress:
            on_progress(1, 2, "rendering")
        self.started.set()
        assert self.release.wait(timeout=10)
        return super().render_shot(prompt_spec, ref_image_keys, seed,
                                   duration_s, aspect_ratio, on_progress)


def test_cancel_rejects_late_result(tmp_path):
    store = Store(tmp_path / "factory.db")
    asset_store = FakeAssetStore(tmp_path / "assets")
    renderer = BlockingRenderer(asset_store)
    app = create_app(store, asset_store, renderer=renderer, judge=FakeJudge(),
                     decision=None, text_model=FakeTextModel(),
                     data_dir=str(tmp_path / "data"), worker_poll_interval_s=0.05)
    client = TestClient(app)
    try:
        r = client.post("/runs/run_nope/commands",
                        json={"action": "pause", "command_id": "c0"})
        assert r.status_code == 404

        pid, shot_id = plan_and_get_shot(client)
        r = client.post(f"/shots/{shot_id}/runs", json={"command_id": "cmd-cancel"})
        run_id = r.json()["run_id"]
        assert renderer.started.wait(timeout=10)   # run is RENDERING now

        # command_id dedupe
        client.post(f"/runs/{run_id}/commands", json={"action": "pause", "command_id": "c1"})
        dup = client.post(f"/runs/{run_id}/commands",
                          json={"action": "pause", "command_id": "c1"})
        assert dup.json()["status"] == "duplicate"
        client.post(f"/runs/{run_id}/commands", json={"action": "resume", "command_id": "c2"})

        # cancel mid-render, then let the renderer finish late
        r = client.post(f"/runs/{run_id}/commands",
                        json={"action": "cancel", "command_id": "c3"})
        assert r.status_code == 200, r.text
        assert r.json()["run"]["state"] == "CANCEL_REQUESTED"
        renderer.release.set()
        assert wait_for(lambda: client.get(f"/runs/{run_id}").json()["run"]["state"]
                        == "CANCELLED")
        run = client.get(f"/runs/{run_id}").json()["run"]
        assert run["candidate_asset_ids"] == []    # late product discarded
        # terminal state rejects further cancels
        r = client.post(f"/runs/{run_id}/commands",
                        json={"action": "cancel", "command_id": "c4"})
        assert r.status_code == 409
    finally:
        renderer.release.set()
        app.state.engine.shutdown()
        store.close()


def test_human_review_accept(tmp_path):
    store = Store(tmp_path / "factory.db")
    asset_store = FakeAssetStore(tmp_path / "assets")
    renderer = FakeRenderer(asset_store)
    app = create_app(store, asset_store, renderer=renderer,
                     judge=FakeJudge(verdict="uncertain"), decision=None,
                     text_model=FakeTextModel(), data_dir=str(tmp_path / "data"),
                     worker_poll_interval_s=0.05)
    client = TestClient(app)
    try:
        pid, shot_id = plan_and_get_shot(client)
        r = client.post(f"/shots/{shot_id}/runs", json={"command_id": "cmd-hr"})
        run_id = r.json()["run_id"]
        assert wait_for(lambda: client.get(f"/runs/{run_id}").json()["run"]["state"]
                        == "HUMAN_REVIEW")
        r = client.post(f"/runs/{run_id}/review",
                        json={"decision": "accept", "note": "ok"})
        assert r.status_code == 200, r.text
        assert r.json()["state"] == "ACCEPTED"
        shot = flat_shots(client.get(f"/projects/{pid}").json())[0]
        assert shot["accepted_run_id"] == run_id
    finally:
        app.state.engine.shutdown()
        store.close()


def test_upload_sha_mismatch_fails(env):
    client, store, _, _, _ = env
    r = client.post("/projects", json={"title": "bad", "brief": "b"})
    pid = r.json()["project_id"]
    data = b"some-bytes"
    uid = client.post("/assets/uploads", json={
        "project_id": pid, "filename": "x.mp4", "total_size": len(data)}).json()["upload_id"]
    client.put(f"/assets/uploads/{uid}/parts/0", content=data)
    r = client.post(f"/assets/uploads/{uid}/complete", json={"sha256": "0" * 64})
    assert r.status_code == 400
    session = store.get("uploads", uid)
    assert session.status == "FAILED"
