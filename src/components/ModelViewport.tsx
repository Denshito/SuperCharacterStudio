import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { ArtifactInfo } from "../types/manifest";

interface PreviewStats { triangles: number; materials: number; textures: number; bones: number; animations: number; }
const emptyStats: PreviewStats = { triangles: 0, materials: 0, textures: 0, bones: 0, animations: 0 };

function disposeMaterial(material: THREE.Material) {
  // Three.js 不会在移除场景对象时自动释放 GPU 纹理与材质。
  for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
  material.dispose();
}

export function ModelViewport({ artifact, label }: { artifact?: ArtifactInfo; label?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const mixerRef = useRef<THREE.AnimationMixer>();
  const actionRef = useRef<THREE.AnimationAction>();
  const [stats, setStats] = useState(emptyStats);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(true);
  const [loop, setLoop] = useState(true);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);

  useEffect(() => {
    // 每个 artifact 拥有独立的 scene/renderer 生命周期。切换 Idle、Walk 或模型阶段时
    // 完整销毁旧资源，避免反复预览大型 GLB 后显存持续增长。
    const element = host.current;
    if (!element || !artifact?.previewable) return;
    let disposed = false;
    let frame = 0;
    let loadedRoot: THREE.Object3D | undefined;
    let skeleton: THREE.SkeletonHelper | undefined;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x25282d);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    element.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    const grid = new THREE.GridHelper(10, 20, 0x606973, 0x363b42);
    scene.add(grid, new THREE.HemisphereLight(0xffffff, 0x4b5563, 2));
    const key = new THREE.DirectionalLight(0xffffff, 3);
    key.position.set(4, 7, 5);
    scene.add(key);
    const resize = () => {
      const width = Math.max(element.clientWidth, 1);
      const height = Math.max(element.clientHeight, 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    const clock = new THREE.Clock();
    const render = () => {
      if (disposed) return;
      frame = requestAnimationFrame(render);
      const delta = Math.min(clock.getDelta(), 0.05);
      if (mixerRef.current && !actionRef.current?.paused) {
        mixerRef.current.update(delta);
        setTime(mixerRef.current.time % Math.max(actionRef.current?.getClip().duration ?? 0.001, 0.001));
      }
      controls.update();
      renderer.render(scene, camera);
    };
    setLoading(true);
    setError("");
    setStats(emptyStats);
    invoke<ArrayBuffer | number[]>("read_artifact", { artifactId: artifact.id })
      .then((payload) => {
        // 前端只提交 artifact ID；实际路径由 Rust 的当前 ProjectSession 决定。
        if (disposed) return;
        const bytes = payload instanceof ArrayBuffer ? payload : new Uint8Array(payload).buffer;
        new GLTFLoader().parse(bytes, "", (gltf) => {
          if (disposed) return;
          loadedRoot = gltf.scene;
          scene.add(loadedRoot);
          const materials = new Set<THREE.Material>();
          const textures = new Set<THREE.Texture>();
          let triangles = 0;
          let bones = 0;
          let hasSkin = false;
          loadedRoot.traverse((object) => {
            if (object instanceof THREE.Bone) bones += 1;
            if (object instanceof THREE.SkinnedMesh) hasSkin = true;
            if (!(object instanceof THREE.Mesh)) return;
            const geometry = object.geometry;
            triangles += geometry.index ? geometry.index.count / 3 : (geometry.attributes.position?.count ?? 0) / 3;
            const list = Array.isArray(object.material) ? object.material : [object.material];
            for (const material of list) {
              materials.add(material);
              for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
            }
          });
          if (hasSkin) { skeleton = new THREE.SkeletonHelper(loadedRoot); scene.add(skeleton); }
          const box = new THREE.Box3().setFromObject(loadedRoot);
          const center = box.getCenter(new THREE.Vector3());
          const size = Math.max(box.getSize(new THREE.Vector3()).length(), 0.1);
          controls.target.copy(center);
          camera.position.copy(center).add(new THREE.Vector3(size * 0.65, size * 0.35, size * 0.9));
          camera.near = Math.max(size / 1000, 0.001);
          camera.far = size * 100;
          camera.updateProjectionMatrix();
          if (gltf.animations.length) {
            // 当前产物约定每个 GLB 只交付一个主动作；多动作选择由产物下拉框完成。
            const mixer = new THREE.AnimationMixer(loadedRoot);
            const action = mixer.clipAction(gltf.animations[0]);
            action.play();
            mixerRef.current = mixer;
            actionRef.current = action;
            setDuration(gltf.animations[0].duration);
          } else {
            mixerRef.current = undefined;
            actionRef.current = undefined;
            setDuration(0);
          }
          setStats({ triangles: Math.round(triangles), materials: materials.size, textures: textures.size, bones, animations: gltf.animations.length });
          setLoading(false);
        }, (reason) => { setError(`模型解析失败：${String(reason)}`); setLoading(false); });
      })
      .catch((reason) => { if (!disposed) { setError(String(reason)); setLoading(false); } });
    render();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      mixerRef.current?.stopAllAction();
      if (loadedRoot) loadedRoot.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const list = Array.isArray(object.material) ? object.material : [object.material];
          list.forEach(disposeMaterial);
        }
      });
      skeleton?.geometry.dispose();
      (skeleton?.material as THREE.Material | undefined)?.dispose();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      mixerRef.current = undefined;
      actionRef.current = undefined;
    };
  }, [artifact?.id, artifact?.previewable]);

  useEffect(() => {
    if (actionRef.current) actionRef.current.paused = !playing;
  }, [playing]);

  useEffect(() => {
    const action = actionRef.current;
    if (!action) return;
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
  }, [loop]);

  const seek = (next: number) => {
    mixerRef.current?.setTime(next);
    setTime(next);
  };

  return (
    <section className="model-viewport">
      <div className="viewport-label">{label ?? artifact?.fileName ?? "3D 预览"}</div>
      <div className="viewport-canvas" ref={host}>
        {!artifact && <div className="viewport-message">选择一个 GLB 产物开始预览</div>}
        {artifact && !artifact.previewable && <div className="viewport-message">此格式仅支持导出和打开目录</div>}
        {loading && <div className="viewport-message">正在加载模型…</div>}
        {error && <div className="viewport-message error">{error}</div>}
      </div>
      <div className="viewport-stats">
        <span>三角面 {stats.triangles.toLocaleString()}</span><span>材质 {stats.materials}</span><span>纹理 {stats.textures}</span><span>骨骼 {stats.bones}</span><span>动画 {stats.animations}</span>
      </div>
      {duration > 0 && <div className="playback">
        <button onClick={() => setPlaying((value) => !value)}>{playing ? "暂停" : "播放"}</button>
        <input aria-label="动画时间轴" type="range" min="0" max={duration} step="0.01" value={Math.min(time, duration)} onChange={(event) => seek(Number(event.target.value))} />
        <label><input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} /> 循环</label>
      </div>}
    </section>
  );
}
