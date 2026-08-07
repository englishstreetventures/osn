// Client mirror of the server's service-category list
// (cire/api/src/lib/service-categories.ts). The organiser can't import cire/api,
// so the labels + order live here too — keep the two in sync when a category is
// added or a label reworded ([[platform-plan]] §4.3).
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

export function categoryLabel(key: string): string {
  return SERVICE_CATEGORIES.find((c) => c.key === key)?.label ?? key;
}
