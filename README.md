# TA Character Studio

面向角色技术美术测试和小型生产流程的节点式桌面工具。项目以美术人员易用性为优先：简单模式展示制作步骤，高级模式暴露真实阶段、中间产物、任务状态与可重连端口。

当前源码已覆盖参考图处理、Comfy/OpenRouter 桥接、Meshy 建模、减面、绑定、Idle/Walk 动画、Blender 规范化与质量审计、Unreal Engine 自动导入，以及工程包/流程配置迁移。剩余工作主要是第二角色泛化、动画/纹理美术精修和最终打包。图形界面不是状态真相来源；每次运行的 `manifest.json` 保存阶段状态、输入哈希、任务 ID、费用、错误和产物哈希。

## 30 秒理解工程

- **给美术人员的入口**：Tauri 客户端把复杂阶段收纳成简单制作步骤，同时允许高级用户查看真实节点和中间产物。
- **真正执行工作的地方**：内置 Node sidecar 运行 `pipeline/pipeline.mjs`；云端任务、Comfy、Blender 和 UE 都从这里编排。
- **文件安全边界**：React 从不直接读取磁盘路径，只把 `artifact_id` 交给 Rust；Rust 仅返回本次原生文件选择批准过的文件。
- **恢复与复用依据**：`manifest.json` 是任务真相，`project.json` 只保存节点连线和编辑器状态。输入文件哈希与参数一致时复用结果，否则下游变为 `STALE`。
- **费用原则**：任何可能创建云端任务的操作都必须逐次确认；密钥只存在于当前会话或子进程环境变量中。

## 当前流程

```text
参考图
→ GPT Image 2 三视图生成（可选）或 ComfyUI / OpenRouter 三视图（可选）
→ 本地切分
→ 美术确认
→ Meshy Multi-Image-to-3D
→ Remesh
→ Rigging（同时返回基础 Walk / Run）
→ Animation（当前 action_id=0，用作 Idle）
→ Blender Normalize / Validation（角色与 Walk 分别规范化）
→ Unreal Engine Import（同一 Skeleton 下导入 Idle / Walk）/ Preview Map
```

### 运行时架构与数据流

```text
React / XYFlow / Three.js
        │ Tauri invoke + pipeline-event
        ▼
Rust 主进程 ──批准文件表、工程包、进程生命周期、原生对话框
        │ 启动内置 Node sidecar；Key 仅通过环境变量传递
        ▼
pipeline.mjs ──Manifest v2、哈希复用、付费门禁、JSONL 进度
   ├─ OpenAI / Meshy HTTP API
   ├─ ComfyUI HTTP API ──TAOpenRouterTurnaround ──OpenRouter
   ├─ Blender 后台脚本 ──Normalize、权重/拓扑/动画审计
   └─ UnrealEditor-Cmd ──Skeletal Mesh、Idle、Walk、材质、Preview Map
```

进程之间只通过受控参数、环境变量、JSONL 和工程文件通信。前端崩溃或客户端退出不会删除云端任务 ID；重新打开 Manifest 后可以恢复轮询，避免重复创建付费任务。

- 客户端：Tauri 2、React、TypeScript、Three.js、XYFlow、Zustand。
- 管线：内置 Node.js sidecar 执行 `pipeline/pipeline.mjs`，通过 JSONL 向 GUI 报告进度。
- 外部工具：Blender 和 Unreal Engine 不随客户端分发，由 GUI 检测或配置路径。
- 云端服务：Meshy API、OpenAI Image API，以及由本地 ComfyUI 编排的 OpenRouter Image API；所有付费 POST 均需逐次确认。
- ComfyUI Bridge 只处理参考图三视图，不迁移 Meshy、Blender 或 UE 调用。
- `.tacs-project.zip` 携带单个工程的 Manifest、节点图和实际中间产物；`.tacs-profile.json` 只携带可复用流程参数，不含密钥、本机工具路径或 Comfy 地址。

## 仓库结构

```text
TACharacterStudio/
├─ src/                    React 节点图、Inspector、图片和 3D 预览
├─ src-tauri/              Rust 安全文件接口、sidecar 管理和打包配置
├─ pipeline/               管线源码、配置、测试及 Blender/UE 脚本
├─ integrations/comfy/     TA Character Tools 自定义节点源码
├─ docs/                   美术操作、验收与故障排查
├─ scripts/                sidecar、Comfy 安装、传输测试和交付脚本
├─ README.md
└─ PROJECT_STATUS_AND_ROADMAP.md   项目状态与后续构建路线
```

`pipeline/` 是当前管线源码的唯一 Git 真相来源。原来的同级 `E:\AIEval\TACharacterPipeline` 仅保留为本机历史备份；克隆和构建本仓库不再依赖该目录。仓库不包含测试角色图片、生成模型、UE 工程、运行输出或安装包。

