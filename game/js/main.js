import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildTextures } from './textures.js';
import { buildCity, navGraph } from './city.js';
import { Effects } from './effects.js';
import { Audio } from './audio.js';
import { Player } from './player.js';
import { EnemyManager } from './enemies.js';
import { isTouchDevice, setupTouch } from './touch.js';

const $ = (id) => document.getElementById(id);
const ui = {
  loading: $('loading'), bar: $('load-bar'), loadText: $('load-text'), menu: $('menu'), pause: $('pause'), over: $('over'),
  hud: $('hud'), ammo: $('ammo'), reserve: $('reserve'), mode: $('mode'), hp: $('hp-fill'), hpText: $('hp-text'),
  wave: $('wave'), kills: $('kills'), left: $('left'), banner: $('banner'), cross: $('cross'), hit: $('hitmarker'),
  vignette: $('vignette'), dmgDir: $('dmg-dir'), overStats: $('over-stats'), reloadTip: $('reload-tip'), touchNote: $('touch-note'),
};

// ---------------------------------------------------------------- レンダラー
const canvas = $('game');
// ?low で軽量表示（影なし・低解像度）
const TOUCH = isTouchDevice();
const QS = new URLSearchParams(location.search);
// スマホは既定で軽量表示（?high で通常）
const LOW = QS.has('low') || (TOUCH && !QS.has('high'));
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !LOW, powerPreference: 'high-performance' });
renderer.setPixelRatio(LOW ? 0.75 : Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = !LOW;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.autoClear = false;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x8c8376, 0.0088);
const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.05, 900);
camera.rotation.order = 'YXZ';

