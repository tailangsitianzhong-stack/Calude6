// 敵兵：soldier.glb（ガスマスク兵）を複製し、アニメーションと AI で動かす
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// 各アクションのルートモーション速度（m/s）＝ Blender の焼き込み値
const ANIM_SPEED = { Walk_Ready: 1.30 / (32 / 30), Jog_Rifle: 2.46 / (18 / 30), Crouch_Rifle: 1.47 * 0.85 / (32 / 30) };
const EYE = 1.55;

function stripRootMotion(clip) {
  // オブジェクト（Soldier_Rig）の移動トラックを除去し、その場アニメにする
  const c = clip.clone();
  c.tracks = c.tracks.filter((t) => !/^Soldier_Rig\.(position)$/.test(t.name));
  return c;
}

export class EnemyManager {
  constructor(scene, gltf, world, nav, fx, audio, player) {
    this.scene = scene;
    this.gltf = gltf;
    this.world = world;
    this.nav = nav;
    this.fx = fx;
    this.audio = audio;
    this.player = player;
    this.list = [];
    this.clips = {};
    for (const a of gltf.animations) {
      const tr = a.tracks.find((t) => /^Soldier_Rig\.position$/.test(t.name));
      if (tr) {
        const v = tr.values, n = v.length / 3;
        const d = Math.hypot(v[(n - 1) * 3] - v[0], v[(n - 1) * 3 + 2] - v[2]);
        if (d > 0.05) ANIM_SPEED[a.name] = d / (tr.times[n - 1] - tr.times[0]);
      }
      this.clips[a.name] = stripRootMotion(a);
    }
    this.gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
    this.alertPos = null;
  }

  spawn(pos) {
    const e = new Enemy(this, pos);
    this.list.push(e);
    return e;
  }

  get alive() { return this.list.filter((e) => e.alive).length; }

  // 銃声：近くの敵が気づく
  noise(pos, radius) {
    for (const e of this.list) if (e.alive && e.root.position.distanceTo(pos) < radius) e.hear(pos);
  }

  // プレイヤーの弾：最も近いヒットボックス
  raycast(o, d, maxDist) {
    let best = null;
    for (const e of this.list) {
      if (!e.alive) continue;
      const h = e.hitTest(o, d, maxDist);
      if (h && (!best || h.t < best.t)) best = { ...h, enemy: e };
    }
    return best;
  }

  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      e.update(dt);
      if (!e.alive && e.deadTime > 15) { e.dispose(); this.list.splice(i, 1); }
    }
  }

  // A*（ノードの番号列を返す）
  path(from, to) {
    const { nodes, edges } = this.nav;
    const nearest = (p) => { let bi = 0, bd = Infinity; nodes.forEach((n, i) => { const d = n.distanceToSquared(p); if (d < bd) { bd = d; bi = i; } }); return bi; };
    const s = nearest(from), g = nearest(to);
    const open = new Set([s]), came = new Map(), gs = new Map([[s, 0]]), fs = new Map([[s, nodes[s].distanceTo(nodes[g])]]);
    while (open.size) {
      let cur = null, cf = Infinity;
      for (const n of open) if ((fs.get(n) ?? Infinity) < cf) { cf = fs.get(n); cur = n; }
      if (cur === g) {
        const out = [cur];
        while (came.has(cur)) { cur = came.get(cur); out.unshift(cur); }
        return out.map((i) => nodes[i].clone());
      }
      open.delete(cur);
      for (const nb of edges[cur]) {
        const t = gs.get(cur) + nodes[cur].distanceTo(nodes[nb]);
        if (t < (gs.get(nb) ?? Infinity)) { came.set(nb, cur); gs.set(nb, t); fs.set(nb, t + nodes[nb].distanceTo(nodes[g])); open.add(nb); }
      }
    }
    return [nodes[g].clone()];
  }
}

