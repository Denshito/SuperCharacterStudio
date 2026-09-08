//! Tauri 主进程：负责所有本地信任边界，不实现角色生成业务。
//!
//! React 只能使用原生对话框选择文件并持有临时 artifact ID；这里把 ID 映射到
//! 已规范化的真实路径、管理 Node sidecar 生命周期，并把 JSONL 原样转发给界面。
//! Manifest 的任务状态仍由 pipeline.mjs 写入，Rust 不维护第二份任务数据库。

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
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
// 只保存当前工程批准过的文件；切换工程会整体替换此表，旧 ID 无法继续读取文件。
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

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortablePackage {
    format: String,
    version: u8,
    run_id: String,
    manifest: String,
}

const PACKAGE_FORMAT: &str = "ta-character-studio-project";
const PROFILE_FORMAT: &str = "ta-character-studio-profile";
const MAX_PACKAGE_FILES: usize = 10_000;
const MAX_PACKAGE_BYTES: u64 = 8 * 1024 * 1024 * 1024;

fn collect_files(root: &Path, directory: &Path, files: &mut Vec<(PathBuf, String)>) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|error| format!("无法读取工程目录：{error}"))? {
        let path = entry.map_err(|error| format!("无法读取工程文件：{error}"))?.path();
        if path.is_dir() {
            collect_files(root, &path, files)?;
        } else if path.is_file() {
            let relative = path.strip_prefix(root).map_err(|_| "工程文件不在工程目录中")?;
            let name = relative.components().map(|part| part.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
            files.push((path, name));
        }
    }
    Ok(())
}

fn validate_archive_path(name: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(name);
    if path.is_absolute() || path.components().any(|part| !matches!(part, Component::Normal(_))) {
        return Err(format!("工程包包含不安全路径：{name}"));
    }
    Ok(path)
}

