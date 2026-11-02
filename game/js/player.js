// 一人称プレイヤー：移動・衝突・視点・武器（M16A2：単発／3 点バースト）
import * as THREE from 'three';
import { RELOAD, poseReload, resetReload } from './reload.js';

const STAND_EYE = 1.62, CROUCH_EYE = 1.08, PRONE_EYE = 0.38;
const lerpN = (a, b, t) => a + (b - a) * t;
const VM_BASE = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);

export class Player {
  constructor(camera, world, vmRoot, fx, audio) {
    this.camera = camera;
    this.world = world;
    this.fx = fx;
    this.audio = audio;
    this.pos = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.eye = STAND_EYE;
    this.onGround = true;
    this.stance = 0;                  // 0=立ち 1=しゃがみ 2=伏せ（匍匐）
    this.keys = {};
    this.health = 100;
    this.alive = true;
    this.lastHurt = -10;
    this.mag = 30; this.reserve = 210;
    this.mode = 'semi';               // semi | burst | auto
    this.touchAuto = false;           // タッチ：射撃ボタン長押しで連射
    this.burstLeft = 0;
    this.fireCool = 0;
    this.reloading = 0;
    this.ads = 0;                     // 0..1
    this.adsHeld = false;
    this.trigger = false;
    this.recoil = 0;                  // 視点の跳ね上がり（回復分）
    this.kick = 0;                    // 銃の後退
    this.bobT = 0; this.stepT = 0;
    this.time = 0;
    this.vm = vmRoot;                 // 一人称の銃と腕
    this.muzzleLocal = new THREE.Vector3(1.03, 0.0, 0.0);
    this.onShoot = null;              // (origin, dir) => {dist, hit}
    this.shake = 0;
  }

  get eyePos() { return new THREE.Vector3(this.pos.x, this.pos.y + this.eye, this.pos.z); }
  get forward() {
    return new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
  }
  get moving() { return Math.hypot(this.vel.x, this.vel.z) > 0.5; }

