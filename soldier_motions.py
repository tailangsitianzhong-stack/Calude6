"""
soldier_175cm.py で作った兵士リグ（Soldier_Rig）に、手続き生成のモーションを焼き込むスクリプト。

作成されるアクション（すべてループ可能、ルートモーション付き）
  Walk / Walk_Rifle       歩行（素手：ライフルは背中 / 小銃：ローレディ）
  Run / Run_Rifle         走行
  Crouch / Crouch_Rifle   しゃがみ歩き（小銃あり：エイミングしながら前進）
  Prone / Prone_Rifle     匍匐前進（ロークロール）

使い方
  CLI : blender soldier_175cm.blend --background --python soldier_motions.py -- --save soldier_175cm.blend
  GUI : .blend を開いた状態で Scripting タブからこのファイルを実行
  切り替え : Dope Sheet > Action Editor でアクションを選ぶ（ライフルも同じアクションで動く）

仕組み
  - 足跡（フットプリント）ベースの歩容：接地中の足はワールドで静止（足滑りなし）、
    踵接地→足裏接地→踵離れ（母指球回転）→つま先離地 のロッカー動作を再現
  - 骨盤の上下動・左右動・回旋・傾き、体幹のカウンター回旋、腕振りを位相で同期
  - 脚・腕は解析的 2 ボーン IK、手首のねじれは前腕と手に分配
  - ライフル保持時は銃の座標系から右手（グリップ）・左手（ハンドガード）を逆算
  - 毎フレームの FK 回転として焼き込み、Cycles モディファイアでループ、
    オブジェクトの前進は線形外挿（ルートモーション）
"""

import math
import os
import sys

import bpy
from mathutils import Matrix, Vector


def V(*a):
    return Vector(a)


RIG_NAME = "Soldier_Rig"
FPS = 30
WEAPON_BONE_LEN = 0.2

RIFLE = {
    "butt": V(0.004, 0.0, -0.035),
    "grip": V(0.356, 0.0, -0.100),
    "grip_axis": V(-0.04, 0.0, -0.11).normalized(),
    "guard_min": 0.555, "guard_max": 0.78,
    "eye": V(0.235, 0.0, 0.088),
}

# ---------------------------------------------------------------------------
# 数学ユーティリティ
# ---------------------------------------------------------------------------


def clamp(x, a, b):
    return a if x < a else b if x > b else x


def lerp(a, b, t):
    return a + (b - a) * t


def smooth(t):
    t = clamp(t, 0.0, 1.0)
    return t * t * (3 - 2 * t)


def smoother(t):
    t = clamp(t, 0.0, 1.0)
    return t * t * t * (t * (t * 6 - 15) + 10)


def Rx(a):
    return Matrix.Rotation(a, 3, "X")


def Ry(a):
    return Matrix.Rotation(a, 3, "Y")


def Rz(a):
    return Matrix.Rotation(a, 3, "Z")


def rad(d):
    return math.radians(d)


def frame(x, y):
    """y を主軸、x を副軸にした正規直交基底（列ベクトル x, y, z）"""
    y = y.normalized()
    x = (x - y * x.dot(y))
    if x.length < 1e-8:
        x = y.orthogonal()
    x.normalize()
    z = x.cross(y)
    return Matrix((x, y, z)).transposed()


def ortho(v, axis):
    v = v - axis * v.dot(axis)
    return v.normalized() if v.length > 1e-8 else axis.orthogonal().normalized()


def slerp_m(a, b, t):
    qa, qb = a.to_quaternion(), b.to_quaternion()
    if qa.dot(qb) < 0:
        qb.negate()
    return qa.slerp(qb, t).to_matrix()


def ik2(root, target, l1, l2, pole):
    d = target - root
    dist = clamp(d.length, abs(l1 - l2) + 1e-4, (l1 + l2) * 0.9995)
    dn = d.normalized()
    c = clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1.0, 1.0)
    perp = ortho(pole, dn)
    mid = root + dn * (l1 * c) + perp * (l1 * math.sqrt(1 - c * c))
    return mid, root + dn * dist


def mat4(R, o):
    M = R.to_4x4()
    M.translation = o
    return M


# ---------------------------------------------------------------------------
# リグのレスト情報
# ---------------------------------------------------------------------------

class Rest:
    def __init__(self, arm):
        self.b = {}
        for bone in arm.data.bones:
            self.b[bone.name] = dict(
                head=bone.head_local.copy(), tail=bone.tail_local.copy(),
                R=bone.matrix_local.copy(), R3=bone.matrix_local.to_3x3(),
                parent=bone.parent.name if bone.parent else None, length=bone.length)
        self.order = []
        seen = set()

        def visit(n):
            if n in seen:
                return
            p = self.b[n]["parent"]
            if p:
                visit(p)
            seen.add(n)
            self.order.append(n)
        for n in self.b:
            visit(n)
        self.side = {}
        for sfx, s in ((".L", 1), (".R", -1)):
            g = lambda n: self.b[n + sfx]  # noqa: E731
            hip, knee, ankle = g("thigh")["head"], g("shin")["head"], g("foot")["head"]
            ball, toe = g("toe")["head"], g("toe")["tail"]
            S, E, W = g("upper_arm")["head"], g("forearm")["head"], g("hand")["head"]
            hand_dir = (g("hand")["tail"] - W).normalized()
            palm = ortho(V(-1.0 * s, 0.3, 0.0), hand_dir)
            arm_bend = ortho(E - S, (W - S).normalized())
            heel = V(ankle.x, ankle.y + 0.05, 0.0)
            self.side[s] = dict(
                sfx=sfx, hip=hip, knee=knee, ankle=ankle, ball=ball, toe=toe, heel=heel,
                l_thigh=g("thigh")["length"], l_shin=g("shin")["length"],
                S=S, E=E, W=W, l_up=g("upper_arm")["length"], l_fo=g("forearm")["length"],
                hand_dir=hand_dir, palm=palm, arm_bend=arm_bend,
                foot_dir=(ball - ankle).normalized(), toe_dir=(toe - ball).normalized())

    def rot(self, name):
        return self.b[name]["R3"]


