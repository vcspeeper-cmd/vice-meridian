import * as THREE from 'three';
import { CITY, DIFFICULTY, POLICE_CFG, WANTED_CFG, WANTED_LEVELS } from './config.js';
import { clamp, wrapAngle } from './random.js';

function createOfficerMesh(uniformColor = 0x1e2c48, accentColor = 0x4ca8ff) {
  const root = new THREE.Group();
  const suitMat = new THREE.MeshLambertMaterial({ color: uniformColor });
  const skinMat = new THREE.MeshLambertMaterial({ color: 0xd9a27b });
  const capMat = new THREE.MeshLambertMaterial({ color: accentColor });
  const gunMat = new THREE.MeshLambertMaterial({ color: 0x1d2028 });

  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.78, 0.24), suitMat);
  legs.position.y = 0.4;
  legs.castShadow = true;

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.66, 0.28), suitMat);
  torso.position.y = 1.12;
  torso.castShadow = true;

  const badge = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.04), new THREE.MeshBasicMaterial({ color: 0xffd058 }));
  badge.position.set(0.12, 1.24, 0.15);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.3, 0.28), skinMat);
  head.position.y = 1.64;

  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.12, 0.34), capMat);
  cap.position.set(0, 1.82, 0.03);

  const armR = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.52, 0.15), suitMat);
  armR.position.set(0.32, 1.28, 0.2);
  armR.rotation.x = -1.35;

  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.36), gunMat);
  gun.position.set(0.32, 1.3, 0.54);

  root.add(legs, torso, badge, head, cap, armR, gun);
  return root;
}

// Striped sawhorse barrier used in roadblocks: bright white with red-emissive stripes.
const BARRIER_GEO = new THREE.BoxGeometry(3.2, 0.5, 0.25);
const BARRIER_MAT = new THREE.MeshLambertMaterial({ color: 0xf2f2f2, emissive: 0xff3040, emissiveIntensity: 0.25 });
const LANE_OFFSET = 3.6;

export class PoliceManager {
  constructor(scene, city, vehicles, rng) {
    this.scene = scene;
    this.city = city;
    this.vehicles = vehicles;
    this.rng = rng;

    // Heat and wanted level state
    this.stars = 0;
    this.heat = 0;
    this.escapeTimer = 0;
    this.spawnTimer = 0;
    this.roadblockTimer = 0;
    this.bustTimer = 0;
    this.playerSeen = false;

    // Active units: pursuing cruisers, patrol cars, on-foot officers, and roadblocks
    this.pursuitCars = [];
    this.patrols = [];
    this.officers = [];
    this.roadblocks = [];

    // Grid lookup for pathing: intersections indexed by "col,row"
    this.nodeMap = new Map();
    for (const it of city.intersections) this.nodeMap.set(`${it.col},${it.row}`, it);
    this.maxCol = city.roadCentersX.length - 1;
    this.maxRow = city.roadCentersZ.length - 1;

    // Last crime location for alert dispatch
    this.lastCrime = null;
    this.lastCrimePos = null;
  }

  // --- Heat / stars --------------------------------------------------------------------------
  // Heat accumulates from crimes; stars are the thresholds heat has crossed.
  // Heat cools when the player is out of sight.

  starsForHeat(heat) {
    const t = WANTED_CFG.heatPerStar;
    let s = 0;
    for (let i = 1; i < t.length; i++) if (heat >= t[i]) s = i;
    return Math.min(POLICE_CFG.maxStars, s);
  }

  reportCrime(kind, pos, severity = 1) {
    const maxHeat = WANTED_CFG.heatPerStar[POLICE_CFG.maxStars] + 2;
    this.heat = Math.min(maxHeat, this.heat + severity);
    const nextStars = this.starsForHeat(this.heat);
    if (nextStars > this.stars) this.stars = nextStars;
    this.escapeTimer = 0;
    this.lastCrime = kind;
    this.lastCrimePos = pos ? { x: pos.x, z: pos.z } : null;
  }

