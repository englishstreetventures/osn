/**
 * The rows of a menu drawn without Kobalte, at a guest's touch size, as class
 * strings with nothing imported.
 *
 * A file of its own, apart from `menu-classes.ts`: the guest site draws this
 * menu and no Kobalte one, so its stylesheet scans this file and leaves the
 * Kobalte menu's classes out (`@source not` in `cire/invites`' global
 * stylesheet).
 */

/**
 * The guest site's menu of links (`cire/invites` `LinkMenu`), which draws its
 * own menu in the top layer rather than load Kobalte's.
 *
 * - `panel`: the raised surface at the 10px corner, at least 224px wide
 *   (`MENU_WIDTH`), `p-2` with a 4px gap
 *   between rows, in a column, under `shadow-lg`. `LinkMenu` places itself
 *   before it has measured from these numbers (`ITEM_GAP`, `MENU_CHROME`), so
 *   they hold.
 * - `row`: a 44px row, a guest's touch floor, in the secondary ink. Filled with
 *   the accent and its on-accent ink under the pointer, for the keyboard and
 *   while pressed — never for focus alone: a tap focuses the link it lands on,
 *   and a row filled for that reads as already chosen.
 */
export const MENU_TOUCH = {
  panel:
    "base:border-ui-hairline base:bg-ui-surface-raised base:flex base:min-w-56 base:flex-col base:gap-1 base:rounded-ui-md base:border base:p-2 base:shadow-lg",
  row:
    "base:font-ui-body base:text-ui-ink-secondary base:text-ui-sm base:tracking-ui-normal base:flex base:min-h-11 base:items-center base:rounded-ui-sm base:px-3 " +
    "base:hover:bg-ui-accent base:hover:text-ui-on-accent base:focus-visible:bg-ui-accent base:focus-visible:text-ui-on-accent base:active:bg-ui-accent base:active:text-ui-on-accent " +
    "base:transition-[color,background-color] base:duration-[var(--dur-fast,var(--ui-dur-fast))] base:ease-[var(--ease-out,var(--ui-ease-out))] base:focus-visible:outline-none",
} as const;
