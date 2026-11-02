// 手続き生成テクスチャ（Canvas 2D）。高さマップから法線マップも作る。
import * as THREE from 'three';

let seed = 1337;
export function rand() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}
export function setSeed(s) { seed = s; }
const R = (a, b) => a + (b - a) * rand();

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')];
}

// 値ノイズ（タイル可能）
function noiseLayer(ctx, size, cells, alpha, light, dark) {
  const g = [];
  for (let i = 0; i < cells * cells; i++) g.push(rand());
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells, fy = (y / size) * cells;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = g[(y0 % cells) * cells + (x0 % cells)], b = g[(y0 % cells) * cells + ((x0 + 1) % cells)];
      const c = g[((y0 + 1) % cells) * cells + (x0 % cells)], e = g[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
      const v = (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + e * sx) * sy;
      const k = (y * size + x) * 4;
      const col = v > 0.5 ? light : dark;
      const s = Math.abs(v - 0.5) * 2 * alpha;
      d[k] = d[k] * (1 - s) + col[0] * s;
      d[k + 1] = d[k + 1] * (1 - s) + col[1] * s;
      d[k + 2] = d[k + 2] * (1 - s) + col[2] * s;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function speckle(ctx, size, n, colors, rmin, rmax, alpha) {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = colors[Math.floor(rand() * colors.length)];
    ctx.globalAlpha = alpha * R(0.4, 1);
    const r = R(rmin, rmax);
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function crack(ctx, x, y, len, width, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x, y);
  let a = rand() * Math.PI * 2;
  for (let i = 0; i < len; i++) {
    a += R(-0.6, 0.6);
    x += Math.cos(a) * 6; y += Math.sin(a) * 6;
    ctx.lineTo(x, y);
    if (rand() < 0.08) crack(ctx, x, y, len / 3, width * 0.6, color);
  }
  ctx.stroke();
}

// 高さ（グレースケール canvas）→ 法線マップ
function normalFromHeight(hc, strength) {
  const size = hc.width;
  const src = hc.getContext('2d').getImageData(0, 0, size, size).data;
  const [c, ctx] = canvas(size);
  const out = ctx.createImageData(size, size);
  const h = (x, y) => src[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
      let nx = -dx, ny = dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      const k = (y * size + x) * 4;
      out.data[k] = (nx / l * 0.5 + 0.5) * 255;
      out.data[k + 1] = (ny / l * 0.5 + 0.5) * 255;
      out.data[k + 2] = (nz / l * 0.5 + 0.5) * 255;
      out.data[k + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

function tex(c, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------- 素材

// 漆喰：汚れ・雨だれ・剥落（下地のレンガが覗く）・ひび
function plaster(size = 512) {
  const [c, ctx] = canvas(size);
  const [hc, hctx] = canvas(size);
  ctx.fillStyle = '#d8d2c4'; ctx.fillRect(0, 0, size, size);
  hctx.fillStyle = '#808080'; hctx.fillRect(0, 0, size, size);
  noiseLayer(ctx, size, 8, 0.25, [240, 236, 226], [150, 142, 128]);
  noiseLayer(ctx, size, 32, 0.12, [255, 255, 250], [120, 112, 100]);
  speckle(ctx, size, 3000, ['#6e675c', '#fffaf0', '#9a8f7c'], 0.4, 1.4, 0.35);
  // 雨だれ
  for (let i = 0; i < 40; i++) {
    const x = rand() * size, w = R(2, 10), l = R(40, size * 0.8);
    const g = ctx.createLinearGradient(0, 0, 0, l);
    g.addColorStop(0, 'rgba(60,55,45,0.28)'); g.addColorStop(1, 'rgba(60,55,45,0)');
    ctx.fillStyle = g; ctx.fillRect(x, 0, w, l);
  }
  hctx.drawImage(c, 0, 0);
  // 剥落
  for (let i = 0; i < 7; i++) {
    const x = rand() * size, y = rand() * size, r = R(14, 46);
    ctx.save(); ctx.beginPath();
    for (let a = 0; a < 6.28; a += 0.5) ctx.lineTo(x + Math.cos(a) * r * R(0.6, 1.2), y + Math.sin(a) * r * R(0.6, 1.2));
    ctx.closePath(); ctx.clip();
    for (let by = y - r; by < y + r; by += 9) for (let bx = x - r + ((by / 9) % 2) * 10; bx < x + r; bx += 20) {
      ctx.fillStyle = `rgb(${R(120, 160)},${R(60, 80)},${R(45, 60)})`; ctx.fillRect(bx, by, 19, 8);
    }
    ctx.restore();
    hctx.save(); hctx.fillStyle = '#4a4a4a'; hctx.beginPath(); hctx.arc(x, y, r * 0.9, 0, 6.28); hctx.fill(); hctx.restore();
  }
  for (let i = 0; i < 10; i++) {
    const x = rand() * size, y = rand() * size;
    crack(ctx, x, y, 30, 1.2, 'rgba(50,45,40,0.6)');
  }
  return { map: tex(c), normalMap: tex(normalFromHeight(hc, 2.0), false) };
}

// レンガ（2m×2m を 1 タイル）
function brick(size = 512) {
  const [c, ctx] = canvas(size);
  const [hc, hctx] = canvas(size);
  const rows = 26, cols = 9;
  const rh = size / rows, cw = size / cols;
  ctx.fillStyle = '#6b6157'; ctx.fillRect(0, 0, size, size);
  hctx.fillStyle = '#303030'; hctx.fillRect(0, 0, size, size);
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * cw * 0.5;
    for (let k = -1; k < cols + 1; k++) {
      const x = k * cw + off, y = r * rh;
      const t = rand();
      const base = t < 0.15 ? [90, 45, 35] : t < 0.3 ? [150, 85, 60] : [R(120, 150), R(55, 70), R(40, 50)];
      ctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
      ctx.fillRect(x + 1.5, y + 1.5, cw - 3, rh - 3);
      hctx.fillStyle = `rgb(${R(150, 200)},${R(150, 200)},${R(150, 200)})`;
      hctx.fillRect(x + 1.5, y + 1.5, cw - 3, rh - 3);
    }
  }
  noiseLayer(ctx, size, 16, 0.18, [200, 180, 160], [40, 30, 25]);
  speckle(ctx, size, 2500, ['#2b211c', '#c9b49b'], 0.4, 1.2, 0.4);
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, 'rgba(20,18,16,0.25)'); g.addColorStop(0.5, 'rgba(20,18,16,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  return { map: tex(c), normalMap: tex(normalFromHeight(hc, 3.5), false) };
}

// 石積み（1 階の基壇・ルスティカ）2m×2m
function stone(size = 512) {
  const [c, ctx] = canvas(size);
  const [hc, hctx] = canvas(size);
  const rows = 6, cols = 3;
  const rh = size / rows, cw = size / cols;
  ctx.fillStyle = '#4c4842'; ctx.fillRect(0, 0, size, size);
  hctx.fillStyle = '#202020'; hctx.fillRect(0, 0, size, size);
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * cw * 0.5;
    for (let k = -1; k < cols + 1; k++) {
      const x = k * cw + off, y = r * rh;
      const v = R(150, 185);
      ctx.fillStyle = `rgb(${v},${v - 6},${v - 16})`;
      ctx.fillRect(x + 4, y + 4, cw - 8, rh - 8);
      const hg = hctx.createRadialGradient(x + cw / 2, y + rh / 2, 2, x + cw / 2, y + rh / 2, cw * 0.6);
      hg.addColorStop(0, '#e0e0e0'); hg.addColorStop(1, '#909090');
      hctx.fillStyle = hg; hctx.fillRect(x + 4, y + 4, cw - 8, rh - 8);
    }
  }
  noiseLayer(ctx, size, 12, 0.25, [210, 205, 195], [70, 65, 60]);
  speckle(ctx, size, 4000, ['#3c3833', '#e8e2d6', '#7a746a'], 0.4, 1.6, 0.4);
  return { map: tex(c), normalMap: tex(normalFromHeight(hc, 3.0), false) };
}

function concrete(size = 512) {
  const [c, ctx] = canvas(size);
  const [hc, hctx] = canvas(size);
  ctx.fillStyle = '#8d8a84'; ctx.fillRect(0, 0, size, size);
  noiseLayer(ctx, size, 6, 0.3, [190, 186, 178], [80, 78, 74]);
  noiseLayer(ctx, size, 40, 0.15, [200, 200, 195], [70, 70, 68]);
  speckle(ctx, size, 6000, ['#5a5752', '#bdb9b0', '#3c3a37'], 0.3, 1.3, 0.5);
  ctx.strokeStyle = 'rgba(40,40,38,0.35)'; ctx.lineWidth = 2;
  for (let y = 64; y < size; y += 128) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke(); }
  for (let i = 0; i < 8; i++) crack(ctx, rand() * size, rand() * size, 25, 1, 'rgba(30,30,28,0.55)');
  hctx.drawImage(c, 0, 0);
  return { map: tex(c), normalMap: tex(normalFromHeight(hc, 1.5), false) };
}

// アスファルト（4m タイル）：骨材・ひび・補修跡・タイヤ痕
function asphalt(size = 1024) {
  const [c, ctx] = canvas(size);
  const [hc, hctx] = canvas(size);
  ctx.fillStyle = '#3d3c3a'; ctx.fillRect(0, 0, size, size);
  noiseLayer(ctx, size, 8, 0.22, [90, 88, 84], [28, 27, 26]);
  speckle(ctx, size, 26000, ['#6e6c68', '#252423', '#8a8780', '#4c4a46'], 0.4, 1.6, 0.55);
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = `rgba(${R(30, 50)},${R(30, 50)},${R(30, 50)},0.6)`;
    ctx.fillRect(rand() * size, rand() * size, R(60, 200), R(40, 160));
  }
  for (let i = 0; i < 18; i++) crack(ctx, rand() * size, rand() * size, 40, R(1, 2.5), 'rgba(15,15,14,0.8)');
  speckle(ctx, size, 40, ['#4a4033'], 10, 30, 0.25);
  hctx.drawImage(c, 0, 0);
  return { map: tex(c), normalMap: tex(normalFromHeight(hc, 2.5), false) };
}

// 歩道の石畳（敷石 0.5m、2m タイル）
function pavers(size = 512) {
  const [c, ctx] = canvas(size);
  const [hc, hctx] = canvas(size);
  const n = 4, s = size / n;
  ctx.fillStyle = '#4a4744'; ctx.fillRect(0, 0, size, size);
  hctx.fillStyle = '#202020'; hctx.fillRect(0, 0, size, size);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = R(115, 150);
    ctx.fillStyle = `rgb(${v},${v - 4},${v - 10})`;
    ctx.fillRect(x * s + 3, y * s + 3, s - 6, s - 6);
    const hv = R(160, 210);
    hctx.fillStyle = `rgb(${hv},${hv},${hv})`;
    hctx.fillRect(x * s + 3, y * s + 3, s - 6, s - 6);
    if (rand() < 0.2) crack(ctx, x * s + s / 2, y * s + s / 2, 10, 1.5, 'rgba(30,30,28,0.8)');
  }
  noiseLayer(ctx, size, 8, 0.2, [180, 175, 168], [50, 48, 45]);
  speckle(ctx, size, 3000, ['#2f2d2a', '#a8a399'], 0.4, 1.4, 0.4);
  return { map: tex(c), normalMap: tex(normalFromHeight(hc, 2.5), false) };
}

// 瓦屋根（2m タイル）
function rooftiles(size = 512) {
  const [c, ctx] = canvas(size);
  const [hc, hctx] = canvas(size);
  const rows = 14, cols = 10;
  const rh = size / rows, cw = size / cols;
  for (let r = 0; r < rows; r++) for (let k = -1; k <= cols; k++) {
    const x = k * cw + (r % 2) * cw / 2, y = r * rh;
    const v = R(0.8, 1.1);
    const gr = ctx.createLinearGradient(0, y, 0, y + rh);
    gr.addColorStop(0, `rgb(${110 * v},${48 * v},${36 * v})`); gr.addColorStop(1, `rgb(${70 * v},${30 * v},${24 * v})`);
    ctx.fillStyle = gr; ctx.fillRect(x + 1, y, cw - 2, rh);
    const hg = hctx.createLinearGradient(x, 0, x + cw, 0);
    hg.addColorStop(0, '#606060'); hg.addColorStop(0.5, '#e0e0e0'); hg.addColorStop(1, '#606060');
    hctx.fillStyle = hg; hctx.fillRect(x + 1, y, cw - 2, rh);
  }
  noiseLayer(ctx, size, 8, 0.35, [120, 110, 100], [20, 20, 20]);
  speckle(ctx, size, 1500, ['#1e1a17', '#6b6b4f'], 0.5, 2, 0.4);
  return { map: tex(c), normalMap: tex(normalFromHeight(hc, 2.5), false) };
}

function wood(size = 256) {
  const [c, ctx] = canvas(size);
  ctx.fillStyle = '#5a4430'; ctx.fillRect(0, 0, size, size);
  for (let y = 0; y < size; y += 32) {
    ctx.fillStyle = `rgb(${R(70, 100)},${R(50, 70)},${R(32, 45)})`; ctx.fillRect(0, y + 1, size, 30);
    for (let i = 0; i < 30; i++) {
      ctx.strokeStyle = 'rgba(30,20,10,0.25)'; ctx.beginPath();
      const yy = y + R(2, 30); ctx.moveTo(0, yy); ctx.bezierCurveTo(size / 3, yy + R(-3, 3), size * 2 / 3, yy + R(-3, 3), size, yy); ctx.stroke();
    }
  }
  noiseLayer(ctx, size, 6, 0.3, [60, 50, 40], [15, 12, 10]);
  return { map: tex(c) };
}

// 焼けた車体：錆・煤・剥げた塗装
function rust(size = 512) {
  const [c, ctx] = canvas(size);
  const [hc, hctx] = canvas(size);
  ctx.fillStyle = '#4a2f22'; ctx.fillRect(0, 0, size, size);
  noiseLayer(ctx, size, 10, 0.45, [140, 70, 35], [25, 20, 18]);
  noiseLayer(ctx, size, 40, 0.3, [170, 95, 50], [20, 18, 16]);
  for (let i = 0; i < 30; i++) {
    ctx.fillStyle = `rgba(${R(60, 80)},${R(70, 85)},${R(55, 65)},${R(0.3, 0.7)})`;
    ctx.beginPath(); ctx.arc(rand() * size, rand() * size, R(10, 40), 0, 6.28); ctx.fill();
  }
  speckle(ctx, size, 5000, ['#120e0c', '#a05a2a', '#2c2420'], 0.5, 2, 0.5);
  hctx.drawImage(c, 0, 0);
  return { map: tex(c), normalMap: tex(normalFromHeight(hc, 2), false) };
}

function cloth(size = 256, base = [150, 135, 100]) {
  const [c, ctx] = canvas(size);
  ctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`; ctx.fillRect(0, 0, size, size);
  for (let y = 0; y < size; y += 2) { ctx.fillStyle = 'rgba(0,0,0,0.06)'; ctx.fillRect(0, y, size, 1); }
  for (let x = 0; x < size; x += 2) { ctx.fillStyle = 'rgba(255,255,255,0.04)'; ctx.fillRect(x, 0, 1, size); }
  noiseLayer(ctx, size, 6, 0.3, [190, 180, 150], [60, 55, 40]);
  speckle(ctx, size, 800, ['#3a3226'], 0.5, 2, 0.3);
  return { map: tex(c) };
}

// 瓦礫・土の地面
function rubble(size = 512) {
  const [c, ctx] = canvas(size);
  const [hc, hctx] = canvas(size);
  ctx.fillStyle = '#6e665b'; ctx.fillRect(0, 0, size, size);
  hctx.fillStyle = '#404040'; hctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 900; i++) {
    const x = rand() * size, y = rand() * size, w = R(4, 26), h = R(3, 14);
    const t = rand();
    ctx.fillStyle = t < 0.35 ? `rgb(${R(110, 150)},${R(55, 70)},${R(40, 55)})` : t < 0.7 ? `rgb(${R(140, 190)},${R(135, 180)},${R(120, 165)})` : `rgb(${R(60, 90)},${R(55, 80)},${R(50, 70)})`;
    ctx.save(); ctx.translate(x, y); ctx.rotate(rand() * 3.14); ctx.fillRect(-w / 2, -h / 2, w, h); ctx.restore();
    hctx.save(); hctx.translate(x, y); hctx.rotate(rand() * 3.14);
    hctx.fillStyle = `rgb(${R(120, 230)},${R(120, 230)},${R(120, 230)})`; hctx.fillRect(-w / 2, -h / 2, w, h); hctx.restore();
  }
  noiseLayer(ctx, size, 8, 0.3, [150, 140, 125], [40, 36, 30]);
  speckle(ctx, size, 5000, ['#2a2520', '#b0a690'], 0.4, 1.6, 0.5);
  return { map: tex(c), normalMap: tex(normalFromHeight(hc, 3), false) };
}

// 窓の奥・屋内の暗い壁
function interior(size = 256) {
  const [c, ctx] = canvas(size);
  ctx.fillStyle = '#4a443c'; ctx.fillRect(0, 0, size, size);
  noiseLayer(ctx, size, 6, 0.4, [120, 110, 95], [20, 18, 15]);
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = `rgba(${R(60, 120)},${R(60, 100)},${R(50, 80)},0.35)`;
    ctx.fillRect(rand() * size, 0, R(20, 60), size);   // 壁紙の名残
  }
  speckle(ctx, size, 1500, ['#1a1714'], 1, 3, 0.4);
  return { map: tex(c) };
}

// 看板アトラス（4×4）
const SIGNS = ['BÄCKEREI', 'APOTHEKE', 'HOTEL ADLER', 'KAFFEEHAUS', 'SCHNEIDEREI', 'BUCHHANDLUNG',
  'METZGEREI', 'KINO ROXY', 'POST', 'GASTHAUS', 'UHRMACHER', 'MÖBEL KRAUS', 'DROGERIE', 'BANK', 'FRISEUR', 'TABAK'];
function signs() {
  const [c, ctx] = canvas(1024);
  for (let i = 0; i < 16; i++) {
    const x = (i % 4) * 256;
    const yy = Math.floor(i / 4) * 256;
    const bg = ['#2b3a2c', '#3a2a22', '#1f2a36', '#3b3527', '#2a2a2a'][i % 5];
    ctx.fillStyle = bg; ctx.fillRect(x, yy, 256, 256);
    ctx.fillStyle = '#c9b37a';
    ctx.font = `bold ${SIGNS[i].length > 9 ? 30 : 38}px Georgia, serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let r = 0; r < 4; r++) ctx.fillText(SIGNS[i], x + 128, yy + 32 + r * 64);
  }
  speckle(ctx, 1024, 6000, ['#111', '#555'], 0.5, 3, 0.35);
  return { map: tex(c) };
}