  setStars(n) {
    this.stars = clamp(n, 0, POLICE_CFG.maxStars);
    this.heat = WANTED_CFG.heatPerStar[this.stars] ?? this.stars;
    this.escapeTimer = 0;
  }

  // 0..1 progress toward losing the next star (drives the HUD decay bar).
  getDecayFraction() {
    if (this.stars === 0) return 0;
    return clamp(this.escapeTimer / POLICE_CFG.decayTime, 0, 1);
  }

  resetWanted() {
    this.stars = 0;
    this.heat = 0;
    this.escapeTimer = 0;
    this.bustTimer = 0;
    // Pursuers go back on patrol along the grid (surplus cruisers are recalled).
    for (const c of this.pursuitCars) {
      c.sirenActive = false;
      if (c.aiMode !== 'police') continue;
      if (this.patrols.length < POLICE_CFG.patrolCars + 1) this.beginPatrol(c);
      else this.vehicles.removeVehicle(c);
    }
    this.pursuitCars.length = 0;
    for (const o of this.officers) this.scene.remove(o.mesh);
    this.officers.length = 0;
    this.clearRoadblocks();
  }

  isCopNearby(pos, radius = 65) {
    const rSq = radius * radius;
    for (const v of this.vehicles.vehicles) {
      if (!v.spec.isPolice || v.aiMode === 'player') continue;
      if ((v.pos.x - pos.x) ** 2 + (v.pos.z - pos.z) ** 2 < rSq) return true;
    }
    for (const o of this.officers) {
      if (!o.alive) continue;
      if ((o.pos.x - pos.x) ** 2 + (o.pos.z - pos.z) ** 2 < rSq) return true;
    }
    return false;
  }

  // --- Grid pathing --------------------------------------------------------------------------
  // Police units follow the street network graph, not cutting through blocks.

  nearestNode(x, z) {
    let best = null;
    let bestD = Infinity;
    for (const it of this.city.intersections) {
      const d = (it.x - x) ** 2 + (it.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = it;
      }
    }
    return best;
  }