# ---------------------------------------------------------------------------
# ポーズ（ワールド＝アーマチュア空間の回転と位置）→ ボーン行列
# ---------------------------------------------------------------------------

class Pose:
    def __init__(self, rest):
        self.rest = rest
        self.Q = {n: Matrix.Identity(3) for n in rest.b}
        self.hips_pos = rest.b["hips"]["head"].copy()
        self.weapon = None   # ライフルのワールド行列（4x4）

    def matrices(self, only=None):
        rb = self.rest.b
        M = {}
        for n in self.rest.order:
            r = rb[n]
            if n == "weapon":
                M[n] = r["R"].copy() if self.weapon is None else \
                    self.weapon @ Matrix.Translation((0, -WEAPON_BONE_LEN, 0))
                continue
            if r["parent"] is None:
                head = self.hips_pos
            else:
                p = r["parent"]
                head = (M[p] @ rb[p]["R"].inverted() @ r["head"].to_4d()).to_3d()
            M[n] = mat4(self.Q[n] @ r["R3"], head)
            if only and n in only and all(o in M for o in only):
                break
        return M


def basis_of(rest, n, M):
    r = rest.b[n]
    if r["parent"] is None:
        return r["R"].inverted() @ M[n]
    p = r["parent"]
    return (rest.b[p]["R"].inverted() @ r["R"]).inverted() @ M[p].inverted() @ M[n]


def bone_point(rest, M, name, rest_point):
    r = rest.b[name]
    return (M[name] @ r["R"].inverted() @ rest_point.to_4d()).to_3d()


# --- 四肢の回転を位置から求める ---------------------------------------------

def leg_rotations(pose, s, hip, knee, ankle, bend, foot_dir, foot_lat, toe_dir):
    rs = pose.rest.side[s]
    sfx = rs["sfx"]
    rb = rs
    # 大腿・下腿：ボーン軸 + 膝の曲がり方向で基底を作る
    y_r = (rb["knee"] - rb["hip"]).normalized()
    pole_r = V(0, -1, 0)
    F_r = frame(y_r.cross(pole_r), y_r)
    y_n = (knee - hip).normalized()
    F_n = frame(y_n.cross(bend), y_n)
    pose.Q["thigh" + sfx] = F_n @ F_r.transposed()
    y_r = (rb["ankle"] - rb["knee"]).normalized()
    F_r = frame(y_r.cross(pole_r), y_r)
    y_n = (ankle - knee).normalized()
    F_n = frame(y_n.cross(bend), y_n)
    pose.Q["shin" + sfx] = F_n @ F_r.transposed()
    pose.Q["foot" + sfx] = frame(foot_lat, foot_dir) @ frame(V(1, 0, 0), rb["foot_dir"]).transposed()
    pose.Q["toe" + sfx] = frame(foot_lat, toe_dir) @ frame(V(1, 0, 0), rb["toe_dir"]).transposed()


def arm_rotations(pose, s, S, E, W, hand_dir, palm):
    rs = pose.rest.side[s]
    sfx = rs["sfx"]
    bend_n = ortho(E - S, (W - S).normalized())
    y_r = (rs["E"] - rs["S"]).normalized()
    y_n = (E - S).normalized()
    pose.Q["upper_arm" + sfx] = frame(y_n.cross(bend_n), y_n) @ frame(y_r.cross(rs["arm_bend"]), y_r).transposed()
    y_r2 = (rs["W"] - rs["E"]).normalized()
    y_n2 = (W - E).normalized()
    Qf = frame(y_n2.cross(bend_n), y_n2) @ frame(y_r2.cross(rs["arm_bend"]), y_r2).transposed()
    Qh = frame(palm, hand_dir) @ frame(rs["palm"], rs["hand_dir"]).transposed()
    # 手のねじれの半分を前腕に分配（前腕回内・回外）
    xr = y_r2.cross(rs["arm_bend"]).normalized()
    a = ortho(Qf @ xr, y_n2)
    b = ortho(Qh @ xr, y_n2)
    ang = math.atan2(a.cross(b).dot(y_n2), clamp(a.dot(b), -1, 1))
    pose.Q["forearm" + sfx] = Matrix.Rotation(ang * 0.5, 3, y_n2) @ Qf
    pose.Q["hand" + sfx] = Qh


# ---------------------------------------------------------------------------
# 足の運び（足跡ベース）
# ---------------------------------------------------------------------------

