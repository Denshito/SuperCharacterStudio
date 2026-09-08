import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { approveReferences, buildComfyWorkflow, collectAssetUrls, createRun, createRunFromReferences, encodePng, executeStage, mimeFor, resolveUeInputs, skipNormalize, splitPng, taskSnapshot, upgradeManifest } from "./pipeline.mjs";

// 极简 ComfyUI HTTP 服务模拟：覆盖检测、上传、提交、历史和下载，
// 用于在无真实 ComfyUI 的情况下验证桥接的真实 HTTP 代码路径。
// mode: "success"（默认）| "node-errors"（/prompt 返回节点错误、无 prompt_id）| "execution-error"（/history 返回执行失败）。
function startMockComfyServer(mode = "success") {
  return new Promise((resolve) => {
    const state = { submitted: [], uploaded: [], history: {}, requestedViews: [] };
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      const json = (status, payload) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(payload)); };
      if (url.pathname === "/system_stats") {
        return json(200, { system: { comfyui_version: "mock-1.0" }, devices: [] });
      }
      if (url.pathname === "/object_info") {
        const names = mode === "missing-node" ? ["LoadImage", "ImageBatch", "SaveImage"] : ["TAOpenRouterTurnaround", "LoadImage", "ImageBatch", "SaveImage"];
        return json(200, Object.fromEntries(names.map((name) => [name, { input: {} }])));
      }
      if (url.pathname === "/upload/image" && request.method === "POST") {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        return request.on("end", () => {
          const body = Buffer.concat(chunks).toString("latin1");
          const name = /filename="([^"]+)"/.exec(body)?.[1] ?? `reference-${state.uploaded.length + 1}.png`;
          const subfolder = /name="subfolder"\r\n\r\n([^\r]+)/.exec(body)?.[1] ?? "";
          state.uploaded.push({ name, subfolder });
          json(200, { name, subfolder, type: "input" });
        });
      }
      if (url.pathname === "/prompt" && request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        return request.on("end", () => {
          const parsed = JSON.parse(body);
          const promptId = `prompt-${state.submitted.length + 1}`;
          state.submitted.push(parsed);
          if (mode === "node-errors") {
            return json(200, { prompt_id: null, node_errors: { "3": { class_type: "TAOpenRouterTurnaround", errors: [{ type: "invalid", message: "node unavailable" }] } } });
          }
          const taNodeId = Object.keys(parsed.prompt).find((id) => parsed.prompt[id].class_type === "TAOpenRouterTurnaround");
          const saveNodeId = Object.keys(parsed.prompt).find((id) => parsed.prompt[id].class_type === "SaveImage");
          state.history[promptId] = mode === "execution-error"
            ? { status: { status_str: "error", completed: true, messages: [["TAOpenRouterTurnaround", "OpenRouter failed"]] } }
            : { outputs: {
              [taNodeId]: { ta_bridge: [JSON.stringify({ model: "openai/gpt-5.4-image-2", request_id: "mock-request", cost_usd: 0.01 })] },
              [saveNodeId]: { images: [{ filename: `${promptId}_00001_.png`, subfolder: `TACharacterStudio/${parsed.client_id}`, type: "output" }] },
            }, status: { status_str: "success", completed: true } };
          json(200, { prompt_id: promptId, number: state.submitted.length, node_errors: {} });
        });
      }
      if (url.pathname.startsWith("/history/")) {
        const promptId = url.pathname.slice("/history/".length);
        return json(200, state.history[promptId] ? { [promptId]: state.history[promptId] } : {});
      }
      if (url.pathname === "/view") {
        state.requestedViews.push(url.search);
        const png = encodePng(12, 4, Buffer.alloc(12 * 4 * 4, 255));
        response.writeHead(200, { "Content-Type": "image/png" });
        return response.end(png);
      }
      response.writeHead(404); response.end();
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: server.address().port, state, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

test("recognizes supported image types", () => {
  assert.equal(mimeFor("front.png"), "image/png");
  assert.equal(mimeFor("back.JPG"), "image/jpeg");
  assert.throws(() => mimeFor("character.webp"), /PNG.*JPG/);
});

