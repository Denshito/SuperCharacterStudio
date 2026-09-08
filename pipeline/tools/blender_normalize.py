"""Blender 后台规范化与质量审计。

脚本既处理主 Idle 角色，也会被 pipeline.mjs 再次调用来转换 Rigging 附带的
Walking GLB。输入永不覆盖；所有可交付文件和 validation.json 写到指定输出目录。
法线策略是 preserve-source：只读检查拓扑，不对 UV/法线接缝拆开的网格岛猜测内外侧。
"""

import argparse
import json
import math
import os
import sys
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector


# Meshy 的 24 骨骼人形骨架到 UE 常用核心命名。这里只改名，不改变层级、参考姿势或骨骼数量。
UE_BONE_NAMES = {
    "Hips": "pelvis",
    "LeftUpLeg": "thigh_l",
    "LeftLeg": "calf_l",
    "LeftFoot": "foot_l",
    "LeftToeBase": "ball_l",
    "RightUpLeg": "thigh_r",
    "RightLeg": "calf_r",
    "RightFoot": "foot_r",
    "RightToeBase": "ball_r",
    "Spine02": "spine_01",
    "Spine01": "spine_02",
    "Spine": "spine_03",
    "LeftShoulder": "clavicle_l",
    "LeftArm": "upperarm_l",
    "LeftForeArm": "lowerarm_l",
    "LeftHand": "hand_l",
    "RightShoulder": "clavicle_r",
    "RightArm": "upperarm_r",
    "RightForeArm": "lowerarm_r",
    "RightHand": "hand_r",
    "neck": "neck_01",
    "Head": "head",
    "headfront": "head_front",
}


def rename_bones_for_ue(armatures, meshes):
    """同步改名骨骼、蒙皮组和动画曲线路径；缺少的骨骼保持缺少。"""
    existing = {bone.name for armature in armatures for bone in armature.data.bones}
    renames = {source: target for source, target in UE_BONE_NAMES.items() if source in existing}
    collisions = sorted(target for source, target in renames.items() if target in existing and target != source)
    if collisions:
        raise RuntimeError(f"UE bone rename collision: {', '.join(collisions)}")

    for armature in armatures:
        for source, target in renames.items():
            bone = armature.data.bones.get(source)
            if bone:
                bone.name = target

    # Blender 通常会随骨骼自动更新同名蒙皮组；这里仅处理没有自动同步的导入格式。
    for mesh in meshes:
        for source, target in renames.items():
            group = mesh.vertex_groups.get(source)
            if group and not mesh.vertex_groups.get(target):
                group.name = target

    for action in bpy.data.actions:
        for curve in action.fcurves:
            for source, target in renames.items():
                curve.data_path = curve.data_path.replace(
                    f'pose.bones["{source}"]', f'pose.bones["{target}"]'
                )

    final_names = {bone.name for armature in armatures for bone in armature.data.bones}
    missing = sorted(target for target in renames.values() if target not in final_names)
    if missing:
        raise RuntimeError(f"UE bone rename failed: {', '.join(missing)}")
    return renames


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