def foot_state(rest, s, phi, P):
    """位相 phi における足首目標・足の向き。アーマチュア空間（体はその場、地面が +Y へ流れる）"""
    rs = rest.side[s]
    D, S = P["duty"], P["stride"]
    strike = P["strike_off"]
    yaw = rad(P.get("toe_out", 5.0)) * s
    Rzy = Rz(yaw)
    x = P["foot_x"] * s
    a_rest, heel_rest, ball_rest = rs["ankle"], rs["heel"], rs["ball"]

    fy = P.get("foot_y", {}).get(s, 0.0)

    def place(flat_y, pitch, pivot):
        A0 = V(x, flat_y + fy, a_rest.z)
        Rf = Rzy @ Rx(-pitch)
        if pivot == "heel":
            P0 = A0 + Rzy @ (heel_rest - a_rest)
            return P0 + Rf @ (a_rest - heel_rest)
        if pivot == "ball":
            P0 = A0 + Rzy @ (ball_rest - a_rest)
            return P0 + Rf @ (a_rest - ball_rest)
        return A0

    p_strike, p_off = rad(P["pitch_strike"]), rad(P["pitch_off"])
    if phi < D:
        flat_y = -strike + S * phi
        hs, ho = P["heel_rock"] * D, P["heel_off"] * D
        if phi < hs:
            pitch = p_strike * (1 - smooth(phi / hs))
            A = place(flat_y, pitch, "heel")
        elif phi > ho:
            t = (phi - ho) / (D - ho)
            pitch = -p_off * (t ** 1.6)
            A = place(flat_y, pitch, "ball")
        else:
            pitch = 0.0
            A = place(flat_y, 0.0, None)
        toe_pitch = max(pitch, 0.0)
        lift = 0.0
        if P.get("foot_pitch") is not None:             # ジャンプ：踵上げ／空中でつま先を伸ばす
            pitch = rad(P["foot_pitch"])
            lift = P.get("foot_lift", 0.0)
            A = place(flat_y, pitch, "ball" if (pitch < 0 and lift < 1e-3) else None)
            A.z += lift
            toe_pitch = 0.0 if lift < 1e-3 else pitch * 0.6
    else:
        sw = (phi - D) / (1 - D)
        old = -strike + S * phi
        new = -strike + S * (phi - 1)
        e = P.get("swing_ease", smoother)(sw)
        flat_y = lerp(old, new, e)
        pitch = lerp(-p_off, p_strike, smooth((sw - 0.1) / 0.85)) + rad(P.get("swing_dorsi", 8)) * math.sin(math.pi * sw)
        Ab = place(flat_y, pitch, "ball")
        Ah = place(flat_y, pitch, "heel")
        w = smooth(sw)
        A = Ab.lerp(Ah, w)
        lift = P["lift"] * P.get("lift_fn", lambda t: math.sin(math.pi * t) ** 1.3)(sw)
        A.z += lift
        toe_pitch = lerp(0.0, pitch, smooth(sw / 0.35))
    Rf = Rzy @ Rx(-pitch)
    return dict(ankle=A, foot_dir=Rf @ rs["foot_dir"], foot_lat=Rzy @ V(1, 0, 0),
                toe_dir=Rzy @ Rx(-toe_pitch) @ rs["toe_dir"], stance=phi < D)


# ---------------------------------------------------------------------------
# 上半身：ライフルの保持
# ---------------------------------------------------------------------------

R0 = Matrix(((0, 1, 0), (-1, 0, 0), (0, 0, 1)))   # 銃 X→キャラ前方(-Y), 銃 Y→左(+X), 銃 Z→上


EYE_R = V(-0.032, -0.10, 1.655)     # 右目（レスト）


def solve_cheek_weld(rest, pose, M, G):
    """首・頭の回転を探索し、右目を照準線（照門の後方）に合わせる"""
    target = G @ RIFLE["eye"]
    aim = G.to_3x3().col[0].normalized()
    Qc = pose.Q["chest"]
    rn, rh = rest.b["neck"], rest.b["head"]
    neck_head = bone_point(rest, M, "neck", rn["head"])

    def eye_of(x):
        a1, a2, r2, y2, r1, y1 = x
        Qn = Qc @ Rz(y1) @ Rx(a1) @ Ry(r1)
        Qh = Qn @ Rz(y2) @ Rx(a2) @ Ry(r2)
        head_head = neck_head + Qn @ (rn["tail"] - rn["head"])
        return head_head + Qh @ (EYE_R - rh["head"]), Qn, Qh

    def cost(x):
        e, _, Qh = eye_of(x)
        face = Qh @ V(0, -1, 0)
        d = e - target
        along = d.dot(aim)                       # 照門からの前後距離（-0.06〜+0.04 を許容）
        perp = d - aim * along
        out = max(0.0, -0.06 - along) + max(0.0, along - 0.04)
        return perp.length_squared + out * out + 0.0006 * (1 - face.dot(aim)) + 1e-5 * sum(v * v for v in x)
    x = [0.2, 0.0, -0.15, 0.0, -0.1, 0.0]
    lo = [-0.3, -0.8, -0.6, -0.5, -0.45, -0.5]
    hi = [0.9, 0.8, 0.3, 0.5, 0.3, 0.5]
    step = 0.2
    c = cost(x)
    while step > 0.002:
        improved = False
        for i in range(6):
            for d in (step, -step):
                y = list(x)
                y[i] = clamp(y[i] + d, lo[i], hi[i])
                cy = cost(y)
                if cy < c:
                    x, c, improved = y, cy, True
        if not improved:
            step *= 0.5
    _, Qn, Qh = eye_of(x)
    pose.Q["neck"], pose.Q["head"] = Qn, Qh


def fit_rifle_to_support(G, S_left, reach_left):
    """左手が届かない場合は銃全体を左肩側へ寄せる（床尾が肩から少し浮く）"""
    for _ in range(3):
        _, left = rifle_hands(G, S_left, reach_left)
        d = left["wrist"] - S_left
        lim = reach_left * 0.985
        if d.length <= lim:
            break
        G = Matrix.Translation(S_left + d.normalized() * lim - left["wrist"]) @ G
    return G


def rifle_hands(G, S_left, reach_left):
    R = G.to_3x3()
    o = G.translation
    Xr, Yr, Zr = R.col[0].copy(), R.col[1].copy(), R.col[2].copy()
    # 右手：ピストルグリップ（手のひらは銃の左側＝グリップ側、指はグリップ前面に回る）
    C = o + R @ RIFLE["grip"]
    d_r = (Xr * 0.94 - Zr * 0.342).normalized()
    p_r = Yr
    center = C - p_r * 0.027 - d_r * 0.012
    right = dict(wrist=center - d_r * 0.05, dir=d_r, palm=p_r)
    # 左手：ハンドガードを下から（届く範囲で前寄りを握る）
    p_l = (Zr * 0.85 - Yr * 0.5).normalized()
    d_l = ortho((Xr * 0.55 - Yr * 0.85), p_l)
    left = None
    xs = [RIFLE["guard_max"] - k * 0.01 for k in range(int((RIFLE["guard_max"] - RIFLE["guard_min"]) / 0.01) + 1)]
    for xh in xs:
        H = o + Xr * xh
        c = H - p_l * 0.046 + Yr * 0.006
        w = c - d_l * 0.05
        left = dict(wrist=w, dir=d_l, palm=p_l)
        if (w - S_left).length <= reach_left * 0.985:
            break
    return right, left