test("collects nested asset URLs without persisting signed URLs", () => {
  const task = {
    model_urls: {
      glb: "https://assets.example/model.glb?token=secret",
    },
    result: {
      rigged_character_fbx_url: "https://assets.example/character.fbx?token=secret",
      basic_animations: {
        walking_glb_url: "https://assets.example/walk.glb?token=secret",
      },
    },
  };
  const assets = collectAssetUrls(task);
  assert.deepEqual(
    assets.map(({ name }) => name),
    ["model-urls-glb", "result-rigged-character-fbx", "result-basic-animations-walking-glb"],
  );
  assert.equal("url" in taskSnapshot({ status: "SUCCEEDED", progress: 100 }), false);
});

test("upgrades an interrupted v1 run with a remesh checkpoint", () => {
  const manifest = {
    version: 1,
    config: {},
    stages: {
      generation: { status: "SUCCEEDED", taskId: "generation-id" },
      rigging: { status: "FAILED", taskId: "old-rig-id", error: "too many faces", outputs: [] },
      animation: { status: "NOT_STARTED", taskId: null },
    },
  };
  upgradeManifest(manifest, {
    remesh: { endpoint: "/openapi/v1/remesh", topology: "triangle", target_polycount: 100000 },
  });
  assert.equal(manifest.version, 2);
  assert.equal(manifest.stages.remesh.endpoint, "/openapi/v1/remesh");
  assert.equal(manifest.stages.rigging.taskId, null);
  assert.equal(manifest.stages.rigging.previousAttempts[0].taskId, "old-rig-id");
});

test("repairs an unused stale remesh endpoint", () => {
  const manifest = {
    config: { remesh: { endpoint: "/openapi/v2/remesh", target_polycount: 100000 } },
    stages: { remesh: { endpoint: "/openapi/v2/remesh", taskId: null } },
  };
  upgradeManifest(manifest, { remesh: { endpoint: "/openapi/v1/remesh" } });
  assert.equal(manifest.config.remesh.endpoint, "/openapi/v1/remesh");
  assert.equal(manifest.stages.remesh.endpoint, "/openapi/v1/remesh");
});

test("upgradeManifest adds the comfy-prep stage and comfy config", () => {
  const manifest = {
    config: { remesh: { endpoint: "/openapi/v1/remesh", target_polycount: 100000 } },
    stages: { remesh: { endpoint: "/openapi/v1/remesh", taskId: null } },
  };
  upgradeManifest(manifest, { remesh: { endpoint: "/openapi/v1/remesh" }, comfy: { preset: "style-unify" } });
  assert.equal(manifest.stages["comfy-prep"].status, "NOT_STARTED");
  assert.equal(manifest.stages["comfy-prep"].endpoint, "local:comfy-openrouter");
  assert.equal(manifest.config.comfy.preset, "style-unify");
  assert.equal(manifest.config.comfy.workflow, "TAOpenRouterTurnaround");
});

test("upgradeManifest adds UE scale defaults without replacing project overrides", () => {
  const manifest = { config: { ue_import: { destination_root: "/Game/Custom" } }, stages: { remesh: { taskId: "done" } } };
  upgradeManifest(manifest, { remesh: {}, ue_import: { destination_root: "/Game/Generated", import_uniform_scale: 100, two_sided_material: true } });
  assert.equal(manifest.config.ue_import.destination_root, "/Game/Custom");
  assert.equal(manifest.config.ue_import.import_uniform_scale, 100);
  assert.equal(manifest.config.ue_import.two_sided_material, true);
});

