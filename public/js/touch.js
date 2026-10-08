// 手機觸控操作（像荒野亂鬥那樣）：
// - 螢幕左半邊：手指按下的地方就是搖桿中心，往哪拖就往哪走（手指拖太遠，搖桿會跟著過去）
// - 右下攻擊鈕：拖曳瞄準、放開發射；只點一下就自動打最近的敵人；瞄準後拖回中間放開可以取消
// - 大招鈕：集滿之後用法和攻擊鈕一樣
// 結果都寫進 Input（stickX/stickY、touchAim、touchShots），client-game.js 再拿去用。
const DEAD = 0.28; // 拖不到半徑的這個比例，就算是「點一下」

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// 手指拖出按鈕外也繼續收到這根手指的事件（測試用的模擬事件沒有真的手指，抓不到就算了）
function capture(el, pointerId) {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // 忽略
  }
}

export class TouchControls {
  constructor(input, { zone, stick, attack, superBtn }) {
    this.input = input;
    this.stick = stick;
    this.stickKnob = stick.querySelector('.stick-knob');
    this.move = null;
    this.aims = new Map(); // 按鈕 → 正在拖曳的手指

    input.onReset = () => this.release();

    zone.addEventListener('pointerdown', (e) => this.moveStart(e, zone));
    zone.addEventListener('pointermove', (e) => this.moveDrag(e));
    zone.addEventListener('pointerup', (e) => this.moveEnd(e));
    zone.addEventListener('pointercancel', (e) => this.moveEnd(e));

    for (const [btn, isSuper] of [[attack, false], [superBtn, true]]) {
      const knob = btn.querySelector('.stick-knob');
      btn.addEventListener('pointerdown', (e) => this.aimStart(e, btn, knob, isSuper));
      btn.addEventListener('pointermove', (e) => this.aimDrag(e, btn));
      btn.addEventListener('pointerup', (e) => this.aimEnd(e, btn, true));
      btn.addEventListener('pointercancel', (e) => this.aimEnd(e, btn, false));
    }
    // 長按不要跳出選單、不要選取文字
    for (const el of [zone, attack, superBtn]) el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ---------- 移動搖桿 ----------

  moveStart(e, zone) {
    if (!this.input.enabled || this.move) return;
    e.preventDefault();
    capture(zone, e.pointerId);
    const r = this.stick.offsetWidth / 2 || 60;
    // 搖桿整個要在畫面裡
    const x = Math.max(r, Math.min(innerWidth - r, e.clientX));
    const y = Math.max(r, Math.min(innerHeight - r, e.clientY));
    this.move = { id: e.pointerId, x, y, r };
    this.stick.classList.add('active');
    this.stick.style.left = `${x}px`;
    this.stick.style.top = `${y}px`;
    this.moveDrag(e);
  }

  moveDrag(e) {
    const m = this.move;
    if (!m || e.pointerId !== m.id) return;
    let dx = e.clientX - m.x;
    let dy = e.clientY - m.y;
    let len = Math.hypot(dx, dy);
    if (len > m.r) {
      // 手指拖出搖桿外：搖桿中心跟著手指移動
      m.x += (dx / len) * (len - m.r);
      m.y += (dy / len) * (len - m.r);
      this.stick.style.left = `${m.x}px`;
      this.stick.style.top = `${m.y}px`;
      dx = e.clientX - m.x;
      dy = e.clientY - m.y;
      len = m.r;
    }
    this.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    if (len < m.r * DEAD * 0.6) {
      this.input.stickX = this.input.stickY = 0;
    } else {
      this.input.stickX = dx / len;
      this.input.stickY = dy / len;
    }
  }

  moveEnd(e) {
    if (!this.move || e.pointerId !== this.move.id) return;
    this.move = null;
    this.input.stickX = this.input.stickY = 0;
    this.stick.classList.remove('active');
    this.stick.style.left = this.stick.style.top = '';
    this.stickKnob.style.transform = '';
  }

  // ---------- 攻擊 / 大招按鈕 ----------

  aimStart(e, btn, knob, isSuper) {
    if (!this.input.enabled || this.aims.has(btn)) return;
    e.preventDefault();
    capture(btn, e.pointerId);
    const r = (btn.offsetWidth / 2 || 50) * 1.1;
    this.aims.set(btn, { id: e.pointerId, x: e.clientX, y: e.clientY, r, knob, isSuper, aimed: false });
    btn.classList.add('pressed');
  }

  aimDrag(e, btn) {
    const a = this.aims.get(btn);
    if (!a || e.pointerId !== a.id) return;
    const dx = e.clientX - a.x;
    const dy = e.clientY - a.y;
    const len = Math.hypot(dx, dy);
    const k = Math.min(len, a.r) / (len || 1);
    a.knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    // 瞄準過又拖回中間：放開就取消（按鈕變灰提示）
    btn.classList.toggle('cancel', a.aimed && len < a.r * DEAD);
    if (len >= a.r * DEAD) {
      a.aimed = true;
      this.input.touchAim = {
        super: a.isSuper,
        angle: Math.atan2(dy, dx),
        power: clamp01((len / a.r - DEAD) / (1 - DEAD)),
      };
    } else if (this.input.touchAim && this.input.touchAim.super === a.isSuper) {
      this.input.touchAim = null;
    }
  }

  aimEnd(e, btn, fire) {
    const a = this.aims.get(btn);
    if (!a || e.pointerId !== a.id) return;
    this.aims.delete(btn);
    btn.classList.remove('pressed', 'cancel');
    a.knob.style.transform = '';
    const aim = this.input.touchAim && this.input.touchAim.super === a.isSuper ? this.input.touchAim : null;
    if (aim) this.input.touchAim = null;
    if (!fire || !this.input.enabled) return;
    if (aim) this.input.touchShots.push({ ...aim });
    else if (!a.aimed) this.input.touchShots.push({ super: a.isSuper, auto: true });
  }

  // 對戰結束、切到別的畫面時：放開所有手指
  release() {
    if (this.move) this.moveEnd({ pointerId: this.move.id });
    for (const [btn, a] of [...this.aims]) this.aimEnd({ pointerId: a.id }, btn, false);
  }
}
