/**
 * A round trip through the coordination store, for `GET /health/coordination`:
 * write a value under a fresh key the server makes, read it back, remove it.
 * No caller input reaches the store, so the probe can only ever touch its own
 * entries.
 */

import type { CoordinationClient } from "@shared/coordination";

/** How long a probe entry lives if its remove never lands. */
export const PROBE_TTL_MS = 60_000;

export interface CoordinationProbe {
  /**
   * True when the value written under a fresh key reads back unchanged and
   * the remove finds it. Rejects when the store fails.
   */
  roundTrip(): Promise<boolean>;
}

/** The three calls a probe makes, as the coordination client answers them. */
export type ProbeTarget = Pick<CoordinationClient, "write" | "read" | "remove">;

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export function createCoordinationProbe(target: ProbeTarget): CoordinationProbe {
  return {
    async roundTrip() {
      const key = randomHex(16);
      const value = randomHex(16);
      await target.write(key, value, PROBE_TTL_MS);
      const read = await target.read(key);
      const removed = await target.remove(key);
      return read === value && removed;
    },
  };
}

/** A probe target in this process's memory, with the store's expiry rule. */
export function createMemoryProbeTarget(): ProbeTarget {
  const entries = new Map<string, { readonly value: string; readonly exp: number }>();
  const live = (key: string) => {
    const entry = entries.get(key);
    return entry && entry.exp > Date.now() ? entry : undefined;
  };
  return {
    async write(key, value, ttlMs) {
      entries.set(key, { value, exp: Date.now() + ttlMs });
    },
    async read(key) {
      return live(key)?.value ?? null;
    },
    async remove(key) {
      const found = live(key) !== undefined;
      entries.delete(key);
      return found;
    },
  };
}
