// 戦時中の市街地マップを手続き生成する
//   3×3 の街区（中央は広場、2 つは崩壊した廃墟街区）、外周道路、外縁の建物列
//   建物は窓が実際に開口になるよう壁パーツで組み立て、窓枠・窓台・まぐさ・鎧戸・バルコニー・
//   蛇腹（コーニス）・看板・日除け・屋根・煙突、損傷（砲弾痕・上部崩落・全壊廃墟）を持つ
import * as THREE from 'three';
import { GeoBuilder, World } from './builder.js';
import { rand } from './textures.js';

const R = (a, b) => a + (b - a) * rand();
const RI = (a, b) => Math.floor(R(a, b + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

export const BLOCK = 52, STREET = 20, SPACING = 72, LIMIT = 110;

const PLASTER_TINTS = [0xd9c9a3, 0xc8c2b4, 0xb9b7a0, 0xd4b896, 0xa9a89c, 0xc9b9a8, 0xbfae8c, 0xd8d0bf, 0x9fa596];

export function makeMaterials(T) {
  const std = (o) => new THREE.MeshStandardMaterial(o);
  const M = {
    plaster: std({ map: T.plaster.map, normalMap: T.plaster.normalMap, vertexColors: true, roughness: 0.95 }),
    brick: std({ map: T.brick.map, normalMap: T.brick.normalMap, roughness: 0.92 }),
    stone: std({ map: T.stone.map, normalMap: T.stone.normalMap, vertexColors: true, roughness: 0.9 }),
    concrete: std({ map: T.concrete.map, normalMap: T.concrete.normalMap, vertexColors: true, roughness: 0.95 }),
    interior: std({ map: T.interior.map, side: THREE.BackSide, roughness: 1, color: 0x8a8070 }),
    wood: std({ map: T.wood.map, vertexColors: true, roughness: 0.85 }),
    roof: std({ map: T.roof.map, normalMap: T.roof.normalMap, roughness: 0.8, side: THREE.DoubleSide }),
    asphalt: std({ map: T.asphalt.map, normalMap: T.asphalt.normalMap, roughness: 0.93 }),
    pavers: std({ map: T.pavers.map, normalMap: T.pavers.normalMap, vertexColors: true, roughness: 0.9 }),
    rust: std({ map: T.rust.map, normalMap: T.rust.normalMap, roughness: 0.85, metalness: 0.35 }),
    metal: std({ color: 0x2a2b2c, roughness: 0.55, metalness: 0.7, vertexColors: true }),
    sandbag: std({ map: T.sandbag.map, roughness: 1, color: 0x8f8670 }),
    awning: std({ map: T.awning.map, roughness: 1, side: THREE.DoubleSide, vertexColors: true }),
    rubble: std({ map: T.rubble.map, normalMap: T.rubble.normalMap, roughness: 1, vertexColors: true }),
    sign: std({ map: T.signs.map, roughness: 0.8 }),
    poster: std({ map: T.posters.map, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2 }),
    soot: std({ map: T.soot.map, transparent: true, depthWrite: false, roughness: 1, color: 0x000000,
      polygonOffset: true, polygonOffsetFactor: -4 }),
    glass: std({ color: 0x1a2024, roughness: 0.08, metalness: 0.6, transparent: true, opacity: 0.75 }),
    bark: std({ color: 0x2a2420, roughness: 1, vertexColors: true }),
  };
  M.soot.userData.noShadow = true;
  M.poster.userData.noShadow = true;
  M.glass.userData.noShadow = true;
  return M;
}

// ---------------------------------------------------------------------------
// 建物
// ---------------------------------------------------------------------------

class Ctx {
  constructor(B, world) { this.B = B; this.world = world; this.M = new THREE.Matrix4(); }
}

const _mb = new THREE.Matrix4(), _ml = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _p = new THREE.Vector3(), _s1 = new THREE.Vector3(1, 1, 1);

// 回転（90°単位）付きの局所座標系
class Frame {
  constructor(parent, x, z, rot) {
    this.m = new THREE.Matrix4().makeRotationY(rot).setPosition(x, 0, z);
    if (parent) this.m.premultiply(parent.m);
  }
  child(x, z, rot) {
    const f = new Frame(null, x, z, rot);
    f.m.premultiply(this.m);
    return f;
  }
  pt(x, y, z) { return new THREE.Vector3(x, y, z).applyMatrix4(this.m); }
  // 局所ボックス → ワールド行列
  boxMatrix(cx, cy, cz, rx = 0, ry = 0, rz = 0) {
    _e.set(rx, ry, rz); _q.setFromEuler(_e);
    _ml.compose(_p.set(cx, cy, cz), _q, _s1);
    return _mb.multiplyMatrices(this.m, _ml);
  }
  aabb(cx, cy, cz, sx, sy, sz) {
    const a = this.pt(cx - sx / 2, cy - sy / 2, cz - sz / 2), b = this.pt(cx + sx / 2, cy + sy / 2, cz + sz / 2);
    return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)];
  }
}

function box(B, F, key, cx, cy, cz, sx, sy, sz, o = {}) {
  B.boxM(key, F.boxMatrix(cx, cy, cz, o.rx, o.ry, o.rz), sx, sy, sz, o.color ?? 0xffffff, o.uv ?? 2, undefined, o.faces ?? 63);
}

// 崩れた縁：不規則な小片
function jagged(B, F, key, u0, u1, y, n0, color, count = 6) {
  for (let i = 0; i < count; i++) {
    const w = R(0.25, 0.8), h = R(0.15, 0.7);
    box(B, F, key, R(u0, u1), y + h / 2 - 0.05, n0 + R(-0.04, 0.04), w, h, R(0.25, 0.42), { color, rz: R(-0.4, 0.4), ry: R(0.06, 0.25) * (rand() < 0.5 ? -1 : 1) });
  }
}

/**
 * ファサード（壁面）を生成する。座標系：u=壁に沿う方向, y=高さ, n=外向き法線（壁は n∈[-t,0]）
 * spec: { L, floors(各ベイの階数), gh, fh, key, color, base, detail, shop, dmgCells, collide, world, t }
 */
