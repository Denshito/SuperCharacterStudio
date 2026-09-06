import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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

const nodeTypes = { pipeline: PipelineNodeCard };
const preferredNames: Record<string, string> = {
  "image-turnaround": "turnaround.png",
  "view-split": "front.png",
  "reference-approval": "front.png",
  generation: "model-urls-glb.glb",
  remesh: "model-urls-glb.glb",
  rigging: "result-rigged-character-glb.glb",
  animation: "result-animation-glb.glb",
  normalize: "normalized-character.glb",
};
const paidStages = ["image-turnaround", "generation", "remesh", "rigging", "animation"];
const executableStages = ["image-turnaround", "view-split", "reference-approval", "generation", "remesh", "rigging", "animation", "normalize", "ue-import"];
const legacyExecutableStages = ["generation", "remesh", "rigging", "animation", "normalize", "ue-import"];
const creditEstimate: Record<string, number> = { generation: 30, remesh: 5, rigging: 5, animation: 3 };
const stageLabels: Record<string, string> = { "image-turnaround": "生成三视图", "view-split": "切分视图", "reference-approval": "美术确认", generation: "生成模型", remesh: "减面优化", rigging: "骨骼绑定", animation: "角色动画", normalize: "规格统一", "ue-import": "导入 UE" };
interface ProcessLine { stream: string; line: string; }

