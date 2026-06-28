// Deterministic, seedable PRNG utilities for the procedural vine system. Every
// random choice in a vine flows from one of these so the SAME seed always yields
// the SAME vine — that's what lets the server prerender the roots and the client
// regrow an identical (or, with a fresh seed, a newly unique) plant without any
// Date.now()/Math.random() leaking nondeterminism in.

/** Hash an arbitrary string into a well-mixed 32-bit seed (xmur3). */
export function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** mulberry32 — tiny, fast, well-distributed 32-bit PRNG. Returns floats in [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A small bundle of seeded helpers built over one stream. */
export interface Rng {
  /** Next float in [0, 1). */
  next(): number;
  /** Float in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Pick one element. */
  pick<T>(items: readonly T[]): T;
  /** Symmetric jitter in [-amount, amount). */
  jitter(amount: number): number;
}

/** Build an {@link Rng} from a string seed (deterministic across server + client). */
export function makeRng(seed: string): Rng {
  const next = mulberry32(xmur3(seed)());
  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)]!,
    jitter: (amount) => (next() * 2 - 1) * amount,
  };
}

/**
 * A fresh, URL-safe random seed string for a new page load. Uses crypto when
 * available (client), falling back to a time-free constant only in environments
 * without it — callers on the server should pass an explicit seed instead.
 */
export function randomSeed(): string {
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    const buf = new Uint32Array(2);
    crypto.getRandomValues(buf);
    return buf[0]!.toString(36) + buf[1]!.toString(36);
  }
  return "cire-static-seed";
}
