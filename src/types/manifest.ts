import type { NodeRunState } from "./pipeline";

export interface ManifestOutput { path: string; bytes?: number; sha256?: string; }
export interface ManifestStage {
  status: string;
  taskId?: string | null;
  progress?: number;
  consumedCredits?: number;
  outputs?: ManifestOutput[];
  error?: unknown;
  report?: unknown;
  createdAt?: number | string;
  startedAt?: number | string;
  finishedAt?: number | string;
}
export interface ManifestV2 {
  version: 2;
  runId: string;
  status: string;
  stages: Record<string, ManifestStage>;
  createdAt?: string;
  updatedAt?: string;
  lastError?: { at?: string; message?: string };
  [key: string]: unknown;
}
export interface ArtifactInfo {
  /** Rust 会话生成的授权 ID；不能由文件路径推导或伪造。 */
  id: string;
  stage: string;
  fileName: string;
  extension: string;
  bytes?: number;
  sha256?: string;
  exists: boolean;
  previewable: boolean;
}
export interface LoadedProject { manifestPath: string; manifest: unknown; artifacts: ArtifactInfo[]; }
export interface DraftFile { id: string; fileName: string; }
export interface SavedGraphEdge { id: string; source: string; target: string; }
export interface LoadedGraph { edges: SavedGraphEdge[]; artifacts: ArtifactInfo[]; staleNodeIds: string[]; }

const states: NodeRunState[] = ["NOT_STARTED", "RUNNING", "SUCCEEDED", "WARNING", "FAILED", "STALE"];
export function toRunState(value?: string): NodeRunState {
  const normalized = value?.toUpperCase() as NodeRunState;
  if (["SUBMITTED", "PENDING", "IN_PROGRESS"].includes(normalized)) return "RUNNING";
  if (normalized === "SKIPPED") return "WARNING";
  if (normalized === "CANCELED") return "WARNING";
  return states.includes(normalized) ? normalized : "NOT_STARTED";
}
export function parseManifestV2(value: unknown): ManifestV2 {
  // 前端检查负责给出易懂错误；Rust 后端仍会独立解析并执行路径安全检查。
  if (!value || typeof value !== "object") throw new Error("Manifest 不是有效对象");
  const candidate = value as Partial<ManifestV2>;
  if (candidate.version !== 2) throw new Error(`仅支持 v2 Manifest，当前版本为 ${String(candidate.version ?? "未知")}`);
  if (typeof candidate.runId !== "string" || !candidate.runId.trim()) throw new Error("Manifest 缺少 runId");
  if (!candidate.stages || typeof candidate.stages !== "object" || Array.isArray(candidate.stages)) throw new Error("Manifest 缺少 stages");
  for (const [name, stage] of Object.entries(candidate.stages)) {
    if (!stage || typeof stage !== "object" || typeof stage.status !== "string") throw new Error(`阶段 ${name} 缺少有效状态`);
    if (stage.outputs !== undefined && !Array.isArray(stage.outputs)) throw new Error(`阶段 ${name} 的 outputs 无效`);
  }
  return candidate as ManifestV2;
}
const severity: Record<NodeRunState, number> = { NOT_STARTED: 0, SUCCEEDED: 1, RUNNING: 2, WARNING: 3, STALE: 3, FAILED: 4 };
export function combinedState(stageIds: string[], manifest?: ManifestV2): NodeRunState {
  // 聚合节点展示最需要用户关注的子阶段，而不是简单采用最后一个阶段。
  return stageIds.map((id) => toRunState(manifest?.stages[id]?.status))
    .reduce((worst, state) => severity[state] > severity[worst] ? state : worst, "NOT_STARTED");
}
export function formatDate(value?: number | string): string {
  if (value === undefined) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN");
}
export function formatBytes(value?: number): string {
  if (value === undefined) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}
export function errorSummary(error: unknown): string {
  if (!error) return "无";
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return "此阶段记录了错误，请展开技术信息查看";
}
