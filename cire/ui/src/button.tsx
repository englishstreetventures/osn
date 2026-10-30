import type { SafeProps } from "@shared/ui/ui/props";
import { splitProps } from "solid-js";

/**
 * cire's button.
 *
 * Sixteen variants, each named for the job a control does, so a call site
 * names the job rather than writing out its classes. Eleven draw a box:
 * `primary`, `cta`, `outline`, `quiet`, `quietDanger`, `choice`, `tile`,
 * `dashed`, `field`, `danger` and `chip`. Five draw none: `link`, `subtle`,
 * `touchLink`, `bare` and `bareDanger` (see {@link BORDERLESS}).
 *
 * ## Why this is not `@shared/ui`'s Button
 *
 * The vocabulary is the house's, not a general one: sixteen variants named for
 * the jobs cire's screens do — a guest site's outlined call to action, a tile,
 * a field-shaped trigger, a sheet's chrome — and a *gold* primary rather than a
 * neutral one. `@shared/ui`'s Button is the shadcn set, six variants, and an
 * app that wanted cire's would be overriding almost every class. Two
 * components is the honest answer; one component carrying both vocabularies
 * is not.
 *
 * ## Shape and case
 *
 * Actions take the `control` corner role, which cire's design draws as a pill
 * once an app maps it so. Labels show as written, at normal tracking, with a
 * medium weight on a boxed label so it stands apart from the text around it.
 * Nothing here transforms the label. The corner comes from a contract role
 * rather than a size step, so each app sets how round its buttons are once, in
 * its stylesheet: see {@link cornerFor}.
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
  | "chip"
  | "link"
  | "subtle"
  | "touchLink"
  | "bare"
  | "bareDanger";
export type ButtonSize = "sm" | "md" | "lg" | "swatch" | "icon";

const BASE =
  "base:font-ui-body base:inline-flex base:items-center base:justify-center base:gap-2 " +
  "base:border base:whitespace-nowrap " +
  // Only what a hover changes. Tailwind's `transition-colors` also fades
  // `outline-color`, which would bring the focus ring in over the hover's
  // duration rather than the moment focus lands. The duration is the app's
  // `--dur-fast`, so it follows the app's motion ladder; the fallback is for an
  // app that declares no ladder.
  "base:transition-[color,background-color,border-color,text-decoration-color] " +
  "base:duration-(--dur-fast,100ms) base:ease-out " +
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
   * submit, the RSVP commit, both gift-registry actions, the consent prompt's
   * "Accept necessary".
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
   * and read as actions: a pill, a medium-weight label, centred. This one holds
   * a value a guest typed the meaning of — "Vegetarian, no nuts" — and drawing
   * it as a pill with a weighted label beside the text box below makes the pair
   * look like two different kinds of thing when they are one. So it takes
   * {@link FIELD_SIZE}, an input's padding and weight rather than a button's,
   * and the text field's corner rather than the action's.
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
  /**
   * A control in a sheet's own chrome rather than in its content — the guest
   * site's "Give RSVP →" and "← See details" beside the event sheet's close
   * cross, which move between the sheet's two panels.
   *
   * A pill on the surface fill, because it is drawn as a sibling of that round
   * close button and has to read as one row with it; and filled rather than
   * transparent, because the sheet's content scrolls underneath it. Accent ink
   * and an accent hairline, because it leads somewhere — `quiet`'s neutral ink
   * would make the way to the RSVP form the dimmest thing on the details.
   *
   * Its pill is the `pill` step rather than the `control` role, which
   * {@link cornerFor} picks for it: it must match the round close button
   * beside it whatever an app decides its buttons look like.
   */
  chip:
    "base:border-ui-accent/40 base:bg-ui-surface base:text-ui-accent-ink " +
    "base:hover:border-ui-accent",

  /*
   * The borderless ones: these four, and `bareDanger` after them.
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
 * padding: a bordered control needs `px-5 py-2` to BE a control, and a text
 * link with the same padding is a word floating in a gap. Nor the medium
 * weight — a link reads as part of the sentence around it, and weighting it
 * makes it a button wearing a link's clothes.
 */
