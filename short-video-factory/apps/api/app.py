# SPDX-License-Identifier: GPL-3.0-only
"""FastAPI surface for the short-video factory.

Adapters are injected through create_app() so tests can wire mocks;
build_default() constructs the real adapters (lazy imports, degraded to
None with a log line when an adapter cannot be loaded).
"""
from __future__ import annotations

import asyncio
import importlib
import json
import logging
import shutil
import subprocess
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from ...config import settings
from ...domain.repositories.store import Store
from ...domain.schemas.core import (
    Acceptance, Asset, AssetBinding, Event, Project, RepairPlan, Run, Scene,
    Shot, ShotSpec, new_id, now_ts,
)
from ...ingestion.uploader import Uploader, UploadError
from ...workers.engine import WorkerEngine

log = logging.getLogger(__name__)

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

_MEDIA_MIME = {"video": "video/mp4", "image": "image/png",
               "audio": "audio/mpeg", "text": "text/plain"}


# ----------------------------------------------------------- request bodies --
class ProjectCreate(BaseModel):
    title: str = ""
    style: str = ""
    brief: str = ""
    duration_target_s: int = 60


class UploadCreate(BaseModel):
    project_id: str
    filename: str
    total_size: int
    chunk_size: int = 8 * 1024 * 1024


class CompleteRequest(BaseModel):
    sha256: Optional[str] = None
    media_type: Optional[str] = None


class BindingCreate(BaseModel):
    asset_id: str
    role: str = "reference"          # reference | first_frame | reuse_clip | audio
    clip_range: Optional[list[float]] = None


class RunCreate(BaseModel):
    command_id: str = ""             # idempotency key
    seed: Optional[int] = None
    max_repairs: Optional[int] = None


class RunCommand(BaseModel):
    action: str                      # pause | resume | cancel | retry
    command_id: str = ""


class ReviewRequest(BaseModel):
    decision: str                    # accept | reject | note
    note: str = ""


# -------------------------------------------------------------------- plan --
def _run_plan(store: Store, text_model, project: Project) -> None:
    """Background planning thread: screenwriter -> scenes, director -> shots."""
    pid = project.project_id

    def ev(type_: str, actor: str, summary: str = "") -> Event:
        return Event(project_id=pid, type=type_, actor=actor, summary=summary)

    try:
        store.append_event(ev("agent.started", "screenwriter", "planning scenes"))
        sc = text_model.chat_json(
            "你是短剧编剧 agent。把创意简报拆成有序场景，只输出 JSON。",
            {"title": project.title, "style": project.style,
             "brief": project.brief,
             "duration_target_s": project.duration_target_s},
            '{"scenes":[{"title":str,"summary":str}]}')
        scenes = sc.get("scenes") or []
        store.append_event(ev("agent.completed", "screenwriter",
                              f"{len(scenes)} scenes"))
        for i, s in enumerate(scenes):
            scene = Scene(scene_id=new_id("scene"), project_id=pid, order=i,
                          title=str(s.get("title", "")),
                          summary=str(s.get("summary", "")))
            store.put("scenes", scene)
            store.append_event(ev("agent.started", "director",
                                  f"shots for scene {scene.title}"))
            sh = text_model.chat_json(
                "你是短剧导演 agent。把场景拆成有序镜头，只输出 JSON。",
                {"project_style": project.style,
                 "scene": {"title": scene.title, "summary": scene.summary}},
                '{"shots":[{"action":str,"dialogue":str,"duration_s":int,'
                '"aspect_ratio":str,"camera":{str:str},'
                '"acceptance":{"required":[str],"forbidden":[str]}}]}')
            for j, d in enumerate(sh.get("shots") or []):
                shot_id = new_id("shot")
                try:
                    acceptance = Acceptance(**(d.get("acceptance") or {}))
                except Exception:
                    acceptance = Acceptance()
                spec = ShotSpec(
                    shot_id=shot_id,
                    action=str(d.get("action", "")),
                    dialogue=str(d.get("dialogue", "")),
                    duration_s=int(d.get("duration_s") or 5),
                    aspect_ratio=str(d.get("aspect_ratio") or "9:16"),
                    camera={str(k): str(v)
                            for k, v in (d.get("camera") or {}).items()},
                    acceptance=acceptance)
                store.put("shots", Shot(shot_id=shot_id, scene_id=scene.scene_id,
                                        project_id=pid, order=j, spec=spec))
            store.append_event(ev("agent.completed", "director",
                                  f"scene {i} shots saved"))
        store.append_event(ev("plan.completed", "screenwriter",
                              f"{len(scenes)} scenes planned"))
    except Exception as exc:
        log.exception("planning failed for project %s", pid)
        store.append_event(ev("plan.failed", "screenwriter", str(exc)[:300]))


