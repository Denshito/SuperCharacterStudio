use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
    sync::Mutex,
};
use tauri::{ipc::Response, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

#[derive(Default)]
struct ProjectSession(Mutex<HashMap<String, PathBuf>>);

#[derive(Default)]
struct SelectedManifest(Mutex<Option<PathBuf>>);

#[derive(Default, Clone)]
struct DraftSelection {
    front: Option<PathBuf>,
    back: Option<PathBuf>,
    output_root: Option<PathBuf>,
}

#[derive(Default)]
struct DraftProject(Mutex<DraftSelection>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DraftFile {
    id: String,
    file_name: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphEdge {
    id: String,
    source: String,
    target: String,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectGraph {
    version: u8,
    #[serde(default)]
    edges: Vec<GraphEdge>,
    #[serde(default)]
    imports: Vec<String>,
    #[serde(default)]
    stale_node_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadedGraph {
    edges: Vec<GraphEdge>,
    artifacts: Vec<ArtifactInfo>,
    stale_node_ids: Vec<String>,
}

#[derive(Default)]
// ponytail: one active child per desktop app; add per-project children only when parallel runs are required.
struct PipelineProcess(Mutex<Option<CommandChild>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessLine {
    stream: String,
    line: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u8,
    run_id: String,
    status: String,
    #[serde(default)]
    input: HashMap<String, ManifestOutput>,
    stages: HashMap<String, ManifestStage>,
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestStage {
    status: String,
    #[serde(default)]
    task_id: Option<String>,
    #[serde(default)]
    progress: Option<f64>,
    #[serde(default)]
    consumed_credits: Option<f64>,
    #[serde(default)]
    outputs: Vec<ManifestOutput>,
    #[serde(default)]
    error: serde_json::Value,
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
}

#[derive(Clone, Deserialize)]
struct ManifestOutput {
    path: String,
    #[serde(default)]
    bytes: Option<u64>,
    #[serde(default)]
    sha256: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactInfo {
    id: String,
    stage: String,
    file_name: String,
    extension: String,
    bytes: Option<u64>,
    sha256: Option<String>,
    exists: bool,
    previewable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadedProject {
    manifest_path: String,
    manifest: serde_json::Value,
    artifacts: Vec<ArtifactInfo>,
}

fn resolve_listed_path(manifest_path: &Path, listed: &str) -> Result<PathBuf, String> {
    let relative = Path::new(listed);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(format!("产物路径不安全：{listed}"));
    }

    let manifest_dir = manifest_path.parent().ok_or("Manifest 没有有效目录")?;
    for base in manifest_dir.ancestors().take(3) {
        let candidate = base.join(relative);
        if candidate.is_file() {
            let canonical_base = base
                .canonicalize()
                .map_err(|error| format!("无法验证项目目录：{error}"))?;
            let canonical_file = candidate
                .canonicalize()
                .map_err(|error| format!("无法读取产物 {listed}：{error}"))?;
            if canonical_file.starts_with(canonical_base) {
                return Ok(canonical_file);
            }
        }
    }
    Err(format!("找不到产物：{listed}"))
}

fn artifact_info(
    id: String,
    stage: String,
    output: &ManifestOutput,
    path: Option<&Path>,
) -> ArtifactInfo {
    let listed = Path::new(&output.path);
    let extension = listed
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    ArtifactInfo {
        id,
        stage,
        file_name: listed
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&output.path)
            .to_string(),
        extension: extension.clone(),
        bytes: path
            .and_then(|value| value.metadata().ok().map(|metadata| metadata.len()))
            .or(output.bytes),
        sha256: output.sha256.clone(),
        exists: path.is_some(),
        previewable: matches!(extension.as_str(), "glb" | "png" | "jpg" | "jpeg") && path.is_some(),
    }
}

fn load_manifest(path: &Path, session: &ProjectSession) -> Result<LoadedProject, String> {
    let text = fs::read_to_string(&path).map_err(|error| format!("无法读取 Manifest：{error}"))?;
    let raw: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("Manifest JSON 已损坏：{error}"))?;
    let manifest: Manifest = serde_json::from_value(raw.clone())
        .map_err(|error| format!("Manifest 结构无效：{error}"))?;
    if manifest.version != 2 {
        return Err(format!(
            "仅支持 v2 Manifest，当前版本为 {}",
            manifest.version
        ));
    }
    if manifest.run_id.trim().is_empty() || manifest.status.trim().is_empty() {
        return Err("Manifest 缺少 runId 或 status".into());
    }

    // Reading these fields here makes the Rust parser reject malformed stage objects while
    // keeping the original JSON intact for the technical details panel.
    for stage in manifest.stages.values() {
        let _ = (
            &stage.status,
            &stage.task_id,
            stage.progress,
            stage.consumed_credits,
            &stage.error,
            &stage.extra,
        );
    }
    let _ = &manifest.extra;

    let mut approved = HashMap::new();
    let mut artifacts = Vec::new();
    for (name, output) in &manifest.input {
        let id = format!("input:{name}");
        let resolved = resolve_listed_path(&path, &output.path).ok();
        if let Some(value) = &resolved {
            approved.insert(id.clone(), value.clone());
        }
        artifacts.push(artifact_info(
            id,
            "reference".into(),
            output,
            resolved.as_deref(),
        ));
    }
    for (stage_name, stage) in &manifest.stages {
        for (index, output) in stage.outputs.iter().enumerate() {
            let id = format!("{stage_name}:{index}");
            let resolved = resolve_listed_path(&path, &output.path).ok();
            if let Some(value) = &resolved {
                approved.insert(id.clone(), value.clone());
            }
            artifacts.push(artifact_info(
                id,
                stage_name.clone(),
                output,
                resolved.as_deref(),
            ));
        }
    }
    *session.0.lock().map_err(|_| "项目会话不可用")? = approved;

    Ok(LoadedProject {
        manifest_path: path.to_string_lossy().into_owned(),
        manifest: raw,
        artifacts,
    })
}

#[tauri::command]
fn pick_manifest(
    app: tauri::AppHandle,
    session: State<ProjectSession>,
    selected: State<SelectedManifest>,
) -> Result<Option<LoadedProject>, String> {
    let Some(file) = app
        .dialog()
        .file()
        .add_filter("TA Character manifest", &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|error| format!("无法打开所选文件：{error}"))?;
    let project = load_manifest(&path, &session)?;
    *selected.0.lock().map_err(|_| "项目会话不可用")? = Some(path);
    Ok(Some(project))
}

#[tauri::command]
fn refresh_manifest(
    session: State<ProjectSession>,
    selected: State<SelectedManifest>,
) -> Result<LoadedProject, String> {
    let path = selected
        .0
        .lock()
        .map_err(|_| "项目会话不可用")?
        .clone()
        .ok_or("尚未打开 Manifest")?;
    load_manifest(&path, &session)
}

fn approved_path(session: &State<ProjectSession>, artifact_id: &str) -> Result<PathBuf, String> {
    let approved = session.0.lock().map_err(|_| "项目会话不可用")?;
    let path = approved_from(&approved, artifact_id)?;
    if !path.is_file() {
        return Err("产物已被移动或删除，请重新打开项目".into());
    }
    Ok(path)
}

fn approved_from(
    approved: &HashMap<String, PathBuf>,
    artifact_id: &str,
) -> Result<PathBuf, String> {
    approved
        .get(artifact_id)
        .cloned()
        .ok_or_else(|| "产物 ID 未获当前项目授权，或文件已缺失".into())
}

#[tauri::command]
fn read_artifact(session: State<ProjectSession>, artifact_id: String) -> Result<Response, String> {
    let path = approved_path(&session, &artifact_id)?;
    let bytes = fs::read(path).map_err(|error| format!("读取产物失败：{error}"))?;
    Ok(Response::new(bytes))
}

#[tauri::command]
fn export_artifact(
    app: tauri::AppHandle,
    session: State<ProjectSession>,
    artifact_id: String,
) -> Result<bool, String> {
    let source = approved_path(&session, &artifact_id)?;
    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("产物文件名无效")?;
    let Some(target) = app
        .dialog()
        .file()
        .set_file_name(file_name)
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let target = target
        .into_path()
        .map_err(|error| format!("导出路径无效：{error}"))?;
    fs::copy(source, target).map_err(|error| format!("导出产物失败：{error}"))?;
    Ok(true)
}

#[tauri::command]
fn reveal_artifact(session: State<ProjectSession>, artifact_id: String) -> Result<(), String> {
    let path = approved_path(&session, &artifact_id)?;
    Command::new("explorer.exe")
        .arg(format!("/select,{}", path.display()))
        .spawn()
        .map_err(|error| format!("无法打开所在目录：{error}"))?;
    Ok(())
}

fn selected_manifest(selected: &SelectedManifest) -> Result<PathBuf, String> {
    selected
        .0
        .lock()
        .map_err(|_| "项目会话不可用")?
        .clone()
        .ok_or_else(|| "请先打开或新建工程".into())
}

fn graph_path(selected: &SelectedManifest) -> Result<PathBuf, String> {
    Ok(selected_manifest(selected)?
        .parent()
        .ok_or("Manifest 没有有效目录")?
        .join("project.json"))
}

fn read_graph(path: &Path) -> Result<ProjectGraph, String> {
    if !path.exists() {
        return Ok(ProjectGraph {
            version: 1,
            ..Default::default()
        });
    }
    let graph: ProjectGraph = serde_json::from_str(
        &fs::read_to_string(path).map_err(|error| format!("无法读取 project.json：{error}"))?,
    )
    .map_err(|error| format!("project.json 已损坏：{error}"))?;
    if graph.version != 1 {
        return Err(format!("不支持 project.json v{}", graph.version));
    }
    Ok(graph)
}

fn write_graph(path: &Path, graph: &ProjectGraph) -> Result<(), String> {
    fs::write(
        path,
        serde_json::to_vec_pretty(graph).map_err(|error| format!("无法编码节点图：{error}"))?,
    )
    .map_err(|error| format!("无法保存节点图：{error}"))
}

#[tauri::command]
fn load_project_graph(
    selected: State<SelectedManifest>,
    session: State<ProjectSession>,
) -> Result<LoadedGraph, String> {
    let path = graph_path(&selected)?;
    let graph = read_graph(&path)?;
    let run_dir = path.parent().ok_or("工程目录无效")?;
    let canonical_run = run_dir
        .canonicalize()
        .map_err(|error| format!("无法验证工程目录：{error}"))?;
    let mut artifacts = Vec::new();
    let mut approved = session.0.lock().map_err(|_| "项目会话不可用")?;
    for listed in &graph.imports {
        let relative = Path::new(listed);
        if relative.is_absolute()
            || relative
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(format!("导入模型路径不安全：{listed}"));
        }
        let resolved = run_dir
            .join(relative)
            .canonicalize()
            .map_err(|_| format!("导入模型已移动或删除：{listed}"))?;
        if !resolved.starts_with(&canonical_run) || !resolved.is_file() {
            return Err(format!("导入模型不在工程目录内：{listed}"));
        }
        let id = format!("imported:{listed}");
        approved.insert(id.clone(), resolved.clone());
        let output = ManifestOutput {
            path: listed.clone(),
            bytes: None,
            sha256: None,
        };
        artifacts.push(artifact_info(id.clone(), id, &output, Some(&resolved)));
    }
    Ok(LoadedGraph {
        edges: graph.edges,
        artifacts,
        stale_node_ids: graph.stale_node_ids,
    })
}

#[tauri::command]
fn save_project_graph(
    selected: State<SelectedManifest>,
    edges: Vec<GraphEdge>,
    stale_node_ids: Vec<String>,
) -> Result<(), String> {
    let path = graph_path(&selected)?;
    let mut graph = read_graph(&path)?;
    graph.edges = edges;
    graph.stale_node_ids = stale_node_ids;
    write_graph(&path, &graph)
}

#[tauri::command]
fn set_view_split(
    selected: State<SelectedManifest>,
    cuts: Vec<f64>,
    order: Vec<String>,
) -> Result<(), String> {
    if cuts.len() != 2
        || !(0.1..0.9).contains(&cuts[0])
        || !(0.1..0.9).contains(&cuts[1])
        || cuts[1] - cuts[0] <= 0.1
    {
        return Err("切分线必须从左到右，并为每个视图保留足够宽度".into());
    }
    let mut sorted = order.clone();
    sorted.sort();
    if sorted != ["back", "front", "side"] {
        return Err("视图顺序必须包含 front、side、back".into());
    }
    let path = selected_manifest(&selected)?;
    let mut manifest: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&path).map_err(|error| format!("无法读取 Manifest：{error}"))?,
    )
    .map_err(|error| format!("Manifest JSON 已损坏：{error}"))?;
    manifest["config"]["view_split"] = serde_json::json!({ "cuts": cuts, "order": order });
    for name in ["view-split", "reference-approval", "generation", "remesh", "rigging", "animation", "normalize", "ue-import"] {
        if let Some(stage) = manifest["stages"].get_mut(name) {
            let status = stage["status"].as_str().unwrap_or("NOT_STARTED");
            if status != "NOT_STARTED" { stage["status"] = "STALE".into(); }
        }
    }
    fs::write(&path, serde_json::to_vec_pretty(&manifest).map_err(|error| format!("无法编码 Manifest：{error}"))?)
        .map_err(|error| format!("无法保存切分设置：{error}"))
}

#[tauri::command]
fn pick_reference(
    app: tauri::AppHandle,
    draft: State<DraftProject>,
    session: State<ProjectSession>,
    slot: String,
) -> Result<Option<DraftFile>, String> {
    if !matches!(slot.as_str(), "front" | "back") {
        return Err("参考图位置无效".into());
    }
    let Some(file) = app
        .dialog()
        .file()
        .add_filter("角色参考图", &["png", "jpg", "jpeg"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|error| format!("参考图路径无效：{error}"))?
        .canonicalize()
        .map_err(|error| format!("无法读取参考图：{error}"))?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg") || !path.is_file() {
        return Err("请选择有效的 PNG 或 JPG 图片".into());
    }
    let id = format!("draft:{slot}");
    session
        .0
        .lock()
        .map_err(|_| "项目会话不可用")?
        .insert(id.clone(), path.clone());
    let mut selection = draft.0.lock().map_err(|_| "新建项目会话不可用")?;
    if slot == "front" {
        selection.front = Some(path.clone());
    } else {
        selection.back = Some(path.clone());
    }
    Ok(Some(DraftFile {
        id,
        file_name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("reference")
            .to_string(),
    }))
}

#[tauri::command]
fn pick_output_root(
    app: tauri::AppHandle,
    draft: State<DraftProject>,
) -> Result<Option<String>, String> {
    let Some(folder) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = folder
        .into_path()
        .map_err(|error| format!("输出目录无效：{error}"))?
        .canonicalize()
        .map_err(|error| format!("无法访问输出目录：{error}"))?;
    draft
        .0
        .lock()
        .map_err(|_| "新建项目会话不可用")?
        .output_root = Some(path.clone());
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn import_mesh(
    app: tauri::AppHandle,
    session: State<ProjectSession>,
    selected: State<SelectedManifest>,
) -> Result<Option<ArtifactInfo>, String> {
    let Some(file) = app
        .dialog()
        .file()
        .add_filter("GLB 模型", &["glb"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|error| format!("模型路径无效：{error}"))?
        .canonicalize()
        .map_err(|error| format!("无法读取模型：{error}"))?;
    if !path.is_file()
        || path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| !value.eq_ignore_ascii_case("glb"))
            .unwrap_or(true)
    {
        return Err("请选择有效的 GLB 文件".into());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "系统时间无效")?
        .as_millis();
    let graph_file = graph_path(&selected)?;
    let run_dir = graph_file.parent().ok_or("工程目录无效")?;
    let import_dir = run_dir.join("imports");
    fs::create_dir_all(&import_dir).map_err(|error| format!("无法创建导入目录：{error}"))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("model.glb");
    let listed = format!("imports/{stamp}-{file_name}");
    let copied = run_dir.join(&listed);
    fs::copy(&path, &copied).map_err(|error| format!("无法复制模型到工程：{error}"))?;
    let id = format!("imported:{listed}");
    session
        .0
        .lock()
        .map_err(|_| "项目会话不可用")?
        .insert(id.clone(), copied.clone());
    let mut graph = read_graph(&graph_file)?;
    graph.imports.push(listed.clone());
    write_graph(&graph_file, &graph)?;
    let output = ManifestOutput {
        path: listed,
        bytes: None,
        sha256: None,
    };
    Ok(Some(artifact_info(id.clone(), id, &output, Some(&copied))))
}

fn valid_run_name(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.len() <= 64
        && trimmed != "."
        && trimmed != ".."
        && trimmed
            .chars()
            .all(|character| character.is_alphanumeric() || matches!(character, '-' | '_' | '.'))
}

fn validated_file(
    value: Option<String>,
    fallback: &str,
    expected_name: &str,
) -> Result<PathBuf, String> {
    let path = PathBuf::from(
        value
            .filter(|item| !item.trim().is_empty())
            .unwrap_or_else(|| fallback.into()),
    )
    .canonicalize()
    .map_err(|error| format!("找不到 {expected_name}：{error}"))?;
    if !path.is_file()
        || !path
            .file_name()
            .and_then(|item| item.to_str())
            .map(|item| item.eq_ignore_ascii_case(expected_name))
            .unwrap_or(false)
    {
        return Err(format!("请选择有效的 {expected_name}"));
    }
    Ok(path)
}

fn validated_project(value: Option<String>) -> Result<PathBuf, String> {
    let path = PathBuf::from(
        value
            .filter(|item| !item.trim().is_empty())
            .unwrap_or_else(|| "E:/AIEval/Eval_Commiting/Eval_Commiting.uproject".into()),
    )
    .canonicalize()
    .map_err(|error| format!("找不到 Unreal 工程：{error}"))?;
    if !path.is_file()
        || !path
            .extension()
            .and_then(|item| item.to_str())
            .map(|item| item.eq_ignore_ascii_case("uproject"))
            .unwrap_or(false)
    {
        return Err("请选择有效的 .uproject 文件".into());
    }
    Ok(path)
}

fn pipeline_script(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法定位应用资源：{error}"))?
        .join("pipeline/pipeline.mjs");
    if bundled.is_file() {
        return Ok(bundled);
    }
    #[cfg(debug_assertions)]
    {
        let development = Path::new(env!("CARGO_MANIFEST_DIR")).join("../pipeline/pipeline.mjs");
        if development.is_file() {
            return development
                .canonicalize()
                .map_err(|error| format!("无法定位开发管线：{error}"));
        }
    }
    Err("安装包中缺少 pipeline.mjs，请重新安装客户端".into())
}

#[tauri::command]
fn start_pipeline(
    app: tauri::AppHandle,
    process: State<PipelineProcess>,
    selected: State<SelectedManifest>,
    draft: State<DraftProject>,
    operation: String,
    stage: Option<String>,
    run_name: Option<String>,
    confirm_spend: bool,
    api_key: Option<String>,
    openai_api_key: Option<String>,
    mock: bool,
    input_artifact_id: Option<String>,
    blender_path: Option<String>,
    ue_path: Option<String>,
    ue_project: Option<String>,
    target_height: Option<f64>,
    root_correction: Option<String>,
    pelvis_correction: Option<String>,
    reference_front_id: Option<String>,
    reference_side_id: Option<String>,
    reference_back_id: Option<String>,
    image_preset: Option<String>,
    image_quality: Option<String>,
    image_background: Option<String>,
    image_prompt: Option<String>,
) -> Result<(), String> {
    if process.0.lock().map_err(|_| "管线进程不可用")?.is_some() {
        return Err("已有节点正在运行，请先停止或等待完成".into());
    }
    if !matches!(operation.as_str(), "init" | "execute" | "resume" | "check" | "approve-references") {
        return Err("不支持的管线操作".into());
    }
    if !matches!(operation.as_str(), "check" | "init" | "approve-references")
        && !matches!(
            stage.as_deref(),
            Some("image-turnaround" | "view-split" | "generation" | "remesh" | "rigging" | "animation" | "normalize" | "ue-import")
        )
    {
        return Err("请选择可执行的 Meshy 阶段".into());
    }

    let script = pipeline_script(&app)?;
    let mut args = vec![script.to_string_lossy().into_owned(), operation.clone()];
    if operation == "check" {
        args.push("--json".into());
    } else if operation == "init" {
        let name = run_name.ok_or("请输入工程名称")?;
        if !valid_run_name(&name) {
            return Err("工程名称只能包含中英文、数字、点、横线和下划线，且不超过 64 字符".into());
        }
        let selection = draft.0.lock().map_err(|_| "新建项目会话不可用")?.clone();
        let front = selection.front.ok_or("请至少选择一张参考图")?;
        let root = selection.output_root.ok_or("请选择工程保存位置")?;
        let manifest = root.join("output").join(name.trim()).join("manifest.json");
        if manifest.exists() {
            return Err("同名工程已经存在，请更换名称".into());
        }
        args.extend([
            "--run-name".into(),
            name.trim().to_string(),
            "--reference".into(),
            front.to_string_lossy().into_owned(),
            "--output-root".into(),
            root.to_string_lossy().into_owned(),
            "--json".into(),
        ]);
        if let Some(back) = selection.back {
            args.extend(["--reference".into(), back.to_string_lossy().into_owned()]);
        }
        *selected.0.lock().map_err(|_| "项目会话不可用")? = Some(manifest);
    } else if operation == "approve-references" {
        let manifest = selected_manifest(&selected)?;
        args.extend(["--manifest".into(), manifest.to_string_lossy().into_owned(), "--json".into()]);
        for (flag, id, required) in [("--front", reference_front_id, true), ("--side", reference_side_id, false), ("--back", reference_back_id, true)] {
            let Some(id) = id else { if required { return Err("美术确认至少需要正面图和背面图".into()); } else { continue; } };
            let path = approved_path(&app.state::<ProjectSession>(), &id)?;
            let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_lowercase();
            if !matches!(extension.as_str(), "png" | "jpg" | "jpeg") { return Err("美术确认只接受已授权的 PNG/JPG 产物".into()); }
            let stage_token = if let Some((stage, index)) = id.rsplit_once(':') { if index.parse::<usize>().is_ok() { format!("{stage}:{index}") } else { return Err("参考图产物 ID 无效".into()); } } else { return Err("参考图产物 ID 无效".into()); };
            args.extend([flag.into(), stage_token]);
        }
    } else {
        let manifest = selected
            .0
            .lock()
            .map_err(|_| "项目会话不可用")?
            .clone()
            .ok_or("请先打开一个 Manifest")?;
        let stage_name = stage.unwrap();
        args.extend([
            stage_name.clone(),
            "--manifest".into(),
            manifest.to_string_lossy().into_owned(),
            "--json".into(),
        ]);
        if let Some(id) = input_artifact_id {
            let input = approved_path(&app.state::<ProjectSession>(), &id)?;
            if input
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| !value.eq_ignore_ascii_case("glb"))
                .unwrap_or(true)
            {
                return Err("Remesh/Rigging 的本地输入必须是 GLB".into());
            }
            if !matches!(stage_name.as_str(), "remesh" | "rigging") {
                return Err("只有 Remesh 和 Rigging 可以使用本地 GLB 输入".into());
            }
            args.extend([
                "--input-artifact".into(),
                input.to_string_lossy().into_owned(),
            ]);
        }
        if stage_name == "normalize" {
            let blender = validated_file(blender_path, "D:/Blender/blender.exe", "blender.exe")?;
            let height = target_height.unwrap_or(1.6);
            if !(0.5..=3.0).contains(&height) {
                return Err("目标身高必须在 0.5 到 3.0 米之间".into());
            }
            args.extend([
                "--tool-path".into(),
                blender.to_string_lossy().into_owned(),
                "--height".into(),
                height.to_string(),
                "--root-correction".into(),
                root_correction.unwrap_or_else(|| "0,0,0".into()),
                "--pelvis-correction".into(),
                pelvis_correction.unwrap_or_else(|| "0,0,0".into()),
            ]);
        }
        if stage_name == "image-turnaround" {
            let preset = image_preset.unwrap_or_else(|| "turnaround".into());
            let quality = image_quality.unwrap_or_else(|| "low".into());
            let background = image_background.unwrap_or_else(|| "opaque".into());
            let prompt = image_prompt.unwrap_or_default();
            if !matches!(preset.as_str(), "turnaround" | "complete-views" | "clean-pose")
                || !matches!(quality.as_str(), "low" | "medium")
                || !matches!(background.as_str(), "opaque" | "transparent" | "auto")
                || prompt.len() > 4000
            {
                return Err("三视图生成参数无效".into());
            }
            args.extend(["--image-preset".into(), preset, "--image-quality".into(), quality, "--image-background".into(), background, "--image-prompt".into(), prompt]);
        }
        if stage_name == "ue-import" {
            let unreal = validated_file(
                ue_path,
                "D:/UE/UE_5.4/Engine/Binaries/Win64/UnrealEditor-Cmd.exe",
                "UnrealEditor-Cmd.exe",
            )?;
            let project = validated_project(ue_project)?;
            args.extend([
                "--tool-path".into(),
                unreal.to_string_lossy().into_owned(),
                "--ue-project".into(),
                project.to_string_lossy().into_owned(),
            ]);
        }
        if confirm_spend && operation == "execute" {
            args.push("--confirm-spend".into());
        }
    }
    if mock {
        args.push("--mock".into());
    }

    let mut command = app
        .shell()
        .sidecar("node")
        .map_err(|error| format!("无法启动 Node sidecar：{error}"))?
        .args(args);
    if let Some(key) = api_key.filter(|value| !value.trim().is_empty()) {
        command = command.env("MESHY_API_KEY", key);
    }
    if let Some(key) = openai_api_key.filter(|value| !value.trim().is_empty()) {
        command = command.env("OPENAI_API_KEY", key);
    }
    let (mut events, child) = command
        .spawn()
        .map_err(|error| format!("启动管线失败：{error}"))?;
    *process.0.lock().map_err(|_| "管线进程不可用")? = Some(child);

    let event_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            let payload = match event {
                CommandEvent::Stdout(bytes) => ProcessLine {
                    stream: "stdout".into(),
                    line: String::from_utf8_lossy(&bytes).into_owned(),
                },
                CommandEvent::Stderr(bytes) => ProcessLine {
                    stream: "stderr".into(),
                    line: String::from_utf8_lossy(&bytes).into_owned(),
                },
                CommandEvent::Terminated(status) => ProcessLine {
                    stream: "exit".into(),
                    line: serde_json::json!({ "type": "process-exit", "code": status.code })
                        .to_string(),
                },
                CommandEvent::Error(error) => ProcessLine {
                    stream: "error".into(),
                    line: serde_json::json!({ "type": "error", "message": error }).to_string(),
                },
                _ => continue,
            };
            let _ = event_app.emit("pipeline-event", payload);
        }
        if let Ok(mut slot) = event_app.state::<PipelineProcess>().0.lock() {
            *slot = None;
        }
    });
    Ok(())
}