function facade(B, F, spec) {
  const { L, gh, fh, key, color, detail, t = 0.42 } = spec;
  const nb = Math.max(1, Math.round(L / (detail === 0 ? 3.6 : 3.1)));
  const bw = L / nb;
  const floorsAt = spec.floors.length ? spec.floors : [1];   // ベイごとの残存階数
  const maxF = Math.max(...floorsAt);
  const yOf = (f) => (f === 0 ? 0 : gh + (f - 1) * fh);
  const hOf = (f) => (f === 0 ? gh : fh);
  const col = (cx, cy, cz, sx, sy, sz, keyOverride, opts = {}) => {
    const k = keyOverride || key;
    box(B, F, k, cx, cy, cz, sx, sy, sz, { color: k === key ? color : opts.color, uv: opts.uv, faces: opts.faces, rx: opts.rx, ry: opts.ry, rz: opts.rz });
    if (spec.collide && opts.solid !== false) {
      const a = F.aabb(cx, cy, cz, sx, sy, sz);
      spec.world.add(a[0], a[1], a[2], a[3], a[4], a[5], 'wall');
    }
  };
  const wallKey = (f) => (f === 0 && spec.base ? spec.base : key);
  const wallCol = (f) => (f === 0 && spec.base ? spec.baseColor : color);

  for (let i = 0; i < nb; i++) {
    const u0 = i * bw, u1 = u0 + bw, uc = (u0 + u1) / 2;
    const top = floorsAt[Math.min(i, floorsAt.length - 1)] ?? 1;
    for (let f = 0; f < top; f++) {
      const y0 = yOf(f), h = hOf(f);
      const k = wallKey(f), c = wallCol(f);
      const cell = spec.dmgCells && spec.dmgCells.has(i + ',' + f);
      if (cell) {
        // 砲弾で抜けた穴：外周に残骸
        const keep = R(0.15, 0.3) * bw;
        box(B, F, k, u0 + keep / 2, y0 + h / 2, -t / 2, keep, h, t, { color: c });
        box(B, F, k, u1 - keep / 2, y0 + h * 0.35, -t / 2, keep, h * 0.7, t, { color: c });
        jagged(B, F, k, u0 + keep, u1 - keep, y0, -t / 2, c, 4);
        jagged(B, F, k, u0 + keep, u1 - keep, y0 + h - 0.6, -t / 2, c, 3);
        if (spec.collide) { const a = F.aabb(uc, y0 + h / 2, -t / 2, bw, h, t); void a; }
        continue;
      }
      // 開口の決定
      let ow, oh, sill, kind = 'win';
      if (f === 0 && spec.shop) {
        kind = (i % 3 === 1 || nb === 1) ? 'door' : 'shop';
        ow = kind === 'door' ? 1.3 : Math.min(bw - 0.9, 2.6); oh = kind === 'door' ? 2.6 : 2.7; sill = kind === 'door' ? 0 : 0.45;
      } else if (f === 0) {
        kind = (spec.door === i) ? 'door' : 'win';
        ow = kind === 'door' ? 1.3 : Math.min(1.25, bw * 0.45); oh = kind === 'door' ? 2.6 : 2.0; sill = kind === 'door' ? 0 : 1.1;
      } else {
        ow = Math.min(1.25, bw * 0.45); oh = Math.min(2.0, h - 1.15); sill = 0.85;
      }
      if (detail === 0) { ow = Math.min(1.1, bw * 0.4); }
      const wl = uc - ow / 2, wr = uc + ow / 2;
      const yS = y0 + sill, yT = y0 + sill + oh;
      // 壁パーツ（窓の左右・下・上）
      col((u0 + wl) / 2, y0 + h / 2, -t / 2, wl - u0, h, t, k, { color: c });
      col((wr + u1) / 2, y0 + h / 2, -t / 2, u1 - wr, h, t, k, { color: c });
      if (sill > 0.01) col(uc, y0 + sill / 2, -t / 2, ow, sill, t, k, { color: c });
      col(uc, (yT + y0 + h) / 2, -t / 2, ow, y0 + h - yT, t, k, { color: c });
      if (detail === 0) continue;
      // 窓まわりのディテール
      const fk = 'wood', fc = pick([0x6b5a46, 0x4b4036, 0x5d6450, 0x3f3a33, 0x7a6e5c]);
      if (kind === 'win' || kind === 'shop') {
        // 枠（開口内側に奥まって）
        box(B, F, fk, wl + 0.04, (yS + yT) / 2, -0.16, 0.08, oh, 0.1, { color: fc });
        box(B, F, fk, wr - 0.04, (yS + yT) / 2, -0.16, 0.08, oh, 0.1, { color: fc });
        box(B, F, fk, uc, yT - 0.04, -0.165, ow - 0.16, 0.08, 0.09, { color: fc });
        box(B, F, fk, uc, yS + 0.04, -0.165, ow - 0.16, 0.08, 0.09, { color: fc });
        if (kind === 'win') {
          box(B, F, fk, uc, (yS + yT) / 2, -0.17, 0.05, oh - 0.16, 0.06, { color: fc });     // 縦桟
          box(B, F, fk, uc, yS + oh * 0.68, -0.175, ow - 0.16, 0.05, 0.045, { color: fc });  // 横桟
          // 窓台
          box(B, F, 'stone', uc, yS - 0.04, 0.085, ow + 0.24, 0.1, 0.17, { color: 0xd0cabd });   // 壁面より手前・1cm 高く
          // まぐさ・ペディメント
          const st = spec.winStyle;
          if (st === 1) box(B, F, key, uc, yT + 0.12, 0.05, ow + 0.4, 0.24, 0.12, { color: shade(color, 1.08) });
          else if (st === 2) {
            box(B, F, key, uc, yT + 0.1, 0.07, ow + 0.5, 0.12, 0.16, { color: shade(color, 1.1) });
            box(B, F, key, uc - ow * 0.28, yT + 0.3, 0.07, ow * 0.62, 0.1, 0.14, { color: shade(color, 1.1), rz: 0.32 });
            box(B, F, key, uc + ow * 0.28, yT + 0.3, 0.064, ow * 0.62, 0.1, 0.132, { color: shade(color, 1.1), rz: -0.32 });
          } else if (st === 3) {
            box(B, F, 'stone', uc, yT + 0.165, 0.045, 0.26, 0.32, 0.1, { color: 0xd8d2c6 });  // 要石
            box(B, F, key, uc, yT + 0.06, 0.03, ow + 0.3, 0.12, 0.08, { color: shade(color, 1.06) });
          }
          // 窓周りの縁取り
          box(B, F, key, wl - 0.08, (yS + yT) / 2, 0.02, 0.16, oh, 0.06, { color: shade(color, 1.07) });
          box(B, F, key, wr + 0.08, (yS + yT) / 2, 0.02, 0.16, oh, 0.06, { color: shade(color, 1.07) });
          // 鎧戸（傾いたもの・片方だけのものも）
          if (spec.shutters && rand() < 0.65) {
            for (const s of [-1, 1]) {
              if (rand() < 0.25) continue;
              const ang = rand() < 0.2 ? R(0.3, 1.2) : 0;
              const sx = s < 0 ? wl - 0.28 - 0.08 : wr + 0.28 + 0.08;
              box(B, F, 'wood', sx, (yS + yT) / 2 - (ang ? 0.15 : 0), 0.06, 0.52, oh * (ang ? 0.9 : 1), 0.04,
                { color: spec.shutterColor, rz: ang * s * 0.3, ry: ang * s * 0.6 });
            }
          }
          // ガラス（残っているもの）
          if (rand() < 0.18) box(B, F, 'glass', uc, (yS + yT) / 2, -0.17, ow - 0.12, oh - 0.12, 0.01, {});
          // 煤（焼けた窓）
          if (spec.soot && rand() < spec.soot) {
            const c0 = F.pt(uc - ow * 0.9, yT - 0.2, 0.03), c1 = F.pt(uc + ow * 0.9, yT - 0.2, 0.03);
            const c2 = F.pt(uc + ow * 0.9, yT + 1.6, 0.03), c3 = F.pt(uc - ow * 0.9, yT + 1.6, 0.03);
            B.quad('soot', [c0, c1, c2, c3], [[0, 0.45], [1, 0.45], [1, 1], [0, 1]]);
          }
        } else {
          // ショーウィンドウ：看板・日除け
          box(B, F, fk, uc, (yS + yT) / 2, -0.17, 0.06, oh - 0.16, 0.07, { color: fc });
        }
      }
      if (kind === 'door') {
        box(B, F, key, uc, yT + 0.1, 0.04, ow + 0.4, 0.2, 0.1, { color: shade(color, 1.08) });
        if (rand() < 0.6) {
          const open = rand() < 0.5 ? R(0.5, 1.4) : 0;
          box(B, F, 'wood', wl + 0.32 * Math.cos(open) + 0.02, yS + oh / 2, -0.3 + 0.3 * Math.sin(open) - 0.05, 0.62, oh - 0.04, 0.06,
            { color: 0x4b3a2a, ry: -open });
        }
      }
    }
    // 上部崩落の縁
    if (top < maxF || spec.ruinTop) {
      const y = yOf(top);
      jagged(B, F, wallKey(top), u0, u1, y, -t / 2, wallCol(top), 5);
    }
  }
  // 1 階上部の看板帯・日除け
  if (spec.shop && detail > 0 && floorsAt.some((x) => x > 0)) {
    const si = Math.floor(rand() * 16);
    const sx = (si % 4) / 4, sy = 1 - (Math.floor(si / 4) + 0.25) / 4;
    const y0 = gh - 0.75, y1 = gh - 0.2;
    const uL = 0.5, uR = Math.min(L - 0.5, uL + Math.min(7, L * 0.7));
    box(B, F, 'wood', (uL + uR) / 2, (y0 + y1) / 2, 0.06, uR - uL + 0.2, y1 - y0 + 0.14, 0.1, { color: 0x2c2620 });
    B.quad('sign', [F.pt(uL, y0, 0.12), F.pt(uR, y0, 0.12), F.pt(uR, y1, 0.12), F.pt(uL, y1, 0.12)],
      [[sx, sy - 0.0625], [sx + 0.25, sy - 0.0625], [sx + 0.25, sy], [sx, sy]]);
    if (rand() < 0.6) {
      const torn = rand() < 0.5;
      const aw = Math.min(L - 1, R(3, 6)), ac = R(aw / 2 + 0.3, L - aw / 2 - 0.3);
      box(B, F, 'awning', ac, gh - 1.1, 0.75, aw, 0.03, 1.5, { rx: 0.42 + (torn ? 0.3 : 0), color: pick([0xffffff, 0xb0c0a0, 0xc0a080]) });
      box(B, F, 'metal', ac, gh - 0.85, 0.05, aw, 0.05, 0.05, {});
    }
  }
  // 蛇腹（階ごとの帯）とメインコーニス（隣の建物と接する側面には付けない）
  if (detail > 0 && spec.trim !== false) {
    for (let f = 1; f <= maxF; f++) {
      const y = yOf(f);
      let segs = [];
      for (let i = 0; i < nb; i++) if (floorsAt[i] >= f) segs.push(i);
      if (!segs.length) continue;
      // 連続区間ごと
      let s0 = segs[0], prev = segs[0];
      const flush = (a, b) => {
        const uu0 = a * bw, uu1 = (b + 1) * bw;
        const isTop = f === maxF && floorsAt[a] === maxF;
        const yo = spec.trimOff || 0;          // 角で正面の軒と重ならないよう側面は少しずらす
        if (isTop && spec.cornice) {
          box(B, F, key, (uu0 + uu1) / 2, y - 0.205 + yo, 0.2 + yo, uu1 - uu0 - 0.006, 0.39, 0.4, { color: shade(color, 1.1) });
          box(B, F, key, (uu0 + uu1) / 2, y + 0.02 + yo, 0.32 + yo, uu1 - uu0 - 0.012, 0.12, 0.75, { color: shade(color, 1.12) });
          for (let u = uu0 + 0.4; u < uu1 - 0.2; u += 0.75) box(B, F, key, u, y - 0.55, 0.15, 0.12, 0.3, 0.3, { color: shade(color, 1.05) });
        } else {
          box(B, F, key, (uu0 + uu1) / 2, y + 0.05 + yo, 0.06 + yo, uu1 - uu0 - 0.006, 0.18, 0.14, { color: shade(color, 1.08) });
        }
      };
      for (const i of segs.slice(1)) { if (i !== prev + 1) { flush(s0, prev); s0 = i; } prev = i; }
      flush(s0, prev);
    }
    // 基壇
    box(B, F, 'stone', L / 2, 0.3, 0.05, L - 0.006, 0.6, 0.12, { color: 0xb8b2a4 });
  }
  // 戦時ポスター
  if (detail > 0 && spec.trim !== false && rand() < 0.5) {
    const pu = R(0.6, L - 1.4), py = R(1.2, 1.7), pi = Math.floor(rand() * 4);
    const ox = (pi % 2) / 2, oy = 1 - Math.floor(pi / 2) / 2;
    B.quad('poster', [F.pt(pu, py, 0.03), F.pt(pu + 0.62, py, 0.03), F.pt(pu + 0.62, py + 0.62, 0.03), F.pt(pu, py + 0.62, 0.03)],
      [[ox, oy - 0.5], [ox + 0.5, oy - 0.5], [ox + 0.5, oy], [ox, oy]]);
  }
  return { nb, bw };
}

