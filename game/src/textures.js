import * as THREE from 'three';

// Every texture in the game is painted on an ordinary 2-D canvas at load time and uploaded once.
// Nothing is fetched: the same seed produces the same pixels, so shots replay identically.

// Allocate an offscreen drawing surface of the requested size.
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Wrap a canvas as a repeating, mip-mapped three.js texture. Colour textures are tagged sRGB so
// the renderer's output transform treats them as authored colours rather than linear data.
function toTexture(canvas, { repeatX = 1, repeatY = 1, srgb = true } = {}) {
  // Validate before handing the canvas to three.js so a zero-sized surface fails loudly here.
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
    console.warn('toTexture: invalid canvas dimensions', canvas && canvas.width, canvas && canvas.height);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// Shared asphalt base: aggregate speckle, tar-sealed cracks, a patched repair square and oil
// stains down the lanes. Everything is drawn from the seeded stream, so it is identical run to run.
function paintAsphalt(ctx, rng, size, base = '#252630') {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  // Aggregate: a dense field of two-pixel chips with a slight blue lift.
  const chips = size * 10;
  for (let i = 0; i < chips; i++) {
    const x = Math.floor(rng.next() * size);
    const y = Math.floor(rng.next() * size);
    const v = 30 + Math.floor(rng.next() * 28);
    ctx.fillStyle = `rgb(${v},${v},${v + 6})`;
    ctx.fillRect(x, y, 2, 2);
  }

  // Patch repair: a slightly darker, crisper rectangle of fresh tarmac.
  const px = rng.range(size * 0.15, size * 0.6);
  const py = rng.range(size * 0.1, size * 0.7);
  ctx.fillStyle = 'rgba(16,16,22,0.35)';
  ctx.fillRect(px, py, rng.range(24, 60), rng.range(18, 44));

  // Oil stains, biased to the wheel tracks down the middle of each half.
  for (let i = 0; i < 5; i++) {
    const ox = rng.pick([size * 0.25, size * 0.75]) + rng.range(-10, 10);
    const oy = rng.range(0, size);
    const g = ctx.createRadialGradient(ox, oy, 1, ox, oy, rng.range(6, 14));
    g.addColorStop(0, 'rgba(8,8,14,0.35)');
    g.addColorStop(1, 'rgba(8,8,14,0)');
    ctx.fillStyle = g;
    ctx.fillRect(ox - 16, oy - 16, 32, 32);
  }

  // Hairline cracks, sealed with dark tar and wandering down the tile.
  ctx.strokeStyle = 'rgba(12,12,18,0.55)';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 6; i++) {
    let x = rng.next() * size;
    let y = rng.next() * size;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const segs = 3 + Math.floor(rng.next() * 4);
    for (let s = 0; s < segs; s++) {
      x += rng.range(-14, 14);
      y += rng.range(4, 18);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

// Plain asphalt tiles used on parking lots and driveways.
export function createAsphaltTexture(rng) {
  const c = makeCanvas(256, 256);
  paintAsphalt(c.getContext('2d'), rng, 256);
  return toTexture(c, { repeatX: 4, repeatY: 4 });
}

// Boulevard surface: the same asphalt, with damp sheen streaked down the lane direction and a
// faint cool reflection so the road catches the golden-hour sky.
export function createRoadTexture(rng) {
  const c = makeCanvas(256, 256);
  const ctx = c.getContext('2d');
  paintAsphalt(ctx, rng, 256);
  const sheen = ctx.createLinearGradient(0, 0, 256, 0);
  sheen.addColorStop(0.0, 'rgba(255,155,95,0.0)');
  sheen.addColorStop(0.24, 'rgba(255,155,95,0.09)');
  sheen.addColorStop(0.5, 'rgba(60,210,235,0.04)');
  sheen.addColorStop(0.76, 'rgba(255,155,95,0.09)');
  sheen.addColorStop(1.0, 'rgba(255,155,95,0.0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, 256, 256);
  return toTexture(c, { repeatX: 4, repeatY: 4 });
}

// Sidewalk: pale concrete slabs laid on a regular grid, with grime speckled on top.
export function createSidewalkTexture(rng) {
  const c = makeCanvas(256, 256);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#bfb3a4';
  ctx.fillRect(0, 0, 256, 256);

  ctx.strokeStyle = 'rgba(128,120,108,0.4)';
  ctx.lineWidth = 2;
  const gridSize = 32;
  for (let x = gridSize; x < 256; x += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 256);
    ctx.stroke();
  }
  for (let y = gridSize; y < 256; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(256, y);
    ctx.stroke();
  }

  // Dirt and gum stains scattered over the slabs.
  ctx.fillStyle = 'rgba(96,88,76,0.15)';
  for (let i = 0; i < 40; i++) {
    const x = rng.next() * 256;
    const y = rng.next() * 256;
    const r = rng.range(2, 8);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return toTexture(c, { repeatX: 3, repeatY: 3 });
}

// Sky dome panorama: a warm golden-hour gradient with soft cloud bands near the horizon.
export function createSkyTexture(rng) {
  const c = makeCanvas(512, 256);
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, '#ff8a4c');
  grad.addColorStop(0.4, '#ffa964');
  grad.addColorStop(0.6, '#ffb870');
  grad.addColorStop(1.0, '#e68466');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 256);

  // Cloud wisps: wide, translucent white bands, kept to the upper half of the panorama.
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 20; i++) {
    const x = rng.next() * 512;
    const y = rng.next() * 128;
    const w = rng.range(80, 200);
    const h = rng.range(20, 60);
    ctx.fillRect(x, y, w, h);
  }
  ctx.globalAlpha = 1.0;
  return toTexture(c, { srgb: true });
}

// Sun disc sprite: white core fading through pale gold to transparent.
export function createSunFlareTexture(rng) {
  const c = makeCanvas(256, 256);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 256, 256);
  const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0.0, 'rgba(255,255,255,1.0)');
  grad.addColorStop(0.5, 'rgba(255,255,200,0.5)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  return toTexture(c, { srgb: true });
}

