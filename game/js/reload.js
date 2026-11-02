// 一人称リロード（Call of Duty 風）：残弾あり＝タクティカル、空＝エンプティ（ボルトキャッチを叩く）
// 一続きの動き：銃を右に傾けて銃口を上げる → 左手がマガジンへ → 抜く（空は落とす）→ 新しいマガジンを持ってくる
//               → 差し込んで底を叩く → （空なら左側面のボルトキャッチを叩く）→ ハンドガードへ戻す
// 座標はライフルのローカル（glTF）：+X 銃口方向, +Y 上, +Z 銃の右
import * as THREE from 'three';

export const RELOAD = {
  tactical: { dur: 2.15, seat: 1.25 },
  empty: { dur: 2.7, seat: 1.32, bolt: 1.62 },
};

const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// [時刻, x, y, z] の折れ線をなめらかに補間
function track(keys, t) {
  if (t <= keys[0][0]) return keys[0].slice(1);
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t <= b[0]) {
      const u = ease((t - a[0]) / (b[0] - a[0]));
      return a.slice(1).map((v, k) => lerp(v, b[k + 1], u));
    }
  }
  return keys[keys.length - 1].slice(1);
}

// 銃の姿勢：[時刻, 銃身まわりの傾き(右), 銃口の上下, 左右(銃口を左へ), 移動 x, y, z]
const GUN = {
  // 銃を右へ大きく傾け（挿入口を左手側へ）、銃口を上げ、前方・上・画面中央へ寄せて挿入口が見えるようにする
  tactical: [[0, 0, 0, 0, 0, 0, 0], [0.3, 42, 14, 18, 0.07, 0.1, -0.12], [1.18, 44, 15, 18, 0.07, 0.1, -0.12],
    [1.25, 45, 19, 18, 0.07, 0.115, -0.12], [1.34, 43, 14, 18, 0.07, 0.1, -0.12], [1.55, 34, 10, 12, 0.05, 0.07, -0.09],
    [1.9, -3, -2, 0, 0, 0.003, 0], [2.15, 0, 0, 0, 0, 0, 0]],
  empty: [[0, 0, 0, 0, 0, 0, 0], [0.3, 44, 16, 19, 0.07, 0.1, -0.12], [1.25, 45, 16, 19, 0.07, 0.1, -0.12],
    [1.32, 47, 20, 19, 0.07, 0.115, -0.12], [1.42, 32, 10, 10, 0.06, 0.08, -0.1], [1.58, 20, 5, 6, 0.05, 0.06, -0.07],
    [1.64, 17, 2, 6, 0.02, 0.058, -0.07], [1.75, 14, 4, 5, 0.04, 0.05, -0.06], [2.3, -3, -2, 0, 0, 0.003, 0],
    [2.7, 0, 0, 0, 0, 0, 0]],
};

// 左手（ハンドガードを握った位置からのずれ）
const HAND = {
  tactical: [[0, 0, 0, 0], [0.3, -0.14, -0.1, 0.0], [0.4, -0.14, -0.1, 0.0], [0.72, -0.24, -0.5, -0.16],
    [0.95, -0.24, -0.52, -0.16], [1.18, -0.14, -0.13, 0.0], [1.25, -0.14, -0.088, 0.0], [1.32, -0.14, -0.1, 0.0],
    [1.7, 0, 0, 0], [2.15, 0, 0, 0]],
  empty: [[0, 0, 0, 0], [0.3, -0.14, -0.1, 0.0], [0.38, -0.14, -0.12, 0.0], [0.75, -0.24, -0.52, -0.16],
    [0.98, -0.24, -0.52, -0.16], [1.24, -0.14, -0.13, 0.0], [1.32, -0.14, -0.088, 0.0], [1.4, -0.14, -0.1, 0.0],
    [1.56, -0.17, -0.02, -0.06], [1.62, -0.175, -0.012, -0.045], [1.7, -0.165, -0.02, -0.06], [2.05, 0, 0, 0], [2.7, 0, 0, 0]],
};

