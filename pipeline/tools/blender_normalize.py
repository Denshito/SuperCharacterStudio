import argparse
import json
import math
import os
import sys
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector


def args_after_separator():
    values = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--height", type=float, default=1.6)
    parser.add_argument("--root", default="0,0,0")
    parser.add_argument("--pelvis", default="0,0,0")
    return parser.parse_args(values)


def degrees(value):
    parts = [float(item.strip()) for item in value.split(",")]
    if len(parts) != 3:
        raise ValueError("rotation must contain X,Y,Z degrees")
    return [math.radians(item) for item in parts]


def emit(kind, **payload):
    print(json.dumps({"type": kind, **payload}, ensure_ascii=False), flush=True)


def bounds(meshes):
    points = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    return Vector(map(min, zip(*points))), Vector(map(max, zip(*points)))


def main():
    options = args_after_separator()
    source = Path(options.input).resolve()
    output_dir = Path(options.output_dir).resolve()
    if source.suffix.lower() not in {".glb", ".gltf", ".fbx"} or not source.is_file():
        raise ValueError("input must be an existing GLB, GLTF, or FBX")
    if options.height <= 0:
        raise ValueError("height must be greater than zero")
    output_dir.mkdir(parents=True, exist_ok=True)
    emit("stage", stage="normalize", status="RUNNING", progress=5)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    if source.suffix.lower() == ".fbx":
        bpy.ops.import_scene.fbx(filepath=str(source), automatic_bone_orientation=False)
    else:
        bpy.ops.import_scene.gltf(filepath=str(source))

    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    if not meshes:
        raise RuntimeError("no mesh objects found")

    minimum, maximum = bounds(meshes)
    source_height = maximum.z - minimum.z
    if source_height <= 1e-6:
        raise RuntimeError("model height is zero")
    scale = options.height / source_height
    for obj in bpy.context.scene.objects:
        if obj.parent is None:
            obj.scale *= scale
    bpy.context.view_layer.update()
    minimum, maximum = bounds(meshes)
    offset = Vector((-(minimum.x + maximum.x) / 2, -(minimum.y + maximum.y) / 2, -minimum.z))
    for obj in bpy.context.scene.objects:
        if obj.parent is None:
            obj.location += offset

    for index, obj in enumerate(meshes, 1):
        obj.name = f"CharacterMesh_{index:02d}"
        mesh = obj.data
        mesh.name = f"CharacterMesh_{index:02d}_Geo"
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(mesh)
        bm.free()
        mesh.update()

    for index, material in enumerate(bpy.data.materials, 1):
        material.name = f"CharacterMaterial_{index:02d}"
    texture_dir = output_dir / "textures"
    texture_dir.mkdir(exist_ok=True)
    texture_paths = []
    for index, image in enumerate((item for item in bpy.data.images if item.type == "IMAGE" and item.size[0] > 0), 1):
        target = texture_dir / f"CharacterTexture_{index:02d}.png"
        image.name = f"CharacterTexture_{index:02d}"
        image.filepath_raw = str(target)
        image.file_format = "PNG"
        image.save()
        texture_paths.append(str(target))

    root_rotation = degrees(options.root)
    for index, armature in enumerate(armatures, 1):
        armature.name = "CharacterRig" if index == 1 else f"CharacterRig_{index:02d}"
        armature.rotation_mode = "XYZ"
        armature.rotation_euler.rotate_axis("X", root_rotation[0])
        armature.rotation_euler.rotate_axis("Y", root_rotation[1])
        armature.rotation_euler.rotate_axis("Z", root_rotation[2])

    pelvis_rotation = degrees(options.pelvis)
    pelvis_applied = False
    if armatures and any(abs(value) > 1e-8 for value in pelvis_rotation):
        pelvis = next((bone for bone in armatures[0].pose.bones if any(name in bone.name.lower() for name in ("pelvis", "hips", "hip"))), None)
        if pelvis:
            pelvis.rotation_mode = "XYZ"
            pelvis.rotation_euler.x += pelvis_rotation[0]
            pelvis.rotation_euler.y += pelvis_rotation[1]
            pelvis.rotation_euler.z += pelvis_rotation[2]
            pelvis_applied = True

    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 30
    bpy.context.view_layer.update()
    minimum, maximum = bounds(meshes)

    triangles = sum(len(poly.vertices) - 2 for obj in meshes for poly in obj.data.polygons)
    materials = {slot.material.name for obj in meshes for slot in obj.material_slots if slot.material}
    images = {image.filepath or image.name for image in bpy.data.images}
    actions = list(bpy.data.actions)
    frame_ranges = [action.frame_range[:] for action in actions]
    warnings = []
    if not armatures:
        warnings.append("未检测到骨架")
    if triangles > 320000:
        warnings.append("三角面超过 Meshy Rigging 的 320,000 上限")
    if not materials:
        warnings.append("未检测到材质")
    if not images:
        warnings.append("未检测到纹理图片")
    if any(abs(value) > 1e-8 for value in pelvis_rotation) and not pelvis_applied:
        warnings.append("未找到 Pelvis/Hips 骨骼，未应用骨盆校正")

    glb_path = output_dir / "normalized-character.glb"
    fbx_path = output_dir / "normalized-character.fbx"
    emit("stage", stage="normalize", status="RUNNING", progress=65)
    bpy.ops.export_scene.gltf(
        filepath=str(glb_path),
        export_format="GLB",
        export_animations=True,
        export_skins=True,
        export_morph=True,
        export_yup=True,
    )
    bpy.ops.export_scene.fbx(
        filepath=str(fbx_path),
        use_selection=False,
        apply_unit_scale=True,
        apply_scale_options="FBX_SCALE_ALL",
        axis_forward="-Y",
        axis_up="Z",
        object_types={"ARMATURE", "MESH", "EMPTY"},
        mesh_smooth_type="FACE",
        use_tspace=True,
        add_leaf_bones=False,
        use_armature_deform_only=True,
        bake_anim=bool(actions),
        bake_anim_use_all_actions=True,
        bake_anim_use_nla_strips=True,
        bake_anim_simplify_factor=0.0,
        path_mode="COPY",
        embed_textures=False,
    )

    report = {
        "version": 1,
        "status": "WARNING" if warnings else "PASS",
        "source": str(source),
        "outputs": [str(glb_path), str(fbx_path), *texture_paths],
        "metrics": {
            "heightMeters": round(maximum.z - minimum.z, 6),
            "triangles": triangles,
            "meshObjects": len(meshes),
            "bones": sum(len(obj.data.bones) for obj in armatures),
            "materials": len(materials),
            "textures": len(images),
            "animations": len(actions),
            "animationTracks": sum(len(action.fcurves) for action in actions),
            "frameRanges": frame_ranges,
        },
        "settings": {
            "targetHeightMeters": options.height,
            "rootCorrectionDegrees": options.root,
            "pelvisCorrectionDegrees": options.pelvis,
            "forwardAxis": "-Y",
            "upAxis": "Z",
            "unit": "meter",
        },
        "warnings": warnings,
    }
    report_path = output_dir / "validation.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    emit("artifact", stage="normalize", path=str(glb_path))
    emit("artifact", stage="normalize", path=str(fbx_path))
    emit("artifact", stage="normalize", path=str(report_path))
    emit("complete", stage="normalize", status=report["status"], progress=100)


try:
    main()
except Exception as error:
    emit("error", stage="normalize", message=str(error))
    raise
