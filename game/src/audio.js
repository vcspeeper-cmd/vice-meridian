// Every sound in VICE MERIDIAN is synthesised here with the Web Audio API: no sample files.
// Signal flow: voices → per-bus gain (sfx / vehicle / ui / music / ambience) → master gain →
// soft compressor → destination, so many overlapping one-shots (gunfire, glass, sirens) never clip
// and the settings menu can scale everything from one master volume.

// --- Synthesis building blocks -------------------------------------------------------------------

// ADSR envelope on an AudioParam. Times are seconds; `sustain` is a fraction of `peak`.
// Returns the time at which the release has finished, so callers can stop their sources there.
export function applyEnvelope(param, start, { attack = 0.01, decay = 0.08, sustain = 0.6, hold = 0.1, release = 0.2, peak = 1, floor = 0.0001 } = {}) {
  const a = Math.max(0.001, attack);
  const d = Math.max(0.001, decay);
  const r = Math.max(0.005, release);
  const sus = Math.max(floor, peak * sustain);
  param.cancelScheduledValues(start);
  param.setValueAtTime(floor, start);
  param.linearRampToValueAtTime(peak, start + a);
  param.exponentialRampToValueAtTime(sus, start + a + d);
  param.setValueAtTime(sus, start + a + d + Math.max(0, hold));
  const end = start + a + d + Math.max(0, hold) + r;
  param.exponentialRampToValueAtTime(floor, end);
  return end;
}

// Deterministic noise buffers. `colour` is white, pink (Paul Kellet's economy filter) or brown
// (leaky integrated white). Seeded with a Lehmer LCG so every session hears identical noise.
export function createNoiseBuffer(ctx, seconds = 1, colour = 'white', seed = 48271) {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);
  let s = seed % 2147483647 || 1;
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let brown = 0;
  for (let i = 0; i < len; i++) {
    s = (s * 16807) % 2147483647;
    const white = s / 1073741823.5 - 1;
    if (colour === 'pink') {
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.2;
    } else if (colour === 'brown') {
      brown = (brown + 0.02 * white) / 1.02;
      data[i] = brown * 3.5;
    } else {
      data[i] = white;
    }
  }
  return buf;
}

// A serial chain of biquad filters described as plain objects, e.g.
// [{ type: 'highpass', freq: 200 }, { type: 'peaking', freq: 1200, gain: 6, q: 2 }].
// Returns { input, output, filters } so a voice connects to `input` and `output` feeds a bus.
export function createFilterChain(ctx, stages) {
  const filters = stages.map((st) => {
    const f = ctx.createBiquadFilter();
    f.type = st.type || 'lowpass';
    f.frequency.value = st.freq ?? 1000;
    f.Q.value = st.q ?? 0.707;
    if (st.gain !== undefined) f.gain.value = st.gain;
    return f;
  });
  for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1]);
  return { input: filters[0], output: filters[filters.length - 1], filters };
}

// Small mixer: named buses with their own gain, all summed into a master gain and a compressor.
export class AudioMixer {
  constructor(ctx, busLevels = { sfx: 0.9, vehicle: 0.85, ui: 0.6, music: 0.45, ambience: 0.8 }) {
    this.ctx = ctx;
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -16;
    this.compressor.ratio.value = 5;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.2;
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0.9;
    this.masterGain.connect(this.compressor).connect(ctx.destination);
    this.buses = new Map();
    this.levels = {};
    for (const [name, level] of Object.entries(busLevels)) {
      const g = ctx.createGain();
      g.gain.value = level;
      g.connect(this.masterGain);
      this.buses.set(name, g);
      this.levels[name] = level;
    }
    this.volume = 0.9;
    this.muted = false;
  }

  bus(name) {
    return this.buses.get(name) || this.buses.get('sfx');
  }

  setBusLevel(name, level, ramp = 0.05) {
    const g = this.buses.get(name);
    if (!g) return;
    this.levels[name] = Math.max(0, Math.min(1.5, level));
    g.gain.setTargetAtTime(this.levels[name], this.ctx.currentTime, ramp);
  }

