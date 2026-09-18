import type { SafeProps } from "@shared/ui/ui/props";
import { splitProps } from "solid-js";

/**
 * cire's button.
 *
 * Every control in both portals was already one of four shapes — a solid gold
 * commit, a gold-outlined secondary, a neutral-outlined quiet action, and a
 * destructive one — written out longhand at each of the ~40 call sites, which
 * is why three had drifted to a different padding and two to a different
 * tracking. This is those four, named.
 *
 * ## Why this is not `@shared/ui`'s Button
 *
 * The shapes are the house style, not a general one: uppercase, tracked, a
 * sharp 4px corner, and a *gold* primary rather than a neutral one. `@shared/ui`'s
 * Button is the shadcn set — six variants, sentence case, rounded — and an app
 * that wanted cire's would be overriding almost every class. Two components is
 * the honest answer; one component with ten variants is not.
 *
 * ## No haptic here
 *
 * Tempting, and wrong. The vocabulary in `haptics.ts` is deliberately five
 * names, fired at the moment a change *takes* — not at the moment a button is
 * pressed. A press that opens a dialog, switches a tab or starts a request that
 * then fails has nothing to confirm yet. Buzzing on every press is exactly the
 * "phone in a pocket buzzing through a seating chart" that module warns about.
 *
 * ## About `class`
 *
 * Appended, and there is no `tailwind-merge` here, so it is for what the
 * variant does not decide — `self-start`, `w-full`, a grid placement. The
 * defaults are all `base:`-prefixed and therefore zero-specificity, so a
 * caller's plain utility does win; what it cannot do is beat another `base:`
 * utility on the same property, since those resolve by stylesheet order.
 * Anything that needs a different colour or padding wants a new variant.
 */

export type ButtonVariant =
  | "primary"
  | "cta"
  | "outline"
  | "quiet"
  | "quietDanger"
  | "choice"
  | "tile"
  | "dashed"
  | "field"
  | "danger"
  | "link"
  | "subtle"
  | "touchLink"
  | "bare"
  | "bareDanger";
export type ButtonSize = "sm" | "md" | "lg" | "swatch" | "icon";

const BASE =
  "base:font-ui-body base:inline-flex base:items-center base:justify-center base:gap-2 " +
  "base:rounded-ui-sm base:border base:whitespace-nowrap " +
  "base:transition-colors base:duration-100 base:ease-out " +
  // Its own focus ring, from the contract's own token. A library component
  // cannot assume its host declares a blanket `:focus-visible` rule: the two
  // portals and `@cire/invites` do, `@cire/landing` does not, and the nine
  // guest-site call sites this replaces each wrote one out by hand. The values
  // match what the portals' global rule already draws, so nothing moves there.
  "base:focus-visible:outline-2 base:focus-visible:outline-offset-2 base:focus-visible:outline-ui-focus " +
  "base:disabled:pointer-events-none base:disabled:opacity-40 " +
  // `aria-disabled` is the other way to say it: the control stays in the tab
  // order and keeps its description reachable, and the click is swallowed below
  // rather than left to each caller. Used where the point is that someone READS
  // why they cannot press it — a `disabled` button is skipped by the keyboard
  // and by a screen reader in forms mode, which hides the explanation from
  // exactly the person asking.
  "base:aria-disabled:cursor-not-allowed base:aria-disabled:opacity-40";

