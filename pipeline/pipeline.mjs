import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = "https://api.meshy.ai";
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELED"]);
const STAGE_NAMES = ["image-turnaround", "generation", "remesh", "rigging", "animation"];
const LOCAL_STAGE_NAMES = ["normalize", "ue-import"];
const CHARACTER_STAGES = ["generation", "remesh", "rigging", "animation", "normalize", "ue-import"];
let jsonOutput = false;
let mockMode = false;
let mockActiveStage;
const mockPolls = new Map();

function isMock() {
  return mockMode || process.env.TA_PIPELINE_MOCK === "1";
}

function emit(event, fallback) {
  console.log(jsonOutput ? JSON.stringify(event) : (fallback ?? `${event.stage ?? "pipeline"}: ${event.status ?? event.type}`));
}

export function mimeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  throw new Error(`只支持 PNG 或 JPG 输入：${filePath}`);
}

export function collectAssetUrls(value, keys = [], found = []) {
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    const urlCollection = keys.at(-1)?.endsWith("_urls");
    if (typeof child === "string" && /^https:\/\//.test(child) && (key.endsWith("_url") || urlCollection)) {
      found.push({ name: [...keys, key.replace(/_url$/, "")].join("-").replaceAll("_", "-"), url: child });
    } else if (child && typeof child === "object") {
      collectAssetUrls(child, [...keys, key], found);
    }
  }
  return found;
}

export function taskSnapshot(task) {
  return {
    status: task.status,
    progress: task.progress,
    consumedCredits: task.consumed_credits ?? 0,
    createdAt: task.created_at ?? null,
    startedAt: task.started_at ?? null,
    finishedAt: task.finished_at ?? null,
    expiresAt: task.expires_at ?? null,
    error: task.task_error?.message || null,
  };
}

function now() {
  return new Date().toISOString();
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function relative(filePath, base = ROOT) {
  return path.relative(base, filePath).replaceAll("\\", "/");
}

function absolute(filePath, base = ROOT) {
  const root = path.resolve(base);
  const resolved = path.resolve(root, filePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`产物路径越界：${filePath}`);
  return resolved;
}

function rootForManifest(manifestPath) {
  return path.dirname(path.dirname(path.dirname(path.resolve(manifestPath))));
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function checkedImage(filePath) {
  const resolved = path.resolve(filePath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile() || stat.size === 0) throw new Error(`输入图片无效：${resolved}`);
  mimeFor(resolved);
  return resolved;
}

async function imageDataUri(filePath) {
  const bytes = await fs.readFile(filePath);
  return `data:${mimeFor(filePath)};base64,${bytes.toString("base64")}`;
}

async function modelDataUri(filePath) {
  const resolved = path.resolve(filePath);
  if (path.extname(resolved).toLowerCase() !== ".glb") throw new Error("本地模型输入必须是 GLB。");
  const bytes = await fs.readFile(resolved);
  if (!bytes.length) throw new Error(`本地 GLB 为空：${resolved}`);
  return `data:model/gltf-binary;base64,${bytes.toString("base64")}`;
}

function apiKey() {
  const key = process.env.MESHY_API_KEY?.trim();
  if (!key) throw new Error("缺少 MESHY_API_KEY；请在当前 PowerShell 进程中设置它。");
  return key;
}

function openAiKey() {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("缺少 OPENAI_API_KEY；请在当前会话中提供 OpenAI API Key。");
  return key;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}
export function encodePng(width, height, rgba) {
  if (width < 1 || height < 1 || rgba.length !== width * height * 4) throw new Error("PNG 像素尺寸无效。");
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0))]);
}
function paeth(a, b, c) {
  const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
export function decodePng(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("三联图不是有效 PNG。");
  let offset = 8; let width; let height; let colorType; let interlace; const chunks = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset); const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (offset + 12 + length > bytes.length) throw new Error("PNG 数据已截断。");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; interlace = data[12]; if (data[8] !== 8) throw new Error("仅支持 8-bit PNG。"); }
    if (type === "IDAT") chunks.push(data);
    offset += length + 12;
    if (type === "IEND") break;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!width || !height || !channels || interlace !== 0 || width * height > 8_294_400) throw new Error("PNG 必须是非交错 RGB/RGBA 图片，且不超过 8294400 像素。");
  const packed = inflateSync(Buffer.concat(chunks)); const stride = width * channels;
  if (packed.length !== (stride + 1) * height) throw new Error("PNG 扫描线尺寸无效。");
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = packed[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const value = packed[y * (stride + 1) + x + 1]; const at = y * stride + x;
      const left = x >= channels ? raw[at - channels] : 0; const up = y ? raw[at - stride] : 0; const upperLeft = y && x >= channels ? raw[at - stride - channels] : 0;
      raw[at] = filter === 0 ? value : filter === 1 ? value + left : filter === 2 ? value + up : filter === 3 ? value + Math.floor((left + up) / 2) : filter === 4 ? value + paeth(left, up, upperLeft) : (() => { throw new Error(`不支持 PNG filter ${filter}`); })();
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) { rgba[pixel * 4] = raw[pixel * channels]; rgba[pixel * 4 + 1] = raw[pixel * channels + 1]; rgba[pixel * 4 + 2] = raw[pixel * channels + 2]; rgba[pixel * 4 + 3] = channels === 4 ? raw[pixel * channels + 3] : 255; }
  return { width, height, rgba };
}
export function splitPng(bytes, cuts = [1 / 3, 2 / 3], order = ["front", "side", "back"]) {
  const image = decodePng(bytes); const [left, right] = cuts;
  if (!(left > 0.1 && right < 0.9 && right - left > 0.1)) throw new Error("切分线必须保持从左到右，并为每个视图保留足够宽度。");
  if (!Array.isArray(order) || new Set(order).size !== 3 || !order.every((item) => ["front", "side", "back"].includes(item))) throw new Error("视图顺序必须包含 front、side、back。");
  const points = [0, Math.round(image.width * left), Math.round(image.width * right), image.width]; const result = {};
  for (let part = 0; part < 3; part += 1) { const width = points[part + 1] - points[part]; const pixels = Buffer.alloc(width * image.height * 4); for (let y = 0; y < image.height; y += 1) image.rgba.copy(pixels, y * width * 4, (y * image.width + points[part]) * 4, (y * image.width + points[part + 1]) * 4); result[order[part]] = encodePng(width, image.height, pixels); }
  return result;
}

