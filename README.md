# TA Character Studio

Node-based desktop client for the AI character asset pipeline. Phase 1 provides the independent Tauri application shell, fixed workflow graph, node inspector, log panel, Three.js preview placeholder, and Windows packaging baseline.

## Stage 1 commands

```powershell
npm.cmd install
npm.cmd run check
npm.cmd run build
npm.cmd run bundle
```

`bundle` copies the currently running Windows x64 Node executable into Tauri's generated sidecar location before packaging. The generated executable is ignored by Git, while the MSI/NSIS installers contain it so the installed application will not require a system Node.js runtime.

## Stage boundary

This phase intentionally does not read manifests, call Meshy, run Blender/Unreal, or preview real models. Disabled actions label the phase that implements them. No API key is required and no paid operation is reachable.
