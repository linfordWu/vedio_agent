# Short Video Factory（短视频工厂 Agent）

按《短视频工厂方案架构图 v3》实现：Web 优先、状态机 + 可追溯产物、Laya 本地决策辅助、
本地模型推理（MiniMax H3 · ComfyUI / Qwen Image 2.1 / DeepSeek V4.1 Flash · Laya）。

## 架构分层

| 层 | 模块 |
|---|---|
| Web 产品层 | `apps/web`（零构建单页工作台,含 `#/chat` 对话出片:多轮对话 → 结构化分镜预览 → 一键出片） |
| 编排与决策 | `apps/api`（FastAPI + SSE + `/assistant/chat`、`/assistant/plan` 对话端点）、`domain/state_machine`、`adapters/decision`（Laya 影子模式 / Jev 接口占位） |
| 创作与资产 | `agents/`（编剧/分镜/提示词/修复/对话助理/结构化规划 `planner.py`）、`ingestion`、`adapters/asset_store` |
| 生成与质检 | `workers`、`adapters/comfyui`（H3 渲染）、`quality`、`adapters/vision_judge` |
| 交付与恢复 | export 合成、command_id 幂等、事件游标回放 |

## 快速开始

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env        # 编辑 .env：填入 DEEPSEEK_API_KEY（默认 agent 模型）
# 依赖服务：ComfyUI :8188、Qwen-Image 2.1 :8601、llama-server :8091（决策可选）
.venv/bin/python -m apps.api        # http://localhost:8600
```

> **刚从仓库下载下来？** 密钥不在仓库里（`.env` 被 gitignore，只有占位符
> `.env.example`）。最少只要 `cp .env.example .env` 并填 `DEEPSEEK_API_KEY`
> 就能跑；没有 key 就把 `TEXT_MODEL_PROVIDER` 改成 `ollama` / `vllm` 用本地模型。

### 环境变量（要改哪里）

文本模型 provider 通过 `TEXT_MODEL_PROVIDER` 切换（默认 `deepseek`；另有
`ollama` / `vllm` / `kimi` / `custom`，见 `config/settings.py`）。密钥只从环境变量或
本地 `.env` 读取，不入库；没有 `.env` 时用 `export DEEPSEEK_API_KEY=...` 亦可。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 空 | **默认 provider 必填**；DeepSeek 开放平台密钥（也支持 `export` 注入） |
| `TEXT_MODEL_PROVIDER` | `deepseek` | agent/文本模型：`deepseek` / `ollama` / `vllm` / `kimi` / `custom` |
| `DEEPSEEK_BASE` / `DEEPSEEK_MODEL` | `https://api.deepseek.com/v1` / `deepseek-flash` | 接口与模型覆盖 |
| `COMFY_BASE` | `http://localhost:8188` | ComfyUI（MiniMax H3 逐镜渲染） |
| `QWEN_IMAGE_URL` | `http://172.19.0.3:8601` | Qwen-Image 2.1 图片服务（定妆 / 场景 / 首帧） |
| `VISION_MODEL_BASE` / `VISION_MODEL_NAME` | 同 ollama `gemma3:4b` | 质检抽帧打分；未配置时转人工复核 |
| `SVF_PORT` | `8600` | 服务端口 |
| `SVF_DATA_DIR` / `SVF_DB` | `data/` / `data/factory.db` | 数据目录与 SQLite |
| `SVF_MAX_REPAIRS` | `2` | 单镜自动修复次数上限 |
| `SVF_RENDER_TIMEOUT` | `7200` | 单镜渲染超时（秒） |
| `SVF_DENSITY_LIMIT` | `3.0` | 提示词密度告警阈值（只告警不拦截） |

## 对话出片（一键出片）

`#/chat` 的完整链路：**对话收集需求 → agent 产出结构化分镜 → 预览确认 → 一键生成**。

1. `POST /assistant/chat`：制片助理把随意中文对话收敛成 `proposal`
   （brief / style / duration_target_s / aspect_ratio），需求齐全才给方案。
2. `POST /assistant/plan`：需求齐全后自动调用结构化规划 agent
   （`agents/planner.py`，编剧+选角一次 → 导演一次拆完全片），产出与手动链路
   同一套 ShotSpec 契约的完整分镜：场次 / 角色与地点登记 / 每镜
   action·dialogue·motion_contract·beats·object_states·camera·lighting_palette·
   acceptance。前端方案卡逐镜预览（含「结构化提示词」明细）。
3. `POST /projects/quick` 携带 `plan`：跳过 LLM 规划，`_materialize_plan` 确定性
   物化（数量/时长/画幅/角色展开/地点兜底/时长归一化与手动链路共用），**返回时
   分镜已可读但不会自动生成**；工作台分镜页展示每镜「渲染提示词」（与提交生成时
   写入 `run.prompt_spec` 的文本一致，`GET /projects/{id}?prompts=1`），确认/修改后
   点「开始生成」调 `POST /projects/{id}/produce`，才走 定妆参考图 → 镜头首帧 →
   逐镜渲染 → 质检。
