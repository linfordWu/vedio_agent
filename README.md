# 镜界 Scenery · The AI Video Foundry

本地部署的 AI 短剧工厂 + 配套 ComfyUI 节点。
**全部代码、配置与文档都在 [`short-video-factory/`](short-video-factory/)。**

| 入口 | 说明 |
|---|---|
| [短剧工厂 README](short-video-factory/README.md) | Web 应用：对话出片 / 一键出片 / 任务中心 / 作品中心（FastAPI + 零构建前端 + 本地模型编排） |
| [ComfyUI 节点 README](short-video-factory/comfyui-node/README.md) | MiniMax H3 W4A4 / Streaming VSA / 009jev 自定义节点；`comfyui-node/` 整体拷进 `ComfyUI/custom_nodes/` 即可 |
| [部署文档](short-video-factory/docs/DEPLOYMENT.zh.md) | GB10（aarch64）容器化部署与实测 |
| [方案架构图](short-video-factory/docs/方案架构图上传.html) | 产品与系统设计 |

许可证：[GPL-3.0](LICENSE)。模型权重与生成物不随仓库分发。
