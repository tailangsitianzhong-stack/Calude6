// マテリアルごとにジオメトリを集めて 1 つのメッシュにまとめるビルダー、
// および当たり判定用 AABB ワールド（グリッドハッシュ付き）
import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _s = new THREE.Vector3();
const _nm = new THREE.Matrix3();

export class GeoBuilder {
  constructor() { this.buckets = new Map(); }

  bucket(key) {
    let b = this.buckets.get(key);
    if (!b) { b = { pos: [], nor: [], uv: [], col: [], idx: [] }; this.buckets.set(key, b); }
    return b;
  }

  // 直方体。中心 (x,y,z)、サイズ (sx,sy,sz)、回転 (rx,ry,rz)。UV はメートル単位 / uvScale
  box(key, x, y, z, sx, sy, sz, opts = {}) {
    const { rx = 0, ry = 0, rz = 0, color = 0xffffff, uv = 2, uvOff = [0, 0], faces = 63 } = opts;
    _e.set(rx, ry, rz);
    _q.setFromEuler(_e);
    _m.compose(_v.set(x, y, z), _q, _s.set(1, 1, 1));
    this.boxM(key, _m, sx, sy, sz, color, uv, uvOff, faces);
  }

  boxM(key, m, sx, sy, sz, color = 0xffffff, uvs = 2, uvOff = [0, 0], faces = 63) {
    const b = this.bucket(key);
    const c = new THREE.Color(color);
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    // 各面：法線, u 軸, v 軸, (u 長, v 長)
    const F = [
      [[1, 0, 0], [0, 0, -1], [0, 1, 0], sz, sy, hx],
      [[-1, 0, 0], [0, 0, 1], [0, 1, 0], sz, sy, hx],
      [[0, 1, 0], [1, 0, 0], [0, 0, -1], sx, sz, hy],
      [[0, -1, 0], [1, 0, 0], [0, 0, 1], sx, sz, hy],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0], sx, sy, hz],
      [[0, 0, -1], [-1, 0, 0], [0, 1, 0], sx, sy, hz],
    ];
    _nm.getNormalMatrix(m);
    // ワールド位置に基づく UV オフセット（同じテクスチャの繰り返しが目立たないように）
    const ox = m.elements[12], oy = m.elements[13], oz = m.elements[14];
    for (let f = 0; f < 6; f++) {
      if (!(faces & (1 << f))) continue;
      const [n, u, v, ul, vl, d] = F[f];
      const base = b.pos.length / 3;
      _n.set(n[0], n[1], n[2]).applyMatrix3(_nm).normalize();
      for (let k = 0; k < 4; k++) {
        const su = (k === 1 || k === 2) ? 1 : -1, sv = (k >= 2) ? 1 : -1;
        _v.set(n[0] * d + u[0] * su * ul / 2 + v[0] * sv * vl / 2,
          n[1] * d + u[1] * su * ul / 2 + v[1] * sv * vl / 2,
          n[2] * d + u[2] * su * ul / 2 + v[2] * sv * vl / 2).applyMatrix4(m);
        b.pos.push(_v.x, _v.y, _v.z);
        b.nor.push(_n.x, _n.y, _n.z);
        const wu = f < 2 ? oz * (f === 0 ? -1 : 1) : ox * (f === 5 ? -1 : 1);
        const wv = f === 2 || f === 3 ? oz : oy;
        b.uv.push((su * ul / 2 + wu) / uvs + uvOff[0], (sv * vl / 2 + wv) / uvs + uvOff[1]);
        b.col.push(c.r, c.g, c.b);
      }
      b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  // 任意の BufferGeometry を行列付きで追加（UV はそのまま／色は一律）
  geom(key, g, m, color = 0xffffff, uvScale = 1) {
    const b = this.bucket(key);
    const c = new THREE.Color(color);
    const gg = g.index ? g.toNonIndexed() : g;
    const p = gg.attributes.position, n = gg.attributes.normal, t = gg.attributes.uv;
    _nm.getNormalMatrix(m);
    const base = b.pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(m);
      b.pos.push(_v.x, _v.y, _v.z);
      _n.fromBufferAttribute(n, i).applyMatrix3(_nm).normalize();
      b.nor.push(_n.x, _n.y, _n.z);
      b.uv.push(t ? t.getX(i) * uvScale : 0, t ? t.getY(i) * uvScale : 0);
      b.col.push(c.r, c.g, c.b);
      b.idx.push(base + i);
    }
  }

  // 四角形 1 枚（看板・デカール用、UV を明示）
  quad(key, corners, uvs, color = 0xffffff) {
    const b = this.bucket(key);
    const c = new THREE.Color(color);
    const base = b.pos.length / 3;
    const e1 = new THREE.Vector3().subVectors(corners[1], corners[0]);
    const e2 = new THREE.Vector3().subVectors(corners[3], corners[0]);
    const nn = new THREE.Vector3().crossVectors(e1, e2).normalize();
    for (let k = 0; k < 4; k++) {
      b.pos.push(corners[k].x, corners[k].y, corners[k].z);
      b.nor.push(nn.x, nn.y, nn.z);
      b.uv.push(uvs[k][0], uvs[k][1]);
      b.col.push(c.r, c.g, c.b);
    }
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  build(materials, group, { shadows = true } = {}) {
    for (const [key, b] of this.buckets) {
      if (!b.pos.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
      g.setIndex(b.idx);
      g.computeBoundingSphere();
      const mat = materials[key];
      if (!mat) { console.warn('no material', key); continue; }
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = shadows && !mat.userData.noShadow;
      mesh.receiveShadow = true;
      mesh.name = 'city_' + key;
      group.add(mesh);
    }
  }
}

// ---------------------------------------------------------------------------
// 当たり判定：軸平行ボックスの集合
// ---------------------------------------------------------------------------
export class World {
  constructor(cell = 8) {
    this.boxes = [];
    this.cell = cell;
    this.grid = new Map();
  }

  add(minX, minY, minZ, maxX, maxY, maxZ, tag = 'solid') {
    const b = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], tag, id: this.boxes.length };
    this.boxes.push(b);
    const c = this.cell;
    for (let gx = Math.floor(minX / c); gx <= Math.floor(maxX / c); gx++) {
      for (let gz = Math.floor(minZ / c); gz <= Math.floor(maxZ / c); gz++) {
        const k = gx * 10007 + gz;
        let a = this.grid.get(k);
        if (!a) { a = []; this.grid.set(k, a); }
        a.push(b);
      }
    }
    return b;
  }

  // 中心・サイズ指定
  addC(x, y, z, sx, sy, sz, tag) {
    return this.add(x - sx / 2, y - sy / 2, z - sz / 2, x + sx / 2, y + sy / 2, z + sz / 2, tag);
  }

  query(minX, minZ, maxX, maxZ) {
    const out = new Set();
    const c = this.cell;
    for (let gx = Math.floor(minX / c); gx <= Math.floor(maxX / c); gx++) {
      for (let gz = Math.floor(minZ / c); gz <= Math.floor(maxZ / c); gz++) {
        const a = this.grid.get(gx * 10007 + gz);
        if (a) for (const b of a) out.add(b);
      }
    }
    return out;
  }

  // 円柱（半径 r, 足元 y0, 高さ h）を XZ で押し出す。段差 stepH 以下は乗り越える
  collideCylinder(pos, r, h, stepH = 0.45) {
    let ground = 0;
    const cand = this.query(pos.x - r - 1, pos.z - r - 1, pos.x + r + 1, pos.z + r + 1);
    for (const b of cand) {
      if (pos.x + r <= b.min[0] || pos.x - r >= b.max[0] || pos.z + r <= b.min[2] || pos.z - r >= b.max[2]) continue;
      const top = b.max[1];
      if (pos.y + h <= b.min[1]) continue;          // 頭上
      if (top <= pos.y + stepH) {                    // 足元：乗れる
        const cx = Math.max(b.min[0], Math.min(pos.x, b.max[0]));
        const cz = Math.max(b.min[2], Math.min(pos.z, b.max[2]));
        if ((pos.x - cx) ** 2 + (pos.z - cz) ** 2 < r * r * 0.5) ground = Math.max(ground, top);
        continue;
      }
      // 側面から押し出す（最近点）
      const cx = Math.max(b.min[0], Math.min(pos.x, b.max[0]));
      const cz = Math.max(b.min[2], Math.min(pos.z, b.max[2]));
      let dx = pos.x - cx, dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        pos.x += dx / d * (r - d); pos.z += dz / d * (r - d);
      } else {
        // 中心が内部：最短の面へ
        const opts = [[b.min[0] - r - pos.x, 0], [b.max[0] + r - pos.x, 0], [0, b.min[2] - r - pos.z], [0, b.max[2] + r - pos.z]];
        opts.sort((a, c) => Math.abs(a[0] + a[1]) - Math.abs(c[0] + c[1]));
        pos.x += opts[0][0]; pos.z += opts[0][1];
      }
    }
    return ground;
  }

  // 天井（頭をぶつける高さ）
  ceiling(pos, r, y) {
    let ceil = Infinity;
    const cand = this.query(pos.x - r, pos.z - r, pos.x + r, pos.z + r);
    for (const b of cand) {
      if (pos.x + r <= b.min[0] || pos.x - r >= b.max[0] || pos.z + r <= b.min[2] || pos.z - r >= b.max[2]) continue;
      if (b.min[1] >= y) ceil = Math.min(ceil, b.min[1]);
    }
    return ceil;
  }

  // レイキャスト（スラブ法）。最も近い交差を返す
  raycast(o, d, maxDist) {
    let best = null, bestT = maxDist;
    // レイに沿ってセルを走査（粗い DDA）
    const c = this.cell;
    const seen = new Set();
    const steps = Math.ceil(maxDist / (c * 0.5)) + 1;
    for (let s = 0; s <= steps; s++) {
      const t = Math.min(s * c * 0.5, maxDist);
      if (t > bestT + c) break;
      const px = o.x + d.x * t, pz = o.z + d.z * t;
      for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
        const k = (Math.floor(px / c) + ox) * 10007 + (Math.floor(pz / c) + oz);
        if (seen.has(k)) continue;
        seen.add(k);
        const a = this.grid.get(k);
        if (!a) continue;
        for (const b of a) {
          const hit = rayBox(o, d, b);
          if (hit && hit.t < bestT) { bestT = hit.t; best = { t: hit.t, normal: hit.normal, box: b }; }
        }
      }
    }
    // 地面
    if (d.y < 0) {
      const tg = -o.y / d.y;
      if (tg > 0 && tg < bestT) { bestT = tg; best = { t: tg, normal: new THREE.Vector3(0, 1, 0), box: null }; }
    }
    return best;
  }
}

export function rayBox(o, d, b) {
  let tmin = -Infinity, tmax = Infinity, axis = -1, sign = 0;
  const oo = [o.x, o.y, o.z], dd = [d.x, d.y, d.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dd[i]) < 1e-9) {
      if (oo[i] < b.min[i] || oo[i] > b.max[i]) return null;
    } else {
      let t1 = (b.min[i] - oo[i]) / dd[i], t2 = (b.max[i] - oo[i]) / dd[i];
      let s = -1;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
      if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  if (tmax < 0 || tmin < 0) return null;
  const normal = new THREE.Vector3();
  if (axis >= 0) normal.setComponent(axis, sign);
  return { t: tmin, normal };
}
