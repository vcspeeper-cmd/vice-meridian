import * as THREE from 'three';
import { CITY, DIFFICULTY } from './config.js';

// ---------------------------------------------------------------------------
// Marker visuals
// ---------------------------------------------------------------------------

// Radial gradient: transparent in the middle, hot band at 55–72% radius, fading out.
function makeGlowRingTexture(colorHex) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  // Guard the colour so a bad value cannot produce NaN channel bytes.
  if (!isFinite(colorHex) || colorHex < 0 || colorHex > 0xffffff) {
    colorHex = 0xffffff;
  }
  const r = (colorHex >> 16) & 255;
  const gg = (colorHex >> 8) & 255;
  const b = colorHex & 255;
  const cx = size / 2;
  const grad = g.createRadialGradient(cx, cx, size * 0.18, cx, cx, cx);
  grad.addColorStop(0, `rgba(${r},${gg},${b},0)`);
  grad.addColorStop(0.55, `rgba(${r},${gg},${b},0.55)`);
  grad.addColorStop(0.72, `rgba(${r},${gg},${b},0.9)`);
  grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

// Ground marker: glow disc, flat ring, light column and a floating diamond.
function createMarkerMesh(colorHex) {
  const group = new THREE.Group();

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.5, 1.85, 32),
    new THREE.MeshBasicMaterial({ color: colorHex, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.28;

  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(6.4, 6.4),
    new THREE.MeshBasicMaterial({
      map: makeGlowRingTexture(colorHex),
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.26;

  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.6, 16, 12, 1, true),
    new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: 0.24,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  beam.position.y = 8.2;

  const diamond = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.55, 0),
    new THREE.MeshBasicMaterial({ color: colorHex }),
  );
  diamond.scale.set(0.8, 1.35, 0.8);
  diamond.position.y = 3.2;

  group.add(glow, ring, beam, diamond);
  return { group, diamond, ring, glow, beam };
}

// Low-poly gang soldier: dark trousers, red jacket, rifle held forward.
function createEnemyMesh() {
  const root = new THREE.Group();
  const jacket = new THREE.MeshLambertMaterial({ color: 0xb82e46 });
  const pants = new THREE.MeshLambertMaterial({ color: 0x1d2028 });
  const skin = new THREE.MeshLambertMaterial({ color: 0xcf946e });
  const gun = new THREE.MeshLambertMaterial({ color: 0x1e222a });

  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.78, 0.24), pants);
  legs.position.y = 0.4;
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.66, 0.28), jacket);
  torso.position.y = 1.12;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.3, 0.28), skin);
  head.position.y = 1.64;
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.54, 0.16), jacket);
  arm.position.set(0.32, 1.26, 0.22);
  arm.rotation.x = -1.35;
  const rifle = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.55), gun);
  rifle.position.set(0.32, 1.28, 0.6);

  root.add(legs, torso, head, arm, rifle);
  return root;
}

// ---------------------------------------------------------------------------
// Mission catalogue
// ---------------------------------------------------------------------------