4. 全部镜头验收后 `workers/compose.py` **自动拼接完整成片**（ffmpeg concat + SRT
   字幕，与手动「导出成片」同一函数；失败降级 manifest），成片出现在「剪辑」步。

### 停止执行

任何「一键出片 / 一键成片」项目都可随时停止：**首页项目卡、工作室顶栏、分镜页**
都有「■ 停止」入口（仅在有生产线程或在途镜头时出现），调
`POST /projects/{id}/stop`：

- 生产线程（定妆/首帧）在当前这张参考图完成后协作退出，不再排队新镜头；
- 在途 run 全部取消（已验收镜头与素材保留）；
- 服务端行为，**关掉浏览器后依然生效**；之后可随时重新「开始生成」，
  幂等地从尚未完成的镜头继续。

### 一键出片（一句话全自动）

`#/oneclick`：输入一句话 → `POST /projects/oneclick`，**不需要任何确认**：

1. 确定性提取你说过的信息（时长「30秒」、画幅「竖屏/9:16」、镜头数「共三个镜头」、
   每镜秒数「每镜5秒」），其余自动补默认（30 秒 · 9:16 · 标题/风格由助理补齐）；
2. 后台自动跑 规划分镜 → 定妆参考图 → 镜头首帧 → 逐镜渲染 → 质检 → 自动拼接；
3. 本页 3 秒轮询展示 6 步阶段进度、进度条、逐镜状态与当前活动，可随时「■ 停止」；
4. 成片就绪后直接在页面内播放 / 下载，也可跳工作室精修。

输入框下方有**两个模式开关**：

- **⚡ 全自动（默认）**：规划 → 定妆 → 首帧 → 渲染 → 质检 → 自动拼接，中途不停；
- **⏸ 素材后确认**：定妆 / 场景参考图 / 镜头首帧生成完即暂停，页面展示素材缩略图，
  点「✅ 确认生成镜头」（`POST /projects/{id}/confirm`，任务页也有同一按钮）后
  才渲染镜头并自动拼接。暂停状态记 `produce.awaiting_confirm`：服务重启不会绕过
  确认，用户主动停止过的项目也不会自动续跑。

### 上传材料（md / txt / docx）

「一键出片」支持**上传自己的材料**生成视频，保证与材料一致/高覆盖：

1. 点「📎 上传材料」选择 `.md` / `.txt` / `.json` / `.csv` / `.docx`
   （docx 由后端用标准库解包 `word/document.xml` 提取正文；其它二进制格式暂不支持）；
2. 材料被**确定性切成有序段落**（markdown 标题 / 章节行 / 空行为界），
   段数超过镜头预算时相邻合并；每个段落对应一个场景，导演逐段展开，
   导演漏拆的段落会用材料原文兜底补镜头 —— **逐段覆盖**；
3. 输入框此时用于补充要求（风格、时长、镜头数等，规则同一键出片）；
4. 材料原文会作为资产保存在项目里（工作室素材页可见），可回溯；
5. 方案卡/进度页会显示「材料逐段覆盖 N 段」与文件名。

与「对话出片」的区别：对话出片会先给结构化分镜让你过目确认；一键出片直接开跑。
底部导航「任务」页可以统一管理这两条链路产生的所有任务。

### 重启自愈（断点续跑）

生产链路（定妆 → 首帧 → 逐镜排队）是多步慢任务，进程重启会打断它。服务启动时
会扫描「已开始但无终态」的项目并**自动续跑**（`_produce_shots` 幂等：已生成的
参考图/首帧/已排队的镜头都会跳过）；用户主动停止过的项目不会被自动续跑。
日志事件：`produce.resumed`。

规划链路的结构化提示词硬规则（一镜一主动作、独立次运动、四要素物体契约、
三桶节拍、光线与调色板、台词清洗、英文否定约束等）见
[`skills/short-drama-script/SKILL.md`](../skills/short-drama-script/SKILL.md)。
对话路径与 `/projects/{id}/plan` 手动规划共用 `_materialize_plan` 与
`_compose_prompt`，所以两条链路产出同样质量的 H3 渲染提示词。

## 数据契约

见 `domain/schemas/core.py`（ShotSpec / ScoreReport / DecisionAdvice 等与架构文档 07 节一致）。
状态机见 `domain/state_machine/machine.py`（08 节转换图）。

## 验收路径

Web 导入角色图 → 绑定镜头 → 提交 ComfyUI 渲染 → 实时事件流 → 评分 → 审核 → 导出；
或 `#/chat` 一句话 → 结构化分镜 → 一键出片。
