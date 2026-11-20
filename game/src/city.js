import * as THREE from 'three';
import { CITY, CITY_GEN, PALETTE } from './config.js';

// --- District planner --------------------------------------------------------------------------
// Every main-grid block belongs to one district. The rules are positional (no RNG), so the plan
// is identical for every seed and other systems can ask "what district is this?" in O(1).
export function planDistrict(col, row) {
  if (col === CITY.gridCols - 1) return 'waterfront';
  if (row === CITY.gridRows - 1 && col >= 2) return 'industrial';
  if (col >= 1 && col <= 3 && row >= 1 && row <= 3) return 'downtown';
  return 'residential';
}

// --- Uniform-grid spatial index ----------------------------------------------------------------
// Axis-aligned boxes are bucketed into square cells. A query visits only the cells under the
// probe circle, so a collision test touches a handful of boxes instead of all of them. Candidate
// indices come back sorted ascending, which keeps "first hit wins" resolution identical to a
// linear scan over the original array.
export class ColliderGrid {
  constructor(cellSize = 24) {
    this.cellSize = cellSize;
    this.cells = new Map();
    this.items = [];
    this._stamp = new Uint32Array(0);
    this._query = 0;
    this._out = [];
  }

  _key(cx, cz) {
    // Pack two signed 16-bit cell coordinates into one integer key.
    return ((cx + 32768) << 16) | (cz + 32768);
  }

  insert(index, box) {
    this.items[index] = box;
    const cs = this.cellSize;
    const x0 = Math.floor(box.minX / cs);
    const x1 = Math.floor(box.maxX / cs);
    const z0 = Math.floor(box.minZ / cs);
    const z1 = Math.floor(box.maxZ / cs);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const key = this._key(cx, cz);
        let list = this.cells.get(key);
        if (!list) {
          list = [];
          this.cells.set(key, list);
        }
        list.push(index);
      }
    }
  }

  build(boxes) {
    this.cells.clear();
    this.items = [];
    for (let i = 0; i < boxes.length; i++) this.insert(i, boxes[i]);
    // One stamp slot per box; queries bump a counter instead of clearing the array.
    this._stamp = new Uint32Array(boxes.length);
    this._query = 0;
  }

  // Indices of every box whose cells overlap the circle (x, z, r). Reuses one output array, so
  // callers must consume it before the next query.
  query(x, z, r) {
    const out = this._out;
    out.length = 0;
    if (this._stamp.length < this.items.length) this._stamp = new Uint32Array(this.items.length);
    this._query = (this._query + 1) >>> 0 || 1;
    const stamp = this._query;
    const cs = this.cellSize;
    const x0 = Math.floor((x - r) / cs);
    const x1 = Math.floor((x + r) / cs);
    const z0 = Math.floor((z - r) / cs);
    const z1 = Math.floor((z + r) / cs);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const list = this.cells.get(this._key(cx, cz));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const idx = list[i];
          if (this._stamp[idx] === stamp) continue;
          this._stamp[idx] = stamp;
          out.push(idx);
        }
      }
    }
    if (out.length > 1) out.sort((a, b) => a - b);
    return out;
  }

  stats() {
    let maxPerCell = 0;
    let total = 0;
    for (const list of this.cells.values()) {
      if (list.length > maxPerCell) maxPerCell = list.length;
      total += list.length;
    }
    return {
      cells: this.cells.size,
      items: this.items.length,
      maxPerCell,
      avgPerCell: this.cells.size ? total / this.cells.size : 0,
    };
  }
}

// --- Road graph ------------------------------------------------------------------------------
// Nodes are every intersection of both grids plus the T-junctions where the annex's offset
// east-west streets meet the western boulevard. Edges follow paved road segments and carry
// their length as cost. Police A* (police.js) runs over this graph.
export function buildRoadGraph(roadCentersX, roadCentersZ, annex) {
  const nodes = [];
  const adj = [];
  const byKey = new Map();

  const addNode = (x, z, kind, col, row) => {
    const key = `${Math.round(x * 10)},${Math.round(z * 10)}`;
    const existing = byKey.get(key);
    if (existing !== undefined) return existing;
    const id = nodes.length;
    nodes.push({ id, x, z, kind, col, row });
    adj.push([]);
    byKey.set(key, id);
    return id;
  };

  const link = (a, b) => {
    if (a === b || a === undefined || b === undefined) return;
    if (adj[a].some((edge) => edge.to === b)) return;
    const cost = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].z - nodes[b].z);
    adj[a].push({ to: b, cost });
    adj[b].push({ to: a, cost });
  };

  const main = [];
  for (let c = 0; c < roadCentersX.length; c++) {
    const column = [];
    main.push(column);
    for (let r = 0; r < roadCentersZ.length; r++) {
      column.push(addNode(roadCentersX[c], roadCentersZ[r], 'main', c, r));
    }
  }
  for (let c = 0; c < roadCentersX.length; c++) {
    for (let r = 0; r < roadCentersZ.length; r++) {
      if (c + 1 < roadCentersX.length) link(main[c][r], main[c + 1][r]);
      if (r + 1 < roadCentersZ.length) link(main[c][r], main[c][r + 1]);
    }
  }

  if (annex) {
    const an = [];
    for (let c = 0; c < annex.roadX.length; c++) {
      const column = [];
      an.push(column);
      for (let r = 0; r < annex.roadZ.length; r++) {
        column.push(addNode(annex.roadX[c], annex.roadZ[r], 'annex', c, r));
      }
    }
    for (let c = 0; c < annex.roadX.length; c++) {
      for (let r = 0; r < annex.roadZ.length; r++) {
        if (c + 1 < annex.roadX.length) link(an[c][r], an[c + 1][r]);
        if (r + 1 < annex.roadZ.length) link(an[c][r], an[c][r + 1]);
      }
    }
    // T-junctions on the western boulevard (main column 0). Each annex street meets the
    // boulevard between two main-grid rows, so it links to both neighbouring intersections.
    const westX = roadCentersX[0];
    for (let r = 0; r < annex.roadZ.length; r++) {
      const z = annex.roadZ[r];
      const junction = addNode(westX, z, 'junction', 0, r + 0.5);
      link(junction, an[0][r]);
      for (let mr = 0; mr < roadCentersZ.length - 1; mr++) {
        if (z > roadCentersZ[mr] && z < roadCentersZ[mr + 1]) {
          link(junction, main[0][mr]);
          link(junction, main[0][mr + 1]);
        }
      }
    }
  }

  const nearest = (x, z) => {
    let best = 0;
    let bestDist = Infinity;
    for (const node of nodes) {
      const d = (node.x - x) ** 2 + (node.z - z) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = node.id;
      }
    }
    return nodes[best];
  };

  return { nodes, adj, nearest, neighbours: (id) => adj[id] };
}