// Indices 0..2 are referenced by the screenshot setups; STORY_ORDER below chains
// all five into one arc.
export const MISSION_DEFS = [
  {
    id: 'sunset_drop',
    title: 'Sunset Courier',
    giver: 'TESSA MARLOW',
    briefing: 'Rico, run this ledger down to the Marisol Marina drop before Bishop spots our runner. You have ninety seconds.',
    reward: 900,
    objective: 'Deliver the ledger to Marisol Marina',
    targetPos: { x: 196, z: -140 },
    timeLimit: 90,
    kind: 'delivery',
  },
  {
    id: 'coral_heist',
    title: 'Hot Coral',
    giver: 'TESSA MARLOW',
    briefing: 'Bishop parked a custom Coral 88 Spider by Hotel Palmetto. Boost it and stash it in your Old Meridian garage — in one piece.',
    reward: 1600,
    objective: 'Steal the Coral 88 Spider and deliver it to your garage',
    carSpawn: { x: 148, z: -85, heading: Math.PI },
    dropoffPos: { x: CITY.garagePos.x, z: CITY.garagePos.z },
    kind: 'car_theft',
  },
  {
    id: 'pier4_reckoning',
    title: 'Pier 4 Reckoning',
    giver: 'TESSA MARLOW',
    briefing: "Bishop's crew hijacked our cargo at Pier 4 Freight. Clear them out of Dockside — and expect reinforcements.",
    reward: 2500,
    objective: "Eliminate Bishop's crew",
    arenaCenter: { x: 105, z: 175 },
    kind: 'shootout',
    finale: true,
    enemySpawns: [
      { x: 96, z: 176 },
      { x: 112, z: 178 },
      { x: 103, z: 186 },
      { x: 117, z: 170 },
      { x: 91, z: 185 },
    ],
    // Second wave arrives from the freight gate once the first is down; Bishop leads it.
    waves: [
      null,
      {
        dialogue: "That's Bishop's van at the gate — he brought everyone. End this, Rico.",
        spawns: [
          { x: 86, z: 166, health: 65 },
          { x: 124, z: 164, health: 65 },
          { x: 108, z: 160, health: 140, boss: true },
          { x: 98, z: 162, health: 65 },
        ],
      },
    ],
  },
  {
    id: 'heat_wave',
    title: 'Heat Wave',
    giver: 'TESSA MARLOW',
    briefing: 'Bishop tipped off Meridian PD — every cruiser in the bay is coming for you. Stay alive and stay free for forty-five seconds while my people move the cargo.',
    reward: 2000,
    objective: 'Survive the three-star manhunt',
    surviveTime: 45,
    stars: 3,
    kind: 'survive',
  },
  {
    id: 'harbor_express',
    title: 'Harbor Express',
    giver: 'TESSA MARLOW',
    briefing: "There's a Harborbox van behind the hotel full of things nobody should see. Get it to the Dockside freight gate in two minutes and don't put a scratch on it.",
    reward: 1200,
    objective: 'Deliver the van to the Dockside freight gate',
    carSpawn: { x: 135, z: -52, heading: 0 },
    carType: 'van',
    carColor: 0xe6e2d8,
    targetPos: { x: 70, z: 128 },
    timeLimit: 120,
    maxDamage: 60,
    kind: 'car_delivery',
  },
];

// Five-chapter arc: deliver the van on the clock, survive a three-star manhunt, beat the
// drop window, boost the Coral 88, then the two-wave finale at Pier 4.
export const STORY_ORDER = [4, 3, 0, 1, 2];

// Base contract value plus the bonuses that reward clean, fast play.
export const REWARD_TABLE = {
  timeBonusPerSecond: 8,
  noDamageBonus: 300,
  accuracyBonus: 400,
  accuracyThreshold: 0.5,
  carConditionBonus: 250,
  finaleBonus: 1000,
  difficultyMultiplier: { easy: 0.8, normal: 1, hard: 1.35 },
};

// Total payout for a finished mission plus an itemised breakdown for the dialogue line.
export function computeReward(def, { timeRemaining = 0, tookDamage = false, accuracy = 0, carHealth = null, difficulty = 'normal' } = {}) {
  const parts = [{ label: 'contract', amount: def.reward }];
  const timed = def.kind === 'delivery' || def.kind === 'car_delivery';
  if (timeRemaining > 0 && timed) {
    parts.push({ label: 'time', amount: Math.round(timeRemaining * REWARD_TABLE.timeBonusPerSecond) });
  }
  if (!tookDamage) parts.push({ label: 'untouched', amount: REWARD_TABLE.noDamageBonus });
  if (def.kind === 'shootout' && accuracy >= REWARD_TABLE.accuracyThreshold) {
    parts.push({ label: 'marksman', amount: REWARD_TABLE.accuracyBonus });
  }
  if (carHealth !== null && carHealth >= 90) parts.push({ label: 'mint condition', amount: REWARD_TABLE.carConditionBonus });
  if (def.finale) parts.push({ label: 'finale', amount: REWARD_TABLE.finaleBonus });
  const mult = REWARD_TABLE.difficultyMultiplier[difficulty] ?? 1;
  let sum = 0;
  for (const p of parts) sum += p.amount;
  return { total: Math.round(sum * mult), parts, mult };
}

