# TA Character Studio：项目状态与后续构建路线

更新时间：2026-09-08
仓库：`Denshito/TACharacterStudio`（Private）
分支：`Meshy/GPTImage`
已提交基线：`fbc37c4 feat: integrate Meshy and GPT Image workflow`

> 本文记录当前状态和后续路线。它区分已实际验证、自动测试通过、Mock 验证、计划中四种状态；不记录 API Key、测试角色图片、生成模型或 UE 资产。

## 1. 定位与状态真相

TA Character Studio 面向角色技术美术测试和小型生产流程。它不是通用 AI 节点编辑器，而是将“参考图到 Unreal Engine 可用角色”的过程组织为可追溯、可恢复、可审核的生产工单。

- **简单模式**服务美术人员：参考图准备、美术确认、资产预览、版本采用与导出。
- **高级模式**服务 TA：真实节点、重连、中间产物注入、任务恢复、Blender/UE 设置与技术日志。
- `manifest.json` 是运行状态真相，保存输入、阶段状态、task ID、费用、错误、哈希与产物。
- `project.json` 只保存节点连接和 UI 图状态。

## 2. 当前架构与流程

```text
Tauri + React + TypeScript + XYFlow + Three.js
                 │
                 ├─ Rust：文件授权、Artifact ID、安全边界、sidecar 管理
                 └─ Node sidecar：pipeline/pipeline.mjs，JSONL 进度
                                      │
              OpenAI GPT Image / Meshy / Blender / Unreal Engine
```

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

关键约束：

- Generation 仅接收已美术确认的图片集。
- Remesh 输出 GLB 进入 Rigging，成功的 Generation 不重做。
- 本地 GLB 可以从 Inspect、Remesh 或 Rigging 继续；Animation 必须有有效 `rig_task_id`。
- 上游输入或参数变化会使下游变为 `STALE`。
- 前端只使用受批准的 `artifact_id`，不能读取任意路径。

## 3. 当前完成度

| 子系统 | 状态 | 证据 / 边界 |
|---|---|---|
| 读取 Manifest 与 Artifact 安全访问 | 已实现 | Rust 测试拒绝伪造 ID、绝对路径、路径穿越、缺失文件 |
| 节点图与恢复 | 已实现 | 简单/高级模式、重连、导入 GLB、STALE、Run/Stop/Resume |
| Three.js 预览 | 已实现 | GLB、骨架、动画、图片、阶段对比；仍需实机多尺寸检查 |
| Meshy Generation | 实际验证 | 已生成角色资产；需要第二角色验证 |
| Remesh | 实际验证 | 高面数资产经 `/openapi/v1/remesh` 可继续绑定 |
| Rigging / Animation | 实际验证 | 24 骨骼与动画资产；动作观感和蒙皮仍待美术修复 |
| Blender Normalize / 质量审计 | 实际验证 | 1.6 m、103,086 三角面、24 骨骼；权重、循环曲线、Root Motion 与贴图报告 |
| UE Import | 实际验证 | 稳定资产路径、Preview Map、可重复导入流程 |
| GPT Image 2 | Mock 通过 | 三视图、切分、门禁、付费阻断、路径安全；待一次 Low 质量真实调用 |
| Comfy Bridge（7D） | 实际验证 | Studio 上传/下载/切分真实往返；一次 Low 请求成功，费用 `$0.0099` |
| 节点工作流灵活性 | 已实现 | 中间节点可导入 GLB / 三视图 PNG，可从任意步骤运行，Comfy 作为可替换的三视图后端，下游链路不变 |
| 暖浅色 GUI 重构 | 源码已修改、未提交 | 6 步简单模式、任务型 Inspector、设置对话框、折叠日志；待实机视觉验收 |
| 可移植性 | 已实现、待 GUI 手验 | 工程 ZIP、流程配置、一键环境自检、安装/更新 Comfy 节点 |
| 安装包 | PASS | 当前候选 MSI / NSIS 已生成；MSI 管理提取、资源清单和启动烟雾测试通过 |

### 当前未提交 GUI 修改

当前工作树保留：

- `src/App.tsx`
- `src/styles.css`
- `src/components/ModelViewport.tsx`
- `src/components/PipelineNodeCard.tsx`
- `src/data/starterGraph.ts`

