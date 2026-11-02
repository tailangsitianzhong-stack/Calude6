// スマホ（横画面）用のタッチ操作
//   左半分：どこに触れても出る移動スティック（端まで倒すと走る）
//   右半分：スワイプで視点
//   射撃ボタン：押している間撃つ。押したまま指を動かすと視点も動く
//   照準（トグル）・リロード・しゃがみ・ジャンプ・射撃モード・一時停止
export function isTouchDevice() {
  return matchMedia('(pointer: coarse)').matches || ('ontouchstart' in window && navigator.maxTouchPoints > 0);
}

export function setupTouch({ root, getPlayer, isPlaying, onPause }) {
  document.body.classList.add('touch');
  const stick = root.querySelector('#t-stick');
  const knob = root.querySelector('#t-knob');
  const btn = (id) => root.querySelector(id);
  const RADIUS = 58;
  const LOOK_SENS = 2.4;
  let stickId = null, sx = 0, sy = 0;
  let lookId = null, lx = 0, ly = 0;
  let fireId = null, fx = 0, fy = 0, holdTimer = 0;

  const P = () => getPlayer();

  function setStick(dx, dy) {
    const l = Math.hypot(dx, dy);
    const k = l > RADIUS ? RADIUS / l : 1;
    knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    const p = P();
    p.moveInput = { x: dx * k / RADIUS, y: dy * k / RADIUS };
    // 前に大きく倒すとダッシュ
    p.touchSprint = l > RADIUS * 1.25 && dy < -Math.abs(dx);
    stick.classList.toggle('sprint', p.touchSprint);
  }

  root.addEventListener('touchstart', (e) => {
    if (!isPlaying()) return;
    for (const t of e.changedTouches) {
      const target = t.target.closest('[data-btn]');
      if (target) continue;
      if (t.clientX < window.innerWidth * 0.42 && stickId === null) {
        stickId = t.identifier; sx = t.clientX; sy = t.clientY;
        stick.style.left = `${sx}px`; stick.style.top = `${sy}px`;
        stick.classList.add('on');
        setStick(0, 0);
      } else if (lookId === null) {
        lookId = t.identifier; lx = t.clientX; ly = t.clientY;
      }
    }
    e.preventDefault();
  }, { passive: false });

  root.addEventListener('touchmove', (e) => {
    if (!isPlaying()) return;
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) setStick(t.clientX - sx, t.clientY - sy);
      else if (t.identifier === lookId) {
        P().look((t.clientX - lx) * LOOK_SENS, (t.clientY - ly) * LOOK_SENS);
        lx = t.clientX; ly = t.clientY;
      } else if (t.identifier === fireId) {
        P().look((t.clientX - fx) * LOOK_SENS, (t.clientY - fy) * LOOK_SENS);
        fx = t.clientX; fy = t.clientY;
      }
    }
    e.preventDefault();
  }, { passive: false });

  const end = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) {
        stickId = null; stick.classList.remove('on', 'sprint');
        const p = P(); p.moveInput = null; p.touchSprint = false;
      } else if (t.identifier === lookId) lookId = null;
      else if (t.identifier === fireId) { fireId = null; clearTimeout(holdTimer); const p = P(); p.trigger = false; p.touchAuto = false; btn('#t-fire').classList.remove('down', 'auto'); }
    }
  };
  root.addEventListener('touchend', end);
  root.addEventListener('touchcancel', end);

  // ボタン
  const tap = (id, fn) => btn(id).addEventListener('touchstart', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!isPlaying() && id !== '#t-pause') return;
    fn(e);
    btn(id).classList.add('down');
    setTimeout(() => btn(id).classList.remove('down'), 120);
  }, { passive: false });

  btn('#t-fire').addEventListener('touchstart', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!isPlaying()) return;
    const t = e.changedTouches[0];
    fireId = t.identifier; fx = t.clientX; fy = t.clientY;
    const p = P();
    p.trigger = true;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { if (fireId !== null) { p.touchAuto = true; btn('#t-fire').classList.add('auto'); } }, 220);
    btn('#t-fire').classList.add('down');
  }, { passive: false });
  btn('#t-fire').addEventListener('touchmove', (e) => {
    e.preventDefault(); e.stopPropagation();
    for (const t of e.changedTouches) if (t.identifier === fireId) {
      P().look((t.clientX - fx) * LOOK_SENS, (t.clientY - fy) * LOOK_SENS);
      fx = t.clientX; fy = t.clientY;
    }
  }, { passive: false });
  btn('#t-fire').addEventListener('touchend', (e) => { e.stopPropagation(); end(e); });

  tap('#t-ads', () => { const p = P(); p.adsHeld = !p.adsHeld; btn('#t-ads').classList.toggle('active', p.adsHeld); });
  tap('#t-reload', () => P().reload());
  tap('#t-crouch', () => P().cycleStance());
  tap('#t-jump', () => { const p = P(); p.keys.Space = true; setTimeout(() => { p.keys.Space = false; }, 120); });
  tap('#t-mode', () => P().toggleMode());
  tap('#t-pause', () => onPause());

  const crouchBtn = btn('#t-crouch');
  return {
    // しゃがみボタン：次に押したときの姿勢を表示
    sync() {
      const s = P().stance;
      const label = ['しゃがむ', '伏せる', '立つ'][s];
      if (crouchBtn.textContent !== label) crouchBtn.textContent = label;
      crouchBtn.classList.toggle('active', s > 0);
    },
    reset() {
      const p = P();
      stickId = lookId = fireId = null;
      p.moveInput = null; p.touchSprint = false; p.trigger = false; p.adsHeld = false; p.touchAuto = false;
      stick.classList.remove('on', 'sprint');
      btn('#t-ads').classList.remove('active'); btn('#t-crouch').classList.remove('active');
    },
  };
}
