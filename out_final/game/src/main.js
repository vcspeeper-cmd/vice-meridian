import { CITY, FIXED_DT, FRAME_BUDGET, PED_CFG, QUALITY_ORDER, QUALITY_TIERS, SAVE_CFG, TRAFFIC_CFG } from './config.js';
import { SeededRandom } from './random.js';
import { createTexturePack } from './textures.js';
import { createRenderRig } from './render.js';
import { buildCity } from './city.js';
import { VehicleManager } from './vehicles.js';
import { PedestrianManager } from './pedestrians.js';
import { PlayerController } from './player.js';
import { PoliceManager } from './police.js';
import { CombatSystem } from './combat.js';
import { MissionManager } from './missions.js';
import { HudOverlay } from './hud.js';
import { AudioEngine } from './audio.js';
import { InputController } from './input.js';
import { setupShotScene, stepShotScene } from './shots.js';

// --- Game flow ---------------------------------------------------------------------------------
// boot → title → playing ⇄ paused; playing → wasted | busted → respawn → playing.
// Shot mode goes boot → playing, steps a fixed number of ticks and renders one frame.
export const GameState = Object.freeze({
  BOOT: 'boot',
  TITLE: 'title',
  PLAYING: 'playing',
  PAUSED: 'paused',
  WASTED: 'wasted',
  BUSTED: 'busted',
  RESPAWN: 'respawn',
});

// Legal transitions. Anything not listed is refused, so a stray event (a pause key during the
// death camera, a resume click on the title screen) can never put the game in a broken state.
const TRANSITIONS = Object.freeze({
  boot: ['title', 'playing'],
  title: ['playing'],
  playing: ['paused', 'wasted', 'busted'],
  paused: ['playing'],
  wasted: ['respawn'],
  busted: ['respawn'],
  respawn: ['playing', 'paused', 'wasted', 'busted'],
});

// States in which the world simulation advances.
const SIMULATING = new Set([GameState.PLAYING, GameState.WASTED, GameState.BUSTED, GameState.RESPAWN]);

export class StateMachine {
  constructor(initial, transitions, onChange) {
    this.state = initial;
    this.transitions = transitions;
    this.onChange = onChange;
    this.timeInState = 0;
    this.history = [initial];
  }

  can(next) {
    return (this.transitions[this.state] || []).includes(next);
  }

  // Returns true when the transition happened.
  go(next) {
    if (next === this.state || !this.can(next)) return false;
    const prev = this.state;
    this.state = next;
    this.timeInState = 0;
    this.history.push(next);
    if (this.history.length > 32) this.history.shift();
    if (this.onChange) this.onChange(next, prev);
    return true;
  }

  tick(dt) {
    this.timeInState += dt;
  }

  is(...states) {
    return states.includes(this.state);
  }
}

// --- Frame-budget guard ------------------------------------------------------------------------
// Tracks a smoothed CPU frame time. In "auto" mode it drops one quality tier when frames stay
// over budget and climbs back when there is plenty of headroom; a pinned tier is never changed.
export class FrameBudgetGuard {
  constructor(onTierChange) {
    this.onTierChange = onTierChange;
    this.mode = 'auto';
    this.tier = 'high';
    this.smoothedMs = FRAME_BUDGET.targetMs;
    this.overFrames = 0;
    this.underFrames = 0;
    this.fps = 60;
    this.changes = 0;
  }

  setMode(mode) {
    this.mode = mode;
    if (mode !== 'auto' && QUALITY_TIERS[mode]) this.setTier(mode);
  }

  setTier(id) {
    if (!QUALITY_TIERS[id] || id === this.tier) return;
    this.tier = id;
    this.overFrames = 0;
    this.underFrames = 0;
    this.changes++;
    if (this.onTierChange) this.onTierChange(QUALITY_TIERS[id]);
  }

  // workMs: CPU time spent simulating and rendering this frame. intervalMs: time between frames.
  sample(workMs, intervalMs) {
    const k = FRAME_BUDGET.smoothing;
    this.smoothedMs += (workMs - this.smoothedMs) * k;
    if (intervalMs > 0) this.fps += (1000 / intervalMs - this.fps) * k;
    if (this.mode !== 'auto') return;
    const idx = QUALITY_ORDER.indexOf(this.tier);
    if (this.smoothedMs > FRAME_BUDGET.downshiftMs) {
      this.overFrames++;
      this.underFrames = 0;
      if (this.overFrames > FRAME_BUDGET.windowFrames && idx > 0) this.setTier(QUALITY_ORDER[idx - 1]);
    } else if (this.smoothedMs < FRAME_BUDGET.upshiftMs) {
      this.underFrames++;
      this.overFrames = 0;
      if (this.underFrames > FRAME_BUDGET.windowFrames * 2 && idx < QUALITY_ORDER.length - 1) this.setTier(QUALITY_ORDER[idx + 1]);
    } else {
      this.overFrames = Math.max(0, this.overFrames - 1);
      this.underFrames = Math.max(0, this.underFrames - 1);
    }
  }
}