  neighbours(node) {
    const out = [];
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = this.nodeMap.get(`${node.col + dc},${node.row + dr}`);
      if (n) out.push(n);
    }
    return out;
  }

  // Lane target: the node shifted onto the right-hand lane for the direction of travel.
  // This keeps traffic on distinct lanes even when they share the same street.
  laneTarget(from, to) {
    const h = Math.atan2(to.x - from.x, to.z - from.z);
    return { x: to.x - Math.cos(h) * LANE_OFFSET, z: to.z + Math.sin(h) * LANE_OFFSET, heading: h };
  }

  beginPatrol(car) {
    car.aiMode = 'patrol';
    car.sirenActive = false;
    car.prevNode = this.nearestNode(car.pos.x, car.pos.z);
    const ns = this.neighbours(car.prevNode);
    car.pathNode = ns.length ? this.rng.pick(ns) : car.prevNode;
    if (!this.patrols.includes(car)) this.patrols.push(car);
  }

  spawnPatrols(count = POLICE_CFG.patrolCars) {
    const nodes = this.city.intersections;
    for (let i = 0; i < count; i++) {
      const start = nodes[Math.floor(((i + 1) / (count + 1)) * nodes.length)];
      const ns = this.neighbours(start);
      const next = this.rng.pick(ns);
      const lt = this.laneTarget(start, next);
      const car = this.vehicles.spawnVehicle('police', start.x + (lt.x - next.x), start.z + (lt.z - next.z), lt.heading, { aiMode: 'patrol', speed: 6 });
      car.prevNode = start;
      car.pathNode = next;
      this.patrols.push(car);
    }
  }

  // Steer a cruiser toward (tx, tz) at up to `speed`, slowing for sharp turns.
  // Uses feedback steering: compute desired heading toward target, blend the current heading
  // toward that target, and cap the turn rate for realism.
  steerCar(car, tx, tz, speed, dt, turnRate = 2.4) {
    const dx = tx - car.pos.x;
    const dz = tz - car.pos.z;
    const targetHeading = Math.atan2(dx, dz);
    const diff = wrapAngle(targetHeading - car.heading);
    car.heading = wrapAngle(car.heading + clamp(diff, -turnRate * dt, turnRate * dt));
    car.steerAngle = clamp(diff * 0.8, -0.45, 0.45);
    const cornerSlow = clamp(1 - Math.abs(diff) / 1.6, 0.3, 1);
    const desired = speed * cornerSlow;
    car.speed += clamp(desired - car.speed, -26 * dt, 22 * dt);
    car.speed = clamp(car.speed, 0, car.spec.maxSpeed);
    car.braking = desired < car.speed - 2;
    car.vel.set(Math.sin(car.heading) * car.speed, 0, Math.cos(car.heading) * car.speed);
    return Math.hypot(dx, dz);
  }

  updatePatrols(dt, player) {
    for (let i = this.patrols.length - 1; i >= 0; i--) {
      const car = this.patrols[i];
      if (car.aiMode !== 'patrol') {
        this.patrols.splice(i, 1);
        continue;
      }
      // A wanted player inside sight range turns the patrol into a pursuer.
      if (this.stars > 0) {
        const d = Math.hypot(player.pos.x - car.pos.x, player.pos.z - car.pos.z);
        if (d < WANTED_CFG.sightRadius && this.pursuitCars.length < POLICE_CFG.maxPursuitCars) {
          car.aiMode = 'police';
          car.sirenActive = true;
          this.pursuitCars.push(car);
          this.patrols.splice(i, 1);
          continue;
        }
      }
      const lt = this.laneTarget(car.prevNode, car.pathNode);
      const dist = this.steerCar(car, lt.x, lt.z, POLICE_CFG.patrolSpeed, dt);
      if (dist < 5) {
        // Pick the next street: never U-turn unless it is a dead end.
        const options = this.neighbours(car.pathNode).filter((n) => n !== car.prevNode);
        car.prevNode = car.pathNode;
        car.pathNode = options.length ? this.rng.pick(options) : car.prevNode;
      }
    }
  }

  // --- Spawning ------------------------------------------------------------------------------

  spawnPursuitCruiser(playerPos, forcedPos = null, forcedHeading = null) {
    let x, z, heading;
    if (forcedPos) {
      x = forcedPos.x;
      z = forcedPos.z;
      heading = forcedHeading ?? 0;
    } else {
      // Pick a road spot ~75m away from the player
      const roadX = this.rng.pick(this.city.roadCentersX);
      const offsetZ = (this.rng.chance(0.5) ? 1 : -1) * this.rng.range(58, 86);
      x = roadX + 3.4;
      z = clamp(playerPos.z + offsetZ, -CITY.halfSpanZ + 10, CITY.halfSpanZ - 10);
      heading = Math.atan2(playerPos.x - x, playerPos.z - z);
    }

    const car = this.vehicles.spawnVehicle('police', x, z, heading, {
      aiMode: 'police',
      sirenActive: true,
      speed: 22,
    });
    car.deployed = 0;
    this.pursuitCars.push(car);
    return car;
  }

  spawnOfficer(x, z, opts = {}) {
    const mesh = createOfficerMesh(opts.uniformColor ?? 0x1b2b4a, opts.accentColor ?? 0x3ba8ff);
    mesh.position.set(x, 0.22, z);
    this.scene.add(mesh);
    const officer = {
      id: `cop_${this.officers.length + 1}`,
      mesh,
      pos: new THREE.Vector3(x, 0.22, z),
      heading: opts.heading ?? 0,
      health: opts.health ?? 75,
      alive: true,
      fireCooldown: this.rng.range(0.5, 1.4),
      inCover: Boolean(opts.inCover),
      faction: opts.faction ?? 'police',
      hitFlash: 0,
      walkPhase: 0,
      holdRange: opts.holdRange ?? this.rng.range(10, 16),
    };
    this.officers.push(officer);
    return officer;
  }

  // Two cruisers parked nose-to-nose across the road ahead of the player, with barriers and
  // two officers behind them. A roadblock denies passage and forces the player to flee or fight.
  spawnRoadblock(player) {
    const v = player.vehicle;
    const heading = v ? v.heading : player.heading;
    const aheadX = player.pos.x + Math.sin(heading) * 90;
    const aheadZ = player.pos.z + Math.cos(heading) * 90;
    const node = this.nearestNode(aheadX, aheadZ);
    if (!node) return;
    if (Math.hypot(node.x - player.pos.x, node.z - player.pos.z) < 45) return;
    if (this.roadblocks.some((rb) => rb.node === node)) return;
    // Block across the road the player is travelling along.
    const alongZ = Math.abs(Math.cos(heading)) > Math.abs(Math.sin(heading));
    const across = alongZ ? Math.PI / 2 : 0;
    const cars = [];
    const meshes = [];
    for (const side of [-1, 1]) {
      const cx = node.x + (alongZ ? side * 3.4 : 0);
      const cz = node.z + (alongZ ? 0 : side * 3.4);
      const car = this.vehicles.spawnVehicle('police', cx, cz, across + (side > 0 ? Math.PI : 0) + 0.25 * side, { aiMode: 'parked', sirenActive: true });
      car.roadblock = true;
      cars.push(car);
    }
    for (const side of [-1, 1]) {
      const bar = new THREE.Mesh(BARRIER_GEO, BARRIER_MAT);
      bar.position.set(node.x + (alongZ ? side * 6.6 : 0), 0.75, node.z + (alongZ ? 0 : side * 6.6));
      bar.rotation.y = across;
      this.scene.add(bar);
      meshes.push(bar);
    }
    const officers = [];
    const back = alongZ ? Math.sign(node.z - player.pos.z) || 1 : Math.sign(node.x - player.pos.x) || 1;
    for (const side of [-1, 1]) {
      if (this.officers.length >= POLICE_CFG.maxOfficers + 2) break;
      const ox = node.x + (alongZ ? side * 2 : back * 3.5);
      const oz = node.z + (alongZ ? back * 3.5 : side * 2);
      officers.push(this.spawnOfficer(ox, oz, { inCover: true }));
    }
    this.roadblocks.push({ node, x: node.x, z: node.z, cars, meshes, officers, life: 45 });
  }

  removeRoadblock(rb) {
    for (const c of rb.cars) this.vehicles.removeVehicle(c);
    for (const m of rb.meshes) this.scene.remove(m);
    for (const o of rb.officers) {
      const idx = this.officers.indexOf(o);
      if (idx !== -1) this.officers.splice(idx, 1);
      this.scene.remove(o.mesh);
    }
  }

  clearRoadblocks() {
    for (const rb of this.roadblocks) this.removeRoadblock(rb);
    this.roadblocks.length = 0;
  }

  getBlips() {
    const list = [];
    for (const c of this.pursuitCars) {
      list.push({ x: c.pos.x, z: c.pos.z, kind: 'police' });
    }
    for (const c of this.patrols) {
      list.push({ x: c.pos.x, z: c.pos.z, kind: 'patrol' });
    }
    for (const o of this.officers) {
      if (o.alive) list.push({ x: o.pos.x, z: o.pos.z, kind: o.faction === 'gang' ? 'enemy' : 'police' });
    }
    return list;
  }

  // --- Main update ---------------------------------------------------------------------------
  // Called every frame: update pursuit logic, heat decay, officer combat, and roadblocks.

  update(dt, time, player, combat, audio) {
    this.updatePatrols(dt, player);

    if (this.stars === 0) {
      if (audio) audio.setSirenActive(false);
      return;
    }

    const desiredCars = Math.min(POLICE_CFG.maxPursuitCars, this.stars);
    this.spawnTimer -= dt;
    if (this.pursuitCars.length < desiredCars && this.spawnTimer <= 0) {
      this.spawnPursuitCruiser(player.pos);
      this.spawnTimer = 4.2;
      if (audio && audio.playRadioBlip) audio.playRadioBlip();
    }

    // Roadblocks from three stars up.
    this.roadblockTimer -= dt;
    if (this.stars >= WANTED_CFG.roadblockStars && player.vehicle && this.roadblockTimer <= 0 && this.roadblocks.length < WANTED_CFG.maxRoadblocks) {
      this.spawnRoadblock(player);
      this.roadblockTimer = 12;
    }
    for (let i = this.roadblocks.length - 1; i >= 0; i--) {
      const rb = this.roadblocks[i];
      rb.life -= dt;
      const far = Math.hypot(rb.x - player.pos.x, rb.z - player.pos.z) > 240;
      if (rb.life <= 0 || far || this.stars < WANTED_CFG.roadblockStars) {
        this.removeRoadblock(rb);
        this.roadblocks.splice(i, 1);
      }
    }

    let nearestDistSq = Infinity;
    let seen = false;
    const sightSq = WANTED_CFG.sightRadius * WANTED_CFG.sightRadius;
    const playerSpeed = player.vehicle ? Math.abs(player.vehicle.speed) : Math.hypot(player.vel.x, player.vel.z);

    // Update pursuing police cruisers: path toward player, deploy officers, handle pursuit state machine.
    for (let i = this.pursuitCars.length - 1; i >= 0; i--) {
      const car = this.pursuitCars[i];
      if (car === player.vehicle || car.aiMode !== 'police') {
        this.pursuitCars.splice(i, 1);
        continue;
      }
      car.sirenActive = true;
      const dx = player.pos.x - car.pos.x;
      const dz = player.pos.z - car.pos.z;
      const distSq = dx * dx + dz * dz;
      nearestDistSq = Math.min(nearestDistSq, distSq);
      if (distSq < sightSq) seen = true;
      const dist = Math.sqrt(distSq);

      if (car.deployed > 0) {
        // Officers are out: the car stays put as cover.
        car.speed = Math.max(0, car.speed - 30 * dt);
        car.braking = true;
        car.vel.set(Math.sin(car.heading) * car.speed, 0, Math.cos(car.heading) * car.speed);
        if (player.vehicle && dist > 40) car.deployed = 0;
        continue;
      }

      if (dist > 45) {
        // Far away: follow the street grid toward the player instead of cutting through blocks.
        if (!car.pathNode || Math.hypot(car.pathNode.x - car.pos.x, car.pathNode.z - car.pos.z) < 6) {
          const from = car.pathNode || this.nearestNode(car.pos.x, car.pos.z);
          const opts = this.neighbours(from);
          opts.push(from);
          let best = from;
          let bestD = Infinity;
          for (const n of opts) {
            const d = Math.hypot(n.x - player.pos.x, n.z - player.pos.z);
            if (d < bestD) {
              bestD = d;
              best = n;
            }
          }
          car.prevNode = from;
          car.pathNode = best;
        }
        this.steerCar(car, car.pathNode.x, car.pathNode.z, Math.max(24, playerSpeed + 7), dt, 2.5);
      } else {
        car.pathNode = null;
        const desiredSpeed = dist > 14 ? Math.max(24, playerSpeed + 7) : 10;
        this.steerCar(car, player.pos.x, player.pos.z, desiredSpeed, dt, 2.5);
        car.braking = dist < 12 && car.speed > 10;
      }

      // Officers bail out when the player is on foot nearby, or stopped in a car.
      const playerStopped = !player.vehicle || playerSpeed < 4;
      if (playerStopped && dist < 26 && this.stars >= WANTED_CFG.officersOnFootStars - 1 && this.officers.length < POLICE_CFG.maxOfficers) {
        car.deployed = 2;
        const rx = Math.cos(car.heading);
        const rz = -Math.sin(car.heading);
        for (const side of [-1, 1]) {
          if (this.officers.length >= POLICE_CFG.maxOfficers) break;
          this.spawnOfficer(car.pos.x + rx * side * 1.8, car.pos.z + rz * side * 1.8, { heading: car.heading });
        }
        if (audio && audio.playDoor) audio.playDoor();
      }
    }

    // Update on-foot officers: move toward player, fire, handle arrests.
    let closeCop = false;
    for (const o of this.officers) {
      if (!o.alive) continue;
      if (o.hitFlash > 0) {
        o.hitFlash -= dt;
      }
      const dx = player.pos.x - o.pos.x;
      const dz = player.pos.z - o.pos.z;
      const dist = Math.hypot(dx, dz);
      nearestDistSq = Math.min(nearestDistSq, dist * dist);
      if (dist < WANTED_CFG.sightRadius) seen = true;
      if (dist < WANTED_CFG.bustRadius) closeCop = true;
      o.heading = Math.atan2(dx, dz);
      o.mesh.rotation.y = o.heading;

      // Advance to a holding range, closing in to arrest a slow player; strafe a little.
      const wantArrest = playerSpeed < WANTED_CFG.bustSpeed * 3 && this.stars <= 2;
      const hold = wantArrest ? 1.6 : o.holdRange;
      if (!o.inCover && dist > hold && dist < 85) {
        const step = (wantArrest ? 5.2 : 4.4) * dt;
        o.pos.x += (dx / dist) * step;
        o.pos.z += (dz / dist) * step;
        this.city.resolveCircleCollisions(o.pos, 0.45);
        o.walkPhase += dt * 9;
      } else if (!o.inCover) {
        const strafe = Math.sin(time * 0.8 + o.pos.x) * 1.2 * dt;
        o.pos.x += (dz / dist) * strafe;
        o.pos.z -= (dx / dist) * strafe;
      }
      o.mesh.position.set(o.pos.x, o.pos.y + Math.abs(Math.sin(o.walkPhase)) * 0.05, o.pos.z);

      // Officers at 1-2 stars prefer to arrest; they only open fire at higher heat or if shot at.
      const willShoot = this.stars >= WANTED_CFG.officersOnFootStars || o.health < 75 || player.vehicle;
      o.fireCooldown -= dt;
      if (willShoot && o.fireCooldown <= 0 && dist < 55 && player.deadTimer <= 0) {
        o.fireCooldown = this.rng.range(0.75, 1.5);
        if (combat) {
          combat.fireNpcShot(o, player);
        }
      }
    }

    // Busted: a cop within reach while the player is (nearly) stationary.
    if (closeCop && playerSpeed < WANTED_CFG.bustSpeed && player.deadTimer <= 0) {
      this.bustTimer += dt;
      if (this.bustTimer >= WANTED_CFG.bustTime && player.arrest) {
        player.arrest();
        this.bustTimer = 0;
      }
    } else {
      this.bustTimer = Math.max(0, this.bustTimer - dt * 2);
    }

    // Siren audio proximity
    if (audio) {
      audio.setSirenActive(nearestDistSq < 120 * 120, Math.sqrt(nearestDistSq));
    }

    // Heat model: while any cop can see the player the clock is held; out of sight, heat cools
    // and each full decay period drops one star.
    this.playerSeen = seen || nearestDistSq < POLICE_CFG.escapeRadius * POLICE_CFG.escapeRadius * 0.25;
    if (!this.playerSeen) {
      this.escapeTimer += dt;
      this.heat = Math.max(WANTED_CFG.heatPerStar[Math.max(0, this.stars - 1)], this.heat - WANTED_CFG.coolRateOutOfSight * dt);
      if (this.escapeTimer >= POLICE_CFG.decayTime) {
        this.stars = Math.max(0, this.stars - 1);
        this.heat = WANTED_CFG.heatPerStar[this.stars];
        this.escapeTimer = 0;
        if (this.stars === 0) this.resetWanted();
      }
    } else {
      this.escapeTimer = Math.max(0, this.escapeTimer - dt * 3);
    }
  }
}