// 空：煙で霞んだ夕方の曇天（地平線は茶色く、太陽は低い）
const SUN_DIR = new THREE.Vector3(-0.55, 0.32, 0.45).normalize();
const sky = new THREE.Mesh(new THREE.SphereGeometry(700, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { sun: { value: SUN_DIR } },
  vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix*vec4(position,1.); gl_Position = projectionMatrix*p; }',
  fragmentShader: `varying vec3 vDir; uniform vec3 sun;
    float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
    float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y); }
    void main(){
      float y = vDir.y;
      vec3 hor = vec3(0.62,0.55,0.47), mid = vec3(0.50,0.50,0.50), top = vec3(0.30,0.33,0.37);
      vec3 c = mix(hor, mid, smoothstep(0.0, 0.25, y)); c = mix(c, top, smoothstep(0.25, 0.9, y));
      float s = max(dot(vDir, sun), 0.0);
      c += vec3(1.0,0.62,0.30) * (pow(s, 6.0) * 0.35 + pow(s, 80.0) * 0.9);
      vec2 uv = vDir.xz / max(0.08, y + 0.15) * 1.6;
      float cl = n(uv) * 0.5 + n(uv * 2.3) * 0.3 + n(uv * 5.1) * 0.2;
      c = mix(c, c * 0.72, smoothstep(0.45, 0.8, cl) * smoothstep(0.02, 0.3, y));
      c = mix(vec3(0.42,0.37,0.32), c, smoothstep(-0.05, 0.06, y));
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
}));
scene.add(sky);

const hemi = new THREE.HemisphereLight(0xbcb8ae, 0x4d4338, 1.25);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffcf98, 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const SH = 60;
Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 1, far: 300 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);

// 一人称の銃は別パスで描く（壁にめり込まない）
const vmScene = new THREE.Scene();
const vmCamera = new THREE.PerspectiveCamera(72, camera.aspect, 0.01, 10);
vmScene.add(new THREE.HemisphereLight(0xc8c4ba, 0x4a4036, 1.4));
const vmSun = new THREE.DirectionalLight(0xffd8a8, 1.8);
vmSun.position.copy(SUN_DIR).multiplyScalar(10);
vmScene.add(vmSun);
// 金属（銃・装備）の映り込み用の環境マップ
const envMap = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
vmScene.environment = envMap;
const vmHolder = new THREE.Group();
const vmRoot = new THREE.Group();
vmHolder.add(vmRoot);
vmScene.add(vmHolder);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = vmCamera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix(); vmCamera.updateProjectionMatrix();
});

// ---------------------------------------------------------------- 読み込み
const progress = (p, text) => { ui.bar.style.width = `${Math.round(p * 100)}%`; if (text) ui.loadText.textContent = text; };
const tick = () => new Promise((r) => requestAnimationFrame(() => r()));

let world, nav, fx, audio, player, enemies;
const state = { mode: 'loading', wave: 0, kills: 0, waveTimer: 0, time: 0, practice: false, attractT: 0 };

async function load() {
  progress(0.05, 'テクスチャを生成中…');
  await tick();
  const T = buildTextures();
  progress(0.25, '市街地を生成中…');
  await tick();
  const city = buildCity(scene, T);
  world = city.world;
  nav = navGraph();
  fx = new Effects(scene, T);
  audio = new Audio();
  progress(0.55, '兵士モデルを読み込み中…');
  const loader = new GLTFLoader();
  // テクスチャは <img> で読む（fetch(blob:) を禁止する配信環境でも動くように）
  loader.register((parser) => { parser.textureLoader = new THREE.TextureLoader(parser.options.manager); return { name: 'img_textures' }; });
  const loadGLB = (url, w0, w1) => url.endsWith('.json') ? loadEmbedded(loader, url, (p) => progress(w0 + (w1 - w0) * p))
    : new Promise((res, rej) => loader.load(url, res, (e) => { if (e.total) progress(w0 + (w1 - w0) * e.loaded / e.total); }, rej));
  // 配信先が .glb を扱えない場合は埋め込み glTF（.json）を使う（window.__ASSET_EXT で指定）
  const ext = window.__ASSET_EXT || '.glb';
  const [soldier, vm] = await Promise.all([loadGLB('assets/soldier' + ext, 0.55, 0.9), loadGLB('assets/viewmodel' + ext, 0.9, 0.98)]);
  // ビューモデル
  vm.scene.traverse((o) => {
    if (o.isMesh) {
      o.frustumCulled = false;
      o.material.side = THREE.DoubleSide;
      o.material.envMapIntensity = 0.55;
      if (o.name.startsWith('Rifle')) vmRoot.userData.rifle = o;
    }
  });
  vmRoot.add(vm.scene);
  player = new Player(camera, world, vmRoot, fx, audio);
  player.onShoot = shoot;
  player.onFired = (o) => enemies.noise(o, 60);
  soldier.scene.traverse((o) => {
    if (o.isMesh) { o.material.envMap = envMap; o.material.envMapIntensity = 0.45; }
  });
  enemies = new EnemyManager(scene, soldier, world, nav, fx, audio, player);
  // 燃える車・遠景の煙柱
  for (const p of [[10, 0.2, -8], [-36, 0.3, 52], [36, 0.3, -70], [-80, 0.3, 36], [72, 0.3, 36]]) fx.fire(new THREE.Vector3(...p), 1);
  for (const p of [[-170, 0, -120], [150, 0, 160], [60, 0, -190], [-140, 0, 170], [190, 0, -40]]) fx.smokeColumn(new THREE.Vector3(...p), 1.4);
  progress(1, '準備完了');
  await tick();
  // メニュー背景：敵兵を何人か巡回させておく
  for (let i = 0; i < 6; i++) enemies.spawn(nav.nodes[(i * 7) % nav.nodes.length].clone());
  ui.loading.hidden = true;
  ui.menu.hidden = false;
  state.mode = 'menu';
  if (TOUCH) {
    ui.touchNote.hidden = false;
    touch = setupTouch({
      root: document.getElementById('touch-ui'), getPlayer: () => player,
      isPlaying: () => state.mode === 'play', onPause: pauseGame,
    });
  }
}

// 埋め込み glTF（.json）：data: URI を fetch せずに自前でデコードし、GLB に組み立てて解析する
async function loadEmbedded(loader, url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} を取得できません（${res.status}）`);
  const total = Number(res.headers.get('content-length')) || 0;
  let text;
  if (res.body && total) {
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      onProgress(Math.min(1, got / total));
    }
    text = new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
  } else {
    text = await res.text();
  }
  const json = JSON.parse(text);
  const uri = json.buffers[0].uri;
  const b64 = uri.slice(uri.indexOf(',') + 1);
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  delete json.buffers[0].uri;
  json.buffers[0].byteLength = bin.length;
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jpad = (4 - (jsonBytes.length % 4)) % 4, bpad = (4 - (bin.length % 4)) % 4;
  const jl = jsonBytes.length + jpad, bl = bin.length + bpad;
  const glb = new Uint8Array(12 + 8 + jl + 8 + bl);
  const dv = new DataView(glb.buffer);
  dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, glb.length, true);
  dv.setUint32(12, jl, true); dv.setUint32(16, 0x4E4F534A, true);
  glb.set(jsonBytes, 20); glb.fill(0x20, 20 + jsonBytes.length, 20 + jl);
  dv.setUint32(20 + jl, bl, true); dv.setUint32(24 + jl, 0x004E4942, true);
  glb.set(bin, 28 + jl);
  return new Promise((ok, ng) => loader.parse(glb.buffer, '', ok, ng));
}