// Health / armour / cash pickups dotted around both grids; they respawn after a minute.
const PICKUP_SPOTS = [
  { x: -175, z: -93, kind: 'health' },
  { x: -70, z: -52, kind: 'health' },
  { x: -245, z: 0, kind: 'armour' },
  { x: -315, z: -140, kind: 'cash' },
  { x: CITY.waterStartX + CITY.pierLength - 12, z: CITY.pierZ, kind: 'armour' },
  { x: 70, z: 158, kind: 'armour' },
  { x: -140, z: 158, kind: 'cash' },
  { x: 0, z: -175, kind: 'health' },
];
const PICKUP_COLORS = { health: 0x4ce88b, armour: 0x2fb8ff, cash: 0xffd84d };
const PICKUP_RADIUS = 1.6;
const PICKUP_RESPAWN_TIME = 60;
const FIXER_INTERACT_RANGE = 6.5;

// ---------------------------------------------------------------------------
// Mission manager
// ---------------------------------------------------------------------------

export class MissionManager {
  constructor(scene, vehicles, police, rng) {
    this.scene = scene;
    this.vehicles = vehicles;
    this.police = police;
    this.rng = rng;

    this.completedCount = 0;
    this.activeMission = null;
    this.stage = 'idle';
    this.targetVehicle = null;
    this.enemies = [];

    this.objectiveText = 'Meet Tessa Marlow at Palmetto Strip (Press E)';
    this.objectiveTag = 'NEXT CONTRACT';
    this.dialogueSpeaker = '';
    this.dialogueText = '';
    this.dialogueTimer = 0;

    // Timed objectives (countdown shown in the HUD banner) and the survival clock.
    this.timerRemaining = 0;
    this.surviveElapsed = 0;
    this.retryWindow = 0;
    this.failedDef = null;

    // Toast text ("MISSION PASSED", "MISSION FAILED", ...).
    this.toastText = '';
    this.toastTimer = 0;
    this.toastFail = false;

    this.giverMarker = createMarkerMesh(0xffa947);
    this.giverMarker.group.position.set(CITY.fixerPos.x, 0, CITY.fixerPos.z);
    this.scene.add(this.giverMarker.group);

    this.objectiveMarker = createMarkerMesh(0xffb85a);
    this.objectiveMarker.group.visible = false;
    this.scene.add(this.objectiveMarker.group);

    this.objectivePos = new THREE.Vector3(CITY.fixerPos.x, 0, CITY.fixerPos.z);

    // Story log the HUD reads: per-mission state, attempts and the payout actually earned.
    this.logState = {};
    for (const def of MISSION_DEFS) this.logState[def.id] = { state: 'pending', attempts: 0, earned: 0 };
    this.difficulty = 'normal';
    this.timeScale = 1;

    // Per-attempt tracking for the reward bonuses.
    this.wave = 0;
    this.tookDamage = false;
    this.attemptStartHealth = 100;
    this.attemptShotsFired = 0;
    this.attemptShotsHit = 0;
    this.lastReward = null;

    this.pickups = [];
    const pickupGeo = new THREE.OctahedronGeometry(0.45, 0);
    for (const spot of PICKUP_SPOTS) {
      const mesh = new THREE.Mesh(pickupGeo, new THREE.MeshBasicMaterial({ color: PICKUP_COLORS[spot.kind] }));
      mesh.position.set(spot.x, 1.1, spot.z);
      this.scene.add(mesh);
      this.pickups.push({ ...spot, mesh, taken: false, respawn: 0 });
    }
  }

  // -------------------------------------------------------------------------
  // HUD text helpers
  // -------------------------------------------------------------------------

  showDialogue(speaker, text, duration = 6.5) {
    this.dialogueSpeaker = speaker;
    this.dialogueText = text;
    this.dialogueTimer = duration;
  }

  showToast(text, fail = false, duration = 3.2) {
    this.toastText = text;
    this.toastFail = fail;
    this.toastTimer = duration;
  }

  getNextMissionDef() {
    return MISSION_DEFS[STORY_ORDER[this.completedCount % STORY_ORDER.length]];
  }

  setDifficulty(level) {
    this.difficulty = level in REWARD_TABLE.difficultyMultiplier ? level : 'normal';
    this.timeScale = DIFFICULTY[this.difficulty] ? DIFFICULTY[this.difficulty].missionTime : 1;
  }

  // Story log in chapter order: { id, title, chapter, state, attempts, reward }.
  getLog() {
    return STORY_ORDER.map((idx, i) => {
      const def = MISSION_DEFS[idx];
      const st = this.logState[def.id];
      return { id: def.id, title: `${i + 1}. ${def.title}`, chapter: i + 1, state: st.state, attempts: st.attempts, reward: st.earned };
    });
  }