const BORDERLESS = new Set<ButtonVariant>(["link", "subtle", "touchLink", "bare", "bareDanger"]);

// A pill's round ends eat into the room beside its label, so each step's side
// padding is a step wider than a rectangle of the same height would need.
//
// The tracking is set rather than left to inherit: letter-spacing passes down
// to a button where a text transform does not, so a button set inside a
// tracked eyebrow would otherwise spread its sentence-case label to match.
const SIZE = {
  sm: "base:px-4 base:py-1.5 base:text-ui-xs base:font-medium base:tracking-ui-normal",
  md: "base:px-5 base:py-2 base:text-ui-sm base:font-medium base:tracking-ui-normal",
  // For a control that is the only thing to do on the screen it is on — a
  // claim-code submit, an RSVP commit. Also the minimum comfortable touch
  // target on a phone, which is where most invites are opened.
  lg: "base:px-7 base:py-3.5 base:text-ui-base base:font-medium base:tracking-ui-normal",
  // The control's content is the thing itself — a colour swatch, a product
  // thumbnail, a design preview. One hairline of padding, so the border reads
  // as a frame around the picture rather than a box around a label, and the
  // picture's own dimensions are what size the control. No type treatment,
  // because there is no type.
  swatch: "base:p-1",
  // Square, for a single glyph, so the pill corner makes it a circle. No
  // weight or tracking: a glyph is not a label.
  icon: "base:h-8 base:w-8 base:shrink-0 base:p-0 base:text-ui-base",
} satisfies Readonly<Record<ButtonSize, string>>;

/** {@link SIZE} for the borderless variants: type only, plus what a glyph needs to stay hittable. */
const BORDERLESS_SIZE = {
  sm: "base:text-ui-xs",
  md: "base:text-ui-sm",
  lg: "base:text-ui-base",
  // Nothing at all: an unframed picture is flush with its own hit area.
  swatch: "base:p-0",
  // `min-h-6 min-w-6` is the WCAG 2.2 SC 2.5.8 floor (24 CSS px), and it is
  // load-bearing rather than decoration: without it the box is whatever the
  // glyph's line box gives, which `leading-none` makes as tight as possible —
  // measured at 22.3 x 18.8 px, under the minimum in both axes. A floor rather
  // than a fixed `size-6`, because a call site that wants a larger target
  // (`h-7 w-7`, `h-11 w-11`) must still win, and a `min-*` yields to it while a
  // fixed height would have to be overridden.
  icon: "base:min-h-6 base:min-w-6 base:shrink-0 base:px-1 base:text-ui-md base:leading-none",
} satisfies Readonly<Record<ButtonSize, string>>;

/**
 * {@link SIZE} for `tile`.
 *
 * Square padding and a wider gap, because a tile's interior is a small layout —
 * a numbered marker beside two lines of text, a label opposite a counter —
 * rather than a word. `px-4 py-2` around that reads as a paragraph that has
 * been squeezed into a button.
 *
 * The type steps and weight are {@link SIZE}'s own, so a tile and an ordinary
 * button in the same row are the same size of thing; only the room inside
 * differs.
 */
const TILE_SIZE = {
  sm: "base:gap-3 base:p-3 base:text-ui-xs base:font-medium base:tracking-ui-normal",
  md: "base:gap-3 base:p-4 base:text-ui-sm base:font-medium base:tracking-ui-normal",
  lg: "base:gap-3 base:p-6 base:text-ui-base base:font-medium base:tracking-ui-normal",
  swatch: "base:p-1",
  icon: "base:h-8 base:w-8 base:shrink-0 base:p-0 base:text-ui-base",
} satisfies Readonly<Record<ButtonSize, string>>;

