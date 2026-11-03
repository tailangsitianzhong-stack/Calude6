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
import { Avatar } from './avatar.js';
import { rigViewmodel } from './reload.js';

const $ = (id) => document.getElementById(id);
const ui = {
  loading: $('loading'), bar: $('load-bar'), loadText: $('load-text'), menu: $('menu'), pause: $('pause'), over: $('over'),
  hud: $('hud'), ammo: $('ammo'), reserve: $('reserve'), mode: $('mode'), hp: $('hp-fill'), hpText: $('hp-text'),
  wave: $('wave'), kills: $('kills'), left: $('left'), banner: $('banner'), cross: $('cross'), hit: $('hitmarker'),
  vignette: $('vignette'), dmgDir: $('dmg-dir'), overStats: $('over-stats'), reloadTip: $('reload-tip'), touchNote: $('touch-note'),
};

// ---------------------------------------------------------------- レンダラー
const canvas = $('game');
const TOUCH = isTouchDevice();
const QS = new URLSearchParams(location.search);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
// 画質プリセット（一時停止画面で切り替え）：解像度の上限・下限と影
const DPR = window.devicePixelRatio || 1;
const QUALITY = {
  low: { label: '低', max: Math.min(DPR, 0.85), min: 0.5, shadows: false, shadowSize: 1024 },
  normal: { label: '標準', max: Math.min(DPR, 1.3), min: 0.7, shadows: !TOUCH, shadowSize: 1024 },
  high: { label: '高', max: Math.min(DPR, 2), min: 0.9, shadows: true, shadowSize: 2048 },
};
let quality = QS.has('low') ? 'low' : QS.has('high') ? 'high' : TOUCH ? 'normal' : 'high';
try { const q = localStorage.getItem('rubble-quality'); if (q && QUALITY[q] && !QS.has('low') && !QS.has('high')) quality = q; } catch (_) { /* 読めない環境 */ }
let MAX_PR = QUALITY[quality].max, MIN_PR = QUALITY[quality].min;
const LOW = !QUALITY[quality].shadows;
let pixelRatio = MAX_PR;
renderer.setPixelRatio(pixelRatio);
// 重ければ解像度を自動で下げ、余裕があればプリセットの上限まで戻す（動的解像度）
const perf = { t: 0, frames: 0 };
function adaptResolution(dt) {
  perf.t += dt; perf.frames++;
  if (perf.t < 2) return;
  const fps = perf.frames / perf.t;
  perf.t = 0; perf.frames = 0;
  let next = pixelRatio;
  if (fps < 30) next = Math.max(MIN_PR, pixelRatio - 0.15);
  else if (fps > 52) next = Math.min(MAX_PR, pixelRatio + 0.1);
  if (Math.abs(next - pixelRatio) > 0.01) { pixelRatio = next; renderer.setPixelRatio(pixelRatio); renderer.setSize(window.innerWidth, window.innerHeight); }
}
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
// 空：天候ごとに色・雲・太陽の強さをユニフォームで切り替える
const skyU = {
  sun: { value: SUN_DIR }, hor: { value: new THREE.Color() }, mid: { value: new THREE.Color() }, top: { value: new THREE.Color() },
  glow: { value: new THREE.Color() }, cloudCol: { value: new THREE.Color() }, cloudAmt: { value: 0 }, cloudCover: { value: 0 },
  ground: { value: new THREE.Color() },
};
const sky = new THREE.Mesh(new THREE.SphereGeometry(700, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false, uniforms: skyU,
  vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix*vec4(position,1.); gl_Position = projectionMatrix*p; }',
  fragmentShader: `varying vec3 vDir; uniform vec3 sun, hor, mid, top, glow, cloudCol, ground; uniform float cloudAmt, cloudCover;
    float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
    float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y); }
    void main(){
      float y = vDir.y;
      vec3 c = mix(hor, mid, smoothstep(0.0, 0.25, y)); c = mix(c, top, smoothstep(0.25, 0.9, y));
      float s = max(dot(vDir, sun), 0.0);
      c += glow * (pow(s, 6.0) * 0.35 + pow(s, 80.0) * 0.9 + pow(s, 900.0) * 6.0);
      vec2 uv = vDir.xz / max(0.08, y + 0.15) * 1.6;
      float cl = n(uv) * 0.5 + n(uv * 2.3) * 0.3 + n(uv * 5.1) * 0.2;
      float m = smoothstep(cloudCover, cloudCover + 0.3, cl) * smoothstep(0.02, 0.3, y) * cloudAmt;
      c = mix(c, cloudCol * (0.85 + 0.3 * n(uv * 3.7)), m);
      c = mix(ground, c, smoothstep(-0.05, 0.06, y));
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
sun.shadow.mapSize.set(QUALITY[quality].shadowSize, QUALITY[quality].shadowSize);
const SH = 60;
Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 1, far: 300 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);

function setQuality(name) {
  const Q = QUALITY[name];
  if (!Q) return;
  quality = name;
  MAX_PR = Q.max; MIN_PR = Q.min;
  pixelRatio = Q.max;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (renderer.shadowMap.enabled !== Q.shadows || sun.shadow.mapSize.x !== Q.shadowSize) {
    renderer.shadowMap.enabled = Q.shadows;
    sun.shadow.mapSize.set(Q.shadowSize, Q.shadowSize);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    scene.traverse((o) => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; }); });
  }
  document.querySelectorAll('[data-quality]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.quality === name)));
  try { localStorage.setItem('rubble-quality', name); } catch (_) { /* 保存できない環境 */ }
}

// 天候プリセット：くもり（煙で霞んだ夕方）／晴れ（高い太陽と青空、乾いた空気）
const WEATHER = {
  cloudy: {
    sun: [-0.55, 0.32, 0.45], hor: 0x9e8c78, mid: 0x808080, top: 0x4d545e, glow: 0xff9e4d, cloudCol: 0x5c5a58, cloudAmt: 0.28, cloudCover: 0.45,
    ground: 0x6b5e52, sunCol: 0xffcf98, sunI: 2.6, hemiSky: 0xbcb8ae, hemiGround: 0x4d4338, hemiI: 1.25, fog: 0x8c8376, fogD: 0.0088, exposure: 1.0,
  },
  sunny: {
    sun: [-0.42, 0.66, 0.36], hor: 0xc9d3dc, mid: 0x86a9d4, top: 0x3d6fb6, glow: 0xfff2d6, cloudCol: 0xf4f2ee, cloudAmt: 0.85, cloudCover: 0.58,
    ground: 0x8a7e6e, sunCol: 0xfff1dc, sunI: 3.4, hemiSky: 0xb3cbe8, hemiGround: 0x6e604c, hemiI: 1.05, fog: 0xb7c2cc, fogD: 0.0042, exposure: 1.02,
  },
};
let weather = 'cloudy';
function applyWeather(name) {
  const W = WEATHER[name] || WEATHER.cloudy;
  weather = name;
  SUN_DIR.set(...W.sun).normalize();
  for (const k of ['hor', 'mid', 'top', 'glow', 'cloudCol', 'ground']) skyU[k].value.set(W[k]);
  skyU.cloudAmt.value = W.cloudAmt; skyU.cloudCover.value = W.cloudCover;
  sun.color.set(W.sunCol); sun.intensity = W.sunI;
  hemi.color.set(W.hemiSky); hemi.groundColor.set(W.hemiGround); hemi.intensity = W.hemiI;
  scene.fog.color.set(W.fog); scene.fog.density = W.fogD;
  renderer.toneMappingExposure = W.exposure;
  if (typeof vmSun !== 'undefined') { vmSun.position.copy(SUN_DIR).multiplyScalar(10); vmSun.intensity = name === 'sunny' ? 2.4 : 1.8; }
  document.querySelectorAll('[data-weather]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.weather === name)));
  try { localStorage.setItem('rubble-weather', name); } catch (_) { /* 保存できない環境 */ }
}

// 一人称の銃は別パスで描く（壁にめり込まない）
const vmScene = new THREE.Scene();
const vmCamera = new THREE.PerspectiveCamera(72, camera.aspect, 0.01, 10);
vmScene.add(new THREE.HemisphereLight(0xc8c4ba, 0x4a4036, 1.7));
// 黒い手袋・袖が黒い銃に溶け込まないよう、カメラ側から弱い補助光
const vmFill = new THREE.PointLight(0xfff1dd, 0.7, 3, 1.5);
vmCamera.add(vmFill); vmFill.position.set(-0.25, 0.25, 0.2); vmScene.add(vmCamera);
const vmSun = new THREE.DirectionalLight(0xffd8a8, 1.8);
vmSun.position.copy(SUN_DIR).multiplyScalar(10);
vmScene.add(vmSun);
// 金属（銃・装備）の映り込み用の環境マップ
const envMap = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
vmScene.environment = envMap;
let savedWeather = 'cloudy';
try { savedWeather = localStorage.getItem('rubble-weather') || 'cloudy'; } catch (_) { /* 読めない環境 */ }
applyWeather(QS.get('weather') || savedWeather);
document.querySelectorAll('[data-weather]').forEach((b) => b.addEventListener('click', () => applyWeather(b.dataset.weather)));
document.querySelectorAll('[data-quality]').forEach((b) => b.addEventListener('click', () => setQuality(b.dataset.quality)));
setQuality(quality);
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

let world, nav, fx, audio, player, enemies, avatar;
const state = { thirdPerson: false, mode: 'loading', wave: 0, kills: 0, waveTimer: 0, time: 0, practice: false, attractT: 0 };

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
  const loadGLB = (url, w0, w1) => url.split('?')[0].endsWith('.json') ? loadEmbedded(loader, url, (p) => progress(w0 + (w1 - w0) * p))
    : new Promise((res, rej) => loader.load(url, res, (e) => { if (e.total) progress(w0 + (w1 - w0) * e.loaded / e.total); }, rej));
  // 配信先が .glb を扱えない場合は埋め込み glTF（.json）を使う（window.__ASSET_EXT で指定）
  const ext = window.__ASSET_EXT || '.glb';
  // モデルを更新したら古いキャッシュを使わないよう版を付ける
  const ASSET_V = '?v=20261103a';
  const [soldier, vm, av] = await Promise.all([loadGLB('assets/soldier' + ext + ASSET_V, 0.55, 0.85), loadGLB('assets/viewmodel' + ext + ASSET_V, 0.85, 0.9),
    loadGLB('assets/avatar' + ext + ASSET_V, 0.9, 0.98)]);
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
  const vmParts = rigViewmodel(vm.scene);   // 本体・マガジン・左腕・右腕に分けてリロードで動かす
  player = new Player(camera, world, vmRoot, fx, audio);
  player.vmParts = vmParts;
  player.onShoot = shoot;
  player.onFired = (o) => enemies.noise(o, 60);
  soldier.scene.traverse((o) => {
    if (o.isMesh) { o.material.envMap = envMap; o.material.envMapIntensity = 0.45; }
  });
  enemies = new EnemyManager(scene, soldier, world, nav, fx, audio, player);
  av.scene.traverse((o) => { if (o.isMesh) { o.material.envMap = envMap; o.material.envMapIntensity = 0.45; } });
  avatar = new Avatar(scene, av);
  // 三人称のときは銃口をアバターの銃から
  const fpMuzzle = player.muzzleWorld.bind(player);
  player.muzzleWorld = () => (state.thirdPerson && avatar.muzzle()) || fpMuzzle();
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
  if (state.thirdPerson) origin = camera.position.clone();   // 三人称：画面中央（カメラ）から
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
  if (e.code === 'KeyV') toggleView();
  if (e.code === 'KeyC' || e.code === 'ControlLeft') player.crouch = !player.crouch;
  if (e.code === 'KeyZ') player.stance = player.stance === 2 ? 0 : 2;
  if (e.code === 'KeyX') player.cycleStance();
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

// 見学モードだけ三人称視点に切り替えられる
function toggleView(force) {
  if (!state.practice && !force) { banner('三人称視点は見学モードで使えます', 1.8); return; }
  state.thirdPerson = force === undefined ? !state.thirdPerson : force;
  avatar.root.visible = state.thirdPerson;
  document.body.classList.toggle('third', state.thirdPerson);
  if (force === undefined) banner(state.thirdPerson ? '三人称視点' : '一人称視点', 1.2);
}
window.__toggleView = toggleView;

const _camTmp = new THREE.Vector3();
function thirdPersonCamera(dt, sprint) {
  avatar.update(dt, player, sprint);
  const pivot = player.pos.clone().add(new THREE.Vector3(0, Math.max(0.6, player.eye * 0.95) + 0.12, 0));
  const fwd = player.forward;
  const right = new THREE.Vector3(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
  const dist = 2.9 - player.ads * 1.4;
  const want = pivot.clone().addScaledVector(fwd, -dist).addScaledVector(right, 0.55);
  // 壁に埋まらないようにカメラを手前に寄せる
  const dir = _camTmp.subVectors(want, pivot);
  const len = dir.length();
  dir.normalize();
  const hit = world.raycast(pivot, dir, len);
  const d = hit ? Math.max(0.3, hit.t - 0.25) : len;
  camera.position.copy(pivot).addScaledVector(dir, d);
}

function startGame(practice) {
  audio.start();
  state.practice = practice;
  state.wave = 0; state.kills = 0; state.time = 0; state.waveTimer = 1.5;
  for (const e of enemies.list) e.dispose();
  enemies.list.length = 0;
  enemies.alertPos = null;
  Object.assign(player, { health: 100, alive: true, mag: 30, reserve: 210, reloading: 0, stance: 0, burstLeft: 0, shake: 0, recoil: 0 });
  player.pos.set(0, 0.16, 22);
  player.vel.set(0, 0, 0);
  player.yaw = 0; player.pitch = 0;
  ui.menu.hidden = true; ui.over.hidden = true; ui.pause.hidden = true; ui.hud.hidden = false;
  touch?.reset();
  toggleView(false);
  document.body.classList.toggle('practice', practice);
  state.mode = 'play';
  if (practice) {
    // 見学モード：敵は撃ってこない。周囲に配置して観察できる
    for (let i = 0; i < 8; i++) enemies.spawn(nav.nodes[(i * 5 + 3) % nav.nodes.length].clone());
    for (const e of enemies.list) e.passive = true;
    banner(TOUCH ? '見学モード：「視点」ボタンで三人称' : '見学モード：V キーで三人称視点');
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
  ui.mode.textContent = { semi: 'SEMI', burst: '3-RND BURST', auto: 'AUTO' }[player.mode] + (player.prone ? ' · 伏せ' : player.crouch ? ' · しゃがみ' : '');
  touch?.sync();
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
  adaptResolution(dt);
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
    if (avatar) avatar.root.visible = false;
    enemies.update(dt);
  } else if (state.mode === 'play') {
    player.update(dt);
    if (state.thirdPerson) thirdPersonCamera(dt, player.lastSprint);
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
  if ((state.mode === 'play' || state.mode === 'paused') && !state.thirdPerson) {
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