# ---------------------------------------------------------------------------
# 歩容系モーション（歩く・走る・しゃがみ歩き）
# ---------------------------------------------------------------------------

GAITS = {
    "Walk": dict(T=32, stride=1.30, duty=0.61, strike_off=0.33, foot_x=0.095, drop=0.03, bob=0.018,
                 sway=0.022, yaw=5.0, roll=3.0, lean=3.0, chest_yaw=5.0, lift=0.045,
                 pitch_strike=18, pitch_off=38, heel_rock=0.16, heel_off=0.55, head_pitch=3.0,
                 arm_swing=17, arm_fwd=2, elbow=14, elbow_amp=8, abd=12),
    "Run": dict(T=20, stride=2.40, duty=0.35, strike_off=0.30, foot_x=0.06, drop=0.075, bob=0.032,
                sway=0.012, yaw=8.0, roll=4.0, lean=9.0, chest_yaw=11.0, lift=0.26,
                pitch_strike=8, pitch_off=48, heel_rock=0.15, heel_off=0.35, head_pitch=4.0,
                arm_swing=34, arm_fwd=12, elbow=82, elbow_amp=12, abd=9, run=True,
                lift_fn=lambda t: math.sin(math.pi * clamp(t, 0, 1) ** 0.62) ** 1.1,
                swing_dorsi=14),
    # その場で構えて立つ（呼吸による微小な上下動のみ）
    "Stand": dict(T=60, stride=0.0, duty=1.0, strike_off=0.0, foot_x=0.13, drop=0.035, bob=0.004,
                  sway=0.004, yaw=0.8, roll=0.5, lean=5.0, chest_yaw=0.5, lift=0.0,
                  pitch_strike=0, pitch_off=0, heel_rock=0.1, heel_off=0.9, head_pitch=0.0,
                  arm_swing=0, arm_fwd=5, elbow=20, elbow_amp=0, abd=12, toe_out=18,
                  foot_y={1: -0.16, -1: 0.12}),
    # ジャンプの基準姿勢（両足を肩幅に揃えて立つ）
    "JumpBase": dict(T=40, stride=0.0, duty=1.0, strike_off=0.0, foot_x=0.11, drop=0.035, bob=0.0,
                     sway=0.0, yaw=0.0, roll=0.0, lean=5.0, chest_yaw=0.0, lift=0.0,
                     pitch_strike=0, pitch_off=0, heel_rock=0.1, heel_off=0.9, head_pitch=0.0,
                     arm_swing=0, arm_fwd=2, elbow=18, elbow_amp=0, abd=12, toe_out=8),
    "Crouch": dict(T=36, stride=0.95, duty=0.64, strike_off=0.25, foot_x=0.13, drop=0.25, bob=0.012,
                   sway=0.03, yaw=4.0, roll=3.0, lean=24.0, chest_yaw=4.0, lift=0.05,
                   pitch_strike=12, pitch_off=28, heel_rock=0.16, heel_off=0.55, head_pitch=-12.0,
                   arm_swing=8, arm_fwd=22, elbow=45, elbow_amp=5, abd=16, toe_out=10),
}

RIFLE_STYLE = {
    # 低い構え（ローレディ）：床尾を肩に付け、銃口を下げる
    "Walk": dict(style="ready", pocket=V(-0.11, -0.165, 1.37), pitch=42, yaw=26, cant=6, blade=-26,
                 head_pitch=6.0, stride_scale=0.9, drop_add=0.03, lean_add=3.0),
    "Run": dict(style="ready", pocket=V(-0.10, -0.18, 1.33), pitch=46, yaw=32, cant=16, blade=-20,
                head_pitch=4.0, stride_scale=1.0, drop_add=0.0, lean_add=2.0),
    # 構えながら前進：照準線に目を合わせ、銃は水平に安定
    "Stand": dict(style="aim", pocket=V(-0.105, -0.155, 1.395), head_pitch=0.0, blade=-32,
                  stride_scale=1.0, drop_add=0.0, lean_add=0.0),
    "JumpBase": dict(style="ready", pocket=V(-0.11, -0.165, 1.37), pitch=40, yaw=26, cant=6, blade=-20,
                     head_pitch=0.0, stride_scale=1.0, drop_add=0.0, lean_add=0.0),
    "Crouch": dict(style="aim", pocket=V(-0.105, -0.155, 1.395), head_pitch=0.0, blade=-30,
                   stride_scale=0.85, drop_add=0.0, lean_add=-6.0),
}


