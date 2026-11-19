import * as THREE from 'three';
import { CITY, VEHICLE_SPECS, pickTrafficClass } from './config.js';
import { clamp, wrapAngle } from './random.js';

const SHARED_GEO = {
  wheel: new THREE.CylinderGeometry(0.36, 0.36, 0.28, 10),
  hub: new THREE.CylinderGeometry(0.2, 0.2, 0.3, 8),
  box: new THREE.BoxGeometry(1, 1, 1),
};
SHARED_GEO.wheel.rotateZ(Math.PI / 2);
SHARED_GEO.hub.rotateZ(Math.PI / 2);

const TIRE_MAT = new THREE.MeshLambertMaterial({ color: 0x16181e });
const HUB_MAT = new THREE.MeshLambertMaterial({ color: 0xcfd6e2 });
const GLASS_MAT = new THREE.MeshLambertMaterial({ color: 0x1e354d, emissive: 0x102235, emissiveIntensity: 0.4 });
const BUMPER_MAT = new THREE.MeshLambertMaterial({ color: 0x20242c });
const HEADLIGHT_MAT = new THREE.MeshBasicMaterial({ color: 0xfff2c2 });
const TAIL_OFF_MAT = new THREE.MeshBasicMaterial({ color: 0x7c1522 });
const TAIL_ON_MAT = new THREE.MeshBasicMaterial({ color: 0xff2842 });
const SIREN_RED_MAT = new THREE.MeshBasicMaterial({ color: 0xff2442 });
const SIREN_BLUE_MAT = new THREE.MeshBasicMaterial({ color: 0x2ca8ff });
const SIREN_DIM_MAT = new THREE.MeshBasicMaterial({ color: 0x2b3040 });
const REVERSE_OFF_MAT = new THREE.MeshLambertMaterial({ color: 0xbfc3c8 });
const REVERSE_ON_MAT = new THREE.MeshBasicMaterial({ color: 0xffffff });
const SCORCH = new THREE.Color(0x1d1a1a);