  // Duck one bus briefly (e.g. music under a mission-complete jingle) and let it recover.
  duck(name, amount = 0.35, holdSeconds = 1.2) {
    const g = this.buses.get(name);
    if (!g) return;
    const now = this.ctx.currentTime;
    const base = this.levels[name];
    g.gain.cancelScheduledValues(now);
    g.gain.setTargetAtTime(base * amount, now, 0.04);
    g.gain.setTargetAtTime(base, now + holdSeconds, 0.3);
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    this._apply();
  }

  setMuted(m) {
    this.muted = Boolean(m);
    this._apply();
  }

  _apply() {
    this.masterGain.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }
}

// Lookahead pattern scheduler. Patterns are step sequences played at a tempo; `tick()` is called
// from the game loop and schedules every step that falls inside the next `lookahead` seconds on
// the audio clock, so timing stays sample-accurate even when frames hitch.
export class PatternScheduler {
  constructor(ctx, lookahead = 0.18) {
    this.ctx = ctx;
    this.lookahead = lookahead;
    this.tracks = new Map();
  }

  // pattern: { bpm, stepsPerBeat, steps: [note|null...], loop, voice(time, note, stepIndex) }
  play(id, pattern, startDelay = 0.05) {
    this.tracks.set(id, {
      pattern,
      nextTime: this.ctx.currentTime + startDelay,
      step: 0,
      done: false,
    });
  }

  stop(id) {
    this.tracks.delete(id);
  }

  isPlaying(id) {
    return this.tracks.has(id);
  }

  tick() {
    const horizon = this.ctx.currentTime + this.lookahead;
    for (const [id, tr] of this.tracks) {
      const p = tr.pattern;
      const stepDur = 60 / (p.bpm || 120) / (p.stepsPerBeat || 4);
      while (tr.nextTime < horizon) {
        const note = p.steps[tr.step];
        if (note !== null && note !== undefined) p.voice(tr.nextTime, note, tr.step, stepDur);
        tr.step += 1;
        tr.nextTime += stepDur;
        if (tr.step >= p.steps.length) {
          if (p.loop) tr.step = 0;
          else {
            tr.done = true;
            break;
          }
        }
      }
      if (tr.done) this.tracks.delete(id);
    }
  }
}