class Enemy {
  constructor(mgr, pos) {
    this.mgr = mgr;
    const root = this.root = SkeletonUtils.clone(mgr.gltf.scene);
    root.position.copy(pos);
    mgr.scene.add(root);
    this.mixer = new THREE.AnimationMixer(root);
    this.actions = {};
    for (const [name, clip] of Object.entries(mgr.clips)) this.actions[name] = this.mixer.clipAction(clip);
    this.actions.Death.setLoop(THREE.LoopOnce, 1);
    this.actions.Death.clampWhenFinished = true;
    this.bones = {};
    // glTF 読み込み時に名前の「.」は除かれる（thigh.L → thighL）ので、両方の名前で引けるようにする
    root.traverse((o) => { if (o.isBone) { this.bones[o.name] = o; } if (o.name === 'Rifle') this.rifle = o; });
    this.cur = null;
    this.play('Walk_Ready', 0);
    this.health = 100;
    this.alive = true;
    this.deadTime = 0;
    this.state = 'patrol';
    this.path = [];
    this.target = null;
    this.yaw = Math.random() * Math.PI * 2;
    this.lastSeen = null;
    this.seeTimer = Math.random() * 0.3;
    this.canSee = false;
    this.reaction = 0;
    this.burst = 0; this.shotCool = 1 + Math.random(); this.stateTime = 0;
    this.crouchMode = false;
    this.speed = 0;
    this.tmp = new THREE.Vector3();
  }

  play(name, fade = 0.25) {
    if (this.cur === name) return;
    const a = this.actions[name];
    if (!a) return;
    a.reset().play();
    if (this.cur) this.actions[this.cur].crossFadeTo(a, fade, false);
    this.cur = name;
  }

  hear(pos) {
    if (!this.alive) return;
    this.lastSeen = pos.clone();
    if (this.state === 'patrol') { this.state = 'hunt'; this.path = []; }
  }

  bonePos(name, off = null) {
    const b = this.bones[name] || this.bones[name.replace('.', '')];
    if (!b) return this.root.position.clone();
    return off ? b.localToWorld(off.clone()) : b.getWorldPosition(new THREE.Vector3());
  }

  // ヒットボックス：頭（球）・胴（カプセル）・脚（カプセル）
  hitTest(o, d, maxDist) {
    this.root.updateMatrixWorld(true);
    const head = this.bonePos('head', new THREE.Vector3(0, 0.1, 0.0));
    const hips = this.bonePos('hips'), chest = this.bonePos('chest', new THREE.Vector3(0, 0.18, 0));
    let best = null;
    const test = (t, part) => { if (t !== null && t < maxDist && (!best || t < best.t)) best = { t, part }; };
    test(raySphere(o, d, head, 0.14), 'head');
    test(rayCapsule(o, d, hips, chest, 0.23), 'body');
    for (const s of ['.L', '.R']) {
      test(rayCapsule(o, d, this.bonePos('thigh' + s), this.bonePos('shin' + s), 0.1), 'leg');
      test(rayCapsule(o, d, this.bonePos('shin' + s), this.bonePos('foot' + s), 0.08), 'leg');
      test(rayCapsule(o, d, this.bonePos('upper_arm' + s), this.bonePos('hand' + s), 0.07), 'arm');
    }
    return best;
  }

  damage(amount, part, fromPos) {
    if (!this.alive) return false;
    this.health -= amount;
    this.hear(fromPos);
    this.reaction = 0.15;
    if (this.health <= 0) { this.die(); return true; }
    return false;
  }

  die() {
    this.alive = false;
    this.state = 'dead';
    const a = this.actions.Death;
    a.reset();
    a.play();
    if (this.cur) this.actions[this.cur].crossFadeTo(a, 0.12, false);
    this.cur = 'Death';
  }

  dispose() {
    this.mgr.scene.remove(this.root);
    this.root.traverse((o) => { if (o.isSkinnedMesh) o.skeleton.dispose(); });
  }

  eye() { return new THREE.Vector3(this.root.position.x, this.root.position.y + (this.crouchMode ? 1.1 : EYE), this.root.position.z); }

