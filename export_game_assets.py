"""
ゲーム用 GLB の書き出し（Three.js 用）

  blender --background --python export_game_assets.py -- <soldier.blend> <ghost.blend> <outdir>

出力
  soldier.glb   : 敵兵（ガスマスク版）。ポリゴン削減 + 焼き込みテクスチャ + 全アクション
  viewmodel.glb : 一人称視点用（ゴースト版の袖・グローブ + ライフル）。ライフル原点基準の静的メッシュ

プロシージャルマテリアルは glTF に出せないので、ベースカラーと（布物は）法線を Cycles で焼き込む。
"""

import importlib.util
import math
import os
import sys

import bpy  # noqa: I001  (pip 版 bpy は bmesh より先に import が必要)
import bmesh
from mathutils import Matrix

HERE = os.path.dirname(os.path.abspath(__file__))

# 目標三角形数（ゲーム用）
TRI_TARGET = {
    "Body_Uniform": 22000, "Gloves": 3500, "Boots": 4000, "Boot_Laces": 800, "PlateCarrier": 3500,
    "Pouches": 2500, "Belt": 1200, "Belt_Gear": 1200, "KneePads": 1500, "Helmet": 5000,
    "GasMask": 3500, "GasMask_Parts": 5000, "Ghost_NVG_Headset": 7000, "Rifle": 9000,
}
TEX_SIZE = {"Body_Uniform": 2048, "Rifle": 1024}
NORMAL_BAKE = {"Body_Uniform", "Gloves", "Boots", "PlateCarrier", "Helmet"}


def load_motions():
    spec = importlib.util.spec_from_file_location("soldier_motions", os.path.join(HERE, "soldier_motions.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def ctx_select(objs, active):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active


def tri_count(me):
    return sum(len(p.vertices) - 2 for p in me.polygons)


def bake_ready_mesh(ob, rig, keep_armature=True, key=None):
    """モディファイア（アーマチュア以外）を適用し、ポリゴンを削減。頂点グループは保持"""
    arm_mods = [m for m in ob.modifiers if m.type == "ARMATURE"]
    for m in arm_mods:
        m.show_viewport = False
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    bpy.data.meshes.remove(old)
    tris = tri_count(me)
    key = key or ob.name
    target = TRI_TARGET.get(key, 3000)
    if tris > target * 1.15:
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.triangulate(bm, faces=bm.faces)
        bm.to_mesh(me)
        bm.free()
        dec = ob.modifiers.new("Decimate", "DECIMATE")
        dec.ratio = target / tris
        dec.use_collapse_triangulate = True
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        me2 = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        ob.modifiers.clear()
        ob.data = me2
        bpy.data.meshes.remove(me)
        me = me2
    for p in me.polygons:
        p.use_smooth = True
    if keep_armature and rig is not None and ob.vertex_groups:
        md = ob.modifiers.new("Armature", "ARMATURE")
        md.object = rig
    print("  %-20s %6d -> %6d tris" % (ob.name, tris, tri_count(me)))


def smart_uv(ob):
    ctx_select([ob], ob)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004)
    bpy.ops.object.mode_set(mode="OBJECT")


def principled_values(mat):
    rough, metal = 0.8, 0.0
    if mat and mat.node_tree:
        for n in mat.node_tree.nodes:
            if n.type == "BSDF_PRINCIPLED":
                if not n.inputs["Roughness"].is_linked:
                    rough = n.inputs["Roughness"].default_value
                if not n.inputs["Metallic"].is_linked:
                    metal = n.inputs["Metallic"].default_value
    return rough, metal


def bake_object(ob, prefix, key=None):
    """ベースカラー（＋法線）を焼き込み、glTF 互換のシンプルなマテリアルに置き換える"""
    key = key or ob.name
    size = TEX_SIZE.get(key, 1024 if key in NORMAL_BAKE else 512)
    col = bpy.data.images.new(prefix + key + "_col", size, size, alpha=False)
    nrm = None
    if key in NORMAL_BAKE:
        nrm = bpy.data.images.new(prefix + key + "_nrm", size, size, alpha=False)
        nrm.colorspace_settings.name = "Non-Color"
    mats = [s.material for s in ob.material_slots]
    vals = [principled_values(m) for m in mats]

    def set_target(img):
        for m in mats:
            if not m:
                continue
            nt = m.node_tree
            n = nt.nodes.get("__bake__") or nt.nodes.new("ShaderNodeTexImage")
            n.name = "__bake__"
            n.image = img
            nt.nodes.active = n
    ctx_select([ob], ob)
    sc = bpy.context.scene
    set_target(col)
    sc.cycles.samples = 1
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, margin=6, use_clear=True)
    col.pack()
    if nrm is not None:
        set_target(nrm)
        bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT", margin=6, use_clear=True)
        nrm.pack()
    # 置き換え
    for i, slot in enumerate(ob.material_slots):
        rough, metal = vals[i]
        m = bpy.data.materials.new("%s%s_%d" % (prefix, key, i))
        try:
            m.use_nodes = True
        except Exception:
            pass
        nt = m.node_tree
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        b = nt.nodes.new("ShaderNodeBsdfPrincipled")
        nt.links.new(b.outputs["BSDF"], out.inputs["Surface"])
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = col
        nt.links.new(t.outputs["Color"], b.inputs["Base Color"])
        b.inputs["Roughness"].default_value = rough
        b.inputs["Metallic"].default_value = metal
        if nrm is not None:
            tn = nt.nodes.new("ShaderNodeTexImage")
            tn.image = nrm
            nm = nt.nodes.new("ShaderNodeNormalMap")
            nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
            nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
        slot.material = m


