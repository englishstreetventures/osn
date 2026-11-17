// The wedding's profile (`GET …/settings`), cached per wedding: the date, the
// guest estimate, the currency and budget total the Overview shows, and the
// form Settings › Profile seeds from.
//
// Written by the profile save with the API's answer, and patched by the budget
// total. A co-host's edit shows once the value is a minute old.
//
// Frontend code: no Effect.
import { CACHE_MAX_AGE_MS, createWeddingCache } from "./wedding-cache";

export interface WeddingSettings {
  id: string;
  slug: string;
  displayName: string;
  weddingDate: string | null;
  guestCountEstimate: number | null;
  currency: string;
  budgetTotalMinor: number | null;
  /** The "kindly respond by" date (`YYYY-MM-DD`), or null for no deadline. */
  rsvpDeadline: string | null;
  /** IANA zone the deadline day is measured in; null ⇒ UTC. */
  rsvpDeadlineTimezone: string | null;
}

const cache = createWeddingCache<WeddingSettings>({ maxAgeMs: CACHE_MAX_AGE_MS });

export const settingsAccessor = (weddingId: string) => cache.accessor(weddingId);
export const hasCachedSettings = (weddingId: string) => cache.has(weddingId);
export const peekCachedSettings = (weddingId: string) => cache.peek(weddingId);
export const ensureSettingsLoaded = (weddingId: string, fetcher: () => Promise<WeddingSettings>) =>
  cache.ensureLoaded(weddingId, fetcher);
/** The profile the save answered with: the newest there is. */
export const setFreshSettings = (weddingId: string, settings: WeddingSettings) =>
  cache.setFresh(weddingId, settings);

/** The budget total, saved from the Budget view, onto a loaded profile. */
export function patchBudgetTotal(weddingId: string, budgetTotalMinor: number | null): void {
  const settings = cache.peek(weddingId);
  if (settings) cache.setCached(weddingId, { ...settings, budgetTotalMinor });
}

export const dropSettings = (weddingId: string) => cache.drop(weddingId);
/** Test-only. */
export const __resetSettingsCache = () => cache.reset();