async function requestJson(endpoint, { method = "GET", body, retries = 2 } = {}) {
  if (isMock()) {
    if (method === "POST") return { result: `mock-${endpoint.split("/").at(-1)}-task` };
    if (endpoint.includes("?")) return { value: [], Count: 0 };
    const token = { generation: "multi-image-to-3d", remesh: "remesh", rigging: "rigging", animation: "animations" }[mockActiveStage];
    if (token && endpoint.includes(token)) {
      const count = (mockPolls.get(endpoint) ?? 0) + 1;
      mockPolls.set(endpoint, count);
      if (count < 6) return { status: "RUNNING", progress: count * 15, consumed_credits: 0 };
    }
    const succeeded = { status: "SUCCEEDED", progress: 100, consumed_credits: 0 };
    if (endpoint.includes("multi-image-to-3d")) return { ...succeeded, model_urls: { glb: "https://mock.local/generation.glb" } };
    if (endpoint.includes("remesh")) return { ...succeeded, model_urls: { glb: "https://mock.local/remesh.glb" } };
    if (endpoint.includes("rigging")) return { ...succeeded, result: { rigged_character_glb_url: "https://mock.local/rigged.glb" } };
    if (endpoint.includes("animations")) return { ...succeeded, result: { animation_glb_url: "https://mock.local/animation.glb" } };
  }
  const url = endpoint.startsWith("http") ? endpoint : `${API_BASE}${endpoint}`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey()}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = text;
      }
      if (response.ok) return payload;
      const error = new Error(`Meshy ${response.status}: ${payload?.message || text || response.statusText}`);
      error.status = response.status;
      if ((response.status === 429 || response.status >= 500) && attempt < retries && method === "GET") {
        await sleep((attempt + 1) * 2_000);
        continue;
      }
      throw error;
    } catch (error) {
      if (attempt < retries && method === "GET" && !error.status) {
        await sleep((attempt + 1) * 2_000);
        continue;
      }
      throw error;
    }
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function saveManifest(manifestPath, manifest) {
  manifest.updatedAt = now();
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function pollTask(endpoint, stage, manifest, manifestPath, config) {
  const deadline = Date.now() + config.timeoutMinutes * 60_000;
  while (Date.now() < deadline) {
    const task = await requestJson(`${endpoint}/${stage.taskId}`);
    Object.assign(stage, taskSnapshot(task));
    await saveManifest(manifestPath, manifest);
    emit({ type: "stage", stage: stage.name, status: stage.status, progress: stage.progress ?? 0 }, `${stage.name}: ${stage.status} ${stage.progress ?? 0}%`);
    if (TERMINAL.has(stage.status)) {
      if (stage.status !== "SUCCEEDED") throw new Error(`${stage.name} 失败：${stage.error || stage.status}`);
      return task;
    }
    await sleep(isMock() ? 400 : config.pollIntervalSeconds * 1_000);
  }
  throw new Error(`${stage.name} 超过 ${config.timeoutMinutes} 分钟仍未完成；可稍后使用 resume 继续。`);
}

async function download(url, destination, storageRoot = ROOT) {
  if (isMock()) {
    await fs.writeFile(destination, `mock asset from ${url}\n`);
    const stat = await fs.stat(destination);
    return { path: relative(destination, storageRoot), bytes: stat.size, sha256: await sha256(destination) };
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`下载失败 ${response.status}: ${destination}`);
  await pipeline(response.body, createWriteStream(destination));
  const stat = await fs.stat(destination);
  if (stat.size === 0) throw new Error(`下载结果为空：${destination}`);
  return { path: relative(destination, storageRoot), bytes: stat.size, sha256: await sha256(destination) };
}

async function downloadTaskAssets(task, stageName, runDir, storageRoot = ROOT) {
  const destinationDir = path.join(runDir, stageName);
  await fs.mkdir(destinationDir, { recursive: true });
  const outputs = [];
  for (const asset of collectAssetUrls(task)) {
    const sourcePath = new URL(asset.url).pathname;
    const extension = path.extname(sourcePath) || ".bin";
    const destination = path.join(destinationDir, `${asset.name}${extension}`);
    emit({ type: "download", stage: stageName, file: path.basename(destination) }, `下载 ${path.basename(destination)}`);
    const output = await download(asset.url, destination, storageRoot);
    outputs.push(output);
    emit({ type: "artifact", stage: stageName, path: output.path });
  }
  if (outputs.length === 0) throw new Error(`${stageName} 成功，但响应中没有可下载资源。`);
  return outputs;
}

function newStage(name, endpoint) {
  return { name, endpoint, status: "NOT_STARTED", taskId: null, outputs: [] };
}

export function upgradeManifest(manifest, currentConfig) {
  const finish = () => {
    manifest.version = 2;
    manifest.config.image_turnaround ||= { ...currentConfig.image_turnaround };
    manifest.config.view_split ||= { ...currentConfig.view_split };
    manifest.config.normalize ||= { ...currentConfig.normalize };
    manifest.config.ue_import ||= { ...currentConfig.ue_import };
    manifest.stages.normalize ||= newStage("normalize", "local:blender");
    manifest.stages["ue-import"] ||= newStage("ue-import", "local:unreal");
    return manifest;
  };
  if (manifest.stages.remesh) {
    manifest.config.remesh ||= { ...currentConfig.remesh };
    if (!manifest.stages.remesh.taskId) {
      manifest.stages.remesh.endpoint = currentConfig.remesh.endpoint;
      manifest.config.remesh.endpoint = currentConfig.remesh.endpoint;
    }
    return finish();
  }
  manifest.version = 2;
  manifest.config.remesh = { ...currentConfig.remesh };
  const rigging = manifest.stages.rigging;
  if (rigging.status !== "NOT_STARTED" && rigging.status !== "SUCCEEDED") {
    rigging.previousAttempts = [
      ...(rigging.previousAttempts || []),
      { taskId: rigging.taskId, status: rigging.status, error: rigging.error || null },
    ];
    Object.assign(rigging, { status: "NOT_STARTED", taskId: null, outputs: [], error: null });
  }
  manifest.stages = {
    generation: manifest.stages.generation,
    remesh: newStage("remesh", currentConfig.remesh.endpoint),
    rigging,
    animation: manifest.stages.animation,
  };
  return finish();
}

export async function createRunFromReferences(referencePaths, runName, outputRoot = ROOT) {
  if (!Array.isArray(referencePaths) || referencePaths.length < 1 || referencePaths.length > 8) throw new Error("请选择 1 至 8 张参考图。");
  const references = await Promise.all(referencePaths.map(checkedImage));
  const config = JSON.parse(await fs.readFile(path.join(ROOT, "config.json"), "utf8"));
  const id = runName || now().replaceAll(":", "-").replace(".", "-");
  if (id === "." || id === ".." || id.includes("/") || id.includes("\\")) throw new Error("运行名称不能包含路径分隔符。");
  const storageRoot = path.resolve(outputRoot);
  const runDir = path.join(storageRoot, "output", id);
  const inputDir = path.join(runDir, "reference-source");
  const manifestPath = path.join(runDir, "manifest.json");
  await fs.mkdir(inputDir, { recursive: true });
  try {
    await fs.access(manifestPath);
    throw new Error(`运行目录已存在：${runDir}；请使用 resume。`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const copiedReferences = [];
  for (let index = 0; index < references.length; index += 1) {
    const copied = path.join(inputDir, `reference-${index + 1}${path.extname(references[index]).toLowerCase()}`);
    await fs.copyFile(references[index], copied);
    copiedReferences.push(await outputRecord(copied, storageRoot));
  }
  const manifest = {
    version: 2,
    runId: id,
    status: "IN_PROGRESS",
    createdAt: now(),
    updatedAt: now(),
    input: {},
    config,
    stages: {
      "reference-source": { ...newStage("reference-source", "local:import"), status: "SUCCEEDED", progress: 100, outputs: copiedReferences, finishedAt: now() },
      "image-turnaround": newStage("image-turnaround", "https://api.openai.com/v1/images/edits"),
      "view-split": newStage("view-split", "local:png-split"),
      "reference-approval": newStage("reference-approval", "local:artist-review"),
      generation: newStage("generation", "/openapi/v1/multi-image-to-3d"),
      remesh: newStage("remesh", config.remesh.endpoint),
      rigging: newStage("rigging", "/openapi/v1/rigging"),
      animation: newStage("animation", "/openapi/v1/animations"),
      normalize: newStage("normalize", "local:blender"),
      "ue-import": newStage("ue-import", "local:unreal"),
    },
    humanInterventions: [],
  };
  await saveManifest(manifestPath, manifest);
  return manifestPath;
}

export async function createRun(frontPath, backPath, runName, outputRoot = ROOT) {
  return createRunFromReferences([frontPath, backPath], runName, outputRoot);
}

function markCharacterStagesStale(manifest) {
  for (const name of ["view-split", "reference-approval", ...CHARACTER_STAGES]) {
    const stage = manifest.stages[name];
    if (stage && !["NOT_STARTED", "STALE"].includes(stage.status)) stage.status = "STALE";
  }
}

function approvedInputs(manifest, storageRoot) {
  const modern = Boolean(manifest.stages["reference-source"]);
  if (modern && manifest.stages["reference-approval"]?.status !== "SUCCEEDED") throw new Error("参考图尚未通过美术确认，不能进入 Generation。");
  const names = ["front", "side", "back"].filter((name) => manifest.input?.[name]?.path);
  if (!names.includes("front") || !names.includes("back")) throw new Error("Generation 至少需要已确认的正面图和背面图。");
  return names.map((name) => absolute(manifest.input[name].path, storageRoot));
}

const turnaroundPrompts = {
  turnaround: "Create one clean character turnaround sheet with exactly three full-body orthographic views arranged left to right: front, right side, back. Preserve identity, outfit, colors, body proportions, hairstyle, accessories, and surface details. Use the same neutral A-pose, scale, camera height, lighting, and plain background in every panel. No text, labels, borders, extra limbs, extra characters, perspective, or cropped body parts.",
  "complete-views": "Complete the missing orthographic character views. Output exactly three aligned full-body panels left to right: front, right side, back. Preserve every visible identity and costume detail. Use a neutral A-pose and plain background. No text or extra characters.",
  "clean-pose": "Convert the character references into exactly three aligned full-body orthographic panels left to right: front, right side, back. Preserve design and colors while using a neutral A-pose, even lighting, and a plain background. No text or extra characters.",
};

async function executeImageTurnaround(manifest, manifestPath, storageRoot, allowSpend) {
  const stage = manifest.stages["image-turnaround"];
  const sources = manifest.stages["reference-source"]?.outputs ?? [];
  if (!sources.length) throw new Error("三视图生成需要至少一张参考图。");
  const config = manifest.config.image_turnaround;
  const sourcePaths = sources.map((item) => absolute(item.path, storageRoot));
  const inputHash = fingerprint({ sources: await Promise.all(sourcePaths.map(sha256)), config });
  const reusable = stage.inputHash === inputHash && stage.status === "SUCCEEDED" && stage.outputs?.length && await fs.access(absolute(stage.outputs[0].path, storageRoot)).then(() => true).catch(() => false);
  if (reusable) { emit({ type: "complete", stage: stage.name, status: stage.status, reused: true, progress: 100 }); return stage; }
  if (!allowSpend && !isMock()) { emit({ type: "spend-required", stage: stage.name }); throw new Error("即将创建付费 image-turnaround 请求；重新运行并添加 --confirm-spend。"); }
  if (stage.inputHash && stage.inputHash !== inputHash) stage.previousAttempts = [...(stage.previousAttempts || []), { status: stage.status, inputHash: stage.inputHash, outputs: stage.outputs, replacedAt: now() }];
  markCharacterStagesStale(manifest);
  Object.assign(stage, { status: "RUNNING", progress: 0, startedAt: now(), inputHash, outputs: [], error: null });
  manifest.status = "IN_PROGRESS"; await saveManifest(manifestPath, manifest); emit({ type: "stage", stage: stage.name, status: "RUNNING", progress: 0 });
  try {
    let png; let requestId = null; let usage = null;
    if (isMock()) {
      const width = 96; const height = 32; const rgba = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) { const at = (y * width + x) * 4; rgba[at + Math.floor(x / 32)] = 210; rgba[at + 3] = 255; }
      png = encodePng(width, height, rgba); requestId = "mock-image-turnaround"; usage = { imageTokens: 0 };
    } else {
      const form = new FormData(); form.set("model", config.model); form.set("prompt", `${turnaroundPrompts[config.preset] ?? turnaroundPrompts.turnaround}${config.prompt_extra ? `\nAdditional art direction: ${config.prompt_extra}` : ""}`); form.set("quality", config.quality); form.set("size", config.size); form.set("background", config.background); form.set("output_format", "png");
      for (const source of sourcePaths) form.append("image[]", new Blob([await fs.readFile(source)], { type: mimeFor(source) }), path.basename(source));
      const response = await fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { Authorization: `Bearer ${openAiKey()}` }, body: form, signal: AbortSignal.timeout(150_000) });
      requestId = response.headers.get("x-request-id"); const text = await response.text(); let payload; try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
      if (!response.ok) { const code = payload?.error?.code; const friendly = code === "moderation_blocked" ? "图像请求未通过内容安全检查，请调整参考图或描述。" : response.status === 401 ? "OpenAI API Key 无效。" : response.status === 403 ? "当前 OpenAI 组织可能尚未获得图像模型权限。" : response.status === 429 ? "OpenAI 余额或速率额度不足。" : `OpenAI 图像服务返回 ${response.status}。`; const error = new Error(friendly); error.requestId = requestId; throw error; }
      const encoded = payload?.data?.[0]?.b64_json; if (!encoded) throw new Error("OpenAI 成功响应中没有 PNG 数据。"); png = Buffer.from(encoded, "base64"); decodePng(png); usage = payload.usage ?? null;
    }
    const outputDir = path.join(path.dirname(manifestPath), "image-turnaround"); await fs.mkdir(outputDir, { recursive: true }); const output = path.join(outputDir, "turnaround.png"); await fs.writeFile(output, png);
    stage.outputs = [await outputRecord(output, storageRoot)]; Object.assign(stage, { status: "SUCCEEDED", progress: 100, finishedAt: now(), requestId, usage }); delete manifest.lastError; await saveManifest(manifestPath, manifest); emit({ type: "artifact", stage: stage.name, path: stage.outputs[0].path }); emit({ type: "complete", stage: stage.name, status: stage.status, progress: 100 }); return stage;
  } catch (error) { Object.assign(stage, { status: "FAILED", error: error.message, requestId: error.requestId ?? null, finishedAt: now() }); manifest.status = "STOPPED"; manifest.lastError = { at: now(), message: error.message }; await saveManifest(manifestPath, manifest); throw error; }
}