  look(dx, dy) {
    const sens = 0.0022 * (1 - this.ads * 0.45);
    this.yaw -= dx * sens;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - dy * sens));
  }

  get crouch() { return this.stance > 0; }
  set crouch(v) { this.stance = v ? 1 : 0; }
  get prone() { return this.stance === 2; }
  // 立ち → しゃがみ → 伏せ → 立ち …
  cycleStance() {
    const next = (this.stance + 1) % 3;
    if (next === 0 && this.world.ceiling(this.pos, 0.3, this.pos.y + 0.6) < this.pos.y + STAND_EYE + 0.15) return;
    this.stance = next;
  }

  toggleMode() {
    const order = ['semi', 'burst', 'auto'];
    this.mode = order[(order.indexOf(this.mode) + 1) % order.length];
    this.audio.click(1200, 0.03, 0.3);
  }

  reload() {
    if (this.reloading > 0 || this.mag >= 30 || this.reserve <= 0 || !this.alive) return;
    // 残弾があればタクティカル、空ならエンプティ（ボルトキャッチを叩く分だけ長い）
    this.reloadKind = this.mag > 0 ? 'tactical' : 'empty';
    this.reloadT = 0;
    this.reloadSeated = false;
    this.reloading = RELOAD[this.reloadKind].dur;
    this.audio.reload(this.reloadKind);
  }

  damage(amount, fromPos) {
    if (!this.alive) return;
    this.health -= amount;
    this.lastHurt = this.time;
    this.shake = Math.min(1, this.shake + 0.4);
    this.audio.hurt();
    if (this.health <= 0) { this.health = 0; this.alive = false; }
    return fromPos;
  }

  update(dt) {
    this.time += dt;
    const k = this.keys;
    const sprint = (((k.ShiftLeft || k.ShiftRight) && k.KeyW) || this.touchSprint) && !this.crouch && this.ads < 0.2 && this.reloading <= 0;
    this.lastSprint = sprint;
    // ADS
    const adsTarget = this.adsHeld && !sprint && this.reloading <= 0 && this.alive ? 1 : 0;
    this.ads += (adsTarget - this.ads) * Math.min(1, dt * 12);
    // 姿勢
    const eyeT = this.stance === 2 ? PRONE_EYE : this.stance === 1 ? CROUCH_EYE : STAND_EYE;
    let ceil = this.world.ceiling(this.pos, 0.3, this.pos.y + 0.5);
    if (eyeT <= this.eye || this.pos.y + eyeT + 0.15 < ceil) this.eye += (eyeT - this.eye) * Math.min(1, dt * (this.stance === 2 ? 5 : 10));
    // 移動
    // 三人称のモーション速度に合わせた移動速度（足が滑らない）：伏せ 0.34 / しゃがみ 1.17 / 通常 4.1 / ダッシュ 5.5 m/s
    let speed = this.stance === 2 ? 0.34 : this.stance === 1 ? 1.17 : sprint ? 5.5 : 4.1;
    if (this.stance === 0) speed = lerpN(speed, 1.6, this.ads);   // 照準しながら歩く 1.6 m/s
    if (k.KeyQ || k.AltLeft) speed = Math.min(speed, 1.2);   // ゆっくり歩く（歩行モーションの速度に合わせる）
    if (!this.alive) speed = 0;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const wish = new THREE.Vector3();
    if (k.KeyW) wish.add(fwd); if (k.KeyS) wish.sub(fwd);
    if (k.KeyD) wish.add(right); if (k.KeyA) wish.sub(right);
    if (this.moveInput) {            // タッチのアナログスティック（y は画面下向きが正）
      wish.addScaledVector(fwd, -this.moveInput.y).addScaledVector(right, this.moveInput.x);
    }
    if (wish.lengthSq() > 1) wish.normalize();
    wish.multiplyScalar(speed);
    const accel = this.onGround ? 14 : 3;
    this.vel.x += (wish.x - this.vel.x) * Math.min(1, dt * accel);
    this.vel.z += (wish.z - this.vel.z) * Math.min(1, dt * accel);
    if (k.Space && this.onGround && this.alive && !this.crouch) { this.vel.y = 5.6; this.onGround = false; }
    this.vel.y -= 19 * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.y += this.vel.y * dt;
    const h = this.eye + 0.15;
    const ground = this.world.collideCylinder(this.pos, 0.33, h, this.onGround ? 0.46 : 0.2);
    if (this.pos.y <= ground) {
      if (!this.onGround && this.vel.y < -6) this.shake = Math.min(1, this.shake + 0.2);
      this.pos.y = ground; this.vel.y = 0; this.onGround = true;
    } else if (this.pos.y > ground + 0.05) {
      this.onGround = false;
    }
    // 段差を登ったら滑らかに
    ceil = this.world.ceiling(this.pos, 0.3, this.pos.y + 0.3);
    if (this.pos.y + h > ceil) { this.pos.y = Math.min(this.pos.y, ceil - h); if (this.vel.y > 0) this.vel.y = 0; }

    // 足音・頭の揺れ
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && hs > 0.5) {
      this.bobT += dt * hs * 1.9;
      this.stepT -= dt * hs;
      if (this.stepT <= 0) { this.stepT = 1.6; this.audio.step(this.crouch ? 0.05 : sprint ? 0.2 : 0.12); }
    }
    // 体力回復
    if (this.alive && this.time - this.lastHurt > 5 && this.health < 100) this.health = Math.min(100, this.health + 12 * dt);

    // 射撃
    this.fireCool -= dt;
    const hs0 = Math.hypot(this.vel.x, this.vel.z);
    if (this.reloading > 0) {
      this.reloading -= dt;
      this.reloadT += dt;
      // マガジンが収まった瞬間に弾数を更新（タクティカルは薬室の 1 発が残る）
      if (!this.reloadSeated && this.reloadT >= RELOAD[this.reloadKind].seat) {
        this.reloadSeated = true;
        const cap = this.reloadKind === 'tactical' ? 31 : 30;
        const keep = this.reloadKind === 'tactical' ? Math.min(1, this.mag) : 0;
        const take = Math.min(cap - keep, this.reserve + (this.mag - keep));
        this.reserve -= take - (this.mag - keep);
        this.mag = keep + take;
      }
      if (this.reloading <= 0) this.reloading = 0;
    } else if (this.alive && !sprint && !(this.prone && hs0 > 0.3)) {
      const auto = this.mode === 'auto' || this.touchAuto;
      if (this.burstLeft > 0 && this.fireCool <= 0) this.fireOne();
      else if (auto && this.trigger && this.fireCool <= 0 && this.mag > 0) { this.burstLeft = 1; this.fireOne(true); }
      else if (this.trigger && this.fireCool <= 0 && this.burstLeft === 0 && this.mag > 0 && !this.triggerLatched) {
        this.triggerLatched = true;
        this.burstLeft = this.mode === 'burst' ? 3 : 1;
        this.fireOne();
      } else if (this.trigger && this.mag === 0 && !this.triggerLatched) {
        this.triggerLatched = true; this.audio.click(500, 0.04, 0.4);
      }
    }
    if (!this.trigger) this.triggerLatched = false;

    // 反動の回復
    const rec = Math.min(this.recoil, dt * 0.35);
    this.recoil -= rec;
    this.kick += (0 - this.kick) * Math.min(1, dt * 14);
    this.shake = Math.max(0, this.shake - dt * 2.5);

    // カメラ
    const bob = this.onGround ? Math.sin(this.bobT * 2) * 0.035 * (1 - this.ads * 0.8) * Math.min(1, hs / 4) : 0;
    const bobX = this.onGround ? Math.cos(this.bobT) * 0.025 * (1 - this.ads * 0.8) * Math.min(1, hs / 4) : 0;
    const shake = this.shake * 0.02;
    this.camera.position.set(this.pos.x + bobX * Math.cos(this.yaw), this.pos.y + this.eye + bob, this.pos.z - bobX * Math.sin(this.yaw));
    this.camera.rotation.set(this.pitch + (Math.random() - 0.5) * shake, this.yaw + (Math.random() - 0.5) * shake, 0, 'YXZ');
    const fov = 72 - this.ads * 30 + (sprint ? 6 : 0);
    if (Math.abs(this.camera.fov - fov) > 0.05) { this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 12); this.camera.updateProjectionMatrix(); }
    this.updateViewmodel(dt, sprint, hs);
  }

  fireOne(auto = false) {
    if (this.mag <= 0) { this.burstLeft = 0; return; }
    this.mag--;
    this.burstLeft--;
    this.fireCool = auto ? 0.085 : this.burstLeft > 0 ? 0.068 : this.mode === 'burst' ? 0.28 : 0.11;
    // 反動：視点の跳ね上がり＋左右ぶれ
    const kickUp = 0.012 + Math.random() * 0.008;
    this.pitch = Math.min(1.45, this.pitch + kickUp * (1 - this.ads * 0.35));
    this.yaw += (Math.random() - 0.5) * 0.008;
    this.kick = 1;
    this.recoil += kickUp;
    // 拡散
    const hs = Math.hypot(this.vel.x, this.vel.z);
    const spread = (this.ads > 0.8 ? 0.0012 : 0.016) + hs * 0.004 + (this.onGround ? 0 : 0.05) - (this.stance === 2 ? 0.008 : this.stance === 1 ? 0.004 : 0);
    const dir = this.forward;
    dir.x += (Math.random() - 0.5) * spread * 2; dir.y += (Math.random() - 0.5) * spread * 2; dir.z += (Math.random() - 0.5) * spread * 2;
    dir.normalize();
    const origin = this.eyePos;
    const res = this.onShoot ? this.onShoot(origin, dir) : null;
    const muzzle = this.muzzleWorld();
    this.fx.flash(muzzle, 0.45);
    if (res && Math.random() < 0.45) this.fx.tracer(muzzle, origin.clone().addScaledVector(dir, Math.min(res.dist, 300)));
    this.audio.gunshot(0, 0, 'player');
    if (this.onFired) this.onFired(origin);
  }

  muzzleWorld() {
    this.vm.updateMatrixWorld(true);
    return this.vm.userData.rifle ? this.vm.userData.rifle.localToWorld(this.muzzleLocal.clone()) : this.eyePos;
  }

  // 一人称の銃：腰だめ ↔ ADS（照準線を目に合わせる）、歩行の揺れ、反動、リロード
  updateViewmodel(dt, sprint, hs) {
    const vm = this.vm;
    const ads = this.ads;
    // ADS 位置：照準線（照門の後方 0.235m・銃身軸の 0.088m 上）を目の位置へ
    // 照門の箱のすぐ上を通す（照星の頂部が照準点のわずか下に見える）
    const adsPos = new THREE.Vector3(0, -0.112, 0.17);
    const hipPos = new THREE.Vector3(0.12, -0.15, 0.24);
    const p = hipPos.lerp(adsPos, ads);
    const t = this.time;
    const sway = (1 - ads * 0.85);
    p.x += Math.sin(this.bobT) * 0.012 * sway * Math.min(1, hs / 4);
    p.y += Math.abs(Math.cos(this.bobT)) * 0.012 * sway * Math.min(1, hs / 4) + Math.sin(t * 1.3) * 0.002 * sway;
    p.z += this.kick * 0.045;
    let rx = 0, ry = (1 - ads) * 0.06, rz = (1 - ads) * -0.05;
    rx += this.kick * 0.06;
    if (sprint || (this.prone && hs > 0.3)) { p.add(new THREE.Vector3(0.06, -0.06, -0.02)); ry += 0.55; rx -= 0.25; rz += 0.3; }
    if (this.vmParts && this.vmParts.ok) {
      if (this.reloading > 0) { poseReload(this.vmParts, this.reloadKind, this.reloadT); this.vmPosed = true; }
      else if (this.vmPosed) { resetReload(this.vmParts); this.vmPosed = false; }
    } else if (this.reloading > 0) {
      const k = Math.sin(Math.min(1, this.reloadT / 2.2) * Math.PI);
      p.y -= 0.12 * k; rx -= 0.5 * k; rz += 0.6 * k;
    }
    vm.position.lerp(p, Math.min(1, dt * 20));
    // カメラ空間での回転 × 基準回転（glTF の銃 +X 前方 → カメラ -Z）
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')).multiply(VM_BASE);
    vm.quaternion.slerp(q, Math.min(1, dt * 14));
  }
}
