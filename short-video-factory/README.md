# Short Video Factory（短视频工厂 Agent）

按《短视频工厂方案架构图 v3》实现：Web 优先、状态机 + 可追溯产物、Laya 本地决策辅助、
本地模型推理（MiniMax H3 · ComfyUI / Qwen Image 2.1 / gemma3 / Laya）。

## 架构分层

| 层 | 模块 |
|---|---|
| Web 产品层 | `apps/web`（零构建单页工作台） |
| 编排与决策 | `apps/api`（FastAPI + SSE）、`domain/state_machine`、`adapters/decision`（Laya 影子模式 / Jev 接口占位） |
| 创作与资产 | `agents/`（编剧/分镜/提示词/修复）、`ingestion`、`adapters/asset_store` |
| 生成与质检 | `workers`、`adapters/comfyui`（H3 渲染）、`quality`、`adapters/vision_judge` |
| 交付与恢复 | export 合成、command_id 幂等、事件游标回放 |

## 快速开始

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
# 依赖服务：ComfyUI :8188、ollama gemma3:4b（172.19.0.2:11434）、llama-server :8091（可选）
.venv/bin/python -m apps.api        # http://localhost:8600
```

## 数据契约

见 `domain/schemas/core.py`（ShotSpec / ScoreReport / DecisionAdvice 等与架构文档 07 节一致）。
状态机见 `domain/state_machine/machine.py`（08 节转换图）。

## 验收路径

Web 导入角色图 → 绑定镜头 → 提交 ComfyUI 渲染 → 实时事件流 → 评分 → 审核 → 导出。