function buildVehicleMesh(spec, paintHex, textures) {
  const root = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color: paintHex });
  // Validate spec dimensions before using them to avoid NaN or invalid scales.
  if (!spec || spec.width <= 0 || spec.height <= 0 || spec.length <= 0) {
    console.error('buildVehicleMesh: invalid spec dimensions', spec);
    return root;
  }
  const w = spec.width;
  const h = spec.height;
  const l = spec.length;

  // Lower chassis body
  const chassisH = spec.id === 'van' ? h * 0.72 : h * 0.46;
  const chassis = new THREE.Mesh(SHARED_GEO.box, bodyMat);
  chassis.scale.set(w, chassisH, l);
  chassis.position.y = 0.36 + chassisH * 0.5;
  chassis.castShadow = true;
  chassis.receiveShadow = true;
  root.add(chassis);

  // Police white side doors + hood contrast
  if (spec.isPolice) {
    const whiteMat = new THREE.MeshLambertMaterial({ color: 0xf4f6fa });
    const doorBand = new THREE.Mesh(SHARED_GEO.box, whiteMat);
    doorBand.scale.set(w + 0.03, chassisH * 0.96, l * 0.46);
    doorBand.position.set(0, 0.36 + chassisH * 0.5, -0.05);
    root.add(doorBand);
  }

  // Cabin / roof (varies by vehicle class)
  if (spec.convertible) {
    // Open cockpit + raked windshield + interior seats
    const interior = new THREE.Mesh(SHARED_GEO.box, new THREE.MeshLambertMaterial({ color: 0x5c2b29 }));
    interior.scale.set(w * 0.78, 0.36, l * 0.44);
    interior.position.set(0, 0.36 + chassisH + 0.06, -0.15);
    root.add(interior);

    const windshield = new THREE.Mesh(SHARED_GEO.box, GLASS_MAT);
    windshield.scale.set(w * 0.84, 0.44, 0.08);
    windshield.position.set(0, 0.36 + chassisH + 0.22, 0.62);
    windshield.rotation.x = -0.52;
    root.add(windshield);

    const headrestL = new THREE.Mesh(SHARED_GEO.box, new THREE.MeshLambertMaterial({ color: 0x3b1b1d }));
    headrestL.scale.set(0.32, 0.38, 0.16);
    headrestL.position.set(-0.42, 0.36 + chassisH + 0.24, -0.55);
    root.add(headrestL);
    const headrestR = headrestL.clone();
    headrestR.position.x = 0.42;
    root.add(headrestR);
  } else if (spec.id === 'pickup') {
    // Front cab + rear open bed
    const cab = new THREE.Mesh(SHARED_GEO.box, bodyMat);
    cab.scale.set(w * 0.88, h * 0.42, l * 0.38);
    cab.position.set(0, 0.36 + chassisH + h * 0.21, 0.32);
    cab.castShadow = true;
    root.add(cab);

    const cabGlass = new THREE.Mesh(SHARED_GEO.box, GLASS_MAT);
    cabGlass.scale.set(w * 0.9, h * 0.3, l * 0.32);
    cabGlass.position.set(0, 0.36 + chassisH + h * 0.22, 0.32);
    root.add(cabGlass);

    const bedFloor = new THREE.Mesh(SHARED_GEO.box, BUMPER_MAT);
    bedFloor.scale.set(w * 0.86, 0.12, l * 0.44);
    bedFloor.position.set(0, 0.36 + chassisH + 0.04, -l * 0.26);
    root.add(bedFloor);
  } else if (spec.id === 'van') {
    const roof = new THREE.Mesh(SHARED_GEO.box, bodyMat);
    roof.scale.set(w * 0.94, h * 0.28, l * 0.84);
    roof.position.set(0, 0.36 + chassisH + h * 0.14, -0.18);
    roof.castShadow = true;
    root.add(roof);

    const frontGlass = new THREE.Mesh(SHARED_GEO.box, GLASS_MAT);
    frontGlass.scale.set(w * 0.86, h * 0.32, 0.1);
    frontGlass.position.set(0, 0.36 + chassisH + 0.04, l * 0.44);
    frontGlass.rotation.x = -0.2;
    root.add(frontGlass);
  } else if (spec.id === 'compact') {
    // Short hatch: tall rounded cab pushed forward, almost no rear overhang.
    const cabH = h * 0.5;
    const cab = new THREE.Mesh(SHARED_GEO.box, bodyMat);
    cab.scale.set(w * 0.88, cabH, l * 0.62);
    cab.position.set(0, 0.36 + chassisH + cabH * 0.5, -0.12);
    cab.castShadow = true;
    root.add(cab);
    const windows = new THREE.Mesh(SHARED_GEO.box, GLASS_MAT);
    windows.scale.set(w * 0.9, cabH * 0.7, l * 0.56);
    windows.position.set(0, 0.36 + chassisH + cabH * 0.52, -0.12);
    root.add(windows);
    const roofRail = new THREE.Mesh(SHARED_GEO.box, BUMPER_MAT);
    roofRail.scale.set(w * 0.7, 0.06, l * 0.5);
    roofRail.position.set(0, 0.36 + chassisH + cabH + 0.03, -0.12);
    root.add(roofRail);
  } else if (spec.id === 'muscle') {
    // Long hood, cab set well back, hood scoop and twin racing stripes.
    const cabH = h * 0.38;
    const cabLen = l * 0.36;
    const cab = new THREE.Mesh(SHARED_GEO.box, bodyMat);
    cab.scale.set(w * 0.82, cabH, cabLen);
    cab.position.set(0, 0.36 + chassisH + cabH * 0.5, -l * 0.14);
    cab.castShadow = true;
    root.add(cab);
    const windows = new THREE.Mesh(SHARED_GEO.box, GLASS_MAT);
    windows.scale.set(w * 0.84, cabH * 0.7, cabLen * 0.86);
    windows.position.set(0, 0.36 + chassisH + cabH * 0.5, -l * 0.14);
    root.add(windows);
    const scoop = new THREE.Mesh(SHARED_GEO.box, BUMPER_MAT);
    scoop.scale.set(w * 0.3, 0.14, l * 0.18);
    scoop.position.set(0, 0.36 + chassisH + 0.06, l * 0.24);
    root.add(scoop);
    const stripeMat = new THREE.MeshLambertMaterial({ color: 0xf6f2ea });
    for (const sx of [-0.16, 0.16]) {
      const stripe = new THREE.Mesh(SHARED_GEO.box, stripeMat);
      stripe.scale.set(0.14, 0.02, l * 1.0);
      stripe.position.set(sx * w, 0.36 + chassisH + 0.005, 0);
      root.add(stripe);
    }
  } else {
    const cabLen = spec.id === 'sports' ? l * 0.44 : l * 0.5;
    const cabH = spec.id === 'sports' ? h * 0.36 : h * 0.42;
    const cabMat = spec.isPolice ? new THREE.MeshLambertMaterial({ color: 0xf4f6fa }) : bodyMat;
    const cab = new THREE.Mesh(SHARED_GEO.box, cabMat);
    cab.scale.set(w * 0.84, cabH, cabLen);
    cab.position.set(0, 0.36 + chassisH + cabH * 0.5, -0.18);
    cab.castShadow = true;
    root.add(cab);

    const windows = new THREE.Mesh(SHARED_GEO.box, GLASS_MAT);
    windows.scale.set(w * 0.86, cabH * 0.72, cabLen * 0.84);
    windows.position.set(0, 0.36 + chassisH + cabH * 0.52, -0.18);
    root.add(windows);

    if (spec.id === 'sports') {
      const spoiler = new THREE.Mesh(SHARED_GEO.box, BUMPER_MAT);
      spoiler.scale.set(w * 0.94, 0.08, 0.34);
      spoiler.position.set(0, 0.36 + chassisH + 0.26, -l * 0.44);
      root.add(spoiler);
    }
  }

  // Front & rear bumpers
  const frontBumper = new THREE.Mesh(SHARED_GEO.box, BUMPER_MAT);
  frontBumper.scale.set(w * 0.98, 0.24, 0.16);
  frontBumper.position.set(0, 0.44, l * 0.5 + 0.04);
  root.add(frontBumper);
  const rearBumper = frontBumper.clone();
  rearBumper.position.z = -l * 0.5 - 0.04;
  root.add(rearBumper);

  // Headlights + additive glow sprites
  const headY = 0.36 + chassisH * 0.55;
  const hlL = new THREE.Mesh(SHARED_GEO.box, HEADLIGHT_MAT);
  hlL.scale.set(0.38, 0.18, 0.08);
  hlL.position.set(-w * 0.34, headY, l * 0.5 + 0.02);
  const hlR = hlL.clone();
  hlR.position.x = w * 0.34;
  root.add(hlL, hlR);

  const headGlowL = new THREE.Sprite(new THREE.SpriteMaterial({
    map: textures.warmGlow,
    color: 0xffe8b0,
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  }));
  headGlowL.scale.set(1.6, 1.2, 1);
  headGlowL.position.set(-w * 0.34, headY, l * 0.5 + 0.18);
  const headGlowR = headGlowL.clone();
  headGlowR.position.x = w * 0.34;
  root.add(headGlowL, headGlowR);

  // Taillights / brake lights
  const tailL = new THREE.Mesh(SHARED_GEO.box, TAIL_OFF_MAT);
  tailL.scale.set(0.42, 0.16, 0.08);
  tailL.position.set(-w * 0.34, headY, -l * 0.5 - 0.02);
  const tailR = tailL.clone();
  tailR.position.x = w * 0.34;
  root.add(tailL, tailR);

  // Reversing lamps (white, lit only while backing up)
  const revL = new THREE.Mesh(SHARED_GEO.box, REVERSE_OFF_MAT);
  revL.scale.set(0.16, 0.12, 0.06);
  revL.position.set(-w * 0.14, headY - 0.02, -l * 0.5 - 0.03);
  const revR = revL.clone();
  revR.position.x = w * 0.14;
  root.add(revL, revR);

  // Engine smoke shown once the car is badly damaged
  const smoke = new THREE.Sprite(new THREE.SpriteMaterial({
    map: textures.warmGlow,
    color: 0x2b2b30,
    transparent: true,
    opacity: 0.0,
    depthWrite: false,
  }));
  smoke.scale.set(1.6, 1.6, 1);
  smoke.position.set(0, 0.36 + chassisH + 0.5, l * 0.32);
  smoke.visible = false;
  root.add(smoke);

  // Taxi roof sign
  if (spec.isTaxi) {
    const sign = new THREE.Mesh(SHARED_GEO.box, new THREE.MeshBasicMaterial({ color: 0xffe46b }));
    sign.scale.set(0.75, 0.24, 0.32);
    sign.position.set(0, 0.36 + h * 0.88 + 0.12, -0.15);
    root.add(sign);
  }

  // Police lightbar + red/blue additive glow sprites
  let sirenBar = null;
  if (spec.isPolice) {
    const barY = 0.36 + h * 0.88 + 0.14;
    const redBox = new THREE.Mesh(SHARED_GEO.box, SIREN_RED_MAT);
    redBox.scale.set(0.54, 0.18, 0.28);
    redBox.position.set(-0.32, barY, -0.12);

    const blueBox = new THREE.Mesh(SHARED_GEO.box, SIREN_BLUE_MAT);
    blueBox.scale.set(0.54, 0.18, 0.28);
    blueBox.position.set(0.32, barY, -0.12);

    const redGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: textures.redGlow,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    }));
    redGlow.scale.set(3.8, 3.8, 1);
    redGlow.position.set(-0.36, barY + 0.18, -0.12);

    const blueGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: textures.blueGlow,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    }));
    blueGlow.scale.set(3.8, 3.8, 1);
    blueGlow.position.set(0.36, barY + 0.18, -0.12);

    root.add(redBox, blueBox, redGlow, blueGlow);
    sirenBar = { redBox, blueBox, redGlow, blueGlow };
  }

  // 4 spinning wheels
  const wheels = [];
  const wx = w * 0.48;
  const wzF = l * 0.32;
  const wzR = -l * 0.31;
  const wheelPos = [
    [-wx, 0.36, wzF, true],
    [wx, 0.36, wzF, true],
    [-wx, 0.36, wzR, false],
    [wx, 0.36, wzR, false],
  ];
  for (const [x, y, z, isFront] of wheelPos) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    const spin = new THREE.Group();
    const tire = new THREE.Mesh(SHARED_GEO.wheel, TIRE_MAT);
    const hub = new THREE.Mesh(SHARED_GEO.hub, HUB_MAT);
    spin.add(tire, hub);
    pivot.add(spin);
    root.add(pivot);
    wheels.push({ pivot, spin, isFront });
  }

  return { root, wheels, tailL, tailR, revL, revR, smoke, sirenBar, bodyMat };
}

