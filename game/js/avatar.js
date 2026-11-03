// 三人称視点で表示するプレイヤー本人（ゴースト版の兵士）とアニメーションの選択
import * as THREE from 'three';

// Blender で焼き込んだ各アクションの速度（m/s）とジャンプの区切り（位相）
const SPEED = {   // 読み込み時に実際の値で上書き
  Walk_Ready: 1.30 / (32 / 30), Jog_Rifle: 2.46 / (18 / 30), Sprint_Rifle: 3.12 / (17 / 30), Walk_Aim: 1.50 / (28 / 30),
  Crouch_Rifle: 1.47 * 0.85 / (32 / 30), Prone_Rifle: 0.55 / (48 / 30),
};
const JUMP = { takeoff: 0.22, land: 0.72 };

export class Avatar {
  constructor(scene, gltf) {
    this.root = gltf.scene;
    this.root.visible = false;
    this.root.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; }
      if (o.name === 'Rifle') this.rifle = o;
    });
    scene.add(this.root);
    this.mixer = new THREE.AnimationMixer(this.root);
    this.actions = {};
    this.speed = {};
    for (const clip of gltf.animations) {
      // ルートモーション（前進量）から各モーションの速度を求める → 移動速度と再生速度を合わせる
      const tr = clip.tracks.find((t) => /^Soldier_Rig\.position$/.test(t.name));
      if (tr) {
        const v = tr.values, n = v.length / 3;
        const d = Math.hypot(v[(n - 1) * 3] - v[0], v[(n - 1) * 3 + 2] - v[2]);
        if (d > 0.05) SPEED[clip.name] = d / (tr.times[n - 1] - tr.times[0]);
      }
      const c = clip.clone();
      c.tracks = c.tracks.filter((t) => !/^Soldier_Rig\.position$/.test(t.name));   // 上昇・前進はゲーム側の物理で
      this.actions[c.name] = this.mixer.clipAction(c);
    }
    const j = this.actions.Jump_Rifle;
    if (j) { j.setLoop(THREE.LoopOnce, 1); j.clampWhenFinished = true; }
    this.cur = null;
    this.wasGround = true;
    this.jumping = false;
  }

  play(name, fade = 0.2) {   // 姿勢の切り替えは 0.2 秒でなめらかに
    if (this.cur === name) return this.actions[name];
    const a = this.actions[name];
    if (!a) return null;
    a.reset().play();
    if (this.cur) this.actions[this.cur].crossFadeTo(a, fade, false);
    this.cur = name;
    return a;
  }

  muzzle() {
    return this.rifle ? this.rifle.localToWorld(new THREE.Vector3(1.0, 0, 0)) : null;
  }

  update(dt, p, sprint) {
    this.root.position.set(p.pos.x, p.pos.y, p.pos.z);
    this.root.rotation.y = p.yaw + Math.PI;          // モデルは +Z 向き、プレイヤー前方は -Z
    const fwd = new THREE.Vector3(-Math.sin(p.yaw), 0, -Math.cos(p.yaw));
    const vf = p.vel.x * fwd.x + p.vel.z * fwd.z;     // 前後方向の速度（後退は逆再生）
    const hs = Math.hypot(p.vel.x, p.vel.z);
    const sgn = vf < -0.2 ? -1 : 1;
    // ジャンプ：離地で踏み切りから再生、着地前で止め、接地したら着地動作を最後まで
    const J = this.actions.Jump_Rifle;
    if (J && !p.onGround && this.wasGround && p.vel.y > 1) {
      this.jumping = true;
      const a = this.play('Jump_Rifle', 0.08);
      a.time = JUMP.takeoff * J.getClip().duration;
      a.timeScale = 1;
    }
    if (this.jumping && J) {
      const d = J.getClip().duration;
      if (!p.onGround && J.time >= JUMP.land * d - 0.02) { J.time = JUMP.land * d - 0.02; J.timeScale = 0; }
      if (p.onGround) J.timeScale = 1.3;
      if (p.onGround && J.time >= d - 0.02) this.jumping = false;
    }
    if (!this.jumping) {
      let name, base;
      if (p.prone) { name = 'Prone_Rifle'; base = SPEED.Prone_Rifle; }
      else if (p.crouch) { name = 'Crouch_Rifle'; base = SPEED.Crouch_Rifle; }
      // Call of Duty 風：普段は腰だめ（胸の高さで前へ）、照準ボタンを押している間だけ目線で狙う
      else if (p.ads > 0.5) {
        if (hs < 0.25) { name = 'Idle_Rifle'; base = 0; } else { name = 'Walk_Aim'; base = SPEED.Walk_Aim; }
      } else if (hs < 0.25) { name = 'Idle_Ready'; base = 0; }
      else if (sprint) { name = 'Sprint_Rifle'; base = SPEED.Sprint_Rifle; }
      else if (hs > 2.0) { name = 'Jog_Rifle'; base = SPEED.Jog_Rifle; }
      else { name = 'Walk_Ready'; base = SPEED.Walk_Ready; }
      const a = this.play(name);
      if (a) a.timeScale = base ? sgn * Math.max(0.7, Math.min(1.1, hs / base)) : 1;   // 再生速度は最大 1.1 倍
    }
    this.wasGround = p.onGround;
    this.mixer.update(dt);
    // 上下の狙い：視点の上下に合わせて背骨・胸を曲げる（銃口がカメラの照準方向を向く）
    if (!p.prone) {
      this.root.updateMatrixWorld(true);
      const right = new THREE.Vector3(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
      // 体を曲げるのは自然な範囲まで（下 -25°〜上 +35°）。それ以上はカメラだけが傾く
      const bend = Math.max(-0.44, Math.min(0.6, p.pitch));
      for (const [n, k] of [['spine', 0.4], ['chest', 0.6]]) {
        const b = this.root.getObjectByName(n);
        if (b) { b.rotateOnWorldAxis(right, bend * k); b.updateMatrixWorld(true); }
      }
    }
  }
}