fn portable_config(raw: &serde_json::Value) -> serde_json::Value {
    const KEYS: &[&str] = &["image_turnaround", "view_split", "generation", "remesh", "rigging", "animation", "normalize", "ue_import", "comfy"];
    let mut result = serde_json::Map::new();
    if let Some(config) = raw.get("config").and_then(serde_json::Value::as_object) {
        for key in KEYS {
            if let Some(value) = config.get(*key) {
                let mut value = value.clone();
                if *key == "comfy" {
                    value.as_object_mut().map(|object| object.remove("base_url"));
                }
                result.insert((*key).into(), value);
            }
        }
    }
    serde_json::Value::Object(result)
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

// 导入资产的 project.json 清单条目必须是工程内的相对普通路径。
fn safe_relative_listing(listed: &str) -> bool {
    let relative = Path::new(listed);
    !relative.is_absolute()
        && !relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
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
    // Manifest 可以列出文件，但不能自行授权任意磁盘路径。只有解析后仍落在允许的
    // manifest/run/pipeline 根目录且真实存在的文件，才会进入 ProjectSession。
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
fn export_project_package(
    app: tauri::AppHandle,
    selected: State<SelectedManifest>,
) -> Result<Option<String>, String> {
    let manifest_path = selected_manifest(&selected)?;
    let run_dir = manifest_path.parent().ok_or("Manifest 没有有效目录")?;
    let raw: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&manifest_path).map_err(|error| format!("无法读取 Manifest：{error}"))?,
    ).map_err(|error| format!("Manifest JSON 已损坏：{error}"))?;
    let run_id = raw.get("runId").and_then(serde_json::Value::as_str).filter(|value| valid_run_name(value)).ok_or("Manifest 缺少有效 runId")?;
    let Some(target) = app.dialog().file().add_filter("TA Character 工程包", &["zip"]).set_file_name(format!("{run_id}.tacs-project.zip")).blocking_save_file() else {
        return Ok(None);
    };
    let target = target.into_path().map_err(|error| format!("导出路径无效：{error}"))?;
    if target.starts_with(run_dir) {
        return Err("工程包不能保存到正在打包的工程目录中".into());
    }

    let mut files = Vec::new();
    collect_files(run_dir, run_dir, &mut files)?;
    if files.len() > MAX_PACKAGE_FILES {
        return Err("工程文件数量超过安全上限".into());
    }
    let archive_file = fs::File::create(&target).map_err(|error| format!("无法创建工程包：{error}"))?;
    let mut archive = zip::ZipWriter::new(archive_file);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let package = PortablePackage {
        format: PACKAGE_FORMAT.into(),
        version: 1,
        run_id: run_id.into(),
        manifest: format!("output/{run_id}/manifest.json"),
    };
    archive.start_file("package.json", options).map_err(|error| format!("无法写入工程包：{error}"))?;
    archive.write_all(&serde_json::to_vec_pretty(&package).map_err(|error| format!("无法编码工程包信息：{error}"))?).map_err(|error| format!("无法写入工程包信息：{error}"))?;
    for (path, relative) in files {
        let file_name = path.file_name().and_then(|value| value.to_str()).unwrap_or_default().to_lowercase();
        if file_name == ".env" || file_name.starts_with(".env.") || file_name.ends_with(".log") { continue; }
        archive.start_file(format!("output/{run_id}/{relative}"), options).map_err(|error| format!("无法写入工程文件：{error}"))?;
        let mut source = fs::File::open(&path).map_err(|error| format!("无法读取工程文件：{error}"))?;
        std::io::copy(&mut source, &mut archive).map_err(|error| format!("无法复制工程文件：{error}"))?;
    }
    archive.finish().map_err(|error| format!("无法完成工程包：{error}"))?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

#[tauri::command]
fn import_project_package(
    app: tauri::AppHandle,
    session: State<ProjectSession>,
    selected: State<SelectedManifest>,
) -> Result<Option<LoadedProject>, String> {
    let Some(source) = app.dialog().file().add_filter("TA Character 工程包", &["zip"]).blocking_pick_file() else {
        return Ok(None);
    };
    let source = source.into_path().map_err(|error| format!("工程包路径无效：{error}"))?;
    let Some(destination) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let destination = destination.into_path().map_err(|error| format!("导入目录无效：{error}"))?.canonicalize().map_err(|error| format!("无法验证导入目录：{error}"))?;
    let mut archive = zip::ZipArchive::new(fs::File::open(&source).map_err(|error| format!("无法打开工程包：{error}"))?).map_err(|error| format!("工程包不是有效 ZIP：{error}"))?;
    if archive.len() > MAX_PACKAGE_FILES {
        return Err("工程包文件数量超过安全上限".into());
    }
    let package: PortablePackage = {
        let mut entry = archive.by_name("package.json").map_err(|_| "工程包缺少 package.json")?;
        let mut text = String::new();
        entry.read_to_string(&mut text).map_err(|error| format!("无法读取工程包信息：{error}"))?;
        serde_json::from_str(&text).map_err(|error| format!("工程包信息无效：{error}"))?
    };
    if package.format != PACKAGE_FORMAT || package.version != 1 || !valid_run_name(&package.run_id) {
        return Err("不支持的工程包格式或版本".into());
    }
    let expected_manifest = format!("output/{}/manifest.json", package.run_id);
    if package.manifest != expected_manifest {
        return Err("工程包 Manifest 位置无效".into());
    }
    {
        let mut entry = archive.by_name(&expected_manifest).map_err(|_| "工程包缺少 manifest.json")?;
        if entry.size() > 16 * 1024 * 1024 { return Err("Manifest 超过安全上限".into()); }
        let mut text = String::new();
        entry.read_to_string(&mut text).map_err(|error| format!("无法读取 Manifest：{error}"))?;
        let manifest: Manifest = serde_json::from_str(&text).map_err(|error| format!("Manifest 结构无效：{error}"))?;
        if manifest.version != 2 || manifest.run_id != package.run_id { return Err("工程包与 Manifest 的版本或 runId 不一致".into()); }
    }
    let prefix = format!("output/{}/", package.run_id);
    let mut total = 0u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| format!("无法检查工程包：{error}"))?;
        let name = entry.name();
        validate_archive_path(name)?;
        if name != "package.json" && !name.starts_with(&prefix) {
            return Err(format!("工程包包含范围外文件：{name}"));
        }
        if entry.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000) {
            return Err("工程包不能包含符号链接".into());
        }
        total = total.checked_add(entry.size()).ok_or("工程包大小溢出")?;
        if total > MAX_PACKAGE_BYTES {
            return Err("工程包解压后超过 8 GiB 安全上限".into());
        }
    }
    let target_run = destination.join("output").join(&package.run_id);
    if target_run.exists() {
        return Err(format!("目标工程已存在：{}", target_run.display()));
    }
    fs::create_dir_all(destination.join("output")).map_err(|error| format!("无法创建导入目录：{error}"))?;
    let output_root = destination.join("output").canonicalize().map_err(|error| format!("无法验证导入目录：{error}"))?;
    if !output_root.starts_with(&destination) { return Err("导入目录包含指向范围外的链接".into()); }
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| format!("无法读取工程包：{error}"))?;
        if entry.name() == "package.json" || entry.is_dir() { continue; }
        let relative = validate_archive_path(entry.name())?;
        let target = destination.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建导入目录：{error}"))?;
            let verified = parent.canonicalize().map_err(|error| format!("无法验证导入目录：{error}"))?;
            if !verified.starts_with(&output_root) { return Err("工程包试图写入目标工程范围外".into()); }
        }
        let mut output = fs::File::create(&target).map_err(|error| format!("无法创建导入文件：{error}"))?;
        std::io::copy(&mut entry, &mut output).map_err(|error| format!("无法解压工程文件：{error}"))?;
    }
    let manifest_path = destination.join(package.manifest);
    let project = load_manifest(&manifest_path, &session)?;
    *selected.0.lock().map_err(|_| "项目会话不可用")? = Some(manifest_path);
    Ok(Some(project))
}