### 状态与文件职责

| 文件或状态 | 职责 | 是否可作为运行真相 |
|---|---|---|
| `manifest.json` | 阶段状态、task/prompt ID、输入哈希、费用、错误、产物及报告 | 是 |
| `project.json` | 自定义连线、导入节点、`STALE` 编辑状态 | 否 |
| `pipeline/config.json` | 新工程默认参数；Manifest 中的工程参数优先 | 否 |
| React state | 当前选择、折叠面板、会话 Key、运行显示 | 否 |
| `validation.json` | 单次 Blender 质量审计证据 | 仅对应当次输出 |
| `ue-import-report.json` | UE 资产路径、导入设置、Bounds、Idle/Walk 结果 | 仅对应当次导入 |

配套文档：项目过程、工具选择、问题与验证证据见 [DEVELOPMENT_RECORD](docs/DEVELOPMENT_RECORD.md)；美术人员从 [ARTIST_GUIDE](docs/ARTIST_GUIDE.md) 开始；版本验收使用 [MANUAL_ACCEPTANCE](docs/MANUAL_ACCEPTANCE.md)；异常处理查看 [TROUBLESHOOTING](docs/TROUBLESHOOTING.md)；后续开发边界见 [PROJECT_STATUS_AND_ROADMAP](PROJECT_STATUS_AND_ROADMAP.md)。

## 已实现能力

### 参考图与 GPT Image 2

- 新工程至少选择一张主参考图，可添加第二张补充图。
- `gpt-image-2-2026-04-21` 支持生成三视图、补全缺失视图、统一背景与站姿。
- 三联 PNG 可在本地拖动分隔线、交换正/侧/背顺序并重新切分。
- 美术确认可混用原图和 AI 结果；正面与背面确认前，Generation 会在管线层拒绝执行。
- 改动提示词、源图、切分或采用结果会使依赖的下游阶段变为 `STALE`。

### 资产执行与预览

- 支持节点 Run、Stop、Resume、Run From Here、Mock 和已有任务复用。
- 本地 GLB 可插入 Inspect、Remesh 或 Rigging；本地三视图 PNG 可插入切分视图；不兼容端口和循环连接会被拒绝。
- Three.js 支持 GLB、骨架和动画预览，以及 Generation/Remesh、Normalize 前后的对比；Animation 节点可在 Idle、Walk、Run 中切换预览。
- `project.json` 保存节点重连；`manifest.json` 保存实际任务和付费状态。

### Comfy Bridge（OpenRouter 参考图准备）

- 高级模式新增「Comfy 参考图」节点；本地 ComfyUI 使用 `TAOpenRouterTurnaround` 调用 OpenRouter GPT-5.4 Image 2，因此同样属于付费节点。
- Studio 通过 `/upload/image` 传入 1—16 张参考图，使用 `ImageBatch` 组批，并通过 `/prompt`、`/history`、`/view` 收回结果。
- 每次运行在 `<run>/bridge/<jobId>/` 写入 `request.json`、`input/`、`workflow_api.json` 与 `output/response.json`；回传结果经文件类型、哈希、jobId 校验后才注册为 Artifact。
- 设置对话框会分别检测 ComfyUI 服务和必需节点；`OPENROUTER_API_KEY` 只由 Comfy 进程管理。
- Comfy workflow 不含 API Key 或角色专有绝对路径；回传结果不覆盖原图；失败不污染 Manifest。

### Blender 与 Unreal Engine

- Remesh 节点可在运行前设置 100–300,000 的目标面数，默认 100,000；参数写入 Manifest 和输入签名，修改后下游结果会标记为需要更新。
- Normalize 统一米制单位、角色高度、原点、轴向、对象命名和 FBX 平滑信息，并把 Meshy 已有的 24 根人形骨骼改为 UE 常用核心命名；不新增 Root、Twist、IK 或手指骨骼。它保留来源面绕序与自定义法线，不再对拆分网格岛执行破坏性的全模型法线重算。
- Root/Pelvis 校正为可配置参数，不写死当前角色。
- Normalize 会把 Rigging 返回的 Walking GLB 独立转换为 `normalized-walk.fbx`；该文件与主角色使用同一规格且不会触发 Meshy 请求。
- UE Import 使用 `/Game/Generated/<runId>/` 稳定路径创建或更新 Skeletal Mesh、Skeleton、Idle、Walk、材质、纹理和 Preview Map；Idle 与 Walk 复用同一个 Skeleton。
- 重复导入不创建 `_2`、`_3` 资产副本。
- Normalize 同时检查并规范化骨骼权重和（容差 0.01）、限制每顶点最多 4 个骨骼影响，并报告未绑定网格、Root/Pelvis 位移轨道、循环首尾差异与贴图分辨率；源资产不会被覆盖。

