import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { PipelineNode } from "../types/pipeline";

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
      <small>{data.status.replace("_", " ")}</small>
      {data.output && <Handle type="source" position={Position.Right} />}
    </article>
  );
}
