import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addEdge, Background, Controls, MiniMap, ReactFlow, useEdgesState, useNodesState, type Connection, type Edge, type EdgeChange } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ModelViewport } from "./components/ModelViewport";
import { ImageViewport } from "./components/ImageViewport";
import { PipelineNodeCard } from "./components/PipelineNodeCard";
import { makeGraph } from "./data/starterGraph";
import { errorSummary, formatBytes, formatDate, parseManifestV2, type ArtifactInfo, type DraftFile, type LoadedGraph, type LoadedProject, type ManifestV2, type SavedGraphEdge } from "./types/manifest";
import type { PipelineNode } from "./types/pipeline";
import "./styles.css";

/**
 * 桌面端的编排视图。这里保存的是选中项、面板开关和会话 Key 等 UI 状态；
 * 阶段成功与否始终从 Rust 重新读取 manifest.json，不能只根据进程退出码推断。
 */
const nodeTypes = { pipeline: PipelineNodeCard };
const preferredNames: Record<string, string> = {
  "image-turnaround": "turnaround.png",
  "comfy-prep": "turnaround.png",
  "view-split": "front.png",
  "reference-approval": "front.png",
  generation: "model-urls-glb.glb",
  remesh: "model-urls-glb.glb",
  rigging: "result-rigged-character-glb.glb",
  animation: "result-animation-glb.glb",
  normalize: "normalized-character.glb",
};
const paidStages = ["image-turnaround", "comfy-prep", "generation", "remesh", "rigging", "animation"];
const executableStages = ["image-turnaround", "comfy-prep", "view-split", "reference-approval", "generation", "remesh", "rigging", "animation", "normalize", "ue-import"];
const legacyExecutableStages = ["generation", "remesh", "rigging", "animation", "normalize", "ue-import"];
const creditEstimate: Record<string, number> = { generation: 30, remesh: 5, rigging: 5, animation: 3 };
const stageLabels: Record<string, string> = { "image-turnaround": "生成三视图", "comfy-prep": "Comfy 参考图", "view-split": "切分视图", "reference-approval": "美术确认", generation: "生成模型", remesh: "减面优化", rigging: "骨骼绑定", animation: "角色动画", normalize: "规格统一", "ue-import": "导入 UE" };
const statusLabels: Record<string, string> = { NOT_STARTED: "未开始", RUNNING: "进行中", SUCCEEDED: "已完成", WARNING: "需检查", FAILED: "失败", STALE: "需更新", SKIPPED: "已跳过" };
const completedStageStatuses = ["SUCCEEDED", "WARNING", "SKIPPED"];
interface ProcessLine { stream: string; line: string; }
interface ComfyStatus { running: boolean; ready: boolean; version?: string | null; missingNodes?: string[]; }
interface EnvironmentCheck { id: string; label: string; status: "PASS" | "WARNING" | "FAIL"; message: string; }

function preferredArtifact(artifacts: ArtifactInfo[], stages: string[]): ArtifactInfo | undefined {
  const candidates = artifacts.filter((item) => stages.includes(item.stage) && item.previewable);
  return candidates.find((item) => item.fileName === preferredNames[item.stage]) ?? candidates[0];
}

function artifactLabel(artifact: ArtifactInfo): string {
  if (artifact.fileName === "result-animation-glb.glb") return "Idle · GLB（可预览）";
  if (artifact.fileName === "result-animation-fbx.fbx") return "Idle · FBX";
  const basic = artifact.fileName.match(/^result-basic-animations-(walking|running)-(glb|fbx)\.(glb|fbx)$/);
  if (basic) return `${basic[1] === "walking" ? "Walk" : "Run"} · ${basic[3].toUpperCase()}${basic[3] === "glb" ? "（可预览）" : ""}`;
  return artifact.fileName;
}

