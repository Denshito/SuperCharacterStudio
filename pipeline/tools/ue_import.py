import json
import os
import hashlib
import re
import traceback

import unreal


def emit(kind, **payload):
    unreal.log(json.dumps({"type": kind, **payload}, ensure_ascii=False))


def import_task(filename, destination, options):
    task = unreal.AssetImportTask()
    task.filename = filename
    task.destination_path = destination
    task.automated = True
    task.replace_existing = True
    task.replace_existing_settings = True
    task.save = True
    if options:
        task.options = options
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    return list(task.imported_object_paths)


def main():
    source = os.environ["TA_NORMALIZED_FBX"]
    run_id = os.environ["TA_RUN_ID"]
    report_path = os.environ["TA_UE_REPORT"]
    texture_files = json.loads(os.environ.get("TA_TEXTURES", "[]"))
    safe_run_id = re.sub(r"[^A-Za-z0-9_-]", "_", run_id).strip("_") or "character"
    if safe_run_id != run_id:
        safe_run_id = f"{safe_run_id}_{hashlib.sha1(run_id.encode('utf-8')).hexdigest()[:8]}"
    destination = f"/Game/Generated/{safe_run_id}"
    emit("stage", stage="ue-import", status="RUNNING", progress=10)

    mesh_options = unreal.FbxImportUI()
    mesh_options.import_mesh = True
    mesh_options.import_as_skeletal = True
    mesh_options.import_animations = False
    mesh_options.import_materials = True
    mesh_options.import_textures = True
    mesh_options.automated_import_should_detect_type = False
    mesh_options.mesh_type_to_import = unreal.FBXImportType.FBXIT_SKELETAL_MESH
    mesh_options.skeletal_mesh_import_data.normal_import_method = unreal.FBXNormalImportMethod.FBXNIM_IMPORT_NORMALS_AND_TANGENTS
    mesh_paths = import_task(source, f"{destination}/Character", mesh_options)
    skeletal_mesh = next((unreal.EditorAssetLibrary.load_asset(path) for path in mesh_paths if isinstance(unreal.EditorAssetLibrary.load_asset(path), unreal.SkeletalMesh)), None)
    if not skeletal_mesh:
        raise RuntimeError("UE 未生成 Skeletal Mesh")
    skeleton = skeletal_mesh.skeleton

    unreal.EditorAssetLibrary.delete_directory(f"{destination}/Materials")
    texture_assets = []
    for texture_file in texture_files:
        texture_assets.extend(import_task(texture_file, f"{destination}/Materials", None))
    texture = unreal.EditorAssetLibrary.load_asset(texture_assets[0]) if texture_assets else None
    material = None
    if texture:
        material = unreal.AssetToolsHelpers.get_asset_tools().create_asset(
            "M_Character",
            f"{destination}/Materials",
            unreal.Material,
            unreal.MaterialFactoryNew(),
        )
        sample = unreal.MaterialEditingLibrary.create_material_expression(material, unreal.MaterialExpressionTextureSample, -350, 0)
        sample.texture = texture
        unreal.MaterialEditingLibrary.connect_material_property(sample, "RGB", unreal.MaterialProperty.MP_BASE_COLOR)
        unreal.MaterialEditingLibrary.recompile_material(material)
        unreal.EditorAssetLibrary.save_loaded_asset(material)
        slots = list(skeletal_mesh.get_editor_property("materials"))
        if slots:
            slots[0].material_interface = material
            skeletal_mesh.set_editor_property("materials", slots)
        unreal.EditorAssetLibrary.save_loaded_asset(skeletal_mesh)

    animation_options = unreal.FbxImportUI()
    animation_options.import_mesh = False
    animation_options.import_animations = True
    animation_options.import_materials = False
    animation_options.import_textures = False
    animation_options.skeleton = skeleton
    animation_options.automated_import_should_detect_type = False
    animation_options.original_import_type = unreal.FBXImportType.FBXIT_ANIMATION
    animation_options.mesh_type_to_import = unreal.FBXImportType.FBXIT_ANIMATION
    unreal.EditorAssetLibrary.delete_directory(f"{destination}/Animation")
    animation_paths = import_task(source, f"{destination}/Animation", animation_options)
    animation = next((unreal.EditorAssetLibrary.load_asset(path) for path in animation_paths if isinstance(unreal.EditorAssetLibrary.load_asset(path), unreal.AnimSequence)), None)
    if not animation:
        raise RuntimeError("UE 未生成 Animation Sequence")
    emit("stage", stage="ue-import", status="RUNNING", progress=70)

    map_path = f"{destination}/PreviewMap"
    if unreal.EditorAssetLibrary.does_asset_exist(map_path):
        unreal.EditorAssetLibrary.delete_asset(map_path)
    level_subsystem = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
    actor_subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    if not level_subsystem.new_level(map_path):
        raise RuntimeError("无法创建 UE Preview Map")
    actor = actor_subsystem.spawn_actor_from_object(skeletal_mesh, unreal.Vector(0, 0, 0))
    if not actor:
        raise RuntimeError("无法在 Preview Map 中放置角色")
    actor.set_actor_label(f"TA_{run_id}")
    component = actor.get_component_by_class(unreal.SkeletalMeshComponent)
    if animation and component:
        component.set_animation_mode(unreal.AnimationMode.ANIMATION_SINGLE_NODE)
        component.set_animation(animation)
        component.play(True)
    actor_subsystem.spawn_actor_from_class(unreal.DirectionalLight, unreal.Vector(200, -200, 300), unreal.Rotator(-35, -45, 0))
    actor_subsystem.spawn_actor_from_class(unreal.SkyLight, unreal.Vector(0, 0, 200))
    floor_mesh = unreal.EditorAssetLibrary.load_asset("/Engine/BasicShapes/Plane.Plane")
    if floor_mesh:
        floor = actor_subsystem.spawn_actor_from_object(floor_mesh, unreal.Vector(0, 0, -1))
        floor.set_actor_label("PreviewFloor")
        floor.set_actor_scale3d(unreal.Vector(5, 5, 1))
    level_subsystem.save_current_level()
    unreal.EditorLoadingAndSavingUtils.save_dirty_packages(True, True)

    assets = sorted(unreal.EditorAssetLibrary.list_assets(destination, recursive=True, include_folder=False))
    report = {
        "version": 1,
        "status": "PASS",
        "runId": run_id,
        "destination": destination,
        "skeletalMesh": skeletal_mesh.get_path_name(),
        "skeleton": skeleton.get_path_name(),
        "animation": animation.get_path_name() if animation else None,
        "previewMap": map_path,
        "previewActor": actor.get_path_name(),
        "animationPlaying": bool(animation and component),
        "material": material.get_path_name() if material else None,
        "textures": texture_assets,
        "assets": assets,
    }
    os.makedirs(os.path.dirname(report_path), exist_ok=True)
    with open(report_path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    emit("artifact", stage="ue-import", path=report_path)
    emit("complete", stage="ue-import", status="PASS", progress=100)


try:
    main()
except Exception as error:
    emit("error", stage="ue-import", message=str(error), detail=traceback.format_exc())
    raise