  checkSight() {
    const P = this.mgr.player;
    if (!P.alive) return false;
    const pe = P.eyePos;
    const me = this.eye();
    const to = pe.clone().sub(me);
    const dist = to.length();
    if (dist > 95) return false;
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const flat = new THREE.Vector3(to.x, 0, to.z).normalize();
    const alerted = this.state !== 'patrol';
    if (fwd.dot(flat) < (alerted ? -0.2 : 0.35) && dist > 6) return false;
    // しゃがみ・静止のプレイヤーは遠くから見つけにくい
    if (!alerted && dist > (P.prone ? 22 : P.crouch ? 35 : 70)) return false;
    to.normalize();
    const hit = this.mgr.world.raycast(me, to, dist);
    return !hit || hit.t > dist - 0.4;
  }

  update(dt) {
    this.mixer.update(dt);
    if (!this.alive) { this.deadTime += dt; return; }
    const P = this.mgr.player;
    const pos = this.root.position;
    this.stateTime += dt;
    this.seeTimer -= dt;
    if (this.seeTimer <= 0) {
      this.seeTimer = 0.2;
      const was = this.canSee;
      this.canSee = this.checkSight();
      if (this.canSee) {
        this.lastSeen = P.pos.clone();
        if (!was) this.reaction = 0.8 + Math.random() * 0.7;    // 発見してから撃つまで
        if (this.state === 'patrol' || this.state === 'hunt') { this.state = 'engage'; this.stateTime = 0; }
        this.mgr.alertPos = P.pos.clone();
      }
    }
    this.reaction -= dt;
    let moveTarget = null, desired = 'Walk_Ready', speed = ANIM_SPEED.Walk_Ready;
    const distP = pos.distanceTo(P.pos);

    if (this.state === 'patrol') {
      if (!this.path.length) {
        const n = this.mgr.nav.nodes;
        this.path = this.mgr.path(pos, n[Math.floor(Math.random() * n.length)]);
      }
      moveTarget = this.path[0];
      if (this.mgr.alertPos && pos.distanceTo(this.mgr.alertPos) < 60 && Math.random() < dt * 0.3) this.hear(this.mgr.alertPos);
    } else if (this.state === 'hunt') {
      // 最後に見た／聞いた地点へ走る
      if (!this.path.length && this.lastSeen) this.path = this.mgr.path(pos, this.lastSeen).concat([this.lastSeen.clone()]);
      moveTarget = this.path[0];
      desired = 'Jog_Rifle'; speed = ANIM_SPEED.Jog_Rifle;
      if (!moveTarget || (this.lastSeen && pos.distanceTo(this.lastSeen) < 2)) { this.state = 'patrol'; this.path = []; }
    } else if (this.state === 'engage') {
      if (!this.canSee) {
        if (this.stateTime > 2.5) { this.state = 'hunt'; this.path = []; }
        desired = 'Idle_Rifle'; speed = 0;
      } else {
        this.stateTime = 0;
        // 間合い：遠ければしゃがみ前進、近すぎれば立ち止まって撃つ
        if (Math.random() < dt * 0.25) this.crouchMode = !this.crouchMode;
        if (distP > 22 && this.crouchMode) { desired = 'Crouch_Rifle'; speed = ANIM_SPEED.Crouch_Rifle; moveTarget = P.pos; }
        else if (distP > 45) { desired = 'Jog_Rifle'; speed = ANIM_SPEED.Jog_Rifle; moveTarget = P.pos; }
        else { desired = 'Idle_Rifle'; speed = 0; }
        this.shoot(dt, distP);
      }
    }

    // 向き
    let faceDir = null;
    if (this.state === 'engage' && this.canSee) faceDir = P.pos.clone().sub(pos);
    else if (moveTarget) faceDir = moveTarget.clone().sub(pos);
    if (faceDir && faceDir.lengthSq() > 0.01) {
      const ty = Math.atan2(faceDir.x, faceDir.z);
      let d = ty - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * Math.min(1, dt * (this.state === 'engage' ? 8 : 4));
    }
    this.root.rotation.y = this.yaw;

    // 移動（アニメの歩幅に速度を合わせる → 足が滑らない）
    if (moveTarget && speed > 0) {
      const to = moveTarget.clone().sub(pos); to.y = 0;
      if (to.length() < 1.2 && this.state !== 'engage') { this.path.shift(); }
      const dir = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      const align = Math.max(0, dir.dot(to.normalize()));
      const v = speed * (0.35 + 0.65 * align);
      pos.addScaledVector(dir, v * dt);
      this.actions[desired] && (this.actions[desired].timeScale = v / speed);
      // 敵同士の間隔
      for (const o of this.mgr.list) {
        if (o === this || !o.alive) continue;
        const dd = pos.clone().sub(o.root.position); dd.y = 0;
        const l = dd.length();
        if (l < 1.0 && l > 0.001) pos.addScaledVector(dd.normalize(), (1.0 - l) * 0.5);
      }
      const ground = this.mgr.world.collideCylinder(pos, 0.35, 1.7, 0.5);
      pos.y += (ground - pos.y) * Math.min(1, dt * 10);
    }
    this.play(desired);
  }

