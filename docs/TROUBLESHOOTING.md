# 故障处理

| 现象 | 处理 |
|---|---|
| Comfy 可连接但缺少 TA 节点 | 在设置中安装/更新节点，完整退出并重启 ComfyUI，再检测 |
| Comfy 提示缺少 Key | 从设置了 `OPENROUTER_API_KEY` 的终端启动 ComfyUI；不要把 Key 写入 workflow |
| Comfy 超时或断线 | 先查 OpenRouter Logs 和 Comfy `/history`；不要自动重试，避免重复扣费 |
| Meshy Rigging 拒绝高面数 | 使用 `/openapi/v1/remesh` 的 GLB 进入 Rigging；不要重复 Generation |
| 阶段显示 STALE | 上游输入或参数已改变；从该节点运行会生成或复用匹配哈希的结果 |
| 产物显示缺失 | 文件被移动/删除；恢复到 Manifest 记录的位置，或从合法中间产物重新连接 |
| Normalize 报无变形组网格 | 先确认是否为眼睛/附件；需要随骨骼变形时在 Blender 权重绑定 |
| Normalize 报循环曲线不一致 | 在预览中检查首尾帧、Root/Pelvis 与脚底；必要时在 Blender 清理曲线 |
| UE 出现重复资产 | 必须使用稳定的 `/Game/Generated/<runId>/` 路径，不要手动改名后重复导入 |
| Windows SmartScreen 提示 | 当前测试交付未做商业代码签名；核对 `checksums.sha256` 后选择继续 |

日志、Manifest 和工程包不应包含 API Key。出现付费请求不确定状态时，以服务端 Logs 为准，并由用户决定是否重试。