export class VehicleManager {
  constructor(scene, city, textures, rng) {
    this.scene = scene;
    this.city = city;
    this.textures = textures;
    this.rng = rng;
    this.vehicles = [];
    this.nextId = 1;
    this.lastImpact = 0;
  }

  spawnVehicle(type, x, z, heading = 0, opts = {}) {
    const spec = VEHICLE_SPECS[type] || VEHICLE_SPECS.sedan;
    const color = opts.color ?? this.rng.pick(spec.colors);
    const built = buildVehicleMesh(spec, color, this.textures);
    built.root.position.set(x, 0.04, z);
    built.root.rotation.y = heading;
    this.scene.add(built.root);

    const v = {
      id: this.nextId++,
      type,
      spec,
      color,
      mesh: built.root,
      wheels: built.wheels,
      tailL: built.tailL,
      tailR: built.tailR,
      revL: built.revL,
      revR: built.revR,
      smoke: built.smoke,
      bodyMat: built.bodyMat,
      baseColor: new THREE.Color(color),
      sirenBar: built.sirenBar,
      pos: new THREE.Vector3(x, 0.04, z),
      vel: new THREE.Vector3(),
      heading,
      speed: opts.speed ?? 0,
      steerAngle: 0,
      braking: false,
      sirenActive: Boolean(opts.sirenActive),
      aiMode: opts.aiMode ?? 'parked', // 'player' | 'traffic' | 'police' | 'parked'
      laneAxis: opts.laneAxis ?? 'z',
      laneDir: opts.laneDir ?? 1,
      laneCoord: opts.laneCoord ?? x,
      targetSpeed: opts.targetSpeed ?? (spec.maxSpeed * 0.44),
      wheelSpin: 0,
      health: 100,
      destroyed: false,
      damageShown: 100,
      lateralSlip: 0,
      reversing: false,
      stolen: false,
    };
    if (v.speed !== 0) {
      v.vel.set(Math.sin(heading) * v.speed, 0, Math.cos(heading) * v.speed);
    }
    this.vehicles.push(v);
    return v;
  }