内容：固定暖浅色美术工作台；简单模式压缩为 6 步；顶栏仅保留新建、打开和状态；Inspector 默认仅显示当前任务、参数和产物；设置/运行详情/JSON 改为折叠；日志改为状态抽屉；节点图和预览默认 `46:54`。

本次新增的 Comfy Bridge 与工作流灵活性改动同样未提交，涉及：

- `pipeline/pipeline.mjs`、`pipeline/config.json`、`pipeline/pipeline.test.mjs`
- `src-tauri/src/lib.rs`
- `src/App.tsx`、`src/data/starterGraph.ts`、`src/styles.css`

## 4. 验证与当前阻塞

已通过：

```powershell
npm.cmd run check
# TypeScript + Cargo check；会准备被忽略的 Node sidecar

npm.cmd run pipeline:test
# 22 项测试：付费阻断、恢复、参考图门禁、切分、路径安全、Remesh，以及 Comfy 的节点检测、上传、动态工作流、回传和错误路径

cargo test --manifest-path src-tauri/Cargo.toml
# 6 项 Rust 安全测试（含导入清单路径和可移植配置白名单）
```

`npm.cmd run verify` 已在桥接阶段通过（check + 22 项管线测试 + Rust 测试 + production build）。本轮新增工程包、流程配置、环境自检和质量审计后会再次全量回归。`tauri dev` 的 GUI 视觉验收仍需在本机执行：

```powershell
cd E:\AIEval\TACharacterStudio
npm.cmd run verify
npm.cmd run tauri -- dev
```

手工验收：检查 `1440×900`、`1152×720`、最小窗口无重叠；打开既有 Manifest；检查简单/高级模式、参考图处理、模型/骨架/动画预览、分隔条、设置、日志抽屉、导出、Mock 运行与「检测 ComfyUI」。没有用户确认时不调用 OpenAI、OpenRouter 或 Meshy 付费接口。

## 5. 当前弱项

- 自动动画仍可能有 Root/Pelvis 偏移、脚底接触、循环与局部穿插问题。
- 肩、胯、膝盖、衣物尚未经过标准姿势和极限姿势测试。
- 纹理整体可用，但关键服装图案、材质分区、粗糙度层次和局部细节不足。
- 当前需以第二个显著不同风格的角色证明流程没有写死。
- OpenAI 直连 GPT Image 2 尚待验证；OpenRouter GPT-5.4 Image 2 Low 已实际验证。

判断原则：角色身份、比例、服装结构或关键纹样错误时回到参考图阶段；高面数、Transform、法线、Root/Pelvis、循环和脚底问题优先后期修正；贴图信息缺失可保留网格并重绘；严重权重或骨架错误进入 Blender 精修或重绑。

## 6. ComfyUI 定位与桥接决策

采用 **Studio 主控 + Comfy Bridge + Blender 修复**，不全量迁移到 ComfyUI：

```text
Studio：项目、Manifest、付费确认、版本采用、预览、UE 交付
  ↓
ComfyUI：三视图、局部重绘、风格统一、纹理候选、Mask
  ↓
Blender：权重、骨骼、动画、UV、贴图回写、最终导出
```

第一版桥接包 `TACharacterComfyBridge` 仅处理图像：

```text
<run目录>/bridge/<jobId>/
├─ request.json
├─ input/front.png、side.png、back.png
├─ workflow_api.json
└─ output/response.json
```

流程：Studio 导出已批准输入与预设 → 本地 ComfyUI 执行固定参考图预处理 workflow → 输出 PNG/`response.json` → Studio 校验文件类型、哈希、jobId 后注册为 Artifact → 美术人员在 Studio 预览和采用。

约束：Comfy workflow 不包含 API Key、角色专有绝对路径；回传结果不覆盖原图；Bridge 失败不污染 Manifest；第一版不迁移 Meshy、Blender 或 UE 调用。

### 复用性的验收定义

> 更换角色输入和已声明参数后，不改源码、不手改脚本、不重新连接流程，仍输出相同结构的中间产物、报告和 UE 交付结果。

