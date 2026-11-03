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
        e = P.get("swing_ease", swing_ease)(sw)
        flat_y = lerp(old, new, e)
        pitch = lerp(-p_off, p_strike, smooth((sw - 0.1) / 0.85)) + rad(P.get("swing_dorsi", 8)) * math.sin(math.pi * sw)
        Ab = place(flat_y, pitch, "ball")
        Ah = place(flat_y, pitch, "heel")
        w = smooth(sw)
        A = Ab.lerp(Ah, w)
        lift = P["lift"] * P.get("lift_fn", early_lift)(sw)
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

def swing_ease(t):
    """遊脚の前方移動：大腿の振り出しで前半に速く進み、踵接地前に減速する"""
    t = clamp(t, 0.0, 1.0)
    return 1.0 - (1.0 - t) ** 1.8 * (1.0 - 0.3 * t)


def early_lift(t):
    """遊脚期の足首の持ち上げ：振り出し初期（踵が尻側へ上がる）にピーク、踵接地前はほぼ 0"""
    t = clamp(t, 0.0, 1.0)
    if t < 0.3:
        return smooth(t / 0.3)
    return 1.0 - smooth((t - 0.3) / 0.5)


# 参考：通常歩行の膝屈曲（立脚 5〜20°、遊脚初期に約 60°）、走行（立脚 40°前後、遊脚 90〜110°）。
# 負荷携行時は体幹の前傾が 10°以上に増え、接地時の股関節・膝の屈曲が大きくなる。
GAITS = {
    "Walk": dict(T=32, stride=1.30, duty=0.61, strike_off=0.33, foot_x=0.095, drop=0.035, bob=0.02,
                 sway=0.024, yaw=7.0, roll=4.0, lean=6.0, chest_yaw=6.0, lift=0.10,
                 pitch_strike=17, pitch_off=34, heel_rock=0.17, heel_off=0.52, head_pitch=0.0,
                 arm_swing=19, arm_fwd=3, elbow=18, elbow_amp=12, abd=11, swing_dorsi=10),
    "Run": dict(T=20, stride=2.40, duty=0.33, strike_off=0.24, foot_x=0.065, drop=0.085, bob=0.035,
                sway=0.014, yaw=9.0, roll=5.0, lean=12.0, chest_yaw=12.0, lift=0.30,
                pitch_strike=6, pitch_off=58, heel_rock=0.12, heel_off=0.3, head_pitch=-4.0,
                arm_swing=36, arm_fwd=10, elbow=88, elbow_amp=14, abd=10, run=True,
                lift_fn=lambda t: smooth(t / 0.32) if t < 0.32 else 1.0 - smooth((t - 0.32) / 0.55),
                # 足はしばらく後ろに残り（踵が尻へ蹴り上がる）、後半で前へ振り出す
                swing_ease=lambda t: smoother(clamp(t * 1.08 - 0.04, 0, 1)),
                swing_dorsi=16),
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
    # --- Call of Duty 風（三人称）：腰だめ＝銃は胸の高さで前方へ、照準時のみ目線へ。上体は安定、脚はやわらかく
    "WalkReady": dict(T=32, stride=1.30, duty=0.60, strike_off=0.32, foot_x=0.11, drop=0.055, bob=0.012,
                      sway=0.022, yaw=6.0, roll=4.0, lean=7.0, chest_yaw=7.0, lift=0.10, lean_osc=1.5, side_flex=2.5,
                      pitch_strike=15, pitch_off=32, heel_rock=0.2, heel_off=0.52, head_pitch=-2.0,
                      arm_swing=0, arm_fwd=0, elbow=0, elbow_amp=0, abd=12, swing_dorsi=10, toe_out=9),
    "Jog": dict(T=18, stride=2.46, duty=0.32, strike_off=0.28, foot_x=0.08, drop=0.08, bob=0.03,
                sway=0.018, yaw=8.0, roll=5.0, lean=10.0, chest_yaw=10.0, lift=0.30, lean_osc=3.0, side_flex=3.5,
                pitch_strike=6, pitch_off=56, heel_rock=0.12, heel_off=0.3, head_pitch=-6.0,
                arm_swing=0, arm_fwd=0, elbow=0, elbow_amp=0, abd=10, run=True, swing_dorsi=16,
                lift_fn=lambda t: smooth(t / 0.32) if t < 0.32 else 1.0 - smooth((t - 0.32) / 0.55),
                swing_ease=lambda t: smooth(t) * 0.6 + swing_ease(t) * 0.4),
    "Sprint": dict(T=17, stride=3.12, duty=0.28, strike_off=0.30, foot_x=0.07, drop=0.09, bob=0.035,
                   sway=0.014, yaw=10.0, roll=5.0, lean=16.0, chest_yaw=14.0, lift=0.36, lean_osc=3.5, side_flex=4.0,
                   pitch_strike=4, pitch_off=62, heel_rock=0.1, heel_off=0.25, head_pitch=-10.0,
                   arm_swing=0, arm_fwd=0, elbow=0, elbow_amp=0, abd=10, run=True, swing_dorsi=18,
                   lift_fn=lambda t: smooth(t / 0.3) if t < 0.3 else 1.0 - smooth((t - 0.3) / 0.55),
                   swing_ease=lambda t: smooth(t) * 0.6 + swing_ease(t) * 0.4),
    "StandReady": dict(T=60, stride=0.0, duty=1.0, strike_off=0.0, foot_x=0.13, drop=0.045, bob=0.004,
                       sway=0.006, yaw=1.0, roll=0.8, lean=6.0, chest_yaw=1.5, lift=0.0, lean_osc=0.8, side_flex=0.8,
                       pitch_strike=0, pitch_off=0, heel_rock=0.1, heel_off=0.9, head_pitch=-2.0,
                       arm_swing=0, arm_fwd=5, elbow=20, elbow_amp=0, abd=12, toe_out=16,
                       foot_y={1: -0.12, -1: 0.10}),
    "WalkAim": dict(T=28, stride=1.50, duty=0.62, strike_off=0.30, foot_x=0.12, drop=0.07, bob=0.008,
                    sway=0.012, yaw=3.0, roll=2.0, lean=6.0, chest_yaw=0.6, lift=0.09,
                    pitch_strike=14, pitch_off=30, heel_rock=0.22, heel_off=0.55, head_pitch=0.0,
                    arm_swing=0, arm_fwd=0, elbow=0, elbow_amp=0, abd=12, swing_dorsi=8, toe_out=12),
    "Crouch": dict(T=32, stride=1.47, duty=0.64, strike_off=0.38, foot_x=0.13, drop=0.25, bob=0.012,
                   sway=0.03, yaw=5.0, roll=3.0, lean=24.0, chest_yaw=4.0, lift=0.11,
                   pitch_strike=12, pitch_off=28, heel_rock=0.16, heel_off=0.55, head_pitch=-12.0,
                   arm_swing=8, arm_fwd=22, elbow=45, elbow_amp=5, abd=16, toe_out=10),
}

