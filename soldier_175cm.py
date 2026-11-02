"""
Blender 用：身長175cmの男性軍人（フルフェイス軍用マスク着用）をプロシージャル生成するスクリプト

使い方
  GUI   : Blender の Scripting タブでこのファイルを開いて「Run Script」
  CLI   : blender --background --python soldier_175cm.py -- --save soldier.blend --render renders
          （同じフォルダの soldier_motions.py があればモーションも自動で追加。不要なら --no-motions）
          ゴーストマスク版: ... -- --variant ghost --save soldier_ghost.blend
          （GUI で実行する場合はファイル末尾の DEFAULT_VARIANT を "ghost" に変更）
  bpy   : python soldier_175cm.py --save soldier.blend --render renders

単位はメートル。キャラクターは -Y 方向（Blender のフロントビュー側）を向き、足元が Z=0。
頭頂（ヘルメットなし）がおよそ 1.75m。
"""

import math
import os
import sys

import bpy
import bmesh
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

HEIGHT = 1.75  # 目標身長（m）。全パーツはこの値を基準に設計

# ---------------------------------------------------------------------------
# 汎用ジオメトリ関数
# ---------------------------------------------------------------------------

def V(*a):
    return Vector(a)


def srgb(hexstr, a=1.0):
    """#RRGGBB -> linear RGBA"""
    h = hexstr.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (*out, a)


def basis_from_z(z, up=V(0, 0, 1)):
    """z 軸を指定した 3x3 回転行列"""
    z = z.normalized()
    if abs(z.dot(up)) > 0.95:
        up = V(0, 1, 0)
    x = up.cross(z).normalized()
    y = z.cross(x)
    return Matrix((x, y, z)).transposed()


def cr(p0, p1, p2, p3, t):
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                  + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t)


def resample(keys, sub=4):
    """Catmull-Rom でキー断面を滑らかに補間"""
    n = len(keys)
    out = []
    for i in range(n - 1):
        k0, k1, k2, k3 = keys[max(i - 1, 0)], keys[i], keys[i + 1], keys[min(i + 2, n - 1)]
        for s in range(sub):
            t = s / sub
            out.append(tuple(cr(a, b, c, d, t) for a, b, c, d in zip(k0, k1, k2, k3)))
    out.append(tuple(keys[-1]))
    return out


def loft(bm, keys, side=V(1, 0, 0), segs=24, n=2.0, M=None, mirror=False, sub=4, mat=0):
    """断面 (x, y, z, rx, ry) の列から閉じたチューブを生成（両端キャップ付き）。
    rx は side 方向、ry はそれと直交する方向の半径。n は超楕円指数（2=楕円）。"""
    ks = resample(keys, sub) if sub > 1 else keys
    pts = [V(k[0], k[1], k[2]) for k in ks]
    rads = [(k[3], k[4]) for k in ks]
    sides = [side.copy() for _ in pts]
    if M is not None:
        R = M.to_3x3()
        pts = [M @ p for p in pts]
        sides = [R @ s for s in sides]
    if mirror:
        pts = [V(-p.x, p.y, p.z) for p in pts]
        sides = [V(-s.x, s.y, s.z) for s in sides]
    rings = []
    last = len(pts) - 1
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, last)] - pts[max(i - 1, 0)]).normalized()
        s = sides[i] - t * sides[i].dot(t)
        if s.length < 1e-6:
            s = t.orthogonal()
        s.normalize()
        f = t.cross(s)
        rx, ry = rads[i]
        ring = []
        for j in range(segs):
            a = 2 * math.pi * j / segs
            c, sn = math.cos(a), math.sin(a)
            x = rx * math.copysign(abs(c) ** (2 / n), c)
            y = ry * math.copysign(abs(sn) ** (2 / n), sn)
            ring.append(bm.verts.new(p + s * x + f * y))
        rings.append(ring)
    faces = []
    for r0, r1 in zip(rings, rings[1:]):
        for j in range(segs):
            j1 = (j + 1) % segs
            faces.append(bm.faces.new((r0[j], r0[j1], r1[j1], r1[j])))
    for ring, p in ((rings[0], pts[0]), (rings[-1], pts[-1])):
        c = bm.verts.new(p)
        for j in range(segs):
            faces.append(bm.faces.new((c, ring[(j + 1) % segs], ring[j])))
    for f in faces:
        f.material_index = mat
        f.smooth = True
    return faces


def ellipsoid(bm, center, radii, M=None, mirror=False, u=24, v=16, mat=0):
    S = Matrix.Diagonal((*radii, 1.0))
    T = Matrix.Translation(center) @ S
    if M is not None:
        T = M @ T
    if mirror:
        T = Matrix.Diagonal((-1, 1, 1, 1)) @ T
    r = bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=1.0, matrix=T)
    fs = {f for vv in r["verts"] for f in vv.link_faces}
    for f in fs:
        f.material_index = mat
        f.smooth = True


def box(bm, center, size, R=None, mat=0):
    R = R if R is not None else Matrix.Identity(3)
    T = Matrix.Translation(center) @ R.to_4x4() @ Matrix.Diagonal((*size, 1.0))
    r = bmesh.ops.create_cube(bm, size=1.0, matrix=T)
    for f in {f for vv in r["verts"] for f in vv.link_faces}:
        f.material_index = mat
        f.smooth = True


def cylinder(bm, center, axis, r1, r2, depth, segs=40, mat=0):
    T = Matrix.Translation(center) @ basis_from_z(axis).to_4x4()
    r = bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs,
                              radius1=r1, radius2=r2, depth=depth, matrix=T)
    for f in {f for vv in r["verts"] for f in vv.link_faces}:
        f.material_index = mat
        f.smooth = True


def torus(bm, center, axis, R, r, seg=40, rseg=10, mat=0):
    B = basis_from_z(axis)
    rings = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        d = V(math.cos(a), math.sin(a), 0)
        ring = []
        for j in range(rseg):
            b = 2 * math.pi * j / rseg
            p = d * (R + r * math.cos(b)) + V(0, 0, r * math.sin(b))
            ring.append(bm.verts.new(center + B @ p))
        rings.append(ring)
    for i in range(seg):
        i1 = (i + 1) % seg
        for j in range(rseg):
            j1 = (j + 1) % rseg
            f = bm.faces.new((rings[i][j], rings[i1][j], rings[i1][j1], rings[i][j1]))
            f.material_index = mat
            f.smooth = True


def solid_grid(bm, P, D, off, thick, wrap=False, mat=0):
    """曲面上のグリッド点 P[i][j] と押し出し方向 D[i][j] から厚みのある板を作る。
    （ボディ表面に沿うベスト・マスク・パッド類に使用）"""
    nu, nv = len(P), len(P[0])
    vin = [[bm.verts.new(P[i][j] + D[i][j] * off) for j in range(nv)] for i in range(nu)]
    vout = [[bm.verts.new(P[i][j] + D[i][j] * (off + thick)) for j in range(nv)] for i in range(nu)]
    faces = []
    iu = range(nu) if wrap else range(nu - 1)
    for i in iu:
        i1 = (i + 1) % nu
        for j in range(nv - 1):
            faces.append(bm.faces.new((vout[i][j], vout[i1][j], vout[i1][j + 1], vout[i][j + 1])))
            faces.append(bm.faces.new((vin[i][j + 1], vin[i1][j + 1], vin[i1][j], vin[i][j])))
    # 側面（縁）
    for j in (0, nv - 1):
        for i in iu:
            i1 = (i + 1) % nu
            faces.append(bm.faces.new((vin[i][j], vin[i1][j], vout[i1][j], vout[i][j])))
    if not wrap:
        for i in (0, nu - 1):
            for j in range(nv - 1):
                faces.append(bm.faces.new((vin[i][j], vin[i][j + 1], vout[i][j + 1], vout[i][j])))
    for f in faces:
        f.material_index = mat
        f.smooth = True
    bmesh.ops.recalc_face_normals(bm, faces=faces)
    return faces


def ray_outer(bvh, origin, d, maxd=1.0):
    """レイが最後に抜ける面（＝最も外側の表面）を返す"""
    d = d.normalized()
    cur = origin.copy()
    last = None
    remain = maxd
    for _ in range(32):
        loc, nor, _, dist = bvh.ray_cast(cur, d, remain)
        if loc is None:
            break
        last = (loc, nor)
        cur = loc + d * 1e-4
        remain -= dist + 1e-4
        if remain <= 0:
            break
    if last is None:
        return origin + d * 0.1, d
    return last


def lerp(a, b, t):
    return a + (b - a) * t


# ---------------------------------------------------------------------------
# シーン／オブジェクト管理
# ---------------------------------------------------------------------------

COLL = None


def make_obj(name, bm, mats=(), mods=()):
    me = bpy.data.meshes.new(name)
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    ob = bpy.data.objects.new(name, me)
    COLL.objects.link(ob)
    for kind, kw in mods:
        md = ob.modifiers.new(kind.title(), kind)
        for k, v in kw.items():
            setattr(md, k, v)
    return ob


def apply_modifiers(ob):
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    eo = ob.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(eo, preserve_all_data_layers=True, depsgraph=dg)
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    me.name = old.name
    bpy.data.meshes.remove(old)


def assign_by_position(ob, fn):
    """面中心座標から material_index を決める"""
    me = ob.data
    n = len(me.polygons)
    co = [0.0] * (3 * n)
    me.polygons.foreach_get("center", co)
    idx = [fn(V(co[3 * i], co[3 * i + 1], co[3 * i + 2])) for i in range(n)]
    me.polygons.foreach_set("material_index", idx)
    me.update()


def remesh_object(name, bm, voxel, mats, smooth_iter=6, smooth_factor=0.5):
    ob = make_obj(name, bm, mats, mods=[
        ("REMESH", dict(mode="VOXEL", voxel_size=voxel, adaptivity=0.0, use_smooth_shade=True)),
        ("SMOOTH", dict(factor=smooth_factor, iterations=smooth_iter)),
    ])
    apply_modifiers(ob)
    for m in mats:
        if m.name not in ob.data.materials:
            ob.data.materials.append(m)
    return ob


# ---------------------------------------------------------------------------
# マテリアル
# ---------------------------------------------------------------------------

def new_mat(name):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (600, 0)
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    b.location = (300, 0)
    nt.links.new(b.outputs["BSDF"], out.inputs["Surface"])
    return m, nt, b


def sset(node, name, val):
    if name in node.inputs:
        node.inputs[name].default_value = val


def texcoord(nt):
    return nt.nodes.new("ShaderNodeTexCoord").outputs["Object"]


def noise(nt, vec, scale, detail=2.0, rough=0.5, distortion=0.0):
    n = nt.nodes.new("ShaderNodeTexNoise")
    nt.links.new(vec, n.inputs["Vector"])
    sset(n, "Scale", scale)
    sset(n, "Detail", detail)
    sset(n, "Roughness", rough)
    sset(n, "Distortion", distortion)
    return n.outputs["Fac"]


def wave(nt, vec, scale, direction="X", distortion=0.0):
    w = nt.nodes.new("ShaderNodeTexWave")
    w.wave_type = "BANDS"
    w.bands_direction = direction
    nt.links.new(vec, w.inputs["Vector"])
    sset(w, "Scale", scale)
    sset(w, "Distortion", distortion)
    sset(w, "Detail", 0.0)
    return w.outputs["Fac"]


def math_op(nt, op, a, b=None):
    m = nt.nodes.new("ShaderNodeMath")
    m.operation = op
    for k, x in enumerate((a, b)):
        if x is None:
            continue
        if isinstance(x, (int, float)):
            m.inputs[k].default_value = x
        else:
            nt.links.new(x, m.inputs[k])
    return m.outputs[0]


def ramp(nt, fac, stops, interp="CONSTANT"):
    r = nt.nodes.new("ShaderNodeValToRGB")
    r.color_ramp.interpolation = interp
    els = r.color_ramp.elements
    els[0].position, els[0].color = stops[0]
    els[1].position, els[1].color = stops[1]
    for pos, col in stops[2:]:
        e = els.new(pos)
        e.color = col
    nt.links.new(fac, r.inputs["Fac"])
    return r.outputs["Color"]