function shade(hex, k) {
  const c = new THREE.Color(hex);
  c.r = Math.min(1, c.r * k); c.g = Math.min(1, c.g * k); c.b = Math.min(1, c.b * k);
  return c.getHex();
}

// 単純な無窓の壁（隣接側面など）
function plainWall(B, F, L, H, key, color, t = 0.42) {
  box(B, F, key, L / 2, H / 2, -t / 2, L, H, t, { color, faces: 63 & ~8 });
}

/**
 * 1 棟の建物。F は facade の左下角が原点、+z が通り側、建物は -z 方向に奥行き dp
 * opts: { w, dp, floors, dmg, shop, cornerLeft, cornerRight, backdrop, enterable }
 */
export function building(ctx, F, o) {
  const { B, world } = ctx;
  const { w, dp } = o;
  const gh = 4.0, fh = 3.3;
  const nf = o.floors;
  const usesBrick = rand() < 0.28;
  const key = usesBrick ? 'brick' : 'plaster';
  const color = usesBrick ? 0xffffff : pick(PLASTER_TINTS);
  const base = !usesBrick && rand() < 0.55 ? 'stone' : null;
  const detail = o.backdrop ? 0 : 1;
  const dmg = o.dmg;
  const H = gh + (nf - 1) * fh;
  const nbGuess = Math.max(1, Math.round(w / (detail === 0 ? 3.6 : 3.1)));

  // 損傷：ベイごとの残存階数
  const floors = new Array(nbGuess).fill(nf);
  if (dmg >= 2) {
    const side = rand() < 0.5 ? 0 : nbGuess - 1;
    const span = RI(1, Math.max(1, Math.ceil(nbGuess * 0.6)));
    for (let k = 0; k < span; k++) {
      const i = side === 0 ? k : nbGuess - 1 - k;
      floors[i] = Math.max(1, nf - RI(1, Math.max(1, nf - 1)) + (k > 0 ? 0 : -0));
    }
    for (let i = 1; i < nbGuess; i++) if (Math.abs(floors[i] - floors[i - 1]) > 2) floors[i] = floors[i - 1] + Math.sign(floors[i] - floors[i - 1]) * 2;
  }
  if (dmg >= 3) for (let i = 0; i < nbGuess; i++) floors[i] = Math.max(1, Math.min(floors[i], RI(1, 2)));
  const dmgCells = new Set();
  const holes = dmg === 0 ? (rand() < 0.3 ? 1 : 0) : dmg === 1 ? RI(1, 3) : RI(2, 4);
  for (let h = 0; h < holes; h++) {
    const i = RI(0, nbGuess - 1), f = RI(dmg >= 3 ? 0 : 1, Math.max(0, floors[i] - 1));
    dmgCells.add(i + ',' + f);
  }
  const spec = {
    L: w, gh, fh, key, color, base, baseColor: 0xd0c8b8, detail, floors, dmgCells,
    shop: o.shop, door: o.shop ? -1 : Math.floor(nbGuess / 2), winStyle: RI(0, 3), shutters: rand() < 0.6,
    shutterColor: pick([0x4f5a3f, 0x5a4636, 0x3e4a52, 0x6b6a5a]), soot: dmg >= 1 ? 0.35 : 0.12, cornice: true,
    collide: o.enterable, world, ruinTop: dmg >= 3,
  };
  facade(B, F, spec);
  const maxH = (() => { const mf = Math.max(...floors); return gh + (mf - 1) * fh; })();
  // 背面・側面
  const back = F.child(w, -dp, Math.PI);
  const t0 = 0.42;
  const left = F.child(0, -dp + t0, -Math.PI / 2);
  const right = F.child(w, -t0, Math.PI / 2);
  const sideL = dp - 2 * t0;
  const sideSpec = (L, exposed, sideFloors) => ({
    ...spec, L, shop: false, door: -1, floors: sideFloors, dmgCells: new Set(), detail: exposed ? detail : 0,
    soot: spec.soot * 0.5, trim: exposed, trimOff: 0.013,
  });
  const avgF = Math.round(floors.reduce((a, b) => a + b, 0) / floors.length);
  const exposedBack = o.enterable || o.exposedBack;
  if (exposedBack) facade(B, back, sideSpec(w, false, new Array(Math.max(1, Math.round(w / 3.6))).fill(Math.min(avgF, nf))));
  else plainWall(B, back, w, maxH, key, color);
  for (const [fr, exposed, first] of [[left, o.cornerLeft, true], [right, o.cornerRight, false]]) {
    if (exposed || o.enterable) {
      const n = Math.max(1, Math.round(sideL / (exposed ? 3.1 : 3.6)));
      const sf = new Array(n).fill(0).map((_, i) => {
        const fi = first ? floors[0] : floors[floors.length - 1];
        return Math.max(1, fi - (dmg >= 2 && i > n / 2 ? RI(0, 1) : 0));
      });
      facade(B, fr, { ...sideSpec(sideL, exposed, sf), shop: exposed && o.shop, detail: exposed ? detail : (o.enterable ? 1 : 0) });
    } else {
      plainWall(B, fr, sideL, first ? gh + (floors[0] - 1) * fh : gh + (floors[floors.length - 1] - 1) * fh, key, color);
    }
  }
  // 屋内：暗い内壁（BackSide）と床スラブ
  const t = 0.42;
  if (!o.enterable) {
    box(B, F, 'interior', w / 2, maxH / 2, -dp / 2, w - 2 * t - 0.02, maxH - 0.02, dp - 2 * t - 0.02, { uv: 3 });
  }
  for (let f = 1; f < Math.max(...floors) + (dmg >= 3 ? 0 : 0); f++) {
    const y = gh + (f - 1) * fh;
    if (dmg >= 2 && rand() < 0.4) {
      // 崩れた床：斜めに垂れ下がる
      box(B, F, 'concrete', w * 0.3, y - 0.8, -dp * 0.5, w * 0.5, 0.22, dp * 0.6, { color: 0xb0aca4, rz: 0.5 });
      box(B, F, 'concrete', w * 0.75, y, -dp / 2, w * 0.5 - t, 0.25, dp - 2 * t, { color: 0xb0aca4 });
    } else {
      box(B, F, 'concrete', w / 2, y, -dp / 2, w - 2 * t, 0.25, dp - 2 * t, { color: 0xb0aca4 });
    }
  }
  // 屋根
  if (dmg < 3) roof(ctx, F, w, dp, maxH, floors.every((x) => x === nf) ? 0 : 1, key, color, dmg);
  // 被害：基部の瓦礫
  if (dmg >= 2) {
    rubblePile(ctx, F.pt(R(1, w - 1), 0, R(1.2, 3)), R(1.6, 3.2), R(0.8, 1.8));
  }
  if (dmg >= 1 && rand() < 0.5) rubblePile(ctx, F.pt(R(0.5, w - 0.5), 0, R(0.6, 1.5)), R(0.8, 1.4), R(0.3, 0.6));

  // 当たり判定
  if (!o.enterable) {
    const a = F.aabb(w / 2, maxH / 2, -dp / 2, w, maxH, dp);
    world.add(a[0], 0, a[2], a[3], maxH + 1.5, a[5], 'building');
  } else {
    // 中に瓦礫・梁
    const n = RI(1, 3);
    for (let k = 0; k < n; k++) rubblePile(ctx, F.pt(R(2, w - 2), 0, -R(2, dp - 2)), R(1.2, 2.6), R(0.5, 1.4));
    for (let k = 0; k < 3; k++) box(B, F, 'wood', R(1, w - 1), R(0.3, 1.2), -R(1.5, dp - 1.5), R(2, 4), 0.2, 0.22,
      { rz: R(-0.5, 0.5), ry: R(0, 3), color: 0x3a2e24 });
    // 床（屋内のコンクリート）
    box(B, F, 'concrete', w / 2, 0.03, -dp / 2, w - 0.8, 0.06, dp - 0.8, { color: 0x8a867e });
  }
  return { maxH };
}

