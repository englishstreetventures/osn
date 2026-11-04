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
 * can wear it without importing the strip: `Button`'s `glass`
 * ({@link GLASS_CHOICE}). The guest site and the marketing
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

/**
 * `Button`'s `glass`: one of several in the portals, wearing the strip's look.
 *
 * At rest, the track's: a hairline on the portals' ground (`--pill-ground`)
 * in the secondary ink. Under the pointer an unchosen one goes halfway, with
 * the strip's own colour and ink (`segmented-tabs.tsx`'s `ITEM`). Chosen —
 * `aria-pressed` on a toggle, `aria-checked` on a radio — it wears
 * {@link GLASS_FILL} in the readable accent ink at medium weight, its hairline
 * cleared for the glass's own edge; at rest its word is at normal weight, so
 * the chosen pill differs by more than colour, as a strip's chosen word does
 * (`Button` holds each word's width at the wider weight). A contrast theme
 * drops the glass, so the chosen pill keeps a 1px outline there. `tests/glass.test.ts` holds the chosen and the
 * halfway looks to the strip's, declaration for declaration.
 */
export const GLASS_CHOICE =
  "base:border-ui-hairline base:bg-[color:var(--pill-ground,transparent)] base:text-ui-ink-secondary " +
  "base:not-aria-pressed:not-aria-checked:font-normal " +
  "not-aria-pressed:not-aria-checked:not-aria-disabled:hover:base:[background-color:color-mix(in_srgb,color-mix(in_srgb,var(--ui-accent)_21.5%,var(--ui-surface-raised))_32.6%,transparent)] " +
  "not-aria-pressed:not-aria-checked:not-aria-disabled:hover:base:[color:color-mix(in_srgb,var(--ui-ink-secondary),var(--ui-accent-ink))] " +
  "base:[&:is([aria-pressed=true],[aria-checked=true])]:border-transparent " +
  "base:[&:is([aria-pressed=true],[aria-checked=true])]:text-ui-accent-ink " +
  "base:[&:is([aria-pressed=true],[aria-checked=true])]:[background-color:color-mix(in_srgb,color-mix(in_srgb,var(--ui-accent)_22.8%,var(--ui-surface-raised))_61.3%,transparent)] " +
  "base:[&:is([aria-pressed=true],[aria-checked=true])]:shadow-[var(--inner-lip,inset_0_1px_0_rgb(255_255_255/0.06)),inset_0_0_0_1px_var(--glass-edge,rgb(255_255_255/0.1)),0_0_0_0.5px_var(--ui-hairline),var(--elev-1,var(--ui-elev-1))] " +
  "base:[&:is([aria-pressed=true],[aria-checked=true])]:backdrop-blur-md " +
  "base:[&:is([aria-pressed=true],[aria-checked=true])]:backdrop-saturate-[1.6] " +
  "base:forced-colors:[&:is([aria-pressed=true],[aria-checked=true])]:outline-1";
