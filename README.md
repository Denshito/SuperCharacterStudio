# TA Character Studio

面向角色技术美术测试和小型生产流程的节点式桌面工具。项目以美术人员易用性为优先：简单模式展示制作步骤，高级模式暴露真实阶段、中间产物、任务状态与可重连端口。

当前分支完成 Phase 2—7A，覆盖参考图处理、Meshy 建模、减面、绑定、动画、Blender 规范化、自动质检和 Unreal Engine 导入。图形界面不是状态真相来源；每次运行的 `manifest.json` 保存阶段状态、输入哈希、任务 ID、费用、错误和产物哈希。

## 当前流程

```text
参考图
→ GPT Image 2 三视图生成（可选）
→ 本地切分
→ 美术确认
→ Meshy Multi-Image-to-3D
→ Remesh
→ Rigging
→ Animation
→ Blender Normalize / Validation
→ Unreal Engine Import / Preview Map
```

- 客户端：Tauri 2、React、TypeScript、Three.js、XYFlow、Zustand。
- 管线：内置 Node.js sidecar 执行 `pipeline/pipeline.mjs`，通过 JSONL 向 GUI 报告进度。
- 外部工具：Blender 和 Unreal Engine 不随客户端分发，由 GUI 检测或配置路径。
- 云端服务：Meshy API 与 OpenAI Image API；所有付费 POST 均需逐次确认。

## 仓库结构

```text
TACharacterStudio/
├─ src/                    React 节点图、Inspector、图片和 3D 预览
├─ src-tauri/              Rust 安全文件接口、sidecar 管理和打包配置
├─ pipeline/               管线源码、配置、测试及 Blender/UE 脚本
├─ scripts/                Node sidecar 准备脚本
└─ README.md
```

`pipeline/` 是当前管线源码的唯一 Git 真相来源。原来的同级 `E:\AIEval\TACharacterPipeline` 仅保留为本机历史备份；克隆和构建本仓库不再依赖该目录。仓库不包含测试角色图片、生成模型、UE 工程、运行输出或安装包。

## 已实现能力

### 参考图与 GPT Image 2

- 新工程至少选择一张主参考图，可添加第二张补充图。
- `gpt-image-2-2026-04-21` 支持生成三视图、补全缺失视图、统一背景与站姿。
- 三联 PNG 可在本地拖动分隔线、交换正/侧/背顺序并重新切分。
- 美术确认可混用原图和 AI 结果；正面与背面确认前，Generation 会在管线层拒绝执行。
- 改动提示词、源图、切分或采用结果会使依赖的下游阶段变为 `STALE`。

### 资产执行与预览

- 支持节点 Run、Stop、Resume、Run From Here、Mock 和已有任务复用。
- 本地 GLB 可插入 Inspect、Remesh 或 Rigging；不兼容端口和循环连接会被拒绝。
- Three.js 支持 GLB、骨架和动画预览，以及 Generation/Remesh、Normalize 前后的对比。
- `project.json` 保存节点重连；`manifest.json` 保存实际任务和付费状态。

### Blender 与 Unreal Engine

- Normalize 统一米制单位、角色高度、原点、轴向、对象命名、法线和 FBX 平滑信息。
- Root/Pelvis 校正为可配置参数，不写死当前角色。
- UE Import 使用 `/Game/Generated/<runId>/` 稳定路径创建或更新 Skeletal Mesh、Skeleton、Animation Sequence、材质、纹理和 Preview Map。
- 重复导入不创建 `_2`、`_3` 资产副本。

## 验证状态