def gait_pose(rest, name, phi, rifle, over=None):
    P = dict(GAITS[name])
    if over:
        P.update(over)
    RS = dict(RIFLE_STYLE[name]) if rifle else None
    if RS:
        P["stride"] *= RS["stride_scale"]
        P["drop"] += RS["drop_add"]
        P["lean"] += RS["lean_add"]
        P["strike_off"] *= RS["stride_scale"]
    pose = Pose(rest)
    tw = 2 * math.pi * phi
    D = P["duty"]
    # --- 骨盤
    if P.get("run"):
        bob = -P["bob"] * math.cos(4 * math.pi * (phi - D / 2))
    else:
        bob = -P["bob"] * math.cos(4 * math.pi * phi)
    sway = P["sway"] * math.sin(tw)
    yaw = -rad(P["yaw"]) * math.cos(tw)
    roll = -rad(P["roll"]) * math.sin(tw)
    lean = rad(P["lean"])
    pose.hips_pos = rest.b["hips"]["head"] + V(sway, 0.0, -P["drop"] + bob)
    hip_lean = lean * (0.75 if name == "Crouch" else 0.5)
    pose.Q["hips"] = Rz(yaw) @ Rx(hip_lean) @ Ry(roll)
    cyaw = rad(P["chest_yaw"]) * math.cos(tw)
    if RS and RS["style"] == "aim":
        cyaw *= 0.25
    blade = rad(RS["blade"]) if RS else 0.0          # 構え時は左肩を前に（ブレーディング）
    pose.Q["spine"] = Rz(yaw * 0.3 + cyaw * 0.3 + blade * 0.4) @ Rx(lean * 0.85) @ Ry(roll * 0.3)
    pose.Q["chest"] = Rz(cyaw + blade) @ Rx(lean) @ Ry(-roll * 0.2)
    hp = rad(P["head_pitch"] + (RS["head_pitch"] if RS else 0.0))
    head_roll = rad(RS.get("head_roll", 0.0)) if RS else 0.0
    head_yaw = rad(RS.get("head_yaw", 0.0)) if RS else 0.0
    pose.Q["head"] = Rz(-yaw * 0.15 + head_yaw) @ Rx(hp) @ Ry(head_roll)
    pose.Q["neck"] = slerp_m(pose.Q["chest"], pose.Q["head"], 0.55)
    raise_ = rad(10.0 if (RS and RS["style"] == "aim") else 0.0)
    for s in (1, -1):
        prot = rad((28 if s == 1 else 4) if RS else 0)        # 構え時は左肩甲骨を前に出す
        pose.Q["shoulder" + rest.side[s]["sfx"]] = pose.Q["chest"] @ Rz(-s * prot) @ Ry(-s * raise_)

    # --- 脚
    M = pose.matrices()
    for s, off in ((1, 0.0), (-1, 0.5)):
        rs = rest.side[s]
        fs = foot_state(rest, s, (phi + off) % 1.0, P)
        hip = bone_point(rest, M, "thigh" + rs["sfx"], rs["hip"])
        pole = Rz(yaw * 0.6) @ V(s * 0.12, -1.0, 0.0)
        knee, ankle = ik2(hip, fs["ankle"], rs["l_thigh"], rs["l_shin"], pole)
        bend = ortho(knee - hip, (ankle - hip).normalized())
        leg_rotations(pose, s, hip, knee, ankle, bend, fs["foot_dir"], fs["foot_lat"], fs["toe_dir"])

    # --- 腕
    M = pose.matrices()
    Qc = pose.Q["chest"]
    if not rifle:
        for s, off in ((1, 0.5), (-1, 0.0)):
            rs = rest.side[s]
            S = (M["shoulder" + rs["sfx"]] @ V(0, rest.b["shoulder" + rs["sfx"]]["length"], 0, 1)).to_3d()
            ph = 2 * math.pi * ((phi + off) % 1.0)
            flex = rad(P["arm_fwd"] + P["arm_swing"] * math.cos(ph))
            elbow = rad(P["elbow"] + P["elbow_amp"] * (0.5 + 0.5 * math.cos(ph)))
            abd = rad(P["abd"])
            u = Rx(-flex) @ V(s * math.sin(abd), 0.02, -math.cos(abd))
            inward = 0.28 if P.get("run") else 0.08
            f = Rx(-(flex + elbow)) @ V(s * math.sin(abd) * 0.4 - s * inward * math.sin(elbow), 0.0, -1.0).normalized()
            E = S + (Qc @ u) * rs["l_up"]
            W = E + (Qc @ f).normalized() * rs["l_fo"]
            hand_dir = Qc @ (Rx(-rad(8)) @ f).normalized()
            palm = Qc @ V(-s, 0.35 if not P.get("run") else -0.1, 0.0)
            arm_rotations(pose, s, S, E, W, hand_dir, ortho(palm, hand_dir.normalized()))
        pose.weapon = M["chest"] @ rest.b["chest"]["R"].inverted() @ sling_rest(rest)
        return pose

    # --- ライフル保持
    Rch = M["chest"] @ rest.b["chest"]["R"].inverted()
    if RS["style"] == "ready":
        Rr = Rz(rad(RS["yaw"])) @ Rx(rad(RS["pitch"])) @ R0 @ Rx(rad(RS["cant"]))
        o = RS["pocket"] - Rr @ RIFLE["butt"]
        G = Rch @ mat4(Rr, o)
    else:
        # 照準：銃は水平で前方へ安定、床尾は肩のポケット、頭を照準線に寄せる（頬付け）
        Rr = Rz(rad(-3.0)) @ R0
        pocket = (Rch @ RS["pocket"].to_4d()).to_3d()
        G = mat4(Rr, pocket - Rr @ RIFLE["butt"])
        solve_cheek_weld(rest, pose, M, G)
        M = pose.matrices()
        pose.eye_err = (bone_point(rest, M, "head", EYE_R) - G @ RIFLE["eye"])
    pose.weapon = G
    SL = (M["shoulder.L"] @ V(0, rest.b["shoulder.L"]["length"], 0, 1)).to_3d()
    SR = (M["shoulder.R"] @ V(0, rest.b["shoulder.R"]["length"], 0, 1)).to_3d()
    rsL = rest.side[1]
    G = fit_rifle_to_support(G, SL, rsL["l_up"] + rsL["l_fo"])
    pose.weapon = G
    right, left = rifle_hands(G, SL, rsL["l_up"] + rsL["l_fo"])
    for s, Sx, h, pole in ((-1, SR, right, Qc @ V(-0.75, 0.35, -0.6)), (1, SL, left, Qc @ V(0.45, 0.0, -0.9))):
        rs = rest.side[s]
        E, W = ik2(Sx, h["wrist"], rs["l_up"], rs["l_fo"], pole)
        arm_rotations(pose, s, Sx, E, W, h["dir"], h["palm"])
    return pose