  removeVehicle(v) {
    const idx = this.vehicles.indexOf(v);
    if (idx !== -1) this.vehicles.splice(idx, 1);
    this.scene.remove(v.mesh);
  }

  clearAll() {
    for (const v of this.vehicles) this.scene.remove(v.mesh);
    this.vehicles.length = 0;
  }

  populateTraffic(count = 24) {
    const xs = this.city.roadCentersX;
    const zs = this.city.roadCentersZ;
    const laneOffset = 3.6;

    for (let i = 0; i < count; i++) {
      const alongZ = this.rng.chance(0.55);
      const dir = this.rng.chance(0.5) ? 1 : -1;
      const type = pickTrafficClass(this.rng);
      let x, z, heading, laneCoord;

      if (alongZ) {
        const roadX = this.rng.pick(xs);
        laneCoord = roadX + (dir > 0 ? -laneOffset : laneOffset);
        x = laneCoord;
        z = this.rng.range(-CITY.halfSpanZ + 12, CITY.halfSpanZ - 12);
        heading = dir > 0 ? 0 : Math.PI;
      } else {
        const roadZ = this.rng.pick(zs);
        laneCoord = roadZ + (dir > 0 ? laneOffset : -laneOffset);
        z = laneCoord;
        x = this.rng.range(-CITY.halfSpanX + 12, CITY.halfSpanX - 12);
        heading = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
      }

      if (this.vehicles.some((o) => o.pos.distanceToSquared(new THREE.Vector3(x, 0, z)) < 110)) continue;
      this.spawnVehicle(type, x, z, heading, {
        aiMode: 'traffic',
        laneAxis: alongZ ? 'z' : 'x',
        laneDir: dir,
        laneCoord,
        speed: this.rng.range(10, 17),
        targetSpeed: this.rng.range(12, 19),
      });
    }
  }

