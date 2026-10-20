// A `weddingId`-keyed cache of a wedding's seats (`GET …/hosts`), for the
// checklist: it names who holds each task, and the task drawer offers them as
// assignees. The sibling of `tasks-store.ts`, with the same stale-while-
// revalidate contract (wiki/cire/cire-host-portal-layout.md §Organiser client
// caches) and the same lifetime, dropped with the wedding's other caches.
//
// The co-host panel keeps its own list, because it writes that list a row at
// a time; it marks this one stale after a removal. Effect is deliberately NOT
// imported (frontend code).
import { type Accessor, createSignal, type Setter } from "solid-js";

import type { WeddingRole } from "./wedding-roles";
import { isWeddingClosed } from "./wedding-scope";

/** One seat as `GET …/hosts` returns it, reduced to what the checklist reads. */
export interface HostSeat {
  /** The seat id — what a task's `assignedHostId` names. */
  hostId: string;
  osnProfileId: string;
  /** Absent when OSN could not resolve the profile. */
  handle?: string;
  displayName?: string;
  role: WeddingRole;
}

/** What a seat is called on screen: the person's name, then their handle, and
 *  the profile id only when OSN could resolve neither. */
export function seatName(seat: HostSeat): string {
  if (seat.displayName) return seat.displayName;
  if (seat.handle) return `@${seat.handle}`;
  return seat.osnProfileId;
}

interface CacheEntry {
  hosts: Accessor<HostSeat[] | null>;
  setHosts: Setter<HostSeat[] | null>;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<boolean>>();
/** Bumped by every invalidate and drop, so a load started before one caches nothing. */
const generation = new Map<string, number>();
const generationOf = (weddingId: string) => generation.get(weddingId) ?? 0;
/** Weddings whose seats are known out of date but still worth showing. */
const stale = new Set<string>();

function entryFor(weddingId: string): CacheEntry {
  let entry = cache.get(weddingId);
  if (!entry) {
    const [hosts, setHosts] = createSignal<HostSeat[] | null>(null);
    entry = { hosts, setHosts };
    cache.set(weddingId, entry);
  }
  return entry;
}

/** The subscribing read: `null` until the seats have loaded. */
export function hostsAccessor(weddingId: string): Accessor<HostSeat[] | null> {
  return entryFor(weddingId).hosts;
}

/** Are the cached seats fresh? `false` before the first load and while stale —
 *  the refetch trigger, not a render gate. */
export function hasCachedHosts(weddingId: string): boolean {
  return !stale.has(weddingId) && cache.get(weddingId)?.hosts() != null;
}

/** Mark the seats stale. They stay on screen; the next `ensureHostsLoaded`
 *  fetches, and a load already in flight discards what it gets. */
export function invalidateHosts(weddingId: string): void {
  stale.add(weddingId);
  inflight.delete(weddingId);
  generation.set(weddingId, generationOf(weddingId) + 1);
}

/**
 * Fetch the seats unless they are fresh; concurrent callers share one request.
 * A refused or failed fetch blanks the seats and rethrows: names read under an
 * authorisation the request could not confirm stop being shown.
 */
export function ensureHostsLoaded(
  weddingId: string,
  fetcher: () => Promise<HostSeat[]>,
): Promise<boolean> {
  if (isWeddingClosed(weddingId)) return Promise.resolve(false);
  if (hasCachedHosts(weddingId)) return Promise.resolve(true);
  let pending = inflight.get(weddingId);
  if (!pending) {
    const startedAt = generationOf(weddingId);
    const load = fetcher()
      .then(
        (hosts) => {
          if (generationOf(weddingId) !== startedAt || isWeddingClosed(weddingId)) return false;
          entryFor(weddingId).setHosts(hosts);
          stale.delete(weddingId);
          return true;
        },
        (err: unknown) => {
          if (generationOf(weddingId) === startedAt) {
            entryFor(weddingId).setHosts(null);
            stale.delete(weddingId);
          }
          throw err;
        },
      )
      .finally(() => {
        if (inflight.get(weddingId) === load) inflight.delete(weddingId);
      });
    pending = load;
    inflight.set(weddingId, pending);
  }
  return pending;
}

/** Forget a wedding's seats. A view still holding the old accessor reads
 *  `null` from then on. */
export function dropHosts(weddingId: string): void {
  cache.get(weddingId)?.setHosts(null);
  cache.delete(weddingId);
  inflight.delete(weddingId);
  stale.delete(weddingId);
  generation.set(weddingId, generationOf(weddingId) + 1);
}

/** Test-only: clear the whole cache so each test starts cold. */
export function __resetHostsCache(): void {
  cache.clear();
  inflight.clear();
  generation.clear();
  stale.clear();
}