def sling_rest(rest):
    w = rest.b["weapon"]
    return w["R"] @ Matrix.Translation((0, WEAPON_BONE_LEN, 0))


# ---------------------------------------------------------------------------
# 匍匐前進（ロークロール）
# ---------------------------------------------------------------------------

PRONE = dict(T=48, stride=0.55, hips_z=0.15)


def prone_pose(rest, phi, rifle):
    T, S = PRONE["T"], PRONE["stride"]
    pose = Pose(rest)
    surge = S * math.sin(4 * math.pi * phi) / (4 * math.pi)       # 2回の押し出しで体が前へ（等速からのずれ）
    side_w = math.sin(2 * math.pi * phi)                          # +: 左膝を引き寄せている側
    pose.hips_pos = V(0.02 * side_w, -surge, PRONE["hips_z"] + 0.006 * abs(side_w))
    roll = rad(7.0) * side_w
    yaw = rad(4.0) * side_w
    pose.Q["hips"] = Ry(-roll) @ Rz(yaw) @ Rx(rad(90))
    pose.Q["spine"] = Ry(-roll * 0.6) @ Rz(-yaw * 0.3) @ Rx(rad(78))
    pose.Q["chest"] = Ry(-roll * 0.3) @ Rz(-yaw * 0.8) @ Rx(rad(68))
    pose.Q["head"] = Rz(-yaw * 0.5) @ Rx(rad(36))
    pose.Q["neck"] = slerp_m(pose.Q["chest"], pose.Q["head"], 0.5)
    for s in (1, -1):
        pose.Q["shoulder" + rest.side[s]["sfx"]] = pose.Q["chest"] @ Rz(-s * rad(14)) @ Ry(-s * rad(12))
    M = pose.matrices()

    # --- 脚：引き寄せ（frog）と押し出し
    def leg_at(s, ph):
        """ph: 0→0.5 押し出し（接地して体が前進）、0.5→1 引き寄せ"""
        rs = rest.side[s]
        y_draw, y_ext, x_draw, x_ext = 0.40, 0.70, 0.30, 0.15
        if ph < 0.5:
            t = ph / 0.5
            y = y_draw + S * 0.5 * t + 0.05 * smooth(t)           # 地面に固定（＋わずかな滑り）
            x = lerp(x_draw, x_ext, smooth(t))
            lift = 0.0
            draw = 1 - smooth(t)
        else:
            t = (ph - 0.5) / 0.5
            y_end = y_draw + S * 0.5 + 0.05
            y = lerp(y_end, y_draw, smoother(t)) + 0.0
            x = lerp(x_ext, x_draw, smoother(t))
            lift = 0.035 * math.sin(math.pi * t)
            draw = smooth(t)
        return y, x, lift, draw

    for s, off in ((1, 0.5), (-1, 0.0)):
        rs = rest.side[s]
        ph = (phi + off) % 1.0
        y, x, lift, draw = leg_at(s, ph)
        # 地面上の点はアーマチュア空間で +Y へ流れる（体は等速＋surge）
        ankle_t = V(s * x, y - S * 0.0, 0.085 + lift)
        hip = bone_point(rest, M, "thigh" + rs["sfx"], rs["hip"])
        ankle_t.y += hip.y + surge          # 体の surge を除いた基準 → 接地中は地面に固定
        # 膝は地面にめり込まないよう横（外側）へ曲げる：引き寄せるほど外へ
        pole = V(s * 1.0, -0.15, -0.35 + 0.25 * draw)
        knee, ankle = ik2(hip, ankle_t, rs["l_thigh"], rs["l_shin"], pole)
        if knee.z < 0.07:                      # 念のため：膝を股関節-足首軸まわりに持ち上げる
            axis = (ankle - hip).normalized()
            for _ in range(24):
                if knee.z >= 0.07:
                    break
                knee = hip + Matrix.Rotation(-s * rad(5), 3, axis) @ (knee - hip)
        bend = ortho(knee - hip, (ankle - hip).normalized())
        shin_axis = (ankle - knee).normalized()
        Rout = Matrix.Rotation(-s * rad(55) * draw, 3, shin_axis)
        fdir = Rout @ V(0, 0.35, -0.94).normalized()
        flat = Rout @ V(1, 0, 0)
        tdir = Rout @ V(0, 0.85, -0.5).normalized()
        leg_rotations(pose, s, hip, knee, ankle, bend, fdir, flat, tdir)

    M = pose.matrices()
    Qc = pose.Q["chest"]
    SL = (M["shoulder.L"] @ V(0, rest.b["shoulder.L"]["length"], 0, 1)).to_3d()
    SR = (M["shoulder.R"] @ V(0, rest.b["shoulder.R"]["length"], 0, 1)).to_3d()
    sh_y0 = (SL.y + SR.y) / 2 + surge   # 等速基準の肩位置

    def elbow_target(s, ph):
        """ph: 0→0.5 肘を接地して引く、0.5→1 肘を前へ伸ばす"""
        reach = -0.24
        if ph < 0.5:
            y = sh_y0 + reach + S * ph
            z = 0.045
        else:
            t = (ph - 0.5) / 0.5
            y = lerp(sh_y0 + reach + S * 0.5, sh_y0 + reach, smoother(t))
            z = 0.045 + 0.06 * math.sin(math.pi * t)
        return y - 0.0, z

    if not rifle:
        for s, Sx, off in ((1, SL, 0.0), (-1, SR, 0.5)):
            rs = rest.side[s]
            ph = (phi + off) % 1.0
            ey, ez = elbow_target(s, ph)
            ey -= surge * 0.0
            h = Sx.z - ez
            dy = ey - Sx.y
            rem = rs["l_up"] ** 2 - h * h - dy * dy
            if rem > 0.0064:
                E = V(Sx.x + s * math.sqrt(rem), ey, ez)
            else:
                tgt = V(Sx.x + s * 0.08, ey, ez)
                E = Sx + (tgt - Sx).normalized() * rs["l_up"]
            fdir = V(-s * 0.42, -0.9, -0.05).normalized()
            W = E + fdir * rs["l_fo"]
            W.z = max(W.z, 0.03)
            W = E + (W - E).normalized() * rs["l_fo"]
            hand_dir = (fdir + V(0, 0, -0.15)).normalized()
            arm_rotations(pose, s, Sx, E, W, hand_dir, ortho(V(0, 0, -1), hand_dir))
        pose.weapon = M["chest"] @ rest.b["chest"]["R"].inverted() @ sling_rest(rest)
        return pose

    # ライフル：左側面を下にして前腕の上に寝かせ、銃口はやや左前方・地面から浮かせる
    Xr = V(0.18, -1.0, 0.06).normalized()
    Zr = ortho(V(1, 0, 0), Xr)
    Yr = Zr.cross(Xr)
    Rr = Matrix((Xr, Yr, Zr)).transposed()
    grip_w = V(-0.02 + 0.03 * side_w, sh_y0 - 0.33 - surge * 0.0, 0.075)
    o = grip_w - Rr @ RIFLE["grip"]
    G = mat4(Rr, o)
    G = fit_rifle_to_support(G, SL, rest.side[1]["l_up"] + rest.side[1]["l_fo"])
    pose.weapon = G
    right, left = rifle_hands(G, SL, rest.side[1]["l_up"] + rest.side[1]["l_fo"])
    for s, Sx, h, pole in ((-1, SR, right, V(-0.6, 0.1, -1.0)), (1, SL, left, V(0.6, 0.1, -1.0))):
        rs = rest.side[s]
        E, W = ik2(Sx, h["wrist"], rs["l_up"], rs["l_fo"], pole)
        arm_rotations(pose, s, Sx, E, W, h["dir"], h["palm"])
    return pose


