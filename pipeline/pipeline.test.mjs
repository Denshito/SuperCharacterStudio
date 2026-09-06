import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { approveReferences, collectAssetUrls, createRun, createRunFromReferences, encodePng, executeStage, mimeFor, splitPng, taskSnapshot, upgradeManifest } from "./pipeline.mjs";

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
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(modelPath, Buffer.from("local-glb"));
  try {
    process.env.TA_PIPELINE_MOCK = "1";
    await executeStage(manifestPath, "remesh", { inputArtifact: modelPath });
    await executeStage(manifestPath, "remesh", { inputArtifact: modelPath });
    const reused = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(reused.stages.remesh.status, "SUCCEEDED");
    assert.equal(reused.stages.remesh.taskId, "mock-remesh-task");
    assert.equal(reused.stages.remesh.previousAttempts, undefined);
    await writeFile(modelPath, Buffer.from("changed-local-glb"));
    await executeStage(manifestPath, "remesh", { inputArtifact: modelPath });
    const replaced = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(replaced.stages.remesh.previousAttempts.length, 1);
  } finally {
    delete process.env.TA_PIPELINE_MOCK;
    await rm(directory, { recursive: true, force: true });
  }
});
