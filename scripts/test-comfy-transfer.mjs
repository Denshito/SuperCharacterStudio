import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { createRunFromReferences, decodePng, executeStage, testComfyTransfer, validateComfyWorkflowNoSpend } from "../pipeline/pipeline.mjs";

const source = path.resolve(process.argv[2] ?? "D:/Comfy-Desktop/ComfyUI-Shared/output/TACharacter/turnaround_00001_.png");
const baseUrl = (process.argv[3] ?? "http://127.0.0.1:8188").replace(/\/+$/, "");
const outputRoot = path.resolve("output/comfy-bridge-transfer");
const runName = `roundtrip-${Date.now().toString(36)}`;
const manifestPath = await createRunFromReferences([source], runName, outputRoot);
const runDir = path.dirname(manifestPath);
const destination = path.join(runDir, "transfer", "roundtrip.png");
const transfer = await testComfyTransfer(source, destination, baseUrl);
const paidWorkflowGate = await validateComfyWorkflowNoSpend(source, baseUrl);
const original = decodePng(await fs.readFile(source));
const roundtrip = decodePng(await fs.readFile(destination));
const pixelHash = (image) => createHash("sha256").update(image.rgba).digest("hex");
if (original.width !== roundtrip.width || original.height !== roundtrip.height || pixelHash(original) !== pixelHash(roundtrip)) throw new Error("Comfy 往返后的图片尺寸或像素不一致。");
await executeStage(manifestPath, "view-split", { inputArtifact: destination });
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
console.log(JSON.stringify({
  status: "PASS",
  source,
  sourceSha256: createHash("sha256").update(await fs.readFile(source)).digest("hex"),
  dimensions: `${original.width}x${original.height}`,
  transfer,
  paidWorkflowGate,
  manifestPath,
  splitOutputs: manifest.stages["view-split"].outputs,
}, null, 2));
