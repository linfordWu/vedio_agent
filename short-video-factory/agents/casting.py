# SPDX-License-Identifier: GPL-3.0-only
"""角色定妆照生成：像素级身份锁定。

规划阶段登记的角色只有文字外观描述，渲染时模型仍可能漂移（换装/换发型）。
本模块为每个角色生成一张定妆参考图，写回 character.asset_id 并合入各镜头
的 reference_assets —— 渲染链路会把第一张参考图注入工作流作为身份锚。
"""
from __future__ import annotations

import logging

from ..domain.schemas.core import Character

log = logging.getLogger(__name__)

_PORTRAIT_PROMPT = (
    "{style}，角色定妆参考图，全身像，{name}：{description}，"
    "纯色简洁背景，正面站姿，面部清晰，画质精细，"
    "画面中不出现任何文字、字幕、水印、logo、标识"
)


def _portrait_prompt(style: str, ch: Character) -> str:
    style_part = style or "动画风格"
    return _PORTRAIT_PROMPT.format(style=style_part, name=ch.name,
                                   description=ch.description)


def generate_character_portraits(store, image_model, project_id: str,
                                 style: str = "") -> dict[str, str]:
    """为项目下所有缺参考图的角色生成定妆照。

    返回 {character_id: asset_id}（只含本次新生成的）。任何单个角色失败
    只告警不中断其余角色。
    """
    made: dict[str, str] = {}
    characters = [c for c in store.all("characters", project_id=project_id)
                  if c.kind == "character" and not c.asset_id]
    if not characters:
        return made

    assets_by_key = {a.storage_key: a for a in store.all("assets")}
    for ch in characters:
        try:
            out_key = f"{project_id}/cast/{ch.name}"
            storage_key = image_model.generate(
                _portrait_prompt(style, ch), out_key,
                width=832, height=1216)
            asset = assets_by_key.get(storage_key)
            if asset is None:  # asset_store 落库后重新查一次
                assets_by_key = {a.storage_key: a for a in store.all("assets")}
                asset = assets_by_key.get(storage_key)
            if asset is None:
                log.warning("portrait asset not found in store: %s", storage_key)
                continue
            asset.category = "character"
            store.put("assets", asset)
            ch.asset_id = asset.asset_id
            store.put("characters", ch)
            made[ch.character_id] = asset.asset_id
            log.info("portrait ready: %s -> %s", ch.name, asset.asset_id)
        except Exception:
            log.warning("portrait failed for %s", ch.name, exc_info=True)

    if not made:
        return made

    # 把定妆图合入所有引用该角色的镜头 reference_assets（置最前，渲染取第一张）
    for shot in store.all("shots", project_id=project_id):
        changed = False
        for entry in shot.spec.characters:
            aid = made.get(entry.get("character_id", ""))
            if aid and aid not in shot.spec.reference_assets:
                shot.spec.reference_assets.insert(0, aid)
                changed = True
        if changed:
            store.put("shots", shot)
    return made
