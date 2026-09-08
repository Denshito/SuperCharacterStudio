# TA Character Studio 美术人员使用说明

更新时间：2026-09-08

## 1. 这套工具能做什么

TA Character Studio 把一张或多张角色参考图组织为可在 Unreal Engine 中继续检查的角色资产。美术人员主要负责选择输入、确认参考图、检查模型和动画；任务 ID、哈希、原始 JSON 和完整日志默认收纳在技术区域。

当前完整流程：

```text
导入参考图
→ 生成或导入三视图
→ 切分正面 / 侧面 / 背面
→ 美术确认
→ Meshy 生成模型
→ Remesh 减面
→ Rigging 绑定
→ Idle / Walk 动画
→ Blender Normalize 与质量检查
→ UE 自动导入和 Preview Map
```

## 2. 开始前准备

### 必需项

- Windows x64。
- TA Character Studio 开发版或安装版。
- 可用的 Meshy API Key，用于 Generation、Remesh、Rigging 和 Animation。

### 按流程选装

- 使用 Comfy 生成三视图：安装并启动 ComfyUI，安装 `TA Character Tools` 自定义节点，准备 OpenRouter Key。
- 使用 Studio 直连三视图：准备 OpenAI API Key；当前推荐优先使用已经实际验证的 Comfy/OpenRouter 路径。
- 运行 Normalize：安装 Blender 4.x。
- 自动导入 UE：安装 Unreal Engine 5.4，并准备目标 `.uproject`。

### 第一次环境检查

1. 打开 Studio。
2. 进入“设置与服务”。
3. 运行“一键环境自检”。
4. 确认内置 Node 和管线为 `PASS`。
5. 需要哪个外部阶段，就确认对应的 ComfyUI、Blender 或 UE 为 `PASS`。

缺少 Blender/UE 不影响前面的参考图、建模和 3D 预览，但对应本地阶段不能运行。

## 3. ComfyUI 的准备方式

只有选择“Comfy 参考图”时，才需要同时运行 ComfyUI。

首次安装节点：

1. 在 Studio“设置与服务”选择“安装 / 更新 Comfy 节点”。
2. 选择实际 ComfyUI 安装中的 `custom_nodes` 文件夹。
3. 完整退出 ComfyUI Desktop，不只是关闭网页。
4. 从带有 OpenRouter Key 的 PowerShell 重新启动：

```powershell
$env:OPENROUTER_API_KEY = Read-Host "OpenRouter API Key"
& 'D:\ComfyUI\Comfy Desktop\Comfy Desktop.exe'
```

如果实际 Desktop 路径不同，请选择自己的安装路径。Key 只属于当前 ComfyUI 进程；Studio 不读取它。

回到 Studio 后点击“检测 ComfyUI”，应分别看到：

- 服务可连接。
- `TAOpenRouterTurnaround` 等必需节点存在。
- Key 由 Comfy 环境管理。

## 4. 从一张新参考图开始

### 第一步：新建工程

1. 点击“新建工程”。
2. 输入不会重复的工程名，例如 `character-knight-02`。
3. 选择工程输出根目录。
4. 选择一张主要参考图；可再选择一张补充图。
5. 建议主图包含完整角色、清晰轮廓和尽可能少的遮挡。

Studio 会复制输入到工程目录；原始图片不会被覆盖。

### 第二步：得到三视图

可以任选一种方式：

#### 方式 A：Comfy 参考图（推荐）

1. 保持 ComfyUI 正在运行。
2. 选择“Comfy 参考图”。
3. 选择三视图预设，按需补充服装、材质或姿势要求。
4. 确认模型、质量、宽高比和预计费用。
5. 勾选允许付费并运行一次。
6. 等待 Studio 自动上传参考图、让 Comfy 执行并下载三联图。

不要因为界面暂时没有刷新而立即重复运行。超时后先查看 OpenRouter Logs 和 Comfy Queue，避免重复扣费。

#### 方式 B：Studio AI 三视图

在当前会话输入 OpenAI Key，选择质量和预设，逐次确认费用后运行。没有 Key 时，该功能不会影响其他本地步骤。

#### 方式 C：导入已有三联图

如果已经在 ComfyUI、Photoshop 或其他工具中得到三联图，可直接在“切分视图”导入 PNG，从这里继续，不需要重新生图。

### 第三步：切分视图

1. 进入“切分视图”。
2. 拖动两条蓝色分隔线，使每个区域完整包住一个角色。
3. 确认顺序为正面、侧面、背面；需要时交换标签。
4. 点击保存切分。

该步骤完全在本机执行，不调用 API，也不产生费用。反复调整切分不会重新生成三联图。

### 第四步：美术确认

1. 并排检查原始参考图与三个切分结果。
2. 为正面、侧面和背面分别选择“采用”。
3. AI 结果不理想时，可用原图或其他本地图片替换其中一张。
4. 至少确认正面和背面。