  get storyChapter() {
    return (this.completedCount % STORY_ORDER.length) + 1;
  }

  // -------------------------------------------------------------------------
  // Mission lifecycle
  // -------------------------------------------------------------------------

  startMission(def, player = null, combat = null) {
    this.clearEnemies();
    this.activeMission = def;
    this.failedDef = null;
    this.retryWindow = 0;
    this.timerRemaining = 0;
    this.surviveElapsed = 0;
    this.wave = 0;
    this.tookDamage = false;
    this.attemptStartHealth = player ? player.health + player.armour : 200;
    this.attemptShotsFired = combat ? combat.shotsFired : 0;
    this.attemptShotsHit = combat ? combat.shotsHit || 0 : 0;

    const log = this.logState[def.id];
    if (log) {
      log.state = 'active';
      log.attempts++;
    }
    this.giverMarker.group.visible = false;
    this.objectiveMarker.group.visible = true;
    this.objectiveTag = `CH.${this.storyChapter} · ${def.title.toUpperCase()}`;
    this.showDialogue(def.giver, def.briefing, 7.5);

    if (def.kind === 'delivery') {
      this.beginDelivery(def);
    } else if (def.kind === 'car_delivery') {
      this.beginCarDelivery(def);
    } else if (def.kind === 'car_theft') {
      this.beginCarTheft(def);
    } else if (def.kind === 'shootout') {
      this.beginShootout(def);
    } else if (def.kind === 'survive') {
      this.beginSurvive(def);
    }
  }

  beginDelivery(def) {
    this.stage = 'deliver';
    this.objectivePos.set(def.targetPos.x, 0, def.targetPos.z);
    this.objectiveMarker.group.position.copy(this.objectivePos);
    this.objectiveText = def.objective;
    this.timerRemaining = (def.timeLimit || 0) * this.timeScale;
  }

  beginCarDelivery(def) {
    this.stage = 'board';
    this.targetVehicle = this.vehicles.spawnVehicle(def.carType, def.carSpawn.x, def.carSpawn.z, def.carSpawn.heading, {
      color: def.carColor,
      aiMode: 'parked',
    });
    this.objectivePos.set(def.carSpawn.x, 0, def.carSpawn.z);
    this.objectiveMarker.group.position.copy(this.objectivePos);
    this.objectiveText = `Get in the ${this.targetVehicle.spec.name}`;
    this.timerRemaining = def.timeLimit * this.timeScale;
  }

  beginCarTheft(def) {
    this.stage = 'steal_car';
    this.targetVehicle = this.vehicles.spawnVehicle('convertible', def.carSpawn.x, def.carSpawn.z, def.carSpawn.heading, {
      color: 0xff5c4d,
      aiMode: 'parked',
    });
    this.objectivePos.set(def.carSpawn.x, 0, def.carSpawn.z);
    this.objectiveMarker.group.position.copy(this.objectivePos);
    this.objectiveText = 'Steal the Coral 88 Spider near Hotel Palmetto';
  }

  beginShootout(def) {
    this.stage = 'eliminate';
    this.objectivePos.set(def.arenaCenter.x, 0, def.arenaCenter.z);
    this.objectiveMarker.group.position.copy(this.objectivePos);
    for (let i = 0; i < def.enemySpawns.length; i++) {
      const sp = def.enemySpawns[i];
      this.spawnEnemy(sp.x, sp.z);
    }
    this.updateShootoutText();
  }

  beginSurvive(def) {
    this.stage = 'survive';
    this.police.setStars(Math.max(this.police.stars, def.stars));
    this.timerRemaining = def.surviveTime / this.timeScale;
    this.objectiveMarker.group.visible = false;
    this.objectiveText = def.objective;
  }

  // Bring in the next shootout wave (index into def.waves); returns false when none is left.
  spawnWave(def, index) {
    const wave = def.waves && def.waves[index];
    if (!wave) return false;
    this.wave = index;
    for (const sp of wave.spawns) {
      const e = this.spawnEnemy(sp.x, sp.z, { health: sp.health, heading: 0 });
      if (sp.boss) {
        e.boss = true;
        e.mesh.scale.setScalar(1.15);
      }
    }
    if (wave.dialogue) this.showDialogue('TESSA MARLOW', wave.dialogue, 6);
    this.showToast(`WAVE ${index + 1}`, false, 2);
    return true;
  }