### 可移植交付

- 设置页可导入/导出完整工程包，也可导入/导出轻量流程配置；导入工程包拒绝路径穿越、绝对路径、符号链接、范围外文件和超限解压。
- 设置页可将安装包内置的 `ComfyUI-TACharacterTools` 同步到用户选择的 `custom_nodes` 目录；完成后需要完整重启 ComfyUI。
- “一键环境自检”检查内置 Node/管线、ComfyUI 必需节点、Blender、UnrealEditor-Cmd 和 `.uproject`，只读且不消费费用。

## 验证状态

| 层级 | 当前证据 | 状态 |
|---|---|---|
| 客户端源码 | TypeScript 类型检查、Cargo check | PASS |
| 生产构建 | `npm run verify`（含 Vite production build，205 模块） | PASS；仅有主 JS chunk 大小提示 |
| Rust 安全边界 | 9 项测试：文件授权、路径与工程包安全、付费布尔值、sidecar/Windows 路径 | PASS |
| 管线 Mock | 23 项测试：参考图门禁、PNG 切分、付费阻断、路径越界、断点复用、Remesh 与 Comfy Bridge | PASS |
| 管线 Mock（含 Comfy Bridge） | 覆盖付费阻断、节点检测、上传、动态工作流、回传校验、切分链和失败状态 | PASS |
| Meshy 实际任务 | Generation 30、Remesh 5、Rigging 5、Animation 3 credits | PASS |
| Blender Normalize | `Testing_2`：1.6 m、103,197 三角面、24 骨骼、0 退化面、0 孤立点、来源法线保留；另输出规范化 Walk | PASS（27 条循环曲线需美术复核） |
| UE 5.4 Import | `Testing_2`：138.58 cm、7 个稳定资产、同 Skeleton 的 Idle/Walk、双面材质、Preview Map | PASS |
| GPT Image 2 直连实际调用 | Mock 已通过；尚未使用 OpenAI 直连账户执行 Low 质量请求 | 待验证（不影响已验证的 OpenRouter 路径） |
| Comfy Bridge 实际调用 | ComfyUI 0.33.4；真实上传/下载/切分 PASS；一次 Low 请求成功，费用 `$0.0099` | PASS |
| 当前角色 UE 视觉检查 | 比例与法线已由用户在 UE 确认通过 | PASS |
| 最终动画/纹理验收 | 肩、胯、膝、脚底、循环、衣物穿插和纹理细节仍需人工检查 | 待确认 |

以上最新角色证据来自本机 `Testing_2` 运行；生成文件本身不进入 Git。最新质量审计得到 103,197 三角面、24 骨骼、100,552 个有效蒙皮顶点、最大 4 影响、0 个零权重点、3 条 Root/Pelvis 位移轨道和 27 条需复核的循环曲线。`npm.cmd run verify` 会执行 check、23 项管线测试、9 项 Rust 测试和 production build；GUI 的布局与动画观感仍需人工确认。

## 后续计划与已知弱项

路线见 `PROJECT_STATUS_AND_ROADMAP.md`，当前剩余项如下：

- **7B 固化与泛化验证**：本机 production build 与手工验收；以第二个显著不同风格的角色跑同一节点图，证明流程没有写死。
- **质量人工复核**：确认无变形组网格是否为附件，并检查 27 条循环曲线对应的脚底、Root/Pelvis 和首尾帧观感。
- **泛化验证**：用第二个明显不同的角色复用同一节点图；除用户明确确认外不产生新的 API 消耗。
- **最终打包与演示**：`npm.cmd run verify` 后生成 MSI/NSIS/SHA-256，并整理演示视频与 `Delivery/` 提交包。

已知弱项：自动动画仍可能有 Root/Pelvis 偏移、脚底接触、循环与局部穿插；肩、胯、膝、衣物未经标准与极限姿势测试；纹理的关键服装图案、材质分区、粗糙度层次和局部细节不足。分级处理原则：角色身份/比例/服装结构/关键纹样错误时回到参考图阶段；高面数、Transform、法线、Root/Pelvis、循环、脚底问题优先后期修正；贴图信息缺失可保留网格并重绘；严重权重或骨架错误进入 Blender 精修或重绑。

## 环境与运行

推荐环境：Windows x64、Node.js 20+、Rust/Cargo、MSVC Build Tools 和 WebView2；Blender 4.x 与 Unreal Engine 5.4 按需安装。

```powershell
git clone https://github.com/Denshito/TACharacterStudio.git
cd TACharacterStudio
npm.cmd install
npm.cmd run check
npm.cmd run pipeline:test
npm.cmd run build
npm.cmd run tauri dev
```

`npm.cmd run verify` 会依次运行客户端检查、管线测试、Rust 测试和生产构建。最终候选版本执行 `npm.cmd run bundle`。安装包内置 Node sidecar、管线脚本和 TA Comfy 节点，不内置 Blender、UE 或 ComfyUI。