验收用角色 A 与角色 B：两者使用同一 Studio 节点图、同一 Comfy workflow JSON、同一管线源码；仅替换参考图、项目名和公开艺术参数；都输出 Manifest、模型、绑定、动画、报告和 UE 导入结果。人工审核只能发生在固定门禁节点。

## 7. 后续构建计划

### 7B：GUI 固化与泛化验证

- 在本机完成 production build 与 GUI 手工验收。
- 修正用户视觉反馈后提交暖浅色 GUI 重构；不重打包。
- 以第二角色跑同一节点图；先 Mock，是否实际消费 credits 必须由用户逐次确认。
- 输出双角色对比：输入、阶段状态、耗时、credits、人工介入、验证和 UE 导入报告。

验收：不改代码与流程图即可处理两角色；失败均可从 Manifest 恢复，且不重复创建已有付费任务。

### 7C：后期资产质量节点

```text
Rigging
→ Weight Audit
→ Weight Repair（Blender）
→ Animation Cleanup（Blender）
→ Normalize
→ UE Import

Texture Review
→ Material / Texture Patch
→ 新贴图 Artifact
```

`Weight Audit` 先只报告未绑定顶点、权重和、影响数、左右对称、异常骨骼影响范围，以及 Bind Pose / 抬臂 / 下蹲 / Idle 结果。

`Weight Repair` 分三档：自动清理（Normalize、清零、限制影响数）、对称修复（镜像权重）、Blender 精修（创建副本、定位问题、用户 Weight Paint、导回）。自动处理永远输出新资产与报告，不覆盖 Meshy 原资产。

`Animation Cleanup` 做 Root/Pelvis 校正、循环和脚底检查；UE Control Rig / Foot IK 只作为最后适配，不替代基础动画修正。`Texture Review` 先支持 BaseColor、Roughness、Normal、AO 预览与导出，后续接入人工重绘回写。

### 7D：Comfy Bridge

- 检测本地 ComfyUI 服务，未启动时提供可操作提示。
- 使用 `TAOpenRouterTurnaround`：输入参考图、艺术预设、补充提示词；输出三联图并回到 Studio 切分。
- Studio 创建任务、提交 workflow、读取回传、注册 Artifact。
- 用角色 A/B 跑同一份 workflow JSON。

验收：用户只需在 Studio 选择“在 Comfy 准备参考图”、选择预设、在 Studio 采用结果；无需复制文件或编辑 JSON。

> 当前实现与验证：`pipeline.mjs` 通过 `/upload/image` 上传 1—16 张参考图，动态构建 `LoadImage/ImageBatch/TAOpenRouterTurnaround/SaveImage` API 图，并在 `<run>/bridge/<jobId>/` 保存脱敏请求、工作流和响应。真实 ComfyUI 0.33.4 无付费往返及本地切分已通过；一次 Low 请求成功，记录费用 `$0.0099`。Key 只由 Comfy 进程读取。

### 7E：最终文档与打包

- **已完成**：更新 README、路线、故障处理、美术操作手册、验收清单和第三方许可证说明。
- 制作演示视频：参考图 → 中间产物 → 模型/骨架/动画 → UE Preview Map；展示一次 Remesh 恢复和一次 Comfy Bridge。
- **已完成**：运行 `npm.cmd run verify`，生成 MSI、NSIS 和 SHA-256；管理提取确认内置 Node、管线、Blender/UE 脚本与 TA Comfy 节点。
- **已完成**：`Delivery/` 包含安装包、Studio/Pipeline/UE 源码包、文档、视频验收清单与校验文件。
- **待用户验收**：在另一台无系统 Node.js 的 Windows x64 机器安装；录制最终演示视频并完成美术观感检查。

## 8. 最终答辩证据

1. 同一 Studio 节点图处理两个不同角色。
2. 同一 `TAOpenRouterTurnaround` Comfy workflow 处理两组参考图。
3. 高面数失败通过 Remesh 恢复，未重做 Generation。
4. Manifest 如何记录 task ID、哈希、费用、失败和恢复。
5. 一个动画/权重或纹理问题如何经历 Review、Blender 修复、UE 复查并产出新 Artifact。
6. UE Preview Map 中角色、材质、骨架和动画的实际播放。

这些证据共同回答评分中的流程自动化、工具综合应用、美术表现与工程素养问题。
