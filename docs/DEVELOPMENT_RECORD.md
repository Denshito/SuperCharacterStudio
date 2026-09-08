# TA Character Studio 开发过程记录

更新时间：2026-09-08
适用版本：当前源码候选版本，最终提交时以 Git commit 标记
项目仓库：`Denshito/TACharacterStudio`（Private）

## 1. 项目目标

TA Character Studio 是一个面向技术美术测试和小型角色生产的桌面工具。目标不是替代 Blender、ComfyUI 或 Unreal Engine，而是把它们连接成一条可恢复、可检查、可复用的角色资产管线：

```text
参考图
→ AI 三视图 / ComfyUI 三视图
→ 本地切分
→ 美术确认
→ Meshy 建模
→ Remesh
→ Rigging
→ Idle / Walk
→ Blender Normalize 与质量审计
→ Unreal Engine 自动导入与预览关卡
```

项目优先级依次为：美术人员易用、付费安全、中间产物可见、失败可恢复、来源工具可替换、结果可在 UE 中验证。

## 2. 技术架构

```text
React / TypeScript / XYFlow / Three.js
                   │
                   │ Tauri invoke + pipeline-event
                   ▼
Tauri / Rust 主进程
  ├─ 原生文件对话框与授权文件表
  ├─ Artifact ID 安全读取与导出
  ├─ sidecar 生命周期和事件转发
  └─ 工程包 / 流程配置导入导出
                   │
                   ▼
Node.js sidecar：pipeline/pipeline.mjs
  ├─ Manifest v2、状态恢复、输入哈希和付费门禁
  ├─ OpenAI / Meshy HTTP API
  ├─ ComfyUI HTTP Bridge → OpenRouter Image API
  ├─ Blender 后台 Normalize / Validation
  └─ UnrealEditor-Cmd Python 自动导入
```

`manifest.json` 是运行状态真相，记录阶段状态、输入哈希、task ID、费用、错误和产物哈希；`project.json` 只记录节点图和界面状态。客户端退出不会删除云端任务 ID，用户可以恢复轮询而不重复创建付费任务。

## 3. 使用的 AI、软件、API 与开源组件

### 3.1 AI 与云端服务

| 工具 | 用途 | 当前状态 |
|---|---|---|
| Meshy Multi-Image-to-3D | 从已确认的正/侧/背参考图生成带纹理模型 | 已真实验证 |
| Meshy Remesh | 将高面数模型减到 Rigging 可接受范围 | 已真实验证 |
| Meshy Rigging | 生成人形骨架、蒙皮和基础 Walk/Run | 已真实验证 |
| Meshy Animation | 通过 `action_id` 生成当前 Idle 动画 | 已真实验证 |
| OpenRouter `openai/gpt-5.4-image-2` | 在 ComfyUI 中由参考图生成三联图 | Low 质量真实请求已验证 |
| OpenAI `gpt-image-2-2026-04-21` | Studio 直连三视图方案 | Mock 已通过，真实账户调用未验证 |
| LLM 编程助手 | 架构拆分、代码实现、日志诊断、测试和文档整理 | 所有结果均以源码检查和实际测试为准 |

DeepSeek V4 曾作为可用的文本模型方案进行评估，但当前闭环不需要文本代理，因此没有把它加入生产节点，避免增加无必要依赖。

### 3.2 DCC、引擎与运行环境

| 软件 | 作用 | 已验证环境 |
|---|---|---|
| Blender | 单位、比例、轴向、骨骼命名、权重限制、GLB/FBX 输出和质量报告 | 4.5.8 LTS |
| Unreal Engine | Skeletal Mesh、Skeleton、材质、纹理、Idle/Walk 和 Preview Map | 5.4 |
| ComfyUI Desktop | 可视化执行 OpenRouter 三视图节点 | ComfyUI 0.33.4 |
| Node.js sidecar | 管线编排、HTTP、JSONL 事件和文件哈希 | 24.20.0 实测；安装包内置运行时 |
| Rust / Cargo / MSVC | Tauri 后端和 Windows 安装包 | Rust 1.98.0、MSVC 2022 |
| WebView2 | Windows 客户端 Web UI | 已完成启动与打包链验证 |

### 3.3 主要开源组件

