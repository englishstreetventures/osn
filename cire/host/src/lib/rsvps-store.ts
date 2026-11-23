// The wedding's RSVP replies (`GET …/rsvps`) and the Overview's "RSVP changes"
// card (`GET …/rsvp-changes`), cached per wedding.
//
// The replies hold names, household codes and dietary answers; like every
// organiser cache they stay in memory only while the wedding's dashboard is on
// screen (`wedding-caches.ts`). Guests change both values from the invitation
// and no push reaches the portal for it, so each is read again once it is a
// minute old.
//
// The RSVP table marks each change it shows as seen, from the badge rows it
// reads beside the replies (`…/rsvp-changes/rows`). Replies the Overview read
// came with no badge rows, so the table reads both again rather than draw a
// table that never marks anything: `withBadges` says which read a value came
// from. A write that changes what the replies hold (the guest list, the
// schedule, the codes) drops the value through `guest-list-changed.ts`; a reply
// the table records patches it.
//
// Frontend code: no Effect.
import type { RsvpChanges } from "./rsvp-changes";
import type { RsvpFilterEvent } from "./rsvp-filter";
import { CACHE_MAX_AGE_MS, createWeddingCache } from "./wedding-cache";

/** One event's replies and tallies as `GET …/rsvps` gives them. */
export interface RsvpEvent extends RsvpFilterEvent {
  id: string;
  name: string;
  invited: number;
  attending: number;
  declined: number;
  maybe: number;
  responded: number;
  noResponse: number;
}

export interface RsvpReplies {
  events: RsvpEvent[];
  /** Read by the RSVP table together with its badge rows. */
  withBadges: boolean;
}

const replies = createWeddingCache<RsvpReplies>({ maxAgeMs: CACHE_MAX_AGE_MS });

export const rsvpsAccessor = (weddingId: string) => replies.accessor(weddingId);
/** Fresh replies the table read with its badges: a visit to the table that
 *  finds these has nothing to mark and nothing to read. */
export const hasTableRsvps = (weddingId: string) =>
  replies.has(weddingId) && replies.peek(weddingId)?.withBadges === true;
export const peekCachedRsvps = (weddingId: string) => replies.peek(weddingId);
export const ensureRsvpsLoaded = (weddingId: string, fetcher: () => Promise<RsvpReplies>) =>
  replies.ensureLoaded(weddingId, fetcher);

/** Replace the events after a reply the table recorded: a new array, never the
 *  table's own store objects. */
export function setCachedRsvpEvents(weddingId: string, events: RsvpEvent[]): void {
  const now = replies.peek(weddingId);
  if (now) replies.setCached(weddingId, { ...now, events });
}

export const invalidateRsvps = (weddingId: string) => replies.invalidate(weddingId);
/** A read of the table's was refused: nobody draws the cached replies. */
export const refuseRsvps = (weddingId: string) => replies.refuse(weddingId);

const changes = createWeddingCache<RsvpChanges>({ maxAgeMs: CACHE_MAX_AGE_MS });

export const rsvpChangesAccessor = (weddingId: string) => changes.accessor(weddingId);
export const ensureRsvpChangesLoaded = (weddingId: string, fetcher: () => Promise<RsvpChanges>) =>
  changes.ensureLoaded(weddingId, fetcher);
/** The card after a change of its own (the digest switch). */
export const setCachedRsvpChanges = (weddingId: string, next: RsvpChanges) =>
  changes.setCached(weddingId, next);
/**
 * The RSVP table marked changes seen, so the card's count is out of date: it
 * is read again on the Overview's next visit. When the table read and marked
 * every change there was, the card says nothing is unseen meanwhile, rather
 * than naming households the organiser has just looked at.
 */
export function noteRsvpChangesSeen(weddingId: string, everyChangeSeen: boolean): void {
  const card = changes.peek(weddingId);
  if (everyChangeSeen && card) {
    changes.setCached(weddingId, { ...card, households: 0, truncated: false, items: [] });
  }
  changes.invalidate(weddingId);
}

export function dropRsvps(weddingId: string): void {
  replies.drop(weddingId);
  changes.drop(weddingId);
}

/** Test-only. */
export function __resetRsvpsCache(): void {
  replies.reset();
  changes.reset();
}