#[tauri::command]
fn stop_pipeline(app: tauri::AppHandle, process: State<PipelineProcess>) -> Result<bool, String> {
    let Some(child) = process.0.lock().map_err(|_| "管线进程不可用")?.take() else {
        return Ok(false);
    };
    child
        .kill()
        .map_err(|error| format!("停止管线失败：{error}"))?;
    let _ = app.emit(
        "pipeline-event",
        ProcessLine {
            stream: "status".into(),
            line: serde_json::json!({ "type": "stopped", "message": "已停止本地轮询；云端任务仍可稍后恢复" }).to_string(),
        },
    );
    Ok(true)
}

#[tauri::command]
fn open_ue_project(
    selected: State<SelectedManifest>,
    ue_path: Option<String>,
    ue_project: Option<String>,
) -> Result<(), String> {
    let command = validated_file(
        ue_path,
        "D:/UE/UE_5.4/Engine/Binaries/Win64/UnrealEditor-Cmd.exe",
        "UnrealEditor-Cmd.exe",
    )?;
    let editor = command.with_file_name("UnrealEditor.exe");
    if !editor.is_file() {
        return Err("同目录中找不到 UnrealEditor.exe".into());
    }
    let project = validated_project(ue_project)?;
    let manifest_path = selected_manifest(&selected)?;
    let manifest: Manifest = serde_json::from_str(
        &fs::read_to_string(manifest_path)
            .map_err(|error| format!("无法读取 Manifest：{error}"))?,
    )
    .map_err(|error| format!("Manifest 结构无效：{error}"))?;
    let preview_map = manifest
        .stages
        .get("ue-import")
        .and_then(|stage| stage.extra.get("report"))
        .and_then(|report| report.get("previewMap"))
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("/Game/Generated/{}/PreviewMap", manifest.run_id));
    Command::new(editor)
        .arg(project)
        .arg(preview_map)
        .spawn()
        .map_err(|error| format!("无法打开 Unreal 工程：{error}"))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(ProjectSession::default())
        .manage(SelectedManifest::default())
        .manage(DraftProject::default())
        .manage(PipelineProcess::default())
        .invoke_handler(tauri::generate_handler![
            pick_manifest,
            refresh_manifest,
            read_artifact,
            export_artifact,
            reveal_artifact,
            pick_reference,
            pick_output_root,
            import_mesh,
            load_project_graph,
            save_project_graph,
            set_view_split,
            start_pipeline,
            stop_pipeline,
            open_ue_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running TA Character Studio");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_absolute_and_parent_paths() {
        let manifest = Path::new("C:/pipeline/output/run/manifest.json");
        assert!(resolve_listed_path(manifest, "../secret.glb").is_err());
        assert!(resolve_listed_path(manifest, "C:/secret.glb").is_err());
    }

    #[test]
    fn missing_listed_file_is_not_approved() {
        let manifest = std::env::temp_dir().join("ta-character-studio-missing/manifest.json");
        assert!(resolve_listed_path(&manifest, "output/run/missing.glb").is_err());
    }

    #[test]
    fn rejects_forged_artifact_id() {
        let mut approved = HashMap::new();
        approved.insert("generation:0".into(), PathBuf::from("model.glb"));
        assert!(approved_from(&approved, "generation:0").is_ok());
        assert!(approved_from(&approved, "../../secret").is_err());
        assert!(approved_from(&approved, "generation:99").is_err());
    }

    #[test]
    fn validates_safe_project_names() {
        assert!(valid_run_name("角色_01"));
        assert!(!valid_run_name("../角色"));
        assert!(!valid_run_name("bad/name"));
        assert!(!valid_run_name(""));
    }
}