test("builds one-to-sixteen image OpenRouter Comfy workflows", () => {
  const preset = { prompt: "turnaround", quality: "low", aspect_ratio: "21:9", background: "opaque" };
  const single = buildComfyWorkflow(["TACharacterStudio/job/reference-1.png"], preset, "keep cape", true, "job");
  assert.equal(single.workflow["1"].class_type, "LoadImage");
  assert.equal(single.workflow[single.taNodeId].inputs.reference_images[0], "1");
  assert.equal(single.workflow[single.taNodeId].inputs.confirm_spend, true);
  assert.ok(single.workflow[single.taNodeId].inputs.prompt.includes("keep cape"));
  const multiple = buildComfyWorkflow(["a.png", "b.png", "c.png"], preset, "", true, "job");
  assert.equal(Object.values(multiple.workflow).filter((node) => node.class_type === "LoadImage").length, 3);
  assert.equal(Object.values(multiple.workflow).filter((node) => node.class_type === "ImageBatch").length, 2);
  assert.throws(() => buildComfyWorkflow([], preset, "", false, "job"), /1 到 16/);
});

function stageManifest() {
  const stage = (name, endpoint, status = "SUCCEEDED", taskId = `${name}-task`) => ({ name, endpoint, status, taskId, outputs: [] });
  return {
    version: 2,
    runId: "mock-stage-run",
    status: "IN_PROGRESS",
    config: {
      remesh: { endpoint: "/openapi/v1/remesh", topology: "triangle", target_polycount: 100000 },
      animation: { action_id: 0 },
      pollIntervalSeconds: 0,
      timeoutMinutes: 1,
    },
    stages: {
      generation: stage("generation", "/openapi/v1/multi-image-to-3d"),
      remesh: stage("remesh", "/openapi/v1/remesh"),
      rigging: stage("rigging", "/openapi/v1/rigging"),
      animation: stage("animation", "/openapi/v1/animations", "NOT_STARTED", null),
    },
  };
}

test("stage JSONL mock execution resumes without creating a second task", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ta-pipeline-stage-"));
  const manifestPath = path.join(directory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(stageManifest()));
  try {
    process.env.TA_PIPELINE_MOCK = "1";
    await executeStage(manifestPath, "animation");
    const afterFirst = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(afterFirst.stages.animation.taskId, "mock-animations-task");
    assert.equal(afterFirst.stages.animation.status, "SUCCEEDED");
    assert.equal(afterFirst.stages.animation.outputs.length, 1);
    assert.equal(afterFirst.stages.animation.outputs[0].path.startsWith(".."), false);
    await executeStage(manifestPath, "animation", { resumeOnly: true });
    const afterSecond = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(afterSecond.stages.animation.taskId, "mock-animations-task");
  } finally {
    delete process.env.TA_PIPELINE_MOCK;
    await rm(directory, { recursive: true, force: true });
  }
});

test("paid stage creation is blocked before any request without confirmation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ta-pipeline-spend-"));
  const manifestPath = path.join(directory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(stageManifest()));
  try {
    delete process.env.TA_PIPELINE_MOCK;
    await assert.rejects(() => executeStage(manifestPath, "animation"), /--confirm-spend/);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.stages.animation.taskId, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("initializes a project under a user-selected output root", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ta-pipeline-init-"));
  const front = path.join(directory, "front.png");
  const back = path.join(directory, "back.jpg");
  await writeFile(front, "front");
  await writeFile(back, "back");
  try {
    const manifestPath = await createRun(front, back, "artist-project", directory);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.runId, "artist-project");
    assert.deepEqual(manifest.input, {});
    assert.equal(manifest.stages["reference-source"].outputs.length, 2);
    assert.equal(manifest.stages["reference-approval"].status, "NOT_STARTED");
    await assert.rejects(() => createRun(front, back, "../escape", directory), /路径分隔符/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("splits a PNG into labeled front, side and back images", () => {
  const width = 12; const height = 4; const rgba = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) rgba[(y * width + x) * 4] = x < 4 ? 20 : x < 8 ? 100 : 220;
  const split = splitPng(encodePng(width, height, rgba));
  assert.equal(split.front.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(split.side.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(split.back.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.throws(() => splitPng(encodePng(width, height, rgba), [0.8, 0.2]), /切分线/);
});

test("mock reference workflow requires approval before generation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ta-pipeline-reference-"));
  const source = path.join(directory, "concept.png"); await writeFile(source, "source");
  try {
    process.env.TA_PIPELINE_MOCK = "1";
    const manifestPath = await createRunFromReferences([source], "reference-workflow", directory);
    await assert.rejects(() => executeStage(manifestPath, "generation"), /美术确认/);
    await executeStage(manifestPath, "image-turnaround");
    await executeStage(manifestPath, "view-split");
    await approveReferences(manifestPath, { front: "view-split:0", side: "view-split:1", back: "view-split:2" });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.stages["reference-approval"].status, "SUCCEEDED");
    assert.ok(manifest.input.front.sha256);
    assert.ok(manifest.input.back.sha256);
    await executeStage(manifestPath, "generation");
    assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).stages.generation.status, "SUCCEEDED");
  } finally {
    delete process.env.TA_PIPELINE_MOCK;
    await rm(directory, { recursive: true, force: true });
  }
});

