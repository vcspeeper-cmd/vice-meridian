import * as THREE from 'three';
import { COMBAT_CFG, DIFFICULTY } from './config.js';
import { clamp, lerp } from './random.js';

const _tmpDir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _casingDummy = new THREE.Object3D();

// Sample a direction uniformly inside a cone of half-angle `angle` around `dir` (unit vector).
// Uses a uniform disk sample so the spread is round, not the box shape that per-axis jitter gives.
export function sampleCone(dir, angle, rng, out = new THREE.Vector3()) {
  if (angle <= 0) return out.copy(dir);
  const r = Math.sqrt(rng.next()) * Math.tan(angle);
  const theta = rng.next() * Math.PI * 2;
  // Build an orthonormal basis around dir; pick an up vector that is never parallel to it.
  if (Math.abs(dir.y) < 0.95) _up.set(0, 1, 0);
  else _up.set(1, 0, 0);
  _right.crossVectors(dir, _up).normalize();
  _up.crossVectors(_right, dir).normalize();
  out.copy(dir).addScaledVector(_right, Math.cos(theta) * r).addScaledVector(_up, Math.sin(theta) * r);
  return out.normalize();
}

// Pool of brass shell casings drawn as one InstancedMesh. Each casing flies out to the right of
// the muzzle, tumbles, bounces on the street and rests briefly before its slot is recycled.
class CasingPool {
  constructor(scene, size = 48) {
    this.size = size;
    const geo = new THREE.CylinderGeometry(0.03, 0.03, 0.11, 5);
    geo.rotateZ(Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0xd9a94a, emissive: 0x3a2808 }), size);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
    this.items = [];
    this.next = 0;
  }

  spawn(pos, heading, rng) {
    // Reject a bad origin outright: one NaN would poison every matrix in the instanced mesh.
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
      return;
    }
    const rx = Math.cos(heading);
    const rz = -Math.sin(heading);
    const c = {
      x: pos.x, y: pos.y, z: pos.z,
      vx: rx * rng.range(1.6, 2.6) + Math.sin(heading) * rng.range(-0.4, 0.3),
      vy: rng.range(2.2, 3.4),
      vz: rz * rng.range(1.6, 2.6) + Math.cos(heading) * rng.range(-0.4, 0.3),
      rot: rng.range(0, Math.PI * 2),
      spin: rng.range(12, 22),
      life: 3.5,
      bounces: 0,
    };
    // Fill the pool first, then recycle slots in a ring once it is full.
    if (this.items.length < this.size) this.items.push(c);
    else {
      this.items[this.next] = c;
      this.next = (this.next + 1) % this.size;
    }
  }

  // Returns how many casings hit the ground this step, so audio can tick a ping per bounce.
  update(dt) {
    let landed = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const c = this.items[i];
      c.life -= dt;
      if (c.life <= 0) {
        this.items.splice(i, 1);
        if (this.next > this.items.length) this.next = 0;
        continue;
      }
      if (c.bounces < 3) {
        c.vy -= 18 * dt;
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        c.z += c.vz * dt;
        c.rot += c.spin * dt;
        // Street level for a casing lying on its side.
        if (c.y < 0.26) {
          c.y = 0.26;
          c.vy = -c.vy * 0.35;
          c.vx *= 0.5;
          c.vz *= 0.5;
          c.spin *= 0.4;
          c.bounces++;
          if (c.bounces === 1) landed++;
        }
      }
    }
    for (let i = 0; i < this.items.length; i++) {
      const c = this.items[i];
      _casingDummy.position.set(c.x, c.y, c.z);
      _casingDummy.rotation.set(0, c.rot, c.bounces >= 3 ? 0 : c.rot * 0.7);
      _casingDummy.updateMatrix();
      this.mesh.setMatrixAt(i, _casingDummy.matrix);
    }
    this.mesh.count = this.items.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    return landed;
  }
}