| 组件 | 项目中的职责 |
|---|---|
| Tauri 2 | Windows 桌面外壳、Rust 命令、安全边界和安装包 |
| React 19 | 客户端界面与任务型 Inspector |
| TypeScript | Manifest、Artifact 和节点端口类型约束 |
| XYFlow / React Flow | 简单模式与高级模式节点画布 |
| Three.js | GLB、材质、骨架和动画预览 |
| Zustand | 客户端轻量状态管理 |
| Vite | 前端开发和生产构建 |
| ComfyUI | 图像工作流执行和可替换图像后端 |
| Blender Python API | 无界面资产处理和报告生成 |
| Unreal Python API | 无界面导入和 Preview Map 创建 |

第三方许可证汇总见仓库根目录 `THIRD_PARTY_NOTICES.md`。

## 4. 分阶段开发过程

### 阶段 1：桌面客户端骨架与打包基线

- 创建独立 Tauri 2 + React + TypeScript 工程，没有修改 STK。
- 建立节点库、节点画布、Inspector、日志和 3D 预览区域。
- 配置构建时复制 Node sidecar，仓库不保存约 93 MB 的 `node.exe`。
- 实际生成过 MSI 和 NSIS，证明 Windows 打包链可用。

### 阶段 2：Manifest 读取与中间产物预览

- 后端通过原生对话框打开 `manifest.json`。
- 只授权 Manifest 实际列出的输入和输出；前端后续只传 `artifact_id`。
- Three.js 增加 GLB、SkeletonHelper、AnimationMixer、统计和阶段对比。
- 历史错误不会覆盖阶段最终 `SUCCEEDED` 状态。

### 阶段 3：执行、停止与恢复

- 管线提供阶段级 `execute`、`resume`、`inspect` 和 JSONL 事件。
- Stop 只停止本地轮询，不伪装成取消云端任务。
- 付费 POST 前必须确认；付费请求不自动重试。
- API Key 通过会话状态或子进程环境变量传递，不进入参数、日志和 Manifest。

### 阶段 4：中间插入与节点复用

- 支持本地 GLB、三联图 PNG 和已有 Manifest 从中间继续。
- 输入哈希或参数变化会使下游变为 `STALE`。
- 相同输入和参数可复用已有输出，避免重复付费。
- 禁止循环连接和不兼容的 Artifact 类型连接。

### 阶段 5：Blender Normalize 与质量门禁

- 统一米制单位、目标高度、原点、前向轴、对象和材质命名。
- 保留来源面绕序与自定义法线，避免对拆分网格岛全局重算法线。
- 审计三角面、骨骼、材质、贴图、动画、循环曲线和 Root/Pelvis 位移。
- 自动把权重和归一化，并把单顶点骨骼影响限制为 4。
- 不覆盖云端原始资产，输出新的 GLB、FBX 和 `validation.json`。

### 阶段 6：UE 自动导入

- 使用稳定的 `/Game/Generated/<runId>/` 路径。
- 导入 Skeletal Mesh、Skeleton、材质、纹理、Idle 和 Walk。
- Idle 与 Walk 复用同一个 Skeleton；重复执行不会生成 `_2`、`_3` 副本。
- 创建或更新 Preview Map，并生成 `ue-import-report.json`。

### 阶段 7A：AI 参考图预处理

- 增加参考图、AI 三视图、切分和美术确认步骤。
- 三联图本地切分，不产生 API 消耗。
- 至少确认正面和背面后，Generation 才能执行。
- AI 输出、切分结果和采用结果位于独立目录，不覆盖源图。

### ComfyUI / Studio Bridge

- 将 `TAOpenRouterTurnaround` 自定义节点源码纳入仓库。
- Studio 通过 `/upload/image` 上传 1—16 张图片，动态创建 `LoadImage`、`ImageBatch`、生成节点和 `SaveImage`。
- 通过 `/prompt`、`/history`、`/view` 取回结果，验证图片、jobId 和哈希后注册 Artifact。
- OpenRouter Key 只属于 ComfyUI 进程，Studio 不读取也不保存。
- 生成和切分分开，调整裁切不会重新运行付费节点。

### 易用性与可移植性