def mix_rgb(nt, fac, a, b):
    m = nt.nodes.new("ShaderNodeMix")
    m.data_type = "RGBA"
    ins = {s.identifier: s for s in m.inputs}
    outs = {s.identifier: s for s in m.outputs}
    for sock, val in ((ins["Factor_Float"], fac), (ins["A_Color"], a), (ins["B_Color"], b)):
        if isinstance(val, (int, float)):
            sock.default_value = val
        elif isinstance(val, tuple):
            sock.default_value = val
        else:
            nt.links.new(val, sock)
    return outs["Result_Color"]


def bump(nt, height, strength, distance, normal=None):
    b = nt.nodes.new("ShaderNodeBump")
    sset(b, "Strength", strength)
    sset(b, "Distance", distance)
    nt.links.new(height, b.inputs["Height"])
    if normal is not None:
        nt.links.new(normal, b.inputs["Normal"])
    return b.outputs["Normal"]


def weave_bump(nt, co, scale=314.0, strength=0.15, normal=None):
    w = math_op(nt, "ADD", wave(nt, co, scale, "X"), wave(nt, co, scale, "Z"))
    return bump(nt, w, strength, 0.0003, normal)


THEMES = {
    # 砂漠系マルチカム + コヨーテ装備
    "multicam": dict(
        camo=["#56573A", "#8A7A5C", "#A2936F", "#6A5137", "#4E5034"], camo_dark="#33291D", grime="#4A4234",
        gear="#7E6243", gear_dark="#4F3D29", molle="#3A2C1D", webbing="#4C4232",
        helmet=("#8A7356", "#5E4C38"), gloves=("#3A3A31", "#1E1E1A"), boot=("#7D6548", "#4E3E2C")),
    # 参考画像のような黒一色の特殊部隊装備（生地の擦れで微妙な濃淡）
    "black": dict(
        camo=["#111214", "#16171A", "#1B1C1F", "#141517", "#0F1012"], camo_dark="#0B0B0C", grime="#26262A",
        gear="#141416", gear_dark="#0A0A0B", molle="#060607", webbing="#101011",
        helmet=("#19191B", "#0D0D0E"), gloves=("#111111", "#080808"), boot=("#141413", "#0A0A09"), sheen=0.12),
}


def build_materials(theme="multicam"):
    T = THEMES[theme]
    M = {}

    # --- 迷彩戦闘服（マルチカム系の多色迷彩） ---
    m, nt, b = new_mat("Uniform_Camo")
    co = texcoord(nt)
    n1 = noise(nt, co, 6.0, 4.0, 0.55, 0.8)
    base = ramp(nt, n1, [
        (0.0, srgb(T["camo"][0])), (0.40, srgb(T["camo"][1])), (0.53, srgb(T["camo"][2])),
        (0.59, srgb(T["camo"][3])), (0.65, srgb(T["camo"][4])),
    ])
    co2 = nt.nodes.new("ShaderNodeVectorMath")
    co2.operation = "ADD"
    nt.links.new(co, co2.inputs[0])
    co2.inputs[1].default_value = (13.7, 5.1, 9.3)
    n2 = noise(nt, co2.outputs[0], 14.0, 3.0, 0.5, 0.5)
    speck = ramp(nt, n2, [(0.0, (0, 0, 0, 1)), (0.66, (1, 1, 1, 1))])
    col = mix_rgb(nt, math_op(nt, "MULTIPLY", speck_to_val(nt, speck), 0.9), base, srgb(T["camo_dark"]))
    grime = noise(nt, co, 30.0, 6.0, 0.6)
    col = mix_rgb(nt, math_op(nt, "MULTIPLY", grime, 0.18), col, srgb(T["grime"]))
    nt.links.new(col, b.inputs["Base Color"])
    sset(b, "Roughness", 0.92)
    sset(b, "Sheen Weight", T.get("sheen", 0.35))
    sset(b, "Sheen Roughness", 0.6)
    nrm = weave_bump(nt, co, 314.0, 0.12)
    wr = noise(nt, co, 11.0, 4.0, 0.55, 0.5)
    nrm = bump(nt, wr, 0.35, 0.004, nrm)
    nt.links.new(nrm, b.inputs["Normal"])
    M["uniform"] = m

    # --- バラクラバ（目出し帽ニット） ---
    m, nt, b = new_mat("Balaclava")
    co = texcoord(nt)
    sset(b, "Base Color", srgb("#121212"))
    sset(b, "Roughness", 0.95)
    sset(b, "Specular IOR Level", 0.2)
    sset(b, "Sheen Weight", 0.15)
    nt.links.new(bump(nt, wave(nt, co, 220.0, "Z", 2.0), 0.25, 0.0006), b.inputs["Normal"])
    M["balaclava"] = m

    # --- コヨーテ色ナイロン装備（MOLLE ウェビング付き） ---
    def gear(name, hexcol, molle):
        m, nt, b = new_mat(name)
        co = texcoord(nt)
        var = noise(nt, co, 18.0, 4.0, 0.6)
        col = mix_rgb(nt, math_op(nt, "MULTIPLY", var, 0.25), srgb(hexcol), srgb(T["gear_dark"]))
        nrm = weave_bump(nt, co, 250.0, 0.2)
        if molle:
            bands = wave(nt, co, 8.27, "Z")  # 約3.8cm周期 = MOLLE 1インチ帯+隙間
            band = math_op(nt, "GREATER_THAN", bands, 0.38)
            col = mix_rgb(nt, math_op(nt, "MULTIPLY", band, 0.18), col, srgb(T["molle"]))
            nrm = bump(nt, band, 0.5, 0.0015, nrm)
        nt.links.new(col, b.inputs["Base Color"])
        nt.links.new(nrm, b.inputs["Normal"])
        sset(b, "Roughness", 0.85)
        sset(b, "Sheen Weight", 0.2)
        return m

    M["vest"] = gear("Gear_MOLLE", T["gear"], True)
    M["gear"] = gear("Gear", T["gear"], False)
    M["webbing"] = gear("Webbing", T["webbing"], False)

    # --- 樹脂（ホルスター・レール・マガジン等） ---
    m, nt, b = new_mat("Polymer_Black")
    co = texcoord(nt)
    sset(b, "Base Color", srgb("#1C1C1B"))
    sset(b, "Roughness", 0.55)
    nt.links.new(bump(nt, noise(nt, co, 900.0, 2.0), 0.08, 0.0002), b.inputs["Normal"])
    M["polymer"] = m

    # --- ヘルメット（コヨーテ、粒状塗装） ---
    m, nt, b = new_mat("Helmet_Coyote")
    co = texcoord(nt)
    var = noise(nt, co, 25.0, 3.0)
    nt.links.new(mix_rgb(nt, math_op(nt, "MULTIPLY", var, 0.2), srgb(T["helmet"][0]), srgb(T["helmet"][1])),
                 b.inputs["Base Color"])
    sset(b, "Roughness", 0.78)
    nt.links.new(bump(nt, noise(nt, co, 450.0, 2.0), 0.25, 0.0004), b.inputs["Normal"])
    M["helmet"] = m

    # --- ガスマスクのゴム ---
    m, nt, b = new_mat("Mask_Rubber")
    co = texcoord(nt)
    sset(b, "Base Color", srgb("#141414"))
    sset(b, "Roughness", 0.42)
    sset(b, "Coat Weight", 0.15)
    nt.links.new(bump(nt, noise(nt, co, 300.0, 3.0), 0.08, 0.0003), b.inputs["Normal"])
    M["rubber"] = m

    # --- レンズ ---
    m, nt, b = new_mat("Mask_Lens")
    sset(b, "Base Color", srgb("#0B0F10"))
    sset(b, "Roughness", 0.03)
    sset(b, "IOR", 1.52)
    sset(b, "Coat Weight", 1.0)
    sset(b, "Coat Roughness", 0.0)
    M["lens"] = m

    # --- グローブ ---
    m, nt, b = new_mat("Gloves")
    co = texcoord(nt)
    var = noise(nt, co, 60.0, 3.0)
    nt.links.new(mix_rgb(nt, math_op(nt, "MULTIPLY", var, 0.3), srgb(T["gloves"][0]), srgb(T["gloves"][1])),
                 b.inputs["Base Color"])
    sset(b, "Roughness", 0.75)
    nt.links.new(bump(nt, noise(nt, co, 500.0, 2.0), 0.2, 0.0003), b.inputs["Normal"])
    M["gloves"] = m

    # --- ブーツ（スエード）／ソール ---
    m, nt, b = new_mat("Boot_Suede")
    co = texcoord(nt)
    var = noise(nt, co, 40.0, 5.0, 0.6)
    nt.links.new(mix_rgb(nt, math_op(nt, "MULTIPLY", var, 0.35), srgb(T["boot"][0]), srgb(T["boot"][1])),
                 b.inputs["Base Color"])
    sset(b, "Roughness", 0.95)
    sset(b, "Sheen Weight", 0.3)
    nt.links.new(bump(nt, noise(nt, co, 700.0, 2.0), 0.2, 0.0003), b.inputs["Normal"])
    M["boot"] = m

    m, nt, b = new_mat("Boot_Sole")
    co = texcoord(nt)
    sset(b, "Base Color", srgb("#191817"))
    sset(b, "Roughness", 0.7)
    nt.links.new(bump(nt, wave(nt, co, 40.0, "Y", 3.0), 0.6, 0.002), b.inputs["Normal"])
    M["sole"] = m

    # --- 銃：アルマイト金属 / 樹脂ファニチャー / アルミマガジン ---
    for key, name, col, metal, rough in (("gunmetal", "Gun_Anodized", "#1E1F21", 0.6, 0.42),
                                         ("gun_polymer", "Gun_Polymer", "#171717", 0.0, 0.6),
                                         ("magazine", "Gun_Magazine", "#5D5E5E", 0.75, 0.48)):
        m, nt, b = new_mat(name)
        co = texcoord(nt)
        var = noise(nt, co, 80.0, 4.0)
        nt.links.new(mix_rgb(nt, math_op(nt, "MULTIPLY", var, 0.25), srgb(col), srgb("#0C0C0C")),
                     b.inputs["Base Color"])
        sset(b, "Metallic", metal)
        sset(b, "Roughness", rough)
        nt.links.new(bump(nt, noise(nt, co, 1200.0, 2.0), 0.06, 0.0001), b.inputs["Normal"])
        M[key] = m

    # --- 地面（コンクリート） ---
    m, nt, b = new_mat("Ground_Concrete")
    co = texcoord(nt)
    n = noise(nt, co, 3.0, 8.0, 0.6)
    nt.links.new(ramp(nt, n, [(0.3, srgb("#5E574B")), (0.7, srgb("#7C7262"))], "LINEAR"),
                 b.inputs["Base Color"])
    sset(b, "Roughness", 0.9)
    nt.links.new(bump(nt, noise(nt, co, 120.0, 6.0), 0.3, 0.002), b.inputs["Normal"])
    M["ground"] = m
    return M


def speck_to_val(nt, color_socket):
    s = nt.nodes.new("ShaderNodeRGBToBW")
    nt.links.new(color_socket, s.inputs["Color"])
    return s.outputs["Val"]


# ---------------------------------------------------------------------------
# 体（戦闘服を着た状態の体型）
# ---------------------------------------------------------------------------

# 肩・腕の基準
SHOULDER = V(0.18, 0.0, 1.405)
ABD = math.radians(24)                 # 腕の開き（Aポーズ寄りの自然な立ち姿）
UPPER = V(math.sin(ABD), 0.0, -math.cos(ABD)).normalized()
ELBOW = SHOULDER + UPPER * 0.29
FORE = V(0.27, -0.26, -0.93).normalized()   # 肘を少し曲げ、手がやや前に来る
WRIST = ELBOW + FORE * 0.255
LATERAL = V(math.cos(ABD), 0.0, math.sin(ABD))