  findNearestVehicle(pos, maxDist = 5.0) {
    let best = null;
    let bestSq = maxDist * maxDist;
    for (const v of this.vehicles) {
      const dSq = (v.pos.x - pos.x) ** 2 + (v.pos.z - pos.z) ** 2;
      if (dSq < bestSq) {
        bestSq = dSq;
        best = v;
      }
    }
    return best;
  }

  drivePlayerVehicle(v, controls, dt) {
    const spec = v.spec;
    // Analog throttle/brake (gamepad triggers or keys) and steering (stick or keys).
    let throttle = (controls.throttle !== undefined ? controls.throttle : controls.forward ? 1 : 0)
      - (controls.brake !== undefined ? controls.brake : controls.backward ? 1 : 0);
    let steerInput = controls.moveX !== undefined ? -controls.moveX : (controls.left ? 1 : 0) - (controls.right ? 1 : 0);
    if (v.destroyed) {
      throttle = 0;
      steerInput *= 0.3;
    }
    const handbrake = Boolean(controls.handbrake);
    // A damaged engine loses power.
    const power = 0.55 + 0.45 * clamp(v.health / 60, 0, 1);
    const boost = (controls.sprint ? 1.18 : 1.0) * power;

    const fwdX = Math.sin(v.heading);
    const fwdZ = Math.cos(v.heading);
    const rightX = Math.cos(v.heading);
    const rightZ = -Math.sin(v.heading);

    let forwardSpeed = v.vel.x * fwdX + v.vel.z * fwdZ;
    let lateralSpeed = v.vel.x * rightX + v.vel.z * rightZ;

    if (throttle > 0) {
      forwardSpeed += spec.accel * boost * throttle * dt;
    } else if (throttle < 0) {
      if (forwardSpeed > 1.5) forwardSpeed += spec.brake * throttle * dt;
      else forwardSpeed += spec.accel * 0.52 * throttle * dt;
    } else {
      forwardSpeed *= Math.max(0, 1 - 1.35 * dt);
    }

    if (handbrake) {
      forwardSpeed *= Math.max(0, 1 - 2.6 * dt);
    }

    forwardSpeed = clamp(forwardSpeed, -spec.maxSpeed * 0.34, spec.maxSpeed * boost);
    v.braking = (throttle < 0 && forwardSpeed > 1) || handbrake;
    v.reversing = forwardSpeed < -0.5;

    // Speed-scaled steering with drift-ish lateral grip when handbraking or hard cornering
    const speedRatio = clamp(Math.abs(forwardSpeed) / 14, 0, 1);
    const highSpeedDamp = clamp(1 - Math.abs(forwardSpeed) / (spec.maxSpeed * 1.9), 0.45, 1);
    const reverseSign = forwardSpeed >= -0.2 ? 1 : -1;
    v.heading = wrapAngle(v.heading + steerInput * spec.turnRate * speedRatio * highSpeedDamp * reverseSign * dt);
    v.steerAngle = steerInput * 0.42;

    const lateralGrip = handbrake ? spec.grip * 0.28 : spec.grip;
    lateralSpeed *= Math.exp(-lateralGrip * dt);
    // Sideways slip plus hard steering at speed both count as tyre scrub for the screech.
    v.lateralSlip = Math.abs(lateralSpeed) + (handbrake && Math.abs(forwardSpeed) > 8 ? 3 : 0) + Math.abs(steerInput) * Math.max(0, Math.abs(forwardSpeed) - spec.maxSpeed * 0.6) * 0.25;

    const nFwdX = Math.sin(v.heading);
    const nFwdZ = Math.cos(v.heading);
    const nRightX = Math.cos(v.heading);
    const nRightZ = -Math.sin(v.heading);

    v.vel.x = nFwdX * forwardSpeed + nRightX * lateralSpeed;
    v.vel.z = nFwdZ * forwardSpeed + nRightZ * lateralSpeed;
    v.speed = forwardSpeed;
  }

