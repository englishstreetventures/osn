// Types only, through the package's own export: a consumer's type check reads
// `orb-api.ts` there and stops, rather than following `orb.tsx` into the
// vendored engine (`component-library.md` §Orb).
import type { OrbProps } from "@shared/ui/ui/orb";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import {
  createSignal,
  onMount,
  Show,
  splitProps,
  type Component,
  type ComponentProps,
  type JSX,
} from "solid-js";

/**
 * The box every size but `inline` draws: one centred row, glyph and label, at
 * the control weight. `inline` draws none, so it takes the sentence's type and
 * wraps with it; that is why these live in each size rather than in the base,
 * where an `inline` override would tie with them. The type step is not here
 * either: each size names its own, so no two `base:` utilities set one property
 * on one button and none depends on the order Tailwind emits them in.
 */
const BOX =
  "base:inline-flex base:items-center base:justify-center base:gap-2 base:whitespace-nowrap base:font-medium";

/**
 * `ghostDanger` destroys something, and says so only when you reach for it —
 * the "Remove" at the end of a connection row, where every row above and below
 * carries the same control.
 *
 * It is one variant rather than `ghost` plus a `text-ui-danger` at the call
 * site because the red belongs to the hover, not to the rest state: a column of
 * red labels down a list reads as an error state rather than as a column of
 * controls. `destructive` is the other end of the same axis — red at rest, for
 * the button that finally commits the destruction, not the one that offers it.
 *
 * `link` underlines on hover, as a link standing alone does. At
 * `size="inline"` it is a link set inside a sentence: underlined at rest, since
 * its colour alone would not tell it from the words around it, in the
 * sentence's own size, line height and weight, adding no height to the line.
 * An `<a>` wearing it wraps with the text, and its focus ring closes round
 * each line it spans (`box-decoration-clone`); a `<button>` stays one box.
 *
 * Keyboard focus draws a `--ui-focus` ring, which is a box shadow, and a
 * Windows contrast theme (forced colours) drops box shadows. So the focused
 * outline is hidden, not removed: `outline-hidden` is a transparent 2px
 * outline 2px off that the theme paints in a system colour, and outside the
 * theme it computes as `outline-none` does. It applies only while focused from
 * the keyboard; at rest the theme would ring every button. Like the `ring-2`
 * it stands in for, it is a fixed 2px and does not follow `--ui-focus-width`
 * or `--ui-focus-offset`. The colour transition below covers the outline's
 * colour, so focus starts one in the theme too, but the theme's colour stands
 * in for every value it passes through: the outline reads the same at once as
 * when settled (`button.browser.test.tsx`, in Chromium).
 */
