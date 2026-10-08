// 鍵盤滑鼠輸入：WASD/方向鍵移動、滑鼠瞄準、左鍵攻擊、右鍵/E/空白鍵大招、Tab 計分板、M 靜音。
// 手機的觸控按鈕在 touch.js，它把搖桿和瞄準的結果寫到這裡的 stick、touchAim、touchShots。
const MOVE_KEYS = {
  KeyW: [0, -1], ArrowUp: [0, -1],
  KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
};

export class Input {
  constructor(canvas) {
    this.enabled = false;
    this.keys = new Set();
    this.mouseX = innerWidth / 2;
    this.mouseY = innerHeight / 2;
    this.attackHeld = false;
    this.attackQueued = false;
    this.superAiming = false;
    this.superQueued = false;
    this.tab = false;
    this.onMute = null;
    this.onReset = null;
    // 最後一次用的是手指還是滑鼠（決定要不要顯示觸控按鈕、怎麼瞄準）
    this.mode = matchMedia('(hover: none) and (pointer: coarse)').matches ? 'touch' : 'mouse';
    this.onModeChange = null;
    this.stickX = 0; // 觸控搖桿方向（單位向量，沒按就是 0）
    this.stickY = 0;
    this.touchAim = null; // 觸控拖曳瞄準中：{ super, angle, power(0～1) }
    this.touchShots = []; // 放開按鈕時要發射的：{ super, angle, power } 或 { super, auto: true }

    const typing = (e) => e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);

    addEventListener('keydown', (e) => {
      if (e.code === 'KeyM' && !typing(e) && !e.repeat && this.onMute) this.onMute();
      if (!this.enabled || typing(e)) return;
      if (MOVE_KEYS[e.code]) {
        this.keys.add(e.code);
        e.preventDefault();
      } else if ((e.code === 'KeyE' || e.code === 'Space') && !e.repeat) {
        this.superQueued = true;
        e.preventDefault();
      } else if (e.code === 'Tab') {
        this.tab = true;
        e.preventDefault();
      }
    });
    addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Tab') this.tab = false;
    });
    // 用 pointer 事件分辨手指和滑鼠；手機點螢幕後瀏覽器補發的假滑鼠事件會被忽略
    addEventListener('pointerdown', (e) => this.setMode(e.pointerType), true);
    addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') this.setMode('mouse');
    }, true);
    addEventListener('mousemove', (e) => {
      if (this.mode === 'touch') return;
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled || this.mode === 'touch') return;
      if (e.button === 0) {
        this.attackHeld = true;
        this.attackQueued = true;
      } else if (e.button === 2) {
        this.superAiming = true;
      }
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.attackHeld = false;
      if (e.button === 2 && this.superAiming) {
        this.superAiming = false;
        if (this.enabled) this.superQueued = true;
      }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('blur', () => this.reset());
  }

  setMode(pointerType) {
    const mode = pointerType === 'mouse' ? 'mouse' : pointerType === 'touch' || pointerType === 'pen' ? 'touch' : null;
    if (!mode || mode === this.mode) return;
    this.mode = mode;
    if (this.onModeChange) this.onModeChange(mode);
  }

  reset() {
    this.keys.clear();
    this.attackHeld = this.attackQueued = this.superAiming = this.superQueued = this.tab = false;
    this.stickX = this.stickY = 0;
    this.touchAim = null;
    this.touchShots.length = 0;
    if (this.onReset) this.onReset();
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.reset();
  }

  get moveX() {
    if (this.stickX || this.stickY) return this.stickX;
    let x = 0;
    for (const k of this.keys) x += MOVE_KEYS[k] ? MOVE_KEYS[k][0] : 0;
    return Math.sign(x);
  }

  get moveY() {
    if (this.stickX || this.stickY) return this.stickY;
    let y = 0;
    for (const k of this.keys) y += MOVE_KEYS[k] ? MOVE_KEYS[k][1] : 0;
    return Math.sign(y);
  }

  consumeAttack() {
    const v = this.attackQueued;
    this.attackQueued = false;
    return v;
  }

  consumeSuper() {
    const v = this.superQueued;
    this.superQueued = false;
    return v;
  }

  consumeTouchShots() {
    return this.touchShots.splice(0);
  }
}
