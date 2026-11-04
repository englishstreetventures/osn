/**
 * The portals' glass: the chosen choice's look in `SegmentedTabs`, and a lone
 * glass pill that wears it (the invite builder's place on a phone).
 *
 * The raised surface at 55% under the accent at 14%, composited into one
 * colour (accent 22.8% into raised, at 61.3%) so the colour a label sits on can
 * be read back and measured; an inner lip (`--inner-lip`), a light inner edge
 * (`--glass-edge`), a hairline ring, the app's first lift and a 12px frosted
 * backdrop. A contrast theme drops the fill, so a lone pill draws its own
 * outline there.
 *
 * Its own module, not `segmented-tabs.tsx`'s, so a part other than the strip
 * can wear it without importing the strip. The guest site and the marketing
 * site draw no glass: each leaves this file out of its Tailwind scan beside
 * `segmented-tabs.tsx`, so none of these rules reaches their CSS.
 *
 * Written out in full so Tailwind's source scan finds it; a class built at run
 * time emits no CSS.
 */
export const GLASS_FILL =
  "base:[background-color:color-mix(in_srgb,color-mix(in_srgb,var(--ui-accent)_22.8%,var(--ui-surface-raised))_61.3%,transparent)] " +
  "base:shadow-[var(--inner-lip,inset_0_1px_0_rgb(255_255_255/0.06)),inset_0_0_0_1px_var(--glass-edge,rgb(255_255_255/0.1)),0_0_0_0.5px_var(--ui-hairline),var(--elev-1,var(--ui-elev-1))] " +
  "base:backdrop-blur-md base:backdrop-saturate-[1.6]";
