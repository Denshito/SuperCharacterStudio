# 美术人员快速操作

## 第一次启动

1. 打开“设置与服务”，执行“一键环境自检”。内置 Node 和管线应为 PASS；只做参考图与模型预览时，Blender/UE 可以暂时缺失。
2. 若使用 Comfy 路径，选择“安装 / 更新 Comfy 节点”，选中 ComfyUI 的 `custom_nodes` 文件夹，随后完整退出并重启 ComfyUI。
3. OpenRouter Key 由 ComfyUI 启动进程的 `OPENROUTER_API_KEY` 管理；Studio 不读取它。Meshy/OpenAI Key 只在当前 Studio 会话输入，不写入工程。

## 最短制作流程

1. 新建工程，导入一张主参考图，可选第二张补充图。
2. 选择“Comfy 参考图”或“AI 三视图”，确认费用后生成三联图；也可以直接导入已有三联图。
3. 在“切分视图”拖动分隔线、交换正/侧/背标签并保存。
4. 在“美术确认”逐张采用。至少确认正面与背面，模型生成才会解锁。
5. 依次运行 Generation、Remesh、Rigging、Animation。停止只停止本地轮询，已有 task ID 可恢复。
6. 运行 Normalize；检查权重、附件、循环动画、贴图与角色高度报告。
7. 运行 UE Import，在 Preview Map 中检查材质、骨架、脚底接触和动画。

## 何时返回上一步

- 身份、比例、服装结构或关键图案错误：回到参考图和美术确认。
- 面数过高：只重跑 Remesh，不重复 Generation。
- 肩胯膝变形、附件未绑定：在 Blender 副本中权重精修，再导回 Normalize。
- Root/Pelvis 偏移、脚底滑动、循环跳变：先在 Blender 修正基础动画，再用 UE IK 做落地适配。
- 材质分区或纹理细节不足：保留网格与绑定，单独修贴图。

## 换机与交付

- “导出工程包”生成 `.tacs-project.zip`，包含 Manifest、节点图和项目中间产物。
- “导出流程配置”生成 `.tacs-profile.json`，只含可复用参数，不含密钥、本机路径或 Comfy 地址。
- 新机器先安装客户端，再导入工程包并运行环境自检。Blender、UE、ComfyUI 需单独安装。
