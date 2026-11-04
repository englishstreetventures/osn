/**
 * The box every text control shares: `Input`, `Textarea` and `Select`.
 *
 * ## Why this is one module and not three class strings
 *
 * Counted across the products before the lift, the text input had drifted into
 * four shapes — `px-3 py-2 text-[0.9rem]` on cire's planning modules, the same
 * padding at `text-[0.95rem]` on its settings forms, `px-2 py-1` with no text
 * size at all in the guest editor's inline cells, and `px-2 py-1 text-[0.8rem]`
 * in the budget table. Three of the four had no focus treatment, so typing into
 * a guest row and typing into a wedding name looked like two different products.
 *
 * So one box, at five sizes, in two fills, and three ways to set the value. `Input` and `Select` take a fixed
 * height at every size from {@link CONTROL_HEIGHT}, so no field's height depends
 * on the platform's font; `Textarea` grows with its rows.
 *
 * ## One class per property
 *
 * Every class here is `base:` — zero specificity — so two of them setting one
 * property tie, and the order Tailwind writes them into the stylesheet decides,
 * not the order in the attribute. {@link controlClass} therefore picks exactly
 * one padding, one type size and at most one letter-spacing for each size, face
 * and fill, rather than stacking a fill's type on a size's.
 *
 * ## `size` is not the native attribute
 *
 * `<input size>` and `<select size>` size a box in characters and rows — neither
 * of which anything here wants, and both of which would collide with the name.
 * The prop types below omit the native one, so passing `size={30}` is a compile
 * error rather than a control that quietly ignores its variant.
 */

/**
 * - `sm` — inside a table row or a filter bar, 28px.
 * - `md` — a form, 36px.
 * - `form` — a form at 34px, md's 12px sides and type: cire's portals, where a
 *   34px field under the 14px field corner keeps a straight side.
 * - `form-compact` — 34px with sm's 8px sides and smaller type, for a form field
 *   in a narrow table cell or an inline editor beside 34px fields.
 * - `touch` — a field a guest taps on a phone: 46px with 16px type below 640px,
 *   44px from there up, so iOS never zooms the page on focus and the tap target
 *   stays at or above 44px.
 */
export type ControlSize = "sm" | "md" | "form" | "form-compact" | "touch";

/**
 * - `ground` — the default: the page's ground for a fill and the strong
 *   hairline for an edge, with a ring for focus.
 * - `ink` — edge and fill drawn from the text colour at an alpha, so the field
 *   reads on whatever surface it sits on: a page, a card, or a guest site's
 *   section in the couple's own colour, where a ground fill could vanish or
 *   clash. The edge is ink at 55%, the lowest that clears the 3:1 a control's
 *   edge needs on every guest palette; the fill is ink at 4.5%, enough to read
 *   as a well. The placeholder is the secondary ink taken 15% toward the text
 *   colour: the well alone takes the secondary ink under the 4.5:1 text needs
 *   on a light palette. Its type never drops under 16px below 640px.
 */
export type ControlFill = "ground" | "ink";

/**
 * The face the value inside the control is set in.
 *
 * - `code` — an identifier the reader checks character by character: a profile
 *   ID, an API key, a colour's hex. Mono and wide tracking together, for the
 *   same reason `Td`'s `code` sets both: mono alone still runs `l1I` and `0O`
 *   into each other at a control's size.
 * - `claim` — the code printed on a guest's invitation: centred, in capitals
 *   with wider tracking, 1rem at every width and 16px sides, so a code read off
 *   a card is easy to check as it is typed. The placeholder stays as written.
 * - `amount` — a sum of money under a centred label: centred, nothing else.
 */
export type ControlFace = "text" | "code" | "claim" | "amount";

/**
 * Everything that does not change with size, in each fill, either side of the
 * width (which `Select` leaves out: its select fills a grid cell instead).
 *
 * `aria-[invalid=true]:` rather than `aria-invalid:`: Tailwind's built-in `aria-*`
 * variants cover `busy`, `checked`, `disabled`, `expanded`, `hidden`, `pressed`,
 * `readonly`, `required` and `selected` — not `invalid`. This is the pair that
 * makes `Field`'s error state visible on the control itself rather than only in
 * the message below it, so it is load-bearing rather than decorative.
 *
 * The corner is the contract's `field` radius role (`--ui-radius-field`), not
 * the `control` role `Button` takes, so an app can give its buttons pill ends
 * and its text fields a softer square. An app that maps no field radius gets
 * its control radius here.
 */
const GROUND_HEAD =
  "base:border-ui-hairline-strong base:bg-ui-ground base:text-ui-ink " +
  "base:ring-offset-ui-ground base:placeholder:text-ui-ink-secondary";

const GROUND_TAIL =
  "base:rounded-ui-field base:border " +
  "base:focus-visible:ring-ui-focus base:focus-visible:outline-none " +
  "base:focus-visible:ring-2 base:focus-visible:ring-offset-2 " +
  "base:aria-[invalid=true]:border-ui-danger " +
  "base:disabled:cursor-not-allowed base:disabled:opacity-50";

/**
 * The ink fill: edge and fill from the text colour, focus turning the edge to
 * the accent and drawing the house outline. An outline, not the ground fill's
 * ring: a ring's offset is painted in `--ui-ground`, which is the wrong colour
 * on a card or a coloured section. Only the colours fade, on the app's
 * `--dur-fast` where it declares one, so the outline lands at once.
 */
