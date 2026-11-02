// 発砲・着弾・煙・炎などの視覚効果
import * as THREE from 'three';

export class Effects {
  constructor(scene, T) {
    this.scene = scene;
    this.T = T;
    this.tracers = [];
    this.particles = [];
    // 曳光弾
    this.tracerMat = new THREE.LineBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.9 });
    // 着弾痕（プール）
    this.decalGeo = new THREE.PlaneGeometry(0.12, 0.12);
    this.decalMat = new THREE.MeshBasicMaterial({ map: T.impact, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -6 });
    this.decals = [];
    this.decalIdx = 0;
    for (let i = 0; i < 160; i++) {
      const m = new THREE.Mesh(this.decalGeo, this.decalMat);
      m.visible = false;
      scene.add(m);
      this.decals.push(m);
    }
    // パーティクル（煙・粉塵・血・火花）
    this.smokeMat = new THREE.SpriteMaterial({ map: T.smoke, color: 0x8a8378, transparent: true, depthWrite: false, opacity: 0.6 });
    this.flameMat = new THREE.SpriteMaterial({ map: T.flame, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.flashMat = new THREE.SpriteMaterial({ map: T.flash, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.lights = [];
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight(0xffb060, 0, 9, 2);
      scene.add(l);
      this.lights.push({ l, t: 0 });
    }
    this.fires = [];
    this.columns = [];
  }

  tracer(a, b, color = 0xffd9a0) {
    const g = new THREE.BufferGeometry().setFromPoints([a.clone(), b.clone()]);
    const mat = this.tracerMat.clone();
    mat.color.set(color);
    const line = new THREE.Line(g, mat);
    this.scene.add(line);
    this.tracers.push({ line, life: 0.06 });
  }

  flash(pos, size = 0.5) {
    const s = new THREE.Sprite(this.flashMat);
    s.position.copy(pos);
    s.scale.setScalar(size * (0.8 + Math.random() * 0.4));
    s.material.rotation = Math.random() * 6;
    this.scene.add(s);
    this.particles.push({ obj: s, life: 0.05, max: 0.05, vel: new THREE.Vector3(), grow: 0, fade: false });
    const L = this.lights.find((x) => x.t <= 0) || this.lights[0];
    L.l.position.copy(pos);
    L.l.intensity = 25;
    L.t = 0.05;
  }

  impact(pos, normal, kind = 'wall') {
    // デカール
    if (kind !== 'flesh') {
      const d = this.decals[this.decalIdx++ % this.decals.length];
      d.visible = true;
      d.position.copy(pos).addScaledVector(normal, 0.01);
      d.lookAt(pos.clone().add(normal));
      d.rotateZ(Math.random() * 6);
      d.scale.setScalar(0.7 + Math.random() * 0.8);
    }
    // 粉塵・血しぶき
    const n = kind === 'flesh' ? 5 : 7;
    for (let i = 0; i < n; i++) {
      const mat = this.smokeMat.clone();
      mat.color.set(kind === 'flesh' ? 0x5a0d08 : 0x9a9080);
      mat.opacity = kind === 'flesh' ? 0.8 : 0.55;
      const s = new THREE.Sprite(mat);
      s.position.copy(pos);
      s.scale.setScalar(0.08);
      const v = normal.clone().multiplyScalar(1 + Math.random() * 2)
        .add(new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5));
      this.scene.add(s);
      this.particles.push({ obj: s, life: 0.6, max: 0.6, vel: v, grow: kind === 'flesh' ? 0.6 : 1.4, fade: true, grav: 2 });
    }
    // 火花（金属・コンクリート）
    if (kind !== 'flesh' && Math.random() < 0.6) {
      for (let i = 0; i < 4; i++) {
        const s = new THREE.Sprite(this.flashMat);
        s.position.copy(pos);
        s.scale.setScalar(0.04);
        const v = normal.clone().multiplyScalar(3).add(new THREE.Vector3(Math.random() * 4 - 2, Math.random() * 3, Math.random() * 4 - 2));
        this.scene.add(s);
        this.particles.push({ obj: s, life: 0.18, max: 0.18, vel: v, grow: 0, fade: false, grav: 9 });
      }
    }
  }

  // 燃え続ける火（炎スプライト＋揺らぐ点光源＋煙）
  fire(pos, scale = 1) {
    const light = new THREE.PointLight(0xff7a2a, 30 * scale, 14 * scale, 2);
    light.position.copy(pos).add(new THREE.Vector3(0, 0.8, 0));
    this.scene.add(light);
    const sprites = [];
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Sprite(this.flameMat);
      s.position.copy(pos);
      this.scene.add(s);
      sprites.push(s);
    }
    this.fires.push({ pos: pos.clone(), light, sprites, scale, t: Math.random() * 10, emit: 0 });
  }

  // 遠景の黒煙柱
  smokeColumn(pos, scale = 1) {
    this.columns.push({ pos: pos.clone(), scale, emit: 0 });
  }

  puff(pos, vel, size, life, color, opacity) {
    const mat = this.smokeMat.clone();
    mat.color.set(color);
    mat.opacity = opacity;
    mat.rotation = Math.random() * 6;
    const s = new THREE.Sprite(mat);
    s.position.copy(pos);
    s.scale.setScalar(size);
    this.scene.add(s);
    this.particles.push({ obj: s, life, max: life, vel, grow: size * 0.6, fade: true, grav: 0, op: opacity });
  }

  update(dt, camPos) {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      t.line.material.opacity = Math.max(0, t.life / 0.06);
      if (t.life <= 0) { this.scene.remove(t.line); t.line.geometry.dispose(); this.tracers.splice(i, 1); }
    }
    for (const L of this.lights) { if (L.t > 0) { L.t -= dt; if (L.t <= 0) L.l.intensity = 0; } }
    for (const f of this.fires) {
      f.t += dt;
      f.light.intensity = 30 * f.scale * (0.7 + 0.3 * Math.sin(f.t * 13) * Math.sin(f.t * 7.3));
      f.sprites.forEach((s, i) => {
        const ph = f.t * (2 + i * 0.7) + i;
        s.position.set(f.pos.x + Math.sin(ph) * 0.15 * f.scale, f.pos.y + (0.3 + i * 0.25 + 0.1 * Math.sin(ph * 2)) * f.scale, f.pos.z + Math.cos(ph) * 0.15 * f.scale);
        s.scale.setScalar((1.3 - i * 0.2) * f.scale * (0.85 + 0.15 * Math.sin(ph * 3)));
      });
      f.emit -= dt;
      if (f.emit <= 0 && f.pos.distanceTo(camPos) < 90) {
        f.emit = 0.25;
        this.puff(f.pos.clone().add(new THREE.Vector3(0, 1.5 * f.scale, 0)), new THREE.Vector3(0.3, 1.4, 0.1), 0.8 * f.scale, 5, 0x2a2622, 0.45);
      }
    }
    for (const c of this.columns) {
      c.emit -= dt;
      if (c.emit <= 0) {
        c.emit = 0.35;
        this.puff(c.pos.clone().add(new THREE.Vector3(Math.random() * 2 - 1, 0, Math.random() * 2 - 1)),
          new THREE.Vector3(1.2, 3.5 + Math.random(), 0.4), 4 * c.scale, 14, 0x1e1b19, 0.5);
      }
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) { this.scene.remove(p.obj); if (p.obj.material !== this.flashMat) p.obj.material.dispose(); this.particles.splice(i, 1); continue; }
      p.vel.y -= (p.grav || 0) * dt;
      p.obj.position.addScaledVector(p.vel, dt);
      if (p.grow) p.obj.scale.addScalar(p.grow * dt);
      if (p.fade) p.obj.material.opacity = (p.op ?? p.obj.material.opacity) * Math.min(1, p.life / p.max * 1.5);
      if (p.op !== undefined) p.obj.material.opacity = p.op * Math.min(1, p.life / p.max * 1.5) * Math.min(1, (p.max - p.life) * 2);
    }
  }
}
