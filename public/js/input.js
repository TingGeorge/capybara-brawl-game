// 鍵盤滑鼠輸入：WASD/方向鍵移動、滑鼠瞄準、左鍵攻擊、右鍵/E/空白鍵大招、Tab 計分板、M 靜音
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
    addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
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

  reset() {
    this.keys.clear();
    this.attackHeld = this.attackQueued = this.superAiming = this.superQueued = this.tab = false;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.reset();
  }

  get moveX() {
    let x = 0;
    for (const k of this.keys) x += MOVE_KEYS[k] ? MOVE_KEYS[k][0] : 0;
    return Math.sign(x);
  }

  get moveY() {
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
}