没有通过确认时，Generation 会被管线拒绝。修改源图、提示词或裁切后，确认和下游阶段会变为 `STALE`，需要重新确认。

## 5. Meshy 角色资产流程

以下阶段会创建付费任务，每次都要在 Studio 中单独确认。

### 5.1 Generation：生成模型

- 输入：已确认的正/侧/背图片。
- 输出：带纹理 GLB。
- 检查：角色身份、整体比例、服装轮廓、关键图案和大体材质。

如果身份、比例或服装结构已经错误，应回到参考图，不建议在后面强行修补。

### 5.2 Remesh：减面优化

- 输入：Generation GLB，也可输入授权的本地 GLB。
- 目标面数可在节点中设置为 100–300,000，默认 100,000；实际结果可能略有偏差。
- 输出：可继续 Rigging 的 GLB。

Meshy Rigging 对输入面数有限制；曾出现约 194 万面模型无法绑定的情况。Remesh 成功后直接继续，不需要重复 Generation。

### 5.3 Rigging：骨骼绑定

- 输入：Remesh GLB。
- 输出：绑定角色，以及基础 Walking/Running GLB、FBX。
- 检查：肩、肘、手腕、胯、膝、脚踝和衣物附件。

云端原始 Rigging 文件保留不变。后续 Normalize 会把现有 24 根人形骨骼改为 UE 常用核心名称，但不会增加 Root、Twist、IK 或手指骨骼。

### 5.4 Animation：Idle

- 输入：有效的 Meshy `rig_task_id`。
- 当前默认 `action_id=0`，作为 Idle。
- Rigging 已附带基础 Walk/Run；Studio 可在 Animation 节点的产物列表切换预览。

只有本地绑定 FBX、但没有 Meshy `rig_task_id` 时，不能继续调用 Meshy Animation；可以保留该资产并在 Blender/UE 中添加自己的动画。

## 6. Studio 中检查模型和动画

在高级模式选择不同节点后，可从“当前产物”切换：

- Generation GLB：检查原始形体和纹理。
- Remesh GLB：与 Generation 并排检查减面损失。
- Rigging GLB：显示骨架。
- Idle / Walk / Run GLB：播放、暂停、循环和拖动时间轴。
- Normalize GLB：与处理前结果比较比例、朝向和动画。

Three.js 预览用于快速发现问题，不代替 Blender 权重检查或 UE 最终播放检查。FBX 当前只能导出、打开目录和进入 UE，不能直接在 Studio 预览。

## 7. Normalize：规格统一与质量检查

选择“质量检查 / Normalize”，确认 Blender 路径和目标高度后运行。该阶段是本地处理，不产生云端费用。

Normalize 会：

- 统一单位、角色高度、原点和轴向。
- 保留来源法线和面绕序。
- 将单顶点骨骼影响限制为 4，并归一化有效权重。
- 检查三角面、未绑定网格、零权重点、动画轨道、循环首尾和 Root/Pelvis 位移。
- 把现有 Meshy 骨骼改为 UE 核心命名。
- 使用相同参数生成主角色 FBX 和 `normalized-walk.fbx`。
- 输出 `validation.json`。

命名示例：

```text
Hips        → pelvis
LeftUpLeg   → thigh_l
LeftLeg     → calf_l
LeftArm     → upperarm_l
LeftForeArm → lowerarm_l
```

不会创建不存在的关节。UE IK Rig、Retarget Chains 和 Retarget Pose 后续由用户在 UE 中手工设置。

状态含义：

- `PASS`：自动检查没有发现警告。
- `WARNING`：产物已生成，但需要人工检查列出的项目。
- `FAILED`：没有形成可用交付结果，应先阅读错误摘要和展开日志。

`WARNING` 不等于失败。循环曲线警告需要在预览中重点检查脚底、身体倾斜和首尾跳变。

## 8. 自动导入 Unreal Engine

1. 在设置中选择 `UnrealEditor-Cmd.exe`。
2. 选择目标 `.uproject`。
3. 确认 Normalize 已产生 `normalized-character.fbx`。
4. 运行“UE Import”。
5. 等待命令行 UE 退出并查看 `ue-import-report.json`。
6. 用普通 Unreal Editor 打开项目进行人工检查。

默认资产位置：

```text
/Game/Generated/<runId>/Character/
/Game/Generated/<runId>/Materials/
/Game/Generated/<runId>/Animation/Idle
/Game/Generated/<runId>/Animation/Walk
/Game/Generated/<runId>/Preview/
```

Idle 和 Walk 使用同一个 Skeleton。重复运行会更新稳定路径，而不是生成 `_2`、`_3` 副本。Preview Map 默认播放 Idle；可打开 Walk Animation Sequence 单独检查。

### UE 中的最终人工检查