// 妻壁：三角柱（x から x+0.42 の厚み、底辺は奥行き全体）
function gable(B, F, key, x, H, dp, rise, color) {
  const sh = new THREE.Shape();
  sh.moveTo(0, 0); sh.lineTo(dp, 0); sh.lineTo(dp / 2, rise); sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: 0.42, bevelEnabled: false });
  // 形状 X → 局所 -z、形状 Y → y、押し出し Z → +x
  const m = new THREE.Matrix4().set(0, 0, 1, x, 0, 1, 0, H, -1, 0, 0, 0, 0, 0, 0, 1);
  B.geom(key, g, new THREE.Matrix4().multiplyMatrices(F.m, m), color, 0.5);
}

function roof(ctx, F, w, dp, H, broken, key, color, dmg) {
  const { B } = ctx;
  const pitched = rand() < 0.5 && !broken;
  if (!pitched) {
    box(B, F, 'concrete', w / 2, H + 0.04, -dp / 2, w - 0.84, 0.1, dp - 0.84, { color: 0x77736b });
    // パラペット（前後は全幅、左右は前後の間だけ）
    for (const [cx, cz, sx, sz, cap] of [[w / 2, -0.21, w, 0.42, 1], [w / 2, -dp + 0.21, w, 0.42, 1],
      [0.21, -dp / 2, 0.42, dp - 0.84, 0], [w - 0.21, -dp / 2, 0.42, dp - 0.84, 0]]) {
      box(B, F, key, cx, H + 0.5, cz, sx, 1.0, sz, { color });
      box(B, F, 'stone', cx, H + 1.04 + (cap ? 0.005 : 0), cz, sx + 0.08, 0.08, cap ? sz + 0.08 : sz - 0.08, { color: 0xb8b2a6 });
    }
    if (rand() < 0.5) box(B, F, 'concrete', R(1.5, w - 1.5), H + 1.2, -R(2, dp - 2), R(1.5, 2.5), 2.2, R(1.5, 2.5), { color: 0x8a857c });
  } else {
    const ridge = dp / 2, pitch = 0.62;
    const rise = ridge * Math.tan(pitch);
    const slant = ridge / Math.cos(pitch);
    const holes = dmg >= 1 ? RI(0, 2) : 0;
    for (const s of [1, -1]) {
      const cz = s > 0 ? -ridge / 2 : -dp + ridge / 2;
      const missing = holes > 0 && rand() < 0.5;
      if (!missing) box(B, F, 'roof', w / 2, H + rise / 2 + (s > 0 ? 0 : 0.004), cz, w + 0.6 - (s > 0 ? 0 : 0.03), 0.08, slant + 0.4, { rx: s * pitch, uv: 2 });
      else {
        // 抜けた屋根：垂木だけ残る
        box(B, F, 'roof', w * 0.25, H + rise / 2, cz, w * 0.5 + 0.3, 0.08, slant + 0.4, { rx: s * pitch });
        for (let x = w * 0.55; x < w; x += 0.7) box(B, F, 'wood', x, H + rise / 2, cz, 0.1, 0.14, slant, { rx: s * pitch, color: 0x2c2218 });
      }
    }
    // 妻壁（三角）
    for (const x of [0, w - 0.42]) gable(B, F, key, x, H, dp, rise, color);
    // 煙突
    const nch = RI(1, 2);
    for (let k = 0; k < nch; k++) {
      const cx = R(1, w - 1);
      box(B, F, 'brick', cx, H + rise * 0.8, -ridge + R(-1, 1), 0.7, rise * 0.9 + 1.2, 0.7, {});
      box(B, F, 'stone', cx, H + rise * 1.25 + 0.65, -ridge, 0.85, 0.12, 0.85, { color: 0x9a9488 });
    }
  }
}