RIFLE_STYLE = {
    # 低い構え（ローレディ）：床尾を肩に付け、銃口を下げる
    "Walk": dict(style="ready", pocket=V(-0.11, -0.165, 1.37), pitch=42, yaw=26, cant=6, blade=-26,
                 head_pitch=6.0, stride_scale=0.9, drop_add=0.045, lean_add=4.0,
                 # 戦術的な歩き方：膝を曲げたまま、上下動を抑え、骨盤の回旋も小さく（銃口を安定させる）
                 bob_scale=0.45, lift_scale=0.8, yaw_scale=0.6, heel_rock=0.22),
    "Run": dict(style="ready", pocket=V(-0.10, -0.18, 1.33), pitch=46, yaw=32, cant=16, blade=-20,
                head_pitch=4.0, stride_scale=1.0, drop_add=0.0, lean_add=2.0),
    # 構えながら前進：照準線に目を合わせ、銃は水平に安定
    "WalkReady": dict(style="hip", pocket=V(-0.13, -0.19, 1.33), pitch=2, yaw=0, cant=0, blade=-14,
                      head_pitch=0.0, stride_scale=1.0, drop_add=0.0, lean_add=0.0),
    "Jog": dict(style="hip", pocket=V(-0.13, -0.20, 1.32), pitch=3, yaw=0, cant=0, blade=-12,
                head_pitch=0.0, stride_scale=1.0, drop_add=0.0, lean_add=0.0),
    "Sprint": dict(style="ready", pocket=V(-0.10, -0.19, 1.33), pitch=46, yaw=34, cant=18, blade=-20,
                   head_pitch=0.0, stride_scale=1.0, drop_add=0.0, lean_add=0.0),
    "StandReady": dict(style="hip", pocket=V(-0.13, -0.19, 1.33), pitch=2, yaw=0, cant=0, blade=-20,
                       head_pitch=0.0, stride_scale=1.0, drop_add=0.0, lean_add=0.0),
    "WalkAim": dict(style="aim", pocket=V(-0.105, -0.17, 1.395), head_pitch=0.0, blade=-30,
                    stride_scale=1.0, drop_add=0.0, lean_add=0.0),
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
        P["bob"] *= RS.get("bob_scale", 1.0)
        P["lift"] *= RS.get("lift_scale", 1.0)
        P["yaw"] *= RS.get("yaw_scale", 1.0)
        if "heel_rock" in RS:
            P["heel_rock"] = RS["heel_rock"]
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
    lean_osc = rad(P.get("lean_osc", 0.0)) * math.cos(4 * math.pi * (phi - D / 2 if P.get("run") else phi))
    side = rad(P.get("side_flex", 0.0)) * math.sin(tw)
    pose.Q["chest"] = Rz(cyaw + blade) @ Rx(lean + lean_osc) @ Ry(-roll * 0.2 + side)
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

    hold_rifle(rest, pose, RS)
    return pose


def hold_rifle(rest, pose, RS):
    """胸の姿勢が決まった pose に、RS の構え方で銃を持たせる（腕は IK）"""
    M = pose.matrices()
    Qc = pose.Q["chest"]
    Rch = M["chest"] @ rest.b["chest"]["R"].inverted()
    if RS["style"] == "hip":
        # 腰だめ（Call of Duty 風）：銃口は常に照準方向（正面・水平）へ。床尾の位置だけ胸の肩口に追従し、
        # 腕は IK で銃に合わせる → 胸・肩が自然に揺れても銃口は前を向いたまま
        Rr = Rx(rad(RS["pitch"])) @ R0
        pocket = (Rch @ RS["pocket"].to_4d()).to_3d()
        G = mat4(Rr, pocket - Rr @ RIFLE["butt"])
    elif RS["style"] == "ready":
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


DEATH_T = 54        # 1.8 秒


def orient(up, face):
    """頭・胴の向き：上方向 up、正面 face（レストは上 +Z、正面 -Y）"""
    up = up.normalized()
    face = ortho(face, up)
    right = face.cross(up).normalized()
    M = Matrix((right, face, up)).transposed()
    R0m = Matrix(((-1, 0, 0), (0, -1, 0), (0, 0, 1))).transposed()
    return M @ R0m.transposed()


def _lerpv(a, b, t):
    return a.lerp(b, t)


def _key(hips, hipsQ, spineQ, chestQ, headQ, ankL, ankR, poleL, poleR, footL, footR, wriL, wriR, epL, epR, palmL, palmR):
    return dict(hips=hips, hipsQ=hipsQ, spineQ=spineQ, chestQ=chestQ, headQ=headQ, ankL=ankL, ankR=ankR,
                poleL=poleL, poleR=poleR, footL=footL, footR=footR, wriL=wriL, wriR=wriR, epL=epL, epR=epR,
                palmL=palmL, palmR=palmR)


def death_keys():
    """被弾→のけぞり→膝が崩れる→膝をつく→前のめりに倒れる→右側を下に横たわる"""
    up, fwd = V(0, 0, 1), V(0, -1, 0)
    prone = Rx(rad(90))
    roll = Ry(rad(-28))                                     # 右側（-X）を下に
    dn = V(0, 0, -1)
    keys = [
        # t, 姿勢
        (0.10, _key(V(0, 0.06, 0.90), Rx(rad(-7)), Rx(rad(-12)), Rz(rad(10)) @ Rx(rad(-18)), Rz(rad(14)) @ Rx(rad(-24)),
                    V(0.13, -0.15, 0.095), V(-0.13, 0.12, 0.095), V(0.1, -1, 0), V(-0.1, -1, 0), fwd, fwd,
                    V(0.30, -0.30, 1.15), V(-0.24, -0.22, 1.05), V(0.6, 0.2, -0.8), V(-0.6, 0.2, -0.8), V(0, 0, 1), V(0, 0, 1))),
        (0.30, _key(V(0.02, 0.07, 0.66), Rx(rad(18)), Rx(rad(26)), Rz(rad(6)) @ Rx(rad(34)), Rz(rad(10)) @ Rx(rad(55)),
                    V(0.13, -0.15, 0.095), V(-0.13, 0.12, 0.095), V(0.2, -1, 0), V(-0.15, -1, 0), fwd, fwd,
                    V(0.26, -0.18, 0.62), V(-0.24, -0.12, 0.58), V(0.5, 0.4, -0.7), V(-0.5, 0.4, -0.7), V(-1, 0, 0), V(1, 0, 0))),
        (0.48, _key(V(0.03, 0.02, 0.50), Rx(rad(40)), Rx(rad(52)), Rz(rad(-4)) @ Rx(rad(62)), Rz(rad(-8)) @ Rx(rad(82)),
                    V(0.16, 0.30, 0.11), V(-0.14, 0.34, 0.11), V(0.2, -1, -0.6), V(-0.2, -1, -0.6),
                    V(0, 1, -0.25), V(0, 1, -0.25),
                    V(0.24, -0.45, 0.28), V(-0.22, -0.42, 0.25), V(0.6, 0.3, -0.6), V(-0.6, 0.3, -0.6), V(0, 0, -1), V(0, 0, -1))),
        (0.74, _key(V(0.05, -0.32, 0.17), roll @ Rx(rad(86)), roll @ Rx(rad(84)), Ry(rad(-34)) @ Rx(rad(78)),
                    orient(V(0, -1, 0.25), V(0.85, -0.1, -0.5)),
                    V(0.22, 0.45, 0.10), V(-0.30, 0.34, 0.13), V(0.5, 0, -1), V(-0.8, 0, -0.6),
                    V(0, 0.55, -0.83), V(-0.3, 0.5, -0.8),
                    V(0.33, -0.22, 0.07), V(-0.36, -0.86, 0.06), V(0.3, 0.5, -0.8), V(-0.8, 0.0, -0.6), V(0, 0, 1), V(0, 0, -1))),
        (1.00, _key(V(0.05, -0.33, 0.155), roll @ Rx(rad(88)), roll @ Rx(rad(86)), Ry(rad(-36)) @ Rx(rad(82)),
                    orient(V(0, -1, 0.18), V(0.9, -0.05, -0.45)),
                    V(0.22, 0.47, 0.095), V(-0.32, 0.33, 0.12), V(0.5, 0, -1), V(-0.85, 0, -0.5),
                    V(0, 0.6, -0.8), V(-0.35, 0.5, -0.79),
                    V(0.34, -0.20, 0.06), V(-0.38, -0.88, 0.05), V(0.3, 0.5, -0.8), V(-0.8, 0.0, -0.6), V(0, 0, 1), V(0, 0, -1))),
    ]
    void_ = (up, fwd, prone, dn)
    return keys


def _interp_key(a, b, t):
    out = {}
    for k, va in a.items():
        vb = b[k]
        out[k] = slerp_m(va, vb, t) if isinstance(va, Matrix) else _lerpv(va, vb, t)
    return out


def death_pose(rest, phi):
    A = gait_pose(rest, "Stand", 0.0, True)        # 撃たれた瞬間：構えて立っている
    keys = death_keys()
    if phi <= keys[0][0]:
        # 立ち姿勢 → のけぞり（素早く）
        t0 = smooth(phi / keys[0][0])
        P = ragdoll_pose(rest, keys[0][1], A, t0)
    else:
        for (ta, ka), (tb, kb) in zip(keys, keys[1:]):
            if phi <= tb:
                t = (phi - ta) / (tb - ta)
                if ta >= 0.48 and tb <= 0.74:
                    t = t ** 1.8                           # 前に倒れる区間は重力で加速
                else:
                    t = smooth(t)
                P = ragdoll_pose(rest, _interp_key(ka, kb, t), None, 1.0)
                break
        # 地面に当たった直後の小さな跳ね返り
        if 0.74 < phi < 0.86:
            P.hips_pos.z += 0.035 * math.sin(math.pi * (phi - 0.74) / 0.12)
            P = ragdoll_pose(rest, _interp_key(keys[3][1], keys[4][1], smooth((phi - 0.74) / 0.26)), None, 1.0,
                             bounce=0.035 * math.sin(math.pi * (phi - 0.74) / 0.12))
    # 銃：撃たれた直後に手を離れ、回転しながら落ちて地面で止まる
    ground = mat4(Rz(rad(25)) @ Matrix(((0, 0, 1), (-1, 0, 0), (0, -1, 0))), V(0.55, -0.55, 0.035))
    tw = clamp((phi - 0.08) / 0.28, 0, 1)               # 約 0.5 秒で地面へ（自由落下）
    fall = tw * tw
    R = slerp_m(A.weapon.to_3x3(), ground.to_3x3(), smooth(tw))
    pos = A.weapon.translation.lerp(ground.translation, fall)
    pos.z += 0.12 * math.sin(math.pi * min(1.0, tw * 1.3)) * (1 - tw)
    if 0.36 < phi < 0.46:
        pos.z += 0.04 * math.sin(math.pi * (phi - 0.36) / 0.10)   # 地面で小さく跳ねる
    P.weapon = mat4(R, pos)
    return P


def ragdoll_pose(rest, k, base=None, w=1.0, bounce=0.0):
    """キー（骨盤・背骨・頭の向き、足首・手首の目標）から IK で全身の姿勢を作る。
    base があれば base の姿勢から k へ w の割合で寄せる（のけぞりの立ち上がり用）"""
    pose = Pose(rest)
    if base is not None:
        pose.hips_pos = base.hips_pos.lerp(k["hips"], w)
        for n, q in (("hips", "hipsQ"), ("spine", "spineQ"), ("chest", "chestQ"), ("head", "headQ")):
            pose.Q[n] = slerp_m(base.Q[n], k[q], w)
        pose.Q["neck"] = slerp_m(pose.Q["chest"], pose.Q["head"], 0.5)
        for s in (1, -1):
            sfx = rest.side[s]["sfx"]
            pose.Q["shoulder" + sfx] = pose.Q["chest"]
    else:
        pose.hips_pos = k["hips"] + V(0, 0, bounce)
        pose.Q["hips"], pose.Q["spine"], pose.Q["chest"], pose.Q["head"] = k["hipsQ"], k["spineQ"], k["chestQ"], k["headQ"]
        pose.Q["neck"] = slerp_m(k["chestQ"], k["headQ"], 0.5)
        for s in (1, -1):
            pose.Q["shoulder" + rest.side[s]["sfx"]] = k["chestQ"]
    M = pose.matrices()
    # 脚
    for s, ank, pole, fd in ((1, k["ankL"], k["poleL"], k["footL"]), (-1, k["ankR"], k["poleR"], k["footR"])):
        rs = rest.side[s]
        hip = bone_point(rest, M, "thigh" + rs["sfx"], rs["hip"])
        if base is not None:
            # 立ち姿勢のときの足首位置から寄せる
            ank0 = bone_point(rest, base.matrices(), "foot" + rs["sfx"], rs["ankle"])
            ank = ank0.lerp(ank, w)
        knee, ankle = ik2(hip, ank, rs["l_thigh"], rs["l_shin"], pole)
        bend = ortho(knee - hip, (ankle - hip).normalized())
        fdir = fd.normalized()
        lat = ortho(V(1, 0, 0), fdir)
        leg_rotations(pose, s, hip, knee, ankle, bend, fdir, lat, (fdir + V(0, 0.2, 0.3)).normalized() if fdir.z < -0.5 else fdir)
    M = pose.matrices()
    # 腕（力の抜けた腕：肘を少し曲げ、手首は重力方向へ）
    for s, wri, ep, palm in ((1, k["wriL"], k["epL"], k["palmL"]), (-1, k["wriR"], k["epR"], k["palmR"])):
        rs = rest.side[s]
        S = (M["shoulder" + rs["sfx"]] @ V(0, rest.b["shoulder" + rs["sfx"]]["length"], 0, 1)).to_3d()
        if base is not None:
            W0 = base.matrices()["hand" + rs["sfx"]].translation
            wri = W0.lerp(wri, w)
        E, W = ik2(S, wri, rs["l_up"], rs["l_fo"] * 0.97, ep)
        hd = ((W - E).normalized() + V(0, 0, -0.35)).normalized()
        arm_rotations(pose, s, S, E, W, hd, ortho(palm, hd))
    return pose


# ---------------------------------------------------------------------------
# モーションキャプチャーの移植（Quaternius Universal Animation Library, CC0）
#   元のボーンのワールド回転の変化量をこのリグへ写す。腕は元が T ポーズなので、
#   レスト時のボーン方向の差を補正してから写す。銃を持つアクションは腕だけ IK で銃に合わせる
# ---------------------------------------------------------------------------

UAL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "third_party", "quaternius_ual", "UAL_Standard.glb")
UAL_MAP = {
    "hips": "DEF-hips", "spine": "DEF-spine.001", "chest": "DEF-spine.003", "neck": "DEF-neck", "head": "DEF-head",
    "shoulder.L": "DEF-shoulder.L", "upper_arm.L": "DEF-upper_arm.L", "forearm.L": "DEF-forearm.L", "hand.L": "DEF-hand.L",
    "shoulder.R": "DEF-shoulder.R", "upper_arm.R": "DEF-upper_arm.R", "forearm.R": "DEF-forearm.R", "hand.R": "DEF-hand.R",
    "thigh.L": "DEF-thigh.L", "shin.L": "DEF-shin.L", "foot.L": "DEF-foot.L", "toe.L": "DEF-toe.L",
    "thigh.R": "DEF-thigh.R", "shin.R": "DEF-shin.R", "foot.R": "DEF-foot.R", "toe.R": "DEF-toe.R",
}