## GUI 最短操作

1. 选择“新建项目”，导入至少一张参考图并指定保存目录。
2. 首次验证建议在“技术信息”中启用“离线模拟”。
3. 运行“生成三视图”，进入“切分视图”调整蓝色分隔线。
4. 在“美术确认”中选择正面、侧面、背面；正面和背面为必需。
5. 确认后运行 Generation，并按 Remesh、Rigging、Animation、Normalize、UE Import 继续；Normalize 会自动处理 Rigging 已产出的 Walk，不会再次请求 Meshy。
6. 在高级模式选择“角色动画”，可从产物下拉框切换预览 Idle、Walk、Run；UE Import 会自动导入 Idle 与 Walk。
7. 已有工程可直接选择对应的 `manifest.json` 恢复。
8. 换机时在“设置与服务”导入 `.tacs-project.zip`，运行“一键环境自检”；只复用参数时导入 `.tacs-profile.json`。

旧 v2 Manifest 若已包含 `input.front` 和 `input.back`，会被视为历史已确认输入，不要求重复执行 GPT Image 处理。

## API Key 与费用安全

GUI 可输入 Meshy 与 OpenAI Key，也可由启动进程提供：

```powershell
$env:MESHY_API_KEY = "<your-meshy-key>"
$env:OPENAI_API_KEY = "<your-openai-key>"
```

Comfy/OpenRouter 需要从设置了独立环境变量的终端启动 Comfy Desktop：

```powershell
$env:OPENROUTER_API_KEY = Read-Host "OpenRouter API Key"
& 'D:\ComfyUI\Comfy Desktop\Comfy Desktop.exe'
```

- Key 只存在于当前 GUI 状态或子进程环境变量。
- Key 不写入命令行参数、Manifest、`project.json`、日志或 Git。
- Mock、本地切分、美术确认、Normalize 和 UE Import 不消费云端 credits；`comfy-prep` 会调用 OpenRouter，必须逐次确认。
- 创建 OpenAI/Meshy 付费请求前会显示阶段、参数和费用估计，并要求确认。
- 付费 POST 不自动重试；超时后由用户决定是否重试，以降低重复扣费风险。

## 管线 CLI

```powershell
node pipeline/pipeline.mjs init --reference D:\Assets\concept.png --run-name character-01 --output-root D:\TAProjects --json
node pipeline/pipeline.mjs execute image-turnaround --manifest D:\TAProjects\output\character-01\manifest.json --json --mock
node pipeline/pipeline.mjs execute comfy-prep --manifest D:\TAProjects\output\character-01\manifest.json --comfy-url http://127.0.0.1:8188 --comfy-preset turnaround --json --confirm-spend
node pipeline/pipeline.mjs execute view-split --manifest D:\TAProjects\output\character-01\manifest.json --json
node pipeline/pipeline.mjs approve-references --manifest D:\TAProjects\output\character-01\manifest.json --front view-split:0 --side view-split:1 --back view-split:2 --json
node pipeline/pipeline.mjs execute generation --manifest D:\TAProjects\output\character-01\manifest.json --json --confirm-spend
node pipeline/pipeline.mjs doctor --comfy-url http://127.0.0.1:8188 --tool-path D:\Blender\blender.exe --ue-path D:\UE\UE_5.4\Engine\Binaries\Win64\UnrealEditor-Cmd.exe --ue-project D:\Projects\Character.uproject --json
```

`--mock` 不访问 OpenAI、OpenRouter 或 Meshy。`check-comfy` 只读检测本地 ComfyUI 服务与必需节点（`node pipeline/pipeline.mjs check-comfy --comfy-url http://127.0.0.1:8188 --json`）。`resume` 只恢复已有 task ID/prompt ID，不会隐式创建新付费任务。Remesh 固定使用当前已验证的 `/openapi/v1/remesh`；历史 `/openapi/v2/remesh` 会在未创建任务时被迁移。

## 安全边界与已知限制

- Manifest、参考图、输出目录和本地 GLB 必须通过原生文件对话框授权。
- 前端只持有临时 artifact ID；Rust 后端拒绝伪造 ID、绝对路径、路径穿越和已删除文件。
- GUI 新建页当前支持最多两张初始参考图；管线 CLI 支持 1—8 张。
- Three.js 预览 GLB 和图片；FBX 仅支持导出、定位和 UE 导入。
- Comfy 自定义节点源码位于 `integrations/comfy/`；安装或更新后必须完整重启 Comfy Desktop。
- Blender、UE 和 Node 开发环境不随源码提供；安装包会内置 Node sidecar，但不内置 Blender/UE。
- 当前安装包未做商业代码签名，最终交付需说明 Windows SmartScreen 提示。