const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Three in-car radio stations, each a short looping groove written as MIDI step patterns.
export const RADIO_STATIONS = [
  { name: 'WAVE 104 · SYNTH', bpm: 108, bass: [36, null, 36, null, 43, null, 41, null, 36, null, 36, 38, 39, null, 41, null], lead: [72, null, null, 75, null, 79, null, null, 77, null, 75, null, 72, null, null, null], wave: 'sawtooth' },
  { name: 'PALMETTO FM · FUNK', bpm: 96, bass: [33, null, 33, 45, null, 33, 43, null, 31, null, 31, 43, null, 31, 41, 43], lead: [null, 69, null, 72, null, null, 74, null, null, 69, null, 72, null, 76, null, null], wave: 'square' },
  { name: 'DOCKSIDE 88 · DUB', bpm: 76, bass: [31, null, null, null, 31, null, 34, null, 36, null, null, null, 34, null, 31, null], lead: [null, null, 67, null, null, null, 70, null, null, null, 72, null, null, null, 70, null], wave: 'triangle' },
];

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.unlocked = false;
    this.mixer = null;
    this.scheduler = null;
    this.master = null;
    this.engineOsc = null;
    this.engineSub = null;
    this.engineGain = null;
    this.engineFilter = null;
    this.sirenOsc = null;
    this.sirenGain = null;
    this.ambienceGain = null;
    this.screechGain = null;
    this.screechFilter = null;
    this.noiseBuffer = null;
    this.pinkBuffer = null;
    this.brownBuffer = null;
    this.sirenActive = false;
    this.sirenDist = 999;
    this.sirenPhase = 0;
    this.tyreSlip = 0;
    this.stepAccum = 0;
    this.stepAlt = false;
    this.lastStars = 0;
    this.muted = false;
    this.volume = 0.8;
    this.radioIndex = -1;
    this.lastThrottle = 0;
    this.revCooldown = 0;
    this.lastMoney = null;
    this.lastHealth = null;
  }

  unlock() {
    if (this.unlocked) {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    try {
      this.ctx = new AudioCtx();
      this.unlocked = true;

      this.mixer = new AudioMixer(this.ctx);
      this.mixer.setVolume(this.volume);
      this.scheduler = new PatternScheduler(this.ctx);
      // `master` stays the default destination for one-shots so every existing voice lands on sfx.
      this.master = this.mixer.bus('sfx');

      // One second of deterministic white noise for gunfire, impacts and tyres; pink for surf and
      // wind; brown for the low engine rumble layer.
      this.noiseBuffer = createNoiseBuffer(this.ctx, 1, 'white', 48271);
      this.pinkBuffer = createNoiseBuffer(this.ctx, 2, 'pink', 16807);
      this.brownBuffer = createNoiseBuffer(this.ctx, 2, 'brown', 69621);

      // Engine: sawtooth + square sub-octave through a lowpass whose cutoff follows the revs.
      this.engineFilter = this.ctx.createBiquadFilter();
      this.engineFilter.type = 'lowpass';
      this.engineFilter.frequency.value = 340;
      this.engineGain = this.ctx.createGain();
      this.engineGain.gain.value = 0.0;
      this.engineOsc = this.ctx.createOscillator();
      this.engineOsc.type = 'sawtooth';
      this.engineOsc.frequency.value = 58;
      this.engineSub = this.ctx.createOscillator();
      this.engineSub.type = 'square';
      this.engineSub.frequency.value = 29;
      const subGain = this.ctx.createGain();
      subGain.gain.value = 0.35;
      this.engineOsc.connect(this.engineFilter);
      this.engineSub.connect(subGain).connect(this.engineFilter);
      this.engineFilter.connect(this.engineGain).connect(this.mixer.bus('vehicle'));
      this.engineOsc.start();
      this.engineSub.start();
      // Brown-noise rumble under the oscillators gives the idle its mechanical grit.
      const rumble = this.ctx.createBufferSource();
      rumble.buffer = this.brownBuffer;
      rumble.loop = true;
      const rumbleChain = createFilterChain(this.ctx, [{ type: 'lowpass', freq: 180 }, { type: 'peaking', freq: 70, gain: 6, q: 1.4 }]);
      this.rumbleGain = this.ctx.createGain();
      this.rumbleGain.gain.value = 0;
      rumble.connect(rumbleChain.input);
      rumbleChain.output.connect(this.rumbleGain).connect(this.mixer.bus('vehicle'));
      rumble.start();

      // Police siren oscillator (wail between two pitches).
      this.sirenGain = this.ctx.createGain();
      this.sirenGain.gain.value = 0.0;
      this.sirenOsc = this.ctx.createOscillator();
      this.sirenOsc.type = 'triangle';
      this.sirenOsc.frequency.value = 660;
      this.sirenOsc.connect(this.sirenGain).connect(this.mixer.bus('vehicle'));
      this.sirenOsc.start();

      // Continuous tyre-screech bed: band-passed noise whose gain follows lateral slip.
      const scrSrc = this.ctx.createBufferSource();
      scrSrc.buffer = this.noiseBuffer;
      scrSrc.loop = true;
      this.screechFilter = this.ctx.createBiquadFilter();
      this.screechFilter.type = 'bandpass';
      this.screechFilter.frequency.value = 2400;
      this.screechFilter.Q.value = 9;
      this.screechGain = this.ctx.createGain();
      this.screechGain.gain.value = 0;
      scrSrc.connect(this.screechFilter).connect(this.screechGain).connect(this.mixer.bus('vehicle'));
      scrSrc.start();

      // Coastal wind / surf ambience with a slow swell LFO.
      const ambSrc = this.ctx.createBufferSource();
      ambSrc.buffer = this.pinkBuffer;
      ambSrc.loop = true;
      const ambFilter = this.ctx.createBiquadFilter();
      ambFilter.type = 'lowpass';
      ambFilter.frequency.value = 520;
      this.ambienceGain = this.ctx.createGain();
      this.ambienceGain.gain.value = 0.03;
      const swell = this.ctx.createOscillator();
      swell.frequency.value = 0.11;
      const swellDepth = this.ctx.createGain();
      swellDepth.gain.value = 0.015;
      swell.connect(swellDepth).connect(this.ambienceGain.gain);
      swell.start();
      ambSrc.connect(ambFilter).connect(this.ambienceGain).connect(this.mixer.bus('ambience'));
      ambSrc.start();
    } catch {
      this.ctx = null;
      this.mixer = null;
    }
  }

  get ready() {
    return Boolean(this.ctx && this.noiseBuffer && this.master);
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.mixer) this.mixer.setMuted(muted);
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.mixer) this.mixer.setVolume(this.volume);
    // Ensure mixer state stays in sync with engine's tracked volume.
    if (this.mixer && Math.abs(this.mixer.volume - this.volume) > 0.01) {
      this.mixer.setVolume(this.volume);
    }
  }

  setSirenActive(active, distance = 40) {
    this.sirenActive = active;
    this.sirenDist = distance;
  }

  // 0..1 amount of sideways slip on the player's tyres; drives the screech bed.
  setTyreSlip(amount) {
    this.tyreSlip = Math.max(0, Math.min(1, amount));
  }

  update(dt, player, police) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;

    if (player.vehicle) {
      const v = player.vehicle;
      const spd = Math.abs(v.speed);
      const maxSpd = (v.spec && v.spec.maxSpeed) || 40;
      // Fake gearbox: revs climb within each of five gears and drop on shift.
      const ratio = Math.min(0.999, spd / maxSpd);
      const gearPos = (ratio * 5) % 1;
      const pitch = 48 + gearPos * 70 + ratio * 40;
      this.engineOsc.frequency.setTargetAtTime(pitch, now, 0.05);
      this.engineSub.frequency.setTargetAtTime(pitch * 0.5, now, 0.05);
      this.engineFilter.frequency.setTargetAtTime(260 + gearPos * 900, now, 0.06);
      this.engineGain.gain.setTargetAtTime(0.045 + Math.min(0.05, spd * 0.0012), now, 0.08);
      // Idle rumble is loudest at standstill and fades as the oscillators take over.
      this.rumbleGain.gain.setTargetAtTime(0.12 * (1 - ratio) + 0.03, now, 0.1);
      // A throttle stab from low revs triggers a short rev blip.
      const throttle = v.throttleInput !== undefined ? Math.abs(v.throttleInput) : ratio;
      this.revCooldown = Math.max(0, this.revCooldown - dt);
      if (throttle > 0.8 && this.lastThrottle < 0.3 && ratio < 0.35 && this.revCooldown <= 0) {
        this.playEngineRev(0.6 + ratio);
        this.revCooldown = 0.8;
      }
      this.lastThrottle = throttle;

      let slip = this.tyreSlip;
      if (v.lateralSlip !== undefined) slip = Math.max(slip, Math.min(1, Math.abs(v.lateralSlip) / 6));
      this.screechGain.gain.setTargetAtTime(spd > 6 ? slip * 0.07 : 0, now, 0.04);
      this.screechFilter.frequency.setTargetAtTime(2000 + slip * 900, now, 0.05);
      this.stepAccum = 0;
    } else {
      this.engineGain.gain.setTargetAtTime(0.0, now, 0.08);
      this.rumbleGain.gain.setTargetAtTime(0.0, now, 0.08);
      this.screechGain.gain.setTargetAtTime(0.0, now, 0.05);
      if (this.radioIndex >= 0) this.setRadioStation(-1);
      // Footsteps keyed to horizontal speed, alternating left/right pitch — only for players that
      // do not emit their own stride-synced footstep events.
      const hs = player.vel ? Math.hypot(player.vel.x, player.vel.z) : 0;
      if (!player.emitsFootsteps && player.onGround && hs > 1.2 && player.health > 0) {
        this.stepAccum += dt * hs * 0.36;
        if (this.stepAccum >= 1) {
          this.stepAccum -= 1;
          this.playFootstep(hs > 8 ? 1.3 : 1);
        }
      }
    }

    if (this.sirenActive) {
      this.sirenPhase += dt * 4.2;
      const freq = 620 + Math.sin(this.sirenPhase) * 230;
      const atten = Math.max(0, 1 - this.sirenDist / 120);
      this.sirenOsc.frequency.setTargetAtTime(freq, now, 0.03);
      this.sirenGain.gain.setTargetAtTime(0.045 * atten, now, 0.08);
    } else {
      this.sirenGain.gain.setTargetAtTime(0.0, now, 0.08);
    }

    // A rising sweep whenever the wanted level climbs.
    const stars = police ? police.stars || 0 : 0;
    if (stars > this.lastStars) this.playWantedSweep(stars);
    this.lastStars = stars;

    // Cash going up plays the register chime; a sudden health drop plays a dull body hit.
    if (player.money !== undefined) {
      if (this.lastMoney !== null && player.money > this.lastMoney + 0.5) this.playCashPickup(Math.min(3, (player.money - this.lastMoney) / 250));
      this.lastMoney = player.money;
    }
    if (player.health !== undefined) {
      if (this.lastHealth !== null && player.health < this.lastHealth - 4) this.playBodyHit();
      this.lastHealth = player.health;
    }

    if (this.scheduler) this.scheduler.tick();
  }

  // Small helpers for one-shots ------------------------------------------------------------

  _noiseShot(start, dur, type, freq, vol, q = 1) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(vol, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(start, (start * 7.13) % 0.8);
    src.stop(start + dur + 0.02);
    return filter;
  }

  _tone(start, dur, type, freq, vol, endFreq = null) {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, start + dur);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(vol, start + Math.min(0.012, dur * 0.2));
    gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
    osc.connect(gain).connect(this.master);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  playGunshot(pitchScale = 1.0) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    this._noiseShot(now, 0.14, 'bandpass', 950 * pitchScale, 0.24);
    // Low thump body so shots feel weighty, not just hissy.
    this._tone(now, 0.09, 'sine', 160 * pitchScale, 0.18, 45);
  }

  playImpact(strength = 10) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const vol = Math.min(0.26, 0.05 + strength * 0.009);
    this._noiseShot(now, 0.22, 'lowpass', 280, vol);
    if (strength > 14) this.playGlassBreak(Math.min(1, strength / 30));
  }

  playDoor() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    this._tone(now, 0.1, 'sine', 140, 0.14, 48);
    this._noiseShot(now + 0.02, 0.05, 'highpass', 3000, 0.04);
  }

  playMissionChime() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    [523.25, 659.25, 783.99].forEach((freq, i) => this._tone(now + i * 0.1, 0.28, 'triangle', freq, 0.09));
  }

  // Short brass-ish fanfare: arpeggio up, then a held major chord.
  playMissionComplete() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const seq = [392.0, 523.25, 659.25, 783.99, 1046.5];
    seq.forEach((f, i) => {
      this._tone(now + i * 0.09, 0.22, 'square', f, 0.035);
      this._tone(now + i * 0.09, 0.24, 'triangle', f, 0.06);
    });
    const chordAt = now + seq.length * 0.09;
    [523.25, 659.25, 783.99].forEach((f) => this._tone(chordAt, 0.9, 'sawtooth', f, 0.025));
    this._tone(chordAt, 0.9, 'triangle', 261.63, 0.08);
  }

  playMissionFailed() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    [392.0, 369.99, 311.13].forEach((f, i) => this._tone(now + i * 0.22, 0.38, 'sawtooth', f, 0.04, f * 0.97));
    this._tone(now + 0.66, 0.8, 'triangle', 155.56, 0.08, 140);
  }

  // Two-tone rising siren sweep that signals a wanted level increase.
  playWantedSweep(stars = 1) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const base = 420 + stars * 40;
    this._tone(now, 0.32, 'sawtooth', base, 0.035, base * 1.9);
    this._tone(now + 0.3, 0.32, 'sawtooth', base * 1.1, 0.03, base * 2.1);
  }

  playHorn() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    // Two slightly detuned squares through a lowpass = classic car horn.
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1600;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.07, now + 0.02);
    gain.gain.setValueAtTime(0.07, now + 0.32);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
    filter.connect(gain).connect(this.master);
    for (const f of [349, 440]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = f;
      osc.connect(filter);
      osc.start(now);
      osc.stop(now + 0.42);
    }
  }

  playTyreScreech(intensity = 1) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const f = this._noiseShot(now, 0.45, 'bandpass', 2600, 0.08 * intensity, 12);
    f.frequency.setValueAtTime(2600, now);
    f.frequency.linearRampToValueAtTime(1900, now + 0.45);
  }

  // Police-radio chirp: squelch burst plus two quick beeps.
  playRadioBlip() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    this._noiseShot(now, 0.07, 'bandpass', 1800, 0.05, 2);
    this._tone(now + 0.05, 0.06, 'square', 1320, 0.03);
    this._tone(now + 0.13, 0.06, 'square', 990, 0.03);
  }

  playFootstep(weight = 1) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    this.stepAlt = !this.stepAlt;
    this._noiseShot(now, 0.06, 'lowpass', this.stepAlt ? 520 : 440, 0.035 * weight);
  }

  playPunch() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    this._tone(now, 0.12, 'sine', 110, 0.22, 40);
    this._noiseShot(now, 0.08, 'lowpass', 900, 0.12);
  }

  playWhoosh() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const f = this._noiseShot(now, 0.16, 'bandpass', 600, 0.05, 3);
    f.frequency.linearRampToValueAtTime(1800, now + 0.16);
  }

  // Glass shatter: a cluster of short high-Q pings over a bright noise burst.
  playGlassBreak(intensity = 1) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    this._noiseShot(now, 0.3, 'highpass', 4200, 0.08 * intensity);
    const pings = [3520, 4186, 2794, 5274, 3951];
    pings.forEach((f, i) => this._tone(now + i * 0.027, 0.16, 'sine', f, 0.025 * intensity, f * 0.92));
  }

  playWeaponSwitch() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    this._noiseShot(now, 0.03, 'highpass', 2500, 0.06);
    this._noiseShot(now + 0.07, 0.04, 'bandpass', 1400, 0.07, 4);
  }

  playReload() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    this._noiseShot(now, 0.05, 'bandpass', 1100, 0.07, 3);
    this._noiseShot(now + 0.32, 0.06, 'bandpass', 1700, 0.08, 3);
  }

  playPickup() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    this._tone(now, 0.12, 'triangle', 880, 0.07);
    this._tone(now + 0.08, 0.18, 'triangle', 1318.5, 0.07);
  }

  // --- Enveloped voices on named buses -----------------------------------------------------------

  // One oscillator through an optional filter chain with a full ADSR, routed to `bus`.
  _voice(start, { type = 'sine', freq = 440, endFreq = null, glide = 0.1, env = {}, filters = null, bus = 'sfx', detune = 0 }) {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.detune.value = detune;
    osc.frequency.setValueAtTime(freq, start);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, start + glide);
    const gain = this.ctx.createGain();
    const end = applyEnvelope(gain.gain, start, env);
    if (filters) {
      const chain = createFilterChain(this.ctx, filters);
      osc.connect(chain.input);
      chain.output.connect(gain);
    } else {
      osc.connect(gain);
    }
    gain.connect(this.mixer.bus(bus));
    osc.start(start);
    osc.stop(end + 0.02);
    return end;
  }

  // Enveloped noise burst through a filter chain on a bus.
  _noiseVoice(start, { buffer = null, env = {}, filters = [{ type: 'bandpass', freq: 1000 }], bus = 'sfx', rate = 1 }) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer || this.noiseBuffer;
    src.playbackRate.value = rate;
    const chain = createFilterChain(this.ctx, filters);
    const gain = this.ctx.createGain();
    const end = applyEnvelope(gain.gain, start, env);
    src.connect(chain.input);
    chain.output.connect(gain).connect(this.mixer.bus(bus));
    src.start(start, (start * 3.7) % 0.5);
    src.stop(end + 0.02);
    return chain;
  }

  // Engine rev blip: the pitch flares up and settles, with a growl from a detuned pair.
  playEngineRev(amount = 1) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const base = 70 + amount * 20;
    const env = { attack: 0.03, decay: 0.25, sustain: 0.3, hold: 0.05, release: 0.25, peak: 0.07 * amount };
    const filters = [{ type: 'lowpass', freq: 900, q: 2 }];
    this._voice(now, { type: 'sawtooth', freq: base, endFreq: base * 2.6, glide: 0.18, env, filters, bus: 'vehicle' });
    this._voice(now, { type: 'sawtooth', freq: base * 1.01, endFreq: base * 2.5, glide: 0.2, env, filters, bus: 'vehicle', detune: 12 });
  }

  // Cash register: a bright two-note bell over a short noise "ching".
  playCashPickup(amount = 1) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const bell = { attack: 0.003, decay: 0.18, sustain: 0.25, hold: 0.02, release: 0.35, peak: 0.06 };
    this._voice(now, { type: 'sine', freq: 1975.5, env: bell, bus: 'ui' });
    this._voice(now + 0.07, { type: 'sine', freq: 2637, env: bell, bus: 'ui' });
    if (amount > 1.5) this._voice(now + 0.14, { type: 'sine', freq: 3136, env: bell, bus: 'ui' });
    this._noiseVoice(now, { env: { attack: 0.002, decay: 0.05, sustain: 0.1, hold: 0, release: 0.05, peak: 0.04 }, filters: [{ type: 'highpass', freq: 5000 }], bus: 'ui' });
  }

  // Dull body hit when the player is wounded.
  playBodyHit() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    this._voice(now, { type: 'sine', freq: 90, endFreq: 42, glide: 0.12, env: { attack: 0.004, decay: 0.08, sustain: 0.2, hold: 0, release: 0.1, peak: 0.16 } });
    this._noiseVoice(now, { buffer: this.brownBuffer, env: { attack: 0.002, decay: 0.06, sustain: 0.2, hold: 0, release: 0.08, peak: 0.2 }, filters: [{ type: 'lowpass', freq: 400 }] });
  }

  // UI hover: a soft high tick. UI click: a two-layer confirm blip.
  playUiHover() {
    if (!this.ready) return;
    this._voice(this.ctx.currentTime, { type: 'triangle', freq: 1760, env: { attack: 0.002, decay: 0.03, sustain: 0.1, hold: 0, release: 0.04, peak: 0.025 }, bus: 'ui' });
  }

  playUiClick() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    this._voice(now, { type: 'square', freq: 880, env: { attack: 0.002, decay: 0.04, sustain: 0.2, hold: 0, release: 0.05, peak: 0.03 }, filters: [{ type: 'lowpass', freq: 3000 }], bus: 'ui' });
    this._voice(now + 0.045, { type: 'triangle', freq: 1320, env: { attack: 0.002, decay: 0.05, sustain: 0.2, hold: 0, release: 0.08, peak: 0.04 }, bus: 'ui' });
  }

  // Dry-fire click when the magazine is empty.
  playReloadClick() {
    if (!this.ready) return;
    this._noiseVoice(this.ctx.currentTime, { env: { attack: 0.001, decay: 0.015, sustain: 0.1, hold: 0, release: 0.02, peak: 0.12 }, filters: [{ type: 'bandpass', freq: 3200, q: 6 }] });
  }

  // Brass casing bouncing on asphalt: three decaying metallic pings.
  playShellCasing() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const t = now + 0.18 + i * (0.09 - i * 0.02);
      this._voice(t, { type: 'sine', freq: 5200 - i * 300, env: { attack: 0.001, decay: 0.02, sustain: 0.2, hold: 0, release: 0.05, peak: 0.018 / (i + 1) } });
    }
  }

  // Police "yelp": a fast up-down siren sweep used when a cruiser joins the chase.
  playSirenYelp() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    for (let i = 0; i < 4; i++) {
      const t = now + i * 0.16;
      this._voice(t, { type: 'sawtooth', freq: 700, endFreq: 1500, glide: 0.08, env: { attack: 0.005, decay: 0.05, sustain: 0.7, hold: 0.04, release: 0.05, peak: 0.03 }, filters: [{ type: 'lowpass', freq: 2600 }], bus: 'vehicle' });
    }
  }

  // --- In-car radio -----------------------------------------------------------------------------

  get radioName() {
    return this.radioIndex >= 0 ? RADIO_STATIONS[this.radioIndex].name : 'RADIO OFF';
  }

  // -1 switches the radio off. Every station change plays the tuning blip.
  setRadioStation(index) {
    if (!this.ready) {
      this.radioIndex = -1;
      return;
    }
    this.scheduler.stop('radio-bass');
    this.scheduler.stop('radio-lead');
    this.radioIndex = index >= 0 && index < RADIO_STATIONS.length ? index : -1;
    this.playRadioBlip();
    if (this.radioIndex < 0) return;
    const st = RADIO_STATIONS[this.radioIndex];
    const bassVoice = (time, note, _step, dur) => {
      this._voice(time, { type: 'square', freq: midiToHz(note), env: { attack: 0.005, decay: dur * 0.6, sustain: 0.4, hold: 0, release: dur * 0.5, peak: 0.06 }, filters: [{ type: 'lowpass', freq: 420, q: 4 }], bus: 'music' });
    };
    const leadVoice = (time, note, _step, dur) => {
      this._voice(time, { type: st.wave, freq: midiToHz(note), env: { attack: 0.01, decay: dur, sustain: 0.5, hold: dur * 0.5, release: dur * 1.5, peak: 0.025 }, filters: [{ type: 'lowpass', freq: 2400 }, { type: 'peaking', freq: 1200, gain: 4, q: 1 }], bus: 'music' });
    };
    this.scheduler.play('radio-bass', { bpm: st.bpm, stepsPerBeat: 4, steps: st.bass, loop: true, voice: bassVoice }, 0.25);
    this.scheduler.play('radio-lead', { bpm: st.bpm, stepsPerBeat: 4, steps: st.lead, loop: true, voice: leadVoice }, 0.25);
  }

  cycleRadio(dir = 1) {
    const count = RADIO_STATIONS.length + 1;
    const next = (((this.radioIndex + 1 + dir) % count) + count) % count;
    this.setRadioStation(next - 1);
    return this.radioName;
  }

  // Jingle and sting that duck the radio while they play.
  playMissionJingle(success = true) {
    if (!this.ready) return;
    this.mixer.duck('music', 0.2, success ? 1.8 : 1.6);
    if (success) this.playMissionComplete();
    else this.playMissionFailed();
  }

  // Wire hover/click sounds onto every button in the front-end menu.
  attachUiSounds(root) {
    if (!root) return;
    root.addEventListener('pointerover', (e) => {
      if (e.target && e.target.closest && e.target.closest('button, select, input')) this.playUiHover();
    });
    root.addEventListener('click', (e) => {
      if (e.target && e.target.closest && e.target.closest('button, select, input')) this.playUiClick();
    });
  }
}
