import { useMemo, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { PipelineNodeCard } from "./components/PipelineNodeCard";
import { starterEdges, starterNodes } from "./data/starterGraph";
import type { PipelineNode } from "./types/pipeline";
import "./styles.css";

const nodeTypes = { pipeline: PipelineNodeCard };

function App() {
  const [nodes, , onNodesChange] = useNodesState<PipelineNode>(starterNodes);
  const [edges, , onEdgesChange] = useEdgesState(starterEdges);
  const [selectedId, setSelectedId] = useState("generate");
  const selected = useMemo(
    () => nodes.find((item) => item.id === selectedId) ?? nodes[0],
    [nodes, selectedId],
  );

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <p className="eyebrow">AI CHARACTER PIPELINE</p>
          <h1>TA Character Studio</h1>
        </div>
        <div className="top-actions">
          <span className="phase-badge">PHASE 1 · UI FOUNDATION</span>
          <button disabled title="Manifest loading is implemented in Phase 2">Open Project</button>
          <button className="primary" disabled title="Pipeline execution is implemented in Phase 3">Run</button>
        </div>
      </header>

      <section className="workspace">
        <aside className="node-library panel">
          <div className="panel-title">
            <span>Node Library</span>
            <b>{nodes.length}</b>
          </div>
          {nodes.map((item) => (
            <button key={item.id} className="library-item" onClick={() => setSelectedId(item.id)}>
              <span>{item.data.title}</span>
              <small>{item.data.category}</small>
            </button>
          ))}
        </aside>

        <section className="graph-panel" aria-label="Character pipeline node graph">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_, item) => setSelectedId(item.id)}
            fitView
            fitViewOptions={{ padding: 0.18 }}
            minZoom={0.35}
            maxZoom={1.6}
            nodesConnectable={false}
            deleteKeyCode={null}
          >
            <Background color="#28354a" gap={24} size={1} />
            <MiniMap pannable zoomable nodeColor="#61718a" maskColor="rgba(7, 11, 18, 0.72)" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </section>

        <aside className="inspector panel">
          <div className="panel-title"><span>Inspector</span></div>
          <p className="eyebrow">{selected.data.category} NODE</p>
          <h2>{selected.data.title}</h2>
          <p className="description">{selected.data.description}</p>
          <dl>
            <div><dt>Status</dt><dd>{selected.data.status}</dd></div>
            <div><dt>Input</dt><dd>{selected.data.input ?? "None"}</dd></div>
            <div><dt>Output</dt><dd>{selected.data.output ?? "None"}</dd></div>
          </dl>
          <button className="wide" disabled title="Node execution is implemented in Phase 3">Run Selected</button>
          <div className="preview-placeholder">
            <span>3D</span>
            <strong>Artifact Preview</strong>
            <small>Three.js model preview arrives in Phase 2</small>
          </div>
        </aside>
      </section>

      <section className="log-panel panel">
        <div className="panel-title"><span>Execution Log</span><b>LOCAL</b></div>
        <code><i /> Application shell ready. No API key required. No paid tasks can run in Phase 1.</code>
      </section>

      <footer className="status-bar">
        <span><i className="ready-dot" /> Ready</span>
        <span>Fixed graph · Drag nodes to arrange · Scroll to zoom</span>
      </footer>
    </main>
  );
}

export default App;