  updateTrafficCar(v, time, dt) {
    const fwdX = Math.sin(v.heading);
    const fwdZ = Math.cos(v.heading);
    let desired = v.targetSpeed;

    // Check vehicle ahead in same direction
    for (const other of this.vehicles) {
      if (other === v) continue;
      const dx = other.pos.x - v.pos.x;
      const dz = other.pos.z - v.pos.z;
      const along = dx * fwdX + dz * fwdZ;
      if (along > 1.5 && along < 17) {
        const side = Math.abs(dx * fwdZ - dz * fwdX);
        if (side < 2.6) {
          if (along < 7.5) desired = 0;
          else desired = Math.min(desired, Math.max(0, (along - 7.5) * 1.4));
        }
      }
    }

    // Check upcoming intersection traffic light
    const pitch = CITY.pitch;
    if (v.laneAxis === 'z') {
      const nextIdx = this.city.roadCentersZ.findIndex((rz) => (v.laneDir > 0 ? rz > v.pos.z + 5 && rz < v.pos.z + 18 : rz < v.pos.z - 5 && rz > v.pos.z - 18));
      if (nextIdx !== -1) {
        const col = Math.round((v.laneCoord + CITY.halfSpanX) / pitch);
        const nsGreen = this.city.isNorthSouthGreen(time, col, nextIdx);
        if (!nsGreen) desired = 0;
      }
    } else {
      const nextIdx = this.city.roadCentersX.findIndex((rx) => (v.laneDir > 0 ? rx > v.pos.x + 5 && rx < v.pos.x + 18 : rx < v.pos.x - 5 && rx > v.pos.x - 18));
      if (nextIdx !== -1) {
        const row = Math.round((v.laneCoord + CITY.halfSpanZ) / pitch);
        const nsGreen = this.city.isNorthSouthGreen(time, nextIdx, row);
        if (nsGreen) desired = 0;
      }
    }

    const diff = desired - v.speed;
    if (diff > 0) {
      v.speed = Math.min(desired, v.speed + 11 * dt);
      v.braking = false;
    } else {
      v.speed = Math.max(desired, v.speed - 22 * dt);
      v.braking = desired < v.speed - 0.8 || desired === 0;
    }
    v.steerAngle = 0;
    v.vel.set(fwdX * v.speed, 0, fwdZ * v.speed);

    // Wrap smoothly at city edges so boulevards stay populated
    if (v.laneAxis === 'z') {
      if (v.pos.z > CITY.halfSpanZ + 12) v.pos.z = -CITY.halfSpanZ - 10;
      if (v.pos.z < -CITY.halfSpanZ - 12) v.pos.z = CITY.halfSpanZ + 10;
    } else {
      if (v.pos.x > CITY.halfSpanX + 12) v.pos.x = -CITY.halfSpanX - 10;
      if (v.pos.x < -CITY.halfSpanX - 12) v.pos.x = CITY.halfSpanX + 10;
    }
  }