def prepare_scene_for_bake():
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.render.bake.margin = 6


def export_soldier(path, outpath, motions):
    bpy.ops.wm.open_mainfile(filepath=path)
    prepare_scene_for_bake()
    rig = bpy.data.objects["Soldier_Rig"]
    motions.make_all(rig, default="Idle_Rifle")
    rig.data.pose_position = "REST"
    meshes = [o for o in bpy.data.objects if o.type == "MESH" and o.parent == rig]
    print("soldier meshes:", [o.name for o in meshes])
    for ob in meshes:
        bake_ready_mesh(ob, rig, keep_armature=(ob.name != "Rifle"))
        smart_uv(ob)
        bake_object(ob, "S_")
    rig.data.pose_position = "POSE"
    ctx_select([rig] + meshes, rig)
    bpy.ops.export_scene.gltf(
        filepath=outpath, export_format="GLB", use_selection=True,
        export_animations=True, export_animation_mode="ACTIONS", export_force_sampling=True,
        export_skins=True, export_def_bones=False, export_reset_pose_bones=True,
        export_image_format="JPEG", export_jpeg_quality=85, export_apply=False, export_yup=True,
        export_optimize_animation_size=True)
    print("exported", outpath, os.path.getsize(outpath) // 1024, "KB")


def export_viewmodel(path, outpath, motions):
    """ゴースト版を構えポーズにし、袖（前腕〜上腕下部）・グローブ・ライフルをライフル原点の座標系で書き出す"""
    bpy.ops.wm.open_mainfile(filepath=path)
    prepare_scene_for_bake()
    rig = bpy.data.objects["Soldier_Rig"]
    motions.make_all(rig, default="Idle_Rifle")
    sc = bpy.context.scene
    sc.frame_set(0)
    bpy.context.view_layer.update()
    rifle = bpy.data.objects["Rifle"]
    inv = rifle.matrix_world.inverted()
    dg = bpy.context.evaluated_depsgraph_get()
    keep = []
    for name in ("Body_Uniform", "Gloves", "Rifle"):
        ob = bpy.data.objects[name]
        me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        me.transform(ob.matrix_world)
        new = bpy.data.objects.new("VM_" + name, me)
        sc.collection.objects.link(new)
        for vg in ob.vertex_groups:
            new.vertex_groups.new(name=vg.name)
        keep.append((new, ob))
    # 袖：腕のウェイトが支配的な頂点だけ残す
    body_vm, body = keep[0]
    names = [g.name for g in body.vertex_groups]
    arm_names = {n for n in names if n.startswith(("forearm", "hand", "upper_arm"))}
    bm = bmesh.new()
    bm.from_mesh(body_vm.data)
    dl = bm.verts.layers.deform.active
    kill = []
    for v in bm.verts:
        w = {names[i]: x for i, x in v[dl].items()} if dl else {}
        arm = sum(x for n, x in w.items() if n in arm_names)
        lower = sum(x for n, x in w.items() if n.startswith(("forearm", "hand")))
        if not (lower > 0.25 or arm > 0.85):
            kill.append(v)
    bmesh.ops.delete(bm, geom=kill, context="VERTS")
    bm.to_mesh(body_vm.data)
    bm.free()
    out_objs = []
    for new, src in keep:
        new.vertex_groups.clear()
        for s in src.material_slots:
            new.data.materials.append(s.material)
        key = src.name
        if key == "Body_Uniform":
            TRI_TARGET["Body_Uniform"] = 7000
            TEX_SIZE["Body_Uniform"] = 1024
        bake_ready_mesh(new, None, keep_armature=False, key=key)
        smart_uv(new)
        bake_object(new, "VM_", key=key)
        new.data.transform(inv)          # ライフル原点・ライフル軸の座標系へ
        new.matrix_world = Matrix.Identity(4)
        out_objs.append(new)
    out_objs = split_viewmodel(out_objs)
    ctx_select(out_objs, out_objs[0])
    bpy.ops.export_scene.gltf(
        filepath=outpath, export_format="GLB", use_selection=True, export_animations=False,
        export_image_format="JPEG", export_jpeg_quality=88, export_apply=False, export_yup=True)
    print("exported", outpath, os.path.getsize(outpath) // 1024, "KB")


def split_viewmodel(objs):
    """リロードで別々に動かせるよう、ライフル本体／マガジン／左腕／右腕に分ける。
    腕は袖・手袋のつながった塊ごとに、ライフル座標の Y（+ が銃の左＝支持手側）で左右を判定する"""
    pieces = {"ArmL": [], "ArmR": [], "Rifle": [], "Magazine": []}
    for ob in objs:
        ctx_select([ob], ob)
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        is_rifle = "Rifle" in ob.name
        if is_rifle:
            bpy.ops.mesh.separate(type="MATERIAL")
        else:
            bpy.ops.mesh.separate(type="LOOSE")
        bpy.ops.object.mode_set(mode="OBJECT")
        parts = list(bpy.context.selected_objects)
        for pt in parts:
            me = pt.data
            if not me.polygons:
                continue
            if is_rifle:
                mats = {me.materials[p.material_index].name for p in me.polygons if me.materials}
                key = "Magazine" if any("Magazine" in m or "_2" in m for m in mats) else "Rifle"
            else:
                cy = sum(v.co.y for v in me.vertices) / len(me.vertices)
                key = "ArmL" if cy > 0.0 else "ArmR"
            pieces[key].append(pt)
    out = []
    for key, arr in pieces.items():
        if not arr:
            continue
        ctx_select(arr, arr[0])
        if len(arr) > 1:
            bpy.ops.object.join()
        o = bpy.context.view_layer.objects.active
        o.name = key
        o.data.name = key
        out.append(o)
        print("  viewmodel piece", key, len(o.data.polygons), "faces")
    return out


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    soldier, ghost, outdir = argv[0], argv[1], argv[2]
    os.makedirs(outdir, exist_ok=True)
    motions = load_motions()
    only = argv[3] if len(argv) > 3 else "all"
    if only in ("all", "soldier"):
        export_soldier(os.path.abspath(soldier), os.path.join(outdir, "soldier.glb"), motions)
    if only in ("all", "viewmodel"):
        export_viewmodel(os.path.abspath(ghost), os.path.join(outdir, "viewmodel.glb"), motions)
    if only in ("all", "avatar"):
        # 三人称視点用のプレイヤー（ゴースト版）
        export_soldier(os.path.abspath(ghost), os.path.join(outdir, "avatar.glb"), motions)


if __name__ == "__main__":
    main()
