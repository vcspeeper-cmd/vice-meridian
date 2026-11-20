import * as THREE from 'three';
import { CITY, PED_CFG, TRAFFIC_CFG } from './config.js';

const TAU = Math.PI * 2;

const SHIRT_COLORS = [0xff5d7a, 0x3bd8e0, 0xffb84d, 0xf2e9dc, 0x7a65ff, 0x52e088, 0xff784f, 0x2f3b52];
const PANTS_COLORS = [0x1f2634, 0x3b485c, 0xcab99c, 0x29323e, 0x5c4a3d];
const SKIN_TONES = [0xe8bc98, 0xd49b72, 0xb37852, 0x8a5638, 0xf0c9a8];

// Outfit archetypes. `shortSleeves` / `shorts` expose skin on arms / lower legs, `hat` adds a
// brim, and `speedScale` lets joggers outpace strollers.
const OUTFITS = [
  { id: 'local', weight: 4, shirts: SHIRT_COLORS, pants: PANTS_COLORS, shortSleeves: false, shorts: false, hat: null, speedScale: 1 },
  { id: 'tourist', weight: 3, shirts: [0xff5d7a, 0xffb84d, 0x3bd8e0, 0x52e088], pants: [0xcab99c, 0xe4d6b8], shortSleeves: true, shorts: true, hat: 0xf2e2b0, speedScale: 0.8 },
  { id: 'business', weight: 2, shirts: [0x2a2f3c, 0x3a3340, 0x23303a], pants: [0x1d2028, 0x2a2f3c], shortSleeves: false, shorts: false, hat: null, speedScale: 1.15 },
  { id: 'beach', weight: 2, shirts: [0xffffff, 0xff784f, 0x3bd8e0], pants: [0x2f8fd8, 0xff3b9a, 0xffd84d], shortSleeves: true, shorts: true, hat: null, speedScale: 0.75 },
  { id: 'jogger', weight: 1, shirts: [0x6dff88, 0xff3b9a, 0xffe14d], pants: [0x1f2634], shortSleeves: true, shorts: true, hat: 0x1f2634, speedScale: 2.1 },
];
const OUTFIT_TOTAL = OUTFITS.reduce((sum, outfit) => sum + outfit.weight, 0);
// Dock workers only show up when a pedestrian is (re)spawned inside the industrial district.
const WORKER_OUTFIT = { id: 'worker', weight: 0, shirts: [0xff8c1a, 0xd8f23a], pants: [0x2c3a52, 0x3b3f46], shortSleeves: false, shorts: false, hat: 0xffd21a, speedScale: 0.95 };

// Pedestrians live on a ring around the player: anyone farther out than `despawn` is recycled onto
// a sidewalk point between `inner` and `outer`, preferably behind the player so nobody pops into
// view. `recyclePerSecond` caps the churn and `deadLinger` is how long a body may lie there first.
const RING = { inner: 55, outer: 110, despawn: 150, recyclePerSecond: 5, deadLinger: 12 };
// Local avoidance: peds closer than `radius` push each other apart, and the grid cell size is the
// neighbourhood range searched for such pairs.
const AVOID = { radius: 0.9, cell: 2, strength: 0.5 };

const INSET = 1.6;