// ---------------------------------------------------------------------------
// 瓦礫・小物
// ---------------------------------------------------------------------------

const _sph = new THREE.SphereGeometry(1, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
function moundGeom(r, h) {
  const g = _sph.clone();
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = 0.8 + 0.4 * rand();
    p.setXYZ(i, x * r * n, Math.max(0, y) * h * (0.75 + 0.5 * rand()), z * r * n);
  }
  g.computeVertexNormals();
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, p.getX(i) / 2, p.getZ(i) / 2);
  return g;
}

export function rubblePile(ctx, pos, r, h) {
  const { B, world } = ctx;
  const m = new THREE.Matrix4().makeTranslation(pos.x, 0, pos.z);
  B.geom('rubble', moundGeom(r, h), m, pick([0xffffff, 0xe8e0d0, 0xd8c8b8]));
  const n = Math.floor(r * 9);
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2, d = rand() * r * 1.1;
    const s = R(0.12, 0.55);
    const k = pick(['brick', 'plaster', 'concrete', 'stone']);
    B.box(k, pos.x + Math.cos(a) * d, Math.max(0.05, h * (1 - d / r) * 0.8) + s * 0.2, pos.z + Math.sin(a) * d,
      s * R(1, 2.2), s * R(0.4, 0.9), s * R(0.8, 1.6),
      { rx: R(-0.6, 0.6), ry: R(0, 3), rz: R(-0.6, 0.6), color: k === 'plaster' ? pick(PLASTER_TINTS) : 0xcfcac0 });
  }
  if (rand() < 0.6) B.box('wood', pos.x + R(-r, r) * 0.5, h * 0.6, pos.z + R(-r, r) * 0.5, 0.18, 0.18, R(2, 3.5),
    { rx: R(-0.5, 0.5), ry: R(0, 3), color: 0x3b2f24 });
  if (rand() < 0.5) for (let k = 0; k < 3; k++) B.box('metal', pos.x + R(-r, r) * 0.4, h * 0.7, pos.z + R(-r, r) * 0.4, 0.03, 1.4, 0.03,
    { rx: R(-0.9, 0.9), rz: R(-0.9, 0.9), color: 0x5a3a2a });           // 鉄筋
  // 段々の当たり判定（登れる）
  const steps = Math.max(1, Math.ceil(h / 0.42));
  for (let k = 1; k <= steps; k++) {
    const hh = Math.min(h, k * 0.42) * 0.85, rr = r * (1 - (k - 0.5) / (steps + 0.6)) * 0.85;
    world.add(pos.x - rr, 0, pos.z - rr, pos.x + rr, hh, pos.z + rr, 'rubble');
  }
}

function car(ctx, x, z, rot, burnt = true) {
  const { B, world } = ctx;
  const F = new Frame(null, x, z, rot);
  const k = burnt ? 'rust' : 'metal';
  box(B, F, k, 0, 0.62, 0, 1.75, 0.65, 4.3, { uv: 1 });
  box(B, F, k, 0, 1.18, 0.2, 1.6, 0.5, 2.2, { uv: 1, color: 0xffffff });
  box(B, F, k, 0, 0.7, 2.0, 1.6, 0.4, 0.5, { uv: 1 });                // フロント
  box(B, F, 'metal', 0, 0.4, 2.2, 1.7, 0.18, 0.12, { color: 0x333333 });
  // 窓（枠だけ、ガラスなし）
  box(B, F, k, 0.78, 1.18, 0.2, 0.06, 0.48, 0.12, {}); box(B, F, k, -0.78, 1.18, 0.2, 0.06, 0.48, 0.12, {});
  for (const [wx, wz] of [[0.82, 1.35], [-0.82, 1.35], [0.82, -1.35], [-0.82, -1.35]]) {
    if (rand() < 0.3) continue;
    const g = new THREE.CylinderGeometry(0.34, 0.34, 0.22, 14);
    const m = F.boxMatrix(wx, 0.34, wz, 0, 0, Math.PI / 2).clone();
    B.geom('metal', g, m, 0x1a1a1a);
  }
  const a = F.aabb(0, 0.8, 0, 1.8, 1.6, 4.4);
  world.add(a[0], 0, a[2], a[3], 1.45, a[5], 'car');
}

function tank(ctx, x, z, rot) {
  const { B, world } = ctx;
  const F = new Frame(null, x, z, rot);
  box(B, F, 'rust', 0, 0.9, 0, 3.0, 1.0, 6.4, { uv: 1.5 });
  box(B, F, 'rust', 0, 1.55, 0.2, 2.6, 0.35, 4.6, { uv: 1.5 });
  for (const s of [-1, 1]) {
    box(B, F, 'metal', s * 1.55, 0.55, 0, 0.6, 1.0, 6.6, { color: 0x2a2826 });
    for (let k = -2.6; k <= 2.6; k += 0.65) {
      const g = new THREE.CylinderGeometry(0.36, 0.36, 0.5, 12);
      B.geom('metal', g, F.boxMatrix(s * 1.55, 0.45, k, 0, 0, Math.PI / 2).clone(), 0x222222);
    }
  }
  // 砲塔（ずれて傾いている）
  box(B, F, 'rust', 0.2, 2.15, -0.3, 2.2, 0.85, 2.6, { ry: 0.5, rz: 0.08, uv: 1.5 });
  const g = new THREE.CylinderGeometry(0.1, 0.12, 4.2, 10);
  B.geom('metal', g, F.boxMatrix(1.0, 2.0, 1.8, Math.PI / 2 - 0.12, 0, 0.5).clone(), 0x2c2b29);
  const a = F.aabb(0, 1.2, 0, 3.6, 2.4, 6.8);
  world.add(a[0], 0, a[2], a[3], 2.4, a[5], 'tank');
}