async function executeViewSplit(manifest, manifestPath, storageRoot) {
  const stage = manifest.stages["view-split"]; const sheet = stageOutput(manifest.stages["image-turnaround"], "turnaround.png", ".png"); if (!sheet) throw new Error("视图切分需要三视图 PNG 输出。");
  const source = absolute(sheet.path, storageRoot); const config = manifest.config.view_split; const inputHash = fingerprint({ sheet: await sha256(source), config });
  const reusable = stage.inputHash === inputHash && stage.status === "SUCCEEDED" && stage.outputs?.length === 3 && (await Promise.all(stage.outputs.map((item) => fs.access(absolute(item.path, storageRoot)).then(() => true).catch(() => false)))).every(Boolean);
  if (reusable) { emit({ type: "complete", stage: stage.name, status: stage.status, reused: true, progress: 100 }); return stage; }
  if (stage.inputHash && stage.inputHash !== inputHash) stage.previousAttempts = [...(stage.previousAttempts || []), { status: stage.status, inputHash: stage.inputHash, outputs: stage.outputs, replacedAt: now() }];
  markCharacterStagesStale(manifest); Object.assign(stage, { status: "RUNNING", progress: 0, startedAt: now(), inputHash, outputs: [], error: null }); await saveManifest(manifestPath, manifest); emit({ type: "stage", stage: stage.name, status: "RUNNING", progress: 0 });
  try { const parts = splitPng(await fs.readFile(source), config.cuts, config.order); const outputDir = path.join(path.dirname(manifestPath), "view-split"); await fs.mkdir(outputDir, { recursive: true }); const files = []; for (const name of ["front", "side", "back"]) { const file = path.join(outputDir, `${name}.png`); await fs.writeFile(file, parts[name]); files.push(file); } stage.outputs = await Promise.all(files.map((file) => outputRecord(file, storageRoot))); Object.assign(stage, { status: "SUCCEEDED", progress: 100, finishedAt: now() }); delete manifest.lastError; await saveManifest(manifestPath, manifest); for (const output of stage.outputs) emit({ type: "artifact", stage: stage.name, path: output.path }); emit({ type: "complete", stage: stage.name, status: stage.status, progress: 100 }); return stage; }
  catch (error) { Object.assign(stage, { status: "FAILED", error: error.message, finishedAt: now() }); manifest.lastError = { at: now(), message: error.message }; await saveManifest(manifestPath, manifest); throw error; }
}

