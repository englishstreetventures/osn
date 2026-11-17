// The wedding's invite (`GET …/invite`), cached per wedding: the invite message
// the guest list copies, the hero and story Getting started checks, and the
// whole builder's state.
//
// The invite builder writes every answer it holds into it — each read, each
// save's answer, its FAQs — so a later visit opens on the invite as last seen.
// A tier change can change what the builder is offered, so it drops the value.
// A co-host's edit shows once the value is a minute old.
//
// Frontend code: no Effect.
import type { InviteCustomisation } from "../components/invite/model";
import { CACHE_MAX_AGE_MS, createWeddingCache } from "./wedding-cache";

const cache = createWeddingCache<InviteCustomisation>({ maxAgeMs: CACHE_MAX_AGE_MS });

export const inviteAccessor = (weddingId: string) => cache.accessor(weddingId);
export const hasCachedInvite = (weddingId: string) => cache.has(weddingId);
export const peekCachedInvite = (weddingId: string) => cache.peek(weddingId);
export const ensureInviteLoaded = (
  weddingId: string,
  fetcher: () => Promise<InviteCustomisation>,
) => cache.ensureLoaded(weddingId, fetcher);
/** A body the API just answered with, read or write. */
export const setFreshInvite = (weddingId: string, invite: InviteCustomisation) =>
  cache.setFresh(weddingId, invite);
export const invalidateInvite = (weddingId: string) => cache.invalidate(weddingId);
/** The builder's own read was refused: nobody draws the cached invite. */
export const refuseInvite = (weddingId: string) => cache.refuse(weddingId);
export const dropInvite = (weddingId: string) => cache.drop(weddingId);
/** Test-only. */
export const __resetInviteCache = () => cache.reset();

/** The FAQ list the builder now holds, onto a loaded invite. */
export function patchInviteFaqs(
  weddingId: string,
  faqs: InviteCustomisation["faqs"] | undefined,
): void {
  const invite = cache.peek(weddingId);
  if (invite && faqs) cache.setCached(weddingId, { ...invite, faqs });
}

/** The invite, when still fresh. */
export function freshInvite(weddingId: string): InviteCustomisation | null {
  return cache.has(weddingId) ? cache.peek(weddingId) : null;
}
