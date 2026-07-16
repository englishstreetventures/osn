/**
 * The closed set of wedding service categories, in display order. Single source
 * of truth for the SERVER: the Budget HTTP schema's category enum derives from
 * THIS list ([[platform-plan]] §4.3). Budget v1 is the first consumer; Vendors
 * and the pricing engine reuse it later. The organiser client keeps its own
 * label mirror (it can't import cire/api) — keep the two in sync when a category
 * is added or a label reworded. `other` is the required catch-all (always last).
 */
export const SERVICE_CATEGORIES = [
  { key: "venue", label: "Venue" },
  { key: "catering", label: "Catering" },
  { key: "photography", label: "Photography" },
  { key: "videography", label: "Videography" },
  { key: "decor_styling", label: "Décor & styling" },
  { key: "florals", label: "Florals" },
  { key: "music_entertainment", label: "Music & entertainment" },
  { key: "celebrant", label: "Celebrant" },
  { key: "cake", label: "Cake" },
  { key: "stationery", label: "Stationery" },
  { key: "hair_makeup", label: "Hair & makeup" },
  { key: "transport", label: "Transport" },
  { key: "attire", label: "Attire" },
  { key: "other", label: "Other" },
] as const;

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number]["key"];

export const SERVICE_CATEGORY_KEYS = SERVICE_CATEGORIES.map((c) => c.key);

export function isServiceCategory(value: string): value is ServiceCategory {
  return (SERVICE_CATEGORY_KEYS as readonly string[]).includes(value);
}
