# Embedded Character Pipeline

这是 TA Character Studio 内置的 Node.js 管线源码。请从仓库根目录运行命令；整体架构、GUI 操作、验证状态和安全边界见根目录 [README](../README.md)。

## 阶段

```text
reference-source → image-turnaround（或 comfy-prep）→ view-split → reference-approval
→ generation → remesh → rigging → animation → normalize → ue-import
```

- `image-turnaround`、`comfy-prep`、`generation`、`remesh`、`rigging`、`animation` 可能创建付费任务，必须显式确认。
- `view-split`、`reference-approval`、`normalize`、`ue-import` 是本地阶段。
- `comfy-prep` 由本地 ComfyUI 的 `TAOpenRouterTurnaround` 节点调用 OpenRouter；`check-comfy` 只读检测服务和必需节点。
- 每个阶段通过 JSONL 输出状态，并把真实状态写入 Manifest v2。
- 任务输入哈希一致时复用成功结果；变化时保留 `previousAttempts` 并将下游标记为 `STALE`。
- Rigging 返回的基础 Walking GLB 会在 Normalize 时使用同一 Blender 参数转换为 `normalized-walk.fbx`；UE Import 将它作为 `Walk` 导入主角色 Skeleton。缺少 Walk 的旧工程仍可只导入 Idle。

## 模块职责

- `pipeline.mjs`：唯一编排入口，负责状态机、费用门禁、哈希复用、下载、Comfy HTTP 和外部工具进程。
- `config.json`：新工程默认参数，不覆盖 Manifest 已保存的工程参数。
- `tools/blender_normalize.py`：单位/高度/坐标、权重与拓扑审计、GLB/FBX 输出；保留来源法线。
- `tools/ue_import.py`：在稳定 `/Game/Generated/<runId>/` 路径导入角色、Idle、Walk、材质与 Preview Map。
- `pipeline.test.mjs`：只使用 Mock 或进程内 HTTP 服务，不会产生云端费用。

JSONL 的稳定事件类型为 `stage`、`artifact`、`complete`、`error` 和 `spend-required`。Tauri 只负责转发这些行；调用方必须在进程结束后重新读取 Manifest，不能把退出码当作阶段状态真相。

## Comfy Bridge 目录

每次 `comfy-prep` 运行在 `<run>/bridge/<jobId>/` 写入：

```text
<run>/bridge/<jobId>/
├─ request.json
├─ input/front.png（或 reference-N.png）
├─ workflow_api.json
└─ output/response.json（含输出 PNG）
```

参考图先通过 `/upload/image` 进入独立 job 子目录；回传结果经文件类型、哈希、jobId 校验后才注册为 Artifact。workflow 不含 API Key；Key 只由 Comfy 进程的 `OPENROUTER_API_KEY` 管理。

## 测试

```powershell
npm.cmd run pipeline:test
```

测试全部使用 Mock、本地临时文件或进程内模拟 ComfyUI HTTP 服务，不访问 OpenAI、Meshy、真实 ComfyUI、Blender 或 Unreal Engine。

## CLI 示例

```powershell
node pipeline/pipeline.mjs init --reference D:\Assets\concept.png --run-name character-01 --output-root D:\TAProjects --json
node pipeline/pipeline.mjs execute image-turnaround --manifest D:\TAProjects\output\character-01\manifest.json --json --mock
node pipeline/pipeline.mjs execute comfy-prep --manifest D:\TAProjects\output\character-01\manifest.json --comfy-url http://127.0.0.1:8188 --comfy-preset turnaround --json --confirm-spend
node pipeline/pipeline.mjs check-comfy --comfy-url http://127.0.0.1:8188 --json
node pipeline/pipeline.mjs execute view-split --manifest D:\TAProjects\output\character-01\manifest.json --json
node pipeline/pipeline.mjs approve-references --manifest D:\TAProjects\output\character-01\manifest.json --front view-split:0 --side view-split:1 --back view-split:2 --json
```

OpenAI/Meshy 调用从环境变量读取 `OPENAI_API_KEY` 或 `MESHY_API_KEY`；OpenRouter Key 只由 Comfy 进程读取。不要把 Key 写入配置、Manifest 或提交内容。`--mock` 会让 `comfy-prep` 走本地 Mock。