HIP = V(0.093, 0.0, 0.93)
KNEE = V(0.100, -0.015, 0.50)
ANKLE = V(0.105, 0.02, 0.095)


def torso_parts(bm):
    T = [  # (x, y, z, 半幅, 半奥行き)
        (0, 0.000, 0.825, 0.10, 0.08),
        (0, 0.005, 0.87, 0.165, 0.11),
        (0, 0.005, 0.94, 0.172, 0.115),
        (0, 0.000, 1.02, 0.158, 0.108),
        (0, -0.005, 1.08, 0.148, 0.105),
        (0, -0.008, 1.16, 0.152, 0.110),
        (0, -0.010, 1.24, 0.163, 0.118),
        (0, -0.010, 1.32, 0.172, 0.123),
        (0, -0.005, 1.39, 0.175, 0.115),
        (0, 0.000, 1.43, 0.155, 0.098),
        (0, 0.005, 1.465, 0.110, 0.075),
        (0, 0.005, 1.49, 0.066, 0.060),
    ]
    loft(bm, T, V(1, 0, 0), segs=32, n=2.6)
    for s in (False, True):
        ellipsoid(bm, V(0.07, 0.045, 0.90), (0.085, 0.075, 0.085), mirror=s)   # 臀部
        ellipsoid(bm, V(0.075, -0.055, 1.32), (0.08, 0.06, 0.07), mirror=s)    # 胸
        ellipsoid(bm, V(0.10, 0.01, 1.435), (0.088, 0.07, 0.048), mirror=s)   # 僧帽筋
        ellipsoid(bm, V(0.12, 0.05, 1.33), (0.07, 0.06, 0.09), mirror=s)       # 肩甲骨/広背筋
    loft(bm, [(0, 0.008, 1.47, 0.080, 0.077), (0, 0.010, 1.512, 0.075, 0.073)],
         V(1, 0, 0), segs=28, sub=1)                                           # 襟


def head_parts(bm):
    loft(bm, [(0, 0.012, 1.45, 0.070, 0.068), (0, 0.010, 1.52, 0.064, 0.064),
              (0, 0.004, 1.60, 0.058, 0.060)], V(1, 0, 0), segs=24)            # 首
    ellipsoid(bm, V(0, 0.005, 1.65), (0.078, 0.098, 0.105))                    # 頭蓋
    ellipsoid(bm, V(0, -0.035, 1.585), (0.062, 0.07, 0.06))                    # 顎・顔
    ellipsoid(bm, V(0, -0.055, 1.665), (0.066, 0.05, 0.035))                   # 眉弓
    ellipsoid(bm, V(0, -0.098, 1.625), (0.011, 0.02, 0.024))                   # 鼻
    for s in (False, True):
        ellipsoid(bm, V(0.045, -0.07, 1.625), (0.025, 0.02, 0.018), mirror=s)  # 頬骨
    for s in (False, True):
        ellipsoid(bm, V(0.078, 0.01, 1.635), (0.012, 0.025, 0.03), mirror=s)   # 耳


def arm_parts(bm):
    S, E, W, u, f = SHOULDER, ELBOW, WRIST, UPPER, FORE
    keys = []
    for p, r in ((S - u * 0.05, (0.06, 0.06)), (S, (0.058, 0.062)), (S + u * 0.06, (0.055, 0.057)),
                 (S + u * 0.15, (0.051, 0.053)), (E - u * 0.03, (0.046, 0.047)), (E, (0.044, 0.046)),
                 (E + f * 0.05, (0.046, 0.046)), (E + f * 0.13, (0.042, 0.040)),
                 (W - f * 0.03, (0.037, 0.034)), (W, (0.035, 0.032))):
        keys.append((p.x, p.y, p.z, r[0], r[1]))
    for s in (False, True):
        loft(bm, keys, V(1, 0, 0), segs=24, mirror=s)
        ellipsoid(bm, V(0.182, 0.0, 1.39), (0.062, 0.068, 0.078), mirror=s)            # 三角筋
        pc = S + u * 0.13 + LATERAL * 0.043
        ellipsoid(bm, pc, (0.009, 0.04, 0.05), mirror=s)                               # 袖ポケット


def leg_parts(bm):
    L = [
        (0.090, 0.005, 1.00, 0.100, 0.110),
        (0.093, 0.000, 0.90, 0.092, 0.097),
        (0.096, -0.005, 0.78, 0.082, 0.085),
        (0.098, -0.008, 0.66, 0.070, 0.074),
        (0.100, -0.012, 0.56, 0.061, 0.064),
        (0.100, -0.016, 0.50, 0.059, 0.063),
        (0.101, -0.006, 0.44, 0.058, 0.062),
        (0.102, 0.004, 0.36, 0.060, 0.066),
        (0.103, 0.012, 0.30, 0.060, 0.064),
        (0.104, 0.016, 0.265, 0.065, 0.068),   # ブーツ上のブラウジング（裾のたるみ）
        (0.105, 0.018, 0.225, 0.050, 0.054),
        (0.105, 0.020, 0.12, 0.042, 0.045),
    ]
    for s in (False, True):
        loft(bm, L, V(1, 0, 0), segs=28, mirror=s)
        ellipsoid(bm, V(0.166, -0.008, 0.67), (0.013, 0.058, 0.072), mirror=s)   # カーゴポケット
        ellipsoid(bm, V(0.10, -0.068, 0.505), (0.04, 0.008, 0.045), mirror=s)   # 膝パッド用ポケット


def build_body(M):
    bm = bmesh.new()
    torso_parts(bm)
    head_parts(bm)
    arm_parts(bm)
    leg_parts(bm)
    ob = remesh_object("Body_Uniform", bm, 0.004, [M["uniform"], M["balaclava"]])

    def region(c):
        return 1 if (c.z > 1.514 and abs(c.x) < 0.11) else 0
    assign_by_position(ob, region)
    # 生地のたるみ・シワ（大小2層のディスプレイスメント）
    for name, kind, size, strength in (("Fabric_Folds", "CLOUDS", 0.045, 0.007),
                                       ("Fabric_Creases", "MARBLE", 0.02, 0.0025)):
        tex = bpy.data.textures.new(name, kind)
        tex.noise_scale = size
        if kind == "MARBLE":
            tex.marble_type = "SHARPER"
            tex.turbulence = 6.0
        md = ob.modifiers.new(name, "DISPLACE")
        md.texture = tex
        md.texture_coords = "LOCAL"
        md.strength = strength
        md.mid_level = 0.5
    return ob


def bvh_of(fn):
    bm = bmesh.new()
    fn(bm)
    bm.normal_update()
    t = BVHTree.FromBMesh(bm)
    bm.free()
    return t


# ---------------------------------------------------------------------------
# 手（グローブ）
# ---------------------------------------------------------------------------

def hand_matrix():
    f = FORE
    N = V(-1.0, 0.3, 0.0)
    N = (N - f * N.dot(f)).normalized()       # 手のひらは太もも側
    W = f.cross(N)
    R = Matrix((-N, W, -f)).transposed()
    return Matrix.Translation(WRIST) @ R.to_4x4()


def hand_parts(bm, M, mirror):
    X = V(1, 0, 0)
    loft(bm, [(0, 0, 0.045, 0.040, 0.043), (0, 0, 0.0, 0.034, 0.039)], X, segs=24, n=2.4,
         M=M, mirror=mirror, sub=2)                                                      # カフ
    loft(bm, [(0, 0, 0.02, 0.020, 0.030), (0, 0, -0.02, 0.018, 0.036),
              (0.001, -0.002, -0.06, 0.016, 0.042), (0.002, 0, -0.09, 0.014, 0.042)],
         X, segs=24, n=3.0, M=M, mirror=mirror)                                          # 手のひら
    ellipsoid(bm, V(0.016, 0.0, -0.08), (0.009, 0.040, 0.013), M=M, mirror=mirror)        # ナックルガード
    fingers = [  # (y, 長さ, 太さ, 開き)
        (-0.029, 0.078, 0.0098, -0.03),
        (-0.009, 0.086, 0.0102, -0.01),
        (0.011, 0.080, 0.0096, 0.02),
        (0.029, 0.064, 0.0088, 0.05),
    ]
    for y, length, r, spread in fingers:
        segs = (0.45, 0.30, 0.25)
        bends = (math.radians(25), math.radians(55), math.radians(80))
        p = V(0.0, y, -0.084)

        def d_of(th):
            return V(-math.sin(th) * math.cos(spread), math.sin(spread), -math.cos(th) * math.cos(spread))
        keys = [(*(p - d_of(0.0) * 0.012), r * 1.05, r * 1.15), (*p, r, r * 1.1)]
        for k in range(3):
            d = d_of(bends[k])
            p = p + d * (length * segs[k])
            rr = r * (1.0 - 0.07 * (k + 1))
            keys.append((*p, rr, rr * 1.05))
        keys.append((*(p + d_of(bends[2]) * 0.006), r * 0.55, r * 0.55))
        loft(bm, keys, X, segs=16, M=M, mirror=mirror, sub=3)
    p = V(-0.010, -0.032, -0.012)
    keys = [(*p, 0.016, 0.018)]
    for d, l, r in ((V(-0.35, -0.55, -0.75), 0.040, 0.0135), (V(-0.5, -0.35, -0.8), 0.032, 0.0112),
                    (V(-0.6, -0.15, -0.78), 0.026, 0.0098)):
        p = p + d.normalized() * l
        keys.append((*p, r, r * 1.05))
    keys.append((*(p + V(-0.6, -0.15, -0.78).normalized() * 0.006), 0.006, 0.006))
    loft(bm, keys, X, segs=16, M=M, mirror=mirror, sub=3)                                # 親指


def build_gloves(M):
    bm = bmesh.new()
    HM = hand_matrix()
    for s in (False, True):
        hand_parts(bm, HM, s)
    return remesh_object("Gloves", bm, 0.0025, [M["gloves"]], smooth_iter=4)


# ---------------------------------------------------------------------------
# ブーツ
# ---------------------------------------------------------------------------