const INK_HEAD =
  "base:border-ui-ink/55 base:bg-ui-ink/4.5 base:text-ui-ink " +
  "base:placeholder:text-[color:color-mix(in_oklab,var(--ui-ink-secondary),var(--ui-ink)_15%)]";

const INK_TAIL =
  "base:rounded-ui-field base:border " +
  "base:focus:border-ui-accent " +
  "base:focus-visible:outline-2 base:focus-visible:outline-offset-2 base:focus-visible:outline-ui-focus " +
  "base:transition-[color,background-color,border-color] " +
  "base:duration-[var(--dur-fast,var(--ui-dur-fast))] base:ease-[var(--ease-out,var(--ui-ease-out))] " +
  "base:aria-[invalid=true]:border-ui-danger " +
  "base:disabled:cursor-not-allowed base:disabled:opacity-50";

const CONTROL_FILL = {
  ground: [GROUND_HEAD, GROUND_TAIL],
  ink: [INK_HEAD, INK_TAIL],
} satisfies Readonly<Record<ControlFill, readonly [string, string]>>;

/** 16px below 640px, where iOS zooms on anything smaller; the base step above. */
const TYPE_FLOOR = "base:text-base base:sm:text-ui-base";

/** Each size's sides (and, for the two padded sizes, its top and bottom). */
const CONTROL_PAD = {
  sm: "base:px-2 base:py-1",
  md: "base:px-3 base:py-2",
  form: "base:px-3",
  "form-compact": "base:px-2",
  touch: "base:px-3",
} satisfies Readonly<Record<ControlSize, string>>;

const CONTROL_TYPE = {
  sm: "base:text-ui-sm",
  md: "base:text-ui-base",
  form: "base:text-ui-base",
  "form-compact": "base:text-ui-sm",
  touch: TYPE_FLOOR,
} satisfies Readonly<Record<ControlSize, string>>;

/**
 * The height `Input` and `Select` take at each size. Rem, so on a site that
 * raises its root size a touch field grows with its type and never drops under
 * 44px. The touch field switches with the type floor, at 640px of viewport:
 * the floor is there for iOS, which zooms by the rendered font size of the
 * device, and a container query cannot see the device.
 */
export const CONTROL_HEIGHT = {
  sm: "base:h-7",
  md: "base:h-9",
  form: "base:h-8.5",
  "form-compact": "base:h-8.5",
  touch: "base:h-11.5 base:sm:h-11",
} satisfies Readonly<Record<ControlSize, string>>;

/**
 * What a face sets. `type`, `pad` and `tracking` replace the size's and the
 * fill's own when present, so no property is set twice.
 */
interface FaceParts {
  readonly face: string;
  readonly type?: string;
  readonly pad?: string;
  readonly tracking?: string;
}

const CONTROL_FACE = {
  text: { face: "" },
  code: { face: "base:font-ui-mono", tracking: "base:tracking-ui-wide" },
  claim: {
    face: "base:text-center base:uppercase base:placeholder:normal-case base:placeholder:tracking-ui-wide",
    type: "base:text-base",
    pad: "base:px-4",
    tracking: "base:tracking-ui-wider",
  },
  amount: { face: "base:text-center" },
} satisfies Readonly<Record<ControlFace, FaceParts>>;

/**
 * The sizes whose box is md's (12px sides, the base type step) rather than
 * sm's. `Select` places its chevron by this.
 */
export function isWideBox(size: ControlSize): boolean {
  return size !== "sm" && size !== "form-compact";
}

/**
 * The control's classes from its parts. `pad` replaces the size's own padding
 * (`Select` and `Textarea` pass theirs); `width: false` leaves out `w-full`
 * (`Select`'s select, which fills a grid cell). One class per property.
 */
export function composeControl(
  size: ControlSize | undefined,
  face: ControlFace | undefined,
  fill: ControlFill | undefined,
  pad?: string,
  width = true,
): string {
  const s = size ?? "md";
  const f: FaceParts = CONTROL_FACE[face ?? "text"];
  const ink = fill === "ink";
  const [head, tail] = CONTROL_FILL[fill ?? "ground"];
  const type = f.type ?? (ink ? TYPE_FLOOR : CONTROL_TYPE[s]);
  // A face that sets its own letter-spacing keeps it; otherwise the ink fill
  // sets the normal one, because the label above a guest field is often widely
  // tracked and an input inherits it.
  const tracking = f.tracking ?? (ink ? "base:tracking-ui-normal" : "");
  const parts = [f.face, tracking].filter((part) => part !== "").join(" ");
  const box = width ? `${head} base:w-full ${tail}` : `${head} ${tail}`;
  return `${box} ${f.pad ?? pad ?? CONTROL_PAD[s]} ${type} ${parts}`;
}

/**
 * The shared box at one size, with the caller's own classes after it.
 *
 * The caller's string goes last so a call site can still override — every class
 * above is `base:`-prefixed and therefore zero-specificity, so ordering in the
 * generated stylesheet is what decides, and later wins.
 */
export function controlClass(
  size: ControlSize | undefined,
  extra: string | undefined,
  face?: ControlFace,
  fill?: ControlFill,
): string {
  return `${composeControl(size, face, fill)}${extra ? ` ${extra}` : ""}`;
}