test("image generation cannot spend without confirmation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ta-pipeline-image-spend-"));
  const source = path.join(directory, "concept.png"); await writeFile(source, "source");
  try {
    delete process.env.TA_PIPELINE_MOCK;
    const manifestPath = await createRunFromReferences([source], "no-spend", directory);
    await assert.rejects(() => executeStage(manifestPath, "image-turnaround"), /--confirm-spend/);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.stages["image-turnaround"].status, "NOT_STARTED");
    assert.equal(manifest.stages["image-turnaround"].taskId, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reference approval rejects manifest path traversal", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ta-pipeline-image-path-"));
  const manifestPath = path.join(directory, "output", "unsafe", "manifest.json");
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const manifest = stageManifest();
  manifest.config.image_turnaround = {}; manifest.config.view_split = {};
  manifest.stages["reference-source"] = { name: "reference-source", status: "SUCCEEDED", outputs: [{ path: "../../../../escape.png" }] };
  manifest.stages["reference-approval"] = { name: "reference-approval", status: "NOT_STARTED", outputs: [] };
  await writeFile(manifestPath, JSON.stringify(manifest));
  try {
    await assert.rejects(() => approveReferences(manifestPath, { front: "reference-source:0", back: "reference-source:0" }), /路径越界/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runs remesh from an approved local GLB without a generation output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ta-pipeline-import-"));
  const manifestPath = path.join(directory, "manifest.json");
  const modelPath = path.join(directory, "imported.glb");
  const manifest = stageManifest();
  manifest.stages.generation.outputs = [];
  manifest.stages.remesh = {
    name: "remesh",
    endpoint: "/openapi/v1/remesh",
    status: "NOT_STARTED",
    taskId: null,
    outputs: [],
  };
  manifest.stages.rigging.status = "SUCCEEDED";
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(modelPath, Buffer.from("local-glb"));
  try {
    process.env.TA_PIPELINE_MOCK = "1";
    await executeStage(manifestPath, "remesh", { inputArtifact: modelPath, remesh: { target_polycount: 200000 } });
    await executeStage(manifestPath, "remesh", { inputArtifact: modelPath, remesh: { target_polycount: 200000 } });
    const reused = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(reused.stages.remesh.status, "SUCCEEDED");
    assert.equal(reused.stages.remesh.taskId, "mock-remesh-task");
    assert.equal(reused.stages.remesh.previousAttempts, undefined);
    assert.equal(reused.config.remesh.target_polycount, 200000);
    assert.equal(reused.stages.rigging.status, "STALE");
    await assert.rejects(() => executeStage(manifestPath, "remesh", { inputArtifact: modelPath, remesh: { target_polycount: 300001 } }), /100.*300,000/);
    await writeFile(modelPath, Buffer.from("changed-local-glb"));
    await executeStage(manifestPath, "remesh", { inputArtifact: modelPath, remesh: { target_polycount: 200000 } });
    const replaced = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(replaced.stages.remesh.previousAttempts.length, 1);
  } finally {
    delete process.env.TA_PIPELINE_MOCK;
    await rm(directory, { recursive: true, force: true });
  }
});