def _compose_prompt(project: Optional[Project], shot: Shot) -> str:
    spec = shot.spec
    parts = []
    if project and project.style:
        parts.append(f"风格: {project.style}")
    if spec.action:
        parts.append(spec.action)
    if spec.dialogue:
        parts.append(f"台词: {spec.dialogue}")
    if spec.camera:
        parts.append("镜头: " + ", ".join(f"{k}={v}" for k, v in spec.camera.items()))
    return " | ".join(parts) or f"shot {shot.shot_id}"


# --------------------------------------------------------------- application --
def create_app(store: Store, asset_store, renderer=None, judge=None,
               decision=None, text_model=None, data_dir: Optional[str] = None,
               start_worker: bool = True,
               worker_poll_interval_s: float = 0.5) -> FastAPI:
    engine = WorkerEngine(store, asset_store, renderer=renderer, judge=judge,
                          decision=decision, text_model=text_model,
                          poll_interval_s=worker_poll_interval_s)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        engine.shutdown()

    app = FastAPI(title="short-video-factory", lifespan=lifespan)
    uploader = Uploader(store, asset_store, data_dir or settings.DATA_DIR)
    app.state.engine = engine
    app.state.uploader = uploader
    if start_worker:
        engine.start()

    def _get_or_404(table: str, key: str):
        obj = store.get(table, key)
        if obj is None:
            raise HTTPException(404, f"{table}/{key} not found")
        return obj

    # ------------------------------------------------------------ projects --
    @app.get("/projects")
    def list_projects() -> dict:
        projects = sorted(store.all("projects"),
                          key=lambda p: p.created_at, reverse=True)
        return {"projects": projects}

    @app.post("/projects", status_code=201)
    def create_project(body: ProjectCreate) -> Project:
        project = Project(title=body.title, style=body.style, brief=body.brief,
                          duration_target_s=body.duration_target_s)
        store.put("projects", project)
        store.append_event(Event(project_id=project.project_id,
                                 type="project.created", actor="api",
                                 summary=project.title))
        return project

    @app.post("/projects/{project_id}/plan", status_code=202)
    def plan_project(project_id: str) -> dict:
        project = _get_or_404("projects", project_id)
        if text_model is None:
            raise HTTPException(503, "text model not configured")
        existing = store.all("scenes", project_id=project_id)
        if existing:
            return {"status": "planned", "scenes": len(existing)}
        threading.Thread(target=_run_plan, args=(store, text_model, project),
                         name=f"svf-plan-{project_id}", daemon=True).start()
        return {"status": "planning"}

    @app.get("/projects/{project_id}")
    def get_project(project_id: str) -> dict:
        project = _get_or_404("projects", project_id)
        scenes = sorted(store.all("scenes", project_id=project_id),
                        key=lambda s: s.order)
        shots = store.all("shots", project_id=project_id)
        runs = store.all("runs", project_id=project_id)
        runs_by_shot: dict[str, list[Run]] = {}
        for r in runs:
            runs_by_shot.setdefault(r.shot_id, []).append(r)
        out_scenes = []
        for scene in scenes:
            scene_shots = sorted([s for s in shots if s.scene_id == scene.scene_id],
                                 key=lambda s: s.order)
            out_scenes.append({
                "scene": scene,
                "shots": [{"shot": s,
                           "runs": sorted(runs_by_shot.get(s.shot_id, []),
                                          key=lambda r: r.created_at)}
                          for s in scene_shots],
            })
        return {"project": project, "scenes": out_scenes,
                "shots": sorted(shots, key=lambda s: (s.scene_id, s.order)),
                "runs": sorted(runs, key=lambda r: r.created_at),
                "counts": {"scenes": len(scenes), "shots": len(shots),
                           "runs": len(runs),
                           "accepted": sum(1 for s in shots if s.accepted_run_id)}}

    # -------------------------------------------------------------- uploads --
    @app.post("/assets/uploads", status_code=201)
    def create_upload(body: UploadCreate):
        _get_or_404("projects", body.project_id)
        return uploader.create(body.project_id, body.filename, body.total_size,
                               body.chunk_size)

    @app.put("/assets/uploads/{upload_id}/parts/{part_no}")
    async def put_part(upload_id: str, part_no: int, request: Request):
        data = await request.body()
        try:
            return uploader.write_part(upload_id, part_no, data)
        except KeyError:
            raise HTTPException(404, f"upload {upload_id} not found")
        except UploadError as exc:
            raise HTTPException(409, str(exc))

    @app.post("/assets/uploads/{upload_id}/complete")
    def complete_upload(upload_id: str, body: Optional[CompleteRequest] = None):
        body = body or CompleteRequest()
        try:
            return uploader.complete(upload_id, sha256=body.sha256,
                                     media_type=body.media_type)
        except KeyError:
            raise HTTPException(404, f"upload {upload_id} not found")
        except UploadError as exc:
            raise HTTPException(400, str(exc))

    # --------------------------------------------------------------- assets --
    @app.get("/assets")
    def list_assets(project_id: Optional[str] = None) -> list:
        if project_id:
            return store.all("assets", project_id=project_id)
        return store.all("assets")

    @app.get("/assets/{asset_id}/file")
    def get_asset_file(asset_id: str):
        asset = _get_or_404("assets", asset_id)
        if not asset.storage_key:
            raise HTTPException(404, "asset has no stored file")
        path = asset_store.path_for(asset.storage_key)

        def stream():
            with open(path, "rb") as f:
                while True:
                    chunk = f.read(1 << 20)
                    if not chunk:
                        break
                    yield chunk

        filename = asset.metadata.get("original_filename", "file")
        return StreamingResponse(
            stream(), media_type=_MEDIA_MIME.get(asset.media_type,
                                                 "application/octet-stream"),
            headers={"Content-Disposition": f'inline; filename="{filename}"'})

    # ----------------------------------------------------------- shot wiring --
    @app.post("/shots/{shot_id}/asset-bindings", status_code=201)
    def bind_asset(shot_id: str, body: BindingCreate) -> AssetBinding:
        _get_or_404("shots", shot_id)
        asset = _get_or_404("assets", body.asset_id)
        for b in store.all("bindings", shot_id=shot_id):
            if b.asset_id == body.asset_id and b.role == body.role:
                return b            # idempotent re-bind
        binding = AssetBinding(shot_id=shot_id, asset_id=asset.asset_id,
                               asset_version=asset.version, role=body.role,
                               clip_range=body.clip_range)
        store.put("bindings", binding)
        shot = store.get("shots", shot_id)
        store.append_event(Event(project_id=shot.project_id, type="asset.bound",
                                 actor="api",
                                 summary=f"{body.role}: {asset.asset_id}"))
        return binding

    @app.post("/shots/{shot_id}/runs", status_code=201)
    def create_run(shot_id: str, body: RunCreate) -> Run:
        shot = _get_or_404("shots", shot_id)
        if body.command_id:
            for r in store.all("runs", shot_id=shot_id):
                if r.input_hash == body.command_id:
                    return r        # same command_id: return the existing run
        project = store.get("projects", shot.project_id)
        run = Run(shot_id=shot.shot_id, project_id=shot.project_id,
                  seed=body.seed if body.seed is not None else settings.DEFAULT_SEED,
                  prompt_spec=_compose_prompt(project, shot),
                  input_hash=body.command_id,
                  max_repairs=(body.max_repairs if body.max_repairs is not None
                               else settings.MAX_REPAIRS))
        store.put("runs", run)

        def ev(type_: str, summary: str = "") -> Event:
            return Event(project_id=run.project_id, run_id=run.run_id,
                         attempt_id=run.attempt_id, type=type_,
                         actor="orchestrator", summary=summary)

        store.transition_run(run.run_id, "ASSET_READY", ev("run.created"))
        if shot.spec.production_mode == "reuse":
            return store.get("runs", run.run_id)
        store.transition_run(run.run_id, "PROMPT_READY",
                             ev("prompt.ready", run.prompt_spec[:200]))
        store.transition_run(run.run_id, "QUEUED", ev("step.queued"))
        return store.get("runs", run.run_id)

    # ------------------------------------------------------------ run control --
    @app.get("/runs/{run_id}")
    def get_run(run_id: str) -> dict:
        run = _get_or_404("runs", run_id)
        return {"run": run, "score_report": store.get("score_reports", run_id)}

    @app.get("/runs/{run_id}/steps")
    def get_run_steps(run_id: str) -> dict:
        _get_or_404("runs", run_id)
        steps = sorted(store.all("events", run_id=run_id), key=lambda e: e.seq)
        return {"steps": steps}

    @app.post("/runs/{run_id}/commands")
    def run_command(run_id: str, body: RunCommand) -> dict:
        _get_or_404("runs", run_id)
        if body.command_id:
            for e in store.all("events", run_id=run_id):
                if e.type == "command.received" and e.summary == body.command_id:
                    return {"status": "duplicate",
                            "run": store.get("runs", run_id)}
        run = store.get("runs", run_id)
        store.append_event(Event(project_id=run.project_id, run_id=run_id,
                                 attempt_id=run.attempt_id,
                                 type="command.received", actor="api",
                                 summary=body.command_id or body.action,
                                 progress={"action": body.action}))
        if body.action == "pause":
            engine.pause_all()
        elif body.action == "resume":
            engine.resume_all()
        elif body.action == "cancel":
            try:
                engine.cancel_run(run_id)
            except ValueError as exc:
                raise HTTPException(409, str(exc))
        elif body.action == "retry":
            _retry_run(run_id)
        else:
            raise HTTPException(400, f"unknown action {body.action}")
        return {"status": "ok", "run": store.get("runs", run_id)}

    def _retry_run(run_id: str) -> None:
        run = store.get("runs", run_id)
        engine.reset_retries(run_id)

        def ev(type_: str, summary: str) -> Event:
            return Event(project_id=run.project_id, run_id=run_id,
                         attempt_id=run.attempt_id, type=type_,
                         actor="orchestrator", summary=summary)

        if run.state == "RETRY_WAIT":
            store.transition_run(run_id, "QUEUED", ev("run.requeued", "manual retry"),
                                 patch={"attempt_id": new_id("att")})
            return
        if run.state == "HUMAN_REVIEW":
            store.transition_run(run_id, "REPAIRING", ev("run.repairing", "manual retry"))
            store.put("repair_plans", RepairPlan(
                run_id=run_id, target="prompt", action="manual retry",
                detail="retry requested via API", invalidate_from="PROMPT_READY"))
            store.transition_run(run_id, "PROMPT_READY",
                                 ev("run.invalidated", "manual retry"))
            store.transition_run(run_id, "QUEUED", ev("step.queued", "manual retry"),
                                 patch={"attempt_id": new_id("att")})
            return
        raise HTTPException(409, f"cannot retry run in state {run.state}")

    @app.post("/runs/{run_id}/review")
    def review_run(run_id: str, body: ReviewRequest) -> Run:
        run = _get_or_404("runs", run_id)
        if run.state != "HUMAN_REVIEW":
            raise HTTPException(409, f"run is {run.state}, not HUMAN_REVIEW")

        def ev(type_: str, summary: str) -> Event:
            return Event(project_id=run.project_id, run_id=run_id,
                         attempt_id=run.attempt_id, type=type_,
                         actor="human-reviewer", summary=summary)

        if body.decision == "accept":
            store.transition_run(run_id, "ACCEPTED",
                                 ev("run.accepted", body.note or "human accept"))
            shot = store.get("shots", run.shot_id)
            shot.accepted_run_id = run_id
            if body.note:
                shot.review_note = body.note
            store.put("shots", shot)
        elif body.decision == "reject":
            store.transition_run(run_id, "REPAIRING",
                                 ev("run.repairing", body.note or "human reject"))
            store.put("repair_plans", RepairPlan(
                run_id=run_id, target="prompt", action="human rejected",
                detail=body.note, invalidate_from="PROMPT_READY"))
            store.transition_run(run_id, "PROMPT_READY",
                                 ev("run.invalidated", body.note or "rejected"))
            store.transition_run(run_id, "QUEUED",
                                 ev("step.queued", "requeued after human reject"),
                                 patch={"attempt_id": new_id("att")})
        elif body.decision == "note":
            store.append_event(ev("review.note", body.note))
            shot = store.get("shots", run.shot_id)
            shot.review_note = body.note
            store.put("shots", shot)
        else:
            raise HTTPException(400, f"unknown decision {body.decision}")
        return store.get("runs", run_id)

    # ---------------------------------------------------------------- export --
    @app.post("/projects/{project_id}/export")
    def export_project(project_id: str) -> dict:
        project = _get_or_404("projects", project_id)
        scene_order = {s.scene_id: s.order
                       for s in store.all("scenes", project_id=project_id)}
        shots = sorted(store.all("shots", project_id=project_id),
                       key=lambda s: (scene_order.get(s.scene_id, 0), s.order))
        if not shots:
            raise HTTPException(400, "project has no shots")
        pending = [s.shot_id for s in shots if not s.accepted_run_id]
        if pending:
            raise HTTPException(409, {"detail": "shots without accepted run",
                                      "pending_shot_ids": pending})
        clips = []
        for shot in shots:
            run = store.get("runs", shot.accepted_run_id)
            video = next((store.get("assets", aid)
                          for aid in run.candidate_asset_ids
                          if store.get("assets", aid)
                          and store.get("assets", aid).media_type == "video"), None)
            if video is None:
                raise HTTPException(409, f"accepted run {run.run_id} has no video asset")
            clips.append({"shot_id": shot.shot_id, "run_id": run.run_id,
                          "asset_id": video.asset_id,
                          "storage_key": video.storage_key})

        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg:
            asset = _try_ffmpeg_concat(ffmpeg, project, clips)
            if asset is not None:
                return {"asset": asset, "mode": "concat", "clips": len(clips)}
        manifest = {"project_id": project_id, "title": project.title,
                    "generated_at": now_ts(), "clips": clips}
        asset = asset_store.save_bytes(
            json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"),
            project_id, "text", "export_manifest.json", source="derived",
            parent_asset_ids=[c["asset_id"] for c in clips])
        asset.status = "READY"
        store.put("assets", asset)
        store.append_event(Event(project_id=project_id, type="export.completed",
                                 actor="orchestrator",
                                 summary=f"manifest with {len(clips)} clips"))
        return {"asset": asset, "mode": "manifest", "clips": len(clips)}

    def _try_ffmpeg_concat(ffmpeg: str, project: Project, clips: list) -> Optional[Asset]:
        export_id = new_id("export")
        workdir = Path(settings.DATA_DIR) / "exports" / export_id
        try:
            workdir.mkdir(parents=True, exist_ok=True)
            list_file = workdir / "concat.txt"
            list_file.write_text("".join(
                f"file '{asset_store.path_for(c['storage_key'])}'\n" for c in clips))
            out = workdir / f"{export_id}.mp4"
            res = subprocess.run(
                [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
                 "-c", "copy", str(out)],
                capture_output=True, text=True, timeout=600)
            if res.returncode != 0 or not out.exists() or out.stat().st_size == 0:
                log.warning("ffmpeg concat failed for %s: %s",
                            project.project_id, res.stderr[-500:])
                return None
            asset = asset_store.save_file(
                str(out), project.project_id, "video",
                f"{project.title or export_id}.mp4", source="derived",
                parent_asset_ids=[c["asset_id"] for c in clips])
            asset.status = "READY"
            store.put("assets", asset)
            store.append_event(Event(project_id=project.project_id,
                                     type="export.completed", actor="orchestrator",
                                     summary=f"concat {len(clips)} clips"))
            return asset
        except Exception:
            log.exception("ffmpeg concat errored")
            return None
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    # ------------------------------------------------------------------ SSE --
    @app.get("/projects/{project_id}/events")
    async def project_events(project_id: str, request: Request, seq: int = 0):
        _get_or_404("projects", project_id)

        async def gen():
            last = seq
            # backlog first, then live tail
            for e in store.events_since(project_id, last):
                last = e.seq
                yield f"data: {e.model_dump_json()}\n\n"
            while not await request.is_disconnected():
                await asyncio.sleep(1)
                new = store.events_since(project_id, last)
                for e in new:
                    last = e.seq
                    yield f"data: {e.model_dump_json()}\n\n"
                if not new:
                    yield ": hb\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream")

    # ------------------------------------------------------------- web page --
    if WEB_DIR.is_dir():
        app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")

    return app