  spawnEnemy(x, z, opts = {}) {
    const mesh = createEnemyMesh();
    mesh.position.set(x, 0.22, z);
    this.scene.add(mesh);
    const enemy = {
      id: `crew_${this.enemies.length + 1}`,
      mesh,
      pos: new THREE.Vector3(x, 0.22, z),
      heading: opts.heading ?? 0,
      health: opts.health ?? 65,
      alive: opts.alive !== undefined ? opts.alive : true,
      fireCooldown: this.rng.range(0.5, 1.3),
      faction: 'gang',
      hitFlash: 0,
    };
    if (!enemy.alive) {
      mesh.rotation.x = Math.PI * 0.5;
      mesh.position.y = 0.28;
    }
    this.enemies.push(enemy);
    return enemy;
  }

  clearEnemies() {
    for (const e of this.enemies) this.scene.remove(e.mesh);
    this.enemies.length = 0;
  }

  updateShootoutText() {
    const total = this.enemies.length || 5;
    let dead = 0;
    for (const e of this.enemies) if (!e.alive) dead++;
    const def = this.activeMission;
    const waveCount = def && def.waves ? def.waves.length : 1;
    const waveText = waveCount > 1 ? ` · wave ${this.wave + 1}/${waveCount}` : '';
    this.objectiveText = `Eliminate Bishop's crew ${dead}/${total}${waveText}`;
  }

  resetToGiver(tag, text) {
    this.activeMission = null;
    this.targetVehicle = null;
    this.stage = 'idle';
    this.timerRemaining = 0;
    this.objectiveMarker.group.visible = false;
    this.giverMarker.group.visible = true;
    this.objectivePos.set(CITY.fixerPos.x, 0, CITY.fixerPos.z);
    this.objectiveTag = tag;
    this.objectiveText = text;
  }

  completeMission(player, audio, combat = null) {
    const def = this.activeMission;
    const fired = combat ? combat.shotsFired - this.attemptShotsFired : 0;
    const hit = combat ? (combat.shotsHit || 0) - this.attemptShotsHit : 0;
    const tv = this.targetVehicle;
    const carriesCar = def.kind === 'car_delivery' || def.kind === 'car_theft';
    const payout = computeReward(def, {
      timeRemaining: this.timerRemaining,
      tookDamage: this.tookDamage,
      accuracy: fired > 0 ? hit / fired : 0,
      carHealth: carriesCar ? (tv && tv.health !== undefined ? tv.health : 100) : null,
      difficulty: this.difficulty,
    });
    const reward = payout.total;
    this.lastReward = payout;
    player.money += reward;
    this.completedCount++;

    const log = this.logState[def.id];
    if (log) {
      log.state = 'passed';
      log.earned = Math.max(log.earned, reward);
    }

    const extra = payout.parts.slice(1);
    const bonusText = extra.length > 0 ? ` (${extra.map((p) => `${p.label} +$${p.amount}`).join(', ')})` : '';
    if (player.money >= 1500 && !player.weaponsState[1].unlocked) {
      player.weaponsState[1].unlocked = true;
      this.showDialogue('TESSA MARLOW', `Clean work, Rico. +$${reward}${bonusText}. Unlocked MERIDIAN V-9 SMG (Press 3).`, 7.0);
    } else if (def.kind === 'survive') {
      this.police.resetWanted();
      this.showDialogue('TESSA MARLOW', `Cargo's clear and I called in a favour — MPD stood down. +$${reward}${bonusText}.`, 6.5);
    } else {
      this.showDialogue('TESSA MARLOW', `Contract closed, Rico. Wired $${reward}${bonusText}. Come back for the next job.`, 6.5);
    }

    if (audio) {
      if (audio.playMissionJingle) audio.playMissionJingle(true);
      else if (audio.playMissionComplete) audio.playMissionComplete();
      else audio.playMissionChime();
    }
    this.showToast('MISSION PASSED', false, 3.5);

    if (this.completedCount % STORY_ORDER.length === 0) {
      this.resetToGiver('STORY COMPLETE', 'Bishop is finished. Tessa has more work on Palmetto Strip (Press E)');
    } else {
      this.resetToGiver('NEXT CONTRACT', `Return to Tessa Marlow for "${this.getNextMissionDef().title}" (Press E)`);
    }
  }

