import * as THREE from 'three';
import { CITY, PLAYER_CFG, WEAPONS } from './config.js';
import { clamp, damp, wrapAngle } from './random.js';

function createPlayerMesh() {
  const root = new THREE.Group();

  const legsMat = new THREE.MeshLambertMaterial({ color: 0x222c3c });
  const shirtMat = new THREE.MeshLambertMaterial({ color: 0x1fc7c9 });
  const jacketMat = new THREE.MeshLambertMaterial({ color: 0xf4eee4 });
  const skinMat = new THREE.MeshLambertMaterial({ color: 0xd8a178 });
  const hairMat = new THREE.MeshLambertMaterial({ color: 0x1b1718 });
  const gunMat = new THREE.MeshLambertMaterial({ color: 0x252830 });

  const legGeo = new THREE.BoxGeometry(0.2, 0.78, 0.22);
  legGeo.translate(0, -0.39, 0);
  const legL = new THREE.Mesh(legGeo, legsMat);
  legL.position.set(-0.14, 0.8, 0);
  legL.castShadow = true;
  const legR = new THREE.Mesh(legGeo, legsMat);
  legR.position.set(0.14, 0.8, 0);
  legR.castShadow = true;

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.66, 0.28), jacketMat);
  torso.position.set(0, 1.15, 0);
  torso.castShadow = true;

  const shirtStrip = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.62, 0.3), shirtMat);
  shirtStrip.position.set(0, 1.14, 0.01);

  const armGeo = new THREE.BoxGeometry(0.16, 0.62, 0.16);
  armGeo.translate(0, -0.26, 0);
  const armL = new THREE.Mesh(armGeo, jacketMat);
  armL.position.set(-0.35, 1.4, 0);
  const armR = new THREE.Mesh(armGeo, jacketMat);
  armR.position.set(0.35, 1.4, 0);

  const pistol = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.34), gunMat);
  pistol.position.set(0, -0.5, 0.18);
  armR.add(pistol);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.32, 0.3), skinMat);
  head.position.set(0, 1.66, 0);
  head.castShadow = true;

  const hair = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.12, 0.32), hairMat);
  hair.position.set(0, 1.82, -0.02);

  const shades = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.07, 0.06), gunMat);
  shades.position.set(0, 1.68, 0.15);

  root.add(legL, legR, torso, shirtStrip, armL, armR, head, hair, shades);
  return { root, legL, legR, armL, armR, pistol };
}

export class PlayerController {
  constructor(scene, city, camera) {
    this.scene = scene;
    this.city = city;
    this.camera = camera;

    const built = createPlayerMesh();
    this.mesh = built.root;
    this.parts = built;
    this.scene.add(this.mesh);

    this.pos = new THREE.Vector3(122, 0.22, -24);
    this.vel = new THREE.Vector3();
    this.heading = 0;
    this.camYaw = 0;
    this.camPitch = 0.24;
    this.onGround = true;
    this.walkPhase = 0;
    this.aiming = false;

    this.vehicle = null;
    this.storedGarageType = null;
    this.storedGarageColor = null;

    this.health = PLAYER_CFG.maxHealth;
    this.armour = PLAYER_CFG.maxArmour;
    this.money = 1250;
    // Validate that health and armour do not exceed their configured maximums.
    if (this.health > PLAYER_CFG.maxHealth) this.health = PLAYER_CFG.maxHealth;
    if (this.armour > PLAYER_CFG.maxArmour) this.armour = PLAYER_CFG.maxArmour;
    this.deadTimer = 0;

    this.weaponIndex = 0;
    this.weaponsState = WEAPONS.map((w) => ({
      id: w.id,
      unlocked: w.unlockedByDefault,
      mag: w.magSize,
      reserve: Math.floor(w.maxReserve * 0.65),
    }));

    this.shake = 0;
    this.shakeClock = 0;
    this.camPos = new THREE.Vector3(122, 5, -34);
    this.camLook = new THREE.Vector3(122, 2, -24);
    this.cameraOverride = null;

    // 0 = on-foot rig, 1 = driving rig; eased over PLAYER_CFG.cameraBlendTime on enter/exit.
    this.camBlend = 0;
    this.lastVehicle = null;
    this.lookBack = false;
    this.busted = false;
    this.bustProgress = 0;
    this.punchTimer = 0;
    this.lastHitTimer = 0;
    this.moving = false;
    this.running = false;
    this.landingSquash = 0;
    this.stats = { distanceDriven: 0, distanceWalked: 0, deaths: 0, arrests: 0 };

    // Locomotion state: 'idle' | 'walk' | 'run' | 'sprint' | 'air' | 'downed'.
    this.moveState = 'idle';
    this.stamina = PLAYER_CFG.staminaMax;
    this.staminaLocked = false;
    // Time since the feet last touched ground (coyote time) and the surface height underfoot.
    this.airTime = 0;
    this.groundY = 0.22;
    this.downedTimer = 0;
    this.calmTimer = 0;
    // Footstep events since the last consumeEvents() call, emitted on each stride's foot plant.
    this.events = [];
    this.lastStrideSign = 0;
    this.emitsFootsteps = true;
    // Settings-driven camera values.
    this.baseFov = 60;
    this.reduceMotion = false;
  }