async function ensureStage({ stage, createBody, inputSignature, manifest, manifestPath, runDir, storageRoot, config, allowSpend, resumeOnly = false }) {
  let task;
  const inputHash = fingerprint(inputSignature);
  if (stage.taskId && stage.inputHash && stage.inputHash !== inputHash) {
    stage.previousAttempts = [...(stage.previousAttempts || []), { taskId: stage.taskId, status: stage.status, inputHash: stage.inputHash, replacedAt: now() }];
    stage.taskId = null;
    stage.status = "STALE";
    stage.outputs = [];
  }
  stage.inputHash = inputHash;
  await saveManifest(manifestPath, manifest);
  if (!stage.taskId) {
    if (resumeOnly) throw new Error(`${stage.name} 没有可恢复的 task ID；请使用 execute 创建任务。`);
    if (!allowSpend && !isMock()) {
      emit({ type: "spend-required", stage: stage.name });
      throw new Error(`即将创建付费 ${stage.name} 任务；重新运行并添加 --confirm-spend。`);
    }
    // Do not retry paid POST requests: a timeout may still have created the task.
    const created = await requestJson(stage.endpoint, { method: "POST", body: createBody, retries: 0 });
    if (!created?.result) throw new Error(`${stage.name} 创建响应缺少 task ID。`);
    stage.taskId = created.result;
    stage.status = "SUBMITTED";
    await saveManifest(manifestPath, manifest);
    emit({ type: "stage", stage: stage.name, status: "RUNNING", progress: 0, taskId: stage.taskId });
  }
  task = await pollTask(stage.endpoint, stage, manifest, manifestPath, config);
  if (!stage.outputs?.length) {
    stage.outputs = await downloadTaskAssets(task, stage.name, runDir, storageRoot);
    await saveManifest(manifestPath, manifest);
  }
  emit({ type: "complete", stage: stage.name, credits: stage.consumedCredits ?? 0 });
  return task;
}