- 暗色技术仪表盘重构为暖浅色工作台，3D 预览保留中性深灰。
- 简单模式只展示六个制作步骤；技术参数和日志默认折叠。
- 节点图和预览左右排列，可拖动分隔条调整比例。
- 支持 `.tacs-project.zip` 完整工程包和 `.tacs-profile.json` 轻量流程配置。
- 设置页提供环境自检和 Comfy 自定义节点安装/更新。

### 动画、骨骼与 UE 收尾

- Rigging 的基础 Walking GLB 会通过同一 Normalize 参数生成 `normalized-walk.fbx`。
- Animation 节点可在 Studio 中预览 Idle、Walk 和 Run GLB。
- Normalize 将 Meshy 现有 24 根骨骼改为 UE 常用核心命名，例如 `Hips → pelvis`、`LeftUpLeg → thigh_l`、`LeftArm → upperarm_l`。
- 不添加 Root、Twist、IK 或手指骨骼，不改变层级和参考姿势；后续 IK Retargeter 由用户在 UE 中手工建立。

## 5. 关键问题与解决过程

| 问题 | 原因 | 处理结果 |
|---|---|---|
| Meshy 返回 401 `Missing API key` | 环境变量未进入当前 PowerShell 会话 | 使用完整 `Authorization: Bearer` 请求验证；Key 不写入文件 |
| Animation 列表为空 | 认证成功但账户没有历史任务 | 将空列表只视为端点可访问，不误判为 Rigging/Animation 已完成 |
| 约 194 万面模型无法 Rigging | 超过 Meshy 320,000 面限制 | 在 Generation 与 Rigging 之间加入 Remesh，目标约 100,000 面 |
| Remesh 返回 `NoMatchingRoute` | 使用了错误的 v2 路由 | 改用已验证的 `/openapi/v1/remesh`，保留历史失败记录 |
| Node 报 `EISDIR ... lstat 'E:'` | Windows 路径在 sidecar 参数中被错误拆分 | 改为参数数组传递和路径规范化，不拼接 shell 命令 |
| `confirmSpend` 提示期望 boolean | Tauri 调用传入了对象 | 修正为真实布尔值，并增加 Rust 测试 |
| 高面数模型视觉类似破面 | 实际为部分法线反向 | Normalize 改为保留来源法线；UE 导入法线和切线，材质可配置双面 |
| 自动导入 UE 后模型过小 | DCC/FBX/UE 单位差异 | UE 导入统一使用 100 倍比例，并在报告中检查 Bounds |
| UE 动画导入拒绝非整数帧 | Meshy 动画帧区间不落在整帧边界 | Animation 导入启用最近帧边界吸附 |
| Walk 没有进入 UE | 早期只处理主 Idle FBX | Normalize 单独转换 Walking GLB，UE 导入到同一 Skeleton |
| Walk 复制报 `ENOENT` | Blender 脚本错误时仍返回 0，后续复制掩盖真实原因 | 增加 `--python-exit-code 1` 和输出存在验证；`EC_Testing` 已重跑成功 |
| 关节名不利于 UE 手工重定向 | Meshy 使用 Hips、LeftUpLeg 等命名 | 固定改为 UE 核心命名，只改已有骨骼，不增加或识别关节 |
| Comfy 修改裁切可能重复扣费 | 生成与裁切在同一工作流容易重复排队 | 拆成生成工作流和本地切分步骤，付费确认默认关闭 |

## 6. 安全与工程约束

- 所有 OpenAI、OpenRouter 和 Meshy 付费创建请求都需要逐次确认。
- 超时或断线后不自动重试付费 POST；先检查 task ID、prompt ID 或服务日志。
- `.env`、API Key、角色图片、GLB/FBX、UE 资产、Node sidecar、安装包和构建缓存不进入 Git。
- Rust 后端拒绝伪造 Artifact ID、绝对路径、路径穿越和已删除文件。
- 工程包导入拒绝符号链接、越界路径和超限解压。
- Blender、UE 和 ComfyUI 不随客户端安装包分发；Node sidecar 随安装包分发。

## 7. 当前验证证据

