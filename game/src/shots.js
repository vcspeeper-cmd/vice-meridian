import * as THREE from 'three';
import { CITY } from './config.js';
import { MISSION_DEFS } from './missions.js';

// Deterministic screenshot rigs. Each named shot lays out a fixed scene — vehicles, crowd, wanted
// state, dialogue and VFX — and returns a small descriptor that stepShotScene() advances by hand,
// so a capture is identical whatever the frame rate or wall clock.

// Wrapped vertical loop length for the chase and drive rigs: once the hero car passes the far end
// it jumps back by this many metres, along with everything tracking it.
const LOOP_WRAP = 220;

// Rebuild the entire dynamic scene for `shotName`. Returns null when the context is incomplete so
// the caller can fall back to the title frame.
export function setupShotScene(shotName, ctx) {
  const { city, vehicles, peds, player, police, combat, missions, renderRig } = ctx;
  if (!city || !vehicles || !peds || !player || !police || !missions) {
    console.error('setupShotScene: incomplete context');
    return null;
  }

  // Every shot starts from the same slate so the frame is reproducible.
  police.resetWanted();
  missions.clearEnemies();
  player.health = 100;
  player.armour = 100;
  player.money = 3480;
  player.deadTimer = 0;

  // Boulevard coordinates: road centres sit at [-210, -140, -70, 0, 70, 140, 210] on both axes,
  // so the Palmetto Strip lane pair is x = 140 ± 3.6 and the coastal highway is x = 210 ± 3.6.
  const palmettoX = 140;
  const coastalX = CITY.coastalRoadX;

  if (shotName === 'chase') {
    // Vantablack GT speeding north along the palm-lined Palmetto Strip at golden hour, two MPD
    // cruisers close behind with lights flashing, three stars lit, traffic ahead and skyline behind.
    const carZ = 24;
    const car = vehicles.spawnVehicle('sports', palmettoX + 2.4, carZ, Math.PI, {
      color: 0xff3a5e,
      aiMode: 'shot',
      speed: 38,
    });
    car.vel.set(0, 0, 0);
    player.vehicle = car;
    player.mesh.visible = false;
    player.pos.copy(car.pos);
    player.heading = car.heading;

    // Pursuers in staggered formation, a few metres off the hero's rear quarters.
    const cop1 = police.spawnPursuitCruiser(car.pos, { x: palmettoX + 5.1, z: carZ + 12.5 }, Math.PI + 0.08);
    const cop2 = police.spawnPursuitCruiser(car.pos, { x: palmettoX - 2.6, z: carZ + 18.5 }, Math.PI - 0.1);
    cop1.aiMode = 'shot';
    cop2.aiMode = 'shot';
    cop1.vel.set(0, 0, 0);
    cop2.vel.set(0, 0, 0);
    cop1.speed = 36;
    cop2.speed = 35;
    cop1.sirenActive = true;
    cop2.sirenActive = true;

    // Oncoming and ahead-of traffic sharing the boulevard lanes.
    vehicles.spawnVehicle('taxi', palmettoX - 3.6, -12, 0, { aiMode: 'traffic', laneAxis: 'z', laneDir: 1, laneCoord: palmettoX - 3.6, speed: 14 });
    vehicles.spawnVehicle('sedan', palmettoX + 3.6, -24, Math.PI, { color: 0x3b6f8c, aiMode: 'traffic', laneAxis: 'z', laneDir: -1, laneCoord: palmettoX + 3.6, speed: 15 });
    vehicles.spawnVehicle('van', palmettoX - 3.6, -42, 0, { color: 0xe6e2d8, aiMode: 'traffic', laneAxis: 'z', laneDir: 1, laneCoord: palmettoX - 3.6, speed: 12 });

    police.setStars(3);
    missions.activeMission = MISSION_DEFS[1];
    missions.objectiveTag = 'HOT CORAL · PURSUIT';
    missions.objectiveText = 'Lose Meridian PD along Palmetto Strip';
    missions.objectivePos.set(CITY.garagePos.x, 0, CITY.garagePos.z);
    missions.dialogueSpeaker = '';
    missions.dialogueText = '';

    // Pedestrians on the flanking sidewalks.
    peds.placePedestrian(0, palmettoX + 10.2, 8, Math.PI, 0, -1);
    peds.placePedestrian(1, palmettoX + 11.4, -4, 0, 0, 1);
    peds.placePedestrian(2, palmettoX - 10.6, 12, Math.PI, 0, -1);

    // Hero chase camera: low and ahead of the car, looking back down the boulevard, so the car sits
    // in the lower third with both flashing cruisers and the palm line behind it.
    player.cameraOverride = {
      position: new THREE.Vector3(palmettoX - 1.2, 2.05, carZ - 10.5),
      lookAt: new THREE.Vector3(palmettoX + 2.2, 2.6, carZ + 16),
      fov: 62,
    };
    return { simDriver: 'chase' };
  }

  if (shotName === 'street') {
    // Rico on foot on the crowded Palmetto Strip sidewalk: storefronts and neon, traffic passing,
    // and a police cruiser sitting on the kerb watching the Strip.
    player.vehicle = null;
    player.mesh.visible = true;
    player.pos.set(palmettoX - 10.2, 0.22, -22);
    player.heading = 0.25;
    player.camYaw = 0.25;
    player.money = 2140;

    // Sidewalk crowd around Rico: [x, z, heading, driftX, driftZ].
    const crowd = [
      [palmettoX - 11.6, -15, Math.PI, 0, -1],
      [palmettoX - 9.4, -10, 0, 0, 1],
      [palmettoX - 12.2, -4, Math.PI, 0, -1],
      [palmettoX - 9.6, -29, 0, 0, 1],
      [palmettoX + 10.2, -14, Math.PI, 0, -1],
      [palmettoX + 11.4, -25, 0, 0, 1],
      [palmettoX - 11.2, 4, Math.PI, 0, -1],
    ];
    crowd.forEach(([x, z, heading, dx, dz], i) => peds.placePedestrian(i, x, z, heading, dx, dz));

    vehicles.spawnVehicle('taxi', palmettoX - 3.6, -16, 0, { aiMode: 'traffic', laneAxis: 'z', laneDir: 1, laneCoord: palmettoX - 3.6, speed: 12 });
    vehicles.spawnVehicle('convertible', palmettoX + 3.6, -8, Math.PI, { color: 0x23e0d6, aiMode: 'traffic', laneAxis: 'z', laneDir: -1, laneCoord: palmettoX + 3.6, speed: 14 });
    vehicles.spawnVehicle('pickup', palmettoX - 3.6, -38, 0, { color: 0xb8382c, aiMode: 'traffic', laneAxis: 'z', laneDir: 1, laneCoord: palmettoX - 3.6, speed: 13 });
    const watchCop = vehicles.spawnVehicle('police', palmettoX + 5.8, -28, Math.PI + 0.14, { aiMode: 'parked', sirenActive: false });
    police.pursuitCars.push(watchCop);

    missions.objectiveTag = 'PALMETTO STRIP';
    missions.objectiveText = 'Meet Tessa Marlow outside Hotel Palmetto';
    missions.objectivePos.set(CITY.fixerPos.x, 0, CITY.fixerPos.z);
    missions.dialogueSpeaker = 'TESSA MARLOW';
    missions.dialogueText = 'Keep your head down, Rico. MPD cruiser is watching the Strip — meet me by the awning.';

    player.mesh.position.copy(player.pos);
    player.mesh.rotation.y = player.heading;
    player.parts.armR.rotation.x = 0.25;

    // Storefront dressing. The HOTEL PALMETTO fascia and awning go on the south facade of the
    // building across the cross street (it faces the camera square-on); a vertical neon blade
    // projects from the near facade so it reads along the sidewalk.
    const tex = ctx.textures || {};
    const signs = tex.signs || [];
    const facing = Math.PI; // plane normal toward -z, i.e. toward the camera
    const across = city.colliders.find((c) => c.minX < palmettoX - 21 && c.maxX > palmettoX - 21 && c.minZ > 4 && c.minZ < 30);
    const frontZ = across ? across.minZ - 0.12 : 14.5;
    // Only ~8 m of that facade clears the near building, so the fascia is sized and centred to sit
    // inside that visible window.
    const frontX = across ? across.maxX - 3.9 : palmettoX - 20;
    const storefrontMat = new THREE.MeshBasicMaterial({ map: tex.storefront || signs[0], toneMapped: false });
    const storefront = new THREE.Mesh(new THREE.PlaneGeometry(6.9, 2.0), storefrontMat);
    storefront.position.set(frontX, 4.7, frontZ);
    storefront.rotation.y = facing;

    const awning = new THREE.Mesh(
      new THREE.BoxGeometry(7.2, 0.22, 2.4),
      new THREE.MeshLambertMaterial({ map: tex.awning || null, color: tex.awning ? 0xffffff : 0x2fc6c8 }),
    );
    awning.position.set(frontX, 3.05, frontZ - 1.1);
    awning.rotation.set(-0.3, 0, 0);

    const near = city.colliders.find((c) => c.minZ < -18 && c.maxZ > -18 && c.maxX > palmettoX - 22 && c.maxX < palmettoX - 8);
    const nearX = near ? near.maxX : palmettoX - 14.6;
    const bladeMat = new THREE.MeshBasicMaterial({ map: tex.neonBlade || signs[1], toneMapped: false, side: THREE.DoubleSide });
    const blade = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 4.8), bladeMat);
    blade.position.set(nearX + 1.6, 6.2, -18);
    blade.rotation.y = facing;

    const bladeArm = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.12, 0.12), new THREE.MeshLambertMaterial({ color: 0x2a2d36 }));
    bladeArm.position.set(nearX + 1.0, 8.75, -18);
    city.group.add(storefront, awning, blade, bladeArm);

    player.cameraOverride = {
      position: new THREE.Vector3(palmettoX - 10.3, 2.55, -28.6),
      lookAt: new THREE.Vector3(palmettoX - 5.4, 3.1, -12.0),
      fov: 60,
    };
    return { simDriver: 'street' };
  }

  if (shotName === 'drive') {
    // Stolen convertible cruising down the coastal highway: ocean, surf and pier on the right,
    // neon hotels and palms on the left.
    const car = vehicles.spawnVehicle('convertible', coastalX + 2.8, 42, Math.PI, {
      color: 0xff5c4d,
      aiMode: 'shot',
      speed: 41,
    });
    car.vel.set(0, 0, 0);
    player.vehicle = car;
    player.mesh.visible = false;
    player.pos.copy(car.pos);
    player.heading = car.heading;
    player.money = 4720;

    vehicles.spawnVehicle('sedan', coastalX - 3.6, -6, 0, { color: 0xd9d2c5, aiMode: 'traffic', laneAxis: 'z', laneDir: 1, laneCoord: coastalX - 3.6, speed: 16 });
    vehicles.spawnVehicle('sports', coastalX + 3.6, -24, Math.PI, { color: 0x16d2d8, aiMode: 'traffic', laneAxis: 'z', laneDir: -1, laneCoord: coastalX + 3.6, speed: 20 });

    missions.activeMission = MISSION_DEFS[0];
    missions.objectiveTag = 'SUNSET COURIER';
    missions.objectiveText = 'Deliver the ledger to Marisol Marina';
    missions.objectivePos.set(196, 0, -140);
    missions.dialogueSpeaker = '';
    missions.dialogueText = '';

    // Right-rear chase framing, swung toward the shore so the beach, surf line, pier and open sea
    // fill the right third while neon hotels and palms frame the left.
    player.cameraOverride = {
      position: new THREE.Vector3(coastalX + 9.6, 3.9, 53.0),
      lookAt: new THREE.Vector3(coastalX + 13.5, 0.9, 20.0),
      fov: 70,
    };
    return { simDriver: 'drive' };
  }

  if (shotName === 'mission') {
    // Dockside shootout at the Pier 4 freight yard: muzzle flashes, live tracers, two officers
    // behind container cover, the crew objective reading 2/5, depleted health and a dialogue box.
    const bx = 105;
    const bz = 175;
    player.vehicle = null;
    player.mesh.visible = true;
    player.pos.set(bx - 11.5, 0.22, bz + 16.5);
    player.heading = 0.62;
    player.camYaw = 0.62;
    player.aiming = true;
    player.health = 62;
    player.armour = 45;
    player.money = 5180;
    player.weaponsState[0].mag = 9;
    player.weaponsState[0].reserve = 78;

    vehicles.spawnVehicle('sports', bx - 19, bz + 21, 0.5, { color: 0x16d2d8, aiMode: 'parked' });
    const dockCopCar = police.spawnPursuitCruiser(player.pos, { x: bx + 16, z: bz + 22 }, -0.85);
    dockCopCar.speed = 0;
    dockCopCar.aiMode = 'parked';
    dockCopCar.sirenActive = true;

    // Two crew down, three still fighting.
    missions.activeMission = MISSION_DEFS[2];
    missions.objectiveTag = 'PIER 4 RECKONING';
    missions.objectivePos.set(bx, 0, bz + 4);
    missions.objectiveMarker.group.position.set(bx, 0, bz + 4);
    missions.objectiveMarker.group.visible = true;

    const e1 = missions.spawnEnemy(bx - 8.5, bz + 2.2, { alive: false });
    const e2 = missions.spawnEnemy(bx + 12.2, bz - 1.5, { alive: false });
    const e3 = missions.spawnEnemy(bx - 2.5, bz + 11.5, { alive: true });
    const e4 = missions.spawnEnemy(bx + 7.8, bz + 3.2, { alive: true });
    const e5 = missions.spawnEnemy(bx + 1.5, bz - 4.5, { alive: true });
    for (const enemy of [e3, e4, e5]) {
      enemy.heading = Math.atan2(player.pos.x - enemy.pos.x, player.pos.z - enemy.pos.z);
      enemy.mesh.rotation.y = enemy.heading;
    }
    missions.updateShootoutText();

    // Two MPD officers taking cover behind the dock containers.
    const off1 = police.spawnOfficer(bx - 9.2, bz + 5.8, { inCover: true });
    const off2 = police.spawnOfficer(bx + 8.5, bz + 6.8, { inCover: true });
    for (const officer of [off1, off2]) {
      officer.heading = Math.atan2(player.pos.x - officer.pos.x, player.pos.z - officer.pos.z);
      officer.mesh.rotation.y = officer.heading;
    }

    police.setStars(2);
    missions.showDialogue('TESSA MARLOW', 'Two down, Rico — watch the crossfire! Meridian PD just rolled in behind those blue containers.', 12);

    // Live gunfight VFX: player muzzle flash and outgoing tracer, incoming enemy and cop tracers.
    const pMuzzle = new THREE.Vector3(player.pos.x + 0.65, player.pos.y + 1.42, player.pos.z - 0.55);
    combat.spawnMuzzleFlash(pMuzzle, 1.9);
    combat.spawnTracer(pMuzzle, new THREE.Vector3(e4.pos.x, 1.45, e4.pos.z), 0xffe48a, 0.9);
    combat.spawnImpactSpark(new THREE.Vector3(e4.pos.x - 0.2, 1.45, e4.pos.z), 0xffb858);

    const e3Muzzle = new THREE.Vector3(e3.pos.x - 0.4, 1.38, e3.pos.z + 0.45);
    combat.spawnMuzzleFlash(e3Muzzle, 1.65);
    combat.spawnTracer(e3Muzzle, new THREE.Vector3(player.pos.x + 1.4, 1.55, player.pos.z - 0.8), 0xff6e48, 0.9);

    const off1Muzzle = new THREE.Vector3(off1.pos.x - 0.2, 1.38, off1.pos.z + 0.5);
    combat.spawnMuzzleFlash(off1Muzzle, 1.55);
    combat.spawnTracer(off1Muzzle, new THREE.Vector3(player.pos.x - 1.1, 1.25, player.pos.z + 0.5), 0x70d8ff, 0.9);
    combat.damageFlash = 0.28;

    // Pose Rico aiming toward the Pier 4 gunmen.
    player.mesh.position.copy(player.pos);
    player.mesh.rotation.y = player.heading;
    player.parts.armR.rotation.x = -1.45;

    player.cameraOverride = {
      position: new THREE.Vector3(bx - 15.2, 2.75, bz + 21.8),
      lookAt: new THREE.Vector3(bx + 1.5, 1.7, bz + 5.5),
      fov: 62,
    };
    return { simDriver: 'mission', anchor: { bx, bz, e3, e4, off1, off2 } };
  }

  // Unknown shot name: fall back to a plain atmosphere update around the player.
  renderRig.updateAtmosphere(player.pos);
  return { simDriver: 'default' };
}