def build_boots(M):
    bm = bmesh.new()
    x0 = 0.105
    shaft = [(x0, 0.012, 0.24, 0.050, 0.055), (x0, 0.014, 0.19, 0.046, 0.053),
             (x0, 0.018, 0.14, 0.044, 0.055), (x0, 0.024, 0.095, 0.047, 0.064),
             (x0, 0.03, 0.06, 0.048, 0.068)]
    foot = []  # 底面 z=0.024 に揃える： (x, y, 中心z, 半幅, 半高さ)
    for y, rx, ry, dx in ((0.088, 0.028, 0.034, 0.0), (0.072, 0.041, 0.046, 0.0), (0.04, 0.045, 0.056, 0.001),
                          (0.0, 0.045, 0.054, 0.003), (-0.05, 0.048, 0.044, 0.007), (-0.10, 0.051, 0.035, 0.011),
                          (-0.14, 0.048, 0.030, 0.013), (-0.17, 0.041, 0.027, 0.014), (-0.19, 0.03, 0.022, 0.015),
                          (-0.198, 0.012, 0.012, 0.015)):
        y, ry = 0.02 + (y - 0.02) * 0.87, ry * 0.9          # 全長約28cm
        foot.append((x0 + dx, y, 0.024 + ry + (0.004 if y < -0.13 else 0.0), rx, ry))
    sole = []
    for y, rx, dx in ((0.094, 0.032, 0.0), (0.082, 0.045, 0.0), (0.04, 0.049, 0.001), (0.0, 0.048, 0.003),
                      (-0.05, 0.054, 0.007), (-0.10, 0.057, 0.011), (-0.14, 0.053, 0.013),
                      (-0.175, 0.044, 0.014), (-0.198, 0.028, 0.015), (-0.207, 0.012, 0.015)):
        y = 0.02 + (y - 0.02) * 0.87
        z = 0.016 + (0.007 if y < -0.14 else 0.0)
        sole.append((x0 + dx, y, z, rx, 0.016))
    for s in (False, True):
        loft(bm, shaft, V(1, 0, 0), segs=28, mirror=s)
        loft(bm, foot, V(1, 0, 0), segs=28, mirror=s)
        loft(bm, sole, V(1, 0, 0), segs=28, n=5.0, mirror=s, sub=3)
        loft(bm, [(x0, 0.012, 0.248, 0.054, 0.059), (x0, 0.012, 0.228, 0.053, 0.058)],
             V(1, 0, 0), segs=28, mirror=s, sub=1)                                  # 履き口のパッド
        ellipsoid(bm, V(x0 + 0.004, -0.038, 0.068), (0.03, 0.05, 0.024), mirror=s)  # 甲（タン）
        ellipsoid(bm, V(x0, 0.07, 0.07), (0.04, 0.03, 0.045), mirror=s)              # ヒールカウンター
    ob = remesh_object("Boots", bm, 0.003, [M["boot"], M["sole"]], smooth_iter=4)
    assign_by_position(ob, lambda c: 1 if c.z < 0.031 else 0)

    # 靴紐・アイレット
    lb = bmesh.new()

    def front_y(z):
        for (_, y0, z0, _, r0), (_, y1, z1, _, r1) in zip(shaft, shaft[1:]):
            if z1 <= z <= z0:
                t = (z0 - z) / (z0 - z1)
                return lerp(y0 - r0, y1 - r1, t)
        return shaft[-1][1] - shaft[-1][4]
    for s in (1, -1):
        prev = None
        for k in range(7):
            z = 0.225 - k * 0.022
            y = front_y(z) - 0.003
            pts = []
            for dx in (-0.019, 0.019):
                p = V((x0 + dx) * s, y + abs(dx) * 0.35, z)
                cylinder(lb, p, V(0, -1, 0), 0.0042, 0.0042, 0.004, segs=10)
                pts.append(p)
            if prev:
                for a_, b_ in ((prev[0], pts[1]), (prev[1], pts[0])):
                    mid = (a_ + b_) / 2 + V(0, -0.003, 0)
                    d = (b_ - a_)
                    R = basis_from_z(d.normalized(), V(0, -1, 0))
                    box(lb, mid, (0.004, 0.0025, d.length), R=R)
            prev = pts
        # 甲部分の紐（つま先方向へ）
        for k in range(3):
            y = -0.03 - k * 0.019
            z = 0.024 + 0.05 - k * 0.006 + 0.004
            box(lb, V((x0 + 0.004) * s, y, z), (0.036, 0.004, 0.003),
                R=Matrix.Rotation(math.radians(-20), 3, "X"))
    laces = make_obj("Boot_Laces", lb, [M["polymer"]],
                     mods=[("BEVEL", dict(width=0.0008, segments=2, limit_method="ANGLE"))])
    return ob, laces


# ---------------------------------------------------------------------------
# プレートキャリア／ベルト／ニーパッド
# ---------------------------------------------------------------------------