function hedgehog(ctx, x, z) {
  const { B, world } = ctx;
  const ry = R(0, 3);
  for (const [rx, rz] of [[0.62, 0], [-0.62, 0], [0, 0.62]]) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, 0.75, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry + (rz ? 1.57 : 0), rz ? 0.62 : 0)), new THREE.Vector3(1, 1, 1));
    B.boxM('metal', m, 0.16, 2.1, 0.16, 0x4a3a30, 1);
  }
  world.add(x - 0.7, 0, z - 0.7, x + 0.7, 1.3, z + 0.7, 'obstacle');
}

function sandbags(ctx, x, z, rot, len, rows = 3) {
  const { B, world } = ctx;
  const F = new Frame(null, x, z, rot);
  const g = new THREE.SphereGeometry(1, 10, 6);
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * 0.3;
    for (let u = -len / 2 + 0.3 + off; u < len / 2 - 0.2; u += 0.6) {
      const m = F.boxMatrix(u, 0.14 + r * 0.24, 0, 0, R(-0.08, 0.08), 0).clone()
        .multiply(new THREE.Matrix4().makeScale(0.33, 0.13, 0.22));
      B.geom('sandbag', g, m, 0xffffff);
    }
  }
  const a = F.aabb(0, rows * 0.12, 0, len, rows * 0.24 + 0.1, 0.5);
  world.add(a[0], 0, a[2], a[3], rows * 0.24 + 0.05, a[5], 'cover');
}

function lamp(ctx, x, z, rot, bent) {
  const { B, world } = ctx;
  const F = new Frame(null, x, z, rot);
  const tilt = bent ? R(0.3, 0.9) : 0;
  const pole = new THREE.CylinderGeometry(0.07, 0.1, 5, 8);
  B.geom('metal', pole, F.boxMatrix(0, 2.5 * Math.cos(tilt), 2.5 * Math.sin(tilt), tilt, 0, 0).clone(), 0x2b2d2c);
  if (!bent) {
    box(B, F, 'metal', 0, 4.95, 0.45, 0.06, 0.06, 0.9, { color: 0x2b2d2c });
    box(B, F, 'metal', 0, 4.8, 0.9, 0.35, 0.25, 0.35, { color: 0x2b2d2c });
  }
  world.add(x - 0.12, 0, z - 0.12, x + 0.12, 4, z + 0.12, 'pole');
}

function tree(ctx, x, z) {
  const { B, world } = ctx;
  const h = R(4, 7);
  const g = new THREE.CylinderGeometry(0.14, 0.26, h, 8);
  B.geom('bark', g, new THREE.Matrix4().makeTranslation(x, h / 2, z), 0xffffff);
  for (let k = 0; k < 6; k++) {
    const l = R(1, 2.6);
    const gb = new THREE.CylinderGeometry(0.03, 0.08, l, 5);
    const ang = R(0, 6.28), up = R(0.5, 1.1);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x + Math.cos(ang) * l * 0.35 * Math.sin(up), h * R(0.55, 0.95) + l * 0.3, z + Math.sin(ang) * l * 0.35 * Math.sin(up)),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.sin(ang) * up, 0, -Math.cos(ang) * up)), new THREE.Vector3(1, 1, 1));
    B.geom('bark', gb, m, 0xffffff);
  }
  world.add(x - 0.25, 0, z - 0.25, x + 0.25, h, z + 0.25, 'tree');
}

function crater(ctx, x, z, r) {
  const { B } = ctx;
  // 縁の盛り上がり（リング状の小さな瓦礫）と中央の暗いデカール
  const c = [new THREE.Vector3(x - r, 0.03, z + r), new THREE.Vector3(x + r, 0.03, z + r),
    new THREE.Vector3(x + r, 0.03, z - r), new THREE.Vector3(x - r, 0.03, z - r)];
  B.quad('soot', c, [[0, 0], [1, 0], [1, 1], [0, 1]]);
  for (let i = 0; i < 26; i++) {
    const a = rand() * 6.28, d = r * R(0.75, 1.05), s = R(0.15, 0.45);
    B.box(pick(['asphalt', 'concrete']), x + Math.cos(a) * d, s * 0.25, z + Math.sin(a) * d, s * 1.5, s * 0.5, s,
      { ry: a, rx: R(-0.4, 0.4), color: 0xcccccc });
  }
}

// 電柱と垂れた電線
function wires(ctx, group, pts) {
  const { B, world } = ctx;
  for (const p of pts) {
    const g = new THREE.CylinderGeometry(0.1, 0.13, 8, 7);
    B.geom('wood', g, new THREE.Matrix4().makeTranslation(p.x, 4, p.z), 0x4a3b2c);
    B.box('wood', p.x, 7.4, p.z, 1.6, 0.1, 0.1, { color: 0x4a3b2c });
    world.add(p.x - 0.15, 0, p.z - 0.15, p.x + 0.15, 8, p.z + 0.15, 'pole');
  }
  const mat = new THREE.LineBasicMaterial({ color: 0x151515 });
  for (let i = 0; i < pts.length - 1; i++) {
    for (const off of [-0.7, 0, 0.7]) {
      const a = pts[i], b = pts[i + 1];
      if (rand() < 0.15) continue;
      const arr = [];
      for (let k = 0; k <= 16; k++) {
        const t = k / 16;
        const dx = b.x - a.x, dz = b.z - a.z;
        const nx = -dz, nz = dx, l = Math.hypot(nx, nz) || 1;
        arr.push(new THREE.Vector3(a.x + dx * t + nx / l * off, 7.45 - Math.sin(Math.PI * t) * 1.1, a.z + dz * t + nz / l * off));
      }
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(arr), mat));
    }
  }
}

// ---------------------------------------------------------------------------
// 街区
// ---------------------------------------------------------------------------

function sideFrame(cx, cz, s) {
  const h = BLOCK / 2;
  if (s === 0) return new Frame(null, cx - h, cz + h, 0);
  if (s === 1) return new Frame(null, cx + h, cz + h, Math.PI / 2);
  if (s === 2) return new Frame(null, cx + h, cz - h, Math.PI);
  return new Frame(null, cx - h, cz - h, -Math.PI / 2);
}

function rowBlock(ctx, cx, cz, mainStreetSides) {
  for (let s = 0; s < 4; s++) {
    const SF = sideFrame(cx, cz, s);
    const shopSide = mainStreetSides.includes(s) || rand() < 0.4;
    // 角の建物
    const lots = [{ u: 0, w: 14, dp: 14, corner: true }];
    let u = 14;
    const rest = BLOCK - 14 - 14;
    const n = rand() < 0.5 ? 2 : 3;
    const widths = [];
    let acc = 0;
    for (let i = 0; i < n; i++) { const ww = i === n - 1 ? rest - acc : Math.round(R(rest / n - 2, rest / n + 2)); widths.push(ww); acc += ww; }
    for (const ww of widths) { lots.push({ u, w: ww, dp: RI(12, 14) }); u += ww; }
    for (const lot of lots) {
      const F = SF.child(lot.u, 0, 0);
      const floors = lot.corner ? RI(4, 5) : RI(3, 5);
      const r = rand();
      const dmg = r < 0.25 ? 0 : r < 0.6 ? 1 : 2;
      building(ctx, F, { w: lot.w, dp: lot.dp, floors, dmg, shop: shopSide, cornerLeft: lot.corner });
    }
  }
}