#[tauri::command]
fn export_profile(app: tauri::AppHandle, selected: State<SelectedManifest>) -> Result<Option<String>, String> {
    let path = selected_manifest(&selected)?;
    let raw: serde_json::Value = serde_json::from_str(&fs::read_to_string(path).map_err(|error| format!("无法读取 Manifest：{error}"))?).map_err(|error| format!("Manifest JSON 已损坏：{error}"))?;
    let profile = serde_json::json!({ "format": PROFILE_FORMAT, "version": 1, "config": portable_config(&raw) });
    let Some(target) = app.dialog().file().add_filter("TA Character 流程配置", &["json"]).set_file_name("TACharacterStudio.tacs-profile.json").blocking_save_file() else { return Ok(None); };
    let target = target.into_path().map_err(|error| format!("配置路径无效：{error}"))?;
    fs::write(&target, serde_json::to_vec_pretty(&profile).map_err(|error| format!("无法编码配置：{error}"))?).map_err(|error| format!("无法导出配置：{error}"))?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

#[tauri::command]
fn import_profile(app: tauri::AppHandle, selected: State<SelectedManifest>) -> Result<bool, String> {
    let Some(source) = app.dialog().file().add_filter("TA Character 流程配置", &["json"]).blocking_pick_file() else { return Ok(false); };
    let source = source.into_path().map_err(|error| format!("配置路径无效：{error}"))?;
    let profile: serde_json::Value = serde_json::from_str(&fs::read_to_string(source).map_err(|error| format!("无法读取配置：{error}"))?).map_err(|error| format!("配置 JSON 已损坏：{error}"))?;
    if profile.get("format").and_then(serde_json::Value::as_str) != Some(PROFILE_FORMAT) || profile.get("version").and_then(serde_json::Value::as_u64) != Some(1) {
        return Err("不支持的流程配置格式或版本".into());
    }
    let config = profile.get("config").and_then(serde_json::Value::as_object).ok_or("流程配置缺少 config")?;
    let path = selected_manifest(&selected)?;
    let mut manifest: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).map_err(|error| format!("无法读取 Manifest：{error}"))?).map_err(|error| format!("Manifest JSON 已损坏：{error}"))?;
    let old_comfy_url = manifest.pointer("/config/comfy/base_url").cloned();
    manifest["config"] = serde_json::Value::Object(config.clone());
    if let Some(url) = old_comfy_url { manifest["config"]["comfy"]["base_url"] = url; }
    if let Some(stages) = manifest.get_mut("stages").and_then(serde_json::Value::as_object_mut) {
        for (name, stage) in stages {
            if name != "reference-source" && stage.get("status").and_then(serde_json::Value::as_str) != Some("NOT_STARTED") {
                stage["status"] = "STALE".into();
            }
        }
    }
    fs::write(path, serde_json::to_vec_pretty(&manifest).map_err(|error| format!("无法编码 Manifest：{error}"))?).map_err(|error| format!("无法应用流程配置：{error}"))?;
    Ok(true)
}