# ------------------------------------------------------------- default wiring --
def _load_adapter(candidates: list[tuple[str, list[str], list[tuple]]],
                  label: str):
    """Try (relative module, attr names, ctor arg tuples) in order."""
    for mod_name, attrs, ctor_args in candidates:
        try:
            mod = importlib.import_module(mod_name, package=__package__)
        except Exception as exc:
            log.info("adapter %s: module %s unavailable: %s", label, mod_name, exc)
            continue
        for attr in attrs:
            cls = getattr(mod, attr, None)
            if cls is None:
                continue
            for args in ctor_args:
                try:
                    return cls(*args)
                except Exception as exc:
                    log.info("adapter %s: %s.%s%r failed: %s",
                             label, mod_name, attr, args, exc)
    log.warning("adapter %s: no implementation available, capability disabled",
                label)
    return None


def build_default() -> FastAPI:
    """Wire the real adapters; any that fail to import degrade to None."""
    store = Store(settings.DB_PATH)
    asset_store = _load_adapter([
        ("...adapters.asset_store.local", ["LocalAssetStore"],
         [(settings.ASSET_ROOT,), (str(settings.ASSET_ROOT),), ()]),
        ("...adapters.asset_store", ["LocalAssetStore", "FileAssetStore"],
         [(settings.ASSET_ROOT,), (str(settings.ASSET_ROOT),), ()]),
    ], "asset_store")
    if asset_store is None:
        raise RuntimeError("asset_store adapter is required but unavailable")
    renderer = _load_adapter([
        ("...adapters.comfyui.adapter", ["H3ComfyRenderer"],
         [(asset_store,), ()]),
        ("...adapters.comfyui", ["ComfyRenderer", "ComfyUIRenderer", "Renderer"],
         [(asset_store,), ()]),
    ], "renderer")
    judge = _load_adapter([
        ("...adapters.vision_judge.judge", ["GemmaVisionJudge"],
         [(asset_store,), ()]),
        ("...adapters.vision_judge", ["VisionJudge", "OllamaVisionJudge", "Judge"],
         [(asset_store,), ()]),
    ], "judge")
    decision = _load_adapter([
        ("...adapters.decision.laya_shadow", ["LayaShadowDecision"], [()]),
        ("...adapters.decision", ["DecisionAdapter", "OpenJevDecision",
                                  "LayaDecision", "Decision"],
         [(), (settings.OPENJEV_BASE, settings.OPENJEV_NAME)]),
    ], "decision")
    text_model = _load_adapter([
        ("...adapters.text_model.client", ["TextModelClient"],
         [(settings.TEXT_MODEL_BASE, settings.TEXT_MODEL_NAME), ()]),
        ("...adapters.text_model", ["TextModel", "OllamaTextModel", "ChatModel"],
         [(settings.TEXT_MODEL_BASE, settings.TEXT_MODEL_NAME), ()]),
    ], "text_model")
    return create_app(store, asset_store, renderer=renderer, judge=judge,
                      decision=decision, text_model=text_model)