export class PedestrianManager {
  constructor(scene, city, rng, count = 88) {
    this.scene = scene;
    this.city = city;
    this.rng = rng;
    this.count = count;
    this.peds = [];

    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.torsoInst = new THREE.InstancedMesh(unitBox, material, count);
    this.headInst = new THREE.InstancedMesh(unitBox, material, count);
    this.legLInst = new THREE.InstancedMesh(unitBox, material, count);
    this.legRInst = new THREE.InstancedMesh(unitBox, material, count);
    // Both arms of a ped share one instance buffer, hence two slots each; hats get one each.
    this.armInst = new THREE.InstancedMesh(unitBox, material, count * 2);
    this.hatInst = new THREE.InstancedMesh(unitBox, material, count);

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
    // Clamp to the valid range and never exceed the pool size.
    const requested = n | 0;
    const clamped = Math.max(0, Math.min(this.peds.length, requested));
    this.activeCount = clamped;
    if (clamped !== requested) {
      console.warn('setActiveCount: clamped from', n, 'to', clamped);
    }
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
  // few seeded tries qualifies, in which case the ped waits for a later frame.
  findRingSpawn(player) {
    const forwardX = Math.sin(player.heading);
    const forwardZ = Math.cos(player.heading);
    for (let attempt = 0; attempt < 8; attempt++) {
      const rect = this.rng.pick(this.sidewalks);
      // Walk along the rect on one axis and stand on an edge of the other.
      const alongX = this.rng.chance(0.5);
      const nearEdge = this.rng.chance(0.5);
      const x = alongX
        ? this.rng.range(rect.minX + INSET, rect.maxX - INSET)
        : nearEdge ? rect.minX + INSET : rect.maxX - INSET;
      const z = alongX
        ? (nearEdge ? rect.minZ + INSET : rect.maxZ - INSET)
        : this.rng.range(rect.minZ + INSET, rect.maxZ - INSET);
      const dx = x - player.pos.x;
      const dz = z - player.pos.z;
      const distance = Math.hypot(dx, dz);
      if (distance < RING.inner || distance > RING.outer) continue;
      // Reject points straight ahead of the player on the first tries.
      if (attempt < 5 && (dx * forwardX + dz * forwardZ) / distance > 0.35) continue;
      if (this.city.isBlocked && this.city.isBlocked(x, z, 1)) continue;
      const sign = this.rng.chance(0.5) ? 1 : -1;
      return alongX
        ? { x, z, dirX: sign, dirZ: 0 }
        : { x, z, dirX: 0, dirZ: sign };
    }
    return null;
  }

  // Move far-away (or long-dead) pedestrians back into the ring around the player.
  recycle(dt, player) {
    this.recycleBudget = Math.min(RING.recyclePerSecond, this.recycleBudget + dt * RING.recyclePerSecond);
    if (this.recycleBudget < 1) return;

    const despawnSq = RING.despawn * RING.despawn;
    const bodySq = 40 * 40;
    for (let i = 0; i < this.activeCount && this.recycleBudget >= 1; i++) {
      const ped = this.peds[i];
      const dx = ped.pos.x - player.pos.x;
      const dz = ped.pos.z - player.pos.z;
      const distSq = dx * dx + dz * dz;
      const tooFar = distSq > despawnSq;
      const expiredBody = !ped.alive && ped.hitTimer <= -RING.deadLinger && distSq > bodySq;
      if (!tooFar && !expiredBody) continue;

      const spot = this.findRingSpawn(player);
      if (!spot) break;
      this.recycleBudget -= 1;
      this.recycled++;

      this.placePedestrian(i, spot.x, spot.z, Math.atan2(spot.dirX, spot.dirZ), spot.dirX, spot.dirZ);
      // Fresh look: industrial streets get dock workers, everywhere else the normal mix.
      const district = this.city.districtAt ? this.city.districtAt(spot.x, spot.z) : 'residential';
      const outfit = district === 'industrial' && this.rng.chance(0.6) ? WORKER_OUTFIT : this.pickOutfit();
      ped.outfit = outfit;
      ped.shirt = this.rng.pick(outfit.shirts);
      ped.pants = this.rng.pick(outfit.pants);
      ped.skin = this.rng.pick(SKIN_TONES);
      ped.speed = this.rng.range(1.4, 2.3) * outfit.speedScale;
      ped.hitTimer = 0;
      this.applyColors(i);
      this.markColorsDirty();
    }
  }

  // Separation: bucket live, upright peds into a 2 m grid and push overlapping pairs apart. Each
  // ped also nudges its walking direction away so pairs slide past instead of jamming.
  applyAvoidance(dt) {
    const grid = this.avoidGrid;
    const cell = AVOID.cell;
    const radius = AVOID.radius;
    const radiusSq = radius * radius;
    const steerAmount = AVOID.strength * dt * 4;

    // Bucket index for a grid coordinate (wrapping hash, collisions just mean a few extra checks).
    const cellKey = (cx, cz) => (cx * 73856093) ^ (cz * 19349663);
    const steers = (ped) => ped.panic > 0 || ped.dodge > 0 || ped.fleeing;
    const steer = (ped, sx, sz) => {
      ped.dirX += sx * steerAmount;
      ped.dirZ += sz * steerAmount;
      const length = Math.hypot(ped.dirX, ped.dirZ) || 1;
      ped.dirX /= length;
      ped.dirZ /= length;
    };

    grid.clear();
    for (let i = 0; i < this.activeCount; i++) {
      const ped = this.peds[i];
      if (!ped.alive || ped.knocked > 0) continue;
      const key = cellKey(Math.floor(ped.pos.x / cell), Math.floor(ped.pos.z / cell));
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }
      bucket.push(i);
    }

    for (let i = 0; i < this.activeCount; i++) {
      const a = this.peds[i];
      if (!a.alive || a.knocked > 0) continue;
      const cellX = Math.floor(a.pos.x / cell);
      const cellZ = Math.floor(a.pos.z / cell);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          const bucket = grid.get(cellKey(cellX + ox, cellZ + oz));
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            const b = this.peds[j];
            const dx = b.pos.x - a.pos.x;
            const dz = b.pos.z - a.pos.z;
            const distSq = dx * dx + dz * dz;
            if (distSq >= radiusSq || distSq < 1e-8) continue;

            const distance = Math.sqrt(distSq);
            const push = (radius - distance) * 0.5;
            const nx = dx / distance;
            const nz = dz / distance;
            a.pos.x -= nx * push;
            a.pos.z -= nz * push;
            b.pos.x += nx * push;
            b.pos.z += nz * push;

            // Only free-running (panicking / dodging / fleeing) peds steer; calm walkers keep
            // their axis-aligned sidewalk heading and are just shouldered aside by the push.
            if (steers(a)) steer(a, -nx, -nz);
            if (steers(b)) steer(b, nx, nz);
          }
        }
      }
    }
  }

  pickOutfit() {
    let roll = this.rng.next() * OUTFIT_TOTAL;
    for (const outfit of OUTFITS) {
      roll -= outfit.weight;
      if (roll <= 0) return outfit;
    }
    return OUTFITS[0];
  }

  spawnAll() {
    this.peds.length = 0;
    const sidewalks = this.city.sidewalkRects;

    for (let i = 0; i < this.count; i++) {
      const rect = this.rng.pick(sidewalks);
      const side = this.rng.int(0, 3);
      let x, z, dirX, dirZ;

      if (side === 0) {
        x = this.rng.range(rect.minX + INSET, rect.maxX - INSET);
        z = rect.minZ + INSET;
        dirX = this.rng.chance(0.5) ? 1 : -1;
        dirZ = 0;
      } else if (side === 1) {
        x = this.rng.range(rect.minX + INSET, rect.maxX - INSET);
        z = rect.maxZ - INSET;
        dirX = this.rng.chance(0.5) ? 1 : -1;
        dirZ = 0;
      } else if (side === 2) {
        x = rect.minX + INSET;
        z = this.rng.range(rect.minZ + INSET, rect.maxZ - INSET);
        dirX = 0;
        dirZ = this.rng.chance(0.5) ? 1 : -1;
      } else {
        x = rect.maxX - INSET;
        z = this.rng.range(rect.minZ + INSET, rect.maxZ - INSET);
        dirX = 0;
        dirZ = this.rng.chance(0.5) ? 1 : -1;
      }

      const outfit = this.pickOutfit();
      this.peds.push({
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
      });
      this.applyColors(i);
    }

    this.markColorsDirty();
    this.syncInstances();
  }

  placePedestrian(index, x, z, heading, dirX, dirZ) {
    if (index < 0 || index >= this.peds.length) return;
    const ped = this.peds[index];
    ped.pos.set(x, 0.22, z);
    ped.heading = heading;
    ped.dirX = dirX;
    ped.dirZ = dirZ;
    ped.alive = true;
    ped.fleeing = false;
    ped.panic = 0;
    ped.dodge = 0;
    ped.idle = 0;
    ped.knocked = 0;
  }

  // Gunfire (or a horn blast) makes everyone within `radius` bolt away from `source`.
  alertGunfire(source, radius = PED_CFG.panicDuration * 6) {
    const radiusSq = radius * radius;
    for (const ped of this.peds) {
      if (!ped.alive || ped.knocked > 0) continue;
      const dx = ped.pos.x - source.x;
      const dz = ped.pos.z - source.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > radiusSq) continue;
      const distance = Math.sqrt(distSq) || 1;
      ped.panic = PED_CFG.panicDuration * (0.7 + 0.3 * (1 - distance / radius));
      ped.fleeX = dx / distance;
      ped.fleeZ = dz / distance;
      ped.idle = 0;
    }
  }

  // A punch: the ped is knocked flat along `dir`, then gets up and runs.
  knockDown(ped, dir) {
    if (!ped.alive) return;
    ped.knocked = 2.6;
    ped.knockDirX = dir.x;
    ped.knockDirZ = dir.z;
    ped.heading = Math.atan2(-dir.x, -dir.z);
    ped.panic = 0;
  }

  // Sidestep out of the path of any fast car heading toward this pedestrian.
  checkVehicleThreat(ped, vehicles) {
    if (!vehicles || !vehicles.vehicles) return;
    const scareSq = TRAFFIC_CFG.scareRadius * TRAFFIC_CFG.scareRadius;

    for (const vehicle of vehicles.vehicles) {
      const speed = Math.abs(vehicle.speed || 0);
      if (speed < TRAFFIC_CFG.scareSpeed) continue;

      const dx = ped.pos.x - vehicle.pos.x;
      const dz = ped.pos.z - vehicle.pos.z;
      if (dx * dx + dz * dz > scareSq) continue;

      // Vehicle forward vector, accounting for reverse gear.
      const sign = vehicle.speed >= 0 ? 1 : -1;
      const forwardX = Math.sin(vehicle.heading) * sign;
      const forwardZ = Math.cos(vehicle.heading) * sign;
      if (dx * forwardX + dz * forwardZ <= 0) continue;

      const lateral = dx * forwardZ - dz * forwardX;
      if (Math.abs(lateral) > 3.2) continue;

      // Dive to whichever side the ped is already on.
      const side = lateral >= 0 ? 1 : -1;
      ped.dodge = 0.9;
      ped.dodgeX = forwardZ * side;
      ped.dodgeZ = -forwardX * side;
      ped.idle = 0;
      return;
    }
  }

  update(dt, player, vehicles, police) {
    this.time += dt;
    const wanted = police ? police.stars > 0 : false;
    const playerPos = player.pos;
    const annex = this.city.annex;

    for (let i = 0; i < this.activeCount; i++) {
      const ped = this.peds[i];
      if (!ped.alive) {
        // Counts below zero so recycle() can tell how long the body has lain there.
        ped.hitTimer -= dt;
        continue;
      }

      if (ped.knocked > 0) {
        ped.knocked -= dt;
        const slide = Math.max(0, ped.knocked - 2.2) * 6;
        ped.pos.x += ped.knockDirX * slide * dt;
        ped.pos.z += ped.knockDirZ * slide * dt;
        if (ped.knocked <= 0) {
          ped.panic = PED_CFG.panicDuration;
          ped.fleeX = ped.knockDirX;
          ped.fleeZ = ped.knockDirZ;
        }
        continue;
      }

      // React to a wanted player by fleeing.
      const dxPlayer = ped.pos.x - playerPos.x;
      const dzPlayer = ped.pos.z - playerPos.z;
      const distSqPlayer = dxPlayer * dxPlayer + dzPlayer * dzPlayer;
      if (wanted && distSqPlayer < 1600) {
        ped.fleeing = true;
      } else if (!wanted && distSqPlayer > 2500) {
        ped.fleeing = false;
      }

      if (ped.panic > 0) ped.panic -= dt;
      if (ped.dodge > 0) ped.dodge -= dt;
      else this.checkVehicleThreat(ped, vehicles);

      let moveSpeed = ped.speed;
      if (ped.dodge > 0) {
        ped.dirX = ped.dodgeX;
        ped.dirZ = ped.dodgeZ;
        moveSpeed = 6.5;
      } else if (ped.panic > 0) {
        ped.dirX = ped.fleeX;
        ped.dirZ = ped.fleeZ;
        moveSpeed = PED_CFG.panicSpeed * (0.8 + 0.2 * Math.min(1, ped.panic));
      } else if (ped.fleeing && distSqPlayer > 0.1) {
        const inverse = 1 / Math.sqrt(distSqPlayer);
        ped.dirX = dxPlayer * inverse;
        ped.dirZ = dzPlayer * inverse;
        moveSpeed = PED_CFG.panicSpeed;
      } else if (ped.idle > 0) {
        // Standing around: look about, then carry on.
        ped.idle -= dt;
        moveSpeed = 0;
      } else {
        // Occasionally turn at block corners or cross streets at crosswalks, or pause.
        ped.crossCooldown -= dt;
        if (ped.crossCooldown <= 0) {
          ped.crossCooldown = this.rng.range(4, 10);
          const wantsIdle = this.rng.chance(PED_CFG.idleChance);
          if (wantsIdle && ped.outfit.id !== 'jogger') {
            ped.idle = this.rng.range(1.5, 4);
          } else if (this.rng.chance(0.35)) {
            const previousDirX = ped.dirX;
            ped.dirX = -ped.dirZ;
            ped.dirZ = previousDirX;
          }
        }
      }

      ped.pos.x += ped.dirX * moveSpeed * dt;
      ped.pos.z += ped.dirZ * moveSpeed * dt;
      if (moveSpeed > 0) {
        let diff = Math.atan2(ped.dirX, ped.dirZ) - ped.heading;
        while (diff > Math.PI) diff -= TAU;
        while (diff < -Math.PI) diff += TAU;
        ped.heading += diff * Math.min(1, dt * 10);
        ped.phase += dt * moveSpeed * 4.2;
      } else {
        // Ease legs back together while standing.
        ped.phase += (Math.round(ped.phase / Math.PI) * Math.PI - ped.phase) * Math.min(1, dt * 6);
      }

      // Head turn: idle peds glance around; anyone near the player watches him.
      let targetYaw;
      if (distSqPlayer < 36 && ped.panic <= 0) {
        let rel = Math.atan2(-dxPlayer, -dzPlayer) - ped.heading;
        while (rel > Math.PI) rel -= TAU;
        while (rel < -Math.PI) rel += TAU;
        targetYaw = Math.max(-1.1, Math.min(1.1, rel));
      } else if (moveSpeed === 0) {
        targetYaw = Math.sin(this.time * 0.9 + ped.lookSeed) * 0.9;
      } else {
        targetYaw = Math.sin(this.time * 0.35 + ped.lookSeed) * 0.25;
      }
      ped.headYaw += (targetYaw - ped.headYaw) * Math.min(1, dt * PED_CFG.headTurnRate * 2);

      // Keep to the city: the main grid, plus the West Annex band.
      if (ped.pos.x > CITY.beachStartX - 2) {
        ped.pos.x = CITY.beachStartX - 3;
        ped.dirX = -Math.abs(ped.dirX);
        ped.fleeX = -Math.abs(ped.fleeX);
      }
      const inAnnexBand = annex && ped.pos.z > annex.minZ + 2 && ped.pos.z < annex.maxZ - 2;
      const westEdge = inAnnexBand ? annex.minX + 2 : -CITY.halfSpanX;
      if (ped.pos.x < westEdge) {
        ped.pos.x = westEdge + 2;
        ped.dirX = Math.abs(ped.dirX);
        ped.fleeX = Math.abs(ped.fleeX);
      }
      if (ped.pos.z > CITY.halfSpanZ) {
        ped.pos.z = CITY.halfSpanZ - 2;
        ped.dirZ = -Math.abs(ped.dirZ);
        ped.fleeZ = -Math.abs(ped.fleeZ);
      }
      if (ped.pos.z < -CITY.halfSpanZ) {
        ped.pos.z = -CITY.halfSpanZ + 2;
        ped.dirZ = Math.abs(ped.dirZ);
        ped.fleeZ = Math.abs(ped.fleeZ);
      }

      if (this.city.resolveCircleCollisions(ped.pos, 0.42)) {
        const previousDirX = ped.dirX;
        ped.dirX = -ped.dirZ;
        ped.dirZ = previousDirX;
        if (ped.panic > 0) {
          const previousFleeX = ped.fleeX;
          ped.fleeX = -ped.fleeZ;
          ped.fleeZ = previousFleeX;
        }
      }

      // Check collision with the speeding player vehicle.
      if (player.vehicle && Math.abs(player.vehicle.speed) > 6.5) {
        const vx = player.vehicle.pos.x - ped.pos.x;
        const vz = player.vehicle.pos.z - ped.pos.z;
        if (vx * vx + vz * vz < 3.6) {
          ped.alive = false;
          ped.hitTimer = 10;
          if (police) police.reportCrime('hit_pedestrian', ped.pos, 1);
          this.alertGunfire(ped.pos, 20);
        }
      }
    }

    this.applyAvoidance(dt);
    this.recycle(dt, player);
    this.syncInstances();
  }

  syncInstances() {
    const dummy = this.dummy;
    // Collapse one instance (or arm slot) to nothing.
    const hide = (instanced, index) => {
      dummy.scale.set(0.001, 0.001, 0.001);
      dummy.updateMatrix();
      instanced.setMatrixAt(index, dummy.matrix);
    };

    for (let i = 0; i < this.peds.length; i++) {
      const ped = this.peds[i];

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

      const down = !ped.alive || ped.knocked > 0;
      if (down) {
        // Lying flat. A knocked-down ped starts to rise in the last half second.
        const rise = ped.alive ? Math.max(0, 1 - ped.knocked / 0.5) : 0;
        const tilt = Math.PI * 0.5 * (1 - rise);
        dummy.position.set(ped.pos.x, 0.14 + rise * 0.98, ped.pos.z);
        dummy.rotation.set(tilt, ped.heading, 0, 'YXZ');
        dummy.scale.set(0.46, 0.62, 0.24);
        dummy.updateMatrix();
        this.torsoInst.setMatrixAt(i, dummy.matrix);
        dummy.rotation.order = 'XYZ';
        hide(this.headInst, i);
        hide(this.legLInst, i);
        hide(this.legRInst, i);
        hide(this.armInst, i * 2);
        hide(this.armInst, i * 2 + 1);
        hide(this.hatInst, i);
        continue;
      }

      const running = ped.panic > 0 || ped.fleeing || ped.dodge > 0;
      const swing = Math.sin(ped.phase) * (running ? 0.75 : 0.42);
      const bob = Math.abs(Math.cos(ped.phase)) * (running ? 0.07 : 0.03);
      const cosHeading = Math.cos(ped.heading);
      const sinHeading = Math.sin(ped.heading);
      const lean = running ? 0.18 : 0;

      // Torso
      dummy.position.set(ped.pos.x, ped.pos.y + 1.12 + bob, ped.pos.z);
      dummy.rotation.set(lean, ped.heading, 0, 'YXZ');
      dummy.scale.set(0.46, 0.64, 0.24);
      dummy.updateMatrix();
      this.torsoInst.setMatrixAt(i, dummy.matrix);

      // Head (turns independently of the body)
      const leanOffsetX = sinHeading * lean * 0.4;
      const leanOffsetZ = cosHeading * lean * 0.4;
      dummy.position.set(ped.pos.x + leanOffsetX, ped.pos.y + 1.62 + bob, ped.pos.z + leanOffsetZ);
      dummy.rotation.set(0, ped.heading + ped.headYaw, 0, 'YXZ');
      dummy.scale.set(0.27, 0.29, 0.27);
      dummy.updateMatrix();
      this.headInst.setMatrixAt(i, dummy.matrix);

      // Hat brim (shares the head's rotation).
      if (ped.outfit.hat !== null) {
        dummy.position.set(ped.pos.x + leanOffsetX, ped.pos.y + 1.79 + bob, ped.pos.z + leanOffsetZ);
        dummy.scale.set(0.4, 0.06, 0.4);
        dummy.updateMatrix();
        this.hatInst.setMatrixAt(i, dummy.matrix);
      } else {
        hide(this.hatInst, i);
      }

      // Legs, offset to either side across the walking direction.
      const legOffsetX = -0.12 * cosHeading;
      const legOffsetZ = 0.12 * sinHeading;
      dummy.position.set(ped.pos.x + legOffsetX, ped.pos.y + 0.42, ped.pos.z + legOffsetZ);
      dummy.rotation.set(swing, ped.heading, 0, 'YXZ');
      dummy.scale.set(0.18, 0.78, 0.18);
      dummy.updateMatrix();
      this.legLInst.setMatrixAt(i, dummy.matrix);

      dummy.position.set(ped.pos.x - legOffsetX, ped.pos.y + 0.42, ped.pos.z - legOffsetZ);
      dummy.rotation.set(-swing, ped.heading, 0, 'YXZ');
      dummy.updateMatrix();
      this.legRInst.setMatrixAt(i, dummy.matrix);

      // Arms swing opposite to the legs; panicking peds throw both up.
      const armOffsetX = -0.3 * cosHeading;
      const armOffsetZ = 0.3 * sinHeading;
      const armSwing = ped.panic > 0 ? -2.4 + Math.sin(ped.phase * 2) * 0.3 : -swing * 0.9;
      dummy.position.set(ped.pos.x + armOffsetX, ped.pos.y + 1.14 + bob, ped.pos.z + armOffsetZ);
      dummy.rotation.set(armSwing, ped.heading, 0, 'YXZ');
      dummy.scale.set(0.12, 0.58, 0.12);
      dummy.updateMatrix();
      this.armInst.setMatrixAt(i * 2, dummy.matrix);

      dummy.position.set(ped.pos.x - armOffsetX, ped.pos.y + 1.14 + bob, ped.pos.z - armOffsetZ);
      dummy.rotation.set(ped.panic > 0 ? armSwing : swing * 0.9, ped.heading, 0, 'YXZ');
      dummy.updateMatrix();
      this.armInst.setMatrixAt(i * 2 + 1, dummy.matrix);
      dummy.rotation.order = 'XYZ';
    }

    this.torsoInst.instanceMatrix.needsUpdate = true;
    this.headInst.instanceMatrix.needsUpdate = true;
    this.legLInst.instanceMatrix.needsUpdate = true;
    this.legRInst.instanceMatrix.needsUpdate = true;
    this.armInst.instanceMatrix.needsUpdate = true;
    this.hatInst.instanceMatrix.needsUpdate = true;
  }
}