  applyDamage(v, amount) {
    if (amount <= 0 || v.destroyed || v.aiMode === 'shot') return;
    v.health = Math.max(0, v.health - amount);
    if (v.health <= 0) {
      v.destroyed = true;
      v.sirenActive = false;
      if (v.aiMode === 'traffic' || v.aiMode === 'patrol' || v.aiMode === 'police') v.aiMode = 'parked';
    }
  }

  repair(v) {
    v.health = 100;
    v.destroyed = false;
    v.damageShown = -1;
    this.updateDamageVisuals(v, 0);
  }

  updateDamageVisuals(v, time) {
    const hp = Math.round(v.health);
    if (hp !== v.damageShown) {
      v.damageShown = hp;
      const scorch = clamp(1 - v.health / 100, 0, 1);
      v.bodyMat.color.copy(v.baseColor).lerp(SCORCH, scorch * scorch * 0.85);
    }
    if (v.smoke) {
      const smoking = v.health < 35;
      v.smoke.visible = smoking;
      if (smoking) {
        const heavy = 1 - v.health / 35;
        const puff = 0.5 + 0.5 * Math.sin(time * 7 + v.id);
        v.smoke.material.opacity = 0.35 + heavy * 0.4;
        v.smoke.position.y = 1.2 + puff * 0.5;
        v.smoke.scale.setScalar(1.3 + heavy * 1.6 + puff * 0.4);
      }
    }
  }