function preferredArtifact(artifacts: ArtifactInfo[], stages: string[]): ArtifactInfo | undefined {
  const candidates = artifacts.filter((item) => stages.includes(item.stage) && item.previewable);
  return candidates.find((item) => item.fileName === preferredNames[item.stage]) ?? candidates[0];
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
  const [runName, setRunName] = useState("");
  const [draftFront, setDraftFront] = useState<DraftFile>();
  const [draftBack, setDraftBack] = useState<DraftFile>();
  const [frontPreview, setFrontPreview] = useState("");
  const [backPreview, setBackPreview] = useState("");
  const [outputRoot, setOutputRoot] = useState("");
  const [split, setSplit] = useState(55);
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
  const [rootCorrection, setRootCorrection] = useState("0,0,0");
  const [pelvisCorrection, setPelvisCorrection] = useState("0,0,0");
  const [imagePreset, setImagePreset] = useState("turnaround");
  const [imageQuality, setImageQuality] = useState("low");
  const [imageBackground, setImageBackground] = useState("opaque");
  const [imagePrompt, setImagePrompt] = useState("");
  const [splitCuts, setSplitCuts] = useState<[number, number]>([0.333333, 0.666667]);
  const [splitOrder, setSplitOrder] = useState(["front", "side", "back"]);
  const [approvalFront, setApprovalFront] = useState("");
  const [approvalSide, setApprovalSide] = useState("");
  const [approvalBack, setApprovalBack] = useState("");

  useEffect(() => {
    const graph = makeGraph(mode, manifest);
    const importedNodes: PipelineNode[] = mode === "advanced" ? importedArtifacts.map((artifact, index) => ({ id: artifact.id, type: "pipeline", position: { x: 40 + index * 210, y: 430 }, data: { title: "导入模型", subtitle: artifact.fileName, category: "Input", description: "从本地导入的 GLB，可连接到检查、Remesh 或 Rigging。", status: "SUCCEEDED", stageIds: [artifact.stage], output: "mesh" } })) : [];
    const nextNodes = [...graph.nodes, ...importedNodes].map((node) => staleNodeIds.includes(node.id) ? { ...node, data: { ...node.data, status: "STALE" as const } } : node);
    setNodes(nextNodes);
    setEdges([...graph.edges, ...customEdges]);
    setSelectedId((current) => nextNodes.some((item) => item.id === current) ? current : nextNodes[0].id);
  }, [mode, manifest, setEdges, setNodes, importedArtifacts, customEdges, staleNodeIds]);

  const selected = nodes.find((item) => item.id === selectedId) ?? nodes[0];
  const stageIds = selected?.data.stageIds ?? [];
  const allArtifacts = [...(project?.artifacts ?? []), ...importedArtifacts];
  const stageArtifacts = allArtifacts.filter((item) => stageIds.includes(item.stage));
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
          const event = JSON.parse(line) as { type?: string; stage?: string; status?: string; progress?: number; credits?: number; message?: string; code?: number | null };
          if (event.stage && (event.status || event.progress !== undefined)) {
            setManifest((current) => current ? {
              ...current,
              stages: { ...current.stages, [event.stage]: { ...current.stages[event.stage], status: event.status ?? current.stages[event.stage]?.status ?? "RUNNING", progress: event.progress ?? current.stages[event.stage]?.progress } },
            } : current);
            if (event.status === "SUCCEEDED") setStaleNodeIds((current) => {
              const next = current.filter((id) => id !== event.stage);
              persistGraph(customEdges, next);
              return next;
            });
          }
          if (event.type === "error") {
            runQueue.current = [];
            setMessage(`节点执行失败：${event.message ?? "未知错误"}`);
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
          if (payload.stream === "stderr") setMessage(`管线错误：${line}`);
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

  const runPipeline = async (operation: "execute" | "resume" | "check", stage?: string) => {
    if (runningStage) return;
    if (stage === "reference-approval") { await approveReferenceSelection(); return; }
    let confirmed = false;
    const inputArtifactId = stage ? edges.find((edge) => edge.target === stage && edge.source.startsWith("imported:"))?.source : undefined;
    if (operation === "execute" && stage && paidStages.includes(stage) && !mockMode) {
      const parameters = JSON.stringify((manifest as { config?: Record<string, unknown> } | undefined)?.config?.[stage] ?? {}, null, 2);
      const cost = stage === "image-turnaround" ? `OpenAI GPT Image 2 · ${imageQuality === "low" ? "低质量草稿，预计约 $0.02–$0.10" : "中质量，预计约 $0.05–$0.25"}（含参考图输入后以实际用量为准）` : `预计最多消耗约 ${creditEstimate[stage]} Meshy credits`;
      confirmed = window.confirm(`${stageLabels[stage]} 将检查输入与参数。完全一致时复用已有结果；输入或参数变化时可能创建新的付费请求。\n${cost}。\n\n参数：\n${parameters}\n\n确认后才允许发送 POST 请求。`);
      if (!confirmed) { runQueue.current = []; setMessage("已取消，未创建任务、未消耗 credits。"); return; }
    }
    try {
      if (stage === "view-split" && operation === "execute") await invoke("set_view_split", { cuts: splitCuts, order: splitOrder });
      await invoke("start_pipeline", {
        operation,
        stage: stage ?? null,
        runName: null,
        confirmSpend: confirmed,
        apiKey: apiKey.trim() || null,
        openaiApiKey: openAiApiKey.trim() || null,
        mock: mockMode,
        inputArtifactId: inputArtifactId ?? null,
        blenderPath,
        uePath,
        ueProject,
        targetHeight,
        rootCorrection,
        pelvisCorrection,
        referenceFrontId: null,
        referenceSideId: null,
        referenceBackId: null,
        imagePreset,
        imageQuality,
        imageBackground,
        imagePrompt,
      });
      setRunningStage(stage ?? "check");
      setMessage(operation === "check" ? "正在执行只读权限检查…" : `${stageLabels[stage ?? ""]} 已启动；task ID 会立即写入 Manifest。`);
    } catch (reason) {
      runQueue.current = [];
      setMessage(`无法启动节点：${String(reason)}`);
    }
  };
  launchStage.current = (stage) => { void runPipeline("execute", stage); };

  const runFromHere = () => {
    if (!actionStage) return;
    const workflow = manifest?.stages["reference-source"] ? executableStages : legacyExecutableStages;
    const start = workflow.indexOf(actionStage);
    let pending = workflow.slice(start).filter((id, index) => index === 0 || staleNodeIds.includes(id) || !["SUCCEEDED", "SKIPPED"].includes(manifest?.stages[id]?.status ?? ""));
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
  const actionStage = selectedExecutable.find((id) => !["SUCCEEDED", "SKIPPED"].includes(manifest?.stages[id]?.status ?? "")) ?? selectedExecutable.at(-1);
  const actionManifestStage = actionStage ? manifest?.stages[actionStage] : undefined;
  const actionFinished = ["SUCCEEDED", "SKIPPED"].includes(actionManifestStage?.status ?? "") && !staleNodeIds.includes(actionStage ?? "");
  const nextStage = workflowStages.find((id) => !["SUCCEEDED", "SKIPPED"].includes(manifest?.stages[id]?.status ?? ""));

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div><p className="eyebrow">AI CHARACTER PIPELINE</p><h1>TA Character Studio</h1></div>
        <div className="top-actions">
          <button onClick={() => setCreating(true)} disabled={Boolean(runningStage)}>新建项目</button>
          <button className="primary" onClick={openProject} disabled={busy}>{busy ? "正在打开…" : "打开项目"}</button>
          <button onClick={() => nextStage && runPipeline("execute", nextStage)} disabled={!manifest || !nextStage || Boolean(runningStage)} title={nextStage ? `继续：${stageLabels[nextStage]}` : "流程已完成"}>继续流程</button>
          <button onClick={() => artifactAction("export_artifact")} disabled={!selectedArtifact?.exists}>导出产物</button>
          <button onClick={() => artifactAction("reveal_artifact")} disabled={!selectedArtifact?.exists}>打开所在目录</button>
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

      <section className="workspace">
        <aside className="node-library panel">
          <div className="mode-switch" role="group" aria-label="节点显示模式">
            <button className={mode === "simple" ? "active" : ""} onClick={() => setMode("simple")}>简单模式</button>
            <button className={mode === "advanced" ? "active" : ""} onClick={() => setMode("advanced")}>高级节点</button>
          </div>
          <div className="panel-title"><span>制作步骤</span><b>{nodes.length}</b></div>
          {mode === "advanced" && <button className="import-button" onClick={importMesh}>＋ 导入本地 GLB</button>}
          {nodes.map((item) => <button key={item.id} className={`library-item ${item.id === selectedId ? "active" : ""}`} onClick={() => setSelectedId(item.id)}>
            <span>{item.data.title}<small>{item.data.subtitle}</small></span><i className={`status-pill status-${item.data.status.toLowerCase()}`}>{item.data.status}</i>
          </button>)}
        </aside>

        <section className="center-workspace" ref={splitHost} style={{ gridTemplateColumns: `${split}fr 6px ${100 - split}fr` }}>
          <section className="graph-panel" aria-label="角色制作节点图">
            <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={changeEdges} onConnect={connectNodes} onNodeClick={(_, item) => setSelectedId(item.id)} fitView fitViewOptions={{ padding: 0.16 }} minZoom={0.35} maxZoom={1.6} nodesConnectable={mode === "advanced"} deleteKeyCode="Delete">
              <Background color="#28354a" gap={24} size={1} /><MiniMap pannable zoomable nodeColor="#61718a" maskColor="rgba(7, 11, 18, 0.72)" /><Controls showInteractive={false} />
            </ReactFlow>
          </section>
          <div className="split-handle" role="separator" aria-label="调整节点图和预览比例" aria-orientation="vertical" tabIndex={0} onPointerDown={resizeSplit} />
          <section className={`preview-panel ${compare ? "compare" : ""}`}>
            <div className="preview-toolbar"><strong>资产预览</strong><button onClick={() => setCompare((value) => !value)} disabled={!compareLeft || !compareRight}>{compare ? "退出对比" : normalizeCompare ? "校正前 / 后对比" : "生成 / 优化对比"}</button></div>
            {compare ? <><ModelViewport artifact={compareLeft} label={normalizeCompare ? "校正前 / Animation" : "生成模型 / Generation"} /><ModelViewport artifact={compareRight} label={normalizeCompare ? "校正后 / Normalize" : "优化模型 / Remesh"} /></> : stageIds.includes("reference-approval") && imageCandidates.length ? <div className="review-grid">{imageCandidates.map((item) => <ImageViewport key={item.id} artifact={item} label={`${item.stage === "reference-source" ? "原图" : "切分"} · ${item.fileName}`} />)}</div> : stageIds.includes("view-split") ? <ImageViewport artifact={turnaroundSheet} cuts={splitCuts} onCutsChange={setSplitCuts} label="拖动蓝线调整切分" /> : selectedIsImage ? <ImageViewport artifact={selectedArtifact} /> : <ModelViewport artifact={selectedArtifact} />}
          </section>
        </section>

        <aside className="inspector panel">
          <div className="panel-title"><span>属性</span><b>INSPECTOR</b></div>
          <p className="eyebrow">{selected?.data.subtitle}</p><h2>{selected?.data.title}</h2>
          <p className="description">{selected?.data.description}</p>
          <dl>
            <div><dt>状态</dt><dd>{selected?.data.status}</dd></div>
            <div><dt>进度</dt><dd>{progress}%</dd></div>
            <div><dt>消耗</dt><dd>{credits} credits</dd></div>
            <div><dt>开始</dt><dd>{formatDate(startedAt.length ? Math.min(...startedAt) : undefined)}</dd></div>
            <div><dt>结束</dt><dd>{formatDate(finishedAt.length ? Math.max(...finishedAt) : undefined)}</dd></div>
            <div><dt>错误</dt><dd className="error-summary">{errorSummary(visibleError)}</dd></div>
          </dl>
          {qualityReport && <div className={`quality-summary quality-${qualityReport.status?.toLowerCase() ?? "warning"}`}>
            <strong>质量门禁：{qualityReport.status ?? "UNKNOWN"}</strong>
            {qualityReport.metrics && <small>{qualityReport.metrics.triangles?.toLocaleString()} 三角面 · {qualityReport.metrics.bones} 骨骼 · {qualityReport.metrics.heightMeters} m · {qualityReport.metrics.animations} 动画</small>}
            {qualityReport.warnings?.map((warning) => <small key={warning}>{warning}</small>)}
          </div>}
          {stageIds.includes("image-turnaround") && <div className="split-controls">
            <label className="field-label">处理预设</label><select value={imagePreset} onChange={(event) => setImagePreset(event.target.value)}><option value="turnaround">生成完整三视图</option><option value="complete-views">补全缺失视图</option><option value="clean-pose">统一背景与站姿</option></select>
            <label className="field-label">输出质量</label><select value={imageQuality} onChange={(event) => setImageQuality(event.target.value)}><option value="low">草稿 · Low</option><option value="medium">最终参考 · Medium</option></select>
            <label className="field-label">背景</label><select value={imageBackground} onChange={(event) => setImageBackground(event.target.value)}><option value="opaque">纯色背景</option><option value="transparent">透明背景（Preview）</option><option value="auto">自动</option></select>
            <label className="field-label">补充美术要求</label><textarea className="key-input" rows={3} maxLength={1000} value={imagePrompt} onChange={(event) => setImagePrompt(event.target.value)} placeholder="例如：保持斗篷长度、鞋底造型和发饰不变" />
          </div>}
          {stageIds.includes("view-split") && <div className="split-controls">
            <strong>本地切分（不消耗 API）</strong>
            <label>左分隔线 {Math.round(splitCuts[0] * 100)}%<input type="range" min="15" max="55" value={splitCuts[0] * 100} onChange={(event) => setSplitCuts([Math.min(Number(event.target.value) / 100, splitCuts[1] - 0.11), splitCuts[1]])} /></label>
            <label>右分隔线 {Math.round(splitCuts[1] * 100)}%<input type="range" min="45" max="85" value={splitCuts[1] * 100} onChange={(event) => setSplitCuts([splitCuts[0], Math.max(Number(event.target.value) / 100, splitCuts[0] + 0.11)])} /></label>
            {[0, 1, 2].map((index) => <select key={index} value={splitOrder[index]} onChange={(event) => { const next = [...splitOrder]; const other = next.indexOf(event.target.value); [next[index], next[other]] = [next[other], next[index]]; setSplitOrder(next); }}>{["front", "side", "back"].map((name) => <option key={name} value={name}>{index + 1} 区域：{{ front: "正面", side: "侧面", back: "背面" }[name]}</option>)}</select>)}
          </div>}
          {stageIds.includes("reference-approval") && <div className="split-controls">
            <strong>美术采用结果</strong><small>正面和背面为必需；可从 AI 切分图或原始参考图中选择。</small>
            {[{ label: "正面", value: approvalFront, set: setApprovalFront }, { label: "侧面", value: approvalSide, set: setApprovalSide }, { label: "背面", value: approvalBack, set: setApprovalBack }].map((choice) => <label className="reference-choice" key={choice.label}><span>{choice.label}</span><select value={choice.value} onChange={(event) => choice.set(event.target.value)}><option value="">{choice.label === "侧面" ? "不采用" : "请选择"}</option>{imageCandidates.map((item) => <option key={item.id} value={item.id}>{item.stage === "reference-source" ? "原图" : "切分"} · {item.fileName}</option>)}</select></label>)}
            <button onClick={approveReferenceSelection} disabled={!approvalFront || !approvalBack || Boolean(runningStage)}>采用这些视图</button>
          </div>}
          <label className="field-label">阶段产物</label>
          <select value={artifactId} onChange={(event) => setArtifactId(event.target.value)} disabled={!stageArtifacts.length}>
            {!stageArtifacts.length && <option>暂无产物</option>}
            {stageArtifacts.map((item) => <option key={item.id} value={item.id}>{item.fileName}{item.exists ? "" : "（缺失）"}</option>)}
          </select>
          {selectedArtifact && <dl className="artifact-meta">
            <div><dt>格式</dt><dd>{selectedArtifact.extension.toUpperCase()}</dd></div>
            <div><dt>大小</dt><dd>{formatBytes(selectedArtifact.bytes)}</dd></div>
            <div><dt>SHA-256</dt><dd title={selectedArtifact.sha256}>{selectedArtifact.sha256?.slice(0, 12) ?? "—"}</dd></div>
          </dl>}
          <div className="node-actions">
            <button className="primary" onClick={() => actionStage && runPipeline("execute", actionStage)} disabled={!manifest || !actionStage || Boolean(runningStage)}>{actionStage === "reference-approval" ? "确认采用" : actionFinished ? "检查 / 复用" : "运行节点"}</button>
            <button onClick={runFromHere} disabled={!manifest || !actionStage || Boolean(runningStage)}>从这里运行</button>
            <button onClick={() => actionStage && runPipeline("resume", actionStage)} disabled={!actionManifestStage?.taskId || actionFinished || Boolean(runningStage)}>恢复</button>
            <button onClick={stopPipeline} disabled={!runningStage}>停止</button>
          </div>
          {stageIds.includes("ue-import") && <button className="wide" onClick={openUE}>打开 UE 工程</button>}
          <details><summary>技术信息</summary>
            <label className="field-label">Meshy API Key（仅本次会话）</label>
            <input className="key-input" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="留空则读取环境变量" autoComplete="off" />
            <label className="field-label">OpenAI API Key（仅本次会话）</label>
            <input className="key-input" type="password" value={openAiApiKey} onChange={(event) => setOpenAiApiKey(event.target.value)} placeholder="留空则读取 OPENAI_API_KEY" autoComplete="off" />
            <label className="mock-toggle"><input type="checkbox" checked={mockMode} onChange={(event) => setMockMode(event.target.checked)} disabled={Boolean(runningStage)} /> 离线模拟（不连接 Meshy）</label>
            <label className="field-label">Blender</label><input className="key-input" value={blenderPath} onChange={(event) => setBlenderPath(event.target.value)} />
            <label className="field-label">目标身高（米）</label><input className="key-input" type="number" min="0.5" max="3" step="0.01" value={targetHeight} onChange={(event) => setTargetHeight(Number(event.target.value))} />
            <label className="field-label">Root 旋转 X,Y,Z</label><input className="key-input" value={rootCorrection} onChange={(event) => setRootCorrection(event.target.value)} />
            <label className="field-label">Pelvis 旋转 X,Y,Z</label><input className="key-input" value={pelvisCorrection} onChange={(event) => setPelvisCorrection(event.target.value)} />
            <label className="field-label">UnrealEditor-Cmd</label><input className="key-input" value={uePath} onChange={(event) => setUePath(event.target.value)} />
            <label className="field-label">UE 工程</label><input className="key-input" value={ueProject} onChange={(event) => setUeProject(event.target.value)} />
            <button className="wide" onClick={() => runPipeline("check")} disabled={Boolean(runningStage)}>只读 API 权限检查</button>
            <dl><div><dt>Task ID</dt><dd>{taskIds}</dd></div><div><dt>Manifest</dt><dd title={project?.manifestPath}>{project?.manifestPath ?? "—"}</dd></div></dl>
            <pre>{manifest ? JSON.stringify(stages.length === 1 ? currentStage : stages, null, 2) : "尚未打开项目"}</pre>
          </details>
        </aside>
      </section>

      <section className="log-panel panel"><div className="panel-title"><span>提示与日志</span><b>{runningStage ? `RUNNING · ${runningStage}` : "LOCAL"}</b></div><p className="user-message">{message}</p><div className="log-lines">{logs.slice(-12).map((line, index) => <code key={`${index}-${line}`}>{line}</code>)}</div></section>
      <footer className="status-bar"><span><i className="ready-dot" /> {manifest ? `${manifest.runId} · ${manifest.status}` : "等待打开或新建项目"}</span><span>Phase 7A · OpenAI / Meshy 付费 POST 必须逐次确认</span></footer>
    </main>
  );
}

export default App;