  failMission(reason, audio) {
    const def = this.activeMission;
    if (!def) return;
    this.clearEnemies();
    if (this.targetVehicle && this.targetVehicle.aiMode === 'parked' && this.vehicles.removeVehicle) {
      this.vehicles.removeVehicle(this.targetVehicle);
    }
    const log = this.logState[def.id];
    if (log && log.state !== 'passed') log.state = 'failed';
    if (audio && audio.playMissionJingle) audio.playMissionJingle(false);
    else if (audio && audio.playMissionFailed) audio.playMissionFailed();
    this.showToast('MISSION FAILED', true, 3.5);
    this.showDialogue(def.giver, `${reason} Press E within ten seconds to try again, or come find me.`, 7);
    this.failedDef = def;
    this.retryWindow = 10;
    this.resetToGiver('MISSION FAILED', `${reason} — Press E to retry "${def.title}"`);
  }

  // -------------------------------------------------------------------------
  // Prompts, markers, pickups
  // -------------------------------------------------------------------------

  getPrompt(player) {
    if (this.failedDef && this.retryWindow > 0 && player.deadTimer <= 0) {
      return `Press E — Retry "${this.failedDef.title}" (${Math.ceil(this.retryWindow)})`;
    }
    if (!this.activeMission) {
      const dist = Math.hypot(player.pos.x - CITY.fixerPos.x, player.pos.z - CITY.fixerPos.z);
      if (dist < FIXER_INTERACT_RANGE) {
        const next = this.getNextMissionDef();
        return `Press E — Start "${next.title}" ($${next.reward})`;
      }
    }
    if (!player.vehicle) {
      const near = this.vehicles.findNearestVehicle(player.pos, 4.6);
      if (near) return `Press F — Enter ${near.spec.name}`;
    } else {
      const gDist = Math.hypot(player.pos.x - CITY.garagePos.x, player.pos.z - CITY.garagePos.z);
      if (gDist < FIXER_INTERACT_RANGE) return `Garage — Stored ${player.vehicle.spec.name}`;
    }
    return '';
  }