function ruinBlock(ctx, cx, cz) {
  const { B, world } = ctx;
  // 外周の一部に全壊した建物（中に入れる）
  for (let s = 0; s < 4; s++) {
    const SF = sideFrame(cx, cz, s);
    let u = 0;
    while (u < BLOCK - 14 - 4) {
      let w = RI(10, 15);
      if (BLOCK - 14 - (u + w) < 6) w = BLOCK - 14 - u;   // 角の区画にはみ出さない
      const F = SF.child(u, 0, 0);
      const r = rand();
      if (r < 0.45) building(ctx, F, { w, dp: RI(10, 13), floors: RI(2, 3), dmg: 3, shop: rand() < 0.5, enterable: true, cornerLeft: u === 0 });
      else if (r < 0.7) {
        // 崩落して瓦礫の山
        rubblePile(ctx, F.pt(w / 2, 0, -5), R(4.5, 6.5), R(2.2, 3.4));
        rubblePile(ctx, F.pt(w * 0.2, 0, -2), R(2, 3), R(1, 1.8));
      } else if (r < 0.85) {
        // 正面壁だけが残った建物（自立するファサード）
        const floorsArr = new Array(Math.max(1, Math.round(w / 3.1))).fill(0).map(() => RI(2, 4));
        facade(B, F, {
          L: w, gh: 4.0, fh: 3.3, key: 'plaster', color: pick(PLASTER_TINTS), detail: 1, floors: floorsArr,
          dmgCells: new Set([RI(0, floorsArr.length - 1) + ',1']), shop: true, winStyle: RI(0, 3), shutters: true,
          shutterColor: 0x4f5a3f, soot: 0.6, cornice: false, collide: true, world, ruinTop: true, base: 'stone', baseColor: 0xd0c8b8,
        });
        rubblePile(ctx, F.pt(w / 2, 0, -3.5), R(3.5, 5), R(1.5, 2.5));
      } else {
        sandbags(ctx, F.pt(w / 2, 0, -3).x, F.pt(w / 2, 0, -3).z, (s % 2) * Math.PI / 2, 5, 4);
      }
      u += w;
    }
  }
  // 中央：瓦礫原と焼けた木
  for (let k = 0; k < 5; k++) rubblePile(ctx, new THREE.Vector3(cx + R(-12, 12), 0, cz + R(-12, 12)), R(1.5, 3.5), R(0.6, 1.8));
  for (let k = 0; k < 3; k++) tree(ctx, cx + R(-14, 14), cz + R(-14, 14));
  // 地面：土と瓦礫
  B.box('rubble', cx, 0.02, cz, BLOCK - 1.2, 0.04, BLOCK - 1.2, { uv: 4 });
}

function plaza(ctx, cx, cz) {
  const { B, world } = ctx;
  B.box('pavers', cx, 0.08, cz, BLOCK, 0.16, BLOCK, { uv: 2, color: 0xe0dcd4, faces: 63 & ~8 });
  world.add(cx - BLOCK / 2, 0, cz - BLOCK / 2, cx + BLOCK / 2, 0.16, cz + BLOCK / 2, 'curb');
  // 噴水（八角形の水盤・崩れた中央柱）
  for (let k = 0; k < 8; k++) {
    const a = k / 8 * Math.PI * 2;
    if (k === 3) continue;                         // 崩れた区間
    B.box('stone', cx + Math.cos(a) * 5, 0.55, cz + Math.sin(a) * 5, 0.5, 0.8, 4.2, { ry: -a, color: 0xd8d0c0 });
    const a0 = [cx + Math.cos(a) * 5, cz + Math.sin(a) * 5];
    world.add(a0[0] - 1.2, 0, a0[1] - 1.2, a0[0] + 1.2, 0.95, a0[1] + 1.2, 'cover');
  }
  B.box('stone', cx, 1.3, cz, 1.2, 2.6, 1.2, { color: 0xc8c0b0 });
  B.box('stone', cx + 0.6, 0.4, cz + 1.4, 0.9, 0.6, 1.5, { ry: 0.6, rz: 0.4, color: 0xc8c0b0 });
  world.add(cx - 0.7, 0, cz - 0.7, cx + 0.7, 2.6, cz + 0.7, 'statue');
  // 記念碑の台座と折れた像
  B.box('stone', cx - 14, 1.2, cz - 12, 3, 2.4, 3, { color: 0xbdb6a8 });
  B.box('stone', cx - 14, 2.6, cz - 12, 2.4, 0.4, 2.4, { color: 0xd0c8b8 });
  B.box('metal', cx - 14, 3.6, cz - 12, 0.7, 1.8, 0.6, { color: 0x3a4a40 });
  B.box('metal', cx - 12.3, 0.4, cz - 10.6, 0.7, 0.6, 1.9, { ry: 0.7, color: 0x3a4a40 });
  world.add(cx - 15.5, 0, cz - 13.5, cx - 12.5, 4.5, cz - 10.5, 'statue');
  // 広告塔（リトファスゾイレ）
  const col = new THREE.CylinderGeometry(0.9, 0.9, 3.2, 20);
  B.geom('poster', col, new THREE.Matrix4().makeTranslation(cx + 16, 1.6, cz + 14), 0xffffff, 1);
  B.box('metal', cx + 16, 3.35, cz + 14, 2.1, 0.3, 2.1, { color: 0x2d3a30 });
  world.add(cx + 15.1, 0, cz + 13.1, cx + 16.9, 3.4, cz + 14.9, 'pole');
  tank(ctx, cx + 10, cz - 8, 0.7);
  crater(ctx, cx - 6, cz + 12, 3.2);
  crater(ctx, cx + 14, cz + 2, 2.4);
  sandbags(ctx, cx - 4, cz - 18, 0, 7, 4);
  sandbags(ctx, cx + 4, cz + 19, 0, 6, 3);
  sandbags(ctx, cx - 19, cz + 4, Math.PI / 2, 8, 4);
  for (const [x, z] of [[-20, -20], [20, -20], [-20, 20], [8, 20], [-8, -21], [20, 8]]) tree(ctx, cx + x, cz + z);
  for (let k = 0; k < 6; k++) hedgehog(ctx, cx + R(-22, 22), cz + R(-22, 22));
  // ベンチの残骸
  for (let k = 0; k < 4; k++) B.box('wood', cx + R(-20, 20), 0.45, cz + R(-20, 20), 1.8, 0.08, 0.5, { ry: R(0, 3), rz: R(-0.3, 0.3), color: 0x5a4632 });
}

// ---------------------------------------------------------------------------
// 全体
// ---------------------------------------------------------------------------