// ---------------------------------------------------------------- 射撃判定
function shoot(origin, dir) {
  const eh = enemies.raycast(origin, dir, 300);
  const wh = world.raycast(origin, dir, 300);
  if (eh && (!wh || eh.t < wh.t)) {
    const dmg = eh.part === 'head' ? 110 : eh.part === 'body' ? 36 : 24;
    const p = origin.clone().addScaledVector(dir, eh.t);
    fx.impact(p, dir.clone().negate(), 'flesh');
    const killed = eh.enemy.damage(dmg * (state.practice ? 1 : 1), eh.part, player.pos.clone());
    audio.hit(eh.part === 'head');
    showHit(killed, eh.part === 'head');
    if (killed) { state.kills++; }
    return { dist: eh.t };
  }
  if (wh) {
    const p = origin.clone().addScaledVector(dir, wh.t);
    fx.impact(p, wh.normal, wh.box && ['car', 'tank', 'pole'].includes(wh.box.tag) ? 'metal' : 'wall');
    return { dist: wh.t };
  }
  return { dist: 300 };
}

let hitTimer = 0;
function showHit(kill, head) {
  ui.hit.classList.toggle('kill', kill);
  ui.hit.classList.toggle('head', head);
  ui.hit.style.opacity = 1;
  hitTimer = kill ? 0.35 : 0.15;
}

// ---------------------------------------------------------------- 入力
const keysDown = new Set();
document.addEventListener('keydown', (e) => {
  if (state.mode !== 'play') return;
  player.keys[e.code] = true;
  if (e.code === 'KeyR') player.reload();
  if (e.code === 'KeyB') player.toggleMode();
  if (e.code === 'KeyC' || e.code === 'ControlLeft') player.crouch = !player.crouch;
  if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) e.preventDefault();
  keysDown.add(e.code);
});
document.addEventListener('keyup', (e) => { if (player) player.keys[e.code] = false; });
document.addEventListener('mousemove', (e) => {
  if (state.mode === 'play' && document.pointerLockElement === canvas) player.look(e.movementX, e.movementY);
});
document.addEventListener('mousedown', (e) => {
  if (state.mode !== 'play' || document.pointerLockElement !== canvas) return;
  if (e.button === 0) player.trigger = true;
  if (e.button === 2) player.adsHeld = true;
});
document.addEventListener('mouseup', (e) => {
  if (!player) return;
  if (e.button === 0) player.trigger = false;
  if (e.button === 2) player.adsHeld = false;
});
document.addEventListener('contextmenu', (e) => e.preventDefault());

let touch = null;
function pauseGame() {
  if (state.mode !== 'play') return;
  state.mode = 'paused';
  ui.pause.hidden = false;
  player.trigger = false; player.adsHeld = false;
  for (const k in player.keys) player.keys[k] = false;
  touch?.reset();
}

function lock() {
  if (TOUCH) {
    // スマホ：全画面＋横向き固定（対応していれば）
    const el = document.documentElement;
    try { const r = el.requestFullscreen?.({ navigationUI: 'hide' }); r?.catch?.(() => {}); } catch (_) { /* 非対応 */ }
    try { screen.orientation?.lock?.('landscape')?.catch?.(() => {}); } catch (_) { /* 非対応 */ }
    return;
  }
  try {
    const r = canvas.requestPointerLock();
    if (r && r.catch) r.catch(() => {});
  } catch (_) { /* ポインタロック不可の環境 */ }
}
document.addEventListener('pointerlockchange', () => {
  if (!TOUCH && document.pointerLockElement !== canvas) pauseGame();
});

