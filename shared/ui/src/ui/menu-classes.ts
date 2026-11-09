/**
 * The menu's look, as class strings, with nothing from Kobalte.
 *
 * `dropdown-menu.tsx` builds every class it renders from here, so a menu's
 * panel, rows, labels and separator have one home. The guest site's own link
 * menu, which cannot afford Kobalte's, takes its rows from
 * `menu-touch-classes.ts` instead, so a stylesheet that draws no Kobalte menu
 * can leave this file unscanned.
 *
 * Two variants, chosen once on the panel:
 *
 * - `default` — the shared look musubi's account menu and pulse's two menus
 *   draw. It grows from its trigger and shrinks a little as it closes, on the
 *   shared motion tokens (`tokens.css`). Its strings are frozen:
 *   `tests/dropdown-menu-default.browser.test.tsx` reads them back literally,
 *   because that is the only thing that keeps those apps unmoved by a change
 *   made for cire. A focused row is marked by its sunk fill; a contrast theme
 *   drops the fill, so the row's outline is hidden only while it has focus,
 *   and the theme paints it. Hidden at rest as well, it would ring every row.
 *   The separator, a fill too, draws a top border in a contrast theme alone.
 * - `accent` — cire's portal look: the raised panel at the 10px corner with
 *   the floating shadow, 6px rows in full ink, the highlighted row a 10%
 *   accent wash with readable accent ink. It opens with a short pop from the
 *   trigger's side, from the shared `--ui-scale-enter`, and closes at once: a menu held mounted for an exit
 *   animation keeps focus inside it, and Kobalte's hand-back to the trigger
 *   then falls to `<body>`.
 *
 * The accent look reads an app's own `--elev-2`, `--dur-fast` and `--ease-out`
 * first and the contract's `--ui-*` after, as `choice.ts` and `control.ts` do,
 * so cire's portals need no new mapping and nothing else they render moves.
 * Its pop is one `animation` shorthand on the open panel, not `animate-in`
 * with a duration beside it: `animate-in` sits on the open panel's selector,
 * which outranks a plain class, so a duration set beside it never applied.
 */

export type MenuVariant = "default" | "accent";

/** A group label's job. `eyebrow` leads a group of rows in small caps. */
export type MenuLabelTone = "heading" | "identity" | "eyebrow";

const PANEL = {
  default:
    "base:bg-ui-surface-raised base:text-ui-ink base:border-ui-hairline base:z-50 base:min-w-32 base:rounded-ui-md base:border base:p-1 base:shadow-md base:outline-none " +
    "base:origin-(--kb-popper-content-transform-origin) base:data-[expanded]:animate-in base:data-[closed]:animate-out base:data-[closed]:fade-out-0 base:data-[expanded]:fade-in-0 base:data-[closed]:zoom-out base:data-[expanded]:zoom-in",
  accent:
    "base:bg-ui-surface-raised base:text-ui-ink base:border-ui-hairline base:z-50 base:min-w-32 base:rounded-ui-md base:border base:p-1.5 " +
    "base:shadow-[var(--elev-2,var(--ui-elev-2))] base:outline-none " +
    "base:origin-(--kb-popper-content-transform-origin) base:data-[expanded]:fade-in-0 base:data-[expanded]:zoom-in " +
    "base:motion-safe:data-[expanded]:[animation:ui-enter_var(--dur-fast,var(--ui-dur-fast))_var(--ease-out,var(--ui-ease-out))_both]",
} satisfies Readonly<Record<MenuVariant, string>>;

