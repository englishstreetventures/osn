import type { DesignId } from "@cire/invite-designs";

import ClassicDocument from "./classic/Document.astro";

/** One renderable design pack. */
export interface DesignEntry {
  /** Full-page Astro document — owns fonts, preloads, and which islands ship. */
  Document: typeof ClassicDocument;
}

/**
 * Design id → component tree. Keyed by the shared catalog's `DesignId` union,
 * so adding a catalog entry without a matching pack is a type error here.
 * Never index this with a raw string — go through `resolveDesignId` so
 * unknown/missing ids fall back to classic (a guest invite must never 500).
 * NOTE: imports `.astro`, so vitest must never import this module — pure logic
 * belongs in `resolve.ts`.
 */
export const registry: Record<DesignId, DesignEntry> = {
  classic: { Document: ClassicDocument },
};