const VARIANT = {
  primary:
    "base:border-ui-accent base:bg-ui-accent base:text-ui-on-accent base:hover:bg-ui-accent-strong",
  /**
   * Outline at rest, primary on hover — the guest site's call to action, at
   * nine call sites across `@cire/invites` and `@cire/landing`: the claim-code
   * submit, the RSVP commit, both gift-registry actions, the consent banner's
   * accept.
   *
   * Not a second `outline`. An invite is restrained enough that a solid gold
   * fill at rest would be the loudest thing on a page whose job is a
   * photograph and a date, so the *primary* action is drawn as an outline and
   * promotes on hover. The portals have the opposite problem — a dashboard
   * needs its commit to be findable — so there `primary` is filled from the
   * start and `outline` stays a wash. Both products need both.
   */
  cta: "base:border-ui-accent base:text-ui-accent-ink base:bg-transparent base:hover:bg-ui-accent base:hover:text-ui-on-accent base:disabled:hover:bg-transparent base:disabled:hover:text-ui-accent-ink",
  outline:
    "base:border-ui-accent/40 base:text-ui-accent-ink base:hover:border-ui-accent base:hover:bg-ui-accent-soft",
  quiet:
    "base:border-ui-hairline base:text-ui-ink-secondary base:hover:border-ui-accent base:hover:text-ui-accent-ink",
  /**
   * Destroys something, and says so only when you reach for it — the
   * "Deactivate" beside a household in the guest table, where the rows above
   * and below carry the same control.
   *
   * `bareDanger`'s reasoning for an action that needs a box: a column of
   * red-outlined buttons down a table reads as an error state rather than as a
   * column of controls, so the warning waits for the pointer. Distinct from
   * `danger`, which is red at rest and belongs on the button that finally
   * commits the destruction — the confirm, not the control that offers it.
   */
  quietDanger:
    "base:border-ui-hairline base:text-ui-ink-secondary base:hover:border-ui-danger base:hover:text-ui-danger",
  /**
   * One option among several, with the chosen one marked — the desktop/phone
   * preview toggle, the palette presets, the section-background picker, the
   * registry's candidate pictures.
   *
   * `quiet`'s body plus the thing all four need and no two would spell the same
   * way: an accent border, and a ring so the mark survives on a swatch whose
   * own colour is already sitting against that border. It reads
   * `aria-pressed` and `aria-checked` together because two of the four are
   * toggle groups and two are radio groups — which ARIA property carries the
   * state is a question about the group's semantics, not about how the chosen
   * member should look.
   *
   * No focus treatment of its own. {@link BASE} already draws one from
   * `--ui-focus`, the app's contrast-checked focus token, which is what the
   * hand-rolled gold rings at these call sites were approximating.
   */
  choice:
    "base:border-ui-hairline base:text-ui-ink-secondary base:hover:border-ui-accent base:hover:text-ui-accent-ink " +
    "base:aria-pressed:border-ui-accent base:aria-pressed:text-ui-accent-ink " +
    "base:aria-pressed:ring-1 base:aria-pressed:ring-ui-accent/60 " +
    "base:aria-checked:border-ui-accent base:aria-checked:text-ui-accent-ink " +
    "base:aria-checked:ring-1 base:aria-checked:ring-ui-accent/60",
  /**
   * The whole block is the control — a wedding in the portal's list, a step in
   * the getting-started guide, the collapsed section menu in the invite
   * builder, the command-palette chip in the top bar.
   *
   * Filled rather than outlined, and that is the distinction rather than a
   * preference: past a certain size a hairline stops describing the control,
   * because the eye reads the empty middle rather than the edge. Lifting the
   * surface off the page is what makes a card-sized target read as pressable.
   *
   * It carries `ink` rather than `ink-secondary` because a tile's interior is
   * composed content — a name, a description, a marker — and muting all of it
   * is not the same thing as muting a label.
   *
   * One wash and one hover for all four, rather than a value per call site:
   * left to themselves they reach for `surface/30`, `surface/40` and `bg/30`,
   * which is three answers to a question with one.
   */
  tile: "base:border-ui-hairline base:bg-ui-surface/30 base:text-ui-ink base:hover:border-ui-accent base:hover:bg-ui-surface/60",
  /**
   * The empty slot — "+ Create a wedding", standing where a wedding would be.
   *
   * A dashed outline is this house's mark for a box with nothing in it yet: the
   * empty enquiries pane and the events table's pending row both draw one. It
   * is not `quiet` with a different border, because the two promise different
   * things — a solid box promises that something happens, a dashed one promises
   * that something appears.
   */
  dashed:
    "base:border-ui-hairline base:border-dashed base:text-ui-ink-secondary " +
    "base:hover:border-ui-accent base:hover:text-ui-accent-ink",
  /**
   * A control shaped like the field it stands in for — the dietary picker's
   * collapsed trigger, which sits in a column of text inputs and says what is
   * currently selected.
   *
   * Not `quiet` with different padding. The other variants are all *actions*
   * and read as actions: uppercase, tracked, centred. This one holds a value a
   * guest typed the meaning of — "Vegetarian, no nuts" — and shouting it in
   * small caps beside the text box below makes the pair look like two different
   * kinds of thing when they are one. So it takes {@link FIELD_SIZE}: sentence
   * case, no tracking, and an input's padding rather than a button's.
   *
   * Transparent rather than washed, for the same reason — it has to sit level
   * with the inputs around it, which are transparent over the form's own
   * surface.
   */
  field:
    "base:border-ui-hairline base:bg-transparent base:text-ui-ink " +
    "base:hover:border-ui-accent-soft",
  danger:
    "base:border-ui-danger/40 base:text-ui-danger base:hover:border-ui-danger base:hover:bg-ui-danger/10",

  /*
   * The four borderless ones.
   *
   * Counted across `cire/host`: 9 accent text links, 17 muted ones and 25 glyph
   * buttons — 51 of that app's 98 raw `<button>` elements, each written out by
   * hand, plus 5 more on the guest site. Four variants rather than one, because
   * the differences are not decoration:
   *
   * `link` is the affirmative text action — "View listing", "Today", "Back".
   * Accent ink, so it reads as the thing to do.
   *
   * `subtle` is its opposite number — "Cancel", "Clear", "Dismiss". Muted ink
   * that brightens on hover, and it keeps the underline: it is still a link,
   * and dropping the underline on 17 cancel actions is a redesign, not a
   * refactor.
   *
   * `touchLink` is `subtle` with its underline at rest rather than on hover,
   * and the difference is the surface rather than the taste: `@cire/invites` is
   * opened on a phone, where there is no hover at all, so a hover-revealed
   * underline is one that never appears. Five of the guest site's secondary
   * actions take it — the two sign-outs, the consent gate's "Privacy choices",
   * and a gift's "Release" and "Cancel".
   *
   * `bare` is a glyph — a move-up arrow, a close cross, a disclosure caret. No
   * underline, because there is no word to underline.
   */
  link: "base:border-transparent base:bg-transparent base:text-ui-accent-ink base:underline-offset-4 base:hover:underline",
  subtle:
    "base:border-transparent base:bg-transparent base:text-ui-ink-secondary base:underline-offset-4 base:hover:text-ui-ink base:hover:underline",
  touchLink:
    "base:border-transparent base:bg-transparent base:text-ui-ink-secondary " +
    "base:underline base:underline-offset-4 base:hover:text-ui-ink",
  bare: "base:border-transparent base:bg-transparent base:text-ui-ink-secondary base:hover:text-ui-ink",
  /**
   * A glyph that destroys something — the bin beside a budget line, a
   * checklist task, a colour swatch. Muted at rest like `bare`, because a row
   * of red crosses down a table reads as an error state rather than as a
   * column of controls, and danger only on hover, where it is a warning
   * arriving exactly when it is useful.
   *
   * It exists because dropping it was a real regression: five of these were
   * `text-text-muted hover:text-error`, and folding them into `bare` left a
   * delete action that no longer signals anything.
   */
  bareDanger:
    "base:border-transparent base:bg-transparent base:text-ui-ink-secondary base:hover:text-ui-danger",
} satisfies Readonly<Record<ButtonVariant, string>>;