def audit_and_repair_weights(meshes, armatures, max_influences=4):
    """把变形权重限制为 UE 常用的 4 影响，并返回修改前发现的问题计数。"""
    deform_names = {bone.name for armature in armatures for bone in armature.data.bones if bone.use_deform}
    result = {"vertices": 0, "weightedVertices": 0, "zeroWeightVertices": 0, "nonNormalizedVertices": 0, "overInfluencedVertices": 0, "repairedVertices": 0, "maxInfluences": 0, "unboundMeshObjects": []}
    if not deform_names:
        return result
    for obj in meshes:
        deform_groups = {group.index: group for group in obj.vertex_groups if group.name in deform_names}
        if not deform_groups:
            result["unboundMeshObjects"].append(obj.name)
            continue
        for vertex in obj.data.vertices:
            result["vertices"] += 1
            weights = [(item.group, item.weight) for item in vertex.groups if item.group in deform_groups and item.weight > 1e-8]
            result["maxInfluences"] = max(result["maxInfluences"], len(weights))
            if not weights:
                result["zeroWeightVertices"] += 1
                continue
            result["weightedVertices"] += 1
            total = sum(weight for _, weight in weights)
            needs_normalize = abs(total - 1.0) > 0.01
            needs_limit = len(weights) > max_influences
            result["nonNormalizedVertices"] += int(needs_normalize)
            result["overInfluencedVertices"] += int(needs_limit)
            if not (needs_normalize or needs_limit):
                continue
            kept = sorted(weights, key=lambda item: item[1], reverse=True)[:max_influences]
            kept_ids = {group for group, _ in kept}
            for group, _ in weights:
                if group not in kept_ids:
                    deform_groups[group].remove([vertex.index])
            kept_total = sum(weight for _, weight in kept)
            if kept_total > 1e-8:
                for group, weight in kept:
                    deform_groups[group].add([vertex.index], weight / kept_total, "REPLACE")
            result["repairedVertices"] += 1
    return result


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

    bone_renames = rename_bones_for_ue(armatures, meshes)
    deform_names = {bone.name for armature in armatures for bone in armature.data.bones if bone.use_deform}
    # 高度必须由真正参与蒙皮的角色网格决定；生成服务可能附带未绑定的 Icosphere 等辅助物。
    height_meshes = [
        obj for obj in meshes
        if obj.find_armature() or any(group.name in deform_names for group in obj.vertex_groups)
    ] or meshes
    excluded_meshes = [
        obj for obj in meshes
        if obj not in height_meshes and obj.parent is None and not obj.material_slots and not obj.vertex_groups
    ]
    excluded_mesh_names = [obj.name for obj in excluded_meshes]
    for obj in excluded_meshes:
        bpy.data.objects.remove(obj, do_unlink=True)
    meshes = [obj for obj in meshes if obj not in excluded_meshes]

    minimum, maximum = bounds(height_meshes)
    source_height = maximum.z - minimum.z
    if source_height <= 1e-6:
        raise RuntimeError("model height is zero")
    scale = options.height / source_height
    for obj in bpy.context.scene.objects:
        if obj.parent is None:
            obj.scale *= scale
    bpy.context.view_layer.update()
    minimum, maximum = bounds(height_meshes)
    offset = Vector((-(minimum.x + maximum.x) / 2, -(minimum.y + maximum.y) / 2, -minimum.z))
    for obj in bpy.context.scene.objects:
        if obj.parent is None:
            obj.location += offset

    topology_report = {"degenerateFaces": 0, "nonManifoldEdges": 0, "looseVertices": 0}
    for index, obj in enumerate(meshes, 1):
        obj.name = f"CharacterMesh_{index:02d}"
        mesh = obj.data
        mesh.name = f"CharacterMesh_{index:02d}_Geo"
        bm = bmesh.new()
        bm.from_mesh(mesh)
        # 这里故意不调用 recalc_face_normals，也不把 BMesh 写回原网格。Meshy/glTF 在
        # UV 接缝处可能拆分顶点，全局重算法线会把不连续网格岛错误翻面。
        topology_report["degenerateFaces"] += sum(1 for face in bm.faces if face.calc_area() < 1e-12)
        topology_report["nonManifoldEdges"] += sum(1 for edge in bm.edges if not edge.is_manifold)
        topology_report["looseVertices"] += sum(1 for vertex in bm.verts if not vertex.link_faces)
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

    weight_report = audit_and_repair_weights(meshes, armatures)

    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 30
    bpy.context.view_layer.update()
    minimum, maximum = bounds(height_meshes)

    triangles = sum(len(poly.vertices) - 2 for obj in meshes for poly in obj.data.polygons)
    materials = {slot.material.name for obj in meshes for slot in obj.material_slots if slot.material}
    images = {image.filepath or image.name for image in bpy.data.images}
    actions = list(bpy.data.actions)
    frame_ranges = [action.frame_range[:] for action in actions]
    loop_mismatch_tracks = sum(
        1 for action in actions for curve in action.fcurves
        if len(curve.keyframe_points) > 1 and abs(curve.keyframe_points[0].co.y - curve.keyframe_points[-1].co.y) > 0.001
    )
    root_motion_tracks = sum(
        1 for action in actions for curve in action.fcurves
        if curve.data_path.endswith("location") and any(name in curve.data_path.lower() for name in ("root", "pelvis", "hips"))
    )
    texture_details = [
        {"name": image.name, "width": image.size[0], "height": image.size[1], "packed": image.packed_file is not None}
        for image in bpy.data.images if image.type == "IMAGE" and image.size[0] > 0
    ]
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

    if weight_report["zeroWeightVertices"]:
        warnings.append(f"{weight_report['zeroWeightVertices']} 个顶点没有有效骨骼权重，需要在 Blender 中检查")
    if weight_report["unboundMeshObjects"]:
        warnings.append(f"{len(weight_report['unboundMeshObjects'])} 个网格没有变形骨骼组；若为眼睛或附件可忽略，否则需要绑定")
    if loop_mismatch_tracks:
        warnings.append(f"{loop_mismatch_tracks} 条动画曲线首尾值不同；循环动画需要美术复核")
    if topology_report["degenerateFaces"] or topology_report["looseVertices"]:
        warnings.append(
            f"网格包含 {topology_report['degenerateFaces']} 个退化面和 {topology_report['looseVertices']} 个孤立顶点"
        )
    if excluded_mesh_names:
        warnings.append(f"已从交付产物排除 {len(excluded_mesh_names)} 个无材质、无权重的辅助网格")

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
            "boneNames": [bone.name for obj in armatures for bone in obj.data.bones],
            "boneRenames": bone_renames,
            "materials": len(materials),
            "textures": len(images),
            "animations": len(actions),
            "animationTracks": sum(len(action.fcurves) for action in actions),
            "frameRanges": frame_ranges,
            "weights": weight_report,
            "topology": topology_report,
            "normalPolicy": "preserve-source",
            "excludedMeshObjects": excluded_mesh_names,
            "rootMotionTracks": root_motion_tracks,
            "loopMismatchTracks": loop_mismatch_tracks,
            "textureDetails": texture_details,
        },
        "settings": {
            "targetHeightMeters": options.height,
            "rootCorrectionDegrees": options.root,
            "pelvisCorrectionDegrees": options.pelvis,
            "forwardAxis": "-Y",
            "upAxis": "Z",
            "unit": "meter",
            "maxBoneInfluences": 4,
            "automaticWeightNormalization": True,
            "boneNamingProfile": "ue5-core",
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