# ---------------------------------------------------------------------------
# ジャンプ：踏み込み → 踏み切り → 空中（膝の引き付け） → 着地（衝撃吸収） → 立ち直り
# 体の上昇はアーマチュアオブジェクトの Z（ルートモーション）に入れる
# ---------------------------------------------------------------------------

JUMP_T = 40
JUMP_H = 0.42
J_A, J_T, J_L, J_R = 0.22, 0.32, 0.72, 0.86      # 踏み込み終了・離地・着地・吸収終了


def _seg(t, a, b):
    return smooth((t - a) / (b - a))


def jump_params(t):
    """位相 t に対する骨盤の沈み・前傾・足の角度・足の持ち上げ・腕振り"""
    if t < J_A:
        d = _seg(t, 0, J_A)
        return dict(drop=0.035 + 0.20 * d, lean=5 + 12 * d, foot_pitch=0.0, foot_lift=0.0, arm_fwd=2 - 32 * d, elbow=18 + 10 * d)
    if t < J_T:
        e = _seg(t, J_A, J_T)
        return dict(drop=0.235 - 0.255 * e, lean=17 - 11 * e, foot_pitch=-38 * e, foot_lift=0.0, arm_fwd=-30 + 95 * e, elbow=28 - 8 * e)
    if t < J_L:
        a = (t - J_T) / (J_L - J_T)
        tuck = math.sin(math.pi * a)
        return dict(drop=-0.02 + 0.03 * tuck, lean=6 + 4 * tuck, foot_pitch=-38 + 26 * smooth(a), foot_lift=0.24 * tuck,
                    arm_fwd=65 - 35 * smooth(a), elbow=20 + 15 * tuck)
    if t < J_R:
        l = _seg(t, J_L, J_R)
        return dict(drop=-0.02 + 0.27 * l, lean=6 + 10 * l, foot_pitch=-12 * (1 - l), foot_lift=0.0, arm_fwd=30 - 8 * l, elbow=35 - 5 * l)
    r = _seg(t, J_R, 1.0)
    return dict(drop=0.25 - 0.215 * r, lean=16 - 11 * r, foot_pitch=0.0, foot_lift=0.0, arm_fwd=22 - 20 * r, elbow=30 - 12 * r)


def jump_root_z(t):
    if J_T <= t <= J_L:
        a = (t - J_T) / (J_L - J_T)
        return 4 * JUMP_H * a * (1 - a)
    return 0.0


def jump_pose(rest, t, rifle):
    jp = jump_params(t)
    over = dict(jp, bob=0.0, sway=0.0, yaw=0.0, roll=0.0, chest_yaw=0.0, head_pitch=-jp["lean"] * 0.6)
    return gait_pose(rest, "JumpBase", 0.0, rifle, over)


# ---------------------------------------------------------------------------
# 被弾して倒れる（膝が崩れ → 前のめりに倒れる。銃は手から離れて地面へ）
# ---------------------------------------------------------------------------

def blend_pose(rest, a, b, t):
    p = Pose(rest)
    for n in rest.b:
        p.Q[n] = slerp_m(a.Q[n], b.Q[n], t)
    p.hips_pos = a.hips_pos.lerp(b.hips_pos, t)
    if a.weapon is not None and b.weapon is not None:
        R = slerp_m(a.weapon.to_3x3(), b.weapon.to_3x3(), t)
        p.weapon = mat4(R, a.weapon.translation.lerp(b.weapon.translation, t))
    return p


DEATH_T = 40