  update(dt, time, playerControls, playerVehicle) {
    this.lastImpact = 0;

    for (const v of this.vehicles) {
      if (v === playerVehicle && v.aiMode === 'player') {
        this.drivePlayerVehicle(v, playerControls, dt);
      } else if (v.aiMode === 'traffic') {
        this.updateTrafficCar(v, time, dt);
      } else if (v.aiMode === 'parked') {
        v.vel.multiplyScalar(Math.max(0, 1 - 5 * dt));
        v.speed = v.vel.length();
        v.braking = false;
      }

      // Integrate position based on velocity and time step.
      const prevX = v.pos.x;
      const prevZ = v.pos.z;
      v.pos.x += v.vel.x * dt;
      v.pos.z += v.vel.z * dt;

      // Resolve collisions with building geometry: push vehicle out and apply damage.
      const hitWall = this.city.resolveCircleCollisions(v.pos, v.spec.width * 0.56);
      if (hitWall) {
        const impact = v.vel.length();
        if (v === playerVehicle && impact > 8) this.lastImpact = Math.max(this.lastImpact, impact);
        if (impact > 6) this.applyDamage(v, (impact - 6) * 1.6);
        v.vel.multiplyScalar(-0.22);
        v.speed *= -0.22;
      }

      // Vehicle-to-vehicle collisions: separate overlapping vehicles, apply damage proportionally.
      for (const o of this.vehicles) {
        if (o.id <= v.id) continue;
        const dx = o.pos.x - v.pos.x;
        const dz = o.pos.z - v.pos.z;
        const minDist = (v.spec.width + o.spec.width) * 0.62;
        const dSq = dx * dx + dz * dz;
        if (dSq > 1e-4 && dSq < minDist * minDist) {
          const dist = Math.sqrt(dSq);
          const nx = dx / dist;
          const nz = dz / dist;
          const overlap = (minDist - dist) * 0.52;
          v.pos.x -= nx * overlap;
          v.pos.z -= nz * overlap;
          o.pos.x += nx * overlap;
          o.pos.z += nz * overlap;

          const relSpeed = Math.hypot(v.vel.x - o.vel.x, v.vel.z - o.vel.z);
          if ((v === playerVehicle || o === playerVehicle) && relSpeed > 6) {
            this.lastImpact = Math.max(this.lastImpact, relSpeed);
          }
          if (relSpeed > 6) {
            // The lighter car takes more of the hit.
            const mv = v.spec.length * v.spec.width;
            const mo = o.spec.length * o.spec.width;
            this.applyDamage(v, (relSpeed - 6) * 1.4 * (mo / (mv + mo)) * 2);
            this.applyDamage(o, (relSpeed - 6) * 1.4 * (mv / (mv + mo)) * 2);
          }
          v.vel.x -= nx * relSpeed * 0.25;
          v.vel.z -= nz * relSpeed * 0.25;
          o.vel.x += nx * relSpeed * 0.25;
          o.vel.z += nz * relSpeed * 0.25;
        }
      }

      // Update mesh transform & wheel animations
      const moved = Math.hypot(v.pos.x - prevX, v.pos.z - prevZ);
      const sign = v.speed >= 0 ? 1 : -1;
      v.wheelSpin += (moved / 0.36) * sign;

      v.mesh.position.set(v.pos.x, 0.04, v.pos.z);
      v.mesh.rotation.y = v.heading;

      // Subtle suspension pitch on acceleration/braking
      const targetPitch = v.braking ? 0.025 : clamp(-v.speed * 0.0005, -0.022, 0.02);
      v.mesh.rotation.x += (targetPitch - v.mesh.rotation.x) * Math.min(1, dt * 8);

      for (const w of v.wheels) {
        w.spin.rotation.x = v.wheelSpin;
        if (w.isFront) w.pivot.rotation.y = v.steerAngle;
      }

      // Brake lights
      const tailMat = v.braking ? TAIL_ON_MAT : TAIL_OFF_MAT;
      v.tailL.material = tailMat;
      v.tailR.material = tailMat;
      const revMat = v.reversing ? REVERSE_ON_MAT : REVERSE_OFF_MAT;
      v.revL.material = revMat;
      v.revR.material = revMat;
      if (v !== playerVehicle) v.reversing = false;

      // Damage tint: paint darkens toward scorched as health drops; smoke below 35%.
      this.updateDamageVisuals(v, time);

      // Police flashing lightbar with phase alternation.
      if (v.sirenBar) {
        if (v.sirenActive) {
          const phase = Math.floor(time * 9) % 2 === 0;
          v.sirenBar.redBox.material = phase ? SIREN_RED_MAT : SIREN_DIM_MAT;
          v.sirenBar.blueBox.material = phase ? SIREN_DIM_MAT : SIREN_BLUE_MAT;
          v.sirenBar.redGlow.visible = phase;
          v.sirenBar.blueGlow.visible = !phase;
        } else {
          v.sirenBar.redBox.material = SIREN_DIM_MAT;
          v.sirenBar.blueBox.material = SIREN_DIM_MAT;
          v.sirenBar.redGlow.visible = false;
          v.sirenBar.blueGlow.visible = false;
        }
      }
    }
  }
}
