import * as THREE from 'three';
import { CITY, PED_CFG, TRAFFIC_CFG } from './config.js';

const SHIRT_COLORS = [0xff5d7a, 0x3bd8e0, 0xffb84d, 0xf2e9dc, 0x7a65ff, 0x52e088, 0xff784f, 0x2f3b52];
const PANTS_COLORS = [0x1f2634, 0x3b485c, 0xcab99c, 0x29323e, 0x5c4a3d];
const SKIN_TONES = [0xe8bc98, 0xd49b72, 0xb37852, 0x8a5638, 0xf0c9a8];

// Distinct outfit archetypes. `shortSleeves` / `shorts` show skin on arms / lower legs,
// `hat` adds a brim, `speedScale` lets joggers outpace strollers.
const OUTFITS = [
  { id: 'local', weight: 4, shirts: SHIRT_COLORS, pants: PANTS_COLORS, shortSleeves: false, shorts: false, hat: null, speedScale: 1 },
  { id: 'tourist', weight: 3, shirts: [0xff5d7a, 0xffb84d, 0x3bd8e0, 0x52e088], pants: [0xcab99c, 0xe4d6b8], shortSleeves: true, shorts: true, hat: 0xf2e2b0, speedScale: 0.8 },
  { id: 'business', weight: 2, shirts: [0x2a2f3c, 0x3a3340, 0x23303a], pants: [0x1d2028, 0x2a2f3c], shortSleeves: false, shorts: false, hat: null, speedScale: 1.15 },
  { id: 'beach', weight: 2, shirts: [0xffffff, 0xff784f, 0x3bd8e0], pants: [0x2f8fd8, 0xff3b9a, 0xffd84d], shortSleeves: true, shorts: true, hat: null, speedScale: 0.75 },
  { id: 'jogger', weight: 1, shirts: [0x6dff88, 0xff3b9a, 0xffe14d], pants: [0x1f2634], shortSleeves: true, shorts: true, hat: 0x1f2634, speedScale: 2.1 },
];
const OUTFIT_TOTAL = OUTFITS.reduce((s, o) => s + o.weight, 0);
// Dock workers only appear when a pedestrian is (re)spawned in the industrial district.
const WORKER_OUTFIT = { id: 'worker', weight: 0, shirts: [0xff8c1a, 0xd8f23a], pants: [0x2c3a52, 0x3b3f46], shortSleeves: false, shorts: false, hat: 0xffd21a, speedScale: 0.95 };

// Spawn ring around the player: pedestrians farther than `despawn` are recycled to a sidewalk
// point between `inner` and `outer`, preferably behind the player so nobody pops into view.
const RING = { inner: 55, outer: 110, despawn: 150, recyclePerSecond: 5, deadLinger: 12 };
// Local avoidance: peds closer than `radius` push apart; the grid cell is the neighbour range.
const AVOID = { radius: 0.9, cell: 2, strength: 0.5 };

export class PedestrianManager {
  constructor(scene, city, rng, count = 88) {
    this.scene = scene;
    this.city = city;
    this.rng = rng;
    this.count = count;
    this.peds = [];

    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.torsoInst = new THREE.InstancedMesh(unitBox, mat, count);
    this.headInst = new THREE.InstancedMesh(unitBox, mat, count);
    this.legLInst = new THREE.InstancedMesh(unitBox, mat, count);
    this.legRInst = new THREE.InstancedMesh(unitBox, mat, count);
    // Arms (both arms share one instance buffer: 2 per ped) and hats.
    this.armInst = new THREE.InstancedMesh(unitBox, mat, count * 2);
    this.hatInst = new THREE.InstancedMesh(unitBox, mat, count);

    scene.add(this.torsoInst, this.headInst, this.legLInst, this.legRInst, this.armInst, this.hatInst);

    this.dummy = new THREE.Object3D();
    this.color = new THREE.Color();
    this.time = 0;
    // How many of the pool are simulated and drawn (quality tiers lower this).
    this.activeCount = count;
    this.recycleBudget = 0;
    this.recycled = 0;
    this.avoidGrid = new Map();
    this.sidewalks = this.city.annex && this.city.annex.sidewalkRects
      ? this.city.sidewalkRects.concat(this.city.annex.sidewalkRects)
      : this.city.sidewalkRects;

    this.spawnAll();
  }