- 模型高度和地面位置。
- 正反面法线、透明区域和材质槽。
- Skeleton 中 `pelvis`、`spine_01`、`thigh_l/r`、`upperarm_l/r` 等名称。
- Idle 和 Walk 是否引用同一个 Skeleton。
- 肩、胯、膝和手腕变形。
- 脚底滑动、穿地、身体倾斜和循环跳变。
- 衣物、头发和附件是否穿插或脱离。

## 9. 停止、恢复和避免重复付费

- “停止”只停止本地轮询，不能保证云端任务停止。
- 已取得 task ID 或 prompt ID 后，可以重新打开 Manifest 并“恢复”。
- Resume 只恢复已有任务，不创建新付费任务。
- 输入哈希和参数不变时，成功输出可以直接复用。
- 上游发生变化时，下游显示 `STALE`，只需要从变化位置继续。
- 付费任务超时后不要连续点击运行；先检查 Meshy/OpenRouter 历史记录。

## 10. 从中间产物继续

- 已有三联图：从“切分视图”导入 PNG。
- 已有本地 GLB：连接 Inspect、Remesh 或 Rigging。
- 已有成功 Manifest：直接“打开工程”恢复状态和产物。
- 已有本地 FBX 动画：可导出并在 Blender/UE 中使用；当前 Meshy Animation 仍需要有效 `rig_task_id`。

导入文件必须通过原生文件对话框选择。Studio 不允许前端传入任意磁盘路径。

## 11. 产物位置和导出

典型工程目录：

```text
<输出根目录>/output/<runId>/
├─ manifest.json
├─ project.json
├─ reference-source/
├─ comfy-prep/ 或 image-turnaround/
├─ view-split/
├─ reference-approval/
├─ generation/
├─ remesh/
├─ rigging/
├─ animation/
├─ normalize/
│  ├─ normalized-character.glb
│  ├─ normalized-character.fbx
│  ├─ normalized-walk.fbx
│  └─ validation.json
└─ ue-import/
   └─ ue-import-report.json
```

节点产物区域提供“预览”“导出”和“打开所在目录”。导出只复制选中产物，不修改工程内原文件。

## 12. 换机与提交

- “导出工程包”生成 `.tacs-project.zip`，包含该工程 Manifest、节点图和中间产物。
- “导出流程配置”生成 `.tacs-profile.json`，只包含可复用参数。
- API Key、Comfy 地址、本机 Blender/UE 路径不会写入流程配置。
- 新机器安装客户端后，先导入工程包，再执行环境自检。
- Blender、UE 和 ComfyUI 需要单独安装。

最终提交不应直接包含整个 11 GB 开发目录。提交源码、文档、演示视频、必要工程和安装包；排除 `node_modules`、`target`、`dist`、UE `Saved/Intermediate/DerivedDataCache`、临时输出、缓存和密钥。

## 13. 常见问题速查

| 现象 | 建议处理 |
|---|---|
| Comfy 节点不存在 | 重新安装节点并完整退出、重启 ComfyUI |
| Comfy 服务不可达 | 确认 ComfyUI 正在运行且地址为 `127.0.0.1:8188` |
| OpenRouter 401/402/403 | 检查 Key、余额、消费限制和启动 Comfy 的终端环境 |
| Meshy `Missing API key` | 在当前 Studio 会话重新输入 Meshy Key |
| 模型面数过高无法绑定 | 运行 Remesh，不要重做 Generation |
| 付费任务超时 | 先检查服务历史和 Manifest task ID，不自动重试 |
| Normalize 为 WARNING | 打开 `validation.json`，按警告检查动画、权重或附件 |
| Walk 报找不到输出 FBX | 使用包含 Blender 失败退出码修复的最新源码并重跑 Normalize |
| UE 模型很小 | 检查 UE Import Scale，当前默认值为 100 |
| UE 看起来破面 | 检查法线方向；不要随意全局重算法线 |
| 动画歪斜或脚滑 | 先检查 Root/Pelvis 和循环，再在 UE 手工建立 IK Retargeter/Foot IK |

更完整的技术异常说明见 `docs/TROUBLESHOOTING.md`。

## 14. 交付前美术清单

- [ ] 正面、侧面、背面是同一角色，比例和服装一致。
- [ ] Generation 与 Remesh 对比没有明显轮廓损失。
- [ ] 纹理没有不可接受的接缝、文字错误或关键图案缺失。
- [ ] 肩、肘、手腕、胯、膝和脚踝基础变形可用。
- [ ] Idle 和 Walk 可播放且共用 Skeleton。
- [ ] 脚底没有明显滑动、穿地和循环跳变。
- [ ] Normalize 报告中的 Warning 已逐项查看。
- [ ] UE Preview Map 中比例、材质、法线和动画正常。
- [ ] API Key、缓存和临时资产未进入提交包。