// 煤・焦げ跡（透過デカール）
function soot(size = 256) {
  const [c, ctx] = canvas(size);
  const g = ctx.createRadialGradient(size / 2, size * 0.75, 4, size / 2, size * 0.6, size * 0.55);
  g.addColorStop(0, 'rgba(10,9,8,0.95)'); g.addColorStop(0.5, 'rgba(15,13,12,0.6)'); g.addColorStop(1, 'rgba(20,18,16,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  const t = tex(c); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return { map: t };
}

// 柔らかい煙・炎・閃光スプライト
function smokeSprite(size = 128) {
  const [c, ctx] = canvas(size);
  for (let i = 0; i < 18; i++) {
    const x = size / 2 + R(-20, 20), y = size / 2 + R(-20, 20), r = R(20, 50);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.22)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  }
  const t = tex(c); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t;
}
function flameSprite(size = 128) {
  const [c, ctx] = canvas(size);
  const g = ctx.createRadialGradient(size / 2, size * 0.65, 2, size / 2, size * 0.55, size * 0.5);
  g.addColorStop(0, 'rgba(255,240,200,1)'); g.addColorStop(0.3, 'rgba(255,160,50,0.9)');
  g.addColorStop(0.7, 'rgba(200,60,10,0.4)'); g.addColorStop(1, 'rgba(120,20,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  const t = tex(c); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t;
}
function flashSprite(size = 128) {
  const [c, ctx] = canvas(size);
  ctx.translate(size / 2, size / 2);
  for (let i = 0; i < 6; i++) {
    ctx.rotate(Math.PI / 3 + R(-0.2, 0.2));
    const g = ctx.createLinearGradient(0, 0, size / 2, 0);
    g.addColorStop(0, 'rgba(255,240,200,1)'); g.addColorStop(1, 'rgba(255,140,40,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(size / 2 * R(0.6, 1), 0); ctx.lineTo(0, 5); ctx.fill();
  }
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, size / 3);
  g.addColorStop(0, 'rgba(255,250,230,1)'); g.addColorStop(1, 'rgba(255,170,60,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, size / 3, 0, 6.28); ctx.fill();
  const t = tex(c); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t;
}
function impactDecal(size = 64) {
  const [c, ctx] = canvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.95)'); g.addColorStop(0.25, 'rgba(20,18,15,0.8)'); g.addColorStop(1, 'rgba(60,55,50,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  const t = tex(c); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t;
}

// 戦時ポスター（壁の貼り紙）
function posters() {
  const [c, ctx] = canvas(512);
  const texts = [['AUSGANGSSPERRE', '22 UHR'], ['WASSER', 'ABKOCHEN!'], ['VERMISST', 'MELDET EUCH'], ['LUFTSCHUTZ', 'KELLER →']];
  for (let i = 0; i < 4; i++) {
    const x = (i % 2) * 256, y = Math.floor(i / 2) * 256;
    ctx.fillStyle = ['#d8cfb5', '#c9b98f', '#e0d9c6', '#b8a988'][i]; ctx.fillRect(x + 6, y + 6, 244, 244);
    ctx.fillStyle = i === 1 ? '#7a1f14' : '#1c1a17';
    ctx.font = 'bold 30px Georgia, serif'; ctx.textAlign = 'center';
    ctx.fillText(texts[i][0], x + 128, y + 90); ctx.font = 'bold 26px Georgia, serif'; ctx.fillText(texts[i][1], x + 128, y + 140);
    for (let k = 0; k < 6; k++) { ctx.fillStyle = 'rgba(30,28,25,0.5)'; ctx.fillRect(x + 40, y + 170 + k * 10, R(100, 176), 3); }
  }
  noiseLayer(ctx, 512, 8, 0.3, [230, 220, 200], [80, 70, 55]);
  return { map: tex(c) };
}

export function buildTextures() {
  setSeed(20251102);
  return {
    plaster: plaster(), brick: brick(), stone: stone(), concrete: concrete(), asphalt: asphalt(),
    pavers: pavers(), roof: rooftiles(), wood: wood(), rust: rust(), sandbag: cloth(256, [150, 132, 96]),
    awning: cloth(256, [120, 40, 32]), rubble: rubble(), interior: interior(), signs: signs(), soot: soot(),
    posters: posters(), smoke: smokeSprite(), flame: flameSprite(), flash: flashSprite(), impact: impactDecal(),
  };
}