function parseParams() {
  const params = new URLSearchParams(window.location.search);
  const rawShot = params.get('shot');
  // Map legacy starter aliases if ever queried, while natively supporting chase|street|drive|mission|skyline
  const aliasMap = { start: 'chase', play: 'drive', end: 'mission' };
  const shot = rawShot ? (aliasMap[rawShot] || rawShot) : null;
  const seed = Number.parseInt(params.get('seed') || '42', 10) || 42;
  const advanceT = Math.max(0, Number.parseFloat(params.get('t') || '0') || 0);
  const forceHud = params.get('hud') === '1';
  return { shot, seed, advanceT, forceHud };
}

// Front-end bridge from index.html (settings + loading bar). Absent when the page is embedded
// without it, so every call is guarded.
function front() {
  return window.VMFront || null;
}

function reportProgress(step) {
  const f = front();
  if (f && f.progress) f.progress(step);
}

// --- Save / load (localStorage) -------------------------------------------------------------

const SAVE_VERSION = 2;

function storage() {
  try {
    return window.localStorage || null;
  } catch {
    return null;
  }
}

// Validate a parsed save. Version 1 saves (no top-level cash) are upgraded on read.
export function validateSave(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.v !== 1 && data.v !== SAVE_VERSION) return null;
  const p = data.player;
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
  if (Math.abs(p.x) > 2000 || Math.abs(p.z) > 2000) return null;
  const wanted = Math.max(0, Math.min(5, Number(data.wanted) | 0));
  const cash = Number.isFinite(data.cash) ? Math.max(0, Math.floor(data.cash)) : Math.max(0, Math.floor(Number(p.money) || 0));
  return { v: SAVE_VERSION, player: { ...p, money: cash }, wanted, cash, missions: data.missions || null, stats: data.stats || null };
}