const ROW = {
  default:
    "base:relative base:flex base:cursor-pointer base:select-none base:items-center base:rounded-ui-sm base:px-2 base:py-1.5 base:text-ui-base base:outline-none " +
    "base:focus:bg-ui-surface-sunk base:focus:text-ui-ink base:focus:outline-hidden " +
    "base:data-[disabled]:pointer-events-none base:data-[disabled]:opacity-50",
  // The ring is inset (-2px), not the dashboard's 2px outside: Kobalte scrolls
  // a highlighted row flush to the edge of a menu that scrolls, ignoring
  // `scroll-padding`, and the panel clips a ring drawn outside the row there.
  // It shows for the keyboard only; a pointer's highlight is the wash. The
  // colour fade names its properties, so the ring never fades in.
  accent:
    "base:relative base:flex base:w-full base:cursor-pointer base:select-none base:items-center base:gap-4 base:rounded-ui-sm base:px-3 base:py-2 " +
    "base:font-ui-body base:text-ui-sm base:text-ui-ink base:no-underline base:outline-none " +
    "base:transition-[color,background-color] base:duration-[var(--dur-fast,var(--ui-dur-fast))] base:ease-[var(--ease-out,var(--ui-ease-out))] " +
    "base:data-[highlighted]:bg-ui-accent/10 base:data-[highlighted]:text-ui-accent-ink " +
    "base:focus-visible:outline-2 base:focus-visible:outline-solid base:focus-visible:-outline-offset-2 base:focus-visible:outline-ui-focus " +
    "base:data-[disabled]:cursor-not-allowed base:data-[disabled]:opacity-50",
} satisfies Readonly<Record<MenuVariant, string>>;

const LABEL_BOX = {
  default: "base:px-2 base:py-1.5 base:text-ui-base",
  accent: "base:px-3 base:py-2 base:font-ui-body base:text-ui-sm",
} satisfies Readonly<Record<MenuVariant, string>>;

/**
 * `heading` names a group and leads the menu — semibold, full ink. `identity`
 * is the block at the top of an account menu that says who you are signed in
 * as: context rather than a heading, so it recedes.
 */
const LABEL_TONE = {
  heading: "base:text-ui-ink base:font-semibold",
  identity: "base:text-ui-ink-secondary base:font-normal",
} satisfies Readonly<Record<Exclude<MenuLabelTone, "eyebrow">, string>>;

/**
 * A group label in small caps, the secondary ink: in a menu, accent ink marks
 * state (the highlighted row, the chosen check, a switch that is on), and a
 * label that cannot be chosen does not wear it.
 */
const EYEBROW = {
  default:
    "base:px-2 base:pt-1.5 base:pb-1 base:text-ui-xs base:tracking-ui-widest base:uppercase base:font-normal base:text-ui-ink-secondary",
  accent:
    "base:px-3 base:pt-2 base:pb-1 base:font-ui-body base:text-ui-xs base:tracking-ui-widest base:uppercase base:font-normal base:text-ui-ink-secondary",
} satisfies Readonly<Record<MenuVariant, string>>;

/**
 * The line is the 1px hairline fill, so both looks set `border-0`: the
 * separator is an `<hr>`, which keeps preflight's 1px top border in the
 * panel's ink, and that border covers the fill wherever an app's base styles
 * leave its colour alone. A contrast theme replaces the fill with the page
 * colour, so the default look draws the top border back there for the theme
 * to paint.
 */
const SEPARATOR = {
  default:
    "base:bg-ui-hairline base:-mx-1 base:my-1 base:h-px base:border-0 base:forced-colors:border-t",
  accent: "base:bg-ui-hairline base:mx-1 base:my-1 base:h-px base:border-0",
} satisfies Readonly<Record<MenuVariant, string>>;

/** The trailing mark on a chosen radio row and a checked check row. */
export const MENU_CHECK_CLASS =
  "base:ml-auto base:inline-flex base:shrink-0 base:items-center base:text-ui-accent-ink";

/** The panel. */
export function menuPanelClass(variant: MenuVariant = "default"): string {
  return PANEL[variant];
}

/** A row: an item, a checkbox item or a radio item. */
export function menuRowClass(variant: MenuVariant = "default"): string {
  return ROW[variant];
}

/** A group label, by the panel's variant and the label's job. */
export function menuLabelClass(
  variant: MenuVariant = "default",
  tone: MenuLabelTone = "heading",
): string {
  return tone === "eyebrow" ? EYEBROW[variant] : `${LABEL_BOX[variant]} ${LABEL_TONE[tone]}`;
}

/** The hairline between groups. */
export function menuSeparatorClass(variant: MenuVariant = "default"): string {
  return SEPARATOR[variant];
}
