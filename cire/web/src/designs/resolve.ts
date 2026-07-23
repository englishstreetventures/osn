import { DEFAULT_DESIGN_ID, isDesignId, type DesignId } from "@cire/invite-designs";

/**
 * Resolve a stored design id to a renderable catalog id. Unknown, missing, or
 * malformed ids fall back to the default design — a guest invite must never
 * 500 (or render blank) because a wedding row references a design this deploy
 * doesn't ship. Kept free of `.astro` imports so vitest can exercise it (the
 * registry itself can't be unit-tested — vitest can't load Astro components).
 */
export function resolveDesignId(value: unknown): DesignId {
  return isDesignId(value) ? value : DEFAULT_DESIGN_ID;
}
