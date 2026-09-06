import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { ArtifactInfo } from "../types/manifest";

export function ImageViewport({ artifact, cuts, onCutsChange, label }: { artifact?: ArtifactInfo; cuts?: [number, number]; onCutsChange?: (cuts: [number, number]) => void; label?: string }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let objectUrl = "";
    setUrl(""); setError("");
    if (!artifact?.exists) return;
    invoke<ArrayBuffer | number[]>("read_artifact", { artifactId: artifact.id }).then((payload) => {
      const bytes = payload instanceof ArrayBuffer ? payload : new Uint8Array(payload).buffer;
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: artifact.extension === "png" ? "image/png" : "image/jpeg" }));
      setUrl(objectUrl);
    }).catch((reason) => setError(String(reason)));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [artifact]);
  const drag = (index: 0 | 1, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!cuts || !onCutsChange) return;
    const frame = event.currentTarget.parentElement;
    if (!frame) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      const value = Math.max(0.11, Math.min(0.89, (next.clientX - frame.getBoundingClientRect().left) / frame.clientWidth));
      onCutsChange(index === 0 ? [Math.min(value, cuts[1] - 0.11), cuts[1]] : [cuts[0], Math.max(value, cuts[0] + 0.11)]);
    };
    const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop, { once: true });
  };
  return <div className="image-viewport">{url ? <figure className="image-frame"><img src={url} alt={artifact?.fileName ?? "参考图"} />{label && <figcaption>{label}</figcaption>}{cuts?.map((cut, index) => <button key={index} className="crop-line" style={{ left: `${cut * 100}%` }} aria-label={`拖动第 ${index + 1} 条切分线`} onPointerDown={(event) => drag(index as 0 | 1, event)} />)}</figure> : <p>{error || "请选择图片产物"}</p>}</div>;
}