// マガジン：手に付いて動く区間と、本体に収まっている区間
function magOffset(kind, t, hand) {
  const K = RELOAD[kind];
  if (kind === 'tactical') {
    if (t < 0.4) return [0, 0, 0, true];
    if (t < K.seat) return [hand[0] + 0.14, hand[1] + 0.088, hand[2], true];     // 手と一緒に（古い→新しい）
    return [0, 0, 0, true];
  }
  // 空：0.36 で外れて重力で落ち、画面外へ。新しいマガジンは 0.98 から手に付いて現れる
  if (t < 0.36) return [0, 0, 0, true];
  if (t < 0.98) {
    const f = t - 0.36;
    return [-0.02 * f, -0.02 - 4.9 * f * f, 0.05 * f, f < 0.45];
  }
  if (t < K.seat) return [hand[0] + 0.14, hand[1] + 0.088, hand[2], true];
  return [0, 0, 0, true];
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();

/** vm: { weapon, leftArm, mag, armRest, magRest, gripPivot } を t 秒時点の姿勢にする */
export function poseReload(vm, kind, t) {
  const g = track(GUN[kind], t);
  // 銃はグリップ（右手）を中心に回す
  _e.set(THREE.MathUtils.degToRad(g[0]), THREE.MathUtils.degToRad(g[2]), THREE.MathUtils.degToRad(g[1]), 'XYZ');
  _q.setFromEuler(_e);
  const p = vm.gripPivot;
  vm.weapon.quaternion.copy(_q);
  vm.weapon.position.copy(p).sub(p.clone().applyQuaternion(_q)).add(new THREE.Vector3(g[3], g[4], g[5]));
  const h = track(HAND[kind], t);
  vm.leftArm.position.set(vm.armRest.x + h[0], vm.armRest.y + h[1], vm.armRest.z + h[2]);
  // 手首を少し返す（マガジンを握る・差し込むときの角度）
  const grab = Math.min(1, Math.abs(h[1]) / 0.1);
  vm.leftArm.rotation.set(-0.35 * grab, 0, 0.15 * grab);
  const m = magOffset(kind, t, h);
  vm.mag.position.set(vm.magRest.x + m[0], vm.magRest.y + m[1], vm.magRest.z + m[2]);
  vm.mag.visible = m[3];
}

export function resetReload(vm) {
  vm.weapon.position.set(0, 0, 0);
  vm.weapon.quaternion.identity();
  vm.leftArm.position.copy(vm.armRest);
  vm.leftArm.rotation.set(0, 0, 0);
  vm.mag.position.copy(vm.magRest);
  vm.mag.visible = true;
}

/** viewmodel.glb の各部品を、リロードで動かせる階層に組み直す */
export function rigViewmodel(vmScene) {
  const find = (n) => { let r = null; vmScene.traverse((o) => { if (!r && o.name.startsWith(n)) r = o; }); return r; };
  const rifle = find('Rifle'), mag = find('Magazine'), armL = find('ArmL'), armR = find('ArmR');
  const weapon = new THREE.Group();
  weapon.name = 'weapon';
  // 部品は複数マテリアルだとグループになるので、中のメッシュをたどる（ノード自身の変換も反映）
  const center = (o, filter) => {
    const v = new THREE.Vector3(), c = new THREE.Vector3();
    let n = 0;
    o.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(o.parent ? o.parent.matrixWorld : new THREE.Matrix4()).invert();
    o.traverse((m) => {
      if (!m.isMesh) return;
      const pos = m.geometry.attributes.position;
      const toParent = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(toParent);
        if (!filter || filter(v)) { c.add(v); n++; }
      }
    });
    return n ? c.multiplyScalar(1 / n) : c;
  };
  // 左手は手の付近を回転中心に、マガジンはその中心を基準に
  const handC = armL ? center(armL, (v) => v.x > 0.45) : new THREE.Vector3(0.6, -0.05, 0);
  const magC = mag ? center(mag) : new THREE.Vector3(0.5, -0.17, 0);
  const leftArm = new THREE.Group();
  leftArm.name = 'leftArm';
  const magG = new THREE.Group();
  magG.name = 'magazine';
  for (const [o, grp, c] of [[armL, leftArm, handC], [mag, magG, magC]]) {
    if (!o) continue;
    o.position.sub(c);
    grp.add(o);
    grp.position.copy(c);
  }
  for (const o of [rifle, armR]) if (o) weapon.add(o);
  weapon.add(leftArm, magG);
  vmScene.add(weapon);
  return {
    weapon, leftArm, mag: magG, rifle, armRest: handC.clone(), magRest: magC.clone(),
    gripPivot: new THREE.Vector3(0.356, -0.1, 0),
    ok: !!(rifle && mag && armL && armR),
  };
}
