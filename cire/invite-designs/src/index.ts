/** One entry in the invite design catalog. */
export interface DesignMeta {
  readonly id: string;
  /** Display name shown in the organiser selector. */
  readonly name: string;
  /** `premium` requires the wedding's `premium_templates` entitlement. */
  readonly tier: "free" | "premium";
}

/**
 * The invite design catalog — single source of truth for design ids, names and
 * entitlement tiers. `@cire/api` validates writes against it, the organiser
 * renders the selector from it, and `@cire/web` keys its design registry off
 * the derived `DesignId` union (a catalog entry without a matching component
 * pack is a type error there). Catalog: `classic` and `gala`, both free; the
 * gate for `premium` tiers is built and tested but dormant.
 */
export const DESIGNS = [
  { id: "classic", name: "Classic", tier: "free" },
  { id: "gala", name: "Gala", tier: "free" },
] as const satisfies readonly DesignMeta[];

/** Union of catalog design ids (`"classic" | "gala"`). */
export type DesignId = (typeof DESIGNS)[number]["id"];

/** The design every wedding starts on and every unknown id falls back to. */
export const DEFAULT_DESIGN_ID = "classic" satisfies DesignId;

/** Whether `value` is a catalog design id. */
export function isDesignId(value: unknown): value is DesignId {
  return typeof value === "string" && DESIGNS.some((d) => d.id === value);
}