| 验证项 | 结果 |
|---|---|
| TypeScript + Cargo check | PASS |
| 管线 Mock 测试 | 23/23 PASS |
| Rust 后端测试 | 9/9 PASS（最近完整回归） |
| Vite 生产构建 | PASS |
| Meshy Generation / Remesh / Rigging / Animation | 真实任务 PASS |
| Comfy 上传、回传和切分 | PASS |
| OpenRouter Low 三视图请求 | PASS，已记录单次费用 `$0.0099` |
| `Testing_2` Blender Normalize | PASS/WARNING，24 骨骼并输出 Walk |
| `Testing_2` UE 5.4 导入 | PASS，Idle/Walk 共用 Skeleton |
| `EC_Testing` 最新 Normalize | WARNING，5 个输出、24 骨骼、`ue5-core` 命名、Walk 已生成 |

`WARNING` 表示文件已经产生，但存在需要美术人员查看的项目，例如循环曲线首尾差异；它不等于执行失败。

## 8. 当前弱项和待完成工作

- 需要第二个显著不同风格的角色完整运行，证明没有写死当前角色。
- 自动权重仍需检查肩、胯、膝、手腕、脚踝和衣物附件。
- Idle/Walk 仍可能存在脚底滑动、身体倾斜、Root/Pelvis 偏移和循环跳变。
- 纹理需要人工检查关键服装图案、材质分区、粗糙度和局部清晰度。
- UE IK Rig、IK Retargeter 和 Retarget Pose 当前留给用户手工建立。
- OpenAI 直连 GPT Image 2 仍只有 Mock 证据；已验证闭环使用 ComfyUI + OpenRouter。
- 最新源码改动后尚未重新生成最终 MSI/NSIS，也尚未做商业代码签名。

## 9. 构建与测试命令

```powershell
cd E:\AIEval\TACharacterStudio
npm.cmd install
npm.cmd run check
npm.cmd run pipeline:test
cargo test --manifest-path src-tauri/Cargo.toml
npm.cmd run build
```

最终候选版本才执行：

```powershell
npm.cmd run verify
npm.cmd run bundle
npm.cmd run delivery
```

## 10. 演示视频建议脚本

建议录制 5—8 分钟，避免展示长时间轮询：

1. 展示一张新参考图和“新建工程”。
2. 展示 Comfy 三视图生成结果，说明本次已确认付费。
3. 拖动切分线并完成正/侧/背美术确认。
4. 快速展示 Manifest 中 Generation、Remesh、Rigging 和 Animation 的成功状态及中间产物。
5. 在 Studio 中切换预览原模型、减面模型、骨架、Idle 和 Walk。
6. 运行或展示 Normalize 报告，指出 24 根 UE 核心命名骨骼和 Warning 含义。
7. 打开 UE Preview Map，展示 Skeletal Mesh、材质、Idle 与 Walk 共用 Skeleton。
8. 最后展示工程包、流程配置和 README/两份提交文档。

视频中不要展示完整 API Key、认证头、本机私密目录或带签名的临时下载 URL。

## 11. 最终提交范围

“提交所有代码”指提交能够阅读、测试和重新构建项目的源码，不是把 11 GB 开发目录原样压缩。建议最终目录为：

```text
Delivery/
├─ FinalAnswer/                 测试题回答
├─ DemoVideo/                  完整流程演示视频
├─ Installers/                 MSI、NSIS 和校验值
├─ Source/
│  ├─ TACharacterStudio-source.zip
│  └─ Eval_Commiting-UE.zip
└─ Documentation/
   ├─ DEVELOPMENT_RECORD.md
   ├─ ARTIST_GUIDE.md
   ├─ MANUAL_ACCEPTANCE.md
   └─ TROUBLESHOOTING.md
```

Studio 源码包应包含 `src/`、`src-tauri/`、`pipeline/`、`integrations/comfy/`、`scripts/`、配置、测试、README 和许可证说明。UE 包应保留可打开项目所需的 `Config/`、`Content/`、`.uproject` 以及项目自己编写的 `Source/` 或 Python 脚本。

必须排除：

```text
node_modules/
dist/
target/
src-tauri/binaries/node*.exe
Saved/
Intermediate/
DerivedDataCache/
.vs/
.env*
API Key
临时日志、下载缓存和无关角色输出
```

生成模型、贴图和 `.uasset` 是否提交取决于它们是否是评审必需的最终结果。只保留能够证明最终角色和 UE Preview Map 的精简资产，不提交重复缓存或所有历史运行。