def death_pose(rest, phi):
    A = gait_pose(rest, "Stand", 0.0, True)
    K = gait_pose(rest, "Crouch", 0.12, False)            # 膝が崩れた中間姿勢
    K.hips_pos = K.hips_pos + V(0, 0.05, -0.12)
    K.Q["chest"] = Rx(rad(35)) @ K.Q["chest"]
    K.Q["head"] = Rx(rad(25)) @ K.Q["head"]
    B = prone_pose(rest, 0.25, False)
    B.hips_pos = B.hips_pos + V(0, -0.62, -0.02)            # 足の位置から前へ倒れ込む
    B.Q["head"] = Rz(rad(70)) @ Rx(rad(80))                 # 顔を横に向けて地面へ
    B.Q["neck"] = slerp_m(B.Q["chest"], B.Q["head"], 0.5)
    ground = mat4(Rz(rad(25)) @ Matrix(((0, 0, 1), (-1, 0, 0), (0, -1, 0))), V(0.45, -0.75, 0.035))
    K.weapon = A.weapon
    B.weapon = ground
    if phi < 0.35:
        t = smooth(phi / 0.35)
        P = blend_pose(rest, A, K, t)
    else:
        t = ((phi - 0.35) / 0.65) ** 1.7                     # 重力で加速しながら倒れる
        P = blend_pose(rest, K, B, t)
        if t > 0.92:                                        # 着地の小さなバウンド
            P.hips_pos.z += 0.02 * math.sin(math.pi * (t - 0.92) / 0.08)
    # 銃はすぐに手を離れ、重力で落ちる
    tw = clamp((phi - 0.05) / 0.5, 0, 1) ** 2
    R = slerp_m(A.weapon.to_3x3(), ground.to_3x3(), tw)
    P.weapon = mat4(R, A.weapon.translation.lerp(ground.translation, tw))
    return P


# ---------------------------------------------------------------------------
# 焼き込み
# ---------------------------------------------------------------------------

def action_fcurves(act):
    try:
        return list(act.fcurves)
    except (AttributeError, TypeError):
        pass
    out = []
    for layer in act.layers:
        for strip in layer.strips:
            for cb in strip.channelbags:
                out.extend(cb.fcurves)
    return out


def bake(arm, rest, name, T, stride, fn, loop=True, root_z=None):
    act = bpy.data.actions.get(name)
    if act:
        bpy.data.actions.remove(act)
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data_create()
    arm.animation_data.action = act
    pbs = arm.pose.bones
    for pb in pbs:
        pb.rotation_mode = "QUATERNION"
        pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)
    prev = {}
    for f in range(T + 1):
        phi = (f % T) / T if loop else f / T
        pose = fn(phi)
        M = pose.matrices()
        for n in rest.order:
            B = basis_of(rest, n, M)
            loc, q, _ = B.decompose()
            if n in prev and prev[n].dot(q) < 0:
                q.negate()
            prev[n] = q
            pb = pbs[n]
            pb.rotation_quaternion = q
            pb.keyframe_insert("rotation_quaternion", frame=f, group=n)
            if n in ("hips", "weapon"):
                pb.location = loc
                pb.keyframe_insert("location", frame=f, group=n)
    # ルートモーション（オブジェクトを前進）
    arm.location = (0, 0, 0)
    arm.keyframe_insert("location", index=1, frame=0, group="Root Motion")
    arm.location = (0, -stride, 0)
    arm.keyframe_insert("location", index=1, frame=T, group="Root Motion")
    if root_z:
        for f in range(T + 1):
            arm.location = (0, 0, root_z(f / T))
            arm.keyframe_insert("location", index=2, frame=f, group="Root Motion")
    arm.location = (0, 0, 0)
    for fc in action_fcurves(act):
        if fc.data_path == "location":
            fc.extrapolation = "LINEAR"
            for k in fc.keyframe_points:
                k.interpolation = "LINEAR"
        elif loop:
            fc.modifiers.new("CYCLES")
    act.use_frame_range = True
    act.frame_start, act.frame_end = 0, T
    try:
        act.use_cyclic = True
    except AttributeError:
        pass
    print("baked %-13s %3d frames  %.2f m/cycle  (%.2f m/s)" % (name, T, stride, stride / T * FPS))
    return act


def make_all(arm=None, default="Walk_Rifle"):
    arm = arm or bpy.data.objects[RIG_NAME]
    rest = Rest(arm)
    scene = bpy.context.scene
    scene.render.fps = FPS
    made = {}
    for name in ("Walk", "Run", "Crouch"):
        for rifle in (False, True):
            P = GAITS[name]
            stride = P["stride"] * (RIFLE_STYLE[name]["stride_scale"] if rifle else 1.0)
            act_name = name + ("_Rifle" if rifle else "")
            made[act_name] = (bake(arm, rest, act_name, P["T"], stride,
                                   lambda phi, n=name, r=rifle: gait_pose(rest, n, phi, r)), P["T"])
    for rifle in (False, True):
        act_name = "Prone" + ("_Rifle" if rifle else "")
        made[act_name] = (bake(arm, rest, act_name, PRONE["T"], PRONE["stride"],
                               lambda phi, r=rifle: prone_pose(rest, phi, r)), PRONE["T"])
    made["Idle_Rifle"] = (bake(arm, rest, "Idle_Rifle", GAITS["Stand"]["T"], 0.0,
                               lambda phi: gait_pose(rest, "Stand", phi, True)), GAITS["Stand"]["T"])
    made["Death"] = (bake(arm, rest, "Death", DEATH_T, 0.0, lambda phi: death_pose(rest, phi), loop=False),
                     DEATH_T)
    for rifle in (False, True):
        act_name = "Jump" + ("_Rifle" if rifle else "")
        made[act_name] = (bake(arm, rest, act_name, JUMP_T, 0.0, lambda t, r=rifle: jump_pose(rest, t, r),
                               loop=False, root_z=jump_root_z), JUMP_T)
    act, T = made[default]
    arm.animation_data.action = act
    scene.frame_start, scene.frame_end = 0, T * 4 - 1
    scene.frame_set(0)
    return made


def main():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    make_all()
    if "--save" in argv:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(argv[argv.index("--save") + 1]))


if __name__ == "__main__":
    main()
