# ComfyUI TA Character Tools

Studio 的 ComfyUI 桥接依赖以下节点：

- `TAOpenRouterTurnaround`：通过 OpenRouter `openai/gpt-5.4-image-2` 生成三联图。
- `TASplitTurnaround`：本地切分节点；Studio 自动桥接默认仍在 Studio 内完成切分。

节点只从 Comfy 进程的 `OPENROUTER_API_KEY` 环境变量读取密钥。工作流、日志、Manifest 和 Studio 均不保存密钥。付费请求没有自动重试。

安装或更新：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-comfy-nodes.ps1
```

完整退出并重启 Comfy Desktop 后，在 Studio 设置中执行“检测 ComfyUI”。