$('btn-start').addEventListener('click', () => startGame(false));
$('btn-practice').addEventListener('click', () => startGame(true));
$('btn-resume').addEventListener('click', () => { ui.pause.hidden = true; state.mode = 'play'; lock(); });
$('btn-restart').addEventListener('click', () => startGame(state.practice));
$('btn-menu').addEventListener('click', () => { ui.pause.hidden = true; ui.over.hidden = true; ui.hud.hidden = true; ui.menu.hidden = false; state.mode = 'menu'; });

function startGame(practice) {
  audio.start();
  state.practice = practice;
  state.wave = 0; state.kills = 0; state.time = 0; state.waveTimer = 1.5;
  for (const e of enemies.list) e.dispose();
  enemies.list.length = 0;
  enemies.alertPos = null;
  Object.assign(player, { health: 100, alive: true, mag: 30, reserve: 210, reloading: 0, crouch: false, burstLeft: 0, shake: 0, recoil: 0 });
  player.pos.set(0, 0.16, 22);
  player.vel.set(0, 0, 0);
  player.yaw = 0; player.pitch = 0;
  ui.menu.hidden = true; ui.over.hidden = true; ui.pause.hidden = true; ui.hud.hidden = false;
  touch?.reset();
  state.mode = 'play';
  if (practice) {
    // 見学モード：敵は撃ってこない。周囲に配置して観察できる
    for (let i = 0; i < 8; i++) enemies.spawn(nav.nodes[(i * 5 + 3) % nav.nodes.length].clone());
    for (const e of enemies.list) e.passive = true;
    banner('見学モード：敵兵は攻撃してきません');
  }
  lock();
}

function banner(text, sec = 2.6) {
  ui.banner.textContent = text;
  ui.banner.classList.add('show');
  clearTimeout(banner.t);
  banner.t = setTimeout(() => ui.banner.classList.remove('show'), sec * 1000);
}

function spawnWave() {
  state.wave++;
  const n = Math.min(4 + (state.wave - 1) * 2, 14);
  const cand = nav.nodes.filter((p) => p.distanceTo(player.pos) > 55);
  for (let i = 0; i < n; i++) {
    const p = cand[Math.floor(Math.random() * cand.length)].clone();
    p.x += (Math.random() - 0.5) * 4; p.z += (Math.random() - 0.5) * 4;
    const e = enemies.spawn(p);
    if (state.wave > 1 && Math.random() < 0.5) e.hear(player.pos.clone());
  }
  player.reserve = Math.min(300, player.reserve + 90);
  banner(`第 ${state.wave} 波 — 敵兵 ${n}`);
}

// ---------------------------------------------------------------- HUD
let lastHealth = 100, dmgFrom = null, dmgT = 0;
function updateHUD(dt) {
  ui.ammo.textContent = player.mag;
  ui.reserve.textContent = player.reserve;
  ui.mode.textContent = player.mode === 'semi' ? 'SEMI' : '3-RND BURST';
  ui.hp.style.width = `${player.health}%`;
  ui.hp.classList.toggle('low', player.health < 35);
  ui.hpText.textContent = Math.ceil(player.health);
  ui.wave.textContent = state.practice ? '—' : state.wave;
  ui.kills.textContent = state.kills;
  ui.left.textContent = enemies.alive;
  ui.reloadTip.hidden = !(player.mag <= 6 && player.reloading <= 0 && player.reserve > 0);
  ui.reloadTip.textContent = player.mag === 0 ? 'R でリロード' : '残弾わずか — R';
  // 照準：移動で広がる、ADS で消える
  const spread = 8 + Math.hypot(player.vel.x, player.vel.z) * 4 + (player.onGround ? 0 : 20);
  ui.cross.style.setProperty('--gap', `${spread}px`);
  ui.cross.style.opacity = 1 - player.ads;
  hitTimer -= dt;
  if (hitTimer <= 0) ui.hit.style.opacity = 0;
  // 被弾
  if (player.health < lastHealth - 0.5) { dmgT = 1; }
  lastHealth = player.health;
  dmgT = Math.max(0, dmgT - dt * 1.4);
  ui.vignette.style.opacity = Math.min(1, dmgT * 0.8 + (1 - player.health / 100) * 0.6);
  ui.dmgDir.style.opacity = dmgT;
  if (dmgFrom) {
    const v = dmgFrom.clone().sub(player.pos);
    const ang = Math.atan2(v.x, -v.z) + player.yaw;
    ui.dmgDir.style.transform = `translate(-50%,-50%) rotate(${ang}rad)`;
  }
}

