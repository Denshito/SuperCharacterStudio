import type { Edge } from "@xyflow/react";
import type { ManifestV2 } from "../types/manifest";
import { combinedState } from "../types/manifest";
import type { PipelineNode, PipelineNodeData } from "../types/pipeline";

type Definition = Omit<PipelineNodeData, "status"> & { id: string; x: number; y: number };
// 这些只是 UI 投影定义。修改节点位置或文案不会改变 Manifest，也不会执行管线。
const advanced: Definition[] = [
  { id: "reference", x: 20, y: 160, title: "参考图", subtitle: "Reference", category: "Input", description: "一张或多张角色概念图，原图始终保留。", stageIds: ["reference-source"], output: "source-images" },
  { id: "image-turnaround", x: 230, y: 160, title: "生成三视图", subtitle: "AI Turnaround", category: "AI", description: "用 GPT Image 2 将参考图整理为正、侧、背三联图。", stageIds: ["image-turnaround"], input: "source-images", output: "turnaround-sheet" },
  { id: "comfy-prep", x: 230, y: 310, title: "Comfy 参考图", subtitle: "Comfy / OpenRouter", category: "AI", description: "由本地 ComfyUI 调用 OpenRouter 生成三视图；提交前会逐次确认费用。", stageIds: ["comfy-prep"], input: "source-images", output: "turnaround-sheet" },
  { id: "view-split", x: 440, y: 160, title: "切分视图", subtitle: "View Split", category: "Process", description: "本地切分三联图，可调整分隔线和视图顺序。", stageIds: ["view-split"], input: "turnaround-sheet", output: "image-set" },
  { id: "reference-approval", x: 650, y: 160, title: "美术确认", subtitle: "Art Review", category: "Process", description: "确认最终正、侧、背参考图；未确认不能生成模型。", stageIds: ["reference-approval"], input: "image-set", output: "approved-image-set" },
  { id: "generation", x: 860, y: 160, title: "生成模型", subtitle: "Generation", category: "AI", description: "由已确认参考图生成带纹理的三维角色。", stageIds: ["generation"], input: "approved-image-set", output: "mesh" },
  { id: "inspect", x: 1070, y: 35, title: "网格检查", subtitle: "Inspect", category: "Process", description: "查看几何、材质与流程就绪情况。", stageIds: ["inspect"], input: "mesh", output: "validation-report" },
  { id: "remesh", x: 1070, y: 255, title: "减面优化", subtitle: "Remesh", category: "AI", description: "将模型降低到可绑定的面数。", stageIds: ["remesh"], input: "mesh", output: "mesh" },
  { id: "rigging", x: 1280, y: 255, title: "骨骼绑定", subtitle: "Rigging", category: "AI", description: "生成骨架和蒙皮权重。", stageIds: ["rigging"], input: "mesh", output: "rigged-mesh" },
  { id: "animation", x: 1490, y: 255, title: "角色动画", subtitle: "Animation", category: "AI", description: "为已绑定角色应用动作。", stageIds: ["animation"], input: "rigged-mesh", output: "animation" },
  { id: "normalize", x: 1700, y: 255, title: "规格统一", subtitle: "Normalize", category: "DCC", description: "统一坐标与比例，检查并保留来源法线，生成质量报告。", stageIds: ["normalize"], input: "animation", output: "validation-report" },
  { id: "ue-import", x: 1910, y: 255, title: "导入 UE", subtitle: "UE Import", category: "Engine", description: "导入资产并更新预览关卡。", stageIds: ["ue-import"], input: "validation-report", output: "ue-assets" },
];
const simple: Definition[] = [
  { id: "reference-prep", x: 20, y: 150, title: "参考图处理", subtitle: "Reference + Art Review", category: "输入", description: "导入参考图，并完成三视图生成、切分与美术确认。", stageIds: ["reference-source", "image-turnaround", "view-split", "reference-approval"], output: "approved-image-set" },
  { id: "generation", x: 240, y: 150, title: "生成模型", subtitle: "Generation", category: "生成", description: "从已确认参考图得到初始三维模型。", stageIds: ["generation"], input: "approved-image-set", output: "mesh" },
  { id: "optimize", x: 460, y: 150, title: "优化", subtitle: "Inspect + Remesh", category: "处理", description: "检查模型并降低到适合后续制作的面数。", stageIds: ["inspect", "remesh"], input: "mesh", output: "mesh" },
  { id: "rig-animation", x: 680, y: 150, title: "绑定与动画", subtitle: "Rigging + Animation", category: "制作", description: "为角色建立骨骼并应用动作。", stageIds: ["rigging", "animation"], input: "mesh", output: "animation" },
  { id: "quality", x: 900, y: 150, title: "质量检查", subtitle: "Normalize", category: "交付", description: "检查并统一交付规格。", stageIds: ["normalize"], input: "animation", output: "validation-report" },
  { id: "ue-import", x: 1120, y: 150, title: "UE", subtitle: "UE Import", category: "引擎", description: "将交付资产导入 Unreal Engine。", stageIds: ["ue-import"], input: "validation-report", output: "ue-assets" },
];
export function makeGraph(mode: "simple" | "advanced", manifest?: ManifestV2): { nodes: PipelineNode[]; edges: Edge[] } {
  // 每次从 Manifest 重建节点状态，避免 React state 成为第二套运行数据库。
  const definitions = mode === "simple" ? simple : advanced;
  const legacyApproved = Boolean(manifest && !manifest.stages["reference-source"] && (manifest.input as Record<string, unknown> | undefined)?.front && (manifest.input as Record<string, unknown> | undefined)?.back);
  const nodes = definitions.map(({ id, x, y, ...data }) => ({ id, type: "pipeline" as const, position: { x, y }, data: { ...data, status: legacyApproved && ["reference", "reference-prep", "image-turnaround", "view-split", "reference-approval"].includes(id) ? "SUCCEEDED" as const : combinedState(data.stageIds, manifest) } }));
  const chain = mode === "simple"
    ? [["reference-prep", "generation"], ["generation", "optimize"], ["optimize", "rig-animation"], ["rig-animation", "quality"], ["quality", "ue-import"]]
    : [["reference", "image-turnaround"], ["reference", "comfy-prep"], ["image-turnaround", "view-split"], ["comfy-prep", "view-split"], ["view-split", "reference-approval"], ["reference-approval", "generation"], ["generation", "inspect"], ["generation", "remesh"], ["remesh", "rigging"], ["rigging", "animation"], ["animation", "normalize"], ["normalize", "ue-import"]];
  return { nodes, edges: chain.map(([source, target]) => ({ id: `${source}-${target}`, source, target, type: "smoothstep" })) };
}
