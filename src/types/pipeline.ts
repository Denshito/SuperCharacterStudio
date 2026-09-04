import type { Node } from "@xyflow/react";

export type ArtifactKind =
  | "image-set"
  | "mesh"
  | "rigged-mesh"
  | "animation"
  | "texture"
  | "validation-report"
  | "ue-assets";

export interface Artifact {
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
  category: "Input" | "AI" | "Process" | "DCC" | "Engine";
  description: string;
  status: NodeRunState;
  input?: ArtifactKind;
  output?: ArtifactKind;
}

export type PipelineNode = Node<PipelineNodeData, "pipeline">;