test("skips Blender explicitly and resolves raw UE inputs without launching a tool", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ta-pipeline-no-blender-"));
  const runDir = path.join(directory, "output", "raw-run");
  const manifestPath = path.join(runDir, "manifest.json");
  const animationFbx = path.join(runDir, "animation", "result-animation-fbx.fbx");
  const riggedFbx = path.join(runDir, "rigging", "result-rigged-character-fbx.fbx");
  const walkFbx = path.join(runDir, "rigging", "result-basic-animations-walking-fbx.fbx");
  await mkdir(path.dirname(animationFbx), { recursive: true });
  await mkdir(path.dirname(riggedFbx), { recursive: true });
  await writeFile(animationFbx, "idle");
  await writeFile(riggedFbx, "rigged");
  await writeFile(walkFbx, "walk");
  const output = (file) => ({ path: path.relative(directory, file).replaceAll("\\", "/") });
  const manifest = stageManifest();
  manifest.runId = "raw-run";
  manifest.stages.animation = { name: "animation", status: "SUCCEEDED", outputs: [output(animationFbx)] };
  manifest.stages.rigging.outputs = [output(riggedFbx), output(walkFbx)];
  manifest.stages.normalize = { name: "normalize", status: "NOT_STARTED", outputs: [] };
  manifest.stages["ue-import"] = { name: "ue-import", status: "SUCCEEDED", outputs: [] };
  await writeFile(manifestPath, JSON.stringify(manifest));
  try {
    await skipNormalize(manifestPath);
    let saved = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(saved.stages.normalize.status, "SKIPPED");
    assert.equal(saved.stages.normalize.validationStatus, "NOT_RUN");
    assert.equal(saved.stages.normalize.report, undefined);
    assert.equal(saved.stages["ue-import"].status, "STALE");
    let inputs = await resolveUeInputs(saved, directory);
    assert.equal(inputs.sourceMode, "raw");
    assert.equal(inputs.source, animationFbx);
    assert.equal(inputs.walkSource, walkFbx);
    assert.equal(inputs.hasIdle, true);

    await rm(animationFbx);
    saved = JSON.parse(await readFile(manifestPath, "utf8"));
    inputs = await resolveUeInputs(saved, directory);
    assert.equal(inputs.source, riggedFbx);
    assert.equal(inputs.hasIdle, false);
    assert.match(inputs.warnings.join(" "), /Idle/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("comfy bridge mock writes bridge directory and feeds the existing view-split chain", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ta-pipeline-comfy-"));
  const source = path.join(directory, "concept.png");
  await writeFile(source, "source");
  try {
    process.env.TA_PIPELINE_MOCK = "1";
    const manifestPath = await createRunFromReferences([source], "comfy-workflow", directory);
    await executeStage(manifestPath, "comfy-prep");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.stages["comfy-prep"].status, "SUCCEEDED");
    assert.equal(manifest.stages["comfy-prep"].outputs.length, 1);
    assert.ok(manifest.stages["comfy-prep"].outputs[0].path.endsWith("turnaround.png"));
    assert.ok(manifest.stages["comfy-prep"].outputs[0].path.startsWith("..") === false);

    const runDir = path.dirname(manifestPath);
    const bridgeEntries = await readdir(path.join(runDir, "bridge"));
    assert.equal(bridgeEntries.length, 1);
    const jobId = bridgeEntries[0];
    const bridgeDir = path.join(runDir, "bridge", jobId);
    for (const name of ["request.json", "workflow_api.json", "input", "output"]) {
      assert.ok(await stat(path.join(bridgeDir, name)).then(() => true).catch(() => false), `缺少 ${name}`);
    }
    const request = JSON.parse(await readFile(path.join(bridgeDir, "request.json"), "utf8"));
    assert.equal(request.workflow, "TAOpenRouterTurnaround");
    assert.equal(request.jobId, jobId);
    const workflow = await readFile(path.join(bridgeDir, "workflow_api.json"), "utf8");
    assert.equal(workflow.includes("{{"), false);
    const response = JSON.parse(await readFile(path.join(bridgeDir, "output", "response.json"), "utf8"));
    assert.equal(response.jobId, jobId);
    assert.equal(response.outputs.length, 1);
    assert.ok(response.outputs[0].sha256);

    // 下游切分、确认、生成保持不变（保底：Comfy 作为 image-turnaround 的本地替代）。
    await executeStage(manifestPath, "view-split");
    await approveReferences(manifestPath, { front: "view-split:0", side: "view-split:1", back: "view-split:2" });
    await executeStage(manifestPath, "generation");
    assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).stages.generation.status, "SUCCEEDED");
  } finally {
    delete process.env.TA_PIPELINE_MOCK;
    await rm(directory, { recursive: true, force: true });
  }
});

