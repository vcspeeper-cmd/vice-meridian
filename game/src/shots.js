import * as THREE from 'three';
import { CITY } from './config.js';
import { MISSION_DEFS } from './missions.js';

export function setupShotScene(shotName, ctx) {
  const { city, vehicles, peds, player, police, combat, missions, renderRig } = ctx;
  // Validate context has required modules before proceeding.
  if (!city || !vehicles || !peds || !player || !police || !missions) {
    console.error('setupShotScene: incomplete context');
    return null;
  }

  // Reset dynamic entities cleanly before building the deterministic shot.
  // Each shot starts from a clean slate so the frame is reproducible.
  police.resetWanted();
  missions.clearEnemies();
  player.health = 100;
  player.armour = 100;
  player.money = 3480;
  player.deadTimer = 0;

  // Road coordinates reference:
  // roadCentersX = [-210, -140, -70, 0, 70, 140, 210]
  // roadCentersZ = [-210, -140, -70, 0, 70, 140, 210]
  const palmettoX = 140;
  const coastalX = CITY.coastalRoadX; // 210

  if (shotName === 'chase') {
    // Cover shot: Vantablack GT speeding north along palm-lined Palmetto Strip at golden hour
    // Two police cruisers close behind with flashing lights, 3 wanted stars, traffic ahead, skyline & sun flare
    const car = vehicles.spawnVehicle('sports', palmettoX + 2.4, 24, Math.PI, {
      color: 0xff3a5e,
      aiMode: 'shot',
      speed: 38,
    });
    car.vel.set(0, 0, 0);
    player.vehicle = car;
    player.mesh.visible = false;
    player.pos.copy(car.pos);
    player.heading = car.heading;

    // Two pursuing MPD cruisers right behind in staggered formation
    const cop1 = police.spawnPursuitCruiser(car.pos, { x: palmettoX + 5.1, z: 36.5 }, Math.PI + 0.08);
    const cop2 = police.spawnPursuitCruiser(car.pos, { x: palmettoX - 2.6, z: 42.5 }, Math.PI - 0.1);
    cop1.aiMode = 'shot';
    cop2.aiMode = 'shot';
    cop1.vel.set(0, 0, 0);
    cop2.vel.set(0, 0, 0);
    cop1.speed = 36;
    cop2.speed = 35;
    cop1.sirenActive = true;
    cop2.sirenActive = true;

    // Oncoming & ahead boulevard traffic
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

    // Pedestrians on the flanking sidewalks
    peds.placePedestrian(0, palmettoX + 10.2, 8, Math.PI, 0, -1);
    peds.placePedestrian(1, palmettoX + 11.4, -4, 0, 0, 1);
    peds.placePedestrian(2, palmettoX - 10.6, 12, Math.PI, 0, -1);

    // Hero chase camera: low, ahead of the Vantablack and looking back down the boulevard, so
    // the car sits in the lower third with both flashing cruisers and the palm line behind it.
    player.cameraOverride = {
      position: new THREE.Vector3(palmettoX - 1.2, 2.05, 24 - 10.5),
      lookAt: new THREE.Vector3(palmettoX + 2.2, 2.6, 24 + 16),
      fov: 62,
    };
    return { simDriver: 'chase' };
  }

  if (shotName === 'street') {
    // Player on foot on crowded Palmetto Strip sidewalk, storefronts & neon signs, traffic passing, police cruiser watching
    player.vehicle = null;
    player.mesh.visible = true;
    player.pos.set(palmettoX - 10.2, 0.22, -22);
    player.heading = 0.25;
    player.camYaw = 0.25;
    player.money = 2140;

    // Populate sidewalk crowd around Rico
    const crowd = [
      [palmettoX - 11.6, -15, Math.PI, 0, -1],
      [palmettoX - 9.4, -10, 0, 0, 1],
      [palmettoX - 12.2, -4, Math.PI, 0, -1],
      [palmettoX - 9.6, -29, 0, 0, 1],
      [palmettoX + 10.2, -14, Math.PI, 0, -1],
      [palmettoX + 11.4, -25, 0, 0, 1],
      [palmettoX - 11.2, 4, Math.PI, 0, -1],
    ];
    crowd.forEach(([x, z, h, dx, dz], i) => peds.placePedestrian(i, x, z, h, dx, dz));

    // Passing traffic + parked sports car + watching police cruiser
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

    // Place player mesh on foot properly
    player.mesh.position.copy(player.pos);
    player.mesh.rotation.y = player.heading;
    player.parts.armR.rotation.x = 0.25;

    // Storefront dressing for the hero frame. The "HOTEL PALMETTO" fascia + awning go on the
    // south facade of the building across the cross street (it faces the camera square-on);
    // a vertical neon blade sign projects from the near facade so it reads along the sidewalk.
    const tex = ctx.textures || {};
    const facing = Math.PI; // plane normal toward -z, i.e. toward the camera
    const across = city.colliders.find((c) => c.minX < palmettoX - 21 && c.maxX > palmettoX - 21 && c.minZ > 4 && c.minZ < 30);
    const frontZ = across ? across.minZ - 0.12 : 14.5;
    // Only ~8 m of that facade (nearest the road) is visible past the near building, so the
    // fascia is sized and centred to sit inside that window.
    const frontX = across ? across.maxX - 3.9 : palmettoX - 20;
    const storefrontMat = new THREE.MeshBasicMaterial({ map: tex.storefront || tex.signs[0], toneMapped: false });
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
    const bladeMat = new THREE.MeshBasicMaterial({ map: tex.neonBlade || tex.signs[1], toneMapped: false, side: THREE.DoubleSide });
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
    // Stolen convertible cruising south-to-north on the coastal highway: ocean & beach on right, neon city & palms on left
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

    // Coastal highway traffic ahead
    vehicles.spawnVehicle('sedan', coastalX - 3.6, -6, 0, { color: 0xd9d2c5, aiMode: 'traffic', laneAxis: 'z', laneDir: 1, laneCoord: coastalX - 3.6, speed: 16 });
    vehicles.spawnVehicle('sports', coastalX + 3.6, -24, Math.PI, { color: 0x16d2d8, aiMode: 'traffic', laneAxis: 'z', laneDir: -1, laneCoord: coastalX + 3.6, speed: 20 });

    missions.activeMission = MISSION_DEFS[0];
    missions.objectiveTag = 'SUNSET COURIER';
    missions.objectiveText = 'Deliver the ledger to Marisol Marina';
    missions.objectivePos.set(196, 0, -140);
    missions.dialogueSpeaker = '';
    missions.dialogueText = '';

    // Right-rear chase framing, swung toward the shore so the beach, the surf line, the pier
    // and open sea fill the right third while neon hotels and palms frame the left.
    player.cameraOverride = {
      position: new THREE.Vector3(coastalX + 9.6, 3.9, 53.0),
      lookAt: new THREE.Vector3(coastalX + 13.5, 0.9, 20.0),
      fov: 70,
    };
    return { simDriver: 'drive' };
  }

  if (shotName === 'mission') {
    // Dockside shootout in progress at Pier 4 Freight yard:
    // Muzzle flash, active tracers, two officers behind shipping container cover, objective "Eliminate Bishop's crew 2/5",
    // dialogue box with name plate, partially depleted health, minimap showing objective.
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

    // Parked getaway car & responding police cruiser near dock gates
    vehicles.spawnVehicle('sports', bx - 19, bz + 21, 0.5, { color: 0x16d2d8, aiMode: 'parked' });
    const dockCopCar = police.spawnPursuitCruiser(player.pos, { x: bx + 16, z: bz + 22 }, -0.85);
    dockCopCar.speed = 0;
    dockCopCar.aiMode = 'parked';
    dockCopCar.sirenActive = true;

    // Start Pier 4 shootout with 2 crew down, 3 still fighting (reads "Eliminate Bishop's crew 2/5")
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
    e3.heading = Math.atan2(player.pos.x - e3.pos.x, player.pos.z - e3.pos.z);
    e4.heading = Math.atan2(player.pos.x - e4.pos.x, player.pos.z - e4.pos.z);
    e5.heading = Math.atan2(player.pos.x - e5.pos.x, player.pos.z - e5.pos.z);
    e3.mesh.rotation.y = e3.heading;
    e4.mesh.rotation.y = e4.heading;
    e5.mesh.rotation.y = e5.heading;
    missions.updateShootoutText();

    // Two MPD officers taking cover behind the dock containers
    const off1 = police.spawnOfficer(bx - 9.2, bz + 5.8, { inCover: true });
    const off2 = police.spawnOfficer(bx + 8.5, bz + 6.8, { inCover: true });
    off1.heading = Math.atan2(player.pos.x - off1.pos.x, player.pos.z - off1.pos.z);
    off2.heading = Math.atan2(player.pos.x - off2.pos.x, player.pos.z - off2.pos.z);
    off1.mesh.rotation.y = off1.heading;
    off2.mesh.rotation.y = off2.heading;

    police.setStars(2);
    missions.showDialogue('TESSA MARLOW', "Two down, Rico — watch the crossfire! Meridian PD just rolled in behind those blue containers.", 12);

    // Live gunfight VFX: player muzzle flash + outgoing tracer + incoming enemy & cop tracers + sparks
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

    // Pose Rico aiming toward Pier 4 gunmen
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

  // Fallback for unknown shot names: default to chase view
  renderRig.updateAtmosphere(player.pos);
  return { simDriver: 'default' };
}

export function stepShotScene(shotInfo, dt, ctx) {
  const { player, vehicles, police, combat } = ctx;
  if (!shotInfo) return;

  if (shotInfo.simDriver === 'chase' && player.vehicle) {
    // Advance hero car & police cruisers down Palmetto Strip without double-integrating via vehicles.update
    const v = player.vehicle;
    const speed = 38;
    v.speed = speed;
    v.vel.set(0, 0, 0);
    const dz = -speed * dt;
    v.pos.z += dz;
    if (v.pos.z < -150) {
      const wrap = 220;
      v.pos.z += wrap;
      for (const c of police.pursuitCars) c.pos.z += wrap;
      if (player.cameraOverride) {
        player.cameraOverride.position.z += wrap;
        player.cameraOverride.lookAt.z += wrap;
      }
    }
    player.pos.copy(v.pos);
    v.wheelSpin += Math.abs(dz) / 0.36;
    v.mesh.position.set(v.pos.x, 0.04, v.pos.z);

    for (const c of police.pursuitCars) {
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
  } else if (shotInfo.simDriver === 'drive' && player.vehicle) {
    const v = player.vehicle;
    const speed = 41;
    v.speed = speed;
    v.vel.set(0, 0, 0);
    const dz = -speed * dt;
    v.pos.z += dz;
    if (v.pos.z < -150) {
      const wrap = 220;
      v.pos.z += wrap;
      if (player.cameraOverride) {
        player.cameraOverride.position.z += wrap;
        player.cameraOverride.lookAt.z += wrap;
      }
    }
    player.pos.copy(v.pos);
    v.wheelSpin += Math.abs(dz) / 0.36;
    v.mesh.position.set(v.pos.x, 0.04, v.pos.z);
    if (player.cameraOverride) {
      player.cameraOverride.position.z += dz;
      player.cameraOverride.lookAt.z += dz;
    }
  } else if (shotInfo.simDriver === 'mission' && shotInfo.anchor) {
    // Keep gunfire tracers & muzzle flashes fresh across arbitrary &t= advances
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