  shoot(dt, dist) {
    if (this.passive) return;
    this.shotCool -= dt;
    if (this.reaction > 0 || this.shotCool > 0) return;
    const P = this.mgr.player;
    if (this.burst <= 0) this.burst = 2 + Math.floor(Math.random() * 3);
    this.burst--;
    this.shotCool = this.burst > 0 ? 0.12 : 1.0 + Math.random() * 1.2;
    // 命中率：距離・プレイヤーの移動・しゃがみで変化
    const pv = Math.hypot(P.vel.x, P.vel.z);
    let p = 0.42 - dist / 120 - pv * 0.045 - (P.prone ? 0.18 : P.crouch ? 0.1 : 0) + (this.crouchMode ? 0.04 : 0);
    p = Math.max(0.03, Math.min(0.45, p));
    const muzzle = this.rifle ? this.rifle.localToWorld(new THREE.Vector3(1.0, 0, 0)) : this.eye();
    const target = P.eyePos.add(new THREE.Vector3(0, -Math.min(0.35, P.eye * 0.4), 0));
    const hit = Math.random() < p;
    const aim = target.clone();
    if (!hit) aim.add(new THREE.Vector3((Math.random() - 0.5) * 2.5, (Math.random() - 0.2) * 1.5, (Math.random() - 0.5) * 2.5));
    const dir = aim.sub(muzzle).normalize();
    const wh = this.mgr.world.raycast(muzzle, dir, 200);
    const end = wh ? muzzle.clone().addScaledVector(dir, wh.t) : muzzle.clone().addScaledVector(dir, 120);
    this.mgr.fx.flash(muzzle, 0.4);
    this.mgr.fx.tracer(muzzle, end, 0xffc070);
    if (wh && !hit) this.mgr.fx.impact(end, wh.normal, 'wall');
    // 音（距離と方向）
    const rel = muzzle.clone().sub(P.eyePos);
    const right = new THREE.Vector3(Math.cos(P.yaw), 0, -Math.sin(P.yaw));
    this.mgr.audio.gunshot(rel.length(), rel.normalize().dot(right), 'enemy');
    if (hit && (!wh || wh.t > dist - 1)) P.damage(7 + Math.random() * 6, muzzle);
  }
}

function raySphere(o, d, c, r) {
  const oc = o.clone().sub(c);
  const b = oc.dot(d), cc = oc.lengthSq() - r * r;
  const h = b * b - cc;
  if (h < 0) return null;
  const t = -b - Math.sqrt(h);
  return t > 0 ? t : null;
}

function rayCapsule(o, d, a, b, r) {
  // 線分 ab 上の最近点で近似：レイと線分の最短距離 < r なら命中
  const ab = b.clone().sub(a), ao = o.clone().sub(a);
  const abd = ab.dot(d), abab = ab.lengthSq(), aod = ao.dot(d), aoab = ao.dot(ab);
  const denom = abab - abd * abd;
  // 線分パラメータ s（レイとの最近点）
  const s = denom > 1e-6 ? Math.max(0, Math.min(1, (aoab - abd * aod) / denom)) : 0;
  const p = a.clone().addScaledVector(ab, s);
  const t = Math.max(0, p.clone().sub(o).dot(d));
  const q = o.clone().addScaledVector(d, t);
  if (q.distanceTo(p) > r) return null;
  return t - Math.sqrt(Math.max(0, r * r - q.distanceToSquared(p)));
}