// ---------------------------------------------------------------- メインループ
const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (state.mode === 'loading') return;
  update(dt);
  render();
}

function update(dt) {
  state.time += dt;

  if (state.mode === 'menu') {
    // メニュー背景：街の上空をゆっくり巡る
    state.attractT += dt * 0.05;
    const a = state.attractT;
    camera.position.set(Math.sin(a) * 30, 7 + Math.sin(a * 2) * 2, Math.cos(a) * 30 + 10);
    camera.lookAt(Math.sin(a + 0.6) * 10, 2.5, Math.cos(a + 0.6) * 10);
    camera.fov = 60; camera.updateProjectionMatrix();
    for (const e of enemies.list) e.passive = true;
    enemies.update(dt);
  } else if (state.mode === 'play') {
    player.update(dt);
    if (!state.practice) {
      if (enemies.alive === 0) {
        state.waveTimer -= dt;
        if (state.waveTimer <= 0) { spawnWave(); state.waveTimer = 5; }
      }
    }
    enemies.update(dt);
    updateHUD(dt);
    if (!player.alive) gameOver();
  } else if (state.mode === 'paused' || state.mode === 'over') {
    // 停止中は何も更新しない
  }
  fx.update(dt, camera.position);
}

function render() {
  // 影のカメラをプレイヤー周辺に追従（テクセル単位でスナップしてちらつき防止）
  const c = camera.position;
  const snap = (SH * 2) / 2048;
  const tx = Math.round(c.x / snap) * snap, tz = Math.round(c.z / snap) * snap;
  sun.target.position.set(tx, 0, tz);
  sun.position.set(tx + SUN_DIR.x * 150, SUN_DIR.y * 150, tz + SUN_DIR.z * 150);
  sky.position.copy(c);

  renderer.clear();
  renderer.render(scene, camera);
  if (state.mode === 'play' || state.mode === 'paused') {
    vmHolder.position.copy(camera.position);
    vmHolder.quaternion.copy(camera.quaternion);
    vmCamera.position.copy(camera.position);
    vmCamera.quaternion.copy(camera.quaternion);
    if (vmCamera.fov !== camera.fov) { vmCamera.fov = camera.fov; vmCamera.updateProjectionMatrix(); }
    renderer.clearDepth();
    renderer.render(vmScene, vmCamera);
  }
}

// 被弾方向の記録（Player.damage をラップ）
const _origDamage = Player.prototype.damage;
Player.prototype.damage = function (amount, fromPos) {
  if (state.practice) return;
  dmgFrom = fromPos ? fromPos.clone() : null;
  return _origDamage.call(this, amount, fromPos);
};

function gameOver() {
  state.mode = 'over';
  document.exitPointerLock?.();
  touch?.reset();
  ui.over.hidden = false;
  const m = Math.floor(state.time / 60), s = Math.floor(state.time % 60);
  ui.overStats.innerHTML = `<div><span>到達ウェーブ</span><b>${state.wave}</b></div><div><span>撃破数</span><b>${state.kills}</b></div><div><span>生存時間</span><b>${m}:${String(s).padStart(2, '0')}</b></div>`;
}

// デバッグ・テスト用
window.__game = {
  get touch() { return touch; },
  state, get player() { return player; }, get enemies() { return enemies; }, camera, scene, startGame,
  simulate(sec) { for (let t = 0; t < sec; t += 1 / 30) update(1 / 30); },
};

load().catch((err) => {
  console.error(err);
  ui.loadText.textContent = '読み込みに失敗しました：' + err.message;
});
frame();