function readSave() {
  const ls = storage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(SAVE_CFG.key);
    if (!raw) return null;
    return validateSave(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeSave(ctx) {
  const ls = storage();
  if (!ls) return false;
  const { player, police, missions } = ctx;
  const data = {
    v: SAVE_VERSION,
    player: player.serialize(),
    wanted: police.stars,
    cash: Math.floor(player.money),
    missions: missions.serialize ? missions.serialize() : null,
    stats: player.stats ? { ...player.stats } : null,
  };
  try {
    ls.setItem(SAVE_CFG.key, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

function applySave(ctx, data) {
  const { player, police, missions } = ctx;
  player.restore(data.player);
  player.money = data.cash;
  if (data.wanted > 0) police.setStars(data.wanted);
  if (data.missions && missions.restore) missions.restore(data.missions);
  if (data.stats && player.stats) {
    for (const k of Object.keys(player.stats)) if (Number.isFinite(data.stats[k])) player.stats[k] = data.stats[k];
  }
}

// Yield to the browser so the loading bar can repaint between construction steps.
const nextPaint = () => new Promise((resolve) => setTimeout(resolve, 0));

async function boot() {
  const { shot, seed, advanceT, forceHud } = parseParams();
  const isShotMode = Boolean(shot);
  // Shot mode builds synchronously in one go; interactive mode yields between steps so the
  // progress bar visibly advances in module order.
  const step = async (name) => {
    reportProgress(name);
    if (!isShotMode) await nextPaint();
  };

  const rng = new SeededRandom(seed);
  const canvas = document.getElementById('viewport');
  await step('modules');
  const textures = createTexturePack(rng.fork(10));
  await step('textures');
  const renderRig = createRenderRig(canvas, textures);
  await step('render');
  const city = buildCity(renderRig.scene, textures, rng.fork(20));
  await step('city');
  const vehicles = new VehicleManager(renderRig.scene, city, textures, rng.fork(30));
  await step('vehicles');
  const peds = new PedestrianManager(renderRig.scene, city, rng.fork(40), PED_CFG.count);
  await step('peds');
  const player = new PlayerController(renderRig.scene, city, renderRig.camera);
  await step('player');
  const police = new PoliceManager(renderRig.scene, city, vehicles, rng.fork(50));
  await step('police');
  const combat = new CombatSystem(renderRig.scene, city, textures, rng.fork(60));
  await step('combat');
  const missions = new MissionManager(renderRig.scene, vehicles, police, rng.fork(70));
  await step('missions');
  const hud = new HudOverlay();
  const audio = new AudioEngine();
  const input = new InputController(canvas);
  combat.peds = peds;
  await step('hud');

  // Populate baseline city traffic and starter cars
  const trafficCount = Math.min(TRAFFIC_CFG.maxCount, Math.round(TRAFFIC_CFG.baseCount * TRAFFIC_CFG.density));
  vehicles.populateTraffic(trafficCount);
  if (!isShotMode) {
    // Park Rico's starter Vantablack GT right near Palmetto Strip
    vehicles.spawnVehicle('sports', 134, -20, Math.PI, { color: 0xff3a5e, aiMode: 'parked' });
    vehicles.spawnVehicle('convertible', 134, -36, 0, { color: 0x23e0d6, aiMode: 'parked' });
    vehicles.spawnVehicle('police', 143.6, 20, Math.PI, { aiMode: 'traffic', laneAxis: 'z', laneDir: -1, laneCoord: 143.6, speed: 13 });
    if (police.spawnPatrols) police.spawnPatrols();
  }

  let simTime = 0;
  let shotInfo = null;
  let autosaveTimer = SAVE_CFG.autosaveSeconds;
  let lastStats = null;

  const ctx = { city, vehicles, peds, player, police, combat, missions, renderRig, textures };

  const emptyControls = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    moveX: 0,
    moveY: 0,
    throttle: 0,
    brake: 0,
    sprint: false,
    jump: false,
    handbrake: false,
    enterExit: false,
    interact: false,
    fire: false,
    aim: false,
    reload: false,
    melee: false,
    horn: false,
    pause: false,
    save: false,
    weapon1: false,
    weapon2: false,
    weapon3: false,
    nextWeapon: false,
    prevWeapon: false,
    lookBack: false,
    weaponWheel: false,
    radioNext: false,
    radioPrev: false,
    missionLog: false,
    stats: false,
    mute: false,
    jumpBufferAge: Infinity,
    consumeJump: () => false,
  };

  function saveNow(announce) {
    const ok = writeSave(ctx);
    if (announce && missions.showToast) missions.showToast(ok ? 'GAME SAVED' : 'SAVE UNAVAILABLE', !ok, 1.6);
    hud.setContinueAvailable(Boolean(readSave()));
  }

  // Entering a state configures overlay, HUD, audio and pointer lock in one place.
  function onStateChange(next, prev) {
    // Shot mode configures its own HUD and never touches audio, pointer lock or saves.
    if (isShotMode) return;
    const f = front();
    if (f && f.setPaused) f.setPaused(next === GameState.PAUSED);
    switch (next) {
      case GameState.PLAYING:
        hud.setOverlay(false);
        hud.setVisible(true);
        audio.unlock();
        if (audio.setMuted) audio.setMuted(muted);
        // Drop input that belongs to the menu: the lock release caused by pausing and any key
        // press still queued (or buffered) from the resume action.
        input.consumeLockLost();
        input.flush();
        input.requestPointerLock();
        if (prev === GameState.TITLE) hud.notify('Tessa is waiting on Palmetto Strip', 'info', 4);
        break;
      case GameState.PAUSED:
        hud.setOverlayCopy('PAUSED', 'Marisol Bay holds its breath. Press P, Esc or the button to jump back in. Progress autosaves every 30 seconds.');
        hud.setOverlay(true, 'RESUME');
        hud.setVisible(forceHud);
        hud.setWeaponWheel(false);
        if (audio.setMuted) audio.setMuted(true);
        input.exitPointerLock();
        break;
      case GameState.WASTED:
      case GameState.BUSTED:
        hud.setVisible(true);
        hud.setWeaponWheel(false);
        break;
      case GameState.RESPAWN:
        hud.setVisible(true);
        hud.notify(prev === GameState.BUSTED ? 'Released on bail — weapons confiscated' : 'Discharged from Marisol General', 'info', 3);
        // Coming back from a death or arrest: persist the respawned state.
        saveNow(false);
        break;
      default:
        hud.setOverlay(true, 'PLAY VICE MERIDIAN');
        hud.setVisible(forceHud);
    }
  }

  const machine = new StateMachine(GameState.BOOT, TRANSITIONS, onStateChange);
  let muted = false;

  // --- Settings ---------------------------------------------------------------------------
  const guard = new FrameBudgetGuard((tier) => {
    if (renderRig.setQualityTier) renderRig.setQualityTier(tier);
    if (!isShotMode && machine.is(GameState.PLAYING)) hud.notify(`Quality: ${tier.id.toUpperCase()}`, 'info', 2);
  });

  function applySettings(s) {
    if (!s) return;
    input.setSensitivity(s.sensitivity);
    input.setInvertY(s.invertY);
    audio.setVolume(s.volume / 100);
    combat.setDifficulty(s.difficulty);
    if (police.setDifficulty) police.setDifficulty(s.difficulty);
    if (missions.setDifficulty) missions.setDifficulty(s.difficulty);
    if (player.setBaseFov) player.setBaseFov(s.fov);
    else {
      renderRig.camera.fov = s.fov;
      renderRig.camera.updateProjectionMatrix();
    }
    if (player.setReduceMotion) player.setReduceMotion(s.reduceMotion);
    hud.reduceMotion = s.reduceMotion;
    guard.setMode(s.quality);
  }

  function handleMetaControls(controls, mouseDelta) {
    if (controls.mute) {
      muted = !muted;
      if (audio.setMuted) audio.setMuted(muted);
      hud.notify(muted ? 'Audio muted' : 'Audio on', 'info', 1.5);
    }
    if (controls.missionLog) hud.toggleMissionLog();
    if (controls.stats) hud.toggleStats();
    if ((controls.radioNext || controls.radioPrev) && player.vehicle && audio.cycleRadio) {
      hud.notify(audio.cycleRadio(controls.radioNext ? 1 : -1), 'info', 2);
    }
    // Weapon wheel: while held, mouse/stick motion picks a slot by direction and the camera
    // does not turn.
    if (controls.weaponWheel && !player.vehicle) {
      if (!hud.wheelVisible) {
        hud.setWeaponWheel(true, player);
        wheelVec.x = 0;
        wheelVec.y = 0;
      }
      wheelVec.x += mouseDelta.dx;
      wheelVec.y += mouseDelta.dy;
      mouseDelta.dx = 0;
      mouseDelta.dy = 0;
      if (Math.hypot(wheelVec.x, wheelVec.y) > 30) {
        const ang = Math.atan2(wheelVec.y, wheelVec.x);
        // Slot directions on screen: fists up, pistol lower right, SMG lower left.
        const slots = [
          { id: 'fists', a: -Math.PI / 2 },
          { id: 'pistol', a: Math.PI * 0.2 },
          { id: 'smg', a: Math.PI * 0.8 },
        ];
        let best = slots[0];
        let bestD = Infinity;
        for (const s of slots) {
          const d = Math.abs(Math.atan2(Math.sin(ang - s.a), Math.cos(ang - s.a)));
          if (d < bestD) {
            bestD = d;
            best = s;
          }
        }
        if (player.selectWeapon(best.id)) hud.setWeaponWheel(true, player);
        wheelVec.x *= 0.5;
        wheelVec.y *= 0.5;
      }
    } else if (hud.wheelVisible) {
      hud.setWeaponWheel(false);
    }
  }
  const wheelVec = { x: 0, y: 0 };

  function stepSimulation(dt, useInput) {
    simTime += dt;
    machine.tick(dt);
    if (useInput) input.tick(dt);
    const controls = useInput ? input.getControls() : emptyControls;
    const mouseDelta = useInput ? input.consumeMouseDelta(dt) : { dx: 0, dy: 0 };

    if (useInput && (controls.pause || input.consumeLockLost()) && machine.can(GameState.PAUSED)) {
      machine.go(GameState.PAUSED);
      input.endFrame();
      return;
    }

    city.update(simTime);

    if (isShotMode) {
      stepShotScene(shotInfo, dt, ctx);
      // Still tick traffic, pedestrians, lightbars, and particle fades
      vehicles.update(dt, simTime, emptyControls, null);
      peds.update(dt, player, vehicles, police);
      combat.update(dt, emptyControls, player, [], police, null);
      missions.giverMarker.diamond.rotation.y = simTime * 1.8;
      missions.objectiveMarker.diamond.rotation.y = simTime * 2.1;
      if (missions.animateMarkers) missions.animateMarkers(simTime);
      player.updateCamera(dt);
    } else {
      if (useInput) handleMetaControls(controls, mouseDelta);
      const allTargets = [...police.officers, ...missions.enemies];
      vehicles.update(dt, simTime, controls, player.vehicle);
      player.update(dt, controls, mouseDelta, vehicles, police, audio);
      peds.update(dt, player, vehicles, police);
      police.update(dt, simTime, player, combat, audio);
      combat.update(dt, controls, player, allTargets, police, audio);
      missions.update(dt, simTime, player, controls, combat, audio);
      audio.update(dt, player, police);
      if (controls.horn && player.vehicle) {
        audio.playHorn();
        if (peds.alertGunfire) peds.alertGunfire(player.pos, 18);
      }
      if (controls.save) saveNow(true);

      // Death / arrest transitions are driven by the player's respawn timer; once it runs out
      // the player has been moved to the hospital or the precinct and the respawn grace begins.
      if (player.deadTimer > 0) {
        machine.go(player.busted ? GameState.BUSTED : GameState.WASTED);
      } else if (machine.is(GameState.WASTED, GameState.BUSTED)) {
        machine.go(GameState.RESPAWN);
      } else if (machine.is(GameState.RESPAWN) && machine.timeInState > 1.5) {
        machine.go(GameState.PLAYING);
      }

      autosaveTimer -= dt;
      if (autosaveTimer <= 0 && machine.is(GameState.PLAYING)) {
        autosaveTimer = SAVE_CFG.autosaveSeconds;
        saveNow(false);
      }
    }

    renderRig.updateAtmosphere(player.pos, simTime);
    hud.update(simTime, city, player, police, missions, vehicles, combat);

    if (useInput) input.endFrame();
  }

  // Draw-call and triangle counts for the last rendered frame, plus timing and state.
  function collectStats(extra = {}) {
    const info = renderRig.renderer.info;
    lastStats = {
      calls: info.render.calls,
      triangles: info.render.triangles,
      post: renderRig.postEnabled,
      tier: renderRig.qualityTier ? renderRig.qualityTier.id : guard.tier,
      state: machine.state,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      ...extra,
    };
    window.__VICE_MERIDIAN_STATS__ = lastStats;
    return lastStats;
  }

  if (isShotMode) {
    input.frozen = true;
    machine.go(GameState.PLAYING);
    hud.hideLoading(true);
    hud.setShotMode(true);
    hud.setOverlay(false);
    hud.setVisible(true);

    shotInfo = setupShotScene(shot, ctx);

    // Advance simulation deterministically by fixed dt = 1/60 for requested seconds (default small settle if t=0)
    const targetT = advanceT > 0 ? advanceT : 0.4;
    const steps = Math.max(1, Math.round(targetT / FIXED_DT));
    for (let i = 0; i < steps; i++) {
      stepSimulation(FIXED_DT, false);
    }

    renderRig.updateAtmosphere(player.pos, simTime);
    player.updateCamera(FIXED_DT);
    hud.update(simTime, city, player, police, missions, vehicles, combat);
    renderRig.render();
    // Frame stats for budget checks (draw calls cover every pass of the final frame). Timing
    // fields are null in shot mode so the object itself is deterministic.
    collectStats({ shot, seed, simTime: +simTime.toFixed(3), fps: null, frameMs: null });
    reportProgress('ready');
    window.__VICE_MERIDIAN_READY__ = true;
    return;
  }

  // Interactive mode setup
  machine.go(GameState.TITLE);
  renderRig.dayCycle = true;
  hud.setShotMode(false);
  hud.setOverlay(true, 'PLAY VICE MERIDIAN');
  hud.setVisible(forceHud);
  hud.setContinueAvailable(Boolean(readSave()));
  renderRig.updateAtmosphere(player.pos, simTime);
  player.updateCamera(FIXED_DT);
  hud.update(simTime, city, player, police, missions, vehicles, combat);
  const f = front();
  if (f) {
    applySettings(f.getSettings());
    f.onChange(applySettings);
  }
  if (audio.attachUiSounds) audio.attachUiSounds(hud.overlay);
  reportProgress('ready');
  hud.hideLoading(false);

  const startPlay = () => {
    if (machine.is(GameState.TITLE, GameState.PAUSED)) machine.go(GameState.PLAYING);
  };
  const continueSaved = () => {
    const data = readSave();
    if (data) applySave(ctx, data);
    if (machine.is(GameState.TITLE, GameState.PAUSED)) machine.go(GameState.PLAYING);
    if (data) hud.notify(`Save loaded — $${data.cash.toLocaleString('en-US')}`, 'cash', 3);
  };

  hud.playBtn.addEventListener('click', startPlay);
  if (hud.continueBtn) hud.continueBtn.addEventListener('click', continueSaved);
  // Clicking anywhere on the title screen (outside the buttons and menus) also starts and unlocks audio.
  hud.overlay.addEventListener('click', (e) => {
    if (e.target === hud.overlay) startPlay();
  });
  window.addEventListener('keydown', (e) => {
    // Enter inside a menu control belongs to that control, not to "start".
    const inForm = e.target && e.target.closest && e.target.closest('#front-panels');
    const resumeKey = (!inForm && (e.code === 'Enter' || e.code === 'NumpadEnter')) || ((e.code === 'KeyP' || e.code === 'Escape') && machine.is(GameState.PAUSED) && !input.pointerLocked);
    if (resumeKey && machine.is(GameState.TITLE, GameState.PAUSED)) {
      startPlay();
      // The same key press is also queued in the input controller; drop it so the first
      // simulation tick does not read it as "pause" again.
      input.flush();
    }
  });
  canvas.addEventListener('click', () => {
    if (machine.is(GameState.PLAYING, GameState.RESPAWN) && !input.pointerLocked) {
      audio.unlock();
      input.requestPointerLock();
    }
  });
  // Save on tab close so progress is never lost.
  window.addEventListener('beforeunload', () => {
    if (!machine.is(GameState.TITLE, GameState.BOOT)) writeSave(ctx);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && machine.can(GameState.PAUSED)) machine.go(GameState.PAUSED);
  });

  // Fixed-timestep interactive render loop with a frame-budget guard.
  let lastNow = performance.now();
  let accumulator = 0;
  let statsClock = 0;

  function frame(now) {
    requestAnimationFrame(frame);
    const intervalMs = now - lastNow;
    const frameDt = Math.min(0.1, intervalMs / 1000);
    lastNow = now;
    const workStart = performance.now();

    if (SIMULATING.has(machine.state)) {
      accumulator += frameDt;
      // Cap catch-up steps so a long hitch cannot spiral into ever-longer frames.
      let stepsThisFrame = 0;
      while (accumulator >= FIXED_DT && stepsThisFrame < 6) {
        stepSimulation(FIXED_DT, true);
        accumulator -= FIXED_DT;
        stepsThisFrame++;
        if (!SIMULATING.has(machine.state)) break;
      }
      if (stepsThisFrame >= 6) accumulator = 0;
    } else if (machine.is(GameState.TITLE)) {
      // Gently orbit camera on the title screen over sun-soaked Palmetto Strip
      simTime += frameDt * 0.45;
      city.update(simTime);
      const orbitAngle = simTime * 0.25;
      const focusX = CITY.fixerPos.x + 8;
      const focusZ = CITY.fixerPos.z;
      renderRig.camera.position.set(
        focusX + Math.cos(orbitAngle) * 34,
        14.5,
        focusZ + Math.sin(orbitAngle) * 34,
      );
      renderRig.camera.lookAt(focusX, 5, focusZ);
      renderRig.updateAtmosphere(player.pos, simTime);
    } else {
      // Paused: hold the last gameplay frame (camera stays where the player left it).
      accumulator = 0;
    }

    renderRig.render();
    const workMs = performance.now() - workStart;
    guard.sample(workMs, intervalMs);
    statsClock += frameDt;
    if (statsClock > 0.25) {
      statsClock = 0;
      const s = collectStats({ fps: Math.round(guard.fps), frameMs: +guard.smoothedMs.toFixed(2) });
      hud.setStats(`${s.fps} fps · ${s.frameMs} ms · ${s.calls} calls · ${(s.triangles / 1000).toFixed(1)}k tris · ${s.tier.toUpperCase()} · ${s.state}`);
    }
  }

  requestAnimationFrame(frame);
}

boot().catch((err) => {
  // Surface boot failures on the loading veil instead of leaving a silent black page.
  console.error(err);
  const stepEl = document.getElementById('loading-step');
  if (stepEl) stepEl.textContent = `Failed to start: ${err && err.message ? err.message : err}`;
});
