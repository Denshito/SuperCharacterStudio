import type { Node } from "@xyflow/react";

export type ArtifactKind =
  | "source-images"
  | "turnaround-sheet"
  | "image-set"
  | "approved-image-set"
  | "mesh"
  | "rigged-mesh"
  | "animation"
  | "texture"
  | "validation-report"
  | "ue-assets";

export interface Artifact {
  /** 稳定的逻辑 ID；前端不应把 path 当作磁盘读取权限。 */
  id: string;
  kind: ArtifactKind;
  path?: string;
  taskId?: string;
  sha256?: string;
  producerNodeId: string;
  metadata: Record<string, string | number | boolean>;
}

export type NodeRunState =
  | "NOT_STARTED"
  | "RUNNING"
  | "SUCCEEDED"
  | "WARNING"
  | "FAILED"
  | "STALE";

export interface PipelineNodeData extends Record<string, unknown> {
  title: string;
  subtitle: string;
  category: "Input" | "AI" | "Process" | "DCC" | "Engine";
  description: string;
  status: NodeRunState;
  /** 一个简单模式节点可以聚合多个真实 Manifest 阶段。 */
  stageIds: string[];
  /** 端口类型只用于编辑器连接校验，实际执行仍由 Manifest 阶段约束。 */
  input?: ArtifactKind | ArtifactKind[];
  output?: ArtifactKind;
}

export type PipelineNode = Node<PipelineNodeData, "pipeline">;