async function continueRun(manifestPath, allowSpend) {
  const resolvedManifest = path.resolve(manifestPath);
  const manifest = JSON.parse(await fs.readFile(resolvedManifest, "utf8"));
  const currentConfig = JSON.parse(await fs.readFile(path.join(ROOT, "config.json"), "utf8"));
  upgradeManifest(manifest, currentConfig);
  await saveManifest(resolvedManifest, manifest);
  const runDir = path.dirname(resolvedManifest);
  const storageRoot = rootForManifest(resolvedManifest);
  const { config, stages } = manifest;
  try {
    const generationBody = {
      ...config.generation,
      image_urls: [
        await imageDataUri(absolute(manifest.input.front.path, storageRoot)),
        await imageDataUri(absolute(manifest.input.back.path, storageRoot)),
      ],
    };
    const generationTask = await ensureStage({
      stage: stages.generation,
      inputSignature: { input: manifest.input, config: config.generation },
      createBody: generationBody,
      manifest,
      manifestPath: resolvedManifest,
      runDir,
      storageRoot,
      config,
      allowSpend,
    });
    const generatedGlbUrl = generationTask.model_urls?.glb;
    if (!generatedGlbUrl) throw new Error("generation 响应缺少 model_urls.glb，无法进入 Remesh。");
    const { endpoint: _remeshEndpoint, ...remeshOptions } = config.remesh;
    const remeshTask = await ensureStage({
      stage: stages.remesh,
      inputSignature: { upstream: stages.generation.taskId, config: remeshOptions },
      createBody: { model_url: generatedGlbUrl, ...remeshOptions },
      manifest,
      manifestPath: resolvedManifest,
      runDir,
      storageRoot,
      config,
      allowSpend,
    });
    const remeshedGlbUrl = remeshTask.model_urls?.glb;
    if (!remeshedGlbUrl) throw new Error("remesh 响应缺少 model_urls.glb，无法进入 Rigging。");
    await ensureStage({
      stage: stages.rigging,
      inputSignature: { upstream: stages.remesh.taskId, config: config.rigging },
      createBody: { model_url: remeshedGlbUrl, ...config.rigging },
      manifest,
      manifestPath: resolvedManifest,
      runDir,
      storageRoot,
      config,
      allowSpend,
    });
    if (config.animation?.action_id == null) {
      stages.animation.status = "SKIPPED";
      stages.animation.reason = "Rigging 输出已包含基础 Walk；config.animation.action_id 为 null。";
    } else {
      await ensureStage({
        stage: stages.animation,
        inputSignature: { upstream: stages.rigging.taskId, config: config.animation },
        createBody: { rig_task_id: stages.rigging.taskId, action_id: config.animation.action_id },
        manifest,
        manifestPath: resolvedManifest,
        runDir,
        storageRoot,
        config,
        allowSpend,
      });
    }
    manifest.status = "SUCCEEDED";
    await saveManifest(resolvedManifest, manifest);
    emit({ type: "pipeline-complete", manifest: resolvedManifest }, `完成：${resolvedManifest}`);
  } catch (error) {
    manifest.status = "STOPPED";
    manifest.lastError = { at: now(), message: error.message };
    await saveManifest(resolvedManifest, manifest);
    throw error;
  }
}

async function completedTask(stage, label) {
  if (!stage?.taskId) throw new Error(`${label} 尚无 task ID，不能作为上游输入。`);
  const task = await requestJson(`${stage.endpoint}/${stage.taskId}`);
  const snapshot = taskSnapshot(task);
  if (snapshot.status !== "SUCCEEDED") throw new Error(`${label} 尚未成功，当前状态：${snapshot.status || "UNKNOWN"}`);
  return task;
}

function stageOutput(stage, preferredName, extension) {
  return stage?.outputs?.find((item) => path.basename(item.path) === preferredName)
    ?? stage?.outputs?.find((item) => path.extname(item.path).toLowerCase() === extension);
}

async function outputRecord(filePath, storageRoot) {
  const stat = await fs.stat(filePath);
  return { path: relative(filePath, storageRoot), bytes: stat.size, sha256: await sha256(filePath) };
}

async function runExternal(executable, args, environment = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, env: { ...process.env, ...environment } });
    let errorText = "";
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => {
      errorText = `${errorText}${chunk}`.slice(-8000);
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`外部工具退出码 ${code}${errorText ? `：${errorText.slice(-1200)}` : ""}`)));
  });
}