export function buildCity(scene, textures, rng) {
  const group = new THREE.Group();
  scene.add(group);

  const pitch = CITY.pitch;
  const cols = CITY.gridCols;
  const rows = CITY.gridRows;
  const startX = -(cols * pitch) * 0.5;
  const startZ = -(rows * pitch) * 0.5;

  const roadCentersX = [];
  const roadCentersZ = [];
  for (let c = 0; c <= cols; c++) roadCentersX.push(startX + c * pitch);
  for (let r = 0; r <= rows; r++) roadCentersZ.push(startZ + r * pitch);

  const colliders = [];
  const blocks = [];
  const intersections = [];
  const sidewalkRects = [];
  const dockCovers = [];

  // West Annex: a second, smaller street grid west of the main lattice. Its east-west streets
  // sit half a pitch off the main grid's, so they meet the western boulevard as staggered
  // T-junctions instead of continuing one uniform lattice.
  const annexRoadX = [startX - pitch, startX - pitch * 2];
  const annexRoadZ = [];
  for (let r = 0; r < rows; r++) annexRoadZ.push(startZ + pitch * 0.5 + r * pitch);
  const annexBlockX = [startX - pitch * 0.5, startX - pitch * 1.5];
  const annexBlockZ = [];
  for (let r = 0; r < annexRoadZ.length - 1; r++) annexBlockZ.push(annexRoadZ[r] + pitch * 0.5);
  const annex = {
    roadX: annexRoadX,
    roadZ: annexRoadZ,
    blockX: annexBlockX,
    blockZ: annexBlockZ,
    minX: annexRoadX[1] - CITY.roadWidth * 0.5,
    maxX: startX - CITY.roadWidth * 0.5,
    minZ: annexRoadZ[0] - CITY.roadWidth * 0.5,
    maxZ: annexRoadZ[annexRoadZ.length - 1] + CITY.roadWidth * 0.5,
    intersections: [],
    sidewalkRects: [],
  };
  const parks = [];
  const pier = {
    z: CITY.pierZ,
    x0: CITY.beachStartX + 6,
    x1: CITY.waterStartX + CITY.pierLength,
    halfW: 3.4,
  };

  // Base ground slab under the urban area. It stops at the shoreline so it never covers the sea.
  const groundMat = new THREE.MeshLambertMaterial({ color: 0x2a2932 });
  const groundWest = -700;
  const groundMesh = new THREE.Mesh(new THREE.PlaneGeometry(CITY.waterStartX - groundWest, 1400), groundMat);
  groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.position.set((CITY.waterStartX + groundWest) * 0.5, -0.08, 0);
  groundMesh.receiveShadow = true;
  group.add(groundMesh);

  // Beach sand strip on the east side, from the boardwalk down to the waterline
  const sandMat = new THREE.MeshLambertMaterial({
    map: textures.sand || null,
    color: textures.sand ? 0xffffff : PALETTE.sand,
  });
  const sandWest = CITY.coastalRoadX + CITY.roadWidth * 0.5;
  const sandEast = CITY.waterStartX + 2.5;
  const sandMesh = new THREE.Mesh(new THREE.PlaneGeometry(sandEast - sandWest, 1400), sandMat);
  sandMesh.rotation.x = -Math.PI / 2;
  sandMesh.position.set((sandEast + sandWest) * 0.5, -0.02, 0);
  sandMesh.receiveShadow = true;
  group.add(sandMesh);

  // Coastal boardwalk promenade separating coastal boulevard from the sand
  const boardMat = new THREE.MeshLambertMaterial({ color: 0xb78b62 });
  const boardwalk = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.24, 520), boardMat);
  boardwalk.position.set(CITY.coastalRoadX + CITY.roadWidth * 0.5 + 3.1, 0.12, 0);
  boardwalk.receiveShadow = true;
  group.add(boardwalk);

  // Ocean water plane (east of beach) + harbor water (south of dockside)
  const waterMat = new THREE.MeshLambertMaterial({
    map: textures.water,
    color: 0x26b2be,
    emissive: 0x093545,
    emissiveIntensity: 0.45,
  });
  const oceanMesh = new THREE.Mesh(new THREE.PlaneGeometry(CITY.waterExtent, 1500), waterMat);
  oceanMesh.rotation.x = -Math.PI / 2;
  oceanMesh.position.set(CITY.waterStartX + CITY.waterExtent * 0.5, -0.25, 0);
  group.add(oceanMesh);

  // Golden sun reflection strip on the ocean surface
  const sunStripMat = new THREE.MeshBasicMaterial({
    color: 0xffb366,
    transparent: true,
    opacity: 0.28,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const sunStrip = new THREE.Mesh(new THREE.PlaneGeometry(360, 48), sunStripMat);
  sunStrip.rotation.x = -Math.PI / 2;
  sunStrip.position.set(CITY.waterStartX + 200, -0.18, -110);
  sunStrip.rotation.z = -0.35;
  group.add(sunStrip);

  // Foam shoreline strip
  const foamMat = new THREE.MeshBasicMaterial({ color: 0xe6fbff, transparent: true, opacity: 0.7 });
  const foamMesh = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 1100), foamMat);
  foamMesh.rotation.x = -Math.PI / 2;
  foamMesh.position.set(CITY.waterStartX + 1.2, -0.14, 0);
  group.add(foamMesh);

  // Road network: instanced straight road segments and intersections
  const roadSegLen = CITY.blockSize;
  const roadW = CITY.roadWidth;

  const nsRoadTex = textures.road.clone();
  nsRoadTex.needsUpdate = true;
  nsRoadTex.repeat.set(1, 3.2);
  const nsRoadMat = new THREE.MeshLambertMaterial({ map: nsRoadTex });

  const ewRoadTex = textures.road.clone();
  ewRoadTex.needsUpdate = true;
  ewRoadTex.repeat.set(1, 3.2);
  const ewRoadMat = new THREE.MeshLambertMaterial({ map: ewRoadTex });

  const interMat = new THREE.MeshLambertMaterial({ map: textures.intersection });

  const nsGeo = new THREE.PlaneGeometry(roadW, roadSegLen);
  nsGeo.rotateX(-Math.PI / 2);
  const nsCount = roadCentersX.length * rows + annexRoadX.length * annexBlockZ.length;
  const nsMesh = new THREE.InstancedMesh(nsGeo, nsRoadMat, nsCount);
  nsMesh.receiveShadow = true;

  const ewGeo = new THREE.PlaneGeometry(roadW, roadSegLen);
  ewGeo.rotateX(-Math.PI / 2);
  ewGeo.rotateY(Math.PI / 2);
  const ewCount = roadCentersZ.length * cols + annexRoadZ.length * annexBlockX.length;
  const ewMesh = new THREE.InstancedMesh(ewGeo, ewRoadMat, ewCount);
  ewMesh.receiveShadow = true;

  const interGeo = new THREE.PlaneGeometry(roadW, roadW);
  interGeo.rotateX(-Math.PI / 2);
  const interCount = roadCentersX.length * roadCentersZ.length + annexRoadX.length * annexRoadZ.length;
  const interMesh = new THREE.InstancedMesh(interGeo, interMat, interCount);
  interMesh.receiveShadow = true;

  const dummy = new THREE.Object3D();
  let idx = 0;

  // North-south segments: one per main-grid column and row, plus the annex columns.
  for (let c = 0; c < roadCentersX.length; c++) {
    for (let r = 0; r < rows; r++) {
      dummy.position.set(roadCentersX[c], 0.02, roadCentersZ[r] + pitch * 0.5);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      nsMesh.setMatrixAt(idx++, dummy.matrix);
    }
  }
  for (const ax of annexRoadX) {
    for (const az of annexBlockZ) {
      dummy.position.set(ax, 0.02, az);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      nsMesh.setMatrixAt(idx++, dummy.matrix);
    }
  }

  // East-west segments: one per main-grid row and column, plus the annex rows.
  idx = 0;
  for (let r = 0; r < roadCentersZ.length; r++) {
    for (let c = 0; c < cols; c++) {
      dummy.position.set(roadCentersX[c] + pitch * 0.5, 0.02, roadCentersZ[r]);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      ewMesh.setMatrixAt(idx++, dummy.matrix);
    }
  }
  for (const az of annexRoadZ) {
    for (const ax of annexBlockX) {
      dummy.position.set(ax, 0.02, az);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      ewMesh.setMatrixAt(idx++, dummy.matrix);
    }
  }

  // Intersection pads for both grids; main pads alternate signal phase in a checkerboard.
  idx = 0;
  for (let c = 0; c < roadCentersX.length; c++) {
    for (let r = 0; r < roadCentersZ.length; r++) {
      const ix = roadCentersX[c];
      const iz = roadCentersZ[r];
      dummy.position.set(ix, 0.03, iz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      interMesh.setMatrixAt(idx++, dummy.matrix);
      intersections.push({
        x: ix,
        z: iz,
        col: c,
        row: r,
        phaseOffset: (c + r) % 2 === 0 ? 0 : 7,
      });
    }
  }
  for (let c = 0; c < annexRoadX.length; c++) {
    for (let r = 0; r < annexRoadZ.length; r++) {
      dummy.position.set(annexRoadX[c], 0.03, annexRoadZ[r]);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      interMesh.setMatrixAt(idx++, dummy.matrix);
      annex.intersections.push({ x: annexRoadX[c], z: annexRoadZ[r], col: c, row: r });
    }
  }
  group.add(nsMesh, ewMesh, interMesh);

  // Sidewalks & raised curbs for each block
  const swMat = new THREE.MeshLambertMaterial({ map: textures.sidewalk });
  const curbMat = new THREE.MeshLambertMaterial({ color: 0x998e80 });
  const swGeo = new THREE.BoxGeometry(CITY.blockSize, 0.22, CITY.blockSize);
  const swMesh = new THREE.InstancedMesh(swGeo, swMat, cols * rows + annexBlockX.length * annexBlockZ.length);
  swMesh.receiveShadow = true;

  // Building instances grouped by facade style so draw calls stay tiny
  const styleBuckets = {
    deco: [],
    glass: [],
    stucco: [],
    warehouse: [],
    motel: [],
    brick: [],
    curtain: [],
  };
  const trimInstances = [];
  const roofInstances = [];
  const palmPositions = [];
  const lampPositions = [];
  const trafficLightPositions = [];
  const signSpecs = [];
  const waterTowers = [];
  const billboards = [];
  const hydrants = [];
  const bins = [];
  const benches = [];
  const canopyTrees = [];
  const parkFeatures = [];
  const roofTops = [];
  const busStops = [];

  let bIdx = 0;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const bx = roadCentersX[c] + pitch * 0.5;
      const bz = roadCentersZ[r] + pitch * 0.5;

      dummy.position.set(bx, 0.11, bz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      swMesh.setMatrixAt(bIdx++, dummy.matrix);

      const blockInfo = {
        col: c,
        row: r,
        x: bx,
        z: bz,
        half: CITY.blockSize * 0.5,
      };
      blocks.push(blockInfo);
      sidewalkRects.push({
        minX: bx - CITY.blockSize * 0.5,
        maxX: bx + CITY.blockSize * 0.5,
        minZ: bz - CITY.blockSize * 0.5,
        maxZ: bz + CITY.blockSize * 0.5,
      });

      const isDockBlock = r === rows - 1 && c >= 2;
      const isCoastalBlock = c === cols - 1;
      const isDowntown = c >= 1 && c <= 3 && r >= 1 && r <= 3;
      const blockDistrict = planDistrict(c, r);
      blockInfo.district = blockDistrict;

      // Palm trees along block edges facing boulevards
      const edgeOff = CITY.blockSize * 0.5 - 2.1;
      for (const offset of [-16, 0, 16]) {
        if (isCoastalBlock || r <= 3 || rng.chance(0.55)) {
          palmPositions.push({
            x: bx + edgeOff,
            z: bz + offset,
            lean: rng.range(-0.14, 0.14),
            h: rng.range(7.2, 11.2),
            rot: rng.range(0, Math.PI * 2),
          });
        }
        if (c === cols - 2 || rng.chance(0.45)) {
          palmPositions.push({
            x: bx - edgeOff,
            z: bz + offset,
            lean: rng.range(-0.14, 0.14),
            h: rng.range(7.0, 10.6),
            rot: rng.range(0, Math.PI * 2),
          });
        }
      }

      // Streetlights at block corners
      const lampOff = CITY.blockSize * 0.5 - 1.2;
      lampPositions.push({ x: bx + lampOff, z: bz + lampOff, rot: Math.PI * 0.75 });
      lampPositions.push({ x: bx - lampOff, z: bz - lampOff, rot: -Math.PI * 0.25 });

      // Traffic lights at alternate corners
      if ((c + r) % 2 === 0) {
        trafficLightPositions.push({ x: bx + lampOff, z: bz - lampOff, rot: 0, interCol: c + 1, interRow: r });
        trafficLightPositions.push({ x: bx - lampOff, z: bz + lampOff, rot: Math.PI, interCol: c, interRow: r + 1 });
      }

      // Street furniture: a hydrant and a trash bin on opposite kerbs, a bench mid-block.
      const kerb = CITY.blockSize * 0.5 - 0.9;
      hydrants.push({ x: bx - kerb, z: bz + 9 + (c % 3) * 2 });
      bins.push({ x: bx + kerb, z: bz - 7 - (r % 3) * 2, rot: 0 });
      if ((c * 3 + r) % 2 === 0) benches.push({ x: bx + 6, z: bz + kerb, rot: 0 });
      // Bus shelters on the south kerb of every third downtown/residential block.
      const wantsBusStop = blockDistrict === 'downtown' || blockDistrict === 'residential';
      const isParkBlock = c === CITY.parkBlock.col && r === CITY.parkBlock.row;
      if (wantsBusStop && (c + r * 2) % CITY_GEN.busStopEvery === 0 && !isParkBlock) {
        busStops.push({ x: bx - 12, z: bz + CITY.blockSize * 0.5 - 1.6, rot: 0 });
      }

      // City park: lawn, crossing footpaths, a fountain and shade trees instead of buildings.
      if (isParkBlock) {
        parks.push({ x: bx, z: bz, half: CITY.blockSize * 0.5 - 3 });
        parkFeatures.push({ x: bx, z: bz });
        colliders.push({ minX: bx - 3.4, maxX: bx + 3.4, minZ: bz - 3.4, maxZ: bz + 3.4, maxY: 1.2 });
        for (let i = 0; i < 10; i++) {
          const angle = (i / 10) * Math.PI * 2 + 0.3;
          const radius = 13 + (i % 3) * 3.5;
          canopyTrees.push({
            x: bx + Math.cos(angle) * radius,
            z: bz + Math.sin(angle) * radius,
            s: rng.range(0.85, 1.3),
          });
        }
        const parkBenches = [
          [-8, 4.2, 0],
          [8, -4.2, Math.PI],
          [4.2, 8, Math.PI / 2],
          [-4.2, -8, -Math.PI / 2],
        ];
        for (const [ox, oz, rot] of parkBenches) {
          benches.push({ x: bx + ox, z: bz + oz, rot });
        }
        continue;
      }

      // Dockside freight yard (open arena for mission shootout with containers + warehouse)
      if (isDockBlock && c === 4) {
        // Leave central yard open for the Pier 4 shootout: warehouse at the north edge and
        // shipping containers scattered as cover.
        const whW = 36;
        const whD = 12;
        const whH = 11;
        const whZ = bz - 15;
        styleBuckets.warehouse.push({
          x: bx,
          y: whH * 0.5 + 0.22,
          z: whZ,
          sx: whW,
          sy: whH,
          sz: whD,
          color: 0x77808a,
        });
        colliders.push({
          minX: bx - whW * 0.5,
          maxX: bx + whW * 0.5,
          minZ: whZ - whD * 0.5,
          maxZ: whZ + whD * 0.5,
          maxY: whH,
        });
        signSpecs.push({ x: bx, y: 7.5, z: whZ + whD * 0.5 + 0.25, rotY: 0, w: 12, h: 3.4, signIndex: 5 });

        const crates = [
          { x: bx - 10, z: bz + 4, w: 7.5, h: 2.8, d: 2.8, color: 0xc24938 },
          { x: bx + 9, z: bz + 5, w: 7.5, h: 2.8, d: 2.8, color: 0x26748a },
          { x: bx - 2, z: bz + 14, w: 8.0, h: 2.8, d: 2.8, color: 0xd98f32 },
          { x: bx + 14, z: bz - 2, w: 2.8, h: 2.8, d: 7.5, color: 0x356978 },
          { x: bx - 15, z: bz + 13, w: 2.8, h: 2.8, d: 7.2, color: 0xa83c34 },
        ];
        for (const crate of crates) {
          dockCovers.push(crate);
          colliders.push({
            minX: crate.x - crate.w * 0.5,
            maxX: crate.x + crate.w * 0.5,
            minZ: crate.z - crate.d * 0.5,
            maxZ: crate.z + crate.d * 0.5,
            maxY: crate.h,
          });
        }
        continue;
      }

      // Garage lot on Caleta/Old Meridian block
      if (c === 1 && r === 3) {
        const gW = 24;
        const gD = 16;
        const gH = 7.5;
        const gx = bx - 7;
        const gz = bz - 10;
        styleBuckets.warehouse.push({
          x: gx,
          y: gH * 0.5 + 0.22,
          z: gz,
          sx: gW,
          sy: gH,
          sz: gD,
          color: 0x626b78,
        });
        colliders.push({
          minX: gx - gW * 0.5,
          maxX: gx + gW * 0.5,
          minZ: gz - gD * 0.5,
          maxZ: gz + gD * 0.5,
          maxY: gH,
        });
        signSpecs.push({ x: gx, y: 6.2, z: gz + gD * 0.5 + 0.25, rotY: 0, w: 10.5, h: 3.0, signIndex: 2 });
        continue;
      }

      // Hospital plaza block
      if (c === 2 && r === 2) {
        const hW = 26;
        const hD = 22;
        const hH = 22;
        const hz = bz - 4;
        styleBuckets.deco.push({
          x: bx,
          y: hH * 0.5 + 0.22,
          z: hz,
          sx: hW,
          sy: hH,
          sz: hD,
          color: 0xf4eee6,
        });
        trimInstances.push({
          x: bx,
          y: hH + 0.45,
          z: hz,
          sx: hW + 0.8,
          sy: 0.7,
          sz: hD + 0.8,
          color: 0xff4558,
        });
        colliders.push({
          minX: bx - hW * 0.5,
          maxX: bx + hW * 0.5,
          minZ: hz - hD * 0.5,
          maxZ: hz + hD * 0.5,
          maxY: hH,
        });
        continue;
      }

      // Subdivide regular block into 2x2 building plots
      const subOffset = 11.2;
      for (let sx = -1; sx <= 1; sx += 2) {
        for (let sz = -1; sz <= 1; sz += 2) {
          const px = bx + sx * subOffset;
          const pz = bz + sz * subOffset;
          // Plots top out below the 22.4 m pitch so every block keeps walkable service alleys.
          const w = rng.range(15.5, CITY.maxPlotSize);
          const d = rng.range(15.5, CITY.maxPlotSize);

          let paletteEntry;
          let h;
          if (isDockBlock) {
            paletteEntry = PALETTE.buildingPalettes[6];
            h = rng.range(8, 15);
          } else if (isCoastalBlock) {
            paletteEntry = rng.pick([
              PALETTE.buildingPalettes[0],
              PALETTE.buildingPalettes[1],
              PALETTE.buildingPalettes[7],
              PALETTE.buildingPalettes[2],
            ]);
            h = rng.range(15, 34);
          } else if (isDowntown) {
            paletteEntry = rng.pick([
              PALETTE.buildingPalettes[2],
              PALETTE.buildingPalettes[3],
              PALETTE.buildingPalettes[0],
            ]);
            h = rng.range(28, 62);
          } else {
            paletteEntry = rng.pick(PALETTE.buildingPalettes);
            h = rng.range(11, 28);
          }

          styleBuckets[paletteEntry.style].push({
            x: px,
            y: h * 0.5 + 0.22,
            z: pz,
            sx: w,
            sy: h,
            sz: d,
            color: paletteEntry.wall,
          });

          // Neon/Art-Deco roofline trim band
          trimInstances.push({
            x: px,
            y: h + 0.45,
            z: pz,
            sx: w + 0.5,
            sy: 0.65,
            sz: d + 0.5,
            color: paletteEntry.trim,
          });

          // Tall towers step back: one or two narrower tiers stacked on the podium.
          let roofTop = h;
          let roofW = w;
          let roofD = d;
          if (h > 30 && paletteEntry.style !== 'warehouse') {
            const tiers = h > 46 ? 2 : 1;
            for (let t = 0; t < tiers; t++) {
              const tw = roofW * rng.range(0.62, 0.78);
              const td = roofD * rng.range(0.62, 0.78);
              const th = h * rng.range(0.18, 0.3);
              const tierStyle = paletteEntry.style === 'glass' ? 'curtain' : paletteEntry.style;
              styleBuckets[tierStyle].push({
                x: px,
                y: roofTop + th * 0.5 + 0.22,
                z: pz,
                sx: tw,
                sy: th,
                sz: td,
                color: paletteEntry.style === 'glass' ? 0xffffff : paletteEntry.wall,
              });
              roofTop += th;
              roofW = tw;
              roofD = td;
              trimInstances.push({
                x: px,
                y: roofTop + 0.4,
                z: pz,
                sx: tw + 0.4,
                sy: 0.55,
                sz: td + 0.4,
                color: paletteEntry.trim,
              });
            }
          } else if (h > 10 && h < 26 && paletteEntry.style !== 'glass' && rng.chance(0.3)) {
            waterTowers.push({ x: px + rng.range(-3, 3), y: h + 0.22, z: pz + rng.range(-3, 3) });
          } else if (
            h > 10 &&
            h < 30 &&
            billboards.length < CITY.maxBillboards &&
            (isCoastalBlock || c === cols - 2) &&
            rng.chance(0.45)
          ) {
            billboards.push({ x: px, y: h + 0.22, z: pz, rotY: Math.PI / 2, signIndex: rng.int(0, 4) });
          }

          // Rooftop penthouse / HVAC box on taller towers
          if (h > 20) {
            roofInstances.push({
              x: px + rng.range(-2, 2),
              y: roofTop + 2.4,
              z: pz + rng.range(-2, 2),
              sx: roofW * 0.44,
              sy: 3.8,
              sz: roofD * 0.44,
              color: 0x3b4454,
            });
          }
          // Remember the final roof footprint for the rooftop prop pass (no RNG draw here, so the
          // main generation stream is untouched).
          roofTops.push({
            x: px,
            z: pz,
            top: roofTop,
            w: roofW,
            d: roofD,
            style: paletteEntry.style,
            district: blockDistrict,
            hasBox: h > 20,
          });

          // Storefront neon signs facing the main boulevards
          if ((isCoastalBlock || c === cols - 2) && sx === 1 && rng.chance(0.75)) {
            signSpecs.push({
              x: px + w * 0.5 + 0.22,
              y: 5.4,
              z: pz,
              rotY: Math.PI / 2,
              w: Math.min(w * 0.72, 11),
              h: 3.0,
              signIndex: rng.int(0, 4),
            });
          } else if (sz === 1 && rng.chance(0.32)) {
            signSpecs.push({
              x: px,
              y: 5.2,
              z: pz + d * 0.5 + 0.22,
              rotY: 0,
              w: Math.min(w * 0.68, 10),
              h: 2.8,
              signIndex: rng.int(0, 4),
            });
          }

          colliders.push({
            minX: px - w * 0.5,
            maxX: px + w * 0.5,
            minZ: pz - d * 0.5,
            maxZ: pz + d * 0.5,
            maxY: h,
          });
        }
      }
    }
  }

  // West Annex blocks: low-rise stucco/motel/deco neighbourhood with a single plot row per side.
  const annexPalettes = [
    PALETTE.buildingPalettes[4],
    PALETTE.buildingPalettes[5],
    PALETTE.buildingPalettes[7],
    PALETTE.buildingPalettes[1],
    { wall: 0xf4e6dc, trim: 0xffb347, style: 'brick' },
    { wall: 0xe6d2c8, trim: 0x30cfd0, style: 'brick' },
  ];
  for (let ci = 0; ci < annexBlockX.length; ci++) {
    for (let ri = 0; ri < annexBlockZ.length; ri++) {
      const bx = annexBlockX[ci];
      const bz = annexBlockZ[ri];
      dummy.position.set(bx, 0.11, bz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      swMesh.setMatrixAt(bIdx++, dummy.matrix);
      const half = CITY.blockSize * 0.5;
      annex.sidewalkRects.push({ minX: bx - half, maxX: bx + half, minZ: bz - half, maxZ: bz + half });
      const lampOff = half - 1.2;
      lampPositions.push({ x: bx + lampOff, z: bz - lampOff, rot: Math.PI * 0.25 });
      lampPositions.push({ x: bx - lampOff, z: bz + lampOff, rot: -Math.PI * 0.75 });
      hydrants.push({ x: bx + half - 0.9, z: bz + 4 });

      // Three row-houses per side along Z with alleys between them.
      for (const side of [-1, 1]) {
        for (let k = -1; k <= 1; k++) {
          const pal = rng.pick(annexPalettes);
          const w = rng.range(14, 18);
          const d = rng.range(11.5, 14);
          const h = rng.range(7, 19);
          const px = bx + side * 11.5;
          const pz = bz + k * 16.5;
          styleBuckets[pal.style].push({ x: px, y: h * 0.5 + 0.22, z: pz, sx: w, sy: h, sz: d, color: pal.wall });
          trimInstances.push({ x: px, y: h + 0.4, z: pz, sx: w + 0.4, sy: 0.55, sz: d + 0.4, color: pal.trim });
          colliders.push({ minX: px - w * 0.5, maxX: px + w * 0.5, minZ: pz - d * 0.5, maxZ: pz + d * 0.5, maxY: h });
          if (h > 11 && rng.chance(0.35)) waterTowers.push({ x: px, y: h + 0.22, z: pz });
          roofTops.push({ x: px, z: pz, top: h, w, d, style: pal.style, district: 'residential', hasBox: false });
        }
      }
      palmPositions.push({
        x: bx,
        z: bz - half + 2,
        lean: rng.range(-0.12, 0.12),
        h: rng.range(7, 10),
        rot: rng.range(0, Math.PI * 2),
      });
      palmPositions.push({
        x: bx,
        z: bz + half - 2,
        lean: rng.range(-0.12, 0.12),
        h: rng.range(7, 10),
        rot: rng.range(0, Math.PI * 2),
      });
    }
  }
  group.add(swMesh);

  // Add coastal boardwalk palms along the beach side of the coastal highway
  for (let z = -220; z <= 220; z += 18) {
    palmPositions.push({
      x: CITY.coastalRoadX + CITY.roadWidth * 0.5 + 3.2,
      z,
      lean: rng.range(-0.18, 0.18),
      h: rng.range(8.5, 12.5),
      rot: rng.range(0, Math.PI * 2),
    });
  }

  // Create one InstancedMesh per building style
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const colorObj = new THREE.Color();
  for (const [style, list] of Object.entries(styleBuckets)) {
    if (list.length === 0) continue;
    const mat = new THREE.MeshLambertMaterial({
      map: textures.facades[style],
      emissive: new THREE.Color(0xffffff),
      emissiveMap: textures.emissives[style],
      emissiveIntensity: style === 'glass' || style === 'curtain' ? 0.65 : 0.48,
    });
    const inst = new THREE.InstancedMesh(unitBox, mat, list.length);
    inst.receiveShadow = true;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      dummy.position.set(b.x, b.y, b.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(b.sx, b.sy, b.sz);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
      colorObj.setHex(b.color);
      inst.setColorAt(i, colorObj);
    }
    inst.instanceColor.needsUpdate = true;
    group.add(inst);
  }

  // Neon roofline trims (emissive basic material for punchy sunset pop)
  if (trimInstances.length > 0) {
    const trimMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const trimInst = new THREE.InstancedMesh(unitBox, trimMat, trimInstances.length);
    for (let i = 0; i < trimInstances.length; i++) {
      const t = trimInstances[i];
      dummy.position.set(t.x, t.y, t.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(t.sx, t.sy, t.sz);
      dummy.updateMatrix();
      trimInst.setMatrixAt(i, dummy.matrix);
      colorObj.setHex(t.color);
      trimInst.setColorAt(i, colorObj);
    }
    trimInst.instanceColor.needsUpdate = true;
    group.add(trimInst);
  }

  // Rooftop mechanical boxes
  if (roofInstances.length > 0) {
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x454f60 });
    const roofInst = new THREE.InstancedMesh(unitBox, roofMat, roofInstances.length);
    for (let i = 0; i < roofInstances.length; i++) {
      const rf = roofInstances[i];
      dummy.position.set(rf.x, rf.y, rf.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(rf.sx, rf.sy, rf.sz);
      dummy.updateMatrix();
      roofInst.setMatrixAt(i, dummy.matrix);
    }
    group.add(roofInst);
  }

  // Dockside shipping containers (cover geometry)
  if (dockCovers.length > 0) {
    const crateMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const crateInst = new THREE.InstancedMesh(unitBox, crateMat, dockCovers.length);
    crateInst.castShadow = true;
    crateInst.receiveShadow = true;
    for (let i = 0; i < dockCovers.length; i++) {
      const crate = dockCovers[i];
      dummy.position.set(crate.x, crate.h * 0.5 + 0.22, crate.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(crate.w, crate.h, crate.d);
      dummy.updateMatrix();
      crateInst.setMatrixAt(i, dummy.matrix);
      colorObj.setHex(crate.color);
      crateInst.setColorAt(i, colorObj);
    }
    crateInst.instanceColor.needsUpdate = true;
    group.add(crateInst);
  }

  // Storefront neon signs
  for (const spec of signSpecs) {
    const mat = new THREE.MeshBasicMaterial({ map: textures.signs[spec.signIndex] });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(spec.w, spec.h), mat);
    mesh.position.set(spec.x, spec.y, spec.z);
    mesh.rotation.y = spec.rotY;
    group.add(mesh);
  }

  // Instanced palm trees (curved-feel trunks + star of drooping fronds)
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.34, 1, 6);
  trunkGeo.translate(0, 0.5, 0);
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x7a573d });
  const trunkInst = new THREE.InstancedMesh(trunkGeo, trunkMat, palmPositions.length);

  const frondGeo = new THREE.BoxGeometry(0.42, 0.08, 3.6);
  frondGeo.translate(0, 0, 1.75);
  const frondMat = new THREE.MeshLambertMaterial({ color: 0x2f7d46 });
  const frondsPerPalm = 6;
  const frondInst = new THREE.InstancedMesh(frondGeo, frondMat, palmPositions.length * frondsPerPalm);

  let fIdx = 0;
  for (let i = 0; i < palmPositions.length; i++) {
    const p = palmPositions[i];
    dummy.position.set(p.x, 0.22, p.z);
    dummy.rotation.set(p.lean, p.rot, p.lean * 0.5);
    dummy.scale.set(1, p.h, 1);
    dummy.updateMatrix();
    trunkInst.setMatrixAt(i, dummy.matrix);

    const topX = p.x + Math.sin(p.lean * 0.5) * p.h * 0.5;
    const topZ = p.z + Math.sin(p.lean) * p.h * 0.5;
    const topY = 0.22 + p.h * 0.96;

    for (let f = 0; f < frondsPerPalm; f++) {
      const yaw = p.rot + (f / frondsPerPalm) * Math.PI * 2;
      dummy.position.set(topX, topY, topZ);
      dummy.rotation.set(0.32, yaw, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      frondInst.setMatrixAt(fIdx++, dummy.matrix);
    }
  }
  group.add(trunkInst, frondInst);

  // Instanced streetlights + warm bulb caps
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.14, 7.6, 6);
  poleGeo.translate(0, 3.8, 0);
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x3b404e });
  const poleInst = new THREE.InstancedMesh(poleGeo, poleMat, lampPositions.length);

  const bulbGeo = new THREE.BoxGeometry(0.65, 0.22, 0.65);
  const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffd280 });
  const bulbInst = new THREE.InstancedMesh(bulbGeo, bulbMat, lampPositions.length);

  for (let i = 0; i < lampPositions.length; i++) {
    const lp = lampPositions[i];
    dummy.position.set(lp.x, 0.22, lp.z);
    dummy.rotation.set(0, lp.rot, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    poleInst.setMatrixAt(i, dummy.matrix);

    dummy.position.set(lp.x, 7.8, lp.z);
    dummy.updateMatrix();
    bulbInst.setMatrixAt(i, dummy.matrix);
  }
  group.add(poleInst, bulbInst);

  // Traffic lights with dynamic signal heads
  const tlPostGeo = new THREE.CylinderGeometry(0.11, 0.14, 6.2, 6);
  tlPostGeo.translate(0, 3.1, 0);
  const tlPostInst = new THREE.InstancedMesh(tlPostGeo, poleMat, trafficLightPositions.length);

  const tlBoxGeo = new THREE.BoxGeometry(0.55, 1.5, 0.45);
  const tlBoxMat = new THREE.MeshLambertMaterial({ color: 0x1e2028 });
  const tlBoxInst = new THREE.InstancedMesh(tlBoxGeo, tlBoxMat, trafficLightPositions.length);

  const tlLampGeo = new THREE.BoxGeometry(0.6, 0.42, 0.5);
  const tlLampMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const tlLampInst = new THREE.InstancedMesh(tlLampGeo, tlLampMat, trafficLightPositions.length);

  for (let i = 0; i < trafficLightPositions.length; i++) {
    const tl = trafficLightPositions[i];
    dummy.position.set(tl.x, 0.22, tl.z);
    dummy.rotation.set(0, tl.rot, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    tlPostInst.setMatrixAt(i, dummy.matrix);

    dummy.position.set(tl.x, 5.8, tl.z);
    dummy.updateMatrix();
    tlBoxInst.setMatrixAt(i, dummy.matrix);

    dummy.position.set(tl.x, 5.8, tl.z);
    dummy.updateMatrix();
    tlLampInst.setMatrixAt(i, dummy.matrix);
    colorObj.setHex(0x4cff88);
    tlLampInst.setColorAt(i, colorObj);
  }
  tlLampInst.instanceColor.needsUpdate = true;
  group.add(tlPostInst, tlBoxInst, tlLampInst);

  // Rooftop water towers: tank + conical cap + a four-sided leg frame, all instanced.
  if (waterTowers.length > 0) {
    const tankGeo = new THREE.CylinderGeometry(1.6, 1.6, 2.8, 10);
    const capGeo = new THREE.ConeGeometry(1.8, 1.1, 10);
    const legGeo = new THREE.CylinderGeometry(1.25, 1.25, 2.4, 4, 1, true);
    const woodMat = new THREE.MeshLambertMaterial({ color: 0x8a5a3c });
    const capMat = new THREE.MeshLambertMaterial({ color: 0x4b3a33 });
    const legMat = new THREE.MeshLambertMaterial({ color: 0x2c2f38, side: THREE.DoubleSide, wireframe: true });
    const tankInst = new THREE.InstancedMesh(tankGeo, woodMat, waterTowers.length);
    const capInst = new THREE.InstancedMesh(capGeo, capMat, waterTowers.length);
    const legInst = new THREE.InstancedMesh(legGeo, legMat, waterTowers.length);
    waterTowers.forEach((wt, i) => {
      dummy.rotation.set(0, Math.PI / 4, 0);
      dummy.scale.set(1, 1, 1);
      dummy.position.set(wt.x, wt.y + 1.2, wt.z);
      dummy.updateMatrix();
      legInst.setMatrixAt(i, dummy.matrix);
      dummy.position.set(wt.x, wt.y + 3.8, wt.z);
      dummy.updateMatrix();
      tankInst.setMatrixAt(i, dummy.matrix);
      dummy.position.set(wt.x, wt.y + 5.75, wt.z);
      dummy.updateMatrix();
      capInst.setMatrixAt(i, dummy.matrix);
    });
    group.add(legInst, tankInst, capInst);
  }

  // Rooftop billboards facing the coastal boulevard: steel frame + lit sign panel.
  if (billboards.length > 0) {
    const frameMat = new THREE.MeshLambertMaterial({ color: 0x23262e });
    const frameInst = new THREE.InstancedMesh(unitBox, frameMat, billboards.length * 2);
    billboards.forEach((bb, i) => {
      dummy.rotation.set(0, bb.rotY, 0);
      dummy.position.set(bb.x, bb.y + 2.2, bb.z);
      dummy.scale.set(0.5, 4.4, 0.5);
      dummy.updateMatrix();
      frameInst.setMatrixAt(i * 2, dummy.matrix);
      dummy.position.set(bb.x, bb.y + 6.4, bb.z);
      dummy.scale.set(12.6, 4.6, 0.35);
      dummy.updateMatrix();
      frameInst.setMatrixAt(i * 2 + 1, dummy.matrix);
      const panelMat = new THREE.MeshBasicMaterial({ map: textures.signs[bb.signIndex] });
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(12, 4), panelMat);
      panel.position.set(bb.x + Math.sin(bb.rotY) * 0.2, bb.y + 6.4, bb.z + Math.cos(bb.rotY) * 0.2);
      panel.rotation.y = bb.rotY;
      group.add(panel);
    });
    group.add(frameInst);
  }

  // Street furniture: fire hydrants, trash bins and benches.
  const furnitureMats = {
    hydrant: new THREE.MeshLambertMaterial({ color: 0xd8342c }),
    bin: new THREE.MeshLambertMaterial({ color: 0x2f5b45 }),
    bench: new THREE.MeshLambertMaterial({ color: 0x8c5f3e }),
  };
  const hydrantGeo = new THREE.CylinderGeometry(0.2, 0.26, 0.85, 7);
  hydrantGeo.translate(0, 0.42, 0);
  const binGeo = new THREE.CylinderGeometry(0.36, 0.3, 1.0, 8);
  binGeo.translate(0, 0.5, 0);
  const benchGeo = new THREE.BoxGeometry(2.2, 0.5, 0.6);
  benchGeo.translate(0, 0.45, 0);
  const placeSimple = (geo, mat, list) => {
    if (list.length === 0) return;
    const inst = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((it, i) => {
      dummy.position.set(it.x, 0.22, it.z);
      dummy.rotation.set(0, it.rot || 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    });
    group.add(inst);
  };
  placeSimple(hydrantGeo, furnitureMats.hydrant, hydrants);
  placeSimple(binGeo, furnitureMats.bin, bins);
  placeSimple(benchGeo, furnitureMats.bench, benches);

  // Park: lawn, crossing paths, fountain basin with a glowing water disc, broadleaf trees.
  for (const pk of parks) {
    const lawnMat = new THREE.MeshLambertMaterial({
      map: textures.grass || null,
      color: textures.grass ? 0xffffff : 0x5c9a4a,
    });
    const lawn = new THREE.Mesh(new THREE.PlaneGeometry(pk.half * 2, pk.half * 2), lawnMat);
    lawn.rotation.x = -Math.PI / 2;
    lawn.position.set(pk.x, 0.235, pk.z);
    lawn.receiveShadow = true;
    group.add(lawn);
    const pathMat = new THREE.MeshLambertMaterial({ color: 0xd9c7a6 });
    for (const rot of [0, Math.PI / 2]) {
      const path = new THREE.Mesh(new THREE.PlaneGeometry(3, pk.half * 2), pathMat);
      path.rotation.set(-Math.PI / 2, 0, rot);
      path.position.set(pk.x, 0.245, pk.z);
      group.add(path);
    }
  }
  for (const pf of parkFeatures) {
    const basin = new THREE.Mesh(
      new THREE.CylinderGeometry(3.4, 3.6, 0.8, 18),
      new THREE.MeshLambertMaterial({ color: 0xcfc3b0 }),
    );
    basin.position.set(pf.x, 0.6, pf.z);
    const pool = new THREE.Mesh(new THREE.CircleGeometry(3.0, 18), new THREE.MeshBasicMaterial({ color: 0x4fd6e0 }));
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(pf.x, 1.02, pf.z);
    const spout = new THREE.Mesh(
      new THREE.CylinderGeometry(0.25, 0.45, 2.2, 8),
      new THREE.MeshLambertMaterial({ color: 0xe8ddcc }),
    );
    spout.position.set(pf.x, 2.0, pf.z);
    group.add(basin, pool, spout);
  }
  if (canopyTrees.length > 0) {
    const crownGeo = new THREE.IcosahedronGeometry(2.4, 0);
    const crownMat = new THREE.MeshLambertMaterial({ color: 0x3f8a3e, flatShading: true });
    const ctTrunkGeo = new THREE.CylinderGeometry(0.22, 0.32, 3.2, 6);
    ctTrunkGeo.translate(0, 1.6, 0);
    const ctTrunk = new THREE.InstancedMesh(ctTrunkGeo, trunkMat, canopyTrees.length);
    const ctCrown = new THREE.InstancedMesh(crownGeo, crownMat, canopyTrees.length);
    canopyTrees.forEach((t, i) => {
      dummy.position.set(t.x, 0.22, t.z);
      dummy.rotation.set(0, t.s * 3, 0);
      dummy.scale.set(t.s, t.s, t.s);
      dummy.updateMatrix();
      ctTrunk.setMatrixAt(i, dummy.matrix);
      dummy.position.set(t.x, 0.22 + 4.1 * t.s, t.z);
      dummy.updateMatrix();
      ctCrown.setMatrixAt(i, dummy.matrix);
    });
    group.add(ctTrunk, ctCrown);
  }

  // Pier: a timber deck running from the beach out over the water on pilings, with a bait shack.
  {
    const len = pier.x1 - pier.x0;
    const deckMat = new THREE.MeshLambertMaterial({
      map: textures.planks || null,
      color: textures.planks ? 0xffffff : 0xa47b55,
    });
    const deck = new THREE.Mesh(new THREE.BoxGeometry(len, 0.3, pier.halfW * 2), deckMat);
    deck.position.set(pier.x0 + len * 0.5, 0.18, pier.z);
    deck.receiveShadow = true;
    group.add(deck);

    const pileCount = Math.floor(len / 7) * 2;
    const pileGeo = new THREE.CylinderGeometry(0.22, 0.22, 2.6, 6);
    const pileInst = new THREE.InstancedMesh(pileGeo, new THREE.MeshLambertMaterial({ color: 0x5b4130 }), pileCount + 2);
    let pi = 0;
    for (let x = pier.x0 + 3; pi < pileCount; x += 7) {
      for (const side of [-1, 1]) {
        dummy.position.set(x, 0.6, pier.z + side * (pier.halfW - 0.2));
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        pileInst.setMatrixAt(pi++, dummy.matrix);
      }
    }
    // Two tall lamp-posts at the pier head reuse the pile instance buffer, stretched.
    for (const side of [-1, 1]) {
      dummy.position.set(pier.x1 - 2, 2.2, pier.z + side * (pier.halfW - 0.2));
      dummy.scale.set(0.5, 1.8, 0.5);
      dummy.updateMatrix();
      pileInst.setMatrixAt(pi++, dummy.matrix);
    }
    group.add(pileInst);

    const railMat = new THREE.MeshLambertMaterial({ color: 0xf2e6d4 });
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.12, 0.12), railMat);
      rail.position.set(pier.x0 + len * 0.5, 1.25, pier.z + side * (pier.halfW - 0.1));
      group.add(rail);
    }

    const shack = new THREE.Mesh(
      new THREE.BoxGeometry(5, 3, 4.4),
      new THREE.MeshLambertMaterial({ color: 0x3fb7c4 }),
    );
    shack.position.set(pier.x1 - 6, 1.83, pier.z);
    const shackRoof = new THREE.Mesh(
      new THREE.ConeGeometry(3.9, 1.4, 4),
      new THREE.MeshLambertMaterial({ color: 0xff6b5a }),
    );
    shackRoof.rotation.y = Math.PI / 4;
    shackRoof.position.set(pier.x1 - 6, 4.03, pier.z);
    group.add(shack, shackRoof);
    colliders.push({ minX: pier.x1 - 8.5, maxX: pier.x1 - 3.5, minZ: pier.z - 2.2, maxZ: pier.z + 2.2, maxY: 3 });
  }

  // Distant silhouette skyline ring on the west and north edges for dramatic depth
  const skylineCount = 44;
  const skylineMat = new THREE.MeshLambertMaterial({
    color: 0x3b3556,
    emissive: 0x2c1f3f,
    emissiveIntensity: 0.45,
  });
  const skylineInst = new THREE.InstancedMesh(unitBox, skylineMat, skylineCount);
  for (let i = 0; i < skylineCount; i++) {
    const angle = Math.PI * 0.48 + (i / (skylineCount - 1)) * Math.PI * 1.15;
    const dist = rng.range(360, 480);
    const sx = rng.range(18, 38);
    const sz = rng.range(18, 38);
    const sy = rng.range(45, 138);
    dummy.position.set(Math.cos(angle) * dist - 40, sy * 0.5, Math.sin(angle) * dist);
    dummy.rotation.set(0, rng.range(0, Math.PI * 0.5), 0);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    skylineInst.setMatrixAt(i, dummy.matrix);
  }
  group.add(skylineInst);

  // Garage glowing floor marker pad
  const garagePad = new THREE.Mesh(
    new THREE.RingGeometry(3.2, 4.1, 24),
    new THREE.MeshBasicMaterial({ color: 0x42f2ff, side: THREE.DoubleSide }),
  );
  garagePad.rotation.x = -Math.PI / 2;
  garagePad.position.set(CITY.garagePos.x, 0.28, CITY.garagePos.z);
  group.add(garagePad);

  // --- Rooftop prop pass -----------------------------------------------------------------------
  // AC units on most roofs, lattice antennas with red aviation lamps on the tallest downtown
  // towers. A forked stream is used so these props never shift the main generation sequence.
  const propRng = rng.fork(0x0f1a7);
  const acUnits = [];
  const antennas = [];
  for (const rt of roofTops) {
    if (rt.top < CITY_GEN.acMinHeight) continue;
    const n = rt.w > 14 ? propRng.int(1, CITY_GEN.acMaxPerRoof) : propRng.int(0, 2);
    for (let i = 0; i < n; i++) {
      // Keep units in the outer ring of the roof so they never sink into the central HVAC box.
      const side = propRng.chance(0.5) ? -1 : 1;
      const alongX = propRng.chance(0.5);
      const ox = alongX ? propRng.range(-rt.w * 0.38, rt.w * 0.38) : side * rt.w * 0.36;
      const oz = alongX ? side * rt.d * 0.36 : propRng.range(-rt.d * 0.38, rt.d * 0.38);
      acUnits.push({
        x: rt.x + ox,
        y: rt.top + 0.22 + 0.55,
        z: rt.z + oz,
        rot: alongX ? 0 : Math.PI / 2,
        s: propRng.range(0.85, 1.25),
      });
    }
    if (rt.district === 'downtown' && rt.top > CITY_GEN.antennaMinHeight && propRng.chance(0.7)) {
      antennas.push({
        x: rt.x + propRng.range(-1.5, 1.5),
        y: rt.top + 0.22,
        z: rt.z + propRng.range(-1.5, 1.5),
        h: propRng.range(6, 13),
      });
    }
  }
  if (acUnits.length > 0) {
    const acMat = new THREE.MeshLambertMaterial({ color: 0x9aa3ad });
    const acInst = new THREE.InstancedMesh(unitBox, acMat, acUnits.length);
    acUnits.forEach((u, i) => {
      dummy.position.set(u.x, u.y, u.z);
      dummy.rotation.set(0, u.rot, 0);
      dummy.scale.set(1.8 * u.s, 1.1 * u.s, 1.2 * u.s);
      dummy.updateMatrix();
      acInst.setMatrixAt(i, dummy.matrix);
    });
    group.add(acInst);
  }
  if (antennas.length > 0) {
    const mastGeo = new THREE.CylinderGeometry(0.08, 0.2, 1, 5);
    mastGeo.translate(0, 0.5, 0);
    const mastMat = new THREE.MeshLambertMaterial({ color: 0x5a5f6b });
    const tipGeo = new THREE.BoxGeometry(0.42, 0.42, 0.42);
    const tipMat = new THREE.MeshBasicMaterial({ color: 0xff3348 });
    const mastInst = new THREE.InstancedMesh(mastGeo, mastMat, antennas.length);
    const tipInst = new THREE.InstancedMesh(tipGeo, tipMat, antennas.length);
    antennas.forEach((a, i) => {
      dummy.position.set(a.x, a.y, a.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, a.h, 1);
      dummy.updateMatrix();
      mastInst.setMatrixAt(i, dummy.matrix);
      dummy.position.set(a.x, a.y + a.h + 0.2, a.z);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      tipInst.setMatrixAt(i, dummy.matrix);
    });
    group.add(mastInst, tipInst);
  }

  // Bus shelters: roof, rear glass, two posts and a route sign, all in one coloured instance set.
  if (busStops.length > 0) {
    const parts = [
      { ox: 0, oy: 2.55, oz: 0, sx: 3.8, sy: 0.14, sz: 1.7, color: 0x30cfd0 },
      { ox: 0, oy: 1.35, oz: -0.72, sx: 3.6, sy: 2.2, sz: 0.06, color: 0x9fd8e8 },
      { ox: -1.75, oy: 1.3, oz: 0.7, sx: 0.12, sy: 2.5, sz: 0.12, color: 0x3b404e },
      { ox: 1.75, oy: 1.3, oz: 0.7, sx: 0.12, sy: 2.5, sz: 0.12, color: 0x3b404e },
      { ox: 2.3, oy: 2.0, oz: 0.75, sx: 0.08, sy: 0.7, sz: 0.55, color: 0xffb347 },
      { ox: 0, oy: 0.55, oz: -0.45, sx: 2.6, sy: 0.1, sz: 0.45, color: 0x8c5f3e },
    ];
    const shelterMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const shelterInst = new THREE.InstancedMesh(unitBox, shelterMat, busStops.length * parts.length);
    let si = 0;
    for (const bs of busStops) {
      const cos = Math.cos(bs.rot);
      const sin = Math.sin(bs.rot);
      for (const p of parts) {
        dummy.position.set(bs.x + p.ox * cos + p.oz * sin, 0.22 + p.oy, bs.z - p.ox * sin + p.oz * cos);
        dummy.rotation.set(0, bs.rot, 0);
        dummy.scale.set(p.sx, p.sy, p.sz);
        dummy.updateMatrix();
        shelterInst.setMatrixAt(si, dummy.matrix);
        colorObj.setHex(p.color);
        shelterInst.setColorAt(si, colorObj);
        si++;
      }
      colliders.push({ minX: bs.x - 1.9, maxX: bs.x + 1.9, minZ: bs.z - 0.8, maxZ: bs.z - 0.62, maxY: 2.4 });
    }
    shelterInst.instanceColor.needsUpdate = true;
    group.add(shelterInst);
  }

  // Spatial index over every static collider and the road graph for pathfinding.
  const colliderGrid = new ColliderGrid(CITY_GEN.spatialCellSize);
  colliderGrid.build(colliders);
  const roadGraph = buildRoadGraph(roadCentersX, roadCentersZ, annex);

  // O(1) district lookup from world position (main grid blocks, then the annex and the shore).
  function districtAt(x, z) {
    if (x > CITY.coastalRoadX + CITY.roadWidth * 0.5) return 'waterfront';
    if (x < startX) return 'residential';
    const c = Math.floor((x - startX) / pitch);
    const r = Math.floor((z - startZ) / pitch);
    if (c < 0 || c >= cols || r < 0 || r >= rows) return 'residential';
    return planDistrict(c, r);
  }

  // Signal helper: true = NS green, false = EW green
  const lightCycle = 14;
  function isNorthSouthGreen(time, col, row) {
    const phase = (time + ((col + row) % 2) * (lightCycle * 0.5)) % lightCycle;
    return phase < lightCycle * 0.5;
  }

  function update(time) {
    // Animate ocean subtle drift
    textures.water.offset.x = (time * 0.015) % 1;
    textures.water.offset.y = (time * 0.022) % 1;

    // Update traffic light colors
    for (let i = 0; i < trafficLightPositions.length; i++) {
      const tl = trafficLightPositions[i];
      const nsGreen = isNorthSouthGreen(time, tl.interCol, tl.interRow);
      colorObj.setHex(nsGreen ? 0x42ff88 : 0xff4558);
      tlLampInst.setColorAt(i, colorObj);
    }
    tlLampInst.instanceColor.needsUpdate = true;
  }

  function resolveCircleCollisions(pos, radius) {
    // Only the boxes bucketed under this circle can touch it; indices arrive in array order.
    const candidates = colliderGrid.query(pos.x, pos.z, radius + 0.01);
    for (let k = 0; k < candidates.length; k++) {
      const c = colliders[candidates[k]];
      const cx = Math.max(c.minX, Math.min(pos.x, c.maxX));
      const cz = Math.max(c.minZ, Math.min(pos.z, c.maxZ));
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const distSq = dx * dx + dz * dz;
      if (distSq < radius * radius) {
        if (distSq > 1e-6) {
          const dist = Math.sqrt(distSq);
          const push = radius - dist;
          pos.x += (dx / dist) * push;
          pos.z += (dz / dist) * push;
        } else {
          // Circle centre is inside the box: push out along the nearest face.
          const dl = Math.abs(pos.x - c.minX);
          const dr = Math.abs(c.maxX - pos.x);
          const dt = Math.abs(pos.z - c.minZ);
          const db = Math.abs(c.maxZ - pos.z);
          const m = Math.min(dl, dr, dt, db);
          if (m === dl) pos.x = c.minX - radius;
          else if (m === dr) pos.x = c.maxX + radius;
          else if (m === dt) pos.z = c.minZ - radius;
          else pos.z = c.maxZ + radius;
        }
        return true;
      }
    }
    // World bounds (keep out of deep ocean and far perimeter). The pier deck is walkable/drivable
    // out over the water, and the West Annex extends the western edge.
    let hitBound = false;
    if (pos.x > CITY.waterStartX - 2) {
      const lim = pier.halfW - 0.3;
      const nearPier = Math.abs(pos.z - pier.z) < pier.halfW + 1.5;
      if (nearPier) {
        if (pos.z > pier.z + lim) {
          pos.z = pier.z + lim;
          hitBound = true;
        }
        if (pos.z < pier.z - lim) {
          pos.z = pier.z - lim;
          hitBound = true;
        }
        if (pos.x > pier.x1 - 1) {
          pos.x = pier.x1 - 1;
          hitBound = true;
        }
      } else {
        pos.x = CITY.waterStartX - 2;
        hitBound = true;
      }
    }
    if (pos.x < -CITY.halfSpanX - 18) {
      if (pos.z < annex.minZ + radius) {
        pos.z = annex.minZ + radius;
        hitBound = true;
      }
      if (pos.z > annex.maxZ - radius) {
        pos.z = annex.maxZ - radius;
        hitBound = true;
      }
    }
    if (pos.x < annex.minX - 4) {
      pos.x = annex.minX - 4;
      hitBound = true;
    }
    if (pos.z > CITY.halfSpanZ + 18) {
      pos.z = CITY.halfSpanZ + 18;
      hitBound = true;
    }
    if (pos.z < -CITY.halfSpanZ - 18) {
      pos.z = -CITY.halfSpanZ - 18;
      hitBound = true;
    }
    return hitBound;
  }

  // Nearest road centreline point, used by police pathing and roadblocks. Covers both grids.
  function nearestRoadNode(x, z) {
    let best = null;
    let bestDist = Infinity;
    for (const it of intersections) {
      const d = (it.x - x) ** 2 + (it.z - z) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = it;
      }
    }
    for (const it of annex.intersections) {
      const d = (it.x - x) ** 2 + (it.z - z) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = it;
      }
    }
    return best;
  }

  function isInPark(x, z) {
    return parks.some((p) => Math.abs(x - p.x) < p.half && Math.abs(z - p.z) < p.half);
  }

  // True when the point is inside any static collider box below `height` (line-of-sight and
  // spawn-validity checks for police and pedestrians).
  function isBlocked(x, z, height = 1) {
    const candidates = colliderGrid.query(x, z, 0.01);
    for (let k = 0; k < candidates.length; k++) {
      const c = colliders[candidates[k]];
      if (x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ && height <= c.maxY) return true;
    }
    return false;
  }

  // Coarse line-of-sight on the XZ plane: march in steps no longer than two metres and test the
  // spatial index at each sample. Good enough for "can the officer see the player".
  function hasLineOfSight(ax, az, bx, bz, eyeHeight = 1.6) {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(len / 2));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (isBlocked(ax + dx * t, az + dz * t, eyeHeight)) return false;
    }
    return true;
  }

  // Which road (if any) a point is on: 'ns', 'ew', 'intersection' or null.
  function roadAt(x, z) {
    const half = CITY.roadWidth * 0.5;
    let onNS = false;
    let onEW = false;
    for (const rx of roadCentersX) {
      if (Math.abs(x - rx) < half && z > startZ - half && z < -startZ + half) onNS = true;
    }
    for (const rz of roadCentersZ) {
      if (Math.abs(z - rz) < half && x > startX - half && x < -startX + half) onEW = true;
    }
    if (!onNS && !onEW) {
      for (const rx of annex.roadX) {
        if (Math.abs(x - rx) < half && z > annex.minZ && z < annex.maxZ) onNS = true;
      }
      for (const rz of annex.roadZ) {
        if (Math.abs(z - rz) < half && x > annex.minX && x < annex.maxX + half) onEW = true;
      }
    }
    if (onNS && onEW) return 'intersection';
    return onNS ? 'ns' : onEW ? 'ew' : null;
  }

  return {
    group,
    roadCentersX,
    roadCentersZ,
    blocks,
    intersections,
    colliders,
    sidewalkRects,
    dockCovers,
    annex,
    parks,
    pier,
    isNorthSouthGreen,
    resolveCircleCollisions,
    nearestRoadNode,
    isInPark,
    isBlocked,
    hasLineOfSight,
    roadAt,
    districtAt,
    colliderGrid,
    roadGraph,
    busStops,
    roofProps: { acUnits: acUnits.length, antennas: antennas.length },
    update,
  };
}
