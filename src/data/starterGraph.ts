import type { Edge } from "@xyflow/react";
import type { PipelineNode } from "../types/pipeline";

const node = (
  id: string,
  x: number,
  y: number,
  data: PipelineNode["data"],
): PipelineNode => ({ id, type: "pipeline", position: { x, y }, data });

export const starterNodes: PipelineNode[] = [
  node("reference", 30, 150, {
    title: "Reference Input",
    category: "Input",
    description: "Front and back character reference images.",
    status: "NOT_STARTED",
    output: "image-set",
  }),
  node("generate", 290, 150, {
    title: "Generate 3D",
    category: "AI",
    description: "Create a textured humanoid GLB with Meshy.",
    status: "NOT_STARTED",
    input: "image-set",
    output: "mesh",
  }),
  node("inspect", 550, 30, {
    title: "Mesh Inspect",
    category: "Process",
    description: "Measure geometry, materials and pipeline readiness.",
    status: "NOT_STARTED",
    input: "mesh",
    output: "validation-report",
  }),
  node("remesh", 550, 250, {
    title: "Remesh",
    category: "AI",
    description: "Reduce geometry to the configured triangle budget.",
    status: "NOT_STARTED",
    input: "mesh",
    output: "mesh",
  }),
  node("rigging", 810, 250, {
    title: "Rigging",
    category: "AI",
    description: "Create skeleton, skin weights and basic motion.",
    status: "NOT_STARTED",
    input: "mesh",
    output: "rigged-mesh",
  }),
  node("animation", 1070, 250, {
    title: "Animation",
    category: "AI",
    description: "Apply an Idle or Walk clip to the rigged character.",
    status: "NOT_STARTED",
    input: "rigged-mesh",
    output: "animation",
  }),
  node("normalize", 1330, 250, {
    title: "Normalize",
    category: "DCC",
    description: "Normalize transforms, axes, normals and export settings.",
    status: "NOT_STARTED",
    input: "animation",
    output: "animation",
  }),
  node("ue-import", 1590, 250, {
    title: "UE Import",
    category: "Engine",
    description: "Import generated assets and update the preview map.",
    status: "NOT_STARTED",
    input: "animation",
    output: "ue-assets",
  }),
];

export const starterEdges: Edge[] = [
  ["reference", "generate"],
  ["generate", "inspect"],
  ["generate", "remesh"],
  ["remesh", "rigging"],
  ["rigging", "animation"],
  ["animation", "normalize"],
  ["normalize", "ue-import"],
].map(([source, target]) => ({
  id: `${source}-${target}`,
  source,
  target,
  type: "smoothstep",
  animated: false,
}));