test("comfy prep fails cleanly when local ComfyUI is unreachable and leaves no artifacts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ta-pipeline-comfy-offline-"));
  const source = path.join(directory, "concept.png");
  await writeFile(source, "source");
  try {
    delete process.env.TA_PIPELINE_MOCK;
    const manifestPath = await createRunFromReferences([source], "comfy-offline", directory);
    await assert.rejects(() => executeStage(manifestPath, "comfy-prep", { comfyUrl: "http://127.0.0.1:1", allowSpend: true }), /ComfyUI/);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.stages["comfy-prep"].status, "FAILED");
    assert.equal(manifest.stages["comfy-prep"].outputs.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("comfy prep cannot upload or submit before spend confirmation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ta-pipeline-comfy-spend-"));
  const source = path.join(directory, "concept.png");
  await writeFile(source, "source");
  const mock = await startMockComfyServer();
  try {
    delete process.env.TA_PIPELINE_MOCK;
    const manifestPath = await createRunFromReferences([source], "comfy-spend", directory);
    await assert.rejects(() => executeStage(manifestPath, "comfy-prep", { comfyUrl: `http://127.0.0.1:${mock.port}` }), /confirm-spend|付费/);
    assert.equal(mock.state.uploaded.length, 0);
    assert.equal(mock.state.submitted.length, 0);
  } finally {
    await mock.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("comfy prep reports missing custom nodes before upload", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ta-pipeline-comfy-nodes-"));
  const source = path.join(directory, "concept.png");
  await writeFile(source, "source");
  const mock = await startMockComfyServer("missing-node");
  try {
    delete process.env.TA_PIPELINE_MOCK;
    const manifestPath = await createRunFromReferences([source], "comfy-nodes", directory);
    await assert.rejects(() => executeStage(manifestPath, "comfy-prep", { comfyUrl: `http://127.0.0.1:${mock.port}`, allowSpend: true }), /TAOpenRouterTurnaround/);
    assert.equal(mock.state.uploaded.length, 0);
    assert.equal(mock.state.submitted.length, 0);
  } finally {
    await mock.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("view-split accepts an imported turnaround PNG to start mid-pipeline", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ta-pipeline-import-image-"));
  const source = path.join(directory, "concept.png");
  await writeFile(source, "source");
  try {
    process.env.TA_PIPELINE_MOCK = "1";
    const manifestPath = await createRunFromReferences([source], "import-image-workflow", directory);
    const sheet = path.join(directory, "imported-turnaround.png");
    const width = 96; const height = 32; const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) { const at = (y * width + x) * 4; rgba[at + Math.floor(x / 32)] = 210; rgba[at + 3] = 255; }
    await writeFile(sheet, encodePng(width, height, rgba));
    await executeStage(manifestPath, "view-split", { inputArtifact: sheet });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.stages["view-split"].status, "SUCCEEDED");
    assert.equal(manifest.stages["view-split"].outputs.length, 3);
    await approveReferences(manifestPath, { front: "view-split:0", side: "view-split:1", back: "view-split:2" });
    await executeStage(manifestPath, "generation");
    assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).stages.generation.status, "SUCCEEDED");
  } finally {
    delete process.env.TA_PIPELINE_MOCK;
    await rm(directory, { recursive: true, force: true });
  }
});

