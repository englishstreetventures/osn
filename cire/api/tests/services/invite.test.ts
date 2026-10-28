/**
 * Compile-time checks on `SLOT_COLUMNS`, the map from each invite image slot to
 * its columns on `wedding_invite_customisations`. `bun run typecheck` checks
 * this file (its second pass covers `tests/`); `bun test` runs nothing here.
 *
 * Drizzle drops an unknown key from `.values()` and `.set()` without a word, so
 * a wrong column name would fail silently at run time. Each `@ts-expect-error`
 * below sits on one wrong entry the compiler must refuse; if the type ever
 * loosens, the directive goes unused and the check fails.
 */
import type { InviteImageSlot } from "../../src/schemas/invite";
import { SLOT_COLUMNS, type SlotColumns } from "../../src/services/invite";

/** The map as shipped, checked here too, so loosening its own `satisfies` is not enough. */
export const pinned: { readonly [S in InviteImageSlot]: SlotColumns<S> } = SLOT_COLUMNS;

export const wrongEntries = [
  {
    key: "storyImageKey",
    // @ts-expect-error a crop column the table does not have
    crop: "storyImageCorp",
    cropMobile: null,
  } satisfies SlotColumns<"story">,
  {
    key: "heroImageKey",
    crop: "heroImageCrop",
    // @ts-expect-error a phone crop column the table does not have
    cropMobile: "heroImageCropMobil",
  } satisfies SlotColumns<"hero">,
  {
    key: "storyImageKey",
    // @ts-expect-error the crop pointed at the slot's own image key
    crop: "storyImageKey",
    cropMobile: null,
  } satisfies SlotColumns<"story">,
  {
    // @ts-expect-error the image key pointed at a copy column
    key: "storyHeading",
    crop: "storyImageCrop",
    cropMobile: null,
  } satisfies SlotColumns<"story">,
  {
    key: "footerImageKey",
    // @ts-expect-error the crop pointed at another slot's crop column
    crop: "storyImageCrop",
    cropMobile: null,
  } satisfies SlotColumns<"footer">,
  {
    // @ts-expect-error the image key shared with another slot
    key: "heroImageKey",
    crop: "storyImageCrop",
    cropMobile: null,
  } satisfies SlotColumns<"story">,
  {
    key: "storyImageKey",
    crop: "storyImageCrop",
    // @ts-expect-error a phone crop on a slot the table gives none
    cropMobile: "heroImageCropMobile",
  } satisfies SlotColumns<"story">,
];
