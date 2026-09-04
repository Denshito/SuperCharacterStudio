import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(`Stage 1 packaging supports Windows x64, received ${process.platform}/${process.arch}`);
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binaryDir = path.join(projectRoot, "src-tauri", "binaries");
const destination = path.join(binaryDir, "node-x86_64-pc-windows-msvc.exe");

await mkdir(binaryDir, { recursive: true });
await copyFile(process.execPath, destination);

const copied = await stat(destination);
if (copied.size < 10_000_000) {
  throw new Error(`Copied Node sidecar is unexpectedly small: ${copied.size} bytes`);
}

console.log(`Prepared Node sidecar: ${destination} (${copied.size} bytes)`);