def build_vest(M, torso_bvh):
    bm = bmesh.new()
    info = {}

    def plate(z0, z1, front, hw_full=0.13, hw_top=0.07):
        dirv = V(0, -1, 0) if front else V(0, 1, 0)
        nu, nv = 27, 31

        def hw(v):
            return hw_full if v < 0.72 else lerp(hw_full, hw_top, (v - 0.72) / 0.28)
        hits = [[None] * nv for _ in range(nu)]
        for i in range(nu):
            u = -1 + 2 * i / (nu - 1)
            for j in range(nv):
                v = j / (nv - 1)
                z = lerp(z0, z1, v)
                x = u * hw(v)
                loc, _ = ray_outer(torso_bvh, V(x, 0.0, z), dirv)
                hits[i][j] = (x, loc.y, z)
        sel = min if front else max
        ycol = [sel(h[1] for h in hits[i]) for i in range(nu)]
        yc = ycol[nu // 2]
        ycol = [yc + (y - yc) * 0.55 for y in ycol]          # 板は体より平ら
        P = [[V(hits[i][j][0], lerp(hits[i][j][1], ycol[i], 0.45), hits[i][j][2]) for j in range(nv)]
             for i in range(nu)]
        D = [[dirv.copy() for _ in range(nv)] for _ in range(nu)]
        solid_grid(bm, P, D, 0.008, 0.045)          # プレート＋キャリアで約 4.5cm
        # 外側の面位置（ポーチ配置用）
        sign = -1 if front else 1
        def surface(x, z):
            i = max(0, min(nu - 1, round((x / hw_full + 1) / 2 * (nu - 1))))
            j = max(0, min(nv - 1, round((z - z0) / (z1 - z0) * (nv - 1))))
            return P[i][j].y + sign * 0.054
        return surface

    info["front"] = plate(1.04, 1.41, True)
    info["back"] = plate(1.06, 1.43, False, 0.13, 0.08)

    # カマーバンド（脇）
    for side in (1, -1):
        nu, nv = 30, 9
        P, D = [], []
        for i in range(nu):
            th = math.radians(lerp(36, 144, i / (nu - 1))) * side
            d = V(math.sin(th), -math.cos(th), 0)
            P.append([]), D.append([])
            for j in range(nv):
                z = lerp(1.03, 1.215, j / (nv - 1))
                loc, _ = ray_outer(torso_bvh, V(0, 0.0, z), d)
                P[-1].append(loc)
                D[-1].append(d)
        solid_grid(bm, P, D, 0.005, 0.02)           # カマーバンド（ソフトアーマー入り）

    # ショルダーストラップ
    for side in (1, -1):
        nu, nv = 7, 34
        P, D = [], []
        for i in range(nu):
            x = (0.105 + lerp(-0.03, 0.03, i / (nu - 1))) * side
            P.append([]), D.append([])
            for j in range(nv):
                ph = math.radians(lerp(8, 172, j / (nv - 1)))
                d = V(0, -math.cos(ph), math.sin(ph))
                loc, _ = ray_outer(torso_bvh, V(x, 0.0, 1.30), d)
                P[-1].append(loc)
                D[-1].append(d)
        solid_grid(bm, P, D, 0.006, 0.02)           # パッド入りショルダーストラップ

    ob = make_obj("PlateCarrier", bm, [M["vest"]], mods=[("SUBSURF", dict(levels=1, render_levels=2))])
    return ob, info


def build_pouches(M, torso_bvh, info):
    bm = bmesh.new()
    G, P = 0, 1
    yf = info["front"]
    # マガジンポーチ ×3 + マガジン
    for x in (-0.08, 0.0, 0.08):
        y = min(yf(x, 1.10), yf(x, 1.19))
        box(bm, V(x, y - 0.027, 1.145), (0.076, 0.054, 0.13), mat=G)
        box(bm, V(x, y - 0.027, 1.22), (0.064, 0.026, 0.05), mat=P)
        box(bm, V(x, y - 0.0555, 1.165), (0.05, 0.006, 0.014), mat=G)     # ショックコード留め
    # アドミンポーチ（胸上部）
    y = min(yf(-0.09, 1.29), yf(0.0, 1.29), yf(0.09, 1.29))
    box(bm, V(0, y - 0.021, 1.29), (0.19, 0.042, 0.088), mat=G)
    box(bm, V(0, y - 0.0435, 1.31), (0.09, 0.004, 0.045), mat=G)          # パッチ用ベルクロ
    # 背面：無線機ポーチ + アンテナ
    yb = info["back"]
    y = max(yb(0.05, 1.2), yb(0.12, 1.2), yb(0.05, 1.33), yb(0.12, 1.33))
    box(bm, V(0.085, y + 0.031, 1.27), (0.075, 0.062, 0.155), mat=G)
    box(bm, V(0.085, y + 0.031, 1.36), (0.05, 0.04, 0.03), mat=P)
    ax = V(0.18, 0.12, 1.0).normalized()
    cylinder(bm, V(0.095, y + 0.031, 1.375) + ax * 0.17, ax, 0.0045, 0.0028, 0.34, segs=12, mat=P)
    # 背面：ハイドレーション（中央）
    y = max(yb(-0.08, 1.12), yb(0.0, 1.12), yb(-0.08, 1.28), yb(0.0, 1.28))
    box(bm, V(-0.04, y + 0.03, 1.2), (0.1, 0.06, 0.22), mat=G)
    # ドラッグハンドル
    box(bm, V(0.0, yb(0.0, 1.42) - 0.03, 1.418), (0.09, 0.02, 0.016), mat=1)
    ob = make_obj("Pouches", bm, [M["gear"], M["polymer"]],
                  mods=[("BEVEL", dict(width=0.006, segments=3, limit_method="ANGLE"))])
    return ob


def build_belt(M, torso_bvh):
    bm = bmesh.new()
    nu, nv = 80, 6
    P, D = [], []
    for i in range(nu):
        th = 2 * math.pi * i / nu
        d = V(math.sin(th), -math.cos(th), 0)
        P.append([]), D.append([])
        for j in range(nv):
            z = lerp(0.955, 1.012, j / (nv - 1))
            loc, _ = ray_outer(torso_bvh, V(0, 0.0, z), d)
            P[-1].append(loc)
            D[-1].append(d)
    solid_grid(bm, P, D, 0.004, 0.022, wrap=True)    # パッド入り戦闘ベルト
    belt = make_obj("Belt", bm, [M["webbing"]], mods=[("SUBSURF", dict(levels=1, render_levels=2))])

    hw = bmesh.new()
    G, PL = 0, 1
    loc, _ = ray_outer(torso_bvh, V(0, 0, 0.985), V(0, -1, 0))
    box(hw, V(0, loc.y - 0.02, 0.985), (0.06, 0.012, 0.045), mat=PL)              # バックル
    # 右腰ホルスター（キャラクターの右 = -X）
    R = Matrix.Rotation(math.radians(-8), 3, "X")
    box(hw, V(-0.197, 0.012, 0.915), (0.042, 0.072, 0.175), R=R, mat=PL)
    box(hw, V(-0.197, 0.03, 1.03), (0.028, 0.04, 0.085),
        R=Matrix.Rotation(math.radians(-18), 3, "X"), mat=PL)                       # 拳銃グリップ
    box(hw, V(-0.183, 0.012, 0.99), (0.02, 0.06, 0.05), mat=PL)                      # ベルトマウント
    # 左後ろダンプポーチ、右前マガジンポーチ
    loc, _ = ray_outer(torso_bvh, V(0.12, 0, 0.965), V(0.4, 1, 0))
    box(hw, loc + V(0.01, 0.03, -0.01), (0.10, 0.05, 0.12),
        R=Matrix.Rotation(math.radians(-22), 3, "Z"), mat=G)
    loc, _ = ray_outer(torso_bvh, V(-0.1, 0, 0.98), V(-0.5, -1, 0))
    box(hw, loc + V(-0.01, -0.02, -0.01), (0.04, 0.03, 0.1),
        R=Matrix.Rotation(math.radians(-25), 3, "Z"), mat=G)
    hard = make_obj("Belt_Gear", hw, [M["gear"], M["polymer"]],
                    mods=[("BEVEL", dict(width=0.005, segments=3, limit_method="ANGLE"))])
    return belt, hard


def build_kneepads(M, leg_bvh):
    bm = bmesh.new()
    for side in (1, -1):
        cx, cy = KNEE.x * side, KNEE.y
        nu, nv = 21, 13
        P, D = [], []
        for i in range(nu):
            P.append([]), D.append([])
            for j in range(nv):
                v = j / (nv - 1)
                z = lerp(0.445, 0.58, v)
                tmax = 55 * math.sqrt(max(0.0, 1 - ((2 * v - 1) ** 2) * 0.55))
                th = math.radians(lerp(-tmax, tmax, i / (nu - 1)))
                d = V(math.sin(th), -math.cos(th), 0)
                loc, _ = ray_outer(leg_bvh, V(cx, cy, z), d, 0.085)
                P[-1].append(loc)
                D[-1].append(d)
        solid_grid(bm, P, D, 0.003, 0.022, mat=0)
        for z0 in (0.46, 0.535):  # ストラップ
            nu2 = 28
            P, D = [], []
            for i in range(nu2):
                th = math.radians(lerp(50, 310, i / (nu2 - 1)))
                d = V(math.sin(th), -math.cos(th), 0)
                P.append([]), D.append([])
                for z in (z0, z0 + 0.022):
                    loc, _ = ray_outer(leg_bvh, V(cx, cy, z), d, 0.085)
                    P[-1].append(loc)
                    D[-1].append(d)
            solid_grid(bm, P, D, 0.001, 0.004, mat=1)
    return make_obj("KneePads", bm, [M["polymer"], M["webbing"]],
                    mods=[("SUBSURF", dict(levels=1, render_levels=2))])


# ---------------------------------------------------------------------------
# ヘルメット（ハイカット）
# ---------------------------------------------------------------------------

HC = V(0.0, 0.006, 1.652)
HR = V(0.101, 0.119, 0.116)


def e_cut(ph):
    return 0.0475 + 0.425 * math.cos(ph) - 0.0725 * math.cos(2 * ph)


def helmet_pt(ph, e, extra=0.0):
    d = V(math.cos(e) * math.sin(ph), -math.cos(e) * math.cos(ph), math.sin(e))
    p = HC + V(HR.x * d.x, HR.y * d.y, HR.z * d.z)
    n = V(d.x / HR.x, d.y / HR.y, d.z / HR.z).normalized()
    return p + n * extra, n


def build_helmet(M):
    bm = bmesh.new()
    nu, nv = 96, 26
    P, D = [], []
    for i in range(nu):
        ph = 2 * math.pi * i / nu
        e0 = e_cut(ph)
        P.append([]), D.append([])
        for j in range(nv):
            e = lerp(e0, math.pi / 2 - 0.06, (j / (nv - 1)) ** 0.9)
            p, n = helmet_pt(ph, e)
            P[-1].append(p)
            D[-1].append(n)
    solid_grid(bm, P, D, 0.0, 0.011, wrap=True, mat=0)

    # トップのベルクロパッチ（極の穴も塞ぐ）
    def patch(ph0, ph1, e0, e1, nu=14, nv=8, off=0.011, th=0.003, mat=2):
        P, D = [], []
        for i in range(nu):
            P.append([]), D.append([])
            for j in range(nv):
                p, n = helmet_pt(lerp(ph0, ph1, i / (nu - 1)), lerp(e0, e1, j / (nv - 1)))
                P[-1].append(p)
                D[-1].append(n)
        solid_grid(bm, P, D, off, th, mat=mat)
    for k in range(4):
        a = k * math.pi / 2
        patch(a - 0.80, a + 0.80, 1.18, 1.53, nu=12, nv=6)
    patch(math.pi - 0.55, math.pi + 0.55, 0.15, 0.62)                    # 後頭部パッチ
    # サイドレール
    for side in (1, -1):
        keys, sides = [], []
        for k in range(12):
            ph = math.radians(lerp(52, 128, k / 11)) * side
            p, n = helmet_pt(ph, e_cut(ph) + 0.11, 0.016)
            keys.append((p.x, p.y, p.z, 0.006, 0.012))
            sides.append(n)
        # loft は side を一律で受けるので、レールは短い区間ごとに生成
        for k in range(11):
            loft(bm, keys[k:k + 2], sides[k], segs=12, n=8.0, sub=1, mat=1)
        # ヘッドセット/ライト用のマウント
        p, n = helmet_pt(math.radians(100) * side, e_cut(math.radians(100)) + 0.11, 0.03)
        box(bm, p, (0.02, 0.03, 0.02), R=basis_from_z(n), mat=1)
    # NVG マウント（シュラウド）
    p, n = helmet_pt(0.0, e_cut(0.0) + 0.09, 0.017)
    R = basis_from_z(n)
    box(bm, p, (0.055, 0.04, 0.014), R=R, mat=1)
    box(bm, p + n * 0.012 + V(0, 0, -0.008), (0.028, 0.018, 0.012), R=R, mat=1)
    # バッテリーパック（後頭部）
    p, n = helmet_pt(math.pi, 0.35, 0.03)
    box(bm, p, (0.075, 0.035, 0.04), R=basis_from_z(n), mat=2)
    ob = make_obj("Helmet", bm, [M["helmet"], M["polymer"], M["webbing"]],
                  mods=[("SUBSURF", dict(levels=1, render_levels=2))])
    return ob


# ---------------------------------------------------------------------------
# ガスマスク（フルフェイス、デュアルレンズ＋ツインフィルター）
# ---------------------------------------------------------------------------

MC = V(0.0, -0.01, 1.615)
MASK_OFF = 0.006
MASK_TH = 0.006


def mask_dir(ph, e):
    return V(math.sin(ph) * math.cos(e), -math.cos(ph) * math.cos(e), math.sin(e))


def mask_bulge(phd, ed):
    return 0.024 * math.exp(-((phd / 30.0) ** 2 + ((ed + 24.0) / 19.0) ** 2))


def mask_surface(head_bvh, phd, ed, extra=0.0):
    d = mask_dir(math.radians(phd), math.radians(ed))
    loc, _ = ray_outer(head_bvh, MC, d, 0.4)
    return loc + d * (MASK_OFF + MASK_TH + mask_bulge(phd, ed) + extra), d


def build_mask(M, head_bvh):
    bm = bmesh.new()
    nu, nv = 41, 33
    e_min, e_max = -60.0, 40.0
    em, eh = (e_min + e_max) / 2, (e_max - e_min) / 2
    P, D = [], []
    for i in range(nu):
        P.append([]), D.append([])
        for j in range(nv):
            ed = lerp(e_min, e_max, j / (nv - 1))
            t = (ed - em) / eh
            phmax = max(18.0, 82.0 * (1 - abs(t) ** 3) ** (1 / 3))
            phd = lerp(-phmax, phmax, i / (nu - 1))
            d = mask_dir(math.radians(phd), math.radians(ed))
            loc, _ = ray_outer(head_bvh, MC, d, 0.4)
            P[-1].append(loc + d * mask_bulge(phd, ed))
            D[-1].append(d)
    solid_grid(bm, P, D, MASK_OFF, MASK_TH, mat=0)

    # ヘッドハーネス（後頭部へ回るストラップ）
    for ed in (24.0, -12.0):
        P, D = [], []
        for i in range(40):
            phd = lerp(70, 290, i / 39)
            P.append([]), D.append([])
            for k in (-1, 1):
                d = mask_dir(math.radians(phd), math.radians(ed + 3.0 * k))
                loc, _ = ray_outer(head_bvh, MC, d, 0.4)
                P[-1].append(loc)
                D[-1].append(d)
        solid_grid(bm, P, D, 0.002, 0.003, mat=0)
    face = make_obj("GasMask", bm, [M["rubber"]], mods=[("SUBSURF", dict(levels=2, render_levels=2))])

    parts = bmesh.new()
    R_, L_, PL = 0, 1, 2
    # レンズ
    LR = 0.0275
    for s in (1, -1):
        p, d = mask_surface(head_bvh, 20 * s, 21)
        nrm = (d + V(0, -1.2, 0)).normalized()
        # レンズ円の範囲にあるゴム面の最も手前の位置を調べ、そこまで持ち上げる
        lift = 0.0
        for a in range(-16, 17):
            for b in range(-16, 17):
                q, _ = mask_surface(head_bvh, 20 * s + a, 21 + b)
                rel = q - p
                h = rel.dot(nrm)
                if (rel - nrm * h).length < LR + 0.007:
                    lift = max(lift, h)
        top = p + nrm * (lift + 0.002)
        # ゴムのレンズ台座（マスク面から立ち上がる短い筒）
        cylinder(parts, p + nrm * (lift - 0.004) / 2, nrm, LR + 0.006, LR + 0.005,
                 lift + 0.008, segs=48, mat=R_)
        torus(parts, top + nrm * 0.0015, nrm, LR + 0.0015, 0.004, mat=PL)        # 金属/樹脂リング
        ellipsoid_on_axis(parts, top, nrm, LR, 0.005, mat=L_)
    # 吸気／発声部（口元）
    p, d = mask_surface(head_bvh, 0, -26)
    ax = (d + V(0, -0.8, -0.2)).normalized()
    cylinder(parts, p + ax * 0.004, ax, 0.024, 0.021, 0.02, mat=PL)
    cylinder(parts, p + ax * 0.016, ax, 0.019, 0.019, 0.006, mat=R_)
    for k in range(5):  # グリル
        box(parts, p + ax * 0.02 + V(0, 0, -0.012 + 0.006 * k), (0.026, 0.003, 0.0022),
            R=basis_from_z(ax), mat=PL)
    # ツインフィルター（頬）
    for s in (1, -1):
        p, d = mask_surface(head_bvh, 50 * s, -24)
        ax = (d + V(0, -0.35, -0.25)).normalized()
        cylinder(parts, p + ax * 0.005, ax, 0.026, 0.026, 0.014, mat=R_)         # マウント
        cylinder(parts, p + ax * 0.025, ax, 0.043, 0.043, 0.028, mat=PL)        # キャニスター
        torus(parts, p + ax * 0.012, ax, 0.042, 0.0035, mat=PL)
        torus(parts, p + ax * 0.038, ax, 0.042, 0.0035, mat=PL)
        cylinder(parts, p + ax * 0.040, ax, 0.03, 0.03, 0.004, mat=R_)          # 前面ラベル部
    # 顎の排気バルブ
    p, d = mask_surface(head_bvh, 0, -48)
    cylinder(parts, p, (d + V(0, -0.3, -0.6)).normalized(), 0.016, 0.014, 0.014, mat=R_)
    mp = make_obj("GasMask_Parts", parts, [M["rubber"], M["lens"], M["polymer"]],
                  mods=[("BEVEL", dict(width=0.0012, segments=2, limit_method="ANGLE"))])
    return face, mp


def ellipsoid_on_axis(bm, center, axis, r, depth, mat=0):
    T = Matrix.Translation(center) @ basis_from_z(axis).to_4x4() @ Matrix.Diagonal((r, r, depth, 1))
    res = bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=1.0, matrix=T)
    for f in {f for vv in res["verts"] for f in vv.link_faces}:
        f.material_index = mat
        f.smooth = True


# ---------------------------------------------------------------------------
# ゴーストマスク版（スカル柄バラクラバ + シューティンググラス + ヘッドセット）
# ---------------------------------------------------------------------------

SKULL_X0, SKULL_W = -0.115, 0.23     # 顔の正面投影範囲（オブジェクト座標）
SKULL_Z0, SKULL_H = 1.495, 0.23