| 层级 | 当前证据 | 状态 |
|---|---|---|
| 客户端源码 | TypeScript、Cargo check、Vite production build | PASS |
| 管线 Mock | 参考图门禁、PNG 切分、付费阻断、路径越界、断点复用 | PASS |
| Meshy 实际任务 | Generation 30、Remesh 5、Rigging 5、Animation 3 credits | PASS |
| Blender Normalize | 1.6 m、103,086 三角面、24 骨骼、1 材质、1 纹理、1 动画 | PASS |
| UE 5.4 Import | 6 个稳定资产、Preview Map、0 Error | PASS |
| GPT Image 2 实际调用 | Mock 已通过；尚未使用用户账户执行 Low 质量请求 | 待验证 |
| 最终美术验收 | 肩、胯、膝、脚底、衣物穿插和动画观感仍需人工检查 | 待确认 |

以上真实资产证据来自本机 `first-character` 运行；生成文件本身不进入 Git。

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

`npm.cmd run verify` 会依次运行客户端检查、管线测试、Rust 测试和生产构建。最终候选版本才执行 `npm.cmd run bundle`；当前分支没有重新生成 MSI/NSIS。

## GUI 最短操作

1. 选择“新建项目”，导入至少一张参考图并指定保存目录。
2. 首次验证建议在“技术信息”中启用“离线模拟”。
3. 运行“生成三视图”，进入“切分视图”调整蓝色分隔线。
4. 在“美术确认”中选择正面、侧面、背面；正面和背面为必需。
5. 确认后运行 Generation，并按 Remesh、Rigging、Animation、Normalize、UE Import 继续。
6. 已有工程可直接选择对应的 `manifest.json` 恢复。

旧 v2 Manifest 若已包含 `input.front` 和 `input.back`，会被视为历史已确认输入，不要求重复执行 GPT Image 处理。

## API Key 与费用安全

GUI 可输入 Meshy 与 OpenAI Key，也可由启动进程提供：

```powershell
$env:MESHY_API_KEY = "<your-meshy-key>"
$env:OPENAI_API_KEY = "<your-openai-key>"
```

- Key 只存在于当前 GUI 状态或子进程环境变量。
- Key 不写入命令行参数、Manifest、`project.json`、日志或 Git。
- Mock、本地切分、美术确认、Normalize 和 UE Import 不消费云端 credits。
- 创建 OpenAI/Meshy 付费请求前会显示阶段、参数和费用估计，并要求确认。
- 付费 POST 不自动重试；超时后由用户决定是否重试，以降低重复扣费风险。

## 管线 CLI

```powershell
node pipeline/pipeline.mjs init --reference D:\Assets\concept.png --run-name character-01 --output-root D:\TAProjects --json
node pipeline/pipeline.mjs execute image-turnaround --manifest D:\TAProjects\output\character-01\manifest.json --json --mock
node pipeline/pipeline.mjs execute view-split --manifest D:\TAProjects\output\character-01\manifest.json --json
node pipeline/pipeline.mjs approve-references --manifest D:\TAProjects\output\character-01\manifest.json --front view-split:0 --side view-split:1 --back view-split:2 --json
node pipeline/pipeline.mjs execute generation --manifest D:\TAProjects\output\character-01\manifest.json --json --confirm-spend
```

`--mock` 不访问 OpenAI 或 Meshy。`resume` 只恢复已有 task ID，不会隐式创建新付费任务。Remesh 固定使用当前已验证的 `/openapi/v1/remesh`；历史 `/openapi/v2/remesh` 会在未创建任务时被迁移。

## 安全边界与已知限制

- Manifest、参考图、输出目录和本地 GLB 必须通过原生文件对话框授权。
- 前端只持有临时 artifact ID；Rust 后端拒绝伪造 ID、绝对路径、路径穿越和已删除文件。
- GUI 新建页当前支持最多两张初始参考图；管线 CLI 支持 1—8 张。
- Three.js 预览 GLB 和图片；FBX 仅支持导出、定位和 UE 导入。
- GPT Image 2 的真实账户权限、延迟、费用和三视图一致性仍需一次 Low 质量调用验证。
- Blender、UE 和 Node 开发环境不随源码提供；安装包会内置 Node sidecar，但不内置 Blender/UE。
- 当前安装包未做商业代码签名，最终交付需说明 Windows SmartScreen 提示。