function App() {
  const initial = useMemo(() => makeGraph("simple"), []);
  const [nodes, setNodes, onNodesChange] = useNodesState<PipelineNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [mode, setMode] = useState<"simple" | "advanced">("simple");
  const [selectedId, setSelectedId] = useState("generation");
  const [manifest, setManifest] = useState<ManifestV2>();
  const [project, setProject] = useState<LoadedProject>();
  const [artifactId, setArtifactId] = useState("");
  const [compare, setCompare] = useState(false);
  const [message, setMessage] = useState("请选择“打开项目”，载入已有角色制作记录。此阶段不会调用 Meshy。 ");
  const [busy, setBusy] = useState(false);
  const [runningStage, setRunningStage] = useState<string>();
  const [logs, setLogs] = useState<string[]>(["客户端已就绪。付费任务需要逐次确认。"]) ;
  const [apiKey, setApiKey] = useState("");
  const [openAiApiKey, setOpenAiApiKey] = useState("");
  const [mockMode, setMockMode] = useState(false);
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logExpanded, setLogExpanded] = useState(false);
  const [runName, setRunName] = useState("");
  const [draftFront, setDraftFront] = useState<DraftFile>();
  const [draftBack, setDraftBack] = useState<DraftFile>();
  const [frontPreview, setFrontPreview] = useState("");
  const [backPreview, setBackPreview] = useState("");
  const [outputRoot, setOutputRoot] = useState("");
  const [split, setSplit] = useState(46);
  const splitHost = useRef<HTMLElement>(null);
  const runQueue = useRef<string[]>([]);
  const launchStage = useRef<(stage: string) => void>(() => undefined);
  const [importedArtifacts, setImportedArtifacts] = useState<ArtifactInfo[]>([]);
  const [customEdges, setCustomEdges] = useState<Edge[]>([]);
  const [staleNodeIds, setStaleNodeIds] = useState<string[]>([]);
  const [blenderPath, setBlenderPath] = useState("D:\\Blender\\blender.exe");
  const [uePath, setUePath] = useState("D:\\UE\\UE_5.4\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe");
  const [ueProject, setUeProject] = useState("E:\\AIEval\\Eval_Commiting\\Eval_Commiting.uproject");
  const [targetHeight, setTargetHeight] = useState(1.6);
  const [targetPolycount, setTargetPolycount] = useState(100000);
  const [rootCorrection, setRootCorrection] = useState("0,0,0");
  const [pelvisCorrection, setPelvisCorrection] = useState("0,0,0");
  const [imagePreset, setImagePreset] = useState("turnaround");
  const [imageQuality, setImageQuality] = useState("low");
  const [imageBackground, setImageBackground] = useState("opaque");
  const [imagePrompt, setImagePrompt] = useState("");
  const [comfyUrl, setComfyUrl] = useState("http://127.0.0.1:8188");
  const [comfyStatus, setComfyStatus] = useState<ComfyStatus>();
  const [environmentChecks, setEnvironmentChecks] = useState<EnvironmentCheck[]>([]);
  const [comfyPreset, setComfyPreset] = useState("turnaround");
  const [comfyPrompt, setComfyPrompt] = useState("");
  const [splitCuts, setSplitCuts] = useState<[number, number]>([0.333333, 0.666667]);
  const [splitOrder, setSplitOrder] = useState(["front", "side", "back"]);
  const [approvalFront, setApprovalFront] = useState("");
  const [approvalSide, setApprovalSide] = useState("");
  const [approvalBack, setApprovalBack] = useState("");

  useEffect(() => {
    // 简单/高级模式只是同一 Manifest 的不同投影，不复制或迁移任务状态。
    const graph = makeGraph(mode, manifest);
    const importedNodes: PipelineNode[] = mode === "advanced" ? importedArtifacts.map((artifact, index) => {
      const isImage = ["png", "jpg", "jpeg"].includes(artifact.extension);
      return { id: artifact.id, type: "pipeline", position: { x: 40 + index * 210, y: 430 }, data: isImage
        ? { title: "导入三视图", subtitle: artifact.fileName, category: "Input", description: "从本地导入的三视图图片，可连接到切分视图以跳过 AI 生成。", status: "SUCCEEDED", stageIds: [artifact.stage], output: "turnaround-sheet" }
        : { title: "导入模型", subtitle: artifact.fileName, category: "Input", description: "从本地导入的 GLB，可连接到检查、Remesh 或 Rigging。", status: "SUCCEEDED", stageIds: [artifact.stage], output: "mesh" } };
    }) : [];
    const nextNodes = [...graph.nodes, ...importedNodes].map((node) => staleNodeIds.includes(node.id) ? { ...node, data: { ...node.data, status: "STALE" as const } } : node);
    setNodes(nextNodes);
    setEdges([...graph.edges, ...customEdges]);
    setSelectedId((current) => nextNodes.some((item) => item.id === current) ? current : nextNodes[0].id);
  }, [mode, manifest, setEdges, setNodes, importedArtifacts, customEdges, staleNodeIds]);

  const selected = nodes.find((item) => item.id === selectedId) ?? nodes[0];
  const stageIds = selected?.data.stageIds ?? [];
  const allArtifacts = [...(project?.artifacts ?? []), ...importedArtifacts];
  // Walk/Run 由 Rigging 免费附带，但在美术语义上属于 Animation。将它们投影到
  // Animation 检查器即可切换 GLB 预览，无需复制文件或制造第二份阶段状态。
  const stageArtifacts = allArtifacts.filter((item) => stageIds.includes(item.stage) || (
    stageIds.includes("animation")
    && item.stage === "rigging"
    && /^result-basic-animations-(walking|running)-(glb|fbx)\.(glb|fbx)$/.test(item.fileName)
  ));
  const selectedArtifact = allArtifacts.find((item) => item.id === artifactId);
  const selectedIsImage = Boolean(selectedArtifact && ["png", "jpg", "jpeg"].includes(selectedArtifact.extension));
  const imageCandidates = allArtifacts.filter((item) => ["reference-source", "view-split"].includes(item.stage) && ["png", "jpg", "jpeg"].includes(item.extension) && item.exists);
  const turnaroundSheet = preferredArtifact(allArtifacts, ["image-turnaround"]);
  const generation = preferredArtifact(allArtifacts, ["generation"]);
  const remesh = preferredArtifact(allArtifacts, ["remesh"]);
  const animation = preferredArtifact(allArtifacts, ["animation"]);
  const normalized = preferredArtifact(allArtifacts, ["normalize"]);
  const normalizeCompare = stageIds.includes("normalize");
  const compareLeft = normalizeCompare ? animation : generation;
  const compareRight = normalizeCompare ? normalized : remesh;

  useEffect(() => {
    const preferred = preferredArtifact(allArtifacts, stageIds);
    const fallback = stageArtifacts.find((item) => item.exists);
    setArtifactId((preferred ?? fallback)?.id ?? "");
    setCompare(false);
  }, [project, selectedId, mode, importedArtifacts]);

  useEffect(() => {
    const byName = (name: string) => imageCandidates.find((item) => item.stage === "view-split" && item.fileName === `${name}.png`)?.id ?? "";
    setApprovalFront((current) => current || byName("front"));
    setApprovalSide((current) => current || byName("side"));
    setApprovalBack((current) => current || byName("back"));
  }, [project?.artifacts]);

  const acceptProject = useCallback((loaded: LoadedProject) => {
    const parsed = parseManifestV2(loaded.manifest);
    const normalize = (parsed.config as { normalize?: { height_meters?: number; root_correction_degrees?: string; pelvis_correction_degrees?: string } } | undefined)?.normalize;
    const remeshConfig = (parsed.config as { remesh?: { target_polycount?: number } } | undefined)?.remesh;
    const savedPolycount = remeshConfig?.target_polycount;
    if (Number.isInteger(savedPolycount) && savedPolycount !== undefined) setTargetPolycount(savedPolycount);
    if (normalize?.height_meters) setTargetHeight(normalize.height_meters);
    if (normalize?.root_correction_degrees) setRootCorrection(normalize.root_correction_degrees);
    if (normalize?.pelvis_correction_degrees) setPelvisCorrection(normalize.pelvis_correction_degrees);
    const image = (parsed.config as { image_turnaround?: { preset?: string; quality?: string; background?: string; prompt_extra?: string }; view_split?: { cuts?: [number, number]; order?: string[] } } | undefined);
    if (image?.image_turnaround?.preset) setImagePreset(image.image_turnaround.preset);
    if (image?.image_turnaround?.quality) setImageQuality(image.image_turnaround.quality);
    if (image?.image_turnaround?.background) setImageBackground(image.image_turnaround.background);
    setImagePrompt(image?.image_turnaround?.prompt_extra ?? "");
    if (image?.view_split?.cuts) setSplitCuts(image.view_split.cuts);
    if (image?.view_split?.order) setSplitOrder(image.view_split.order);
    setApprovalFront(""); setApprovalSide(""); setApprovalBack("");
    setProject(loaded);
    setManifest(parsed);
    return parsed;
  }, []);

  const restoreGraph = useCallback(async () => {
    const saved = await invoke<LoadedGraph>("load_project_graph");
    setImportedArtifacts(saved.artifacts);
    setCustomEdges(saved.edges.map((edge) => ({ ...edge, type: "smoothstep" })));
    setStaleNodeIds(saved.staleNodeIds);
  }, []);

  const persistGraph = useCallback((next: Edge[], nextStale: string[]) => {
    const edges: SavedGraphEdge[] = next.map(({ id, source, target }) => ({ id, source, target }));
    void invoke("save_project_graph", { edges, staleNodeIds: nextStale }).catch((reason) => setMessage(`节点图保存失败：${String(reason)}`));
  }, []);

  const refreshProject = useCallback(async () => {
    if (!project) return;
    try {
      acceptProject(await invoke<LoadedProject>("refresh_manifest"));
    } catch (reason) {
      setMessage(`刷新项目失败：${String(reason)}`);
    }
  }, [acceptProject, project]);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    listen<ProcessLine>("pipeline-event", ({ payload }) => {
      for (const line of payload.line.split(/\r?\n/).filter(Boolean)) {
        setLogs((current) => [...current.slice(-99), `${payload.stream}> ${line}`]);
        try {
          const event = JSON.parse(line) as { type?: string; stage?: string; status?: string; progress?: number; credits?: number; message?: string; code?: number | null; running?: boolean; ready?: boolean; version?: string | null; url?: string; error?: string; missingNodes?: string[]; checks?: EnvironmentCheck[] };
          if (event.stage && (event.status || event.progress !== undefined)) {
            setManifest((current) => current ? {
              ...current,
              stages: { ...current.stages, [event.stage]: { ...current.stages[event.stage], status: event.status ?? current.stages[event.stage]?.status ?? "RUNNING", progress: event.progress ?? current.stages[event.stage]?.progress } },
            } : current);
            if (event.status && completedStageStatuses.includes(event.status)) setStaleNodeIds((current) => {
              const next = current.filter((id) => id !== event.stage);
              persistGraph(customEdges, next);
              return next;
            });
          }
          if (event.type === "error") {
            runQueue.current = [];
            setLogExpanded(true);
            setMessage(`节点执行失败：${event.message ?? "未知错误"}`);
          }
          if (event.type === "check-comfy") {
            setComfyStatus({ running: Boolean(event.running), ready: Boolean(event.ready), version: event.version, missingNodes: event.missingNodes });
            setMessage(event.ready ? `ComfyUI ${event.version ?? ""} 与 TA 节点已就绪（${event.url ?? ""}）。` : event.running ? `ComfyUI 已连接，但缺少节点：${event.missingNodes?.join("、") ?? "未知"}。` : `未检测到 ComfyUI（${event.url ?? ""}）：${event.error ?? "无法连接"}。请先启动 ComfyUI，或修改本会话设置中的地址。`);
          }
          if (event.type === "doctor" && event.checks) {
            setEnvironmentChecks(event.checks);
            setMessage(`环境自检完成：${event.checks.filter((item) => item.status === "PASS").length}/${event.checks.length} 项通过。`);
          }
          if (event.type === "initialized") {
            invoke<LoadedProject>("refresh_manifest").then((loaded) => {
              const parsed = acceptProject(loaded);
              void restoreGraph();
              setMessage(`工程 ${parsed.runId} 已创建，可以从“生成三视图”开始；也可在美术确认中直接采用原图。`);
            }).catch((reason) => setMessage(`工程已创建，但自动打开失败：${String(reason)}`));
          }
          if (["process-exit", "stopped"].includes(event.type ?? "")) {
            setRunningStage(undefined);
            if (event.type === "stopped") runQueue.current = [];
            void refreshProject().finally(() => {
              const next = runQueue.current.shift();
              if (next) window.setTimeout(() => launchStage.current(next), 0);
            });
          }
        } catch {
          if (payload.stream === "stderr") { setLogExpanded(true); setMessage(`管线错误：${line}`); }
        }
      }
    }).then((unlisten) => { dispose = unlisten; });
    return () => dispose?.();
  }, [acceptProject, customEdges, persistGraph, refreshProject, restoreGraph]);

  const openProject = async () => {
    setBusy(true);
    try {
      const loaded = await invoke<LoadedProject | null>("pick_manifest");
      if (!loaded) { setMessage("已取消打开项目。"); return; }
      const parsed = acceptProject(loaded);
      await restoreGraph();
      setMessage(`已打开 ${parsed.runId}。项目状态：${parsed.status}；未执行任何付费请求。`);
    } catch (reason) {
      setMessage(`无法打开项目：${String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const importProjectPackage = async () => {
    setBusy(true);
    try {
      const loaded = await invoke<LoadedProject | null>("import_project_package");
      if (!loaded) { setMessage("已取消导入工程包。"); return; }
      const parsed = acceptProject(loaded);
      await restoreGraph();
      setMessage(`工程包已导入并打开：${parsed.runId}`);
    } catch (reason) {
      setMessage(`导入工程包失败：${String(reason)}`);
      setLogExpanded(true);
    } finally {
      setBusy(false);
    }
  };

  const exportProjectPackage = async () => {
    try {
      const path = await invoke<string | null>("export_project_package");
      setMessage(path ? `工程包已导出：${path}` : "已取消导出工程包。");
    } catch (reason) { setMessage(`导出工程包失败：${String(reason)}`); }
  };

  const exportProfile = async () => {
    try {
      const path = await invoke<string | null>("export_profile");
      setMessage(path ? `流程配置已导出：${path}` : "已取消导出流程配置。");
    } catch (reason) { setMessage(`导出流程配置失败：${String(reason)}`); }
  };

  const importProfile = async () => {
    try {
      if (!await invoke<boolean>("import_profile")) { setMessage("已取消导入流程配置。"); return; }
      acceptProject(await invoke<LoadedProject>("refresh_manifest"));
      setMessage("流程配置已应用；受影响的已有阶段已标记为需要更新。");
    } catch (reason) { setMessage(`导入流程配置失败：${String(reason)}`); }
  };

  const installComfyNodes = async () => {
    try {
      const path = await invoke<string | null>("install_comfy_nodes");
      setMessage(path ? `TA 节点已同步到 ${path}；请完整退出并重启 ComfyUI。` : "已取消安装 ComfyUI 节点。");
    } catch (reason) { setMessage(`安装 ComfyUI 节点失败：${String(reason)}`); }
  };

  const pickReference = async (slot: "front" | "back") => {
    try {
      const file = await invoke<DraftFile | null>("pick_reference", { slot });
      if (!file) return;
      const payload = await invoke<ArrayBuffer | number[]>("read_artifact", { artifactId: file.id });
      const bytes = payload instanceof ArrayBuffer ? payload : new Uint8Array(payload).buffer;
      const url = URL.createObjectURL(new Blob([bytes]));
      if (slot === "front") { if (frontPreview) URL.revokeObjectURL(frontPreview); setDraftFront(file); setFrontPreview(url); }
      else { if (backPreview) URL.revokeObjectURL(backPreview); setDraftBack(file); setBackPreview(url); }
    } catch (reason) { setMessage(`参考图读取失败：${String(reason)}`); }
  };

  const pickOutputRoot = async () => {
    try {
      const folder = await invoke<string | null>("pick_output_root");
      if (folder) setOutputRoot(folder);
    } catch (reason) { setMessage(`输出目录选择失败：${String(reason)}`); }
  };

  const createProject = async () => {
    if (!draftFront || !outputRoot || !runName.trim()) { setMessage("请至少选择一张参考图，并填写工程名称和保存位置。"); return; }
    try {
      await invoke("start_pipeline", { operation: "init", stage: null, runName, confirmSpend: false, apiKey: null, mock: false, inputArtifactId: null });
      setRunningStage("init");
      setCreating(false);
      setMessage("正在创建工程和 Manifest…");
    } catch (reason) { setMessage(`创建工程失败：${String(reason)}`); }
  };

  const resizeSplit = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!splitHost.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = splitHost.current.getBoundingClientRect();
    const move = (next: PointerEvent) => setSplit(Math.min(75, Math.max(25, ((next.clientX - rect.left) / rect.width) * 100)));
    const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };

  const importMesh = async () => {
    try {
      const artifact = await invoke<ArtifactInfo | null>("import_mesh");
      if (!artifact) return;
      setImportedArtifacts((current) => [...current, artifact]);
      setMode("advanced");
      setSelectedId(artifact.id);
      setArtifactId(artifact.id);
      setMessage(`${artifact.fileName} 已导入。请将它连接到网格检查、Remesh 或 Rigging。`);
    } catch (reason) { setMessage(`导入模型失败：${String(reason)}`); }
  };

  const importTurnaround = async () => {
    try {
      const artifact = await invoke<ArtifactInfo | null>("import_image");
      if (!artifact) return;
      setImportedArtifacts((current) => [...current, artifact]);
      setMode("advanced");
      setSelectedId(artifact.id);
      setArtifactId(artifact.id);
      setMessage(`${artifact.fileName} 已导入。请将它连接到切分视图，即可从切分步骤继续。`);
    } catch (reason) { setMessage(`导入三视图失败：${String(reason)}`); }
  };

  const connectNodes = (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const source = nodes.find((item) => item.id === connection.source);
    const target = nodes.find((item) => item.id === connection.target);
    const accepted = Array.isArray(target?.data.input) ? target.data.input : target?.data.input ? [target.data.input] : [];
    if (!source?.data.output || !accepted.includes(source.data.output)) {
      setMessage(`连接不兼容：${source?.data.output ?? "无输出"} 不能连接到 ${target?.data.input ?? "无输入"}。`);
      return;
    }
    const adjacency = new Map<string, string[]>();
    for (const edge of edges) adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target]);
    const pending = [connection.target];
    const visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === connection.source) { setMessage("连接被拒绝：节点图不能形成循环。"); return; }
      if (visited.has(id)) continue;
      visited.add(id);
      pending.push(...(adjacency.get(id) ?? []));
    }
    const edge = { ...connection, id: `custom-${connection.source}-${connection.target}`, type: "smoothstep" } as Edge;
    const nextEdges = [...customEdges.filter((item) => item.target !== connection.target), edge];
    setCustomEdges(nextEdges);
    const nextStale = [...new Set([...staleNodeIds, ...visited])];
    persistGraph(nextEdges, nextStale);
    setEdges((current) => addEdge(edge, current.filter((item) => !item.id.startsWith("custom-") || item.target !== connection.target)));
    setStaleNodeIds(nextStale);
    setMessage(`已连接 ${source.data.title} → ${target.data.title}；目标及后续结果需要重新运行。`);
  };

  const changeEdges = (changes: EdgeChange[]) => {
    const removed = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id));
    if (removed.size) setCustomEdges((current) => {
      const next = current.filter((edge) => !removed.has(edge.id));
      persistGraph(next, staleNodeIds);
      return next;
    });
    onEdgesChange(changes);
  };

  const approveReferenceSelection = async () => {
    if (runningStage || !approvalFront || !approvalBack) { setMessage("请先为正面和背面各选择一张图片。"); return; }
    try {
      await invoke("start_pipeline", { operation: "approve-references", stage: null, runName: null, confirmSpend: false, apiKey: null, openaiApiKey: null, mock: false, inputArtifactId: null, blenderPath: null, uePath: null, ueProject: null, targetHeight: null, rootCorrection: null, pelvisCorrection: null, referenceFrontId: approvalFront, referenceSideId: approvalSide || null, referenceBackId: approvalBack, imagePreset: null, imageQuality: null, imageBackground: null, imagePrompt: null });
      setRunningStage("reference-approval"); setMessage("正在保存美术确认结果；原图不会被覆盖。");
    } catch (reason) { setMessage(`无法确认参考图：${String(reason)}`); }
  };

  const runPipeline = async (operation: "execute" | "resume" | "skip" | "check", stage?: string) => {
    // 确认只对本次 IPC 调用有效；Key 由 Rust 放入 sidecar 环境变量，不进入命令行或 Manifest。
    if (runningStage) return;
    if (stage === "reference-approval") { await approveReferenceSelection(); return; }
    if (stage === "remesh" && (!Number.isInteger(targetPolycount) || targetPolycount < 100 || targetPolycount > 300000)) {
      setMessage("Remesh 目标面数必须是 100 到 300,000 之间的整数。");
      return;
    }
    let confirmed = false;
    const inputArtifactId = stage ? edges.find((edge) => edge.target === stage && edge.source.startsWith("imported:"))?.source : undefined;
    if (operation === "execute" && stage && paidStages.includes(stage) && !mockMode) {
      const configKey = stage === "comfy-prep" ? "comfy" : stage;
      const savedParameters = (manifest as { config?: Record<string, unknown> } | undefined)?.config?.[configKey] ?? {};
      const parameters = JSON.stringify(stage === "comfy-prep" ? { ...(savedParameters as object), preset: comfyPreset, promptExtra: comfyPrompt } : stage === "remesh" ? { ...(savedParameters as object), target_polycount: targetPolycount } : savedParameters, null, 2);
      const cost = stage === "image-turnaround" ? `OpenAI GPT Image 2 · ${imageQuality === "low" ? "低质量草稿，预计约 $0.02–$0.10" : "中质量，预计约 $0.05–$0.25"}（含参考图输入后以实际用量为准）` : stage === "comfy-prep" ? "ComfyUI 将调用 OpenRouter GPT-5.4 Image 2 · Low · 21:9；费用以 OpenRouter 实际记录为准，提交后不会自动重试" : `预计最多消耗约 ${creditEstimate[stage]} Meshy credits`;
      confirmed = await confirmDialog(`${stageLabels[stage]} 将检查输入与参数。完全一致时复用已有结果；输入或参数变化时可能创建新的付费请求。\n${cost}。\n\n参数：\n${parameters}\n\n确认后才允许发送 POST 请求。`, {
        title: "确认付费请求",
        kind: "warning",
      });
      if (!confirmed) { runQueue.current = []; setMessage("已取消，未创建任务、未消耗 credits。"); return; }
    }
    try {
      if (stage === "view-split" && operation === "execute") await invoke("set_view_split", { cuts: splitCuts, order: splitOrder });
      await invoke("start_pipeline", {
        operation,
        stage: stage ?? null,
        runName: null,
        confirmSpend: confirmed === true,
        apiKey: apiKey.trim() || null,
        openaiApiKey: openAiApiKey.trim() || null,
        mock: mockMode,
        inputArtifactId: inputArtifactId ?? null,
        blenderPath,
        uePath,
        ueProject,
        targetHeight,
        targetPolycount,
        rootCorrection,
        pelvisCorrection,
        referenceFrontId: null,
        referenceSideId: null,
        referenceBackId: null,
        imagePreset,
        imageQuality,
        imageBackground,
        imagePrompt,
        comfyUrl: comfyUrl.trim() || null,
        comfyPreset,
        comfyPrompt,
      });
      setRunningStage(stage ?? "check");
      setMessage(operation === "check" ? "正在执行只读权限检查…" : operation === "skip" ? "正在记录跳过 Blender 质检…" : `${stageLabels[stage ?? ""]} 已启动；task ID 会立即写入 Manifest。`);
    } catch (reason) {
      runQueue.current = [];
      setLogExpanded(true);
      setMessage(`无法启动节点：${String(reason)}`);
    }
  };
  launchStage.current = (stage) => { void runPipeline("execute", stage); };

  const skipNormalize = async () => {
    if (runningStage) return;
    const accepted = await confirmDialog("将跳过 Blender Normalize，并直接使用 Meshy 原始 FBX 进入 UE。法线、权重、骨骼命名、身高和动画循环不会被本地质检，最终状态将标记为 WARNING。", {
      title: "无 Blender 兼容模式",
      kind: "warning",
    });
    if (accepted) await runPipeline("skip", "normalize");
  };

  const checkComfy = async () => {
    if (runningStage) return;
    try {
      await invoke("start_pipeline", { operation: "check-comfy", stage: null, runName: null, confirmSpend: false, apiKey: null, openaiApiKey: null, mock: false, inputArtifactId: null, blenderPath: null, uePath: null, ueProject: null, targetHeight: null, rootCorrection: null, pelvisCorrection: null, referenceFrontId: null, referenceSideId: null, referenceBackId: null, imagePreset: null, imageQuality: null, imageBackground: null, imagePrompt: null, comfyUrl: comfyUrl.trim() || null, comfyPreset: null, comfyPrompt: null });
      setRunningStage("check-comfy");
      setMessage("正在检测本地 ComfyUI 服务…");
    } catch (reason) { setMessage(`无法检测 ComfyUI：${String(reason)}`); }
  };

  const diagnoseEnvironment = async () => {
    if (runningStage) return;
    try {
      await invoke("start_pipeline", { operation: "doctor", stage: null, runName: null, confirmSpend: false, apiKey: null, openaiApiKey: null, mock: false, inputArtifactId: null, blenderPath, uePath, ueProject, targetHeight: null, rootCorrection: null, pelvisCorrection: null, referenceFrontId: null, referenceSideId: null, referenceBackId: null, imagePreset: null, imageQuality: null, imageBackground: null, imagePrompt: null, comfyUrl: comfyUrl.trim() || null, comfyPreset: null, comfyPrompt: null });
      setRunningStage("doctor");
      setMessage("正在检查运行时、ComfyUI、Blender 与 Unreal…");
    } catch (reason) { setMessage(`无法启动环境自检：${String(reason)}`); }
  };

  const runFromHere = () => {
    if (!actionStage) return;
    const base = manifest?.stages["reference-source"] ? executableStages : legacyExecutableStages;
    const linear = base.filter((id) => id !== "comfy-prep");
    const workflow = actionStage === "comfy-prep" ? ["comfy-prep", ...linear.slice(linear.indexOf("view-split"))] : linear;
    const start = workflow.indexOf(actionStage);
    let pending = workflow.slice(start).filter((id, index) => index === 0 || staleNodeIds.includes(id) || !completedStageStatuses.includes(manifest?.stages[id]?.status ?? ""));
    const review = pending.indexOf("reference-approval");
    if (review > 0) pending = pending.slice(0, review);
    const [first, ...rest] = pending;
    if (!first) { setMessage("从此节点开始的流程已经完成。"); return; }
    runQueue.current = rest;
    if (review > 0) setMessage("将运行到参考图切分；随后停下等待美术确认。");
    void runPipeline("execute", first);
  };

  const stopPipeline = async () => {
    try {
      const stopped = await invoke<boolean>("stop_pipeline");
      if (!stopped) setMessage("当前没有正在运行的本地任务。");
    } catch (reason) {
      setMessage(`停止失败：${String(reason)}`);
    }
  };

  const openUE = async () => {
    try {
      await invoke("open_ue_project", { uePath, ueProject });
      setMessage("正在打开 Unreal 工程；生成资产位于 /Game/Generated/<runId>/。");
    } catch (reason) { setMessage(`无法打开 Unreal 工程：${String(reason)}`); }
  };

  const artifactAction = async (command: "export_artifact" | "reveal_artifact") => {
    if (!selectedArtifact) return;
    try {
      const result = await invoke<boolean | void>(command, { artifactId: selectedArtifact.id });
      setMessage(command === "export_artifact" && result === false ? "已取消导出。" : command === "export_artifact" ? `已导出 ${selectedArtifact.fileName}` : `已在资源管理器中定位 ${selectedArtifact.fileName}`);
    } catch (reason) {
      setMessage(`操作失败：${String(reason)}`);
    }
  };

  const stages = stageIds.map((id) => ({ id, value: manifest?.stages[id] }));
  const activeStages = stages.filter((item) => item.value);
  const credits = stages.reduce((sum, item) => sum + (item.value?.consumedCredits ?? 0), 0);
  const taskIds = stages.map((item) => item.value?.taskId).filter(Boolean).join(" / ") || "—";
  const progress = activeStages.length ? Math.min(...activeStages.map((item) => item.value?.progress ?? 0)) : 0;
  const currentStage = stages.length === 1 ? stages[0].value : undefined;
  const startedAt = activeStages.map((item) => item.value?.startedAt).filter((value): value is number | string => value !== undefined).map((value) => new Date(value).getTime());
  const finishedAt = activeStages.map((item) => item.value?.finishedAt).filter((value): value is number | string => value !== undefined).map((value) => new Date(value).getTime());
  const visibleError = currentStage?.error ?? activeStages.find((item) => item.value?.error)?.value?.error;
  const qualityReport = currentStage?.report as { status?: string; metrics?: Record<string, number>; warnings?: string[] } | undefined;
  const workflowStages = manifest?.stages["reference-source"] ? executableStages : legacyExecutableStages;
  const selectedExecutable = stageIds.filter((id) => workflowStages.includes(id) && Boolean(manifest?.stages[id]));
  const actionStage = selectedExecutable.find((id) => !completedStageStatuses.includes(manifest?.stages[id]?.status ?? "")) ?? selectedExecutable.at(-1);
  const actionManifestStage = actionStage ? manifest?.stages[actionStage] : undefined;
  const actionFinished = completedStageStatuses.includes(actionManifestStage?.status ?? "") && !staleNodeIds.includes(actionStage ?? "");
  const actionLabel = actionStage === "image-turnaround" ? "生成三视图" : actionStage === "comfy-prep" ? "在 Comfy 准备参考图" : actionStage === "view-split" ? "保存切分结果" : actionStage === "reference-approval" ? "确认采用视图" : actionStage === "normalize" && actionManifestStage?.status === "SKIPPED" ? "运行 Blender 完整质检" : actionFinished ? "检查并复用" : "运行当前节点";

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div className="brand"><p className="eyebrow">角色资产工作台</p><h1>TA Character Studio</h1></div>
        <div className="project-summary" aria-live="polite">
          <span className={`node-status-dot status-${(manifest?.status ?? "not_started").toLowerCase()}`} />
          <span>{manifest ? manifest.runId : "尚未打开工程"}</span>
          {manifest && <small>{statusLabels[manifest.status] ?? manifest.status}</small>}
        </div>
        <div className="top-actions">
          <button onClick={() => setCreating(true)} disabled={Boolean(runningStage)}>新建项目</button>
          <button className="primary" onClick={openProject} disabled={busy}>{busy ? "正在打开…" : "打开项目"}</button>
        </div>
      </header>

      {creating && <div className="modal-backdrop" role="presentation">
        <section className="new-project-dialog" role="dialog" aria-modal="true" aria-labelledby="new-project-title">
          <div className="dialog-heading"><div><p className="eyebrow">NEW CHARACTER</p><h2 id="new-project-title">从参考图创建工程</h2></div><button onClick={() => setCreating(false)} aria-label="关闭">×</button></div>
          <div className="reference-grid">
            <button className="reference-picker" onClick={() => pickReference("front")}>{frontPreview ? <img src={frontPreview} alt="主参考图" /> : <span>选择主参考图（必需）</span>}<small>{draftFront?.fileName ?? "Reference 1 · PNG/JPG"}</small></button>
            <button className="reference-picker" onClick={() => pickReference("back")}>{backPreview ? <img src={backPreview} alt="补充参考图" /> : <span>添加补充参考图（可选）</span>}<small>{draftBack?.fileName ?? "Reference 2 · PNG/JPG"}</small></button>
          </div>
          <label className="field-label">工程名称</label><input value={runName} onChange={(event) => setRunName(event.target.value)} placeholder="例如 stylized-character-01" />
          <label className="field-label">保存位置</label><button className="folder-picker" onClick={pickOutputRoot}>{outputRoot || "选择工程根目录…"}</button>
          <p className="dialog-note">这里只创建本地 Manifest 和原图副本，不会连接 OpenAI、Meshy 或消耗费用。</p>
          <div className="dialog-actions"><button onClick={() => setCreating(false)}>取消</button><button className="primary" onClick={createProject} disabled={!draftFront || !outputRoot || !runName.trim()}>创建并打开</button></div>
        </section>
      </div>}

      {settingsOpen && <div className="modal-backdrop" role="presentation">
        <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div className="dialog-heading"><div><p className="eyebrow">本次会话</p><h2 id="settings-title">工具与服务设置</h2></div><button onClick={() => setSettingsOpen(false)} aria-label="关闭">×</button></div>
          <p className="dialog-note">密钥只保存在当前会话，不会写入工程、日志或 Git。</p>
          <div className="settings-fields">
            <label><span>Meshy API Key</span><input className="key-input" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="留空则读取环境变量" autoComplete="off" /></label>
            <label><span>OpenAI API Key</span><input className="key-input" type="password" value={openAiApiKey} onChange={(event) => setOpenAiApiKey(event.target.value)} placeholder="留空则读取 OPENAI_API_KEY" autoComplete="off" /></label>
            <label><span>ComfyUI 地址</span><input className="key-input" value={comfyUrl} onChange={(event) => setComfyUrl(event.target.value)} placeholder="http://127.0.0.1:8188" /></label>
            <div className="settings-wide dialog-note">服务：{comfyStatus?.running ? "已连接" : "未确认"}　TA 节点：{comfyStatus?.ready ? "已安装" : comfyStatus?.running ? `缺少 ${comfyStatus.missingNodes?.join("、")}` : "未确认"}　OpenRouter Key：由 Comfy 进程管理</div>
            <label><span>Blender</span><input className="key-input" value={blenderPath} onChange={(event) => setBlenderPath(event.target.value)} /></label>
            <label><span>UnrealEditor-Cmd</span><input className="key-input" value={uePath} onChange={(event) => setUePath(event.target.value)} /></label>
            <label className="settings-wide"><span>UE 工程</span><input className="key-input" value={ueProject} onChange={(event) => setUeProject(event.target.value)} /></label>
          </div>
          {environmentChecks.length > 0 && <div className="environment-checks" aria-label="环境自检结果">
            {environmentChecks.map((item) => <div key={item.id} className={`environment-check status-${item.status.toLowerCase()}`}><strong>{item.label}</strong><span>{item.status}</span><small title={item.message}>{item.message}</small></div>)}
          </div>}
          <div className="dialog-actions portable-actions">
            <button onClick={installComfyNodes} disabled={Boolean(runningStage)}>安装 / 更新 Comfy 节点</button>
            <button onClick={importProjectPackage} disabled={Boolean(runningStage) || busy}>导入工程包</button>
            <button onClick={exportProjectPackage} disabled={!manifest || Boolean(runningStage)}>导出工程包</button>
            <button onClick={importProfile} disabled={!manifest || Boolean(runningStage)}>导入流程配置</button>
            <button onClick={exportProfile} disabled={!manifest || Boolean(runningStage)}>导出流程配置</button>
          </div>
          <label className="mock-toggle"><input type="checkbox" checked={mockMode} onChange={(event) => setMockMode(event.target.checked)} disabled={Boolean(runningStage)} /> 离线模拟，不连接 Meshy、OpenAI 或 OpenRouter</label>
          <div className="dialog-actions"><button onClick={diagnoseEnvironment} disabled={Boolean(runningStage)}>一键环境自检</button><button onClick={() => runPipeline("check")} disabled={Boolean(runningStage)}>只读权限检查</button><button onClick={checkComfy} disabled={Boolean(runningStage)}>检测 ComfyUI</button><button className="primary" onClick={() => setSettingsOpen(false)}>完成</button></div>
        </section>
      </div>}

      <section className="workspace">
        <aside className="node-library panel">
          <div className="mode-switch" role="group" aria-label="节点显示模式">
            <button className={mode === "simple" ? "active" : ""} onClick={() => setMode("simple")}>简单模式</button>
            <button className={mode === "advanced" ? "active" : ""} onClick={() => setMode("advanced")}>高级节点</button>
          </div>
          <div className="panel-title"><span>制作步骤</span><b>{nodes.length} 步</b></div>
          {mode === "advanced" && <div className="import-actions"><button className="import-button" onClick={importMesh}>＋ 导入本地 GLB</button><button className="import-button" onClick={importTurnaround}>＋ 导入三视图</button></div>}
          {nodes.map((item) => <button key={item.id} className={`library-item ${item.id === selectedId ? "active" : ""}`} onClick={() => setSelectedId(item.id)}>
            <span>{item.data.title}<small>{item.data.subtitle}</small></span><i className={`status-pill status-${item.data.status.toLowerCase()}`}>{statusLabels[item.data.status] ?? item.data.status}</i>
          </button>)}
          <button className="settings-button" onClick={() => setSettingsOpen(true)}>设置与服务</button>
        </aside>

        <section className="center-workspace" ref={splitHost} style={{ gridTemplateColumns: `${split}fr 6px ${100 - split}fr` }}>
          <section className="graph-panel" aria-label="角色制作节点图">
            <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={changeEdges} onConnect={connectNodes} onNodeClick={(_, item) => setSelectedId(item.id)} fitView fitViewOptions={{ padding: 0.16 }} minZoom={0.35} maxZoom={1.6} nodesConnectable={mode === "advanced"} deleteKeyCode="Delete">
              <Background color="#d5d0c7" gap={24} size={1} /><MiniMap pannable zoomable nodeColor="#9ca6b5" maskColor="rgba(243, 240, 233, 0.78)" /><Controls showInteractive={false} />
            </ReactFlow>
          </section>
          <div className="split-handle" role="separator" aria-label="调整节点图和预览比例" aria-orientation="vertical" tabIndex={0} onPointerDown={resizeSplit} />
          <section className={`preview-panel ${compare ? "compare" : ""}`}>
            <div className="preview-toolbar"><strong>资产预览</strong><button onClick={() => setCompare((value) => !value)} disabled={!compareLeft || !compareRight}>{compare ? "退出对比" : normalizeCompare ? "校正前 / 后对比" : "生成 / 优化对比"}</button></div>
            {compare ? <><ModelViewport artifact={compareLeft} label={normalizeCompare ? "校正前 / Animation" : "生成模型 / Generation"} /><ModelViewport artifact={compareRight} label={normalizeCompare ? "校正后 / Normalize" : "优化模型 / Remesh"} /></> : actionStage === "reference-approval" && imageCandidates.length ? <div className="review-grid">{imageCandidates.map((item) => <ImageViewport key={item.id} artifact={item} label={`${item.stage === "reference-source" ? "原图" : "切分"} · ${item.fileName}`} />)}</div> : actionStage === "view-split" ? <ImageViewport artifact={turnaroundSheet} cuts={splitCuts} onCutsChange={setSplitCuts} label="拖动蓝线调整切分" /> : selectedIsImage ? <ImageViewport artifact={selectedArtifact} /> : <ModelViewport artifact={selectedArtifact} />}
          </section>
        </section>

        <aside className="inspector panel">
          <div className="inspector-heading">
            <div><p className="eyebrow">{selected?.data.subtitle}</p><h2>{selected?.data.title}</h2></div>
            <span className={`status-badge status-${selected?.data.status.toLowerCase()}`}>{statusLabels[selected?.data.status ?? "NOT_STARTED"]}</span>
          </div>
          <p className="description">{selected?.data.description}</p>
          {visibleError && <div className="error-callout" role="alert"><strong>需要处理</strong><span>{errorSummary(visibleError)}</span></div>}
          {qualityReport && <div className={`quality-summary quality-${qualityReport.status?.toLowerCase() ?? "warning"}`}>
            <strong>质量门禁：{qualityReport.status ?? "UNKNOWN"}</strong>
            {qualityReport.metrics && <small>{qualityReport.metrics.triangles?.toLocaleString()} 三角面 · {qualityReport.metrics.bones} 骨骼 · {qualityReport.metrics.heightMeters} m · {qualityReport.metrics.animations} 动画</small>}
            {qualityReport.warnings?.map((warning) => <small key={warning}>{warning}</small>)}
          </div>}
          {actionStage === "image-turnaround" && <section className="task-controls">
            <h3>生成设置</h3>
            <label className="field-label">处理预设</label><select value={imagePreset} onChange={(event) => setImagePreset(event.target.value)}><option value="turnaround">生成完整三视图</option><option value="complete-views">补全缺失视图</option><option value="clean-pose">统一背景与站姿</option></select>
            <label className="field-label">输出质量</label><select value={imageQuality} onChange={(event) => setImageQuality(event.target.value)}><option value="low">草稿 · Low</option><option value="medium">最终参考 · Medium</option></select>
            <label className="field-label">背景</label><select value={imageBackground} onChange={(event) => setImageBackground(event.target.value)}><option value="opaque">纯色背景</option><option value="transparent">透明背景（Preview）</option><option value="auto">自动</option></select>
            <label className="field-label">补充美术要求</label><textarea className="key-input" rows={3} maxLength={1000} value={imagePrompt} onChange={(event) => setImagePrompt(event.target.value)} placeholder="例如：保持斗篷长度、鞋底造型和发饰不变" />
          </section>}
          {actionStage === "comfy-prep" && <section className="task-controls">
            <h3>Comfy 参考图准备 <small>调用 OpenRouter，执行前逐次确认费用</small></h3>
            <label className="field-label">工作流</label><input className="key-input" value="TAOpenRouterTurnaround" disabled />
            <label className="field-label">艺术预设</label><select value={comfyPreset} onChange={(event) => setComfyPreset(event.target.value)}><option value="turnaround">三视图（Turnaround）</option><option value="style-unify">风格统一（Style Unify）</option></select>
            <label className="field-label">ComfyUI 地址</label><input className="key-input" value={comfyUrl} onChange={(event) => setComfyUrl(event.target.value)} placeholder="http://127.0.0.1:8188" />
            <label className="field-label">补充美术要求</label><textarea className="key-input" rows={3} maxLength={1000} value={comfyPrompt} onChange={(event) => setComfyPrompt(event.target.value)} placeholder="例如：统一为手绘水彩风格，保持斗篷长度不变" />
          </section>}
          {actionStage === "view-split" && <section className="task-controls">
            <h3>本地切分 <small>不消耗 API</small></h3>
            <label>左分隔线 {Math.round(splitCuts[0] * 100)}%<input type="range" min="15" max="55" value={splitCuts[0] * 100} onChange={(event) => setSplitCuts([Math.min(Number(event.target.value) / 100, splitCuts[1] - 0.11), splitCuts[1]])} /></label>
            <label>右分隔线 {Math.round(splitCuts[1] * 100)}%<input type="range" min="45" max="85" value={splitCuts[1] * 100} onChange={(event) => setSplitCuts([splitCuts[0], Math.max(Number(event.target.value) / 100, splitCuts[0] + 0.11)])} /></label>
            {[0, 1, 2].map((index) => <select key={index} value={splitOrder[index]} onChange={(event) => { const next = [...splitOrder]; const other = next.indexOf(event.target.value); [next[index], next[other]] = [next[other], next[index]]; setSplitOrder(next); }}>{["front", "side", "back"].map((name) => <option key={name} value={name}>{index + 1} 区域：{{ front: "正面", side: "侧面", back: "背面" }[name]}</option>)}</select>)}
          </section>}
          {actionStage === "reference-approval" && <section className="task-controls">
            <h3>采用视图</h3><small>正面和背面为必需，可采用 AI 切分图或原图。</small>
            {[{ label: "正面", value: approvalFront, set: setApprovalFront }, { label: "侧面", value: approvalSide, set: setApprovalSide }, { label: "背面", value: approvalBack, set: setApprovalBack }].map((choice) => <label className="reference-choice" key={choice.label}><span>{choice.label}</span><select value={choice.value} onChange={(event) => choice.set(event.target.value)}><option value="">{choice.label === "侧面" ? "不采用" : "请选择"}</option>{imageCandidates.map((item) => <option key={item.id} value={item.id}>{item.stage === "reference-source" ? "原图" : "切分"} · {item.fileName}</option>)}</select></label>)}
          </section>}
          {actionStage === "remesh" && <section className="task-controls">
            <h3>减面设置</h3>
            <label className="field-label">目标面数</label><input className="key-input" type="number" min="100" max="300000" step="1000" value={targetPolycount} onChange={(event) => setTargetPolycount(Number(event.target.value))} />
            <small>允许 100–300,000；实际结果可能因模型结构略有偏差。</small>
          </section>}
          {stageIds.includes("normalize") && <section className="task-controls">
            <h3>交付规格</h3>
            <label className="field-label">目标身高（米）</label><input className="key-input" type="number" min="0.5" max="3" step="0.01" value={targetHeight} onChange={(event) => setTargetHeight(Number(event.target.value))} />
            <label className="field-label">Root 旋转 X,Y,Z</label><input className="key-input" value={rootCorrection} onChange={(event) => setRootCorrection(event.target.value)} />
            <label className="field-label">Pelvis 旋转 X,Y,Z</label><input className="key-input" value={pelvisCorrection} onChange={(event) => setPelvisCorrection(event.target.value)} />
            {actionManifestStage?.status === "SKIPPED"
              ? <small>兼容模式：Blender 质检未运行，UE 将使用 Meshy 原始 FBX，最终结果只能标记为需检查。</small>
              : <button className="wide" onClick={skipNormalize} disabled={!manifest || Boolean(runningStage)}>无 Blender，跳过质检</button>}
          </section>}

          <section className="primary-task">
            <button className="primary wide" onClick={() => actionStage && runPipeline("execute", actionStage)} disabled={!manifest || !actionStage || Boolean(runningStage)}>{actionLabel}</button>
            <p>{actionStage ? `${stageLabels[actionStage]} · ${actionFinished ? "已有结果可复用" : "准备执行"}` : "打开工程后可执行当前步骤"}</p>
          </section>

          <section className="artifact-section">
            <div className="section-heading"><h3>当前产物</h3><span>{stageArtifacts.length}</span></div>
            <select value={artifactId} onChange={(event) => setArtifactId(event.target.value)} disabled={!stageArtifacts.length}>
              {!stageArtifacts.length && <option>暂无产物</option>}
              {stageArtifacts.map((item) => <option key={item.id} value={item.id}>{artifactLabel(item)}{item.exists ? "" : "（缺失）"}</option>)}
            </select>
            {selectedArtifact && <p className="artifact-summary">{selectedArtifact.extension.toUpperCase()} · {formatBytes(selectedArtifact.bytes)}{selectedArtifact.previewable ? " · 正在预览" : " · 仅可导出"}</p>}
            <div className="artifact-actions"><button onClick={() => artifactAction("export_artifact")} disabled={!selectedArtifact?.exists}>导出</button><button onClick={() => artifactAction("reveal_artifact")} disabled={!selectedArtifact?.exists}>打开目录</button></div>
          </section>

          <details className="detail-section"><summary>更多运行操作</summary><div className="node-actions">
            <button onClick={runFromHere} disabled={!manifest || !actionStage || Boolean(runningStage)}>从这里运行</button>
            <button onClick={() => actionStage && runPipeline("resume", actionStage)} disabled={!actionManifestStage?.taskId || actionFinished || Boolean(runningStage)}>恢复</button>
            <button onClick={stopPipeline} disabled={!runningStage}>停止</button>
          </div></details>
          {stageIds.includes("ue-import") && <button className="wide" onClick={openUE}>打开 UE 工程</button>}
          <details className="detail-section"><summary>运行详情</summary>
            <dl><div><dt>进度</dt><dd>{progress}%</dd></div><div><dt>消耗</dt><dd>{credits} credits</dd></div><div><dt>开始</dt><dd>{formatDate(startedAt.length ? Math.min(...startedAt) : undefined)}</dd></div><div><dt>结束</dt><dd>{formatDate(finishedAt.length ? Math.max(...finishedAt) : undefined)}</dd></div><div><dt>Task ID</dt><dd>{taskIds}</dd></div></dl>
            {selectedArtifact && <dl className="artifact-meta"><div><dt>SHA-256</dt><dd title={selectedArtifact.sha256}>{selectedArtifact.sha256?.slice(0, 12) ?? "—"}</dd></div></dl>}
          </details>
          <details className="detail-section"><summary>技术信息</summary>
            <dl><div><dt>Manifest</dt><dd title={project?.manifestPath}>{project?.manifestPath ?? "—"}</dd></div></dl>
            <pre>{manifest ? JSON.stringify(stages.length === 1 ? currentStage : stages, null, 2) : "尚未打开项目"}</pre>
          </details>
        </aside>
      </section>

      <section className={`log-drawer ${logExpanded ? "expanded" : ""}`}>
        <button className="log-summary" onClick={() => setLogExpanded((value) => !value)} aria-expanded={logExpanded}>
          <span><i className={`ready-dot ${runningStage ? "is-running" : ""}`} />{runningStage ? `${stageLabels[runningStage] ?? runningStage} 进行中` : "本地就绪"}</span>
          <strong aria-live="polite">{message}</strong><small>{logExpanded ? "收起日志" : "查看日志"}</small>
        </button>
        {logExpanded && <div className="log-content"><div className="log-lines">{logs.slice(-30).map((line, index) => <code key={`${index}-${line}`}>{line}</code>)}</div><p>OpenAI / Meshy 付费请求仍需逐次确认。</p></div>}
      </section>
    </main>
  );
}

export default App;