  setActiveCount(n) {
    this.activeCount = Math.max(0, Math.min(this.peds.length, n | 0));
  }

  // Paint a ped's instance colours from its outfit (used at spawn and when recycled).
  applyColors(i) {
    const ped = this.peds[i];
    const outfit = ped.outfit;
    this.color.setHex(ped.shirt);
    this.torsoInst.setColorAt(i, this.color);
    this.color.setHex(ped.skin);
    this.headInst.setColorAt(i, this.color);
    this.color.setHex(outfit.shorts ? ped.skin : ped.pants);
    this.legLInst.setColorAt(i, this.color);
    this.legRInst.setColorAt(i, this.color);
    this.color.setHex(outfit.shortSleeves ? ped.skin : ped.shirt);
    this.armInst.setColorAt(i * 2, this.color);
    this.armInst.setColorAt(i * 2 + 1, this.color);
    this.color.setHex(outfit.hat !== null ? outfit.hat : ped.skin);
    this.hatInst.setColorAt(i, this.color);
  }

  markColorsDirty() {
    this.torsoInst.instanceColor.needsUpdate = true;
    this.headInst.instanceColor.needsUpdate = true;
    this.legLInst.instanceColor.needsUpdate = true;
    this.legRInst.instanceColor.needsUpdate = true;
    this.armInst.instanceColor.needsUpdate = true;
    this.hatInst.instanceColor.needsUpdate = true;
  }