  setBaseFov(fov) {
    this.baseFov = clamp(Number(fov) || 60, 45, 100);
  }

  setReduceMotion(on) {
    this.reduceMotion = Boolean(on);
    if (this.reduceMotion) this.shake = 0;
  }

  // Drain gameplay events (footsteps, landings, knockdowns) for audio and HUD.
  consumeEvents() {
    if (this.events.length === 0) return [];
    const out = this.events;
    this.events = [];
    return out;
  }

  emit(type, data = {}) {
    this.events.push({ type, ...data });
    if (this.events.length > 32) this.events.shift();
  }

  // Knock the player off their feet (big hit, car clip, hard landing). No input until it ends.
  knockDown(duration = PLAYER_CFG.downedTime) {
    if (this.deadTimer > 0 || this.vehicle) return;
    this.downedTimer = Math.max(this.downedTimer, duration);
    this.moveState = 'downed';
    this.emit('downed');
  }

  // Capsule (radius × height, feet at pos.y) against the city's static boxes, using the
  // spatial index. Boxes whose top is below the feet (+ step height) are surfaces to stand on,
  // not walls; the highest such top under the capsule becomes the ground height.
  resolveCapsule() {
    const r = PLAYER_CFG.radius;
    const grid = this.city.colliderGrid;
    const boxes = this.city.colliders;
    let ground = 0.22;
    let standingOnBox = false;
    if (grid) {
      const ids = grid.query(this.pos.x, this.pos.z, r + 0.05);
      for (let k = 0; k < ids.length; k++) {
        const c = boxes[ids[k]];
        const top = c.maxY + 0.22;
        const cx = clamp(this.pos.x, c.minX, c.maxX);
        const cz = clamp(this.pos.z, c.minZ, c.maxZ);
        const dx = this.pos.x - cx;
        const dz = this.pos.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        if (this.pos.y >= top - PLAYER_CFG.stepHeight) {
          // Over the box: it is floor. Only count it when the feet are actually above it.
          if (d2 < (r * 0.6) ** 2 || (this.pos.x >= c.minX && this.pos.x <= c.maxX && this.pos.z >= c.minZ && this.pos.z <= c.maxZ)) {
            ground = Math.max(ground, top);
            standingOnBox = true;
          }
          continue;
        }
        // Wall: push out along the shortest separation.
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          this.pos.x += (dx / d) * (r - d);
          this.pos.z += (dz / d) * (r - d);
        } else {
          const pushes = [this.pos.x - c.minX, c.maxX - this.pos.x, this.pos.z - c.minZ, c.maxZ - this.pos.z];
          const m = Math.min(...pushes);
          if (m === pushes[0]) this.pos.x = c.minX - r;
          else if (m === pushes[1]) this.pos.x = c.maxX + r;
          else if (m === pushes[2]) this.pos.z = c.minZ - r;
          else this.pos.z = c.maxZ + r;
        }
      }
    }
    // Ground-level movement still goes through the city resolver for the world bounds (sea,
    // pier rails, annex edges). On top of a box those bounds cannot apply.
    if (!standingOnBox) this.city.resolveCircleCollisions(this.pos, r);
    this.groundY = ground;
    return ground;
  }

  // Select a weapon by id if it is unlocked; returns true when the selection changed.
  selectWeapon(id) {
    const idx = WEAPONS.findIndex((w) => w.id === id);
    if (idx < 0 || !this.weaponsState[idx].unlocked || idx === this.weaponIndex) return false;
    this.weaponIndex = idx;
    return true;
  }

  // Step to the next (dir = 1) or previous (dir = -1) unlocked weapon.
  cycleWeapon(dir = 1) {
    const n = WEAPONS.length;
    for (let step = 1; step <= n; step++) {
      const idx = (((this.weaponIndex + step * dir) % n) + n) % n;
      if (this.weaponsState[idx].unlocked) {
        this.weaponIndex = idx;
        return;
      }
    }
  }

  serialize() {
    return {
      x: +this.pos.x.toFixed(2),
      z: +this.pos.z.toFixed(2),
      heading: +this.heading.toFixed(3),
      health: Math.round(this.health),
      armour: Math.round(this.armour),
      money: Math.floor(this.money),
      weaponIndex: this.weaponIndex,
      weapons: this.weaponsState.map((w) => ({ id: w.id, unlocked: w.unlocked, mag: w.mag, reserve: w.reserve })),
      garage: this.storedGarageType ? { type: this.storedGarageType, color: this.storedGarageColor } : null,
    };
  }

  restore(data) {
    if (!data) return;
    if (this.vehicle) this.exitVehicle();
    this.pos.set(data.x, 0.22, data.z);
    this.city.resolveCircleCollisions(this.pos, PLAYER_CFG.radius);
    this.heading = Number.isFinite(data.heading) ? data.heading : 0;
    this.camYaw = this.heading;
    this.health = clamp(Number(data.health) || PLAYER_CFG.maxHealth, 1, PLAYER_CFG.maxHealth);
    this.armour = clamp(Number(data.armour) || 0, 0, PLAYER_CFG.maxArmour);
    this.money = Math.max(0, Number(data.money) || 0);
    if (Array.isArray(data.weapons)) {
      for (const saved of data.weapons) {
        const st = this.weaponsState.find((w) => w.id === saved.id);
        if (!st) continue;
        st.unlocked = Boolean(saved.unlocked);
        st.mag = Math.max(0, saved.mag | 0);
        st.reserve = Math.max(0, saved.reserve | 0);
      }
    }
    if (Number.isInteger(data.weaponIndex) && this.weaponsState[data.weaponIndex] && this.weaponsState[data.weaponIndex].unlocked) {
      this.weaponIndex = data.weaponIndex;
    }
    if (data.garage) {
      this.storedGarageType = data.garage.type;
      this.storedGarageColor = data.garage.color;
    }
    this.deadTimer = 0;
    this.busted = false;
    this.vel.set(0, 0, 0);
    this.mesh.position.copy(this.pos);
    this.mesh.visible = true;
    this.camPos.set(this.pos.x - Math.sin(this.heading) * 5, this.pos.y + 3, this.pos.z - Math.cos(this.heading) * 5);
    this.camLook.copy(this.pos);
  }

  getCurrentWeaponSpec() {
    return WEAPONS[this.weaponIndex];
  }

  getCurrentWeaponState() {
    return this.weaponsState[this.weaponIndex];
  }

  addShake(amount) {
    if (this.reduceMotion) return;
    this.shake = Math.min(1.2, this.shake + amount);
  }

  damage(amount) {
    if (this.deadTimer > 0) return;
    let rem = amount;
    if (this.armour > 0) {
      const absorbed = Math.min(this.armour, rem * PLAYER_CFG.armourAbsorb);
      this.armour = Math.max(0, this.armour - absorbed);
      rem -= absorbed;
    }
    this.health = Math.max(0, this.health - rem);
    this.lastHitTimer = 4;
    this.calmTimer = 0;
    this.addShake(0.32);
    if (this.health > 0 && amount >= PLAYER_CFG.downedThreshold) this.knockDown();
    if (this.health <= 0) {
      this.deadTimer = 3.2;
      this.busted = false;
      this.stats.deaths++;
      if (this.vehicle) this.exitVehicle();
      // Collapse on the spot.
      this.mesh.rotation.x = -Math.PI * 0.5;
      this.mesh.position.y = this.pos.y + 0.2;
    }
  }

  // Called by the police when officers pin a slow/stationary wanted player.
  arrest() {
    if (this.deadTimer > 0) return;
    this.busted = true;
    this.deadTimer = 3.6;
    this.stats.arrests++;
    if (this.vehicle) this.exitVehicle();
    this.vel.set(0, 0, 0);
    this.parts.armL.rotation.x = -2.9;
    this.parts.armR.rotation.x = -2.9;
  }

  respawnAtHospital() {
    this.pos.set(CITY.hospitalPos.x, 0.22, CITY.hospitalPos.z + 18);
    this.vel.set(0, 0, 0);
    this.health = PLAYER_CFG.maxHealth;
    this.armour = 50;
    this.money = Math.max(0, this.money - 200);
    this.deadTimer = 0;
    this.downedTimer = 0;
    this.stamina = PLAYER_CFG.staminaMax;
    this.staminaLocked = false;
    this.mesh.visible = true;
    this.mesh.rotation.x = 0;
  }

  // Busted: released from Meridian PD Central, minus bail and every gun's ammunition.
  respawnAtPolice() {
    this.pos.set(CITY.policeHQPos.x, 0.22, CITY.policeHQPos.z + 18);
    this.vel.set(0, 0, 0);
    this.health = PLAYER_CFG.maxHealth;
    this.armour = 0;
    this.money = Math.max(0, this.money - 300);
    for (const st of this.weaponsState) {
      st.mag = 0;
      st.reserve = 0;
    }
    const pistol = this.weaponsState.find((w) => w.id === 'pistol');
    if (pistol) pistol.mag = 6;
    this.deadTimer = 0;
    this.downedTimer = 0;
    this.busted = false;
    this.mesh.visible = true;
    this.mesh.rotation.x = 0;
  }

  enterVehicle(v, police, audio) {
    if (this.vehicle || !v) return false;
    this.vehicle = v;
    v.aiMode = 'player';
    this.mesh.visible = false;
    if (!v.stolen) {
      v.stolen = true;
      if (police && police.isCopNearby(v.pos, 65)) {
        police.reportCrime('car_theft', v.pos, 2);
      } else if (v.spec.isPolice && police) {
        police.reportCrime('police_theft', v.pos, 2);
      }
    }
    if (audio) audio.playDoor();
    return true;
  }

  exitVehicle() {
    if (!this.vehicle) return;
    const v = this.vehicle;
    const leftX = Math.cos(v.heading) * (v.spec.width * 0.75 + 0.6);
    const leftZ = -Math.sin(v.heading) * (v.spec.width * 0.75 + 0.6);
    this.pos.set(v.pos.x - leftX, 0.22, v.pos.z - leftZ);
    this.city.resolveCircleCollisions(this.pos, PLAYER_CFG.radius);
    this.heading = v.heading;
    this.vel.set(0, 0, 0);
    v.aiMode = 'parked';
    this.vehicle = null;
    this.mesh.visible = true;
  }

  update(dt, controls, mouseDelta, vehicles, police, audio) {
    if (this.punchTimer > 0) this.punchTimer -= dt;
    if (this.deadTimer > 0) {
      this.deadTimer -= dt;
      if (this.deadTimer <= 0) {
        if (this.busted) this.respawnAtPolice();
        else this.respawnAtHospital();
        if (police) police.resetWanted();
        this.camBlend = 0;
      }
      this.updateCamera(dt);
      return;
    }

    // Mouse / right-stick look
    this.camYaw = wrapAngle(this.camYaw - mouseDelta.dx * 0.0026);
    this.camPitch = clamp(this.camPitch + mouseDelta.dy * 0.0022, -0.25, 0.85);
    this.lookBack = Boolean(controls.lookBack);
    this.aiming = Boolean(controls.aim) && !this.vehicle;

    // Weapon switching: 1 fists, 2 pistol, 3 SMG (if unlocked), X / RB next, Z / LB previous.
    if (controls.weapon1) this.selectWeapon('fists');
    if (controls.weapon2) this.selectWeapon('pistol');
    if (controls.weapon3) this.selectWeapon('smg');
    if (controls.nextWeapon) this.cycleWeapon(1);
    if (controls.prevWeapon) this.cycleWeapon(-1);

    // Regeneration rules. Armour never regenerates (pickups only). Health creeps back to a low
    // floor a few seconds after the last hit; with no wanted level, standing still out of
    // combat refills further, to calmRegenCap.
    if (this.lastHitTimer > 0) this.lastHitTimer -= dt;
    else if (this.health < PLAYER_CFG.healthRegenBelow) this.health = Math.min(PLAYER_CFG.healthRegenBelow, this.health + PLAYER_CFG.healthRegenRate * dt);
    const wantedNow = police && police.stars > 0;
    const still = !this.vehicle && Math.hypot(this.vel.x, this.vel.z) < 0.5;
    this.calmTimer = !wantedNow && this.lastHitTimer <= 0 && still ? this.calmTimer + dt : 0;
    if (this.calmTimer > PLAYER_CFG.calmDelay && this.health < PLAYER_CFG.calmRegenCap) {
      this.health = Math.min(PLAYER_CFG.calmRegenCap, this.health + PLAYER_CFG.calmRegenRate * dt);
    }

    // Downed: lying on the street, no control until the timer runs out, then a quick get-up.
    if (this.downedTimer > 0 && !this.vehicle) {
      this.downedTimer -= dt;
      const k = clamp(this.downedTimer / PLAYER_CFG.downedTime, 0, 1);
      this.vel.x *= Math.exp(-6 * dt);
      this.vel.z *= Math.exp(-6 * dt);
      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.z * dt;
      this.resolveCapsule();
      this.mesh.position.copy(this.pos);
      this.mesh.rotation.y = this.heading;
      // Fall flat fast, rise during the last 30% of the timer.
      this.mesh.rotation.x = k > 0.3 ? -Math.PI * 0.5 : -Math.PI * 0.5 * (k / 0.3);
      this.mesh.position.y = this.pos.y + 0.2 * (k > 0.3 ? 1 : k / 0.3);
      if (this.downedTimer <= 0) {
        this.mesh.rotation.x = 0;
        this.moveState = 'idle';
        this.emit('getup');
      }
      this.updateCamera(dt);
      return;
    }

    // Enter / exit vehicle
    if (controls.enterExit) {
      if (this.vehicle) {
        this.exitVehicle();
      } else {
        const near = vehicles.findNearestVehicle(this.pos, PLAYER_CFG.enterVehicleDist);
        if (near) this.enterVehicle(near, police, audio);
      }
    }

    if (this.vehicle) {
      this.stats.distanceDriven += Math.abs(this.vehicle.speed) * dt;
      this.pos.copy(this.vehicle.pos);
      this.heading = this.vehicle.heading;
      // Save stolen car into garage when parked on the garage pad
      const gDist = Math.hypot(this.pos.x - CITY.garagePos.x, this.pos.z - CITY.garagePos.z);
      if (gDist < 5.5 && Math.abs(this.vehicle.speed) < 3.5) {
        this.storedGarageType = this.vehicle.type;
        this.storedGarageColor = this.vehicle.color;
      }
    } else {
      // On-foot movement relative to camera yaw. Analog sticks give proportional walk → run;
      // the keyboard walks, and Shift (or a full stick push + sprint) runs.
      let moveZ = controls.moveY !== undefined ? controls.moveY : (controls.forward ? 1 : 0) - (controls.backward ? 1 : 0);
      let moveX = controls.moveX !== undefined ? controls.moveX : (controls.right ? 1 : 0) - (controls.left ? 1 : 0);
      const mag = Math.min(1, Math.hypot(moveX, moveZ));
      const aimSlow = this.aiming ? 0.6 : 1;
      // Stamina: sprinting drains it; once empty, sprint is locked until it recovers a little.
      const wantsSprint = Boolean(controls.sprint) && mag > 0.1 && !this.aiming;
      if (wantsSprint && !this.staminaLocked) {
        this.stamina = Math.max(0, this.stamina - PLAYER_CFG.staminaDrain * dt);
        if (this.stamina <= 0) this.staminaLocked = true;
      } else {
        this.stamina = Math.min(PLAYER_CFG.staminaMax, this.stamina + PLAYER_CFG.staminaRegen * dt);
        if (this.staminaLocked && this.stamina >= PLAYER_CFG.staminaResume) this.staminaLocked = false;
      }
      const sprinting = wantsSprint && !this.staminaLocked;
      // Walk below 55% stick, run at full deflection (or keyboard), sprint on the sprint button.
      let speed;
      if (sprinting) speed = PLAYER_CFG.sprintSpeed;
      else if (mag < 0.55) speed = PLAYER_CFG.slowWalkSpeed + (PLAYER_CFG.walkSpeed - PLAYER_CFG.slowWalkSpeed) * Math.max(0, (mag - 0.2) / 0.35) * 0.5;
      else speed = PLAYER_CFG.walkSpeed;
      speed *= aimSlow;
      this.running = sprinting;
      this.moveState = !this.onGround ? 'air' : mag < 0.1 ? 'idle' : sprinting ? 'sprint' : mag < 0.55 ? 'walk' : 'run';
      if (mag > 1e-3 && mag < 1) {
        moveX /= mag;
        moveZ /= mag;
      }

      const sinY = Math.sin(this.camYaw);
      const cosY = Math.cos(this.camYaw);
      let dirX = sinY * moveZ + cosY * moveX;
      let dirZ = cosY * moveZ - sinY * moveX;
      const len = Math.hypot(dirX, dirZ);
      // Air control is reduced so jumps carry momentum.
      const control = this.onGround ? 1 : 0.25;
      if (len > 0.01) {
        dirX /= len;
        dirZ /= len;
        this.vel.x = damp(this.vel.x, dirX * speed, 18 * control, dt);
        this.vel.z = damp(this.vel.z, dirZ * speed, 18 * control, dt);
        if (!this.aiming) {
          const targetHeading = Math.atan2(dirX, dirZ);
          const diff = wrapAngle(targetHeading - this.heading);
          this.heading = wrapAngle(this.heading + diff * Math.min(1, dt * 12));
        }
        this.walkPhase += dt * (this.running ? 14 : 9 * Math.max(0.5, mag));
      } else if (this.onGround) {
        this.vel.x *= Math.exp(-12 * dt);
        this.vel.z *= Math.exp(-12 * dt);
      }
      this.moving = len > 0.01;

      if (controls.fire || this.aiming) {
        this.heading = this.camYaw;
      }

      // Jump with coyote time (a short grace after leaving a ledge) and a press buffer (a jump
      // pressed just before landing fires on touchdown).
      const canJump = this.onGround || this.airTime < PLAYER_CFG.coyoteTime;
      const buffered = controls.jumpBufferAge !== undefined && controls.jumpBufferAge <= PLAYER_CFG.jumpBufferTime;
      if ((controls.jump || buffered) && canJump && this.vel.y <= 0.01) {
        this.vel.y = PLAYER_CFG.jumpSpeed * (this.running ? 1.08 : 1);
        this.onGround = false;
        this.airTime = PLAYER_CFG.coyoteTime;
        if (controls.consumeJump) controls.consumeJump();
        this.emit('jump');
      }
      this.vel.y -= PLAYER_CFG.gravity * dt;

      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.z * dt;
      this.pos.y += this.vel.y * dt;
      this.stats.distanceWalked += Math.hypot(this.vel.x, this.vel.z) * dt;

      // Capsule collision first: it also reports the surface height under the feet.
      const groundY = this.resolveCapsule();
      if (this.pos.y <= groundY) {
        if (!this.onGround) {
          const impact = -this.vel.y;
          this.landingSquash = Math.min(0.25, impact * 0.02);
          if (impact > PLAYER_CFG.fallDamageSpeed) this.damage((impact - PLAYER_CFG.fallDamageSpeed) * 6);
          this.emit('land', { impact });
          if (audio && audio.playFootstep) audio.playFootstep(1.6);
        }
        this.pos.y = groundY;
        this.vel.y = 0;
        this.onGround = true;
        this.airTime = 0;
      } else if (this.pos.y > groundY + 0.05) {
        // Walked off a raised surface: start falling, but keep coyote time to jump.
        if (this.onGround && this.vel.y <= 0) this.onGround = false;
        this.airTime += dt;
      }
      if (this.landingSquash > 0) this.landingSquash = Math.max(0, this.landingSquash - dt * 1.2);

      // Footstep events on each foot plant (stride sine changes sign), weighted by gait.
      const strideSign = Math.sign(Math.sin(this.walkPhase));
      if (this.onGround && len > 0.05 && strideSign !== 0 && strideSign !== this.lastStrideSign) {
        const weight = sprinting ? 1.3 : this.moveState === 'walk' ? 0.6 : 1;
        this.emit('footstep', { weight, foot: strideSign > 0 ? 'L' : 'R' });
        if (audio && audio.playFootstep) audio.playFootstep(weight);
      }
      this.lastStrideSign = strideSign;

      // Animate character limbs
      this.mesh.position.copy(this.pos);
      this.mesh.position.y -= this.landingSquash * 0.4;
      this.mesh.rotation.y = this.heading;
      const strideAmt = this.running ? 0.8 : 0.55;
      const stride = len > 0.05 && this.onGround ? Math.sin(this.walkPhase) * strideAmt : 0;
      const airPose = this.onGround ? 0 : 0.5;
      this.parts.legL.rotation.x = stride - airPose;
      this.parts.legR.rotation.x = -stride + airPose * 0.4;
      this.parts.armL.rotation.x = this.onGround ? -stride * 0.7 : -2.2;
      const weapon = this.getCurrentWeaponSpec();
      this.parts.pistol.visible = !weapon.melee;
      if (this.punchTimer > 0) {
        // Jab: arm snaps forward then recoils.
        const k = this.punchTimer / 0.28;
        this.parts.armR.rotation.x = -1.6 * Math.sin(k * Math.PI);
      } else if (!weapon.melee && (controls.fire || this.aiming)) {
        this.parts.armR.rotation.x = -1.45;
      } else {
        this.parts.armR.rotation.x = this.onGround ? stride * 0.7 : -2.2;
      }
    }

    if (vehicles.lastImpact > 6) {
      this.addShake(Math.min(0.65, vehicles.lastImpact * 0.02));
      if (audio) audio.playImpact(vehicles.lastImpact);
    }

    this.updateCamera(dt);
  }

  updateCamera(dt) {
    if (this.cameraOverride) {
      this.camera.position.copy(this.cameraOverride.position);
      this.camera.lookAt(this.cameraOverride.lookAt);
      if (this.cameraOverride.fov && this.camera.fov !== this.cameraOverride.fov) {
        this.camera.fov = this.cameraOverride.fov;
        this.camera.updateProjectionMatrix();
      }
      return;
    }

    let desiredPos, desiredLook, targetFov;
    // Ease the rig weight toward the current mode; smoothstep makes the hand-off gentle.
    const blendTarget = this.vehicle ? 1 : 0;
    const blendStep = dt / Math.max(0.05, PLAYER_CFG.cameraBlendTime);
    this.camBlend = blendTarget > this.camBlend ? Math.min(1, this.camBlend + blendStep) : Math.max(0, this.camBlend - blendStep);
    if (this.vehicle) this.lastVehicle = this.vehicle;
    const w = this.camBlend * this.camBlend * (3 - 2 * this.camBlend);

    // On-foot rig (over-the-shoulder, tighter when aiming)
    const footDist = this.aiming ? 3.2 : 4.9;
    const shoulder = this.aiming ? 0.95 : 0.75;
    const yaw = this.camYaw + (this.lookBack && !this.vehicle ? Math.PI : 0);
    const sinY = Math.sin(yaw);
    const cosY = Math.cos(yaw);
    const cosP = Math.cos(this.camPitch);
    const sinP = Math.sin(this.camPitch);
    const footPos = new THREE.Vector3(
      this.pos.x - sinY * cosP * footDist + cosY * shoulder,
      this.pos.y + 1.75 + sinP * footDist,
      this.pos.z - cosY * cosP * footDist - sinY * shoulder,
    );
    const footLook = new THREE.Vector3(
      this.pos.x + sinY * 8 + cosY * 0.35,
      this.pos.y + 1.5 - sinP * 2.5,
      this.pos.z + cosY * 8 - sinY * 0.35,
    );
    const footFov = this.aiming ? this.baseFov - 10 : this.baseFov;

    if (w > 0 && this.lastVehicle) {
      const v = this.lastVehicle;
      const speed = Math.abs(v.speed);
      const backDist = 7.4 + clamp(speed * 0.05, 0, 2.2);
      const height = 2.95 + clamp(speed * 0.015, 0, 0.7);
      const lookAhead = clamp(v.speed * 0.16, -2.5, 8.5);
      const back = this.lookBack ? -1 : 1;
      const fwdX = Math.sin(v.heading) * back;
      const fwdZ = Math.cos(v.heading) * back;

      const drivePos = new THREE.Vector3(
        v.pos.x - fwdX * backDist,
        v.pos.y + height,
        v.pos.z - fwdZ * backDist,
      );
      const driveLook = new THREE.Vector3(
        v.pos.x + fwdX * (4.5 + lookAhead),
        v.pos.y + 1.35,
        v.pos.z + fwdZ * (4.5 + lookAhead),
      );
      const driveFov = this.baseFov + clamp(speed * 0.34, 0, 16);
      desiredPos = footPos.lerp(drivePos, w);
      desiredLook = footLook.lerp(driveLook, w);
      targetFov = footFov + (driveFov - footFov) * w;
    } else {
      desiredPos = footPos;
      desiredLook = footLook;
      targetFov = footFov;
    }

    // While blending, follow tightly so the explicit blend (not the damping) shapes the move.
    const blending = w > 0.001 && w < 0.999;
    const posLambda = blending ? 16 : this.vehicle ? 8.5 : 14;
    this.camPos.x = damp(this.camPos.x, desiredPos.x, posLambda, dt);
    this.camPos.y = damp(this.camPos.y, Math.max(1.1, desiredPos.y), posLambda, dt);
    this.camPos.z = damp(this.camPos.z, desiredPos.z, posLambda, dt);

    this.camLook.x = damp(this.camLook.x, desiredLook.x, 12, dt);
    this.camLook.y = damp(this.camLook.y, desiredLook.y, 12, dt);
    this.camLook.z = damp(this.camLook.z, desiredLook.z, 12, dt);

    // Camera shake decay, driven by an internal clock so it is frame-rate and replay stable.
    this.shakeClock += dt;
    let sx = 0, sy = 0;
    if (this.shake > 0.005) {
      sx = Math.sin(this.shakeClock * 70) * this.shake * 0.32;
      sy = Math.cos(this.shakeClock * 90) * this.shake * 0.24;
      this.shake = Math.max(0, this.shake - dt * 1.8);
    }

    this.camera.position.set(this.camPos.x + sx, this.camPos.y + sy, this.camPos.z);
    this.camera.lookAt(this.camLook);

    const newFov = damp(this.camera.fov, targetFov, 5.5, dt);
    if (Math.abs(newFov - this.camera.fov) > 0.02) {
      this.camera.fov = newFov;
      this.camera.updateProjectionMatrix();
    }
  }
}
