// Keyboard, mouse (pointer lock) and gamepad input, merged into one controls snapshot per tick.
// Every action is looked up through a rebindable map, so players can remap keys at runtime and
// the map persists to localStorage when it is changed.
import { INPUT_CFG } from './config.js';

// Default key codes per action. Several actions share a key on purpose (Space is both jump and
// handbrake, which is why setBinding() keeps those two in step).
export const DEFAULT_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  backward: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space'],
  handbrake: ['Space'],
  enterExit: ['KeyF'],
  interact: ['KeyE'],
  reload: ['KeyR'],
  melee: ['KeyQ'],
  horn: ['KeyH'],
  pause: ['KeyP', 'Escape'],
  save: ['KeyK'],
  weapon1: ['Digit1'],
  weapon2: ['Digit2'],
  weapon3: ['Digit3'],
  nextWeapon: ['KeyX'],
  prevWeapon: ['KeyZ'],
  lookBack: ['KeyC'],
  weaponWheel: ['Tab'],
  radioNext: ['Period'],
  radioPrev: ['Comma'],
  missionLog: ['KeyL'],
  stats: ['F3'],
  mute: ['KeyM'],
};

// Actions that fire once per key press rather than every frame the key is held.
const PRESS_ACTIONS = new Set([
  'jump', 'enterExit', 'interact', 'reload', 'melee', 'horn', 'pause', 'save',
  'weapon1', 'weapon2', 'weapon3', 'nextWeapon', 'prevWeapon',
  'radioNext', 'radioPrev', 'missionLog', 'stats', 'mute',
]);

// Standard-mapping gamepad buttons.
const PAD = {
  A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5, LT: 6, RT: 7,
  BACK: 8, START: 9, LS: 10, RS: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
};

// Bumpers cycle weapons, the d-pad tunes the radio (left/right), starts missions (up) and looks
// back (down); stick clicks are sprint (L3) and horn (R3); Back toggles the mission log.
const PAD_BINDINGS = {
  jump: PAD.A,
  enterExit: PAD.Y,
  interact: PAD.UP,
  reload: PAD.X,
  melee: PAD.B,
  horn: PAD.RS,
  pause: PAD.START,
  nextWeapon: PAD.RB,
  prevWeapon: PAD.LB,
  lookBack: PAD.DOWN,
  sprint: PAD.LS,
  radioNext: PAD.RIGHT,
  radioPrev: PAD.LEFT,
  missionLog: PAD.BACK,
};

const BINDINGS_KEY = 'vice-meridian-bindings-v1';
const BINDINGS_VERSION = 2;
const PAD_LOOK_SPEED = 900; // pseudo-pixels per second at full right-stick deflection

// Keys the browser would otherwise use for scrolling, tabbing or the dev-tools overlay. Their
// default action is suppressed while the game owns the keyboard.
const SWALLOWED_CODES = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'F3']);

// Per-axis deadzone for triggers and single axes: values inside the band read as zero and the
// remainder is rescaled so the live range still reaches 1 at full travel.
function deadzone(v, dz = INPUT_CFG.triggerDeadzone) {
  const a = Math.abs(v);
  if (a < dz) return 0;
  return Math.sign(v) * (a - dz) / (1 - dz);
}

// Radial deadzone for a stick: the dead area is a circle (no cross-shaped sticking along the
// axes), and the live range is rescaled so output still reaches 1 at full deflection.
export function radialDeadzone(x, y, dz = INPUT_CFG.stickDeadzone) {
  const mag = Math.hypot(x, y);
  if (mag < dz) return { x: 0, y: 0 };
  const scaled = Math.min(1, (mag - dz) / (1 - dz));
  // Slight response curve: finer control near the centre, full speed at the rim.
  const curved = scaled * scaled * (3 - 2 * scaled) * 0.35 + scaled * 0.65;
  return { x: (x / mag) * curved, y: (y / mag) * curved };
}

// Serialise a bindings map with a version tag so a future format can migrate old saves.
export function serializeBindings(bindings) {
  return JSON.stringify({ v: BINDINGS_VERSION, bindings });
}