def make_skull_image(res=768):
    """顔正面に投影するスカル柄（陰影付きグレースケール：0=黒地, 1=骨の白）を手続き生成。
    頭部メッシュの目・鼻・口の位置に合わせて、眼窩・鼻腔・頬骨・上下の歯・下顎を描く。"""
    import numpy as np
    u = (np.arange(res) + 0.5) / res
    X, Z = np.meshgrid(SKULL_X0 + u * SKULL_W, SKULL_Z0 + u * SKULL_H)
    ax = np.abs(X)
    px = SKULL_W / res

    def soft(f, scale):          # f<0 が内側の陰関数 → アンチエイリアス付きマスク
        return np.clip(0.5 - f * scale / (1.5 * px), 0.0, 1.0)

    def ell(cx, cz, rx, rz, n=2.0, xs=None):
        xx = (ax if xs is None else xs) - cx
        f = (np.abs(xx / rx) ** n + np.abs((Z - cz) / rz) ** n) ** (1.0 / n) - 1.0
        return f, min(rx, rz)

    def mask(cx, cz, rx, rz, n=2.0, xs=None):
        f, r = ell(cx, cz, rx, rz, n, xs)
        return soft(f, r)

    def smooth(a, lo, hi):
        t = np.clip((a - lo) / (hi - lo), 0.0, 1.0)
        return t * t * (3 - 2 * t)

    # --- 輪郭：頭蓋 + 頬 + 下顎
    cran = mask(0, 1.672, 0.074, 0.075)
    cheek = mask(0, 1.618, 0.066, 0.042, 2.4)
    jw = 0.021 + 0.031 * smooth(Z, 1.521, 1.572)                      # 顎先は細く、エラで広がる
    jaw = soft(ax - jw, 1.0) * smooth(Z, 1.519, 1.526) * (1 - smooth(Z, 1.60, 1.61))
    chin = mask(0, 1.531, 0.024, 0.012)
    sil = np.maximum.reduce([cran, cheek, jaw, chin])
    # 骨の陰影：輪郭付近とこめかみを暗く
    f_c, _ = ell(0, 1.64, 0.072, 0.10)
    bone = 0.95 - 0.35 * smooth(f_c, -0.25, 0.05) - 0.18 * smooth(ax, 0.055, 0.075)
    # --- 眼窩（外側がやや下がった角丸の穴）と周囲のグラデーション
    cz = 1.655 - (ax - 0.0335) * 0.15                                   # 外側がやや下がる
    fs = (np.abs((ax - 0.0335) / 0.023) ** 2.6 + np.abs((Z - cz) / 0.0205) ** 2.6) ** (1 / 2.6) - 1.0
    sock = soft(fs, 0.0205)
    rim = 1.0 - smooth(fs, 0.0, 0.45)                                   # 眼窩縁の落ち込み
    brow = mask(0.03, 1.684, 0.03, 0.007)                               # 眉弓のハイライト
    # --- 鼻腔（逆ハート）
    nose = np.maximum(mask(0.0065, 1.614, 0.0085, 0.012), mask(0, 1.627, 0.0055, 0.012))
    fn = np.minimum(ell(0.0065, 1.614, 0.0085, 0.012)[0], ell(0, 1.627, 0.0055, 0.012)[0])
    nose_rim = 1.0 - smooth(fn, 0.0, 0.6)
    # --- 頬骨下の影と下顎の切れ目
    zyg = mask(0.052, 1.612, 0.016, 0.010) * (1 - mask(0.048, 1.62, 0.014, 0.009))
    ramus = soft(np.abs(ax - 0.047) - 0.0012, 1.0) * smooth(Z, 1.565, 1.57) * (1 - smooth(Z, 1.60, 1.605))
    # --- 歯（上下2列、外側ほど小さく、弧を描く）
    curve = (ax / 0.03) ** 2 * 0.004
    mouth = soft(ax - 0.031, 1.0) * smooth(Z, 1.557 + curve, 1.559 + curve) * \
        (1 - smooth(Z, 1.601 - curve, 1.603 - curve))
    tw = 0.0068 + 0.0012 * np.cos(np.clip(ax / 0.03, 0, 1) * math.pi / 2)
    phase = np.mod(ax, tw) / tw
    gaps = soft(np.minimum(phase, 1 - phase) * tw - 0.00045, 1.0)
    up_row = smooth(Z, 1.5815 + curve, 1.583 + curve) * (1 - smooth(Z, 1.5985 - curve, 1.600 - curve))
    lo_row = smooth(Z, 1.5605 + curve, 1.562 + curve) * (1 - smooth(Z, 1.5795 + curve, 1.581 + curve))
    teeth = (up_row + lo_row) * (1 - gaps) * soft(ax - 0.027, 1.0)
    tooth_shade = 0.9 - 0.25 * smooth(ax, 0.012, 0.027)

    v = sil * bone
    v = v * (1 - 0.55 * rim) + 0.12 * brow * sil
    v = v * (1 - sock)
    v = v * (1 - 0.4 * nose_rim) * (1 - nose)
    v = v * (1 - 0.6 * zyg) * (1 - 0.85 * ramus)
    v = v * (1 - mouth) + teeth * tooth_shade
    rng = np.random.default_rng(7)
    grain = rng.random((res, res)).astype(np.float32)
    blot = np.repeat(np.repeat(rng.random((res // 16, res // 16)), 16, 0), 16, 1)[:res, :res]
    v = np.clip(v * (0.86 + 0.1 * grain + 0.06 * blot), 0, 1).astype(np.float32)
    rgba = np.stack([v, v, v, np.ones_like(v)], axis=-1)
    img = bpy.data.images.new("SkullPrint", res, res, alpha=False)
    img.colorspace_settings.name = "Non-Color"   # 先に設定（後で変えるとピクセルが破棄される）
    img.pixels.foreach_set(rgba.ravel())
    img.update()
    img.pack()
    return img


def skull_material():
    m, nt, b = new_mat("Balaclava_Skull")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    co = tc.outputs["Object"]
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(co, sep.inputs[0])
    uu = math_op(nt, "MULTIPLY", math_op(nt, "SUBTRACT", sep.outputs["X"], SKULL_X0), 1.0 / SKULL_W)
    vv = math_op(nt, "MULTIPLY", math_op(nt, "SUBTRACT", sep.outputs["Z"], SKULL_Z0), 1.0 / SKULL_H)
    comb = nt.nodes.new("ShaderNodeCombineXYZ")
    nt.links.new(uu, comb.inputs["X"])
    nt.links.new(vv, comb.inputs["Y"])
    it = nt.nodes.new("ShaderNodeTexImage")
    it.image = make_skull_image()
    it.extension = "CLIP"
    nt.links.new(comb.outputs[0], it.inputs["Vector"])
    # 顔の前面だけに柄を出す（Y座標で滑らかにフェード）
    front = math_op(nt, "MULTIPLY", math_op(nt, "ADD", sep.outputs["Y"], 0.035), -1.0 / 0.03)
    front = math_op(nt, "MINIMUM", math_op(nt, "MAXIMUM", front, 0.0), 1.0)
    fac = math_op(nt, "MULTIPLY", speck_to_val(nt, it.outputs["Color"]), front)
    knit = wave(nt, co, 220.0, "Z", 2.0)
    col = mix_rgb(nt, fac, srgb("#121212"), srgb("#D9D3C4"))
    nt.links.new(col, b.inputs["Base Color"])
    sset(b, "Roughness", 0.95)
    sset(b, "Specular IOR Level", 0.2)
    sset(b, "Sheen Weight", 0.15)
    nt.links.new(bump(nt, knit, 0.25, 0.0006), b.inputs["Normal"])
    return m


def build_ghost(M, head_bvh):
    bm = bmesh.new()
    PL, LN = 0, 1
    # 4眼ナイトビジョン（跳ね上げ収納状態）
    sp, sn = helmet_pt(0.0, e_cut(0.0) + 0.09, 0.017)
    up = (V(0, 0, 1) - sn * sn.z).normalized()
    side = sn.cross(up).normalized()                     # キャラクターの右(-X)方向
    mount = sp + sn * 0.014 - up * 0.004
    box(bm, mount, (0.03, 0.02, 0.036), R=Matrix((side, sn, up)).transposed(), mat=PL)   # マウント
    tube_dir = (up * 0.62 + sn * 0.78).normalized()       # 跳ね上げ状態：管は前上方を向く
    fwd = side.cross(tube_dir).normalized()
    if fwd.dot(sn) < 0:
        fwd = -fwd
    base = mount + sn * 0.026 + up * 0.014
    Rb = Matrix((side, fwd, tube_dir)).transposed()
    box(bm, base, (0.12, 0.028, 0.026), R=Rb, mat=PL)                                    # ブリッジ
    for k, (dx, ang, r, ln) in enumerate(((-0.05, 22, 0.0135, 0.07), (-0.0175, 4, 0.0155, 0.082),
                                          (0.0175, -4, 0.0155, 0.082), (0.05, -22, 0.0135, 0.07))):
        d = (Matrix.Rotation(math.radians(ang), 3, fwd) @ tube_dir).normalized()
        p0 = base + side * dx
        cylinder(bm, p0 + d * (ln / 2), d, r, r * 0.97, ln, segs=28, mat=PL)
        cylinder(bm, p0 + d * (ln - 0.004), d, r * 1.08, r * 1.08, 0.012, segs=28, mat=PL)  # 先端リング
        ellipsoid_on_axis(bm, p0 + d * (ln + 0.002), d, r * 0.82, 0.003, mat=LN)          # 対物レンズ
        cylinder(bm, p0 - d * 0.012, d, r * 0.85, r * 0.9, 0.02, segs=24, mat=PL)        # 接眼部
    cyl_from = base - side * 0.07
    hp, _ = helmet_pt(math.pi * 0.62, 0.5, 0.012)
    loft(bm, [(*cyl_from, 0.003, 0.003), (*(cyl_from + V(-0.01, 0.03, 0.02)), 0.003, 0.003),
              (*hp, 0.003, 0.003)], V(0, 0, 1), segs=8, sub=4, mat=PL)                    # 電源ケーブル
    # ヘッドセット（イヤーカップ + ブームマイク）
    for s in (1, -1):
        c = V(s * 0.1, 0.008, 1.633)
        ax = V(s, 0, 0)
        cylinder(bm, c - ax * 0.006, ax, 0.041, 0.041, 0.02, segs=40, mat=PL)       # クッション側
        cylinder(bm, c + ax * 0.014, ax, 0.044, 0.038, 0.024, segs=40, mat=PL)      # シェル
        box(bm, c + ax * 0.03 + V(0, 0.0, 0.0), (0.012, 0.03, 0.03), mat=PL)         # 音量ボタン
        torus(bm, c - ax * 0.016, ax, 0.034, 0.008, mat=PL)                          # イヤーパッド
        # レール接続アーム
        hp, _ = helmet_pt(math.radians(100) * s, e_cut(math.radians(100)) + 0.11, 0.018)
        top = c + ax * 0.01 + V(0, 0, 0.038)
        loft(bm, [(top.x, top.y, top.z, 0.006, 0.01), (hp.x, hp.y, hp.z, 0.006, 0.01)],
             V(0, 1, 0), segs=10, n=4.0, sub=1, mat=PL)
    mouth, _ = ray_outer(head_bvh, V(0, -0.03, 1.578), V(0, -1, 0), 0.3)
    boom = [V(0.11, -0.02, 1.62), V(0.098, -0.07, 1.6), V(0.06, -0.112, 1.585),
            mouth + V(0.026, -0.022, 0.0)]
    loft(bm, [(*p, 0.0028, 0.0028) for p in boom], V(0, 0, 1), segs=10, sub=4, mat=PL)
    ellipsoid(bm, boom[-1] + V(-0.008, 0.0, 0.0), (0.012, 0.009, 0.009), mat=PL)     # マイクスポンジ
    return make_obj("Ghost_NVG_Headset", bm, [M["polymer"], M["lens"]],
                    mods=[("BEVEL", dict(width=0.0008, segments=2, limit_method="ANGLE"))])


# ---------------------------------------------------------------------------
# ライフル（M16A2 タイプ：固定A2ストック、キャリングハンドル、丸型リブ付きハンドガード）
# ライフルのローカル座標：+X=銃口方向, +Y=銃の左側, +Z=上（照準側）。原点=床尾板の後端・銃身軸の高さ
# ---------------------------------------------------------------------------

RIFLE_PTS = {
    "butt": V(0.004, 0.0, -0.035),       # 肩付けする床尾の中心
    "grip": V(0.356, 0.0, -0.100),       # 右手（グリップ握りの中心）
    "grip_axis": V(-0.04, 0.0, -0.11).normalized(),
    "guard_min": 0.575, "guard_max": 0.78,   # 左手で握れるハンドガード範囲（X）
    "guard_z": 0.0,
    "eye": V(0.235, 0.0, 0.088),         # 照準線上の目の位置（キャリングハンドルの照門の後方）
    "muzzle": V(1.006, 0.0, 0.0),
    "upper_swivel": V(0.875, 0.0, -0.04),
}


def ribbed_tube(bm, x0, x1, r0, r1, z=0.0, ribs=14, depth=0.08, segs=56, rings=24, mat=0):
    """長手方向のリブ（溝）が入った丸パイプ（A2 ハンドガード）"""
    rows = []
    for i in range(rings + 1):
        t = i / rings
        x = lerp(x0, x1, t)
        r = lerp(r0, r1, t)
        row = []
        for j in range(segs):
            a = 2 * math.pi * j / segs
            rr = r * (1.0 - depth * max(0.0, math.cos(ribs * a)) ** 6)
            row.append(bm.verts.new(V(x, rr * math.cos(a), z + rr * math.sin(a))))
        rows.append(row)
    fs = []
    for r0_, r1_ in zip(rows, rows[1:]):
        for j in range(segs):
            j1 = (j + 1) % segs
            fs.append(bm.faces.new((r0_[j], r1_[j], r1_[j1], r0_[j1])))
    for row in (rows[0], rows[-1]):
        fs.append(bm.faces.new(row))
    for f in fs:
        f.material_index = mat
        f.smooth = True


def prism(bm, pts2d, y_half, mat=0):
    """XZ 平面の多角形を Y 方向に押し出した板（照星・用心金など）"""
    a = [bm.verts.new(V(x, -y_half, z)) for x, z in pts2d]
    b = [bm.verts.new(V(x, y_half, z)) for x, z in pts2d]
    fs = [bm.faces.new(a[::-1]), bm.faces.new(b)]
    n = len(pts2d)
    for i in range(n):
        j = (i + 1) % n
        fs.append(bm.faces.new((a[i], a[j], b[j], b[i])))
    for f in fs:
        f.material_index = mat
        f.smooth = True
    bmesh.ops.recalc_face_normals(bm, faces=fs)


def build_rifle(M):
    bm = bmesh.new()
    MT, PO, MG = 0, 1, 2       # 金属（アルマイト）/ 樹脂 / マガジン
    Y = V(0, 1, 0)
    # ストック（A2 固定式）
    loft(bm, [(0.000, 0, -0.040, 0.0225, 0.066), (0.020, 0, -0.040, 0.023, 0.066),
              (0.120, 0, -0.033, 0.022, 0.053), (0.230, 0, -0.022, 0.0195, 0.037),
              (0.300, 0, -0.013, 0.018, 0.027)], Y, segs=32, n=4.0, mat=PO)
    box(bm, V(-0.003, 0, -0.040), (0.008, 0.047, 0.134), mat=MT)                         # 床尾板
    torus(bm, V(0.035, 0, -0.112), V(0, 1, 0), 0.009, 0.0018, seg=20, rseg=6, mat=MT)    # 後部スイベル
    # ロワーレシーバー
    box(bm, V(0.418, 0, -0.031), (0.236, 0.026, 0.048), mat=MT)
    prism(bm, [(0.445, -0.05), (0.52, -0.05), (0.522, -0.086), (0.447, -0.086)], 0.0155, mat=MT)  # マガジンウェル
    for zz in (-0.08, -0.0745):                                                            # 用心金（上下2本で枠）
        box(bm, V(0.408, 0, zz), (0.07, 0.008, 0.004), mat=MT)
    box(bm, V(0.441, 0, -0.066), (0.004, 0.008, 0.03), mat=MT)
    prism(bm, [(0.402, -0.053), (0.408, -0.053), (0.406, -0.072), (0.399, -0.070)], 0.003, mat=MT)  # 引き金
    cylinder(bm, V(0.39, 0.016, -0.025), Y, 0.007, 0.007, 0.004, segs=16, mat=MT)          # セレクター
    box(bm, V(0.398, 0.019, -0.022), (0.022, 0.003, 0.006), mat=MT)
    cylinder(bm, V(0.448, -0.015, -0.035), Y, 0.005, 0.005, 0.004, segs=12, mat=MT)         # マグキャッチ
    # グリップ
    g0, g1 = V(0.378, 0, -0.045), V(0.333, 0, -0.158)
    loft(bm, [(*g0, 0.0145, 0.019), (*lerp(g0, g1, 0.5), 0.0145, 0.019), (*g1, 0.014, 0.018)],
         Y, segs=24, n=3.5, sub=3, mat=PO)
    for t in (0.35, 0.62):                                                                 # フィンガーグルーブ
        ellipsoid(bm, lerp(g0, g1, t) + V(0.017, 0, 0), (0.006, 0.0135, 0.009), mat=PO)
    # アッパーレシーバー
    loft(bm, [(0.300, 0, 0.010, 0.0155, 0.024), (0.535, 0, 0.010, 0.0155, 0.024)], Y,
         segs=24, n=4.5, sub=1, mat=MT)
    box(bm, V(0.427, -0.016, 0.007), (0.068, 0.003, 0.022), mat=MT)                        # 排莢口カバー
    ellipsoid(bm, V(0.40, -0.019, 0.022), (0.012, 0.007, 0.008), mat=MT)                   # 薬莢デフレクター
    cylinder(bm, V(0.462, -0.024, 0.02), V(0.6, -1, 0), 0.008, 0.007, 0.03, segs=16, mat=MT)  # フォワードアシスト
    box(bm, V(0.31, 0, 0.03), (0.026, 0.05, 0.008), mat=MT)                                 # チャージングハンドル
    # キャリングハンドル + 照門
    box(bm, V(0.415, 0, 0.073), (0.165, 0.016, 0.014), mat=MT)
    box(bm, V(0.488, 0, 0.051), (0.024, 0.02, 0.034), mat=MT)
    box(bm, V(0.352, 0, 0.06), (0.05, 0.022, 0.054), mat=MT)
    box(bm, V(0.352, 0, 0.093), (0.016, 0.012, 0.012), mat=MT)                              # 照門アパーチャ
    cylinder(bm, V(0.37, 0, 0.073), Y, 0.009, 0.009, 0.034, segs=20, mat=MT)               # 照準調整ノブ
    cylinder(bm, V(0.352, 0, 0.083), Y, 0.009, 0.009, 0.028, segs=20, mat=MT)
    # デルタリング + ハンドガード
    cylinder(bm, V(0.545, 0, 0.0), V(1, 0, 0), 0.036, 0.036, 0.022, segs=40, mat=MT)
    ribbed_tube(bm, 0.556, 0.815, 0.0315, 0.0285, mat=PO)
    cylinder(bm, V(0.82, 0, 0.0), V(1, 0, 0), 0.027, 0.025, 0.012, segs=36, mat=MT)       # ハンドガードキャップ
    # 銃身・照星・消炎器
    cylinder(bm, V(0.91, 0, 0.0), V(1, 0, 0), 0.0095, 0.0088, 0.18, segs=24, mat=MT)
    box(bm, V(0.872, 0, 0.0), (0.03, 0.026, 0.032), mat=MT)                                 # 照星基部
    prism(bm, [(0.853, 0.012), (0.891, 0.012), (0.876, 0.07), (0.866, 0.07)], 0.006, mat=MT)
    for yy in (0.0085, -0.0085):                                                             # 照星ガード（耳）
        bmy = bmesh.new()
        prism(bmy, [(0.862, 0.055), (0.878, 0.055), (0.877, 0.086), (0.864, 0.086)], 0.0015)
        bmesh.ops.translate(bmy, verts=bmy.verts, vec=V(0, yy, 0))
        tmp = bpy.data.meshes.new("tmp")
        bmy.to_mesh(tmp)
        bmy.free()
        bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
    box(bm, V(0.871, 0, 0.083), (0.003, 0.003, 0.016), mat=MT)                               # 照星ポスト
    box(bm, V(0.872, 0, -0.026), (0.02, 0.012, 0.02), mat=MT)                                # 着剣ラグ
    torus(bm, V(0.872, 0, -0.045), Y, 0.01, 0.0018, seg=20, rseg=6, mat=MT)                 # 前部スイベル
    cylinder(bm, V(0.988, 0, 0.0), V(1, 0, 0), 0.011, 0.011, 0.036, segs=24, mat=MT)       # 消炎器
    for k in range(5):
        a = math.radians(-60 + k * 30) + math.pi / 2
        box(bm, V(0.992, 0.0105 * math.cos(a), 0.0105 * math.sin(a)), (0.022, 0.002, 0.002),
            R=Matrix.Rotation(a - math.pi / 2, 3, "X"), mat=PO)
    # 30連マガジン（湾曲）
    keys = []
    for k in range(7):
        t = k / 6
        keys.append((0.484 + 0.045 * t * t, 0, -0.07 - 0.19 * t, 0.0125, 0.032))
    loft(bm, keys, Y, segs=24, n=6.0, sub=2, mat=MG)
    box(bm, V(0.532, 0, -0.262), (0.075, 0.03, 0.012),
        R=Matrix.Rotation(math.radians(-18), 3, "Y"), mat=MG)                                 # 底板
    ob = make_obj("Rifle", bm, [M["gunmetal"], M["gun_polymer"], M["magazine"]],
                  mods=[("BEVEL", dict(width=0.0012, segments=2, limit_method="ANGLE"))])
    return ob


# ---------------------------------------------------------------------------
# アーマチュア（リグ）
# ---------------------------------------------------------------------------

def add_armature_mod(ob, arm):
    md = ob.modifiers.new("Armature", "ARMATURE")
    md.object = arm
    try:
        ob.modifiers.move(len(ob.modifiers) - 1, 0)
    except Exception:
        pass
    ob.parent = arm


def transfer_weights(src, dst, arm, k=6):
    """装備品は近傍のボディ頂点からウェイトをコピー（ボーンヒートより安定）"""
    from mathutils.kdtree import KDTree
    me = src.data
    kd = KDTree(len(me.vertices))
    for v in me.vertices:
        kd.insert(v.co, v.index)
    kd.balance()
    names = [g.name for g in src.vertex_groups]
    sw = [{names[g.group]: g.weight for g in v.groups} for v in me.vertices]
    groups = {n: dst.vertex_groups.new(name=n) for n in names}
    for v in dst.data.vertices:
        acc = {}
        tot = 0.0
        for co, idx, dist in kd.find_n(v.co, k):
            w = 1.0 / (dist + 1e-4)
            tot += w
            for n, x in sw[idx].items():
                acc[n] = acc.get(n, 0.0) + x * w
        for n, x in acc.items():
            if x / tot > 1e-3:
                groups[n].add([v.index], x / tot, "REPLACE")
    add_armature_mod(dst, arm)


def weight_gloves(ob, arm):
    """手首からの距離で forearm→hand をブレンド"""
    gs = {n: ob.vertex_groups.new(name=n) for n in ("forearm.L", "hand.L", "forearm.R", "hand.R")}
    for v in ob.data.vertices:
        sfx = ".L" if v.co.x > 0 else ".R"
        p = V(abs(v.co.x), v.co.y, v.co.z)
        t = (p - WRIST).dot(FORE)
        w = max(0.0, min(1.0, (t + 0.02) / 0.03))
        if w < 1.0:
            gs["forearm" + sfx].add([v.index], 1.0 - w, "REPLACE")
        if w > 0.0:
            gs["hand" + sfx].add([v.index], w, "REPLACE")
    add_armature_mod(ob, arm)


def sling_back_matrix():
    """非携行時：ライフルを背中に斜め掛け（銃の側面を背中に沿わせ、銃口は左肩の上）"""
    X = V(0.55, 0.0, 0.83).normalized()
    Yr = V(0.0, 1.0, 0.0)
    Z = X.cross(Yr)
    mid = V(0.0, 0.30, 1.12)
    o = mid - X * 0.5
    return Matrix(((X.x, Yr.x, Z.x, o.x), (X.y, Yr.y, Z.y, o.y), (X.z, Yr.z, Z.z, o.z), (0, 0, 0, 1)))


WEAPON_BONE_LEN = 0.2


def build_rig(deform_objs, rigid_head_objs, transfer_objs=(), glove_objs=(), rifle=None):
    ad = bpy.data.armatures.new("Soldier_Rig")
    arm = bpy.data.objects.new("Soldier_Rig", ad)
    COLL.objects.link(arm)
    ad.display_type = "STICK"
    arm.show_in_front = True
    vl = bpy.context.view_layer
    for o in vl.objects:
        o.select_set(False)
    vl.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = ad.edit_bones

    def bone(name, h, t, parent=None, connect=False):
        b = eb.new(name)
        b.head, b.tail = h, t
        if parent:
            b.parent = eb[parent]
            b.use_connect = connect
        return b

    bone("hips", V(0, 0.0, 0.94), V(0, 0, 1.04))
    bone("spine", V(0, 0, 1.04), V(0, 0, 1.18), "hips", True)
    bone("chest", V(0, 0, 1.18), V(0, 0, 1.40), "spine", True)
    bone("neck", V(0, 0.005, 1.45), V(0, 0.0, 1.56), "chest")
    bone("head", V(0, 0.0, 1.56), V(0, 0.0, 1.76), "neck", True)
    hm = hand_matrix()
    hand_tip = hm @ V(0, 0, -0.10)
    for sfx, s in ((".L", 1), (".R", -1)):
        def m(v):
            return V(v.x * s, v.y, v.z)
        bone("shoulder" + sfx, m(V(0.03, 0.0, 1.42)), m(SHOULDER), "chest")
        bone("upper_arm" + sfx, m(SHOULDER), m(ELBOW), "shoulder" + sfx, True)
        bone("forearm" + sfx, m(ELBOW), m(WRIST), "upper_arm" + sfx, True)
        bone("hand" + sfx, m(WRIST), m(hand_tip), "forearm" + sfx, True)
        bone("thigh" + sfx, m(HIP), m(KNEE), "hips")
        bone("shin" + sfx, m(KNEE), m(ANKLE), "thigh" + sfx, True)
        bone("foot" + sfx, m(ANKLE), m(V(0.115, -0.085, 0.03)), "shin" + sfx, True)
        bone("toe" + sfx, m(V(0.115, -0.085, 0.03)), m(V(0.12, -0.165, 0.03)), "foot" + sfx, True)
    # 武器ボーン（変形なし）：ボーンのテール＝ライフル原点。レスト位置は背中の斜め掛け
    wb = bone("weapon", V(0, 0, 0), V(0, WEAPON_BONE_LEN, 0))
    wb.matrix = sling_back_matrix() @ Matrix.Translation((0, -WEAPON_BONE_LEN, 0))
    wb.use_deform = False
    bpy.ops.object.mode_set(mode="OBJECT")
    if rifle is not None:
        rifle.parent = arm
        rifle.parent_type = "BONE"
        rifle.parent_bone = "weapon"
        rifle.matrix_parent_inverse = Matrix.Identity(4)
        rifle.matrix_basis = Matrix.Identity(4)

    for ob in deform_objs:
        for o in vl.objects:
            o.select_set(False)
        ob.select_set(True)
        arm.select_set(True)
        vl.objects.active = arm
        try:
            bpy.ops.object.parent_set(type="ARMATURE_AUTO")
        except Exception as ex:  # 自動ウェイトが失敗した場合はエンベロープ
            print("auto weights failed for", ob.name, ex)
            bpy.ops.object.parent_set(type="ARMATURE_ENVELOPE")
        # アーマチュアをモディファイア先頭へ
        idx = [i for i, md in enumerate(ob.modifiers) if md.type == "ARMATURE"]
        if idx and idx[0] != 0:
            try:
                ob.modifiers.move(idx[0], 0)
            except Exception:
                pass
    for ob in rigid_head_objs:
        vg = ob.vertex_groups.new(name="head")
        vg.add(list(range(len(ob.data.vertices))), 1.0, "REPLACE")
        add_armature_mod(ob, arm)
    for ob in transfer_objs:
        transfer_weights(deform_objs[0], ob, arm)
    for ob in glove_objs:
        weight_gloves(ob, arm)
    # ウェイト漏れチェック
    for ob in list(deform_objs) + list(transfer_objs) + list(glove_objs):
        empty = sum(1 for v in ob.data.vertices if sum(g.weight for g in v.groups) < 1e-4)
        print("weights %-14s verts=%7d unweighted=%d" % (ob.name, len(ob.data.vertices), empty))
    for o in vl.objects:
        o.select_set(False)
    return arm


# ---------------------------------------------------------------------------
# シーン（ライト・カメラ・地面）
# ---------------------------------------------------------------------------

def setup_scene(M):
    sc = bpy.context.scene
    sc.unit_settings.system = "METRIC"
    w = bpy.data.worlds.new("World")
    sc.world = w
    try:
        w.use_nodes = True
    except Exception:
        pass
    bg = w.node_tree.nodes.get("Background") or w.node_tree.nodes.new("ShaderNodeBackground")
    bg.inputs["Color"].default_value = srgb("#B9C3CC")
    bg.inputs["Strength"].default_value = 0.3
    out = [n for n in w.node_tree.nodes if n.type == "OUTPUT_WORLD"]
    out = out[0] if out else w.node_tree.nodes.new("ShaderNodeOutputWorld")
    w.node_tree.links.new(bg.outputs["Background"], out.inputs["Surface"])

    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=80.0)
    ground = make_obj("Ground", bm, [M["ground"]])
    ground.hide_select = True

    def light(name, kind, loc, energy, size=None, rot=None, color=(1, 1, 1)):
        ld = bpy.data.lights.new(name, kind)
        ld.energy = energy
        ld.color = color
        if size is not None:
            if kind == "SUN":
                ld.angle = size
            else:
                ld.size = size
        lo = bpy.data.objects.new(name, ld)
        lo.location = loc
        if rot:
            lo.rotation_euler = rot
        COLL.objects.link(lo)
        return lo

    target = bpy.data.objects.new("Cam_Target", None)
    target.location = (0, 0, 0.92)
    COLL.objects.link(target)

    def aim(ob, tgt):
        c = ob.constraints.new("TRACK_TO")
        c.target = tgt
        c.track_axis = "TRACK_NEGATIVE_Z"
        c.up_axis = "UP_Y"

    sun = light("Sun", "SUN", (0, 0, 5), 2.2, math.radians(3),
                (math.radians(48), math.radians(12), math.radians(-38)), (1.0, 0.96, 0.9))
    key = light("Key_Area", "AREA", (-2.4, -2.8, 2.6), 120, 2.0)
    aim(key, target)
    rim = light("Rim_Area", "AREA", (2.2, 2.6, 2.4), 220, 1.5, color=(0.85, 0.9, 1.0))
    aim(rim, target)
    _ = sun

    cd = bpy.data.cameras.new("Camera")
    cd.lens = 70
    cam = bpy.data.objects.new("Camera", cd)
    cam.location = (-1.75, -3.7, 1.15)
    COLL.objects.link(cam)
    aim(cam, target)
    sc.camera = cam

    sc.render.engine = "CYCLES"
    try:
        sc.cycles.device = "CPU"
        sc.cycles.samples = 96
        sc.cycles.use_denoising = True
    except Exception:
        pass
    sc.render.resolution_x = 900
    sc.render.resolution_y = 1600
    try:
        sc.view_settings.view_transform = "AgX"
        sc.view_settings.look = "AgX - Medium High Contrast"
    except Exception:
        pass
    return cam, target


# ---------------------------------------------------------------------------
# メイン
# ---------------------------------------------------------------------------

def build(variant="gas"):
    global COLL
    bpy.ops.wm.read_factory_settings(use_empty=True)
    COLL = bpy.data.collections.new("Soldier")
    bpy.context.scene.collection.children.link(COLL)

    M = build_materials("black" if variant == "ghost" else "multicam")
    if variant == "ghost":
        M["balaclava"] = skull_material()
    torso_bvh = bvh_of(torso_parts)
    head_bvh = bvh_of(head_parts)
    leg_bvh = bvh_of(leg_parts)

    body = build_body(M)
    gloves = build_gloves(M)
    boots, laces = build_boots(M)
    vest, info = build_vest(M, torso_bvh)
    pouches = build_pouches(M, torso_bvh, info)
    belt, belt_gear = build_belt(M, torso_bvh)
    knees = build_kneepads(M, leg_bvh)
    helmet = build_helmet(M)
    if variant == "ghost":
        face_gear = [build_ghost(M, head_bvh)]
    else:
        face_gear = list(build_mask(M, head_bvh))

    rifle = build_rifle(M)
    cam, target = setup_scene(M)
    rig = build_rig([body, boots, laces],
                    [helmet] + face_gear,
                    [vest, pouches, belt, belt_gear, knees],
                    [gloves], rifle=rifle)
    # ディスプレイスはアーマチュアより前（レスト形状基準）に置く
    for i, md in enumerate(list(body.modifiers)):
        if md.type == "DISPLACE":
            body.modifiers.move(i, sum(1 for m in body.modifiers[:i] if m.type == "DISPLACE"))
    print("Body modifiers:", [m.type for m in body.modifiers])
    for ob in [body, gloves, boots, laces, vest, pouches, belt, belt_gear, knees, helmet] + face_gear:
        if ob.parent is None:
            ob.parent = rig
    return dict(camera=cam, target=target, rig=rig)


def render_views(outdir, ctx, prefix=""):
    os.makedirs(outdir, exist_ok=True)
    sc = bpy.context.scene
    cam, target = ctx["camera"], ctx["target"]
    views = [
        ("front_34", (-1.75, -3.7, 1.15), (0, 0, 0.92), 70, (900, 1600)),
        ("back_34", (2.0, 3.55, 1.2), (0, 0, 0.92), 70, (900, 1600)),
        ("side", (4.0, -0.2, 1.0), (0, 0, 0.9), 70, (900, 1600)),
        ("head_closeup", (-0.62, -1.2, 1.74), (0, -0.01, 1.63), 85, (1000, 1000)),
    ]
    only = os.environ.get("SOLDIER_VIEWS")
    for name, loc, tgt, lens, res in views:
        if only and name not in only.split(","):
            continue
        cam.location = loc
        target.location = tgt
        cam.data.lens = lens
        sc.render.resolution_x, sc.render.resolution_y = res
        sc.render.filepath = os.path.join(outdir, prefix + name + ".png")
        bpy.ops.render.render(write_still=True)
    cam.location = views[0][1]
    target.location = views[0][2]
    cam.data.lens = 70
    sc.render.resolution_x, sc.render.resolution_y = views[0][4]


def main():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else argv[1:]
    save = render = None
    if "--save" in argv:
        save = os.path.abspath(argv[argv.index("--save") + 1])
    if "--render" in argv:
        render = os.path.abspath(argv[argv.index("--render") + 1])
    variant = argv[argv.index("--variant") + 1] if "--variant" in argv else DEFAULT_VARIANT
    ctx = build(variant)
    # 寸法チェック
    deps = bpy.context.evaluated_depsgraph_get()
    body = bpy.data.objects["Body_Uniform"]
    zs = [ (body.matrix_world @ v.co).z for v in body.data.vertices ]
    print("Body (balaclava top) height: %.3f m" % max(zs))
    _ = deps
    if render:
        render_views(render, ctx, "" if variant == "gas" else variant + "_")
    if "--no-motions" not in argv:
        add_motions(ctx["rig"])
    if save:
        bpy.ops.wm.save_as_mainfile(filepath=save)
        print("saved", save)


def add_motions(rig):
    """同じフォルダの soldier_motions.py で歩行・走行・しゃがみ・匍匐（素手／小銃）を焼き込む"""
    import importlib.util
    here = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.getcwd()
    path = os.path.join(here, "soldier_motions.py")
    if not os.path.exists(path):
        print("soldier_motions.py not found; skipping motions")
        return
    spec = importlib.util.spec_from_file_location("soldier_motions", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.make_all(rig)


DEFAULT_VARIANT = "gas"   # "gas"=ガスマスク / "ghost"=ゴーストマスク

if __name__ == "__main__":
    main()