async function executeLocalStage(manifestPath, stageName, options) {
  const resolvedManifest = path.resolve(manifestPath);
  const manifest = JSON.parse(await fs.readFile(resolvedManifest, "utf8"));
  const currentConfig = JSON.parse(await fs.readFile(path.join(ROOT, "config.json"), "utf8"));
  upgradeManifest(manifest, currentConfig);
  const runDir = path.dirname(resolvedManifest);
  const storageRoot = rootForManifest(resolvedManifest);
  const stage = manifest.stages[stageName];
  const outputDir = path.join(runDir, stageName);
  await fs.mkdir(outputDir, { recursive: true });
  let source;
  let signature;
  let executable;
  let args;
  let expected;
  let environment = {};

  if (stageName === "normalize") {
    const script = path.join(ROOT, "tools", "blender_normalize.py");
    const input = stageOutput(manifest.stages.animation, "result-animation-glb.glb", ".glb")
      ?? stageOutput(manifest.stages.rigging, "result-rigged-character-glb.glb", ".glb");
    if (!input) throw new Error("Normalize 需要 Animation 或 Rigging 阶段的 GLB 输出。");
    source = absolute(input.path, storageRoot);
    executable = path.resolve(options.toolPath || "D:/Blender/blender.exe");
    const config = { ...manifest.config.normalize, ...options.normalize };
    manifest.config.normalize = config;
    signature = { input: await sha256(source), script: await sha256(script), config };
    args = ["--background", "--factory-startup", "--python", script, "--", "--input", source, "--output-dir", outputDir, "--height", String(config.height_meters), "--root", config.root_correction_degrees, "--pelvis", config.pelvis_correction_degrees];
    expected = ["normalized-character.glb", "normalized-character.fbx", "validation.json"];
  } else {
    const script = path.join(ROOT, "tools", "ue_import.py");
    const input = stageOutput(manifest.stages.normalize, "normalized-character.fbx", ".fbx");
    if (!input) throw new Error("UE Import 需要 Normalize 阶段输出的 FBX。");
    source = absolute(input.path, storageRoot);
    executable = path.resolve(options.toolPath || "D:/UE/UE_5.4/Engine/Binaries/Win64/UnrealEditor-Cmd.exe");
    const project = path.resolve(options.ueProject || "E:/AIEval/Eval_Commiting/Eval_Commiting.uproject");
    signature = { input: await sha256(source), script: await sha256(script), project, config: manifest.config.ue_import };
    const report = path.join(outputDir, "ue-import-report.json");
    args = [project, `-ExecutePythonScript=${script}`, "-unattended", "-nop4", "-nosplash", "-nullrhi"];
    const textures = (manifest.stages.normalize.outputs || []).filter((item) => path.extname(item.path).toLowerCase() === ".png").map((item) => absolute(item.path, storageRoot));
    environment = { TA_NORMALIZED_FBX: source, TA_RUN_ID: manifest.runId, TA_UE_REPORT: report, TA_TEXTURES: JSON.stringify(textures) };
    expected = ["ue-import-report.json"];
  }
  if (!await fs.stat(executable).then((item) => item.isFile()).catch(() => false)) throw new Error(`找不到外部工具：${executable}`);
  const inputHash = fingerprint(signature);
  const reusable = stage.inputHash === inputHash && ["SUCCEEDED", "WARNING"].includes(stage.status)
    && stage.outputs?.length && (await Promise.all(stage.outputs.map((item) => fs.access(absolute(item.path, storageRoot)).then(() => true).catch(() => false)))).every(Boolean);
  if (reusable) {
    emit({ type: "complete", stage: stageName, status: stage.status, reused: true, progress: 100 });
    return manifest;
  }
  if (stage.inputHash && stage.inputHash !== inputHash) {
    stage.previousAttempts = [...(stage.previousAttempts || []), { status: stage.status, inputHash: stage.inputHash, outputs: stage.outputs, replacedAt: now() }];
  }
  await Promise.all(expected.map((name) => fs.rm(path.join(outputDir, name), { force: true })));
  Object.assign(stage, { status: "RUNNING", progress: 0, startedAt: now(), inputHash, outputs: [], error: null });
  manifest.status = "IN_PROGRESS";
  await saveManifest(resolvedManifest, manifest);
  emit({ type: "stage", stage: stageName, status: "RUNNING", progress: 0 });
  try {
    await runExternal(executable, args, environment);
    const reportPath = path.join(outputDir, expected.at(-1));
    const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
    const files = stageName === "normalize" ? [...report.outputs, reportPath] : [reportPath];
    stage.outputs = await Promise.all(files.map((file) => outputRecord(path.resolve(file), storageRoot)));
    Object.assign(stage, { status: report.status === "WARNING" ? "WARNING" : "SUCCEEDED", progress: 100, finishedAt: now(), report });
    manifest.status = stageName === "ue-import" && stage.status === "SUCCEEDED" ? "SUCCEEDED" : "IN_PROGRESS";
    delete manifest.lastError;
    await saveManifest(resolvedManifest, manifest);
    emit({ type: "complete", stage: stageName, status: stage.status, progress: 100 });
    return manifest;
  } catch (error) {
    Object.assign(stage, { status: "FAILED", error: error.message, finishedAt: now() });
    manifest.status = "STOPPED";
    manifest.lastError = { at: now(), message: error.message };
    await saveManifest(resolvedManifest, manifest);
    throw error;
  }
}

