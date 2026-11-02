// 三人称視点で表示するプレイヤー本人（ゴースト版の兵士）とアニメーションの選択
import * as THREE from 'three';

// Blender で焼き込んだ各アクションの速度（m/s）とジャンプの区切り（位相）
const SPEED = { Walk_Rifle: 1.17 / (32 / 30), Run_Rifle: 2.4 / (20 / 30), Crouch_Rifle: 0.81 / (36 / 30), Prone_Rifle: 0.55 / (48 / 30) };
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
    for (const clip of gltf.animations) {
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

  play(name, fade = 0.2) {
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
      else if (hs < 0.25) { name = 'Idle_Rifle'; base = 0; }
      // 速度に合ったモーションを選ぶ（再生速度を上げすぎると脚の動きが崩れるため）
      else if (sprint || hs > 1.4) { name = 'Run_Rifle'; base = SPEED.Run_Rifle; }
      else { name = 'Walk_Rifle'; base = SPEED.Walk_Rifle; }
      const a = this.play(name);
      if (a) a.timeScale = base ? sgn * Math.max(0.7, Math.min(1.1, hs / base)) : 1;   // 再生速度は最大 1.1 倍
    }
    this.wasGround = p.onGround;
    this.mixer.update(dt);
  }
}
