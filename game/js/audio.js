// Web Audio による効果音の合成（外部音源なし）
export class Audio {
  constructor() {
    this.ctx = null;
    this.enabled = false;
  }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain();
    this.master.gain.value = 0.7;
    this.master.connect(ctx.destination);
    // 市街地の反響（生成したインパルス応答）
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(2.6, 2.2);
    this.revGain = ctx.createGain();
    this.revGain.gain.value = 0.35;
    this.reverb.connect(this.revGain).connect(this.master);
    this.noise = this.noiseBuffer(2);
    this.enabled = true;
    this.ambience();
  }

  noiseBuffer(sec) {
    const ctx = this.ctx;
    const b = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  impulse(sec, decay) {
    const ctx = this.ctx;
    const len = ctx.sampleRate * sec;
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) {
        // 初期反射（建物の壁）＋拡散残響
        const t = i / len;
        const early = (i % Math.floor(ctx.sampleRate * (0.031 + c * 0.007)) < 30) ? 0.6 : 0;
        d[i] = ((Math.random() * 2 - 1) + early * (1 - t)) * Math.pow(1 - t, decay);
      }
    }
    return b;
  }

  // 出力ノード（距離減衰・左右定位）
  out(gain, pan = 0, wet = 0.35) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = gain;
    let node = g;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      node = p;
    }
    node.connect(this.master);
    const w = ctx.createGain();
    w.gain.value = wet;
    g.connect(w).connect(this.reverb);
    return g;
  }

  // 銃声：鋭いクラック＋低い衝撃＋ノイズの減衰。distance で高域が減る
  gunshot(distance = 0, pan = 0, kind = 'player') {
    if (!this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const vol = kind === 'player' ? 0.9 : Math.min(0.8, 9 / (distance + 6));
    const dest = this.out(vol, pan, kind === 'player' ? 0.45 : Math.min(0.9, 0.3 + distance / 80));
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.max(900, 9000 - distance * 90);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(1, t + 0.002);
    env.gain.exponentialRampToValueAtTime(0.25, t + 0.04);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    src.connect(lp).connect(env).connect(dest);
    src.start(t, Math.random()); src.stop(t + 0.4);
    // 低域の衝撃
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    const og = ctx.createGain();
    og.gain.setValueAtTime(kind === 'player' ? 0.9 : 0.5, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(og).connect(dest);
    o.start(t); o.stop(t + 0.2);
  }

  click(freq = 1800, dur = 0.03, vol = 0.3) {
    if (!this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square'; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.out(0.6, 0, 0.1)); o.start(t); o.stop(t + dur + 0.01);
  }

  reload() {
    if (!this.enabled) return;
    [[0, 900, 0.05], [0.45, 600, 0.06], [1.5, 1300, 0.04], [1.85, 700, 0.07], [2.1, 1500, 0.03]].forEach(([d, f, l]) =>
      setTimeout(() => this.click(f, l, 0.35), d * 1000));
  }

  hit(head) { this.click(head ? 2600 : 1900, 0.05, 0.25); }

  hurt() {
    if (!this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const s = ctx.createBufferSource(); s.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 400;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.7, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    s.connect(f).connect(g).connect(this.out(1, 0, 0.1)); s.start(t, Math.random()); s.stop(t + 0.3);
  }

  step(vol = 0.12) {
    if (!this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const s = ctx.createBufferSource(); s.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 300 + Math.random() * 500; f.Q.value = 1.2;
    const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    s.connect(f).connect(g).connect(this.out(1, 0, 0.05)); s.start(t, Math.random()); s.stop(t + 0.1);
  }

  // 風・遠くの砲撃・機関銃
  ambience() {
    const ctx = this.ctx;
    const s = ctx.createBufferSource(); s.buffer = this.noise; s.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 380;
    const g = ctx.createGain(); g.gain.value = 0.07;
    s.connect(f).connect(g).connect(this.master); s.start();
    const boom = () => {
      if (!this.enabled) return;
      const t = ctx.currentTime;
      const n = ctx.createBufferSource(); n.buffer = this.noise;
      const lf = ctx.createBiquadFilter(); lf.type = 'lowpass'; lf.frequency.value = 160;
      const eg = ctx.createGain(); eg.gain.setValueAtTime(0.0001, t);
      eg.gain.exponentialRampToValueAtTime(0.6, t + 0.05); eg.gain.exponentialRampToValueAtTime(0.0001, t + 2.5);
      n.connect(lf).connect(eg).connect(this.out(0.6, Math.random() * 2 - 1, 0.8)); n.start(t, Math.random()); n.stop(t + 2.6);
      setTimeout(boom, 7000 + Math.random() * 16000);
    };
    const mg = () => {
      if (!this.enabled) return;
      const pan = Math.random() * 2 - 1, n = 4 + Math.floor(Math.random() * 8), d = 140 + Math.random() * 80;
      for (let i = 0; i < n; i++) setTimeout(() => this.gunshot(d, pan, 'far'), i * 85);
      setTimeout(mg, 9000 + Math.random() * 20000);
    };
    setTimeout(boom, 3000);
    setTimeout(mg, 6000);
  }
}