export function buildCity(scene, T) {
  const materials = makeMaterials(T);
  const world = new World(8);
  const root = new THREE.Group();
  root.name = 'city';
  scene.add(root);
  const centers = [-SPACING, 0, SPACING];
  const builders = [];
  const mk = () => { const B = new GeoBuilder(); builders.push(B); return { B, world }; };

  // 地面（アスファルト）と歩道
  const ground = mk();
  ground.B.box('asphalt', 0, -0.05, 0, 300, 0.1, 300, { uv: 4, faces: 4 });
  for (const cx of centers) for (const cz of centers) {
    const h = BLOCK / 2, sw = 3;
    for (const [x, z, sx, sz] of [[cx, cz + h + sw / 2, BLOCK + 2 * sw, sw], [cx, cz - h - sw / 2, BLOCK + 2 * sw, sw],
      [cx + h + sw / 2, cz, sw, BLOCK], [cx - h - sw / 2, cz, sw, BLOCK]]) {
      ground.B.box('pavers', x, 0.08, z, sx, 0.16, sz, { uv: 2, color: 0xd8d4cc, faces: 63 & ~8 });
      world.add(x - sx / 2, 0, z - sz / 2, x + sx / 2, 0.16, z + sz / 2, 'curb');
    }
    // 縁石
    const o = h + sw;
    for (const [x, z, sx, sz] of [[cx, cz + o, BLOCK + 2 * sw, 0.25], [cx, cz - o, BLOCK + 2 * sw, 0.25], [cx + o, cz, 0.25, BLOCK + 2 * sw - 0.5], [cx - o, cz, 0.25, BLOCK + 2 * sw - 0.5]]) {
      ground.B.box('stone', x, 0.09, z, sx, 0.18, sz, { uv: 1, color: 0xa8a49c, faces: 63 & ~8 });
    }
  }
  // 路面電車の軌道（東西の大通り z=+36）
  for (const zz of [SPACING / 2 - 1.6, SPACING / 2 + 1.6]) {
    for (const off of [-0.72, 0.72]) ground.B.box('metal', 0, 0.02, zz + off, 220, 0.05, 0.08, { color: 0x6a645c });
  }

  // 街区
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const cx = centers[i], cz = centers[j];
    const C = mk();
    if (i === 1 && j === 1) plaza(C, cx, cz);
    else if ((i === 2 && j === 0) || (i === 0 && j === 2)) ruinBlock(C, cx, cz);
    else rowBlock(C, cx, cz, [j === 1 ? 0 : -1, i === 1 ? 1 : -1].filter((x) => x >= 0));
  }

  // 外縁の建物列（内側を向く）
  const edge = mk();
  for (let s = 0; s < 4; s++) {
    const rot = [0, Math.PI / 2, Math.PI, -Math.PI / 2][s];
    // 北・南の列は角まで、東・西の列は角の手前（±LIMIT）で止めて重ならないように
    const u0 = s % 2 === 0 ? -LIMIT - 13 : -LIMIT - 1, u1 = s % 2 === 0 ? LIMIT + 13 : LIMIT + 1;
    let u = u0;
    while (u < u1 - 0.5) {
      let w = RI(10, 16);
      if (u1 - (u + w) < 6) w = u1 - u;
      // s=0: 北側（z=-LIMIT）の建物、正面は +z
      let F;
      if (s === 0) F = new Frame(null, u, -LIMIT - 1, 0);
      else if (s === 1) F = new Frame(null, -LIMIT - 1, -u, Math.PI / 2);
      else if (s === 2) F = new Frame(null, -u, LIMIT + 1, Math.PI);
      else F = new Frame(null, LIMIT + 1, u, -Math.PI / 2);
      void rot;
      const r = rand();
      building(edge, F, { w, dp: 12, floors: RI(3, 6), dmg: r < 0.4 ? 0 : r < 0.75 ? 1 : 2, shop: rand() < 0.5, backdrop: false });
      u += w;
    }
  }
  // 境界（見えない壁）
  world.add(-LIMIT - 2, 0, -LIMIT - 2, LIMIT + 2, 30, -LIMIT, 'bounds');
  world.add(-LIMIT - 2, 0, LIMIT, LIMIT + 2, 30, LIMIT + 2, 'bounds');
  world.add(-LIMIT - 2, 0, -LIMIT, -LIMIT, 30, LIMIT, 'bounds');
  world.add(LIMIT, 0, -LIMIT, LIMIT + 2, 30, LIMIT, 'bounds');

  // 通りの小物
  const st = mk();
  const streetLines = [-SPACING / 2, SPACING / 2];
  const streetPos = () => {
    // 道路上のランダム位置（交差点含む）
    if (rand() < 0.5) return [pick(streetLines) + R(-5, 5), R(-100, 100)];
    return [R(-100, 100), pick(streetLines) + R(-5, 5)];
  };
  for (let k = 0; k < 16; k++) {
    const [x, z] = streetPos();
    const along = Math.abs(Math.abs(x) - SPACING / 2) < 6 ? 0 : Math.PI / 2;
    car(st, x, z, along + R(-0.35, 0.35) + (rand() < 0.5 ? Math.PI : 0));
  }
  for (const x of streetLines) for (const z of streetLines) {
    // 交差点のバリケード
    for (let k = 0; k < 3; k++) hedgehog(st, x + R(-7, 7), z + R(-7, 7));
    sandbags(st, x + R(-4, 4), z + pick([-6, 6]), 0, R(4, 7), 3);
    crater(st, x + R(-5, 5), z + R(-5, 5), R(1.8, 3));
  }
  for (let k = 0; k < 10; k++) { const [x, z] = streetPos(); crater(st, x, z, R(1.2, 2.6)); }
  for (let k = 0; k < 6; k++) { const [x, z] = streetPos(); sandbags(st, x, z, rand() < 0.5 ? 0 : Math.PI / 2, R(3, 6), RI(2, 4)); }
  // 街灯（歩道沿い）
  for (const cx of centers) for (const cz of centers) {
    const o = BLOCK / 2 + 2.4;
    for (let u = -22; u <= 22; u += 15) {
      lamp(st, cx + u, cz + o, Math.PI, rand() < 0.3);
      lamp(st, cx + o, cz + u, -Math.PI / 2, rand() < 0.3);
    }
  }
  // 電柱と電線（南北の通り x=-36）
  const poles = [];
  for (let z = -100; z <= 100; z += 22) poles.push(new THREE.Vector3(-SPACING / 2 + 7.5, 0, z));
  wires(st, root, poles);
  // 散乱した破片
  for (let k = 0; k < 900; k++) {
    const x = R(-108, 108), z = R(-108, 108);
    const s = R(0.06, 0.3);
    st.B.box(pick(['brick', 'concrete', 'plaster', 'stone']), x, s * 0.2, z, s * 1.6, s * 0.5, s, { ry: R(0, 3), rx: R(-0.3, 0.3), color: 0xcfcac0 });
  }

  for (const b of builders) b.build(materials, root);
  return { world, materials, root };
}

// AI 用の通行グラフ（交差点と通りの中間点）
export function navGraph() {
  const nodes = [];
  const lines = [-SPACING / 2, SPACING / 2];
  const ring = [-104, 104];
  const xs = [...ring, ...lines].sort((a, b) => a - b);
  for (const x of xs) for (const z of xs) nodes.push(new THREE.Vector3(x, 0, z));
  // 通りの中間点
  for (const x of xs) for (let i = 0; i < xs.length - 1; i++) {
    nodes.push(new THREE.Vector3(x, 0, (xs[i] + xs[i + 1]) / 2));
    nodes.push(new THREE.Vector3((xs[i] + xs[i + 1]) / 2, 0, x));
  }
  // 広場の中
  for (const [x, z] of [[0, 0], [-16, 0], [16, 0], [0, -16], [0, 16]]) nodes.push(new THREE.Vector3(x, 0, z));
  const edges = nodes.map(() => []);
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    const sameLine = Math.abs(a.x - b.x) < 0.1 || Math.abs(a.z - b.z) < 0.1;
    const d = a.distanceTo(b);
    if (sameLine && d < 40) { edges[i].push(j); edges[j].push(i); }
  }
  return { nodes, edges };
}