// Advance a shot by `dt` without going through the normal vehicle/pedestrian integrators, so the
// framing stays exactly where setupShotScene() put it while traffic and VFX keep moving.
export function stepShotScene(shotInfo, dt, ctx) {
  const { player, police, combat } = ctx;
  if (!shotInfo) return;

  if (shotInfo.simDriver === 'chase' && player.vehicle) {
    const v = player.vehicle;
    v.speed = 38;
    v.vel.set(0, 0, 0);
    const dz = -v.speed * dt;
    v.pos.z += dz;
    if (v.pos.z < -150) {
      v.pos.z += LOOP_WRAP;
      for (const c of police.pursuitCars) c.pos.z += LOOP_WRAP;
      if (player.cameraOverride) {
        player.cameraOverride.position.z += LOOP_WRAP;
        player.cameraOverride.lookAt.z += LOOP_WRAP;
      }
    }
    player.pos.copy(v.pos);
    v.wheelSpin += Math.abs(dz) / 0.36;
    v.mesh.position.set(v.pos.x, 0.04, v.pos.z);

    for (const c of police.pursuitCars) {
      // Cruisers trail at a slightly slower rate so they hold station rather than clipping the car.
      c.pos.z += dz * 0.992;
      c.speed = 37;
      c.vel.set(0, 0, 0);
      c.sirenActive = true;
      c.wheelSpin += Math.abs(dz) / 0.36;
      c.mesh.position.set(c.pos.x, 0.04, c.pos.z);
    }
    if (player.cameraOverride) {
      player.cameraOverride.position.z += dz;
      player.cameraOverride.lookAt.z += dz;
    }
    return;
  }

  if (shotInfo.simDriver === 'drive' && player.vehicle) {
    const v = player.vehicle;
    v.speed = 41;
    v.vel.set(0, 0, 0);
    const dz = -v.speed * dt;
    v.pos.z += dz;
    if (v.pos.z < -150) {
      v.pos.z += LOOP_WRAP;
      if (player.cameraOverride) {
        player.cameraOverride.position.z += LOOP_WRAP;
        player.cameraOverride.lookAt.z += LOOP_WRAP;
      }
    }
    player.pos.copy(v.pos);
    v.wheelSpin += Math.abs(dz) / 0.36;
    v.mesh.position.set(v.pos.x, 0.04, v.pos.z);
    if (player.cameraOverride) {
      player.cameraOverride.position.z += dz;
      player.cameraOverride.lookAt.z += dz;
    }
    return;
  }

  if (shotInfo.simDriver === 'mission' && shotInfo.anchor) {
    // Keep the gunfire alive across arbitrary &t= advances: tracers expire after a fraction of a
    // second, so re-seed a salvo whenever fewer than two are left in flight.
    if (combat.tracers.length < 2) {
      const { e3, e4, off1 } = shotInfo.anchor;
      const pMuzzle = new THREE.Vector3(player.pos.x + 0.65, player.pos.y + 1.42, player.pos.z - 0.55);
      combat.spawnMuzzleFlash(pMuzzle, 1.85);
      combat.spawnTracer(pMuzzle, new THREE.Vector3(e4.pos.x, 1.45, e4.pos.z), 0xffe48a, 0.45);
      combat.spawnImpactSpark(new THREE.Vector3(e4.pos.x - 0.2, 1.45, e4.pos.z), 0xffb858);

      const e3Muzzle = new THREE.Vector3(e3.pos.x - 0.4, 1.38, e3.pos.z + 0.45);
      combat.spawnMuzzleFlash(e3Muzzle, 1.6);
      combat.spawnTracer(e3Muzzle, new THREE.Vector3(player.pos.x + 1.4, 1.55, player.pos.z - 0.8), 0xff6e48, 0.45);

      const off1Muzzle = new THREE.Vector3(off1.pos.x - 0.2, 1.38, off1.pos.z + 0.5);
      combat.spawnMuzzleFlash(off1Muzzle, 1.5);
      combat.spawnTracer(off1Muzzle, new THREE.Vector3(player.pos.x - 1.1, 1.25, player.pos.z + 0.5), 0x70d8ff, 0.45);
    }
  }
}
