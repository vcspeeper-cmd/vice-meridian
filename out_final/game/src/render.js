import * as THREE from 'three';
import { PALETTE, TIME_OF_DAY, sampleTimeOfDay } from './config.js';

// Fullscreen-triangle vertex shader shared by the post passes.
const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Bright pass: keep only what is brighter than the threshold, downsampled with a 4-tap box.
const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform vec2 texel;
uniform float threshold;
varying vec2 vUv;
vec3 bright(vec2 uv) {
  vec3 c = texture2D(tScene, uv).rgb;
  float l = max(c.r, max(c.g, c.b));
  return c * smoothstep(threshold, threshold + 0.35, l);
}
void main() {
  vec3 sum = bright(vUv + texel * vec2(-1.0, -1.0));
  sum += bright(vUv + texel * vec2(1.0, -1.0));
  sum += bright(vUv + texel * vec2(-1.0, 1.0));
  sum += bright(vUv + texel * vec2(1.0, 1.0));
  gl_FragColor = vec4(sum * 0.25, 1.0);
}
`;

// Composite: scene + soft additive glow (13-tap blur of the quarter-res bright buffer),
// then a gentle warm vignette, then the renderer's tone mapping and output colour space.
const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tGlow;
uniform vec2 glowTexel;
uniform float glowStrength;
uniform float vignetteStrength;
uniform vec3 vignetteTint;
varying vec2 vUv;
void main() {
  vec3 col = texture2D(tScene, vUv).rgb;
  vec3 g = texture2D(tGlow, vUv).rgb * 0.2;
  vec2 o1 = glowTexel * 1.5;
  vec2 o2 = glowTexel * 3.5;
  g += (texture2D(tGlow, vUv + vec2(o1.x, 0.0)).rgb + texture2D(tGlow, vUv - vec2(o1.x, 0.0)).rgb
      + texture2D(tGlow, vUv + vec2(0.0, o1.y)).rgb + texture2D(tGlow, vUv - vec2(0.0, o1.y)).rgb) * 0.1;
  g += (texture2D(tGlow, vUv + o2).rgb + texture2D(tGlow, vUv - o2).rgb
      + texture2D(tGlow, vUv + vec2(o2.x, -o2.y)).rgb + texture2D(tGlow, vUv + vec2(-o2.x, o2.y)).rgb) * 0.06;
  vec2 o3 = glowTexel * 7.0;
  g += (texture2D(tGlow, vUv + vec2(o3.x, 0.0)).rgb + texture2D(tGlow, vUv - vec2(o3.x, 0.0)).rgb
      + texture2D(tGlow, vUv + vec2(0.0, o3.y)).rgb + texture2D(tGlow, vUv - vec2(0.0, o3.y)).rgb) * 0.04;
  col += g * glowStrength;
  vec2 d = vUv - 0.5;
  float v = smoothstep(0.32, 0.92, length(d * vec2(1.15, 1.0)));
  col = mix(col, col * vignetteTint, v * vignetteStrength);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function makeFullscreenTriangle() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  return geo;
}

export function createRenderRig(canvas, textures) {
  const params = new URLSearchParams(window.location.search);
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.info.autoReset = false;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(PALETTE.fogColor, 0.00205);

  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.25, 1600);

  // Sky dome
  const skyGeo = new THREE.SphereGeometry(950, 24, 16);
  const skyMat = new THREE.MeshBasicMaterial({
    map: textures.sky,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const skyDome = new THREE.Mesh(skyGeo, skyMat);
  scene.add(skyDome);

  // Golden-hour sun direction (low over the horizon for warm key light and long shadows)
  const sunDir = new THREE.Vector3(0.45, 0.22, -0.86).normalize();

  // Sun disc + additive lens flare sprites
  const sunGroup = new THREE.Group();
  const sunCoreMat = new THREE.SpriteMaterial({
    map: textures.sunFlare,
    color: 0xfff0c2,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const sunCore = new THREE.Sprite(sunCoreMat);
  sunCore.scale.set(170, 170, 1);
  sunGroup.add(sunCore);

  const sunHaloMat = new THREE.SpriteMaterial({
    map: textures.warmGlow,
    color: 0xff8c48,
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    fog: false,
  });
  const sunHalo = new THREE.Sprite(sunHaloMat);
  sunHalo.scale.set(420, 260, 1);
  sunGroup.add(sunHalo);
  scene.add(sunGroup);

  // Primary lights: one HemisphereLight + one shadow-casting DirectionalLight
  const baseHemiIntensity = 0.92;
  const baseSunIntensity = 2.25;
  const hemiLight = new THREE.HemisphereLight(PALETTE.hemiSky, PALETTE.hemiGround, baseHemiIntensity);
  scene.add(hemiLight);

  const sunLight = new THREE.DirectionalLight(PALETTE.sunColor, baseSunIntensity);
  sunLight.position.copy(sunDir).multiplyScalar(190);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(1024, 1024);
  sunLight.shadow.camera.near = 20;
  sunLight.shadow.camera.far = 420;
  const s = 95;
  sunLight.shadow.camera.left = -s;
  sunLight.shadow.camera.right = s;
  sunLight.shadow.camera.top = s;
  sunLight.shadow.camera.bottom = -s;
  // Bias tuned for the low sun: a small constant bias plus a normal offset removes acne on the
  // long grazing faces without the peter-panning a large constant bias causes.
  sunLight.shadow.bias = -0.00035;
  sunLight.shadow.normalBias = 0.035;
  sunLight.shadow.radius = 2.5;
  scene.add(sunLight);
  scene.add(sunLight.target);

  // --- Post: glow + vignette ------------------------------------------------------------------
  const gl = renderer.getContext();
  const isWebGL2 = renderer.capabilities.isWebGL2;
  const canHalf = isWebGL2 && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
  let postEnabled = params.get('post') !== '0' && isWebGL2 && Boolean(gl);

  let sceneRT = null;
  let glowRT = null;
  const fsTri = makeFullscreenTriangle();
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const brightMat = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: null },
      texel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
      threshold: { value: 0.92 },
    },
    vertexShader: FS_VERT,
    fragmentShader: BRIGHT_FRAG,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const compositeMat = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: null },
      tGlow: { value: null },
      glowTexel: { value: new THREE.Vector2(1 / 320, 1 / 180) },
      glowStrength: { value: 0.55 },
      vignetteStrength: { value: 0.32 },
      vignetteTint: { value: new THREE.Color(0.55, 0.38, 0.5) },
    },
    vertexShader: FS_VERT,
    fragmentShader: COMPOSITE_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  const brightScene = new THREE.Scene();
  const brightQuad = new THREE.Mesh(fsTri, brightMat);
  brightQuad.frustumCulled = false;
  brightScene.add(brightQuad);
  const compositeScene = new THREE.Scene();
  const compositeQuad = new THREE.Mesh(fsTri, compositeMat);
  compositeQuad.frustumCulled = false;
  compositeScene.add(compositeQuad);

  function allocTargets() {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(2, Math.floor(size.x));
    const h = Math.max(2, Math.floor(size.y));
    if (sceneRT) sceneRT.dispose();
    if (glowRT) glowRT.dispose();
    sceneRT = new THREE.WebGLRenderTarget(w, h, {
      type: canHalf ? THREE.HalfFloatType : THREE.UnsignedByteType,
      samples: 4,
      depthBuffer: true,
    });
    const gw = Math.max(2, Math.floor(w / 4));
    const gh = Math.max(2, Math.floor(h / 4));
    glowRT = new THREE.WebGLRenderTarget(gw, gh, { type: canHalf ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: false });
    brightMat.uniforms.texel.value.set(1 / w * 1.5, 1 / h * 1.5);
    compositeMat.uniforms.glowTexel.value.set(1 / gw, 1 / gh);
  }

  if (postEnabled) {
    try {
      allocTargets();
    } catch {
      postEnabled = false;
    }
  }

  function render() {
    // Count every pass of one frame together (scene + bright pass + composite).
    renderer.info.reset();
    if (!postEnabled) {
      renderer.render(scene, camera);
      return;
    }
    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);
    brightMat.uniforms.tScene.value = sceneRT.texture;
    renderer.setRenderTarget(glowRT);
    renderer.render(brightScene, postCam);
    compositeMat.uniforms.tScene.value = sceneRT.texture;
    compositeMat.uniforms.tGlow.value = glowRT.texture;
    renderer.setRenderTarget(null);
    renderer.render(compositeScene, postCam);
  }

  // --- Time of day ---------------------------------------------------------------------------
  // Off by default so every screenshot keeps the tuned golden-hour frame; interactive play
  // switches it on for a slow swing between late afternoon and dusk.
  const rig = { dayCycle: false };
  const tmpColor = new THREE.Color();
  const baseSkyTint = new THREE.Color(1, 1, 1);

  function applyTimeOfDay(t) {
    const tod = sampleTimeOfDay(t);
    const ref = sampleTimeOfDay(TIME_OF_DAY.default);
    const k = tod.sunIntensity / ref.sunIntensity;
    sunLight.color.setHex(tod.sun);
    sunLight.intensity = baseSunIntensity * k;
    hemiLight.color.setHex(tod.hemiSky);
    hemiLight.intensity = baseHemiIntensity * (0.6 + 0.4 * k);
    scene.fog.color.setHex(tod.fog);
    tmpColor.setHex(tod.sky);
    // Lean the sky texture slightly toward the keyframe sky colour and dim it toward dusk.
    skyMat.color.copy(baseSkyTint).lerp(tmpColor, 0.15).multiplyScalar(0.55 + 0.45 * Math.min(1, k));
  }

  function updateAtmosphere(anchorPos, time = 0) {
    if (rig.dayCycle) {
      const swing = Math.sin((time / TIME_OF_DAY.dayLengthSeconds) * Math.PI * 2) * 0.1;
      applyTimeOfDay(TIME_OF_DAY.default + swing);
    }
    skyDome.position.set(anchorPos.x, 0, anchorPos.z);
    sunGroup.position.set(
      anchorPos.x + sunDir.x * 780,
      Math.max(52, sunDir.y * 780),
      anchorPos.z + sunDir.z * 780,
    );
    // Snap the shadow camera to whole shadow-map texels so shadows do not shimmer as you move.
    const texel = (s * 2) / sunLight.shadow.mapSize.x;
    const ax = Math.round(anchorPos.x / texel) * texel;
    const az = Math.round(anchorPos.z / texel) * texel;
    sunLight.position.set(
      ax + sunDir.x * 160,
      sunDir.y * 160 + 25,
      az + sunDir.z * 160,
    );
    sunLight.target.position.set(ax, 0, az);
    sunLight.target.updateMatrixWorld();
  }

  function resize() {
    const w = window.innerWidth || 1280;
    const h = window.innerHeight || 720;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    if (postEnabled) allocTargets();
  }

  window.addEventListener('resize', resize);

  // --- Quality tier management & dynamic resolution scaling ----------------------------------------
  // The frame-budget guard monitors frame time and switches quality tiers to maintain target FPS.
  // If the smoothed frame time exceeds downshiftMs for windowFrames in a row, drop one tier.
  // If it stays below upshiftMs for twice as long, climb back up.
  let currentTier = 'medium';
  let tierAdjustTimer = 0;
  let frameTimeSmoothed = 16.7;
  let pixelRatioOverride = 1.0;

  function setQualityTier(tier) {
    currentTier = tier;
    const tierCfg = QUALITY_TIERS[tier];
    if (!tierCfg) return;

    renderer.setPixelRatio(tierCfg.pixelRatio * pixelRatioOverride);
    sunLight.shadow.mapSize.set(tierCfg.shadowMapSize, tierCfg.shadowMapSize);
    sunLight.castShadow = tierCfg.shadows;
    scene.fog.far = tierCfg.drawDistance;

    if (postEnabled && !tierCfg.post) postEnabled = false;
  }

  function updateQualityGate(frameMs) {
    frameTimeSmoothed = frameTimeSmoothed * (1 - FRAME_BUDGET.smoothing) + frameMs * FRAME_BUDGET.smoothing;

    if (frameTimeSmoothed > FRAME_BUDGET.downshiftMs) {
      tierAdjustTimer += 1;
      if (tierAdjustTimer >= FRAME_BUDGET.windowFrames) {
        const idx = QUALITY_ORDER.indexOf(currentTier);
        if (idx < QUALITY_ORDER.length - 1) {
          setQualityTier(QUALITY_ORDER[idx + 1]);
        }
        tierAdjustTimer = 0;
      }
    } else if (frameTimeSmoothed < FRAME_BUDGET.upshiftMs) {
      tierAdjustTimer += 1;
      if (tierAdjustTimer >= FRAME_BUDGET.windowFrames * 2) {
        const idx = QUALITY_ORDER.indexOf(currentTier);
        if (idx > 0) {
          setQualityTier(QUALITY_ORDER[idx - 1]);
        }
        tierAdjustTimer = 0;
      }
    } else {
      tierAdjustTimer = 0;
    }
  }

  // --- Frustum culling: skip rendering blocks outside the camera view -----
  const frustum = new THREE.Frustum();
  const projMatrix = new THREE.Matrix4();
  const frustumCulled = new Set();

  function updateFrustumCull() {
    projMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projMatrix);
    frustumCulled.clear();

    // Test each block mesh's bounding sphere
    for (const block of scene.children) {
      if (!block.geometry || !block.geometry.boundingSphere) continue;
      if (!block.visible) continue;

      const sphere = block.geometry.boundingSphere;
      const worldPos = new THREE.Vector3();
      block.getWorldPosition(worldPos);
      const worldSphere = new THREE.Sphere(worldPos, sphere.radius);

      if (!frustum.intersectsSphere(worldSphere)) {
        block.visible = false;
        frustumCulled.add(block);
      } else if (frustumCulled.has(block)) {
        block.visible = true;
        frustumCulled.delete(block);
      }
    }
  }

  // --- Main render loop with fixed timestep & frame interpolation --------
  // The game runs at FIXED_DT (1/60), but renders interpolated between ticks.
  // This decouples simulation from frame rate and prevents stuttering.
  let lastTime = performance.now();
  let accumulator = 0;
  let running = true;

  rig.isRunning = () => running;
  rig.stop = () => { running = false; };

  function renderLoop(now) {
    if (!running) return;

    const dt = Math.min((now - lastTime) / 1000, 0.05); // Cap at 50ms to prevent spiral
    lastTime = now;
    accumulator += dt;

    // Let the game controller know how many fixed ticks are queued
    rig.ticksQueued = 0;
    while (accumulator >= FIXED_DT) {
      rig.ticksQueued += 1;
      accumulator -= FIXED_DT;
    }

    // Interpolation factor: 0 at the last tick, 1 just before the next tick
    rig.interpolation = accumulator / FIXED_DT;

    // Call the game's main simulation, which processes ticks and renderable state
    if (rig.onTick) rig.onTick(rig.ticksQueued, rig.interpolation);

    // Update camera position and atmosphere based on player/vehicle position
    if (rig.getCameraTarget) {
      const target = rig.getCameraTarget();
      updateAtmosphere(target.position, target.time ?? 0);
    }

    // Cull blocks outside the frustum
    updateFrustumCull();

    // Render the scene (scene pass + post passes if enabled)
    const startMs = performance.now();
    render();
    const frameMs = performance.now() - startMs;

    // Update the frame-budget guard
    updateQualityGate(frameMs);

    requestAnimationFrame(renderLoop);
  }

  // --- Cleanup and resource disposal ------
  rig.dispose = function() {
    running = false;
    window.removeEventListener('resize', resize);

    // Dispose all geometries and materials
    scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach(m => m.dispose());
        } else {
          obj.material.dispose();
        }
      }
    });

    // Dispose render targets
    if (sceneRT) sceneRT.dispose();
    if (glowRT) glowRT.dispose();

    // Dispose the renderer and its WebGL context
    renderer.dispose();
  };

  // Start the loop
  requestAnimationFrame(renderLoop);

  return Object.assign(rig, {
    renderer,
    scene,
    camera,
    sunDir,
    sunLight,
    hemiLight,
    updateAtmosphere,
    applyTimeOfDay,
    render,
    resize,
    get postEnabled() {
      return postEnabled;
    },
  });
}
