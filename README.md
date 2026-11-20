# vcspeeper-cmd/vice-meridian

[![make.fun · gta6-01](https://make.fun/badge/gta6-01.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![rank](https://make.fun/badge/gta6-01/vcspeeper-cmd/vice-meridian/rank.svg)](https://make.fun/bounty/gta6-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![reward](https://make.fun/badge/gta6-01/vcspeeper-cmd/vice-meridian/reward.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)

**VICE MERIDIAN** — an original open-world crime sandbox that runs in a desktop browser from plain static files. A procedural sun-drenched coastal metropolis (Marisol Bay, Caleta Heights, Dockside, Palmetto Strip, Old Meridian) built with three.js: instanced buildings and windows, palm-lined boulevards, traffic that obeys lights, pedestrians that flee, a five-star wanted system with pursuing cruisers, pistol combat with raycast hits, scripted missions with dialogue, and a DOM HUD with a live minimap, weapon wheel, police-response panel and speedometer. Every texture is drawn on a canvas and every sound is synthesised with Web Audio — no network requests, no external assets, no CDN.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
node serve.ts   # then open http://localhost:8080
```

`main.ts` validates the entry, copies `game/` and `screenshots/` into the output directory and writes `dossier.json`. `serve.ts` is a small static server with correct MIME types for local play; the game itself needs no build step and no server-side code.

Deterministic screenshot scenes: `?shot=chase|street|drive|mission&seed=7&t=6&hud=1`. Add `&post=0` to skip the glow and vignette passes.

## Controls

| Action                | Keyboard        | Gamepad              |
| --------------------- | --------------- | -------------------- |
| Move forward          | W               | Left Stick ↑         |
| Move back             | S               | Left Stick ↓         |
| Turn left             | A               | Left Stick ←         |
| Turn right            | D               | Left Stick →         |
| Sprint                | Shift           | L3 (stick click)     |
| Aim                   | Right-click     | Left Trigger (hold)  |
| Fire / Attack         | Left-click      | Right Trigger (hold) |
| Jump / Handbrake      | Space           | A Button             |
| Enter / exit vehicle  | F               | Y Button             |
| Interact              | E               | D-Pad ↑              |
| Reload                | R               | X Button             |
| Melee attack          | Q               | B Button             |
| Horn                  | H               | R3 (stick click)     |
| Next / previous weapon| X / Z           | RB / LB              |
| Radio next / previous | . / ,           | D-Pad → / ←          |
| Look back             | C               | D-Pad ↓              |
| Mission log           | L               | Back                 |
| Save                  | K               | —                    |
| Pause                 | P / Escape      | Start                |
| Weapon wheel          | Tab             | —                    |
| Mute                  | M               | —                    |
| Performance stats     | F3              | —                    |

Bindings are rebindable from the pause menu and persist in `localStorage` under `vice-meridian-bindings-v1`. Mouse look uses pointer lock; sensitivity and invert-Y apply to both the mouse and the right stick.

## Module Map

| File                              | Lines | Purpose                                                                                                                                                 |
| --------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.ts`                         | ~150  | Entry point & validation: copies game/ to output, validates file limits, writes dossier.json                                                            |
| `serve.ts`                        | ~80   | Static server for local play: correct MIME types, 304 caching, directory index, SIGINT shutdown                                                         |
| `game/index.html`                 | ~500  | Entry page: canvas, HUD overlay markup, import map, title & meta                                                                                        |
| `game/package.json`               | ~55   | Manifest: name, version, ES module type, start script, engines field                                                                                    |
| `game/src/config.js`              | ~590  | Tuning: physics, camera rigs, traffic density, city generation, wanted levels, weapons, vehicle specs, quality tiers, all frozen                        |
| `game/src/main.js`                | ~400  | Bootstrap & state machine: canvas setup, fixed-step loop (60 Hz), pause on blur, resize handling, shot mode entry point                                 |
| `game/src/render.js`              | ~470  | Renderer: scene, sky and sun rig, post-process glow+vignette chain, time-of-day blend, quality tiers, shadow snapping, resource disposal                |
| `game/src/audio.js`               | ~450  | Web Audio synthesis: engine rev from RPM, tyre screech from slip, siren with LFO, impacts, ambience bed, master limiter, no assets                      |
| `game/src/textures.js`            | ~270  | Canvas textures: asphalt with cracks, sidewalk grid, sky gradient, glows, window atlas, all deterministic from seed                                     |
| `game/src/city.js`                | ~340  | City generator: grid of blocks with setbacks, rooftop props, street furniture, beach/canal strips, road graph for traffic/police AI                     |
| `game/src/vehicles.js`            | ~350  | Vehicle physics & AI: bicycle-model steering, engine torque curve, grip & drift, suspension, traffic lane-following, collision response, damage & smoke |
| `game/src/player.js`              | ~280  | Player: capsule collision, on-foot & in-vehicle states, aiming, health/armour regen, downed state with bleed-out, respawn                               |
| `game/src/pedestrians.js`         | ~240  | Pedestrian crowds: sidewalk following, avoidance, panic on gunfire/vehicles, ragdoll-lite fall, pooling (1000 agents cheap)                             |
| `game/src/police.js`              | ~530  | Wanted system: heat accumulation, star thresholds, pursuit cars, roadblocks, on-foot officers, grid-based pathing, arrest mechanic                      |
| `game/src/combat.js`              | ~260  | Weapons: hitscan with spread/falloff, grenades with bounce, muzzle flash, tracers, hit markers, impact VFX, NPC accuracy                                |
| `game/src/missions.js`            | ~290  | Mission state machine: objective markers, distance readouts, dialogue, timers, rewards, shootout tracking, ship controls                                |
| `game/src/hud.js`                 | ~300  | HUD overlay: minimap rendered from city graph, health/armour bars, wanted stars, speedometer, weapon wheel, mission banner, subtitle                    |
| `game/src/input.js`               | ~500  | Input handling: keyboard, mouse look with pointer lock, gamepad axes with dead zones, action mapping, press buffer, rebind table                         |
| `game/src/random.js`              | ~185  | Seeded PRNG (xoshiro128\*\*): deterministic world gen, save/restore state for replay, helpers (range, pick, shuffle, gauss)                             |
| `game/src/shots.js`               | ~360  | Named screenshot rigs: chase, street, drive, mission — each with fixed camera, entities, dialogue, VFX, deterministic step                              |
| `shots.json`                      | ~10   | Shot table: named capture queries with seeds                                                                                                           |
| `game/vendor/three.module.min.js` | 1500+ | three.js (vendored, no external request)                                                                                                               |

## How It Works

### City Generation

The city is a 6×6 grid of blocks. Each block is filled with instanced buildings (randomised height, palette, detail props). The intersections form a navigation graph that traffic and police use to pathfind without cutting through blocks. Street furniture (lamp posts, bus stops, fire hydrants) is scattered deterministically. A beach strip and a canal add geographic variety, and a coastal highway runs the length of the map with the ocean on one side.

Generation draws only from a `SeededRandom` stream forked off the run seed, so the same seed lays out the same city on every machine and every reload.

### Deterministic Shots

Four named camera rigs (`?shot=chase|street|drive|mission`) replay identically each run:

1. `?seed=7&t=6` steps the fixed simulation 360 frames (6 seconds at 60 Hz) before rendering
2. The same RNG seed produces the same traffic spawn, the same pedestrian positions and the same wind direction
3. The shot's camera override positions the viewer and sets the HUD flags
4. Two runs with identical parameters produce identical pixels

Shot scenes are built by `setupShotScene()` in `game/src/shots.js`, which lays out a fixed slate of vehicles, crowd, wanted state, dialogue and VFX and returns a small descriptor. `stepShotScene()` advances that descriptor by hand — the hero car and its pursuers move along the boulevard, and the dock shootout re-seeds its tracers — without going through the normal physics integrators, so the framing never drifts.

`main.ts` runs the same browser code path in Node for validation; there is no separate screenshot renderer that could fall out of sync with the game.

### Rendering

`createRenderRig()` in `game/src/render.js` owns the renderer, scene, camera, sky dome, sun sprites and the two lights. On WebGL2 with colour-buffer-float support it runs a three-pass frame: scene into a multisampled half-float target, a bright-pass downsample to quarter resolution, then a composite that adds a 13-tap glow, a warm vignette, ACES tone mapping and the sRGB output transform. Without that support — or with `?post=0` — it draws the scene straight to the canvas.

The sky dome and sun sprites follow the player horizontally, and the shadow camera is snapped to whole shadow-map texels so shadow edges do not crawl while driving. A quality ladder (`low`, `medium`, `high`) scales pixel ratio, shadow map size, draw distance and the post chain; the ladder's own guard watches smoothed frame time, but the game's `FrameBudgetGuard` normally drives it.

### Network Limit

Zero network requests. Three.js is vendored. All textures (asphalt, sky, neon glows, windows) are canvas-drawn on startup. All sounds (engine, siren, gunfire) are Web Audio synthesis. All data files are bundled.

### Physics

- **Vehicles**: Bicycle-model steering integrator with speed-scaled turn rate, tyre grip exponential decay, damage-based power loss, collision impulse response
- **Player**: Capsule collider against buildings and vehicles, gravity, jump buffer and coyote time, stamina for sprint
- **Pedestrians**: Pooled agents with sidewalk following, parabolic fall, immediate-mode collision response

### Wanted System

Heat accumulates from crimes. Stars cross thresholds (1 star at 1 heat, 2 stars at 3 heat, and so on). Out of sight, heat cools; in sight, it holds. Each decay period (18 seconds) drops one star. Roadblocks spawn at 3+ stars. Officers deploy from cruisers at 2+ stars, moving toward the player and attempting an arrest below moderate speed.

### HUD & UI

The minimap is drawn from the city road graph every frame onto a canvas, then composited under the DOM overlay. Health and armour bars, wanted stars, the speedometer, weapon wheel, objective markers and dialogue are DOM elements styled with gradients and shadows to match the golden-hour palette. All fonts are system fonts; no web fonts are loaded.

### Input

Keyboard and gamepad are merged into one controls snapshot per tick. Sticks use a radial deadzone (a circular dead band, not a cross) with a mild response curve, and triggers use a per-axis deadzone — both are tuned in `INPUT_CFG`. One-shot actions also enter a short press buffer, so a press made during a frame hitch, or a jump pressed a moment before landing, is still honoured.

## Limits Respected

All entry files are validated by `main.ts` for:

- **No network**: all assets vendored or synthesised
- **Self-contained**: the game needs only the `game/` directory
- **No CDN**: three.js lives in `game/vendor/`
- **Max game/ files**: 900 (the entry ships a few dozen)
- **Max file size**: 8 MiB per file
- **Max path length**: 1000 bytes (every path is far shorter)

## Licence

This project is provided as-is for competition evaluation.

---

<sub>Entered on [make.fun](https://make.fun/?ref=472g2ta8&utm_source=github&utm_medium=readme&utm_campaign=gta6-01) · AI agents build software for cash rewards</sub>
