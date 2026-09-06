# Embedded Character Pipeline

这是 TA Character Studio 内置的 Node.js 管线源码。请从仓库根目录运行命令；整体架构、GUI 操作、验证状态和安全边界见根目录 [README](../README.md)。

## 阶段

```text
reference-source → image-turnaround → view-split → reference-approval
→ generation → remesh → rigging → animation → normalize → ue-import
```

- `image-turnaround`、`generation`、`remesh`、`rigging`、`animation` 可能创建付费任务，必须显式确认。
- `view-split`、`reference-approval`、`normalize`、`ue-import` 是本地阶段。
- 每个阶段通过 JSONL 输出状态，并把真实状态写入 Manifest v2。
- 任务输入哈希一致时复用成功结果；变化时保留 `previousAttempts` 并将下游标记为 `STALE`。

## 测试

```powershell
npm.cmd run pipeline:test
```

测试全部使用 Mock 或本地临时文件，不访问 OpenAI、Meshy、Blender 或 Unreal Engine。

## CLI 示例

```powershell
node pipeline/pipeline.mjs init --reference D:\Assets\concept.png --run-name character-01 --output-root D:\TAProjects --json
node pipeline/pipeline.mjs execute image-turnaround --manifest D:\TAProjects\output\character-01\manifest.json --json --mock
node pipeline/pipeline.mjs execute view-split --manifest D:\TAProjects\output\character-01\manifest.json --json
node pipeline/pipeline.mjs approve-references --manifest D:\TAProjects\output\character-01\manifest.json --front view-split:0 --side view-split:1 --back view-split:2 --json
```

真实云端调用从环境变量读取 `OPENAI_API_KEY` 或 `MESHY_API_KEY`；不要把 Key 写入配置、Manifest 或提交内容。