test("comfy prep exercises the real HTTP protocol against a mock ComfyUI server", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ta-pipeline-comfy-http-"));
  const source = path.join(directory, "concept.png");
  await writeFile(source, "source");
  const mock = await startMockComfyServer();
  try {
    delete process.env.TA_PIPELINE_MOCK;
    const manifestPath = await createRunFromReferences([source], "comfy-http", directory);
    await executeStage(manifestPath, "comfy-prep", { comfyUrl: `http://127.0.0.1:${mock.port}`, allowSpend: true });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.stages["comfy-prep"].status, "SUCCEEDED");
    assert.equal(manifest.stages["comfy-prep"].outputs.length, 1);
    assert.equal(manifest.stages["comfy-prep"].promptId, "prompt-1");

    // 提交给 /prompt 的 workflow 是完整实例化后的 ComfyUI API 图。
    assert.equal(mock.state.submitted.length, 1);
    const submittedPrompt = mock.state.submitted[0].prompt;
    const loadNode = Object.values(submittedPrompt).find((node) => node.class_type === "LoadImage");
    const taNode = Object.values(submittedPrompt).find((node) => node.class_type === "TAOpenRouterTurnaround");
    const saveNode = Object.values(submittedPrompt).find((node) => node.class_type === "SaveImage");
    assert.ok(saveNode);
    assert.ok(loadNode.inputs.image.includes("TACharacterStudio/comfy-http-"));
    assert.ok(taNode.inputs.prompt.includes("三视图"));
    assert.equal(taNode.inputs.confirm_spend, true);
    assert.equal(JSON.stringify(submittedPrompt).includes("{{"), false);
    assert.equal(mock.state.submitted[0].client_id.startsWith("comfy-http-"), true);
    assert.equal(mock.state.uploaded.length, 1);
    assert.ok(mock.state.requestedViews.length >= 1);

    const runDir = path.dirname(manifestPath);
    const bridgeDirs = await readdir(path.join(runDir, "bridge"));
    assert.equal(bridgeDirs.length, 1);
    const response = JSON.parse(await readFile(path.join(runDir, "bridge", bridgeDirs[0], "output", "response.json"), "utf8"));
    assert.equal(response.promptId, "prompt-1");
    assert.equal(response.outputs[0].type, "image/png");
    assert.ok(response.outputs[0].sha256);
    assert.equal(response.metadata.costUsd, 0.01);
  } finally {
    await mock.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("comfy prep surfaces workflow node errors and leaves no artifacts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ta-pipeline-comfy-node-errors-"));
  const source = path.join(directory, "concept.png");
  await writeFile(source, "source");
  const mock = await startMockComfyServer("node-errors");
  try {
    delete process.env.TA_PIPELINE_MOCK;
    const manifestPath = await createRunFromReferences([source], "comfy-node-errors", directory);
    await assert.rejects(() => executeStage(manifestPath, "comfy-prep", { comfyUrl: `http://127.0.0.1:${mock.port}`, allowSpend: true }), /prompt_id|节点错误/);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.stages["comfy-prep"].status, "FAILED");
    assert.equal(manifest.stages["comfy-prep"].outputs.length, 0);
  } finally {
    await mock.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("comfy prep handles ComfyUI execution errors from history cleanly", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ta-pipeline-comfy-exec-error-"));
  const source = path.join(directory, "concept.png");
  await writeFile(source, "source");
  const mock = await startMockComfyServer("execution-error");
  try {
    delete process.env.TA_PIPELINE_MOCK;
    const manifestPath = await createRunFromReferences([source], "comfy-exec-error", directory);
    await assert.rejects(() => executeStage(manifestPath, "comfy-prep", { comfyUrl: `http://127.0.0.1:${mock.port}`, allowSpend: true }), /ComfyUI 执行失败/);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.stages["comfy-prep"].status, "FAILED");
    assert.equal(manifest.stages["comfy-prep"].outputs.length, 0);
  } finally {
    await mock.close();
    await rm(directory, { recursive: true, force: true });
  }
});