export class CombatSystem {
  constructor(scene, city, textures, rng) {
    this.scene = scene;
    this.city = city;
    this.textures = textures;
    this.rng = rng;

    this.fireTimer = 0;
    this.meleeTimer = 0;
    this.tracers = [];
    this.muzzleFlashes = [];
    this.sparks = [];
    this.ragdolls = [];
    this.damageFlash = 0;
    // Accumulated spread ("bloom") from sustained fire; recovers when the trigger is released.
    this.bloom = 0;
    // Hit-marker state read by the HUD: time left and whether the last hit was a kill.
    this.hitMarker = 0;
    this.hitMarkerKill = false;
    this.hitMarkerHeadshot = false;
    this.lastWeaponIndex = -1;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.headshots = 0;
    this.kills = 0;
    // Optional pedestrian manager so gunfire causes panic and punches can knock civilians down.
    this.peds = null;
    // Camera pitch still owed back to the player after recoil kicks; paid back smoothly.
    this.recoilDebt = 0;
    // Melee lunge: a short forward dash on the punch frame.
    this.lungeTime = 0;
    this.lungeDir = new THREE.Vector3();
    // Hit-registration queue the HUD drains: one entry per confirmed hit, newest last.
    this.hitQueue = [];
    this.time = 0;
    this.difficulty = DIFFICULTY.normal;
    this.casings = new CasingPool(scene, COMBAT_CFG.maxCasings);
    // Muzzle "light": an additive warm pool projected on the ground under the shooter. It reads
    // as the flash lighting the street without adding a real light (which would recompile every
    // material and cost per-fragment work on software GL).
    this.lightPool = new THREE.Mesh(
      new THREE.CircleGeometry(1, 20),
      new THREE.MeshBasicMaterial({ map: textures.warmGlow || null, color: 0xffb86a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.lightPool.rotation.x = -Math.PI / 2;
    this.lightPool.visible = false;
    this.lightPoolLife = 0;
    scene.add(this.lightPool);
  }

  setDifficulty(level) {
    this.difficulty = DIFFICULTY[level] || DIFFICULTY.normal;
  }

  // Push one confirmed hit for the HUD (hit markers, kill feed, damage numbers).
  registerHit(entry) {
    this.hitQueue.push({ t: this.time, ...entry });
    // The queue is bounded so a long burst cannot grow it without limit if nobody is draining.
    if (this.hitQueue.length > COMBAT_CFG.hitQueueSize) this.hitQueue.shift();
  }

  // The HUD calls this once per frame to take every hit registered since the last call.
  consumeHits() {
    if (this.hitQueue.length === 0) return [];
    const out = this.hitQueue;
    this.hitQueue = [];
    return out;
  }

  getAccuracy() {
    return this.shotsFired > 0 ? this.shotsHit / this.shotsFired : 0;
  }

  flashLightPool(pos, radius = 3.2) {
    this.lightPool.position.set(pos.x, 0.27, pos.z);
    this.lightPool.scale.set(radius, radius, 1);
    this.lightPool.visible = true;
    this.lightPool.material.opacity = 0.55;
    this.lightPoolLife = 0.07;
  }

  spawnMuzzleFlash(pos, scale = 1.65) {
    const mat = new THREE.SpriteMaterial({
      map: this.textures.sunFlare,
      color: 0xffd37a,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    });
    const sp = new THREE.Sprite(mat);
    sp.position.copy(pos);
    sp.scale.set(scale, scale, 1);
    this.scene.add(sp);
    this.muzzleFlashes.push({ mesh: sp, life: 0.08, maxLife: 0.08 });
  }

  spawnTracer(start, end, color = 0xffe48a, life = 0.14) {
    const dir = new THREE.Vector3().subVectors(end, start);
    const len = dir.length();
    // Degenerate shots (muzzle inside geometry) would produce a zero-length cylinder.
    if (len < 0.1) return;
    const geo = new THREE.CylinderGeometry(0.032, 0.032, len, 4);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(start).addScaledVector(dir, 0.5);
    mesh.lookAt(end);
    this.scene.add(mesh);
    this.tracers.push({ mesh, life, maxLife: life, geo });
  }

  spawnImpactSpark(pos, color = 0xffa852, size = 1.4) {
    const mat = new THREE.SpriteMaterial({
      map: this.textures.warmGlow,
      color,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    const sp = new THREE.Sprite(mat);
    sp.position.copy(pos);
    sp.scale.set(size, size, 1);
    this.scene.add(sp);
    this.sparks.push({ mesh: sp, life: 0.18, maxLife: 0.18 });
  }

  raycastTargets(origin, dir, maxRange, targets) {
    let bestT = maxRange;
    let hitTarget = null;
    let hitPos = origin.clone().addScaledVector(dir, maxRange);
    let hitWorld = false;

    // Check against building colliders with a 2D slab ray in the x/z plane.
    for (const c of this.city.colliders) {
      let tmin = 0;
      let tmax = bestT;
      if (Math.abs(dir.x) > 1e-6) {
        const tx1 = (c.minX - origin.x) / dir.x;
        const tx2 = (c.maxX - origin.x) / dir.x;
        tmin = Math.max(tmin, Math.min(tx1, tx2));
        tmax = Math.min(tmax, Math.max(tx1, tx2));
      } else if (origin.x < c.minX || origin.x > c.maxX) {
        continue;
      }
      if (Math.abs(dir.z) > 1e-6) {
        const tz1 = (c.minZ - origin.z) / dir.z;
        const tz2 = (c.maxZ - origin.z) / dir.z;
        tmin = Math.max(tmin, Math.min(tz1, tz2));
        tmax = Math.min(tmax, Math.max(tz1, tz2));
      } else if (origin.z < c.minZ || origin.z > c.maxZ) {
        continue;
      }
      if (tmax >= tmin && tmin > 0.2 && tmin < bestT) {
        // Only count the slab hit if the ray is still below the roof at that distance.
        const yAt = origin.y + dir.y * tmin;
        if (yAt >= 0 && yAt <= c.maxY + 0.3) {
          bestT = tmin;
          hitTarget = null;
          hitWorld = true;
          hitPos = origin.clone().addScaledVector(dir, bestT);
        }
      }
    }

    // Ground plane: shots aimed downward stop at the street.
    if (dir.y < -1e-4) {
      const tGround = (0.05 - origin.y) / dir.y;
      if (tGround > 0.2 && tGround < bestT) {
        bestT = tGround;
        hitWorld = true;
        hitPos = origin.clone().addScaledVector(dir, bestT);
      }
    }

    // Check against NPC cylinder hitboxes; the top 0.35 m of the cylinder is the head.
    let headshot = false;
    for (const t of targets) {
      if (!t.alive) continue;
      const toX = t.pos.x - origin.x;
      const toZ = t.pos.z - origin.z;
      // Project the target onto the shot in the horizontal plane only.
      const proj = toX * dir.x + toZ * dir.z;
      if (proj <= 0.3 || proj >= bestT) continue;
      const px = origin.x + dir.x * proj;
      const pz = origin.z + dir.z * proj;
      const py = origin.y + dir.y * proj;
      const distSq = (px - t.pos.x) ** 2 + (pz - t.pos.z) ** 2;
      if (distSq < 0.72 * 0.72 && py >= t.pos.y - 0.2 && py <= t.pos.y + 2.0) {
        bestT = proj;
        hitTarget = t;
        hitWorld = false;
        hitPos = new THREE.Vector3(px, py, pz);
        headshot = py >= t.pos.y + COMBAT_CFG.headHeight && distSq < 0.3 * 0.3;
      }
    }

    return { hitTarget, hitPos, dist: bestT, hitWorld, headshot };
  }

  // Linear damage falloff between the weapon's falloffStart and its range.
  damageAt(spec, dist) {
    const start = spec.falloffStart ?? spec.range * 0.5;
    const k = clamp((dist - start) / Math.max(1, spec.range - start), 0, 1);
    return spec.damage * lerp(1, spec.minDamageScale ?? 0.45, k);
  }

  // Apply damage to an NPC target and, if it dies, start a tumbling death.
  applyHit(target, amount, dir, player, police, info = {}) {
    target.health -= amount;
    target.hitFlash = 0.2;
    this.hitMarker = COMBAT_CFG.hitMarkerTime;
    this.hitMarkerKill = false;
    this.hitMarkerHeadshot = Boolean(info.headshot);
    let killed = false;
    if (target.health <= 0 && target.alive) {
      target.alive = false;
      killed = true;
      this.hitMarkerKill = true;
      this.kills++;
      this.startRagdoll(target.mesh, dir, amount * (info.headshot ? 1.4 : 1));
      // Bounty: gang members are worth more than a random patrol officer.
      if (player) player.money += target.faction === 'gang' ? 120 : 50;
    }
    this.registerHit({
      kind: killed ? 'kill' : 'hit',
      headshot: Boolean(info.headshot),
      damage: Math.round(amount),
      weapon: info.weapon || 'fists',
      faction: target.faction || 'police',
      x: target.pos.x,
      y: target.pos.y + 1.8,
      z: target.pos.z,
    });
    // Shooting anyone but a gang member counts as a crime in the eyes of the police.
    if (police && target.faction !== 'gang') {
      police.reportCrime('shoot_officer', player ? player.pos : target.pos, 1.5);
    }
  }

  // Ragdoll-ish tumble: the body is pushed along the shot, pitches over with a little
  // twist, bounces once on the pavement and settles flat.
  startRagdoll(mesh, dir, force = 30) {
    if (!mesh) return;
    const push = clamp(force / 10, 1.6, 6);
    const tumbleSign = this.rng.chance(0.5) ? 1 : -1;
    this.ragdolls.push({
      mesh,
      t: 0,
      vx: dir.x * push,
      vz: dir.z * push,
      vy: 2.2,
      y: mesh.position.y,
      baseY: mesh.position.y,
      spin: this.rng.range(-2.4, 2.4),
      fallAxis: tumbleSign,
      startRotX: mesh.rotation.x,
      startRotZ: mesh.rotation.z,
    });
  }

  updateRagdolls(dt) {
    for (let i = this.ragdolls.length - 1; i >= 0; i--) {
      const r = this.ragdolls[i];
      r.t += dt;
      const m = r.mesh;
      r.vy -= 18 * dt;
      r.y += r.vy * dt;
      if (r.y <= r.baseY + 0.06) {
        r.y = r.baseY + 0.06;
        // One soft bounce, then the body stays down.
        if (r.vy < -1.5) r.vy = -r.vy * 0.28;
        else r.vy = 0;
        r.vx *= 0.55;
        r.vz *= 0.55;
      }
      m.position.x += r.vx * dt;
      m.position.z += r.vz * dt;
      m.position.y = r.y;
      const fall = clamp(r.t / 0.55, 0, 1);
      const eased = 1 - (1 - fall) * (1 - fall);
      m.rotation.x = r.startRotX + eased * Math.PI * 0.5;
      m.rotation.z = r.startRotZ + eased * 0.35 * r.fallAxis;
      m.rotation.y += r.spin * dt * (1 - fall);
      if (r.t > 1.4) this.ragdolls.splice(i, 1);
    }
  }

  // Melee punch: short-range cone check in front of the player.
  punch(player, targets, police, audio) {
    if (this.meleeTimer > 0 || player.vehicle || player.deadTimer > 0) return false;
    this.meleeTimer = COMBAT_CFG.punchCooldown;
    player.punchTimer = 0.28;
    // Forward vector on the ground plane, matching the player's heading convention.
    const fx = Math.sin(player.heading);
    const fz = Math.cos(player.heading);
    let best = null;
    let bestD = COMBAT_CFG.punchRange;
    // A candidate only counts if it is inside the range and roughly ahead (cos > 0.5, a ~60° cone).
    const consider = (t) => {
      if (!t.alive) return;
      const dx = t.pos.x - player.pos.x;
      const dz = t.pos.z - player.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > bestD || d < 1e-3) return;
      if ((dx * fx + dz * fz) / d < 0.5) return;
      best = t;
      bestD = d;
    };
    for (const t of targets) consider(t);
    let pedHit = null;
    if (this.peds && this.peds.peds) {
      for (const p of this.peds.peds) {
        const before = best;
        consider(p);
        if (best !== before) pedHit = p;
      }
    }
    if (!best) {
      if (audio && audio.playWhoosh) audio.playWhoosh();
      // Even a whiff carries the body forward a little.
      this.startLunge(fx, fz, 0.6);
      return false;
    }
    _tmpDir.set(fx, 0, fz);
    // Close the gap: lunge most of the way to the target, stopping short of its body.
    this.startLunge(fx, fz, clamp(bestD - 0.9, 0, 1));
    const hitPos = new THREE.Vector3(best.pos.x, best.pos.y + 1.4, best.pos.z);
    this.spawnImpactSpark(hitPos, 0xffffff, 0.9);
    player.addShake(0.08);
    if (audio && audio.playPunch) audio.playPunch();
    if (pedHit === best && this.peds.knockDown) {
      // Civilians go down instead of taking lethal damage.
      this.peds.knockDown(best, _tmpDir);
      this.hitMarker = COMBAT_CFG.hitMarkerTime;
      this.hitMarkerKill = !best.alive;
      if (police && police.isCopNearby(player.pos, 60)) police.reportCrime('assault', player.pos, 0.6);
    } else {
      this.applyHit(best, COMBAT_CFG.punchDamage, _tmpDir, player, police, { weapon: 'fists' });
    }
    return true;
  }

  // Start a melee lunge covering `distance` metres over COMBAT_CFG.lungeTime seconds.
  startLunge(fx, fz, distance) {
    if (distance <= 0.01) return;
    this.lungeTime = COMBAT_CFG.lungeTime;
    this.lungeDir.set(fx, 0, fz).multiplyScalar(distance / COMBAT_CFG.lungeTime);
  }

  updateLunge(dt, player) {
    // Driving or an already-finished dash cancels any pending lunge.
    if (this.lungeTime <= 0 || player.vehicle) {
      this.lungeTime = 0;
      return;
    }
    const step = Math.min(dt, this.lungeTime);
    this.lungeTime -= step;
    player.pos.x += this.lungeDir.x * step;
    player.pos.z += this.lungeDir.z * step;
    // Do not let the dash push the player through a wall.
    if (this.city.resolveCircleCollisions) this.city.resolveCircleCollisions(player.pos, 0.48);
  }

  firePlayerWeapon(player, targets, police, audio) {
    if (player.vehicle || player.deadTimer > 0) return;
    const spec = player.getCurrentWeaponSpec();
    if (spec.melee) {
      this.punch(player, targets, police, audio);
      return;
    }
    // Rate of fire gate shared by every shot path.
    if (this.fireTimer > 0) return;

    const st = player.getCurrentWeaponState();
    if (st.mag <= 0) {
      if (st.reserve <= 0) {
        // Empty and nothing to load: dry-fire click, rate-limited by the fire timer.
        this.fireTimer = spec.fireRate * 2;
        if (audio && audio.playReloadClick) audio.playReloadClick();
        return;
      }
      this.reloadWeapon(player, audio);
      return;
    }

    st.mag--;
    this.shotsFired++;
    this.fireTimer = spec.fireRate;
    player.addShake(0.08 + (spec.recoil || 0) * 2.2);
    if (audio) audio.playGunshot(spec.id === 'smg' ? 1.25 : 1.0);

    // Recoil kicks the view up and is paid back over the next few frames (see update);
    // sustained fire blooms the spread cone.
    if (spec.recoil) {
      const kick = spec.recoil * (1 + this.bloom * 6);
      const before = player.camPitch;
      player.camPitch = Math.max(-0.25, player.camPitch - kick);
      this.recoilDebt += before - player.camPitch;
    }
    const spread = spec.spread + this.bloom;
    this.bloom = Math.min(COMBAT_CFG.maxBloom, this.bloom + (spec.bloomPerShot || 0.006));

    // The muzzle sits just in front of and to the right of the chest.
    const muzzlePos = new THREE.Vector3(
      player.pos.x + Math.sin(player.heading) * 0.72 + Math.cos(player.heading) * 0.26,
      player.pos.y + 1.38,
      player.pos.z + Math.cos(player.heading) * 0.72 - Math.sin(player.heading) * 0.26,
    );

    const aimCenter = new THREE.Vector3(
      Math.sin(player.camYaw) * Math.cos(player.camPitch),
      -Math.sin(player.camPitch) * 0.65,
      Math.cos(player.camYaw) * Math.cos(player.camPitch),
    ).normalize();
    // Spread is a cone half-angle: the old per-axis jitter of ±spread/2 maps to atan(spread/2).
    const aimDir = sampleCone(aimCenter, Math.atan(spread * 0.5), this.rng);

    this.spawnMuzzleFlash(muzzlePos, 1.55);
    this.flashLightPool(player.pos, spec.id === 'smg' ? 2.6 : 3.2);
    this.casings.spawn(muzzlePos, player.heading, this.rng);
    const res = this.raycastTargets(muzzlePos, aimDir, spec.range, targets);
    this.spawnTracer(muzzlePos, res.hitPos, 0xffe48a, 0.13);
    this.spawnImpactSpark(res.hitPos, res.hitTarget ? (res.headshot ? 0xffffff : 0xff4558) : 0xffbe68);
    if (this.peds && this.peds.alertGunfire) this.peds.alertGunfire(player.pos, COMBAT_CFG.panicRadius);

    if (res.hitTarget) {
      this.shotsHit++;
      if (res.headshot) this.headshots++;
      const mult = res.headshot ? spec.headshotMult ?? COMBAT_CFG.headshotMultiplier : 1;
      const dmg = this.damageAt(spec, res.dist) * mult * this.difficulty.playerDamage;
      this.applyHit(res.hitTarget, dmg, aimDir, player, police, { headshot: res.headshot, weapon: spec.id });
    } else {
      // A high hit on a building may pop glass; either way, shots near cops draw attention.
      if (res.hitWorld && res.hitPos.y > 1.2 && audio && this.rng.chance(0.25)) audio.playGlassBreak(0.5);
      if (police && police.isCopNearby(player.pos, 75)) police.reportCrime('weapon_fire', player.pos, 0.8);
    }

    // Firing the last round starts the reload immediately.
    if (st.mag === 0) this.reloadWeapon(player, audio);
  }

  reloadWeapon(player, audio = null) {
    const spec = player.getCurrentWeaponSpec();
    if (spec.melee) return;
    const st = player.getCurrentWeaponState();
    const need = spec.magSize - st.mag;
    // Never load more rounds than the reserve actually holds.
    const take = Math.min(need, st.reserve);
    if (take <= 0) return;
    st.mag += take;
    st.reserve -= take;
    this.fireTimer = Math.max(this.fireTimer, spec.reloadTime || 0.9);
    if (audio && audio.playReload) audio.playReload();
  }

  fireNpcShot(npc, player, forceHit = null) {
    const start = new THREE.Vector3(
      npc.pos.x + Math.sin(npc.heading) * 0.65,
      npc.pos.y + 1.35,
      npc.pos.z + Math.cos(npc.heading) * 0.65,
    );
    const targetPos = new THREE.Vector3(player.pos.x, player.pos.y + 1.25, player.pos.z);
    const dir = new THREE.Vector3().subVectors(targetPos, start);
    const dist = dir.length();
    dir.normalize();

    // Accuracy falls off with distance and when the player is moving fast.
    const playerSpeed = player.vehicle ? Math.abs(player.vehicle.speed) : Math.hypot(player.vel.x, player.vel.z);
    const hitChance = COMBAT_CFG.npcBaseAccuracy * this.difficulty.npcAccuracy * clamp(1.35 - dist / 55, 0.25, 1.2) * clamp(1.15 - playerSpeed / 40, 0.4, 1.1);
    const hits = forceHit !== null ? forceHit : this.rng.chance(hitChance);
    if (!hits) {
      // A miss is still a tracer: scatter the direction around the target.
      dir.x += this.rng.range(-0.14, 0.14);
      dir.y += this.rng.range(-0.07, 0.08);
      dir.z += this.rng.range(-0.14, 0.14);
      dir.normalize();
    }

    const end = start.clone().addScaledVector(dir, Math.min(dist + 4, 65));
    this.spawnMuzzleFlash(start, 1.4);
    this.spawnTracer(start, end, npc.faction === 'gang' ? 0xff7048 : 0x70d4ff, 0.18);
    if (this.peds && this.peds.alertGunfire) this.peds.alertGunfire(npc.pos, COMBAT_CFG.panicRadius * 0.7);

    if (hits && player.deadTimer <= 0) {
      const dmg = Math.round(COMBAT_CFG.npcDamage * this.difficulty.npcDamage * clamp(1.2 - dist / 80, 0.5, 1.2));
      player.damage(dmg);
      this.damageFlash = 0.7;
      this.spawnImpactSpark(targetPos, 0xff4558);
    }
  }

  update(dt, controls, player, allTargets, police, audio) {
    this.time += dt;
    if (this.fireTimer > 0) this.fireTimer -= dt;
    if (this.meleeTimer > 0) this.meleeTimer -= dt;
    if (this.hitMarker > 0) this.hitMarker = Math.max(0, this.hitMarker - dt);
    if (this.damageFlash > 0) this.damageFlash = Math.max(0, this.damageFlash - dt * 2.4);
    // Spread recovers only once the trigger is released.
    if (!controls.fire) this.bloom = Math.max(0, this.bloom - dt * COMBAT_CFG.bloomRecover);

    // Pay the recoil kick back to the camera: fast at first, easing out (exponential decay).
    if (this.recoilDebt > 1e-5) {
      const pay = Math.min(this.recoilDebt, this.recoilDebt * (1 - Math.exp(-COMBAT_CFG.recoilRecovery * dt)) + 0.0004);
      this.recoilDebt -= pay;
      // While the trigger is held the kick is not returned, so sustained fire climbs.
      if (!controls.fire || this.fireTimer > 0) player.camPitch = Math.min(1.2, player.camPitch + pay);
    } else {
      this.recoilDebt = 0;
    }

    // Muzzle light pool fades in a couple of frames.
    if (this.lightPoolLife > 0) {
      this.lightPoolLife -= dt;
      this.lightPool.material.opacity = Math.max(0, this.lightPoolLife / 0.07) * 0.55;
      if (this.lightPoolLife <= 0) this.lightPool.visible = false;
    }

    this.updateLunge(dt, player);
    const landed = this.casings.update(dt);
    if (landed > 0 && audio && audio.playShellCasing) audio.playShellCasing();

    // Switching weapons clears the bloom and costs a beat before the next shot.
    if (player.weaponIndex !== this.lastWeaponIndex) {
      if (this.lastWeaponIndex >= 0 && audio && audio.playWeaponSwitch) audio.playWeaponSwitch();
      this.lastWeaponIndex = player.weaponIndex;
      this.bloom = 0;
      this.fireTimer = Math.max(this.fireTimer, 0.18);
    }

    if (controls.reload) this.reloadWeapon(player, audio);
    if (controls.melee) this.punch(player, allTargets, police, audio);
    if (controls.fire) this.firePlayerWeapon(player, allTargets, police, audio);

    this.updateRagdolls(dt);

    // Fade and retire the short-lived visual effects (tracers, flashes, sparks).
    const decayList = (arr) => {
      for (let i = arr.length - 1; i >= 0; i--) {
        const it = arr[i];
        it.life -= dt;
        if (it.life <= 0) {
          this.scene.remove(it.mesh);
          if (it.geo) it.geo.dispose();
          if (it.mesh.material) it.mesh.material.dispose();
          arr.splice(i, 1);
        } else if (it.mesh.material && 'opacity' in it.mesh.material) {
          it.mesh.material.opacity = Math.max(0, it.life / it.maxLife);
        }
      }
    };
    decayList(this.tracers);
    decayList(this.muzzleFlashes);
    decayList(this.sparks);
  }
}
