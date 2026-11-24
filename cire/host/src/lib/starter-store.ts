// The starter checklist's preview (`GET …/tasks/templates/starter`), cached per
// wedding so the dialog opens at once on a later visit.
//
// The preview marks each item new, already added or deleted by the couple, and
// dates it from the wedding date, so it is out of date as soon as the tasks
// change: the tasks store marks it stale on every change it learns of (its own
// writes, a push, a wedding date this tab changed). A co-host's date change
// sends no push when no task moves, which the cache's max age covers.
//
// Frontend code: no Effect.
import { CACHE_MAX_AGE_MS, createWeddingCache } from "./wedding-cache";

/** One template item as the preview gives it. */
export interface StarterPreviewItem {
  key: string;
  title: string;
  timeframeBucket: string;
  /** `YYYY-MM-DD`, or null when the wedding has no date. */
  dueAt: string | null;
  /** `added`: on the checklist already. `removed`: the couple deleted it. */
  state: "new" | "added" | "removed";
}

export interface StarterPreview {
  weddingDate: string | null;
  items: StarterPreviewItem[];
}

const cache = createWeddingCache<StarterPreview>({ maxAgeMs: CACHE_MAX_AGE_MS });

export const starterPreviewAccessor = (weddingId: string) => cache.accessor(weddingId);
export const hasStarterPreview = (weddingId: string) => cache.has(weddingId);
export const ensureStarterPreviewLoaded = (
  weddingId: string,
  fetcher: () => Promise<StarterPreview>,
) => cache.ensureLoaded(weddingId, fetcher);
export const invalidateStarterPreview = (weddingId: string) => cache.invalidate(weddingId);
export const dropStarterPreview = (weddingId: string) => cache.drop(weddingId);
/** Test-only. */
export const __resetStarterPreview = () => cache.reset();