def _rot_between(a, b):
    a, b = a.normalized(), b.normalized()
    return a.rotation_difference(b).to_matrix()


def sample_mocap(rest, clips):
    """clips: {名前: 元アクション名}。各クリップを 30fps で標本化して、ボーンごとの回転 Q と骨盤位置、前進速度を返す"""
    if not os.path.exists(UAL_PATH):
        print("mocap library not found:", UAL_PATH)
        return {}
    before = set(bpy.data.objects)
    acts_before = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=UAL_PATH)
    new = [o for o in bpy.data.objects if o not in before]
    src = [o for o in new if o.type == "ARMATURE"][0]
    for o in new:
        if o is not src:
            o.hide_render = True
    sc = bpy.context.scene
    W0 = {n: (src.matrix_world @ src.data.bones[b].matrix_local).to_3x3() for n, b in UAL_MAP.items()}
    # 腕など、レスト時のボーン方向が違うものの補正
    A = {}
    for n, b in UAL_MAP.items():
        sb = src.data.bones[b]
        sdir = (sb.tail_local - sb.head_local)
        tdir = rest.b[n]["tail"] - rest.b[n]["head"]
        A[n] = _rot_between(tdir, sdir) if n.split(".")[0] in ("shoulder", "upper_arm", "forearm", "hand") else Matrix.Identity(3)
    hip0 = src.matrix_world @ src.data.bones["DEF-hips"].head_local
    scale = rest.b["thigh.L"]["head"].z / (src.matrix_world @ src.data.bones["DEF-thigh.L"].head_local).z
    out = {}
    src_fps = 24.0
    for name, aname in clips.items():
        act = bpy.data.actions.get(aname)
        if act is None:
            print("missing mocap clip", aname)
            continue
        src.animation_data_create()
        src.animation_data.action = act
        f0, f1 = act.frame_range
        dur = (f1 - f0) / src_fps
        n = max(8, round(dur * FPS))
        frames = []
        for i in range(n):
            sc.frame_set(int(f0), subframe=0.0)
            fr = f0 + (f1 - f0) * i / n
            sc.frame_set(int(math.floor(fr)), subframe=fr - math.floor(fr))
            bpy.context.view_layer.update()
            Q = {}
            for tn, b in UAL_MAP.items():
                Wt = (src.matrix_world @ src.pose.bones[b].matrix).to_3x3()
                Q[tn] = Wt @ W0[tn].inverted() @ A[tn]
            hp = src.matrix_world @ src.pose.bones["DEF-hips"].head
            toes = [src.matrix_world @ src.pose.bones["DEF-foot." + s].head for s in "LR"]
            frames.append(dict(Q=Q, hip=(hp - hip0) * scale, feet=toes))
        # 前進速度：接地している（低い方の）足が後ろへ動く速さ
        # 接地中（地面近く）の足が後ろへ動く速さの平均
        zmin = min(min(f["feet"][0].z, f["feet"][1].z) for f in frames)
        vs = []
        for i in range(n):
            a, b = frames[i], frames[(i + 1) % n]
            for k in (0, 1):
                if a["feet"][k].z < zmin + 0.06 and b["feet"][k].z < zmin + 0.06:
                    vs.append((b["feet"][k].y - a["feet"][k].y) * FPS)
        vs = [v for v in vs if v > 0] or [0.0]
        vs.sort()
        speed = vs[len(vs) // 2] * scale
        out[name] = dict(frames=frames, n=n, speed=speed)
        print("mocap %-14s <- %-16s %3d frames  %.2f m/s" % (name, aname, n, speed))
    for o in new:
        bpy.data.objects.remove(o, do_unlink=True)
    for a in list(bpy.data.actions):
        if a not in acts_before:
            bpy.data.actions.remove(a)
    return out


def mocap_pose(rest, clip, phi, RS=None, arms=True, extra_drop=0.0):
    fr = clip["frames"][int(round(phi * clip["n"])) % clip["n"]]
    pose = Pose(rest)
    for n, q in fr["Q"].items():
        if not arms and n.split(".")[0] in ("shoulder", "upper_arm", "forearm", "hand"):
            continue
        pose.Q[n] = q
    h = fr["hip"].copy()
    h.y = 0.0                                                   # その場（前進はルートモーション）
    pose.hips_pos = rest.b["hips"]["head"] + h + V(0, 0, -extra_drop)
    # 足の接地：低い方の足首をレストの高さに合わせる（体格差による浮き・めり込みを除く）
    M = pose.matrices()
    lo = min(bone_point(rest, M, "foot" + s, rest.side[k]["ankle"]).z for s, k in ((".L", 1), (".R", -1)))
    pose.hips_pos.z += rest.side[1]["ankle"].z - lo
    if RS is not None:
        if not arms:
            for s in (1, -1):
                sfx = rest.side[s]["sfx"]
                pose.Q["shoulder" + sfx] = pose.Q["chest"]
        hold_rifle(rest, pose, RS)
    else:
        M = pose.matrices()
        pose.weapon = M["chest"] @ rest.b["chest"]["R"].inverted() @ sling_rest(rest)
    return pose


# ゲームで使う歩き・走りはモーションキャプチャーに置き換え（アクション名 → (元クリップ, 構え)）
MOCAP_ACTIONS = {
    "Walk": ("Walk_Loop", None), "Run": ("Jog_Fwd_Loop", None),
    "Walk_Ready": ("Walk_Loop", "WalkReady"), "Jog_Rifle": ("Jog_Fwd_Loop", "Jog"),
    "Sprint_Rifle": ("Sprint_Loop", "Sprint"), "Idle_Ready": ("Idle_Loop", "StandReady"),
    "Walk_Aim": ("Walk_Loop", "WalkAim"),
    "Walk_Rifle": ("Walk_Loop", "Walk"), "Run_Rifle": ("Jog_Fwd_Loop", "Run"),
}


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
    # Call of Duty 風の三人称セット（すべて小銃）
    for gname, aname in (("WalkReady", "Walk_Ready"), ("Jog", "Jog_Rifle"), ("Sprint", "Sprint_Rifle"),
                         ("StandReady", "Idle_Ready"), ("WalkAim", "Walk_Aim")):
        G = GAITS[gname]
        made[aname] = (bake(arm, rest, aname, G["T"], G["stride"],
                            lambda phi, n=gname: gait_pose(rest, n, phi, True)), G["T"])
    made["Idle_Rifle"] = (bake(arm, rest, "Idle_Rifle", GAITS["Stand"]["T"], 0.0,
                               lambda phi: gait_pose(rest, "Stand", phi, True)), GAITS["Stand"]["T"])
    made["Death"] = (bake(arm, rest, "Death", DEATH_T, 0.0, lambda phi: death_pose(rest, phi), loop=False),
                     DEATH_T)
    for rifle in (False, True):
        act_name = "Jump" + ("_Rifle" if rifle else "")
        made[act_name] = (bake(arm, rest, act_name, JUMP_T, 0.0, lambda t, r=rifle: jump_pose(rest, t, r),
                               loop=False, root_z=jump_root_z), JUMP_T)
    clips = sample_mocap(rest, {k: v[0] for k, v in MOCAP_ACTIONS.items()})
    for act_name, (src, style) in MOCAP_ACTIONS.items():
        c = clips.get(act_name)
        if not c:
            continue
        RS = dict(RIFLE_STYLE[style]) if style else None
        T = c["n"]
        stride = c["speed"] * T / FPS
        made[act_name] = (bake(arm, rest, act_name, T, stride,
                               lambda phi, c=c, RS=RS: mocap_pose(rest, c, phi, RS, arms=RS is None)), T)
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