export async function executeStage(manifestPath, stageName, { allowSpend = false, resumeOnly = false, inputArtifact, toolPath, ueProject, normalize, imageTurnaround } = {}) {
  if (LOCAL_STAGE_NAMES.includes(stageName)) return executeLocalStage(manifestPath, stageName, { toolPath, ueProject, normalize });
  if (stageName === "view-split") {
    const resolved = path.resolve(manifestPath); const manifest = JSON.parse(await fs.readFile(resolved, "utf8")); const currentConfig = JSON.parse(await fs.readFile(path.join(ROOT, "config.json"), "utf8")); upgradeManifest(manifest, currentConfig); return executeViewSplit(manifest, resolved, rootForManifest(resolved));
  }
  if (!STAGE_NAMES.includes(stageName)) throw new Error(`未知阶段：${stageName}`);
  mockActiveStage = stageName;
  const resolvedManifest = path.resolve(manifestPath);
  const manifest = JSON.parse(await fs.readFile(resolvedManifest, "utf8"));
  const currentConfig = JSON.parse(await fs.readFile(path.join(ROOT, "config.json"), "utf8"));
  upgradeManifest(manifest, currentConfig);
  const runDir = path.dirname(resolvedManifest);
  const storageRoot = rootForManifest(resolvedManifest);
  const { config, stages } = manifest;
  if (stageName === "image-turnaround" && imageTurnaround) config.image_turnaround = { ...config.image_turnaround, ...imageTurnaround };
  if (stageName === "image-turnaround") {
    if (!Object.hasOwn(turnaroundPrompts, config.image_turnaround.preset)) throw new Error("未知的三视图提示预设。");
    if (!["low", "medium"].includes(config.image_turnaround.quality)) throw new Error("三视图质量只支持 low 或 medium。");
    if (!["opaque", "transparent", "auto"].includes(config.image_turnaround.background)) throw new Error("三视图背景参数无效。");
    if ((config.image_turnaround.prompt_extra ?? "").length > 1000) throw new Error("补充美术描述不能超过 1000 字符。");
  }
  manifest.status = "IN_PROGRESS";
  await saveManifest(resolvedManifest, manifest);
  try {
    let task;
    if (stageName === "image-turnaround") {
      task = await executeImageTurnaround(manifest, resolvedManifest, storageRoot, allowSpend);
    } else if (stageName === "generation") {
      const images = approvedInputs(manifest, storageRoot);
      task = await ensureStage({
        stage: stages.generation,
        inputSignature: { input: manifest.input, config: config.generation },
        createBody: {
          ...config.generation,
          image_urls: await Promise.all(images.map(imageDataUri)),
        },
        manifest, manifestPath: resolvedManifest, runDir, storageRoot, config, allowSpend, resumeOnly,
      });
    } else if (stageName === "remesh") {
      const upstream = inputArtifact ? null : await completedTask(stages.generation, "generation");
      const glb = inputArtifact ? await modelDataUri(inputArtifact) : upstream?.model_urls?.glb;
      if (!glb) throw new Error("generation 响应缺少 model_urls.glb，无法进入 Remesh。");
      const { endpoint: _endpoint, ...options } = config.remesh;
      const input = inputArtifact ? await sha256(path.resolve(inputArtifact)) : stages.generation.taskId;
      task = await ensureStage({ stage: stages.remesh, createBody: { model_url: glb, ...options }, inputSignature: { input, config: options }, manifest, manifestPath: resolvedManifest, runDir, storageRoot, config, allowSpend, resumeOnly });
    } else if (stageName === "rigging") {
      const upstream = inputArtifact ? null : await completedTask(stages.remesh, "remesh");
      const glb = inputArtifact ? await modelDataUri(inputArtifact) : upstream?.model_urls?.glb;
      if (!glb) throw new Error("remesh 响应缺少 model_urls.glb，无法进入 Rigging。");
      const input = inputArtifact ? await sha256(path.resolve(inputArtifact)) : stages.remesh.taskId;
      task = await ensureStage({ stage: stages.rigging, createBody: { model_url: glb, ...config.rigging }, inputSignature: { input, config: config.rigging }, manifest, manifestPath: resolvedManifest, runDir, storageRoot, config, allowSpend, resumeOnly });
    } else if (config.animation?.action_id == null) {
      stages.animation.status = "SKIPPED";
      stages.animation.reason = "Rigging 输出已包含基础 Walk；config.animation.action_id 为 null。";
      task = null;
    } else {
      if (stages.rigging?.status !== "SUCCEEDED" || !stages.rigging.taskId) throw new Error("rigging 尚未成功，不能创建 Animation。");
      task = await ensureStage({ stage: stages.animation, createBody: { rig_task_id: stages.rigging.taskId, action_id: config.animation.action_id }, inputSignature: { upstream: stages.rigging.taskId, config: config.animation }, manifest, manifestPath: resolvedManifest, runDir, storageRoot, config, allowSpend, resumeOnly });
    }
    manifest.status = CHARACTER_STAGES.every((name) => ["SUCCEEDED", "SKIPPED"].includes(stages[name]?.status)) ? "SUCCEEDED" : "IN_PROGRESS";
    delete manifest.lastError;
    await saveManifest(resolvedManifest, manifest);
    emit({ type: "stage-finished", stage: stageName, status: stages[stageName].status, manifest: resolvedManifest });
    return task;
  } catch (error) {
    manifest.status = "STOPPED";
    manifest.lastError = { at: now(), message: error.message };
    await saveManifest(resolvedManifest, manifest);
    throw error;
  }
}

function artifactOutput(manifest, token) {
  const match = /^([^:]+):(\d+)$/.exec(token ?? "");
  if (!match) throw new Error(`产物标识无效：${token}`);
  const output = manifest.stages[match[1]]?.outputs?.[Number(match[2])];
  if (!output) throw new Error(`找不到产物：${token}`);
  return output;
}

export async function approveReferences(manifestPath, selection) {
  const resolved = path.resolve(manifestPath); const manifest = JSON.parse(await fs.readFile(resolved, "utf8")); const currentConfig = JSON.parse(await fs.readFile(path.join(ROOT, "config.json"), "utf8")); upgradeManifest(manifest, currentConfig);
  if (!manifest.stages["reference-approval"]) throw new Error("历史工程无需重复确认参考图。");
  if (!selection.front || !selection.back) throw new Error("至少需要选择正面图和背面图。");
  const storageRoot = rootForManifest(resolved); const outputDir = path.join(path.dirname(resolved), "reference-approval"); await fs.mkdir(outputDir, { recursive: true }); const input = {}; const outputs = [];
  for (const name of ["front", "side", "back"]) {
    if (!selection[name]) continue;
    const listed = artifactOutput(manifest, selection[name]); const source = absolute(listed.path, storageRoot); await checkedImage(source); const target = path.join(outputDir, `${name}${path.extname(source).toLowerCase()}`); await fs.copyFile(source, target); const record = await outputRecord(target, storageRoot); input[name] = record; outputs.push(record);
  }
  const stage = manifest.stages["reference-approval"]; const inputHash = fingerprint(input);
  if (stage.inputHash && stage.inputHash !== inputHash) { stage.previousAttempts = [...(stage.previousAttempts || []), { status: stage.status, inputHash: stage.inputHash, outputs: stage.outputs, replacedAt: now() }]; for (const name of CHARACTER_STAGES) if (manifest.stages[name] && manifest.stages[name].status !== "NOT_STARTED") manifest.stages[name].status = "STALE"; }
  manifest.input = input; Object.assign(stage, { status: "SUCCEEDED", progress: 100, startedAt: now(), finishedAt: now(), inputHash, outputs, error: null, selection }); manifest.status = "IN_PROGRESS"; delete manifest.lastError; await saveManifest(resolved, manifest); emit({ type: "complete", stage: stage.name, status: stage.status, progress: 100 }); return manifest;
}

