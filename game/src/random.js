// Deterministic randomness for world generation and simulation.
// Core generator: xoshiro128** (Blackman & Vigna), 128-bit state, seeded through splitmix32 so
// that small/sequential seeds still produce well-mixed, independent streams.
// Same seed → same sequence → same world, on every run and every browser.

// Initial state mixer: splitmix32 turns any 32-bit seed into four well-distributed words, so
// neighbouring seeds (1, 2, 3 …) start from completely different points in the state space.
function splitmix32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 15)) >>> 0;
  };
}

// 32-bit left rotate used by the xoshiro state transition.
function rotl(x, k) {
  return (x << k) | (x >>> (32 - k));
}

// True when the four-word state has at least one non-zero word. xoshiro is degenerate at zero.
function stateIsLive(s) {
  return (s[0] | s[1] | s[2] | s[3]) !== 0;
}

export class SeededRandom {
  constructor(seed = 1) {
    const mix = splitmix32((Number(seed) >>> 0) || 1);
    this.s = new Uint32Array(4);
    this.s[0] = mix();
    this.s[1] = mix();
    this.s[2] = mix();
    this.s[3] = mix();
    // splitmix32 can only reach zero through an (astronomically unlikely) collision; guard anyway.
    if (!stateIsLive(this.s)) this.s[0] = 0x9e3779b9;
    this.seed = (Number(seed) >>> 0) || 1;
  }

  // Next raw 32-bit unsigned integer via the xoshiro128** permutation.
  nextUint32() {
    const s = this.s;
    const result = Math.imul(rotl(Math.imul(s[1], 5), 7), 9) >>> 0;
    const t = s[1] << 9;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return result;
  }

  // Uniform float in [0, 1) — 32 bits of mantissa precision.
  next() {
    return this.nextUint32() / 4294967296;
  }

  // Uniform float in [min, max).
  range(min, max) {
    return min + (max - min) * this.next();
  }

  // Integer in [min, max], both ends inclusive.
  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  // Uniformly chosen element of an array. Callers pass non-empty arrays.
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  // Bernoulli trial: true with probability p.
  chance(p) {
    return this.next() < p;
  }

  // Symmetric value in [-mag, mag].
  spread(mag) {
    return (this.next() * 2 - 1) * mag;
  }

  // Approximately normal distribution (Irwin–Hall with four samples), mean 0, std ≈ sd.
  gaussian(sd = 1) {
    const sum = this.next() + this.next() + this.next() + this.next();
    return (sum - 2) * sd * 1.7320508;
  }

  // Pick from a weighted list. Items are either { weight, ... } objects or [value, weight] pairs;
  // objects are returned whole so callers can read their other fields.
  weighted(items) {
    let total = 0;
    for (const item of items) total += Array.isArray(item) ? item[1] : item.weight;
    let roll = this.next() * total;
    for (const item of items) {
      roll -= Array.isArray(item) ? item[1] : item.weight;
      if (roll <= 0) return Array.isArray(item) ? item[0] : item;
    }
    // Fall through only when rounding leaves roll just above zero: the last entry wins.
    const last = items[items.length - 1];
    return Array.isArray(last) ? last[0] : last;
  }

  // In-place Fisher–Yates shuffle; returns the same array for chaining.
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const held = arr[i];
      arr[i] = arr[j];
      arr[j] = held;
    }
    return arr;
  }

  // Independent child stream keyed by `salt`. Forking does not advance this generator, so
  // adding a new subsystem never shifts the streams of the ones that already exist.
  fork(salt) {
    const h = Math.imul((salt | 0) ^ 0x5bd1e995, 0x27d4eb2d) >>> 0;
    const mixed = (this.s[0] ^ rotl(this.s[1], 7) ^ rotl(this.s[2], 13) ^ rotl(this.s[3], 19) ^ h) >>> 0;
    return new SeededRandom(mixed || 1337);
  }

  // Snapshot the full generator state for replay.
  getState() {
    return Array.from(this.s);
  }

  // Restore the generator from a saved state.
  setState(state) {
    for (let i = 0; i < 4; i++) this.s[i] = state[i] >>> 0;
    // A saved all-zero state would make nextUint32() return zero forever; re-seed instead.
    if (!stateIsLive(this.s)) this.s[0] = 0x9e3779b9;
  }

  // Verify the generator is in a valid (non-degenerate) state.
  isValid() {
    return stateIsLive(this.s);
  }
}

// Stateless helper functions, usable with any SeededRandom instance (or a look-alike).

export function range(rng, min, max) {
  return rng.range(min, max);
}

export function pick(rng, arr) {
  return rng.pick(arr);
}

export function chance(rng, p) {
  return rng.chance(p);
}

// Stateless 2-D hash → [0, 1): handy for per-cell decisions that must not consume a stream.
export function hash2(x, y, seed = 0) {
  let h = Math.imul((x | 0) ^ 0x27d4eb2d, 0x165667b1) ^ Math.imul((y | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

// Small math helpers shared across the city, vehicle and camera code.

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Frame-rate independent exponential approach from a toward b.
export function damp(a, b, lambda, dt) {
  return lerp(a, b, 1 - Math.exp(-lambda * dt));
}

export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

// Fold an angle into (-π, π] so heading deltas never take the long way round.
export function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
