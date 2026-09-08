import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { PipelineNode } from "../types/pipeline";

const statusLabels: Record<string, string> = { NOT_STARTED: "未开始", RUNNING: "进行中", SUCCEEDED: "已完成", WARNING: "需检查", FAILED: "失败", STALE: "需更新" };

export function PipelineNodeCard({ data, selected }: NodeProps<PipelineNode>) {
  return (
    <article className={`pipeline-node status-${data.status.toLowerCase()} ${selected ? "is-selected" : ""}`}>
      {data.input && <Handle type="target" position={Position.Left} />}
      <div className="node-heading">
        <span className="node-category">{data.category}</span>
        <span className="node-status-dot" aria-label={data.status} />
      </div>
      <strong>{data.title}</strong>
      <em>{data.subtitle}</em>
      <small>{statusLabels[data.status] ?? data.status.replace("_", " ")}</small>
      {data.output && <Handle type="source" position={Position.Right} />}
    </article>
  );
}