async function inspectManifest(manifestPath) {
  const resolved = path.resolve(manifestPath);
  const manifest = JSON.parse(await fs.readFile(resolved, "utf8"));
  emit({ type: "inspect", manifestPath: resolved, manifest });
}

async function checkAccess() {
  const endpoints = [
    ["Multi-Image-to-3D", "/openapi/v1/multi-image-to-3d?page_num=1&page_size=1"],
    ["Remesh", "/openapi/v1/remesh?page_num=1&page_size=1"],
    ["Rigging", "/openapi/v1/rigging?page_num=1&page_size=1"],
    ["Animation", "/openapi/v1/animations?page_num=1&page_size=1"],
  ];
  for (const [name, endpoint] of endpoints) {
    const result = await requestJson(endpoint);
    const count = Array.isArray(result) ? result.length : result?.Count ?? result?.count ?? "unknown";
    emit({ type: "check", service: name, status: "OK", tasks: count }, `${name}: OK, tasks=${count}`);
  }
}

function usage() {
  console.log(`用法：
  node pipeline.mjs check
  node pipeline.mjs init [--reference <image> ...] --run-name <name> [--output-root <folder>] --json
  node pipeline.mjs execute <stage> --manifest <manifest.json> [--input-artifact <local.glb>] --json [--confirm-spend]
  node pipeline.mjs execute normalize --manifest <manifest.json> [--tool-path <blender.exe>] [--height 1.6] --json
  node pipeline.mjs execute ue-import --manifest <manifest.json> --ue-project <project.uproject> [--tool-path <UnrealEditor-Cmd.exe>] --json
  node pipeline.mjs resume <stage> --manifest <manifest.json> --json
  node pipeline.mjs inspect --manifest <manifest.json> --json
  node pipeline.mjs approve-references --manifest <manifest.json> --front <artifact> [--side <artifact>] --back <artifact> --json
  node pipeline.mjs run <front.png> <back.png> [run-name] --confirm-spend
  node pipeline.mjs resume <output/.../manifest.json> --confirm-spend

check 只读且不消费 credits；run/resume 只有添加 --confirm-spend 才会创建付费任务。`);
}

async function main() {
  const args = process.argv.slice(2);
  jsonOutput = args.includes("--json");
  mockMode = args.includes("--mock");
  const allowSpend = args.includes("--confirm-spend");
  const manifestFlag = args.indexOf("--manifest");
  const manifestPath = manifestFlag >= 0 ? args[manifestFlag + 1] : undefined;
  const outputRootFlag = args.indexOf("--output-root");
  const outputRoot = outputRootFlag >= 0 ? args[outputRootFlag + 1] : undefined;
  const inputFlag = args.indexOf("--input-artifact");
  const inputArtifact = inputFlag >= 0 ? args[inputFlag + 1] : undefined;
  const valueFor = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
  const toolPath = valueFor("--tool-path");
  const ueProject = valueFor("--ue-project");
  const height = valueFor("--height");
  const rootCorrection = valueFor("--root-correction");
  const pelvisCorrection = valueFor("--pelvis-correction");
  const imagePreset = valueFor("--image-preset"); const imageQuality = valueFor("--image-quality"); const imageBackground = valueFor("--image-background"); const imagePrompt = valueFor("--image-prompt");
  const runName = valueFor("--run-name"); const front = valueFor("--front"); const side = valueFor("--side"); const back = valueFor("--back");
  const references = args.flatMap((arg, index) => arg === "--reference" && args[index + 1] ? [args[index + 1]] : []);
  const valuedFlags = ["--manifest", "--output-root", "--input-artifact", "--tool-path", "--ue-project", "--height", "--root-correction", "--pelvis-correction", "--run-name", "--front", "--side", "--back", "--reference", "--image-preset", "--image-quality", "--image-background", "--image-prompt"];
  const flagsWithValues = new Set(valuedFlags.map((flag) => args.indexOf(flag)).filter((index) => index >= 0).map((index) => index + 1));
  const positional = args.filter((arg, index) => !["--confirm-spend", "--json", "--mock", ...valuedFlags].includes(arg) && !flagsWithValues.has(index));
  const [command, ...values] = positional;
  if (command === "check") return checkAccess();
  if (command === "init" && (references.length || values.length >= 2)) {
    const created = references.length ? await createRunFromReferences(references, runName, outputRoot) : await createRun(values[0], values[1], values[2], outputRoot);
    emit({ type: "initialized", manifest: created }, `已创建：${created}`);
    return;
  }
  if (command === "inspect" && manifestPath) return inspectManifest(manifestPath);
  if (command === "approve-references" && manifestPath) return approveReferences(manifestPath, { front, side, back });
  if (command === "execute" && values[0] && manifestPath) return executeStage(manifestPath, values[0], { allowSpend, inputArtifact, toolPath, ueProject, normalize: { ...(height ? { height_meters: Number(height) } : {}), ...(rootCorrection ? { root_correction_degrees: rootCorrection } : {}), ...(pelvisCorrection ? { pelvis_correction_degrees: pelvisCorrection } : {}) }, imageTurnaround: { ...(imagePreset ? { preset: imagePreset } : {}), ...(imageQuality ? { quality: imageQuality } : {}), ...(imageBackground ? { background: imageBackground } : {}), ...(imagePrompt !== undefined ? { prompt_extra: imagePrompt } : {}) } });
  if (command === "resume" && values[0] && manifestPath) return executeStage(manifestPath, values[0], { allowSpend, resumeOnly: true, inputArtifact });
  if (command === "run" && values.length >= 2) {
    const manifestPath = await createRun(values[0], values[1], values[2]);
    return continueRun(manifestPath, allowSpend);
  }
  if (command === "resume" && values[0]) return continueRun(values[0], allowSpend);
  usage();
  if (command) process.exitCode = 1;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  main().catch((error) => {
    console.error(jsonOutput ? JSON.stringify({ type: "error", message: error.message }) : `ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