  // A sidewalk point inside the spawn ring, biased behind the player. Returns null if none of a
  // few seeded tries qualifies (the ped then waits for a later frame).
  findRingSpawn(player) {
    const fx = Math.sin(player.heading);
    const fz = Math.cos(player.heading);
    for (let attempt = 0; attempt < 8; attempt++) {
      const rect = this.rng.pick(this.sidewalks);
      const alongX = this.rng.chance(0.5);
      const edge = this.rng.chance(0.5);
      const inset = 1.6;
      const x = alongX ? this.rng.range(rect.minX + inset, rect.maxX - inset) : edge ? rect.minX + inset : rect.maxX - inset;
      const z = alongX ? (edge ? rect.minZ + inset : rect.maxZ - inset) : this.rng.range(rect.minZ + inset, rect.maxZ - inset);
      const dx = x - player.pos.x;
      const dz = z - player.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < RING.inner || d > RING.outer) continue;
      // Reject points straight ahead of the player on the first tries.
      if (attempt < 5 && (dx * fx + dz * fz) / d > 0.35) continue;
      if (this.city.isBlocked && this.city.isBlocked(x, z, 1)) continue;
      const dir = alongX ? [this.rng.chance(0.5) ? 1 : -1, 0] : [0, this.rng.chance(0.5) ? 1 : -1];
      return { x, z, dirX: dir[0], dirZ: dir[1] };
    }
    return null;
  }

  // Move far-away (or long-dead) pedestrians back into the ring around the player.
  recycle(dt, player) {
    this.recycleBudget = Math.min(RING.recyclePerSecond, this.recycleBudget + dt * RING.recyclePerSecond);
    if (this.recycleBudget < 1) return;
    const despawn2 = RING.despawn * RING.despawn;
    for (let i = 0; i < this.activeCount && this.recycleBudget >= 1; i++) {
      const p = this.peds[i];
      const dx = p.pos.x - player.pos.x;
      const dz = p.pos.z - player.pos.z;
      const far = dx * dx + dz * dz > despawn2;
      const expiredBody = !p.alive && p.hitTimer <= -RING.deadLinger && dx * dx + dz * dz > 40 * 40;
      if (!far && !expiredBody) continue;
      const spot = this.findRingSpawn(player);
      if (!spot) break;
      this.recycleBudget -= 1;
      this.recycled++;
      this.placePedestrian(i, spot.x, spot.z, Math.atan2(spot.dirX, spot.dirZ), spot.dirX, spot.dirZ);
      // Fresh look: industrial streets get dock workers, everywhere else the normal mix.
      const district = this.city.districtAt ? this.city.districtAt(spot.x, spot.z) : 'residential';
      const outfit = district === 'industrial' && this.rng.chance(0.6) ? WORKER_OUTFIT : this.pickOutfit();
      p.outfit = outfit;
      p.shirt = this.rng.pick(outfit.shirts);
      p.pants = this.rng.pick(outfit.pants);
      p.skin = this.rng.pick(SKIN_TONES);
      p.speed = this.rng.range(1.4, 2.3) * outfit.speedScale;
      p.hitTimer = 0;
      this.applyColors(i);
      this.markColorsDirty();
    }
  }

  // Separation: bucket live, upright peds into a 2 m grid and push overlapping pairs apart.
  // Each ped also nudges its walking direction away so pairs slide past instead of jamming.
  applyAvoidance(dt) {
    const grid = this.avoidGrid;
    grid.clear();
    const cell = AVOID.cell;
    const key = (cx, cz) => cx * 73856093 ^ cz * 19349663;
    for (let i = 0; i < this.activeCount; i++) {
      const p = this.peds[i];
      if (!p.alive || p.knocked > 0) continue;
      const k = key(Math.floor(p.pos.x / cell), Math.floor(p.pos.z / cell));
      let list = grid.get(k);
      if (!list) {
        list = [];
        grid.set(k, list);
      }
      list.push(i);
    }
    const r = AVOID.radius;
    for (let i = 0; i < this.activeCount; i++) {
      const a = this.peds[i];
      if (!a.alive || a.knocked > 0) continue;
      const cx = Math.floor(a.pos.x / cell);
      const cz = Math.floor(a.pos.z / cell);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          const list = grid.get(key(cx + ox, cz + oz));
          if (!list) continue;
          for (const j of list) {
            if (j <= i) continue;
            const b = this.peds[j];
            const dx = b.pos.x - a.pos.x;
            const dz = b.pos.z - a.pos.z;
            const d2 = dx * dx + dz * dz;
            if (d2 >= r * r || d2 < 1e-8) continue;
            const d = Math.sqrt(d2);
            const push = (r - d) * 0.5;
            const nx = dx / d;
            const nz = dz / d;
            a.pos.x -= nx * push;
            a.pos.z -= nz * push;
            b.pos.x += nx * push;
            b.pos.z += nz * push;
            // Steer only free-running (panicking / dodging) peds; calm walkers keep their
            // axis-aligned sidewalk heading and just get shouldered aside by the push above.
            const s = AVOID.strength * dt * 4;
            const steer = (p, sx, sz) => {
              if (p.panic <= 0 && p.dodge <= 0 && !p.fleeing) return;
              p.dirX += sx * s;
              p.dirZ += sz * s;
              const l = Math.hypot(p.dirX, p.dirZ) || 1;
              p.dirX /= l;
              p.dirZ /= l;
            };
            steer(a, -nx, -nz);
            steer(b, nx, nz);
          }
        }
      }
    }
  }

  pickOutfit() {
    let roll = this.rng.next() * OUTFIT_TOTAL;
    for (const o of OUTFITS) {
      roll -= o.weight;
      if (roll <= 0) return o;
    }
    return OUTFITS[0];
  }

  spawnAll() {
    this.peds.length = 0;
    const swList = this.city.sidewalkRects;
    for (let i = 0; i < this.count; i++) {
      const rect = this.rng.pick(swList);
      const side = this.rng.int(0, 3);
      const inset = 1.6;
      let x, z, dirX, dirZ;
      if (side === 0) {
        x = this.rng.range(rect.minX + inset, rect.maxX - inset);
        z = rect.minZ + inset;
        dirX = this.rng.chance(0.5) ? 1 : -1;
        dirZ = 0;
      } else if (side === 1) {
        x = this.rng.range(rect.minX + inset, rect.maxX - inset);
        z = rect.maxZ - inset;
        dirX = this.rng.chance(0.5) ? 1 : -1;
        dirZ = 0;
      } else if (side === 2) {
        x = rect.minX + inset;
        z = this.rng.range(rect.minZ + inset, rect.maxZ - inset);
        dirX = 0;
        dirZ = this.rng.chance(0.5) ? 1 : -1;
      } else {
        x = rect.maxX - inset;
        z = this.rng.range(rect.minZ + inset, rect.maxZ - inset);
        dirX = 0;
        dirZ = this.rng.chance(0.5) ? 1 : -1;
      }

      const outfit = this.pickOutfit();
      const ped = {
        pos: new THREE.Vector3(x, 0.22, z),
        dirX,
        dirZ,
        heading: Math.atan2(dirX, dirZ),
        speed: this.rng.range(1.4, 2.3) * outfit.speedScale,
        phase: this.rng.range(0, Math.PI * 2),
        alive: true,
        fleeing: false,
        crossCooldown: this.rng.range(1, 5),
        outfit,
        shirt: this.rng.pick(outfit.shirts),
        pants: this.rng.pick(outfit.pants),
        skin: this.rng.pick(SKIN_TONES),
        hitTimer: 0,
        // Behaviour state
        panic: 0,
        fleeX: 0,
        fleeZ: 0,
        dodge: 0,
        dodgeX: 0,
        dodgeZ: 0,
        idle: 0,
        headYaw: 0,
        lookSeed: this.rng.range(0, Math.PI * 2),
        knocked: 0,
        knockDirX: 0,
        knockDirZ: 0,
      };
      this.peds.push(ped);
      this.applyColors(i);
    }
    this.markColorsDirty();
    this.syncInstances();
  }

  placePedestrian(index, x, z, heading, dirX, dirZ) {
    if (index < 0 || index >= this.peds.length) return;
    const p = this.peds[index];
    p.pos.set(x, 0.22, z);
    p.heading = heading;
    p.dirX = dirX;
    p.dirZ = dirZ;
    p.alive = true;
    p.fleeing = false;
    p.panic = 0;
    p.dodge = 0;
    p.idle = 0;
    p.knocked = 0;
  }

  // Gunfire (or a horn blast) makes everyone within `radius` bolt away from `source`.
  alertGunfire(source, radius = PED_CFG.panicDuration * 6) {
    const r2 = radius * radius;
    for (const p of this.peds) {
      if (!p.alive || p.knocked > 0) continue;
      const dx = p.pos.x - source.x;
      const dz = p.pos.z - source.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2) || 1;
      p.panic = PED_CFG.panicDuration * (0.7 + 0.3 * (1 - d / radius));
      p.fleeX = dx / d;
      p.fleeZ = dz / d;
      p.idle = 0;
    }
  }

  // A punch: the ped is knocked flat along `dir`, then gets up and runs.
  knockDown(p, dir) {
    if (!p.alive) return;
    p.knocked = 2.6;
    p.knockDirX = dir.x;
    p.knockDirZ = dir.z;
    p.heading = Math.atan2(-dir.x, -dir.z);
    p.panic = 0;
  }

  // Sidestep out of the path of any fast car heading toward this pedestrian.
  checkVehicleThreat(p, vehicles) {
    if (!vehicles || !vehicles.vehicles) return;
    const scareR2 = TRAFFIC_CFG.scareRadius * TRAFFIC_CFG.scareRadius;
    for (const v of vehicles.vehicles) {
      const spd = Math.abs(v.speed || 0);
      if (spd < TRAFFIC_CFG.scareSpeed) continue;
      const dx = p.pos.x - v.pos.x;
      const dz = p.pos.z - v.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > scareR2) continue;
      const sgn = v.speed >= 0 ? 1 : -1;
      const fx = Math.sin(v.heading) * sgn;
      const fz = Math.cos(v.heading) * sgn;
      const ahead = dx * fx + dz * fz;
      if (ahead <= 0) continue;
      const lateral = dx * fz - dz * fx;
      if (Math.abs(lateral) > 3.2) continue;
      // Dive to whichever side the ped is already on.
      const side = lateral >= 0 ? 1 : -1;
      p.dodge = 0.9;
      p.dodgeX = fz * side;
      p.dodgeZ = -fx * side;
      p.idle = 0;
      return;
    }
  }

  update(dt, player, vehicles, police) {
    this.time += dt;
    const wanted = police ? police.stars > 0 : false;
    const pPos = player.pos;
    const annex = this.city.annex;

    for (let i = 0; i < this.activeCount; i++) {
      const p = this.peds[i];
      if (!p.alive) {
        // Keeps counting below zero so recycle() can tell how long the body has lain there.
        p.hitTimer -= dt;
        continue;
      }

      if (p.knocked > 0) {
        p.knocked -= dt;
        const slide = Math.max(0, p.knocked - 2.2) * 6;
        p.pos.x += p.knockDirX * slide * dt;
        p.pos.z += p.knockDirZ * slide * dt;
        if (p.knocked <= 0) {
          p.panic = PED_CFG.panicDuration;
          p.fleeX = p.knockDirX;
          p.fleeZ = p.knockDirZ;
        }
        continue;
      }

      // React to wanted player by fleeing
      const dxP = p.pos.x - pPos.x;
      const dzP = p.pos.z - pPos.z;
      const distSqP = dxP * dxP + dzP * dzP;
      if (wanted && distSqP < 1600) {
        p.fleeing = true;
      } else if (!wanted && distSqP > 2500) {
        p.fleeing = false;
      }

      if (p.panic > 0) p.panic -= dt;
      if (p.dodge > 0) p.dodge -= dt;
      else this.checkVehicleThreat(p, vehicles);

      let moveSpeed = p.speed;
      if (p.dodge > 0) {
        p.dirX = p.dodgeX;
        p.dirZ = p.dodgeZ;
        moveSpeed = 6.5;
      } else if (p.panic > 0) {
        p.dirX = p.fleeX;
        p.dirZ = p.fleeZ;
        moveSpeed = PED_CFG.panicSpeed * (0.8 + 0.2 * Math.min(1, p.panic));
      } else if (p.fleeing && distSqP > 0.1) {
        const inv = 1 / Math.sqrt(distSqP);
        p.dirX = dxP * inv;
        p.dirZ = dzP * inv;
        moveSpeed = PED_CFG.panicSpeed;
      } else if (p.idle > 0) {
        // Standing around: look about, then carry on.
        p.idle -= dt;
        moveSpeed = 0;
      } else {
        // Occasionally turn at block corners or cross streets at crosswalks, or pause.
        p.crossCooldown -= dt;
        if (p.crossCooldown <= 0) {
          p.crossCooldown = this.rng.range(4, 10);
          if (this.rng.chance(PED_CFG.idleChance) && p.outfit.id !== 'jogger') {
            p.idle = this.rng.range(1.5, 4);
          } else if (this.rng.chance(0.35)) {
            const tmp = p.dirX;
            p.dirX = -p.dirZ;
            p.dirZ = tmp;
          }
        }
      }

      p.pos.x += p.dirX * moveSpeed * dt;
      p.pos.z += p.dirZ * moveSpeed * dt;
      if (moveSpeed > 0) {
        const target = Math.atan2(p.dirX, p.dirZ);
        let diff = target - p.heading;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        p.heading += diff * Math.min(1, dt * 10);
        p.phase += dt * moveSpeed * 4.2;
      } else {
        // Ease legs back together while standing.
        p.phase += (Math.round(p.phase / Math.PI) * Math.PI - p.phase) * Math.min(1, dt * 6);
      }

      // Head turn: idle peds glance around; anyone near the player watches him.
      let targetYaw = 0;
      if (distSqP < 36 && p.panic <= 0) {
        const toPlayer = Math.atan2(-dxP, -dzP);
        let rel = toPlayer - p.heading;
        while (rel > Math.PI) rel -= Math.PI * 2;
        while (rel < -Math.PI) rel += Math.PI * 2;
        targetYaw = Math.max(-1.1, Math.min(1.1, rel));
      } else if (moveSpeed === 0) {
        targetYaw = Math.sin(this.time * 0.9 + p.lookSeed) * 0.9;
      } else {
        targetYaw = Math.sin(this.time * 0.35 + p.lookSeed) * 0.25;
      }
      p.headYaw += (targetYaw - p.headYaw) * Math.min(1, dt * PED_CFG.headTurnRate * 2);

      // Keep to the city: main grid, plus the West Annex band.
      if (p.pos.x > CITY.beachStartX - 2) { p.pos.x = CITY.beachStartX - 3; p.dirX = -Math.abs(p.dirX); p.fleeX = -Math.abs(p.fleeX); }
      const inAnnexBand = annex && p.pos.z > annex.minZ + 2 && p.pos.z < annex.maxZ - 2;
      const westEdge = inAnnexBand ? annex.minX + 2 : -CITY.halfSpanX;
      if (p.pos.x < westEdge) { p.pos.x = westEdge + 2; p.dirX = Math.abs(p.dirX); p.fleeX = Math.abs(p.fleeX); }
      if (p.pos.z > CITY.halfSpanZ) { p.pos.z = CITY.halfSpanZ - 2; p.dirZ = -Math.abs(p.dirZ); p.fleeZ = -Math.abs(p.fleeZ); }
      if (p.pos.z < -CITY.halfSpanZ) { p.pos.z = -CITY.halfSpanZ + 2; p.dirZ = Math.abs(p.dirZ); p.fleeZ = Math.abs(p.fleeZ); }

      const hitBuilding = this.city.resolveCircleCollisions(p.pos, 0.42);
      if (hitBuilding) {
        const tmp = p.dirX;
        p.dirX = -p.dirZ;
        p.dirZ = tmp;
        if (p.panic > 0) {
          const t2 = p.fleeX;
          p.fleeX = -p.fleeZ;
          p.fleeZ = t2;
        }
      }

      // Check collision with speeding player vehicle
      if (player.vehicle && Math.abs(player.vehicle.speed) > 6.5) {
        const vx = player.vehicle.pos.x - p.pos.x;
        const vz = player.vehicle.pos.z - p.pos.z;
        if (vx * vx + vz * vz < 3.6) {
          p.alive = false;
          p.hitTimer = 10;
          if (police) police.reportCrime('hit_pedestrian', p.pos, 1);
          this.alertGunfire(p.pos, 20);
        }
      }
    }

    this.applyAvoidance(dt);
    this.recycle(dt, player);
    this.syncInstances();
  }

  syncInstances() {
    const d = this.dummy;
    const hide = (inst, idx) => {
      d.scale.set(0.001, 0.001, 0.001);
      d.updateMatrix();
      inst.setMatrixAt(idx, d.matrix);
    };
    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i];
      if (i >= this.activeCount) {
        // Outside the active pool (low quality tier): collapse every part.
        hide(this.torsoInst, i);
        hide(this.headInst, i);
        hide(this.legLInst, i);
        hide(this.legRInst, i);
        hide(this.armInst, i * 2);
        hide(this.armInst, i * 2 + 1);
        hide(this.hatInst, i);
        continue;
      }
      const down = !p.alive || p.knocked > 0;
      if (down) {
        // Lying flat. A knocked-down ped starts to rise in the last half second.
        const rise = p.alive ? Math.max(0, 1 - p.knocked / 0.5) : 0;
        const tilt = Math.PI * 0.5 * (1 - rise);
        d.position.set(p.pos.x, 0.14 + rise * 0.98, p.pos.z);
        d.rotation.set(tilt, p.heading, 0, 'YXZ');
        d.scale.set(0.46, 0.62, 0.24);
        d.updateMatrix();
        this.torsoInst.setMatrixAt(i, d.matrix);
        d.rotation.order = 'XYZ';
        hide(this.headInst, i);
        hide(this.legLInst, i);
        hide(this.legRInst, i);
        hide(this.armInst, i * 2);
        hide(this.armInst, i * 2 + 1);
        hide(this.hatInst, i);
        continue;
      }

      const running = p.panic > 0 || p.fleeing || p.dodge > 0;
      const swingAmt = running ? 0.75 : 0.42;
      const swing = Math.sin(p.phase) * swingAmt;
      const bob = Math.abs(Math.cos(p.phase)) * (running ? 0.07 : 0.03);
      const cosH = Math.cos(p.heading);
      const sinH = Math.sin(p.heading);
      const lean = running ? 0.18 : 0;

      // Torso
      d.position.set(p.pos.x, p.pos.y + 1.12 + bob, p.pos.z);
      d.rotation.set(lean, p.heading, 0, 'YXZ');
      d.scale.set(0.46, 0.64, 0.24);
      d.updateMatrix();
      this.torsoInst.setMatrixAt(i, d.matrix);

      // Head (turns independently of the body)
      d.position.set(p.pos.x + sinH * lean * 0.4, p.pos.y + 1.62 + bob, p.pos.z + cosH * lean * 0.4);
      d.rotation.set(0, p.heading + p.headYaw, 0, 'YXZ');
      d.scale.set(0.27, 0.29, 0.27);
      d.updateMatrix();
      this.headInst.setMatrixAt(i, d.matrix);

      // Hat brim
      if (p.outfit.hat !== null) {
        d.position.set(p.pos.x + sinH * lean * 0.4, p.pos.y + 1.79 + bob, p.pos.z + cosH * lean * 0.4);
        d.scale.set(0.4, 0.06, 0.4);
        d.updateMatrix();
        this.hatInst.setMatrixAt(i, d.matrix);
      } else {
        hide(this.hatInst, i);
      }

      // Legs
      const lx = -0.12 * cosH;
      const lz = 0.12 * sinH;
      d.position.set(p.pos.x + lx, p.pos.y + 0.42, p.pos.z + lz);
      d.rotation.set(swing, p.heading, 0, 'YXZ');
      d.scale.set(0.18, 0.78, 0.18);
      d.updateMatrix();
      this.legLInst.setMatrixAt(i, d.matrix);

      d.position.set(p.pos.x - lx, p.pos.y + 0.42, p.pos.z - lz);
      d.rotation.set(-swing, p.heading, 0, 'YXZ');
      d.updateMatrix();
      this.legRInst.setMatrixAt(i, d.matrix);

      // Arms swing opposite to legs; panicking peds throw them up.
      const ax = -0.3 * cosH;
      const az = 0.3 * sinH;
      const armSwing = p.panic > 0 ? -2.4 + Math.sin(p.phase * 2) * 0.3 : -swing * 0.9;
      d.position.set(p.pos.x + ax, p.pos.y + 1.14 + bob, p.pos.z + az);
      d.rotation.set(armSwing, p.heading, 0, 'YXZ');
      d.scale.set(0.12, 0.58, 0.12);
      d.updateMatrix();
      this.armInst.setMatrixAt(i * 2, d.matrix);
      d.position.set(p.pos.x - ax, p.pos.y + 1.14 + bob, p.pos.z - az);
      d.rotation.set(p.panic > 0 ? armSwing : swing * 0.9, p.heading, 0, 'YXZ');
      d.updateMatrix();
      this.armInst.setMatrixAt(i * 2 + 1, d.matrix);
      d.rotation.order = 'XYZ';
    }

    this.torsoInst.instanceMatrix.needsUpdate = true;
    this.headInst.instanceMatrix.needsUpdate = true;
    this.legLInst.instanceMatrix.needsUpdate = true;
    this.legRInst.instanceMatrix.needsUpdate = true;
    this.armInst.instanceMatrix.needsUpdate = true;
    this.hatInst.instanceMatrix.needsUpdate = true;
  }
}