  // Bob, spin and pulse the markers; also called in shot mode where update() is not run.
  animateMarkers(time) {
    for (const m of [this.giverMarker, this.objectiveMarker]) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 3.2);
      m.diamond.position.y = 3.2 + Math.sin(time * 2.4) * 0.22;
      m.glow.scale.setScalar(0.9 + pulse * 0.25);
      m.glow.material.opacity = 0.5 + pulse * 0.35;
      m.ring.material.opacity = 0.65 + pulse * 0.3;
    }
    for (const pk of this.pickups) {
      pk.mesh.rotation.y = time * 2 + pk.x * 0.1;
      pk.mesh.position.y = 1.1 + Math.sin(time * 2.6 + pk.z) * 0.18;
    }
  }

  updatePickups(dt, player, audio) {
    for (const pk of this.pickups) {
      if (pk.taken) {
        pk.respawn -= dt;
        if (pk.respawn <= 0) {
          pk.taken = false;
          pk.mesh.visible = true;
        }
        continue;
      }
      if (player.deadTimer > 0 || player.vehicle) continue;
      if (Math.hypot(player.pos.x - pk.x, player.pos.z - pk.z) > PICKUP_RADIUS) continue;
      if (pk.kind === 'health') {
        if (player.health >= 100) continue;
        player.health = Math.min(100, player.health + 50);
      } else if (pk.kind === 'armour') {
        if (player.armour >= 100) continue;
        player.armour = Math.min(100, player.armour + 50);
      } else {
        player.money += 250;
      }
      pk.taken = true;
      pk.respawn = PICKUP_RESPAWN_TIME;
      pk.mesh.visible = false;
      if (audio && audio.playPickup) audio.playPickup();
    }
  }

  // -------------------------------------------------------------------------
  // Save / load
  // -------------------------------------------------------------------------

  serialize() {
    const log = {};
    for (const [id, st] of Object.entries(this.logState)) {
      log[id] = { state: st.state === 'active' ? 'pending' : st.state, attempts: st.attempts, earned: st.earned };
    }
    return { completed: this.completedCount, log };
  }

  restore(data) {
    if (!data || !Number.isFinite(data.completed)) return;
    this.completedCount = Math.max(0, data.completed | 0);
    if (data.log && typeof data.log === 'object') {
      for (const [id, st] of Object.entries(data.log)) {
        if (!this.logState[id] || !st) continue;
        this.logState[id].state = ['pending', 'passed', 'failed'].includes(st.state) ? st.state : 'pending';
        this.logState[id].attempts = Math.max(0, st.attempts | 0);
        this.logState[id].earned = Math.max(0, st.earned | 0);
      }
    } else {
      // Older saves only stored a count: mark that many chapters as passed.
      const chapters = Math.min(STORY_ORDER.length, this.completedCount);
      for (let i = 0; i < chapters; i++) {
        this.logState[MISSION_DEFS[STORY_ORDER[i]].id].state = 'passed';
      }
    }
    this.resetToGiver('NEXT CONTRACT', `Meet Tessa Marlow for "${this.getNextMissionDef().title}" (Press E)`);
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  update(dt, time, player, controls, combat, audio) {
    this.giverMarker.diamond.rotation.y = time * 1.8;
    this.objectiveMarker.diamond.rotation.y = time * 2.1;
    this.animateMarkers(time);
    this.updatePickups(dt, player, audio);

    if (this.toastTimer > 0) this.toastTimer -= dt;
    if (this.dialogueTimer > 0) {
      this.dialogueTimer -= dt;
      if (this.dialogueTimer <= 0) {
        this.dialogueSpeaker = '';
        this.dialogueText = '';
      }
    }

    if (!this.activeMission) {
      this.updateIdle(dt, player, controls, combat);
      return;
    }

    const def = this.activeMission;

    // Any mission fails if Rico is wasted or busted.
    if (player.deadTimer > 0) {
      this.failMission(player.busted ? 'You got busted.' : 'You were wasted.', audio);
      return;
    }
    if (player.health + player.armour < this.attemptStartHealth - 0.5) this.tookDamage = true;
    this.attemptStartHealth = Math.min(this.attemptStartHealth, player.health + player.armour);

    // Shared countdown for timed objectives.
    if (this.timerRemaining > 0 && (def.kind === 'delivery' || def.kind === 'car_delivery')) {
      this.timerRemaining -= dt;
      if (this.timerRemaining <= 0) {
        this.timerRemaining = 0;
        const reason = def.kind === 'car_delivery' ? 'Too slow — the buyer walked.' : 'Too slow — the drop window closed.';
        this.failMission(reason, audio);
        return;
      }
    }

    if (def.kind === 'delivery') this.updateDelivery(def, player, audio, combat);
    else if (def.kind === 'car_delivery') this.updateCarDelivery(def, player, audio, combat);
    else if (def.kind === 'car_theft') this.updateCarTheft(def, player, audio, combat);
    else if (def.kind === 'survive') this.updateSurvive(def, player, audio, combat);
    else if (def.kind === 'shootout') this.updateShootout(def, player, audio, combat);
  }

  // Between missions: retry window, then the fixer's start prompt.
  updateIdle(dt, player, controls, combat) {
    if (this.retryWindow > 0) {
      this.retryWindow -= dt;
      if (controls.interact && this.failedDef && player.deadTimer <= 0) {
        this.startMission(this.failedDef, player, combat);
        return;
      }
      if (this.retryWindow <= 0) this.failedDef = null;
    }
    const dist = Math.hypot(player.pos.x - CITY.fixerPos.x, player.pos.z - CITY.fixerPos.z);
    if (dist < FIXER_INTERACT_RANGE && controls.interact) {
      this.startMission(this.getNextMissionDef(), player, combat);
    }
  }

  updateDelivery(def, player, audio, combat) {
    const dist = Math.hypot(player.pos.x - def.targetPos.x, player.pos.z - def.targetPos.z);
    if (dist < 6.0) this.completeMission(player, audio, combat);
  }

  updateCarDelivery(def, player, audio, combat) {
    const tv = this.targetVehicle;
    const condition = tv && tv.health !== undefined ? tv.health : 100;
    if (!tv || tv.destroyed || condition <= 100 - def.maxDamage) {
      this.failMission('The van is too beaten up to deliver.', audio);
      return;
    }

    if (player.vehicle !== tv) {
      // Not in the van yet: point at the van wherever it now sits.
      this.stage = this.stage === 'board' ? 'board' : 'reboard';
      this.objectiveText = this.stage === 'board' ? `Get in the ${tv.spec.name}` : `Get back in the ${tv.spec.name}`;
      this.objectivePos.copy(tv.pos);
      this.objectiveMarker.group.position.set(tv.pos.x, 0, tv.pos.z);
      return;
    }

    this.stage = 'drive';
    this.objectiveText = `${def.objective} — condition ${Math.round(condition)}%`;
    this.objectivePos.set(def.targetPos.x, 0, def.targetPos.z);
    this.objectiveMarker.group.position.copy(this.objectivePos);
    const dist = Math.hypot(player.pos.x - def.targetPos.x, player.pos.z - def.targetPos.z);
    if (dist < 7 && Math.abs(tv.speed) < 6) this.completeMission(player, audio, combat);
  }

  updateCarTheft(def, player, audio, combat) {
    const tv = this.targetVehicle;
    if (tv && (tv.destroyed || (tv.health !== undefined && tv.health <= 0))) {
      this.failMission('The Coral 88 is wrecked.', audio);
      return;
    }

    if (this.stage === 'steal_car') {
      if (tv) {
        this.objectivePos.copy(tv.pos);
        this.objectiveMarker.group.position.set(this.objectivePos.x, 0, this.objectivePos.z);
      }
      if (player.vehicle !== tv) return;
      this.stage = 'dropoff';
      this.objectivePos.set(def.dropoffPos.x, 0, def.dropoffPos.z);
      this.objectiveMarker.group.position.copy(this.objectivePos);
      this.objectiveText = 'Lose the heat and stash the Coral 88 at your garage';
      this.police.reportCrime('car_theft', player.pos, 2);
      this.showDialogue('TESSA MARLOW', 'MPD spotted the boost! Shake them and bring the Coral 88 to your garage.', 6.0);
      return;
    }

    if (this.stage !== 'dropoff') return;
    const dist = Math.hypot(player.pos.x - def.dropoffPos.x, player.pos.z - def.dropoffPos.z);
    if (player.vehicle !== tv) {
      this.objectiveText = 'Get back in the Coral 88';
      this.objectivePos.copy(tv.pos);
      this.objectiveMarker.group.position.set(tv.pos.x, 0, tv.pos.z);
      return;
    }
    this.objectiveText = this.police.stars > 0
      ? 'Lose the heat, then stash the Coral 88 at your garage'
      : 'Stash the Coral 88 at your garage';
    this.objectivePos.set(def.dropoffPos.x, 0, def.dropoffPos.z);
    this.objectiveMarker.group.position.copy(this.objectivePos);
    if (dist < 6.5 && this.police.stars === 0) this.completeMission(player, audio, combat);
  }

  updateSurvive(def, player, audio, combat) {
    // Hold at least the mission's wanted level while the clock runs.
    if (this.police.stars < def.stars) this.police.setStars(def.stars);
    this.timerRemaining -= dt;
    this.surviveElapsed += dt;
    this.objectiveText = `Survive the manhunt — ${Math.ceil(Math.max(0, this.timerRemaining))}s`;
    if (this.timerRemaining <= 0) {
      this.timerRemaining = 0;
      this.completeMission(player, audio, combat);
    }
  }

  updateShootout(def, player, audio, combat) {
    let aliveCount = 0;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      aliveCount++;
      const dx = player.pos.x - e.pos.x;
      const dz = player.pos.z - e.pos.z;
      const dist = Math.hypot(dx, dz);
      e.heading = Math.atan2(dx, dz);
      e.mesh.rotation.y = e.heading;
      if (e.hitFlash > 0) e.hitFlash -= dt;
      e.fireCooldown -= dt;
      if (e.fireCooldown <= 0 && dist < 55 && player.deadTimer <= 0) {
        // Bishop fires in quicker bursts than his crew.
        e.fireCooldown = e.boss ? this.rng.range(0.5, 0.9) : this.rng.range(0.85, 1.7);
        combat.fireNpcShot(e, player);
      }
    }
    this.updateShootoutText();

    if (aliveCount === 0 && this.enemies.length > 0) {
      // Next wave if the def has one, otherwise the mission is won.
      if (this.spawnWave(def, this.wave + 1)) this.updateShootoutText();
      else this.completeMission(player, audio, combat);
    }
  }
}