/**
 * The variants that draw no box.
 *
 * They take the type size from {@link SIZE}'s twin below and none of its
 * padding: a bordered control needs `px-4 py-2` to BE a control, and a text
 * link with the same padding is a word floating in a gap. Nor the uppercase —
 * a link reads as a sentence fragment, and shouting it makes it a button
 * wearing a link's clothes.
 */
const BORDERLESS = new Set<ButtonVariant>(["link", "subtle", "touchLink", "bare", "bareDanger"]);

const SIZE = {
  sm: "base:px-3 base:py-1.5 base:text-ui-xs base:tracking-ui-wider base:uppercase",
  md: "base:px-4 base:py-2 base:text-ui-sm base:tracking-ui-wider base:uppercase",
  // For a control that is the only thing to do on the screen it is on — a
  // claim-code submit, an RSVP commit. Also the minimum comfortable touch
  // target on a phone, which is where most invites are opened.
  lg: "base:px-6 base:py-3.5 base:text-ui-base base:tracking-ui-wider base:uppercase",
  // The control's content is the thing itself — a colour swatch, a product
  // thumbnail, a design preview. One hairline of padding, so the border reads
  // as a frame around the picture rather than a box around a label, and the
  // picture's own dimensions are what size the control. No type treatment,
  // because there is no type.
  swatch: "base:p-1",
  // Square, for a single glyph. No tracking — there is nothing to track.
  icon: "base:h-8 base:w-8 base:shrink-0 base:p-0 base:text-ui-base base:uppercase",
} satisfies Readonly<Record<ButtonSize, string>>;