// Amber halo laid over the sun to paint the sky around it.
export function createWarmGlowTexture(rng) {
  const c = makeCanvas(256, 256);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 256, 256);
  const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 180);
  grad.addColorStop(0.0, 'rgba(255,200,100,1.0)');
  grad.addColorStop(0.6, 'rgba(255,150,50,0.4)');
  grad.addColorStop(1.0, 'rgba(255,100,0,0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  return toTexture(c, { srgb: true });
}

// Red glow for brake lights, sirens and damage flashes.
export function createRedGlowTexture(rng) {
  const c = makeCanvas(256, 256);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 256, 256);
  const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 180);
  grad.addColorStop(0.0, 'rgba(255,0,0,1.0)');
  grad.addColorStop(0.6, 'rgba(255,80,80,0.5)');
  grad.addColorStop(1.0, 'rgba(255,0,0,0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  return toTexture(c, { srgb: true });
}

// Blue glow for police light bars, headlights on the far shore and neon spill.
export function createBlueGlowTexture(rng) {
  const c = makeCanvas(256, 256);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 256, 256);
  const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 180);
  grad.addColorStop(0.0, 'rgba(44,168,255,1.0)');
  grad.addColorStop(0.6, 'rgba(100,180,255,0.5)');
  grad.addColorStop(1.0, 'rgba(44,168,255,0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  return toTexture(c, { srgb: true });
}

// 8×8 atlas of lit and unlit windows, mapped per-building-face with the instanced facade shader.
// Lit cells get a warm rectangle split by a cross mullion; unlit cells stay cold and dim.
export function createWindowAtlasTexture(rng) {
  const c = makeCanvas(256, 256);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 256, 256);

  const cellSize = 32;
  const glowColor = '#ffdc80';
  const half = cellSize / 2;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const x = col * cellSize;
      const y = row * cellSize;
      if (rng.chance(0.7)) {
        ctx.fillStyle = glowColor;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(x + 4, y + 4, cellSize - 8, cellSize - 8);
        ctx.globalAlpha = 1.0;
        ctx.strokeStyle = glowColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + half, y + 4);
        ctx.lineTo(x + half, y + cellSize - 4);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + 4, y + half);
        ctx.lineTo(x + cellSize - 4, y + half);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#1a2a40';
        ctx.globalAlpha = 0.6;
        ctx.fillRect(x + 2, y + 2, cellSize - 4, cellSize - 4);
        ctx.globalAlpha = 1.0;
      }
    }
  }
  return toTexture(c, { srgb: true });
}

// The complete set, built from one forked stream so adding a texture never reshuffles the others.
export function createTexturePack(rng) {
  return Object.freeze({
    asphalt: createAsphaltTexture(rng),
    road: createRoadTexture(rng),
    sidewalk: createSidewalkTexture(rng),
    sky: createSkyTexture(rng),
    sunFlare: createSunFlareTexture(rng),
    warmGlow: createWarmGlowTexture(rng),
    redGlow: createRedGlowTexture(rng),
    blueGlow: createBlueGlowTexture(rng),
    windowAtlas: createWindowAtlasTexture(rng),
  });
}