/**
 * {@link SIZE} for `field`.
 *
 * An input's padding and an input's weight — the two things that make a
 * control read as a form field rather than as a button. The type steps are
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
 * The one corner a variant and size take, always `base:`-prefixed.
 *
 * Actions take the `control` role, which decides how round an app's buttons
 * are. A `tile`, a `field` and anything at the `swatch` size take the `field`
 * role instead — the text field's corner: a tile is a block, a field holds a
 * value, and a swatch frames a picture, so a pill would read as a lozenge
 * around each. `chip` takes the `pill` step, since it is drawn as a sibling of a
 * round close button and stays round whatever `control` is. The borderless
 * variants take `control` too; with no border and no fill, only their focus
 * ring shows it.
 *
 * Exactly one corner class, and never a plain one, so a caller's plain
 * `rounded-*` in `class` outranks it rather than tying with it.
 */
function cornerFor(variant: ButtonVariant, size: ButtonSize): string {
  if (size === "swatch" || variant === "tile" || variant === "field") {
    return "base:rounded-ui-field";
  }
  if (variant === "chip") return "base:rounded-ui-pill";
  return "base:rounded-ui-control";
}

/**
 * The classes on their own, for a call site that needs a different element — an
 * `<a>` that looks like a button, a Kobalte trigger rendered `as`. Reaching for
 * this instead of `<button role="link">` is the right trade every time.
 */
export function buttonClass(options: { variant?: ButtonVariant; size?: ButtonSize } = {}): string {
  const variant = options.variant ?? "quiet";
  const size = options.size ?? "md";
  return `${BASE} ${cornerFor(variant, size)} ${VARIANT[variant]} ${sizingFor(variant, size)}`;
}

export type ProseLinkTone = "accent" | "muted";

/**
 * A link's ink, by tone. `accent` is readable gold, for a link the sentence is
 * about. `muted` is the secondary ink, for a way round to somewhere else, and
 * brightens to the body ink under the pointer as `touchLink` does. An accent
 * link changes nothing on hover: its underline already says what it is.
 *
 * Two tones and no third that inherits: a link inside a tinted notice keeps
 * the readable gold rather than taking the notice's own ink (the owner's
 * choice on englishstreetventures/osn#1838).
 */
const PROSE_LINK_TONE = {
  accent: "base:text-ui-accent-ink",
  muted: "base:text-ui-ink-secondary base:hover:text-ui-ink",
} satisfies Readonly<Record<ProseLinkTone, string>>;

/**
 * The classes for a link set inside a sentence — "See our privacy notice",
 * "or edit Bloom & Co's listing".
 *
 * Not a `buttonClass` variant, because every `buttonClass` output starts
 * `inline-flex … whitespace-nowrap`, which holds a long link to one line where
 * a link in running text has to break with the words around it. So: inline,
 * no type size and no weight, both of which it takes from its sentence, and
 * underlined at rest at a 2px offset, because inside a sentence the underline
 * is what marks the words as a link without colour (WCAG 1.4.1), and a phone
 * has no hover to reveal one.
 *
 * For an `<a>`. A `<button>` lays out as an inline block even at
 * `display: inline`, so its words never wrap with the sentence; an in-page
 * action written in a sentence is an `<a href>` whose click handler does the
 * work.
 *
 * Its own focus ring, with `Button`'s values, since `@cire/landing` declares
 * no blanket `:focus-visible` rule. The corner is the `control` role, as on the
 * borderless buttons, and only the ring shows it. The transition names the
 * colours alone, so the ring lands the moment focus does.
 *
 * A link that stands alone rather than inside a sentence is not this: it is a
 * pill, `buttonClass({ variant: "outline" })`.
 */
export function proseLinkClass(options: { tone?: ProseLinkTone } = {}): string {
  const tone = options.tone ?? "accent";
  return (
    "base:underline base:underline-offset-2 base:rounded-ui-control " +
    "base:transition-[color,text-decoration-color] base:duration-(--dur-fast,100ms) base:ease-out " +
    "base:focus-visible:outline-2 base:focus-visible:outline-offset-2 base:focus-visible:outline-ui-focus " +
    PROSE_LINK_TONE[tone]
  );
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