/** {@link SIZE} for the borderless variants: type only, plus what a glyph needs to stay hittable. */
const BORDERLESS_SIZE = {
  sm: "base:text-ui-xs",
  md: "base:text-ui-sm",
  lg: "base:text-ui-base",
  // Nothing at all: an unframed picture is flush with its own hit area.
  swatch: "base:p-0",
  icon: "base:px-1 base:text-ui-md base:leading-none",
} satisfies Readonly<Record<ButtonSize, string>>;

/**
 * {@link SIZE} for `tile`.
 *
 * Square padding and a wider gap, because a tile's interior is a small layout —
 * a numbered marker beside two lines of text, a label opposite a counter —
 * rather than a word. `px-4 py-2` around that reads as a paragraph that has
 * been squeezed into a button.
 *
 * The type steps are {@link SIZE}'s own, so a tile and an ordinary button in
 * the same row are the same size of thing; only the room inside differs.
 */
const TILE_SIZE = {
  sm: "base:gap-3 base:p-3 base:text-ui-xs base:tracking-ui-wider base:uppercase",
  md: "base:gap-3 base:p-4 base:text-ui-sm base:tracking-ui-wider base:uppercase",
  lg: "base:gap-3 base:p-6 base:text-ui-base base:tracking-ui-wider base:uppercase",
  swatch: "base:p-1",
  icon: "base:h-8 base:w-8 base:shrink-0 base:p-0 base:text-ui-base base:uppercase",
} satisfies Readonly<Record<ButtonSize, string>>;

/**
 * {@link SIZE} for `field`.
 *
 * An input's padding and sentence case — the two things that make a control
 * read as a form field rather than as a button. The type steps are
 * {@link SIZE}'s own, so a field and the text box under it are the same size of
 * thing.
 */
const FIELD_SIZE = {
  sm: "base:px-3 base:py-2 base:text-ui-sm",
  md: "base:px-3 base:py-2.5 base:text-ui-base",
  lg: "base:px-4 base:py-3 base:text-ui-md",
  swatch: "base:p-1",
  icon: "base:h-8 base:w-8 base:shrink-0 base:p-0 base:text-ui-base",
} satisfies Readonly<Record<ButtonSize, string>>;

/** Which of the four tables a variant sizes from. */
function sizingFor(variant: ButtonVariant, size: ButtonSize): string {
  if (variant === "tile") return TILE_SIZE[size];
  if (variant === "field") return FIELD_SIZE[size];
  return BORDERLESS.has(variant) ? BORDERLESS_SIZE[size] : SIZE[size];
}

/**
 * The classes on their own, for a call site that needs a different element — an
 * `<a>` that looks like a button, a Kobalte trigger rendered `as`. Reaching for
 * this instead of `<button role="link">` is the right trade every time.
 */
export function buttonClass(options: { variant?: ButtonVariant; size?: ButtonSize } = {}): string {
  const variant = options.variant ?? "quiet";
  const size = options.size ?? "md";
  return `${BASE} ${VARIANT[variant]} ${sizingFor(variant, size)}`;
}

export type ButtonProps = SafeProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export default function Button(props: ButtonProps) {
  const [own, rest] = splitProps(props, ["variant", "size", "class", "onClick"]);

  /**
   * `aria-disabled` has to mean it.
   *
   * The attribute only tells assistive technology the control is unavailable —
   * the browser still fires the click, because that is the whole reason to
   * choose it over `disabled` (the control keeps its tab stop, so its reason
   * stays reachable). Swallowing the click here is what makes the announcement
   * true; leaving it to every caller makes the styling a promise the component
   * does not keep.
   */
  const inert = () => props["aria-disabled"] === true || props["aria-disabled"] === "true";

  return (
    // `type` sits before the spread so a caller can still pass `type="submit"`.
    // A button with no type submits the form it is in, which is never what a
    // toolbar control in a settings form means to do.
    <button
      type="button"
      {...rest}
      class={`${buttonClass({ variant: own.variant, size: own.size })}${
        own.class ? ` ${own.class}` : ""
      }`}
      onClick={(event) => {
        if (inert()) {
          // `preventDefault` as well as the early return: a `type="submit"`
          // button inside a form would otherwise still submit it.
          event.preventDefault();
          return;
        }
        const handler = own.onClick;
        if (typeof handler === "function") handler(event);
        // Solid's bound form: `onClick={[fn, data]}`.
        else if (Array.isArray(handler)) handler[0](handler[1], event);
      }}
    />
  );
}