// Parse a stored bindings map. Only known actions survive, and each must be a short array of
// plausible key codes; anything else keeps its default. Version 1 stored the bare map, so both
// shapes are accepted.
export function parseBindings(text) {
  const merged = {};
  for (const [action, codes] of Object.entries(DEFAULT_BINDINGS)) merged[action] = [...codes];

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return merged;
  }

  const map = data && typeof data === 'object' && data.bindings ? data.bindings : data;
  if (!map || typeof map !== 'object') return merged;

  for (const [action, codes] of Object.entries(map)) {
    if (!merged[action] || !Array.isArray(codes) || codes.length > 4) continue;
    const valid = codes.every((c) => typeof c === 'string' && /^[A-Za-z0-9]{1,24}$/.test(c));
    if (valid) merged[action] = [...codes];
  }
  return merged;
}

export class InputController {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.mouseDown = false;
    this.rightMouseDown = false;
    this.justPressed = new Set();
    this.pointerLocked = false;
    this.lockLost = false;
    this.frozen = false;
    this.mouseSensitivity = 1;
    this.invertY = false;
    this.bindings = this.loadBindings();
    this.rebindTarget = null;
    this.onRebind = null;
    this.gamepadIndex = null;
    this.padPrev = [];
    this.padPressed = new Set();
    this.padState = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, buttons: [] };
    this.lastInputSource = 'keyboard';
    // Input buffer: action → simulation-clock time of an unconsumed press. A press survives
    // endFrame() for INPUT_CFG.bufferSeconds, so one made during a hitch (or on a frame where
    // the game could not act on it yet, like a jump just before landing) is still honoured.
    this.clock = 0;
    this.buffer = new Map();
    this.codeToActions = new Map();
    this.rebuildCodeIndex();

    this._onKeyDown = (e) => this.handleKeyDown(e);
    this._onKeyUp = (e) => this.handleKeyUp(e);
    this._onMouseMove = (e) => this.handleMouseMove(e);
    this._onMouseDown = (e) => this.handleMouseDown(e);
    this._onMouseUp = (e) => this.handleMouseUp(e);
    this._onPointerLockChange = () => this.handlePointerLockChange();
    this._onBlur = () => this.handleBlur();
    this._onGamepadConnected = (e) => {
      if (this.gamepadIndex === null) this.gamepadIndex = e.gamepad.index;
    };
    this._onGamepadDisconnected = (e) => {
      if (this.gamepadIndex === e.gamepad.index) this.gamepadIndex = null;
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('gamepadconnected', this._onGamepadConnected);
    window.addEventListener('gamepaddisconnected', this._onGamepadDisconnected);
    if (canvas) canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
  }

  // --- Raw event handlers ----------------------------------------------------------------------

  handleKeyDown(e) {
    if (this.frozen) return;
    // While rebinding, the next key press becomes the new binding for that action.
    if (this.rebindTarget) {
      e.preventDefault();
      if (e.code !== 'Escape') this.setBinding(this.rebindTarget, e.code);
      const done = this.rebindTarget;
      this.rebindTarget = null;
      if (this.onRebind) this.onRebind(done, e.code);
      return;
    }
    // Only the first event of a press counts; OS key repeat must not refill the buffer.
    if (!this.keys.has(e.code)) {
      this.justPressed.add(e.code);
      const actions = this.codeToActions.get(e.code);
      if (actions) {
        for (const a of actions) if (PRESS_ACTIONS.has(a)) this.buffer.set(a, this.clock);
      }
      this.noteInput('keyboard');
    }
    this.keys.add(e.code);
    if (SWALLOWED_CODES.has(e.code)) e.preventDefault();
  }

  handleKeyUp(e) {
    this.keys.delete(e.code);
  }

  handleMouseMove(e) {
    if (this.frozen || !this.pointerLocked) return;
    this.mouseDeltaX += (e.movementX || 0) * this.mouseSensitivity;
    this.mouseDeltaY += (e.movementY || 0) * this.mouseSensitivity * (this.invertY ? -1 : 1);
  }

  handleMouseDown(e) {
    if (this.frozen) return;
    if (e.button === 0) {
      this.mouseDown = true;
      this.justPressed.add('Mouse0');
    } else if (e.button === 2) {
      this.rightMouseDown = true;
    }
  }

  handleMouseUp(e) {
    if (e.button === 0) this.mouseDown = false;
    if (e.button === 2) this.rightMouseDown = false;
  }

  handlePointerLockChange() {
    const wasLocked = this.pointerLocked;
    this.pointerLocked = document.pointerLockElement === this.canvas;
    // Browsers swallow Escape while releasing pointer lock; report it so the game can pause.
    if (wasLocked && !this.pointerLocked) this.lockLost = true;
  }

  handleBlur() {
    // Focus loss drops every held key, otherwise the character keeps running into a wall.
    this.keys.clear();
    this.mouseDown = false;
    this.rightMouseDown = false;
  }

  // --- Key rebinding ---------------------------------------------------------------------------

  loadBindings() {
    try {
      const raw = window.localStorage ? window.localStorage.getItem(BINDINGS_KEY) : null;
      if (raw) return parseBindings(raw);
    } catch {
      // Storage unavailable (private mode, file://): defaults stand.
    }
    return parseBindings('{}');
  }

  saveBindings() {
    try {
      if (window.localStorage) window.localStorage.setItem(BINDINGS_KEY, serializeBindings(this.bindings));
    } catch {
      // Storage may be disabled; the bindings still apply for this session.
    }
  }

  // Key code → actions it triggers. Rebuilt whenever bindings change; only the press buffer uses it.
  rebuildCodeIndex() {
    this.codeToActions.clear();
    for (const [action, codes] of Object.entries(this.bindings)) {
      for (const code of codes) {
        let list = this.codeToActions.get(code);
        if (!list) {
          list = [];
          this.codeToActions.set(code, list);
        }
        list.push(action);
      }
    }
  }

  exportBindings() {
    return serializeBindings(this.bindings);
  }

  importBindings(text) {
    this.bindings = parseBindings(text);
    this.rebuildCodeIndex();
    this.saveBindings();
    return this.bindings;
  }

  // Settings hooks; both mouse look and the right stick go through these.
  setSensitivity(mult) {
    this.mouseSensitivity = Math.max(0.1, Math.min(4, Number(mult) || 1));
  }

  setInvertY(on) {
    this.invertY = Boolean(on);
  }

  // Replace the primary key for an action, removing that key from any other action first. Jump
  // and handbrake share Space by default, so those two are exempt from the sweep.
  setBinding(action, code) {
    if (!this.bindings[action]) return false;
    for (const [other, list] of Object.entries(this.bindings)) {
      if (other === action) continue;
      const sharesSpace = (other === 'jump' && action === 'handbrake') || (other === 'handbrake' && action === 'jump');
      if (!sharesSpace) this.bindings[other] = list.filter((c) => c !== code);
    }
    const rest = this.bindings[action].slice(1).filter((c) => c !== code);
    this.bindings[action] = [code, ...rest];
    this.rebuildCodeIndex();
    this.saveBindings();
    return true;
  }

  beginRebind(action, onDone = null) {
    if (!this.bindings[action]) return false;
    this.rebindTarget = action;
    this.onRebind = onDone;
    return true;
  }

  resetBindings() {
    this.bindings = {};
    for (const [action, codes] of Object.entries(DEFAULT_BINDINGS)) this.bindings[action] = [...codes];
    this.rebuildCodeIndex();
    this.saveBindings();
  }

  // Human-readable label for the settings menu: "KeyW" → "W", "Digit1" → "1".
  describeBinding(action) {
    const list = this.bindings[action] || [];
    return list.map((c) => c.replace(/^Key/, '').replace(/^Digit/, '')).join(' / ');
  }

  // --- Pointer lock ----------------------------------------------------------------------------

  requestPointerLock() {
    if (this.frozen) return;
    if (!this.canvas || !this.canvas.requestPointerLock) return;
    try {
      const p = this.canvas.requestPointerLock();
      // Newer browsers return a promise that rejects when the request is not user-initiated.
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      // Ignore browser rejections (headless mode, sandboxed iframe).
    }
  }

  exitPointerLock() {
    if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock();
  }

  // True once after the browser dropped pointer lock on its own (Escape, tab switch).
  consumeLockLost() {
    const lost = this.lockLost;
    this.lockLost = false;
    return lost;
  }

  // --- Input buffer ----------------------------------------------------------------------------

  // Advance the buffer clock by one simulation step and expire stale presses.
  tick(dt) {
    this.clock += dt;
    for (const [action, t] of this.buffer) {
      if (this.clock - t > INPUT_CFG.bufferSeconds) this.buffer.delete(action);
    }
  }

  // Seconds since the last unconsumed press of `action`, or Infinity when there is none.
  bufferAge(action) {
    const t = this.buffer.get(action);
    return t === undefined ? Infinity : this.clock - t;
  }

  consumeBuffered(action) {
    const had = this.buffer.has(action);
    this.buffer.delete(action);
    return had;
  }

  // Drop every pending press: used on state changes so menu keys never leak into gameplay.
  flush() {
    this.justPressed.clear();
    this.buffer.clear();
    this.padPressed.clear();
  }

  // --- Gamepad ---------------------------------------------------------------------------------

  pollGamepad() {
    this.padPressed.clear();
    const st = this.padState;
    st.lx = st.ly = st.rx = st.ry = st.lt = st.rt = 0;
    if (this.frozen || !navigator.getGamepads) return;

    const pads = navigator.getGamepads();
    let pad = this.gamepadIndex !== null ? pads[this.gamepadIndex] : null;
    if (!pad) {
      for (const p of pads) {
        if (p && p.connected) {
          pad = p;
          this.gamepadIndex = p.index;
          break;
        }
      }
    }
    if (!pad) return;
    // Some drivers expose a partially populated pad; check the shape before indexing into it.
    if (!pad.axes || pad.axes.length < 4 || !pad.buttons || pad.buttons.length < 16) return;

    const left = radialDeadzone(pad.axes[0] || 0, pad.axes[1] || 0);
    const right = radialDeadzone(pad.axes[2] || 0, pad.axes[3] || 0);
    st.lx = left.x;
    st.ly = left.y;
    st.rx = right.x;
    st.ry = right.y;

    // Triggers report either analog `value` or a boolean `pressed` depending on the browser.
    const trigger = (index) => {
      const button = pad.buttons[index];
      if (!button) return 0;
      return button.value || (button.pressed ? 1 : 0);
    };
    st.lt = deadzone(trigger(PAD.LT));
    st.rt = deadzone(trigger(PAD.RT));

    st.buttons = pad.buttons.map((b) => b.pressed);
    st.buttons.forEach((down, i) => {
      if (down && !this.padPrev[i]) {
        this.padPressed.add(i);
        this.noteInput('gamepad');
      }
    });
    this.padPrev = st.buttons;
  }

  get hasGamepad() {
    return this.gamepadIndex !== null;
  }

  // --- Queries ---------------------------------------------------------------------------------

  isDown(code) {
    return !this.frozen && this.keys.has(code);
  }

  consumePress(code) {
    if (this.frozen) return false;
    if (!this.justPressed.has(code)) return false;
    this.justPressed.delete(code);
    return true;
  }

  action(name) {
    const codes = this.bindings[name] || [];
    let active = false;

    if (PRESS_ACTIONS.has(name)) {
      // Check every code without short-circuiting so the press is consumed whichever key made it.
      for (const c of codes) if (this.justPressed.has(c)) active = true;
      const padBtn = PAD_BINDINGS[name];
      if (padBtn !== undefined && this.padPressed.has(padBtn)) active = true;
      // A buffered press that no step has consumed yet still counts. Jump keeps its buffer for
      // the player's landing check (see controls.jumpBufferAge), so it is never drained here.
      if (!active && name !== 'jump' && this.buffer.has(name)) active = true;
      if (name !== 'jump') {
        for (const c of codes) this.justPressed.delete(c);
        this.buffer.delete(name);
      }
    } else {
      for (const c of codes) if (this.keys.has(c)) active = true;
      const padBtn = PAD_BINDINGS[name];
      if (padBtn !== undefined && this.padState.buttons[padBtn]) active = true;
    }

    return !this.frozen && active;
  }

  consumeMouseDelta(dt = 1 / 60) {
    // The right stick adds to mouse look, scaled to feel like a mouse sweep. Sensitivity and
    // invert-Y apply to both sources; vertical stick motion is damped to match mouse feel.
    const inv = this.invertY ? -1 : 1;
    const dx = this.mouseDeltaX + this.padState.rx * PAD_LOOK_SPEED * this.mouseSensitivity * dt;
    const dy = this.mouseDeltaY + this.padState.ry * PAD_LOOK_SPEED * 0.6 * this.mouseSensitivity * inv * dt;
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    return { dx, dy };
  }

  // One merged snapshot of every control the simulation reads this tick.
  getControls() {
    this.pollGamepad();
    const pad = this.padState;

    const kbForward = this.action('forward');
    const kbBackward = this.action('backward');
    const kbLeft = this.action('left');
    const kbRight = this.action('right');
    // Analog axes: keyboard gives ±1, the left stick gives a proportional value.
    const moveX = pad.lx !== 0 ? pad.lx : (kbRight ? 1 : 0) - (kbLeft ? 1 : 0);
    const moveY = pad.ly !== 0 ? -pad.ly : (kbForward ? 1 : 0) - (kbBackward ? 1 : 0);
    const jumpPressed = this.action('jump');

    return {
      forward: kbForward || pad.ly < -0.3,
      backward: kbBackward || pad.ly > 0.3,
      left: kbLeft || pad.lx < -0.3,
      right: kbRight || pad.lx > 0.3,
      moveX,
      moveY,
      // Triggers: RT is throttle (or fire on foot), LT is brake/reverse (or aim on foot).
      throttle: Math.max(kbForward ? 1 : 0, pad.rt),
      brake: Math.max(kbBackward ? 1 : 0, pad.lt),
      sprint: this.action('sprint'),
      jump: jumpPressed,
      handbrake: this.action('handbrake') || Boolean(pad.buttons[PAD.A]),
      enterExit: this.action('enterExit'),
      interact: this.action('interact'),
      fire: !this.frozen && (this.mouseDown || pad.rt > 0.5),
      aim: !this.frozen && (this.rightMouseDown || pad.lt > 0.5),
      reload: this.action('reload'),
      melee: this.action('melee'),
      horn: this.action('horn'),
      pause: this.action('pause'),
      save: this.action('save'),
      weapon1: this.action('weapon1'),
      weapon2: this.action('weapon2'),
      weapon3: this.action('weapon3'),
      nextWeapon: this.action('nextWeapon'),
      prevWeapon: this.action('prevWeapon'),
      lookBack: this.action('lookBack'),
      weaponWheel: this.action('weaponWheel'),
      radioNext: this.action('radioNext'),
      radioPrev: this.action('radioPrev'),
      missionLog: this.action('missionLog'),
      stats: this.action('stats'),
      mute: this.action('mute'),
      // Seconds since an unconsumed jump press (Infinity if none) plus a way to consume it, so
      // the player can honour a jump pressed just before landing.
      jumpBufferAge: this.bufferAge('jump'),
      consumeJump: () => this.consumeBuffered('jump'),
      usingGamepad: this.hasGamepad,
    };
  }

  endFrame() {
    this.justPressed.clear();
  }

  // Track which device was used most recently, for icons and smart input switching.
  noteInput(source = 'keyboard') {
    this.lastInputSource = source;
  }

  getLastInputSource() {
    return this.lastInputSource || 'keyboard';
  }
}