#[tauri::command]
fn install_comfy_nodes(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let bundled = app.path().resource_dir().map_err(|error| format!("无法定位应用资源：{error}"))?.join("integrations/comfy/ComfyUI-TACharacterTools");
    #[cfg(debug_assertions)]
    let source = if bundled.is_dir() { bundled } else { Path::new(env!("CARGO_MANIFEST_DIR")).join("../integrations/comfy/ComfyUI-TACharacterTools") };
    #[cfg(not(debug_assertions))]
    let source = bundled;
    if !source.join("ta_nodes.py").is_file() { return Err("安装包缺少 ComfyUI TA 节点资源".into()); }
    let Some(folder) = app.dialog().file().blocking_pick_folder() else { return Ok(None); };
    let custom_nodes = folder.into_path().map_err(|error| format!("ComfyUI 节点目录无效：{error}"))?;
    if !custom_nodes.is_dir() || custom_nodes.file_name().and_then(|value| value.to_str()).map(|value| !value.eq_ignore_ascii_case("custom_nodes")).unwrap_or(true) {
        return Err("请选择 ComfyUI 的 custom_nodes 文件夹".into());
    }
    let target = custom_nodes.join("ComfyUI-TACharacterTools");
    fs::create_dir_all(&target).map_err(|error| format!("无法创建节点目录：{error}"))?;
    let mut files = Vec::new();
    collect_files(&source, &source, &mut files)?;
    for (path, relative) in files {
        if relative.contains("__pycache__") || relative.ends_with(".pyc") { continue; }
        let destination = target.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = destination.parent() { fs::create_dir_all(parent).map_err(|error| format!("无法创建节点子目录：{error}"))?; }
        fs::copy(path, destination).map_err(|error| format!("无法安装 ComfyUI 节点：{error}"))?;
    }
    Ok(Some(target.to_string_lossy().into_owned()))
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
        if !safe_relative_listing(listed) {
            return Err(format!("导入资产路径不安全：{listed}"));
        }
        let relative = Path::new(listed);
        let resolved = run_dir
            .join(relative)
            .canonicalize()
            .map_err(|_| format!("导入资产已移动或删除：{listed}"))?;
        if !resolved.starts_with(&canonical_run) || !resolved.is_file() {
            return Err(format!("导入资产不在工程目录内：{listed}"));
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

fn import_asset(
    app: &tauri::AppHandle,
    session: &State<ProjectSession>,
    selected: &State<SelectedManifest>,
    filter_name: &str,
    extensions: &[&str],
    fallback_name: &str,
    error_label: &str,
) -> Result<Option<ArtifactInfo>, String> {
    let Some(file) = app
        .dialog()
        .file()
        .add_filter(filter_name, extensions)
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|error| format!("文件路径无效：{error}"))?
        .canonicalize()
        .map_err(|error| format!("无法读取文件：{error}"))?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    if !path.is_file() || !extensions.iter().any(|ext| extension.eq_ignore_ascii_case(ext)) {
        return Err(error_label.into());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "系统时间无效")?
        .as_millis();
    let graph_file = graph_path(selected)?;
    let run_dir = graph_file.parent().ok_or("工程目录无效")?;
    let import_dir = run_dir.join("imports");
    fs::create_dir_all(&import_dir).map_err(|error| format!("无法创建导入目录：{error}"))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(fallback_name);
    let listed = format!("imports/{stamp}-{file_name}");
    let copied = run_dir.join(&listed);
    fs::copy(&path, &copied).map_err(|error| format!("无法复制文件到工程：{error}"))?;
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

#[tauri::command]
fn import_mesh(
    app: tauri::AppHandle,
    session: State<ProjectSession>,
    selected: State<SelectedManifest>,
) -> Result<Option<ArtifactInfo>, String> {
    import_asset(&app, &session, &selected, "GLB 模型", &["glb"], "model.glb", "请选择有效的 GLB 文件")
}

#[tauri::command]
fn import_image(
    app: tauri::AppHandle,
    session: State<ProjectSession>,
    selected: State<SelectedManifest>,
) -> Result<Option<ArtifactInfo>, String> {
    import_asset(&app, &session, &selected, "角色三视图/参考图", &["png", "jpg", "jpeg"], "turnaround.png", "请选择有效的 PNG 或 JPG 图片")
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

fn command_line_path(path: &Path) -> String {
    // canonicalize() 在 Windows 上可能产生 \\?\ 前缀；Node/UE 命令行不能可靠识别它。
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
    }
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

fn sidecar_entry(script: &Path) -> Result<(PathBuf, String), String> {
    let directory = script.parent().ok_or("管线脚本没有有效目录")?.to_path_buf();
    let file_name = script.file_name().and_then(|value| value.to_str()).ok_or("管线脚本文件名无效")?.to_string();
    Ok((directory, file_name))
}

fn is_explicit_spend_confirmation(value: &serde_json::Value) -> bool {
    value.as_bool() == Some(true)
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
    confirm_spend: serde_json::Value,
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
    comfy_url: Option<String>,
    comfy_preset: Option<String>,
    comfy_prompt: Option<String>,
) -> Result<(), String> {
    // IPC 中 confirmSpend 是 JSON 值而不是 Rust bool：只接受字面量 true，避免
    // { value: true } 或字符串 "true" 被误判为付费确认。
    let confirm_spend = is_explicit_spend_confirmation(&confirm_spend);
    if process.0.lock().map_err(|_| "管线进程不可用")?.is_some() {
        return Err("已有节点正在运行，请先停止或等待完成".into());
    }
    if !matches!(operation.as_str(), "init" | "execute" | "resume" | "check" | "check-comfy" | "doctor" | "approve-references") {
        return Err("不支持的管线操作".into());
    }
    if !matches!(operation.as_str(), "check" | "check-comfy" | "doctor" | "init" | "approve-references")
        && !matches!(
            stage.as_deref(),
            Some("image-turnaround" | "view-split" | "generation" | "remesh" | "rigging" | "animation" | "normalize" | "ue-import" | "comfy-prep")
        )
    {
        return Err("请选择可执行的管线阶段".into());
    }

    let script = pipeline_script(&app)?;
    let (script_dir, script_name) = sidecar_entry(&script)?;
    let mut args = vec![script_name, operation.clone()];
    if operation == "check" {
        args.push("--json".into());
    } else if operation == "check-comfy" {
        args.push("--json".into());
        if let Some(url) = comfy_url.filter(|value| !value.trim().is_empty()) {
            args.extend(["--comfy-url".into(), url]);
        }
    } else if operation == "doctor" {
        args.push("--json".into());
        if let Some(url) = comfy_url.filter(|value| !value.trim().is_empty()) { args.extend(["--comfy-url".into(), url]); }
        if let Some(path) = blender_path.filter(|value| !value.trim().is_empty()) { args.extend(["--tool-path".into(), path]); }
        if let Some(path) = ue_path.filter(|value| !value.trim().is_empty()) { args.extend(["--ue-path".into(), path]); }
        if let Some(path) = ue_project.filter(|value| !value.trim().is_empty()) { args.extend(["--ue-project".into(), path]); }
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
            let extension = input
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_lowercase();
            match stage_name.as_str() {
                "remesh" | "rigging" => {
                    if extension != "glb" {
                        return Err("Remesh/Rigging 的本地输入必须是 GLB".into());
                    }
                }
                "view-split" => {
                    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg") {
                        return Err("视图切分的本地输入必须是 PNG 或 JPG 三视图".into());
                    }
                }
                _ => return Err("该阶段不支持本地输入".into()),
            }
            args.extend([
                "--input-artifact".into(),
                input.to_string_lossy().into_owned(),
            ]);
        }
        if stage_name == "comfy-prep" {
            if let Some(url) = comfy_url.filter(|value| !value.trim().is_empty()) {
                args.extend(["--comfy-url".into(), url]);
            }
            if let Some(preset) = comfy_preset.filter(|value| !value.trim().is_empty()) {
                if !matches!(preset.as_str(), "turnaround" | "style-unify") {
                    return Err("Comfy 预设无效".into());
                }
                args.extend(["--comfy-preset".into(), preset]);
            }
            if let Some(prompt) = comfy_prompt.filter(|value| !value.trim().is_empty()) {
                if prompt.len() > 4000 {
                    return Err("Comfy 补充提示词不能超过 4000 字符".into());
                }
                args.extend(["--comfy-prompt".into(), prompt]);
            }
        }
        if stage_name == "normalize" {
            let blender = validated_file(blender_path, "D:/Blender/blender.exe", "blender.exe")?;
            let height = target_height.unwrap_or(1.6);
            if !(0.5..=3.0).contains(&height) {
                return Err("目标身高必须在 0.5 到 3.0 米之间".into());
            }
            args.extend([
                "--tool-path".into(),
                command_line_path(&blender),
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
                command_line_path(&unreal),
                "--ue-project".into(),
                command_line_path(&project),
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
        .current_dir(script_dir)
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
        .arg(command_line_path(&project))
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
            export_project_package,
            import_project_package,
            export_profile,
            import_profile,
            install_comfy_nodes,
            refresh_manifest,
            read_artifact,
            export_artifact,
            reveal_artifact,
            pick_reference,
            pick_output_root,
            import_mesh,
            import_image,
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

    #[test]
    fn rejects_unsafe_import_listings() {
        assert!(safe_relative_listing("imports/model.glb"));
        assert!(safe_relative_listing("imports/turnaround.png"));
        assert!(!safe_relative_listing("../escape.glb"));
        assert!(!safe_relative_listing("C:/secret.glb"));
        assert!(!safe_relative_listing("imports/../escape.glb"));
    }

    #[test]
    fn validates_archive_paths_and_portable_config() {
        assert!(validate_archive_path("output/character/manifest.json").is_ok());
        assert!(validate_archive_path("../manifest.json").is_err());
        assert!(validate_archive_path("C:/manifest.json").is_err());
        let raw = serde_json::json!({ "config": { "generation": { "mode": "multi-image" }, "comfy": { "base_url": "http://127.0.0.1:8188", "preset": "turnaround" }, "secret": "no" } });
        let config = portable_config(&raw);
        assert_eq!(config["generation"]["mode"], "multi-image");
        assert_eq!(config["comfy"]["preset"], "turnaround");
        assert!(config["comfy"].get("base_url").is_none());
        assert!(config.get("secret").is_none());
    }

    #[test]
    fn sidecar_entry_is_safe_for_drive_and_space_paths() {
        let (directory, entry) = sidecar_entry(Path::new("E:/TA Character Studio/pipeline/pipeline.mjs")).unwrap();
        assert_eq!(directory, PathBuf::from("E:/TA Character Studio/pipeline"));
        assert_eq!(entry, "pipeline.mjs");
    }

    #[test]
    fn spend_confirmation_requires_a_json_boolean_true() {
        assert!(is_explicit_spend_confirmation(&serde_json::json!(true)));
        assert!(!is_explicit_spend_confirmation(&serde_json::json!(false)));
        assert!(!is_explicit_spend_confirmation(&serde_json::json!({ "confirmed": true })));
        assert!(!is_explicit_spend_confirmation(&serde_json::json!("true")));
        assert!(!is_explicit_spend_confirmation(&serde_json::Value::Null));
    }

    #[test]
    fn strips_windows_verbatim_prefix_for_external_tools() {
        assert_eq!(command_line_path(Path::new(r"\\?\E:\AIEval\Eval.uproject")), r"E:\AIEval\Eval.uproject");
        assert_eq!(command_line_path(Path::new(r"\\?\UNC\server\share\Eval.uproject")), r"\\server\share\Eval.uproject");
        assert_eq!(command_line_path(Path::new(r"E:\AIEval\Eval.uproject")), r"E:\AIEval\Eval.uproject");
    }
}