const buttonVariants = cva(
  "base:cursor-pointer base:rounded-ui-control base:transition-colors base:focus-visible:outline-hidden base:focus-visible:ring-2 base:focus-visible:ring-ui-focus base:disabled:pointer-events-none base:disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "base:bg-ui-accent base:text-ui-on-accent base:hover:bg-ui-accent/90",
        destructive: "base:bg-ui-danger base:text-ui-on-danger base:hover:bg-ui-danger/90",
        outline:
          "base:border base:border-ui-hairline-strong base:bg-ui-ground base:hover:bg-ui-surface-sunk base:hover:text-ui-ink",
        secondary: "base:bg-ui-surface-sunk base:text-ui-ink base:hover:bg-ui-surface-sunk/80",
        ghost: "base:hover:bg-ui-surface-sunk base:hover:text-ui-ink",
        ghostDanger:
          "base:text-ui-ink-secondary base:hover:bg-ui-surface-sunk base:hover:text-ui-danger",
        link: "base:text-ui-accent-ink base:hover:underline",
      },
      size: {
        default: `${BOX} base:h-9 base:px-4 base:py-2 base:text-ui-base`,
        sm: `${BOX} base:h-8 base:px-3 base:text-ui-sm`,
        lg: `${BOX} base:h-10 base:px-8 base:text-ui-base`,
        icon: `${BOX} base:h-9 base:w-9 base:text-ui-base`,
        inline: "base:inline base:text-start base:box-decoration-clone",
      },
    },
    compoundVariants: [
      {
        variant: "link",
        size: ["default", "sm", "lg", "icon"],
        class: "base:underline-offset-4",
      },
      {
        variant: "link",
        size: "inline",
        class: "base:underline base:underline-offset-2",
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type Variant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;

/**
 * Each member names `variant`, `size` and `busy`, so a wrapper that `Omit`s
 * keys from the union (Kobalte's `as={Button}`) keeps all three, if widened.
 * The rules the union carries — `inline` only with `link`, no `busy` on `icon`
 * or `inline` — hold where `Button` is used directly.
 */
type ButtonProps = ComponentProps<"button"> &
  (
    | {
        variant?: Variant | null;
        size?: "default" | "sm" | "lg";
        /**
         * Something the button started is under way. The button keeps keyboard
         * focus, is announced as busy and unavailable (`aria-busy`,
         * `aria-disabled`), refuses activation — a click, Enter, Space, or the
         * form submission they would make — dims as a disabled button does
         * except while focused from the keyboard, and draws the 20px orb before
         * its label. Pass the label the wait wants ("Creating…"); the button
         * does not change it.
         *
         * Use it in place of `disabled={pending()}`, which drops focus to the
         * page; keep `disabled` for the other reasons a button cannot act, which
         * win when both are set.
         */
        busy?: boolean;
      }
    | { variant?: Variant | null; size: "icon"; busy?: never }
    | { variant: "link"; size: "inline"; busy?: never }
  );

/** `ButtonProps` with the union flattened: what the component reads. */
type Flat = ComponentProps<"button"> & {
  variant?: Variant | null;
  size?: "default" | "sm" | "lg" | "icon" | "inline";
  busy?: boolean;
};

/**
 * Dimmed as a disabled button is, and passed through by the pointer. A busy
 * button keeps keyboard focus, and its focus ring is a box shadow that the
 * button's own opacity would fade below 3:1, so while focused from the keyboard
 * it stays at full strength; the orb and its label still say it is busy.
 */
const BUSY = "base:pointer-events-none base:opacity-50 base:focus-visible:opacity-100";

/** The room the 20px orb takes, held while its module loads. */
const ROOM = "base:inline-block base:size-5 base:shrink-0";

// The orb's module is fetched the first time a page needs it, and only then,
// so an app none of whose buttons is ever busy fetches it never. Its own
// export, so the bundler gives it a chunk of its own, and a consumer's type
// check stops at the types above.
const [loadedOrb, setLoadedOrb] = createSignal<Component<OrbProps>>();
let loading: Promise<unknown> | undefined;
// Set by the first button that queues the idle-time fetch, so a page of such
// buttons queues one.
let prefetchQueued = false;

/**
 * Fetch the orb's module once. A failed fetch leaves the room the orb would
 * take, and is forgotten, so the next button to turn busy asks again; Chromium
 * then fetches the module anew (`button-busy-failed.browser.test.tsx`).
 */
function loadOrb() {
  loading ??= import("@shared/ui/ui/orb").then(
    (module) => setLoadedOrb(() => module.Orb),
    () => {
      loading = undefined;
    },
  );
}

/** Run `task` when the page is next idle, or soon where there is no idle callback. */
function whenIdle(task: () => void) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(task, { timeout: 2000 });
  else setTimeout(task, 1);
}

/** The orb, or the room for it until its module arrives. */
const BusyMark: Component = () => {
  onMount(loadOrb);
  return (
    <Show when={loadedOrb()} keyed fallback={<span aria-hidden="true" class={ROOM} />}>
      {(Orb) => <Orb size={20} state="working" />}
    </Show>
  );
};

const Button: Component<ButtonProps> = (props) => {
  const [local, others] = splitProps(props as Flat, [
    "variant",
    "size",
    "class",
    "busy",
    "onClick",
    "aria-busy",
    "aria-disabled",
    "children",
  ]);

  // A button that takes `busy` will likely wait on something, so fetch the
  // orb once the page is idle, and its first wait draws it at once. One idle
  // fetch per page: after a failed one, the orb is asked for again only when a
  // button turns busy.
  onMount(() => {
    if (local.busy === undefined || prefetchQueued || loadedOrb()) return;
    prefetchQueued = true;
    whenIdle(loadOrb);
  });

  // Attached whether or not the caller passed `onClick`: a submit button
  // usually has none, and a click is how a key press or a form's implicit
  // submission reaches it too, so cancelling the click refuses all of them.
  const click: JSX.EventHandler<HTMLButtonElement, MouseEvent> = (event) => {
    if (local.busy) {
      event.preventDefault();
      return;
    }
    const handler = local.onClick;
    if (typeof handler === "function") handler(event);
    else if (handler) handler[0](handler[1], event);
  };

  return (
    <button
      {...others}
      class={clsx(
        buttonVariants({ variant: local.variant, size: local.size }),
        local.busy && BUSY,
        local.class,
      )}
      aria-busy={local.busy ? "true" : local["aria-busy"]}
      aria-disabled={local.busy ? "true" : local["aria-disabled"]}
      onClick={click}
    >
      <Show when={local.busy}>
        <BusyMark />
      </Show>
      {local.children}
    </button>
  );
};

export { Button, buttonVariants };
export type { ButtonProps };
