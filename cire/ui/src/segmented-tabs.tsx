import {
  createEffect,
  createMemo,
  createSelector,
  For,
  onCleanup,
  Show,
  type Component,
  type JSX,
} from "solid-js";
import { Dynamic } from "solid-js/web";

import { createSlidingPill } from "./lib/sliding-pill";

/**
 * A strip of choices in one rounded glass track, with one highlight that
 * slides to the chosen one: the portals' segmented controls (owner,
 * englishstreetventures/osn#1845) — a module's views, the edit modes, the
 * vendor portal's two views, an RSVP list's events, the invite's sections.
 *
 * ## Look
 *
 * A 28px track: a 1px hairline on the surface at 30%, 2px inside it, so each
 * choice is 22px whatever font the platform has. The highlight is glass: the
 * raised surface at 55% under the accent at 14%, an inner lip, a light inner
 * edge (`--glass-edge`), a hairline ring, the app's first lift and a 12px
 * frosted backdrop. It slides on the house spring and jumps for a reader who
 * has turned motion down (`lib/sliding-pill.ts`). It sits in its own layer,
 * clipped to the track's shape, so an overshoot past either end is cut by the
 * track and no choice's focus ring is.
 *
 * Labels are sentence case at the extra-small step, normal weight, in the
 * secondary ink; the chosen one in the readable accent ink. Under the pointer
 * an unchosen choice goes halfway: half the glass's tint and an ink between
 * the two. The colours fade on `--dur-base` and name their properties, so the
 * focus ring — the dashboard's 2px ring at 2px — never fades in.
 *
 * ## Meaning
 *
 * `semantics` keeps each strip's ARIA, because the strips mean different
 * things:
 *
 * - `tabs` — views of one thing: a named `tablist` of `tab`s with the call
 *   site's ids and panel, one tab stop, the arrows, Home and End moving focus
 *   without choosing, Enter, Space or a click choosing (manual activation: a
 *   view mounts and fetches, so passing over one must not open it).
 * - `radio` — alternative ways to do one job: a named `radiogroup` of
 *   `radio`s, each its own tab stop. `aria-checked` follows `value` alone, so
 *   a choice the call site refuses (an unsaved draft it will not drop) never
 *   shows as made.
 * - `current` — places the page can be: a named `group` of buttons, the
 *   chosen one `aria-current="page"`.
 *
 * ## Items
 *
 * Each item's fields are read as they change and the strip is keyed by
 * `value`, so a call site may rebuild `items` on every keystroke (a count, a
 * state in a name) and keep each choice's element, focus and highlight.
 * `icon` draws before the label; `iconOnly` hides the label for assistive
 * technology alone and hands it to `tipAttribute`, the attribute the app's
 * own tooltip layer reads. `name` replaces the accessible name when it says
 * more than the label; `after` draws a count or a mark after it.
 *
 * `scroll` keeps the strip on one row and lets it scroll sideways inside its
 * box, with room for the focus ring and no scrollbar; the chosen choice, and
 * one the arrows reach, are scrolled into the strip, never the page.
 *
 * `class` is for the strip's place in its row only: `shrink-0`, `mr-auto`,
 * `max-w-full`, `min-w-0`.
 */

export interface SegmentedItem<V extends string = string> {
  value: V;
  label: string;
  icon?: Component<{ class?: string; "aria-hidden"?: "true"; strokeWidth?: number }>;
  name?: string;
  describedBy?: string;
  after?: (chosen: boolean) => JSX.Element;
}

export type SegmentedSemantics = "tabs" | "radio" | "current";

export interface SegmentedTabsProps<V extends string> {
  items: readonly SegmentedItem<V>[];
  value: V;
  onChange: (value: V) => void;
  label: string;
  semantics: SegmentedSemantics;
  iconOnly?: boolean;
  tipAttribute?: `data-${string}`;
  tabId?: (value: V) => string;
  panelId?: (value: V) => string;
  onIntent?: (value: V) => void;
  scroll?: boolean;
  class?: string;
}

const TRACK =
  "base:relative base:inline-flex base:h-7 base:w-max base:shrink-0 base:items-center base:gap-0.5 base:rounded-ui-pill base:border base:border-ui-hairline base:bg-ui-surface/30 base:p-0.5";

/** The glass's layer: the track's padding box, clipped to its shape. */
const CLIP =
  "base:pointer-events-none base:absolute base:inset-0 base:overflow-clip base:rounded-ui-pill";

/**
 * The glass. Its fill is the raised surface at 55% under the accent at 14%,
 * composited into one colour (accent 22.8% into raised, at 61.3%), so the
 * colour the label sits on can be read back and measured.
 */
const GLASS =
  "base:absolute base:top-0 base:left-0 base:rounded-ui-pill " +
  "base:[background-color:color-mix(in_srgb,color-mix(in_srgb,var(--ui-accent)_22.8%,var(--ui-surface-raised))_61.3%,transparent)] " +
  "base:shadow-[var(--inner-lip,inset_0_1px_0_rgb(255_255_255/0.06)),inset_0_0_0_1px_var(--glass-edge,rgb(255_255_255/0.1)),0_0_0_0.5px_var(--ui-hairline),var(--elev-1,var(--ui-elev-1))] " +
  "base:backdrop-blur-md base:backdrop-saturate-[1.6]";

/**
 * A choice. Halfway under the pointer: the raised surface at 27.5% under the
 * accent at 7% (accent 21.5% into raised, at 32.6%), and an ink midway between
 * the secondary ink and the readable accent ink.
 */
const ITEM =
  "base:relative base:inline-flex base:h-5.5 base:shrink-0 base:cursor-pointer base:items-center base:gap-1.5 base:rounded-ui-pill base:px-3 " +
  "base:font-ui-body base:text-ui-xs base:font-normal base:tracking-ui-normal base:leading-none base:whitespace-nowrap base:text-ui-ink-secondary base:outline-none " +
  "base:transition-[color,background-color] base:duration-[var(--dur-base,var(--ui-dur-base))] base:ease-[var(--ease-in-out,var(--ui-ease-in-out))] base:motion-reduce:transition-none " +
  "base:data-[chosen]:text-ui-accent-ink " +
  "base:not-data-[chosen]:hover:[background-color:color-mix(in_srgb,color-mix(in_srgb,var(--ui-accent)_21.5%,var(--ui-surface-raised))_32.6%,transparent)] " +
  "base:not-data-[chosen]:hover:[color:color-mix(in_srgb,var(--ui-ink-secondary),var(--ui-accent-ink))] " +
  "base:focus-visible:outline-2 base:focus-visible:outline-offset-2 base:focus-visible:outline-solid base:focus-visible:outline-ui-focus " +
  // A contrast theme drops the glass and its ink, so the chosen choice keeps
  // a 1px outline in the theme's own text colour.
  "base:forced-colors:data-[chosen]:outline-1 base:forced-colors:data-[chosen]:outline-solid base:forced-colors:data-[chosen]:outline-offset-0";

const ICON = "base:size-3.5 base:shrink-0";

/** A strip that scrolls: 4px of room all round for the ring, inside a matching margin. */
const SCROLLER =
  "base:-m-1 base:min-w-0 base:max-w-full base:overflow-x-auto base:p-1 base:[scrollbar-width:none]";

/** Space kept between a revealed choice and the strip's edge: the ring's. */
const REVEAL_INSET = 4;

const ROLE = { tabs: "tablist", radio: "radiogroup", current: "group" } as const;

export default function SegmentedTabs<V extends string>(props: SegmentedTabsProps<V>) {
  const pill = createSlidingPill(() => props.value, { ease: "spring" });
  const byValue = createMemo(() => new Map(props.items.map((item) => [item.value, item])));
  // Keyed by value: a rebuilt `items` with the same values keeps every element.
  const values = createMemo(() => props.items.map((item) => item.value), undefined, {
    equals: (a, b) => a.length === b.length && a.every((value, i) => value === b[i]),
  });
  // Only the two rows whose answer flips hear a change of choice.
  const isChosen = createSelector(() => props.value);
  // A strip whose value names no item (a deleted event, a stale link) still
  // needs one tab stop: its first item.
  const unmatched = createMemo(() => !values().includes(props.value));
  const refs = new Map<V, HTMLButtonElement>();
  let scroller: HTMLDivElement | undefined;

  /** Scroll the strip, and only the strip, until `el` is wholly in it. */
  function reveal(el: HTMLElement | undefined) {
    if (!props.scroll || !scroller || !el) return;
    const view = scroller.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    if (box.left < view.left + REVEAL_INSET) {
      scroller.scrollLeft -= view.left + REVEAL_INSET - box.left;
    } else if (box.right > view.right - REVEAL_INSET) {
      scroller.scrollLeft += box.right - (view.right - REVEAL_INSET);
    }
  }

  // The chosen choice in view when it changes, and once the strip has
  // mounted: a deep link to a choice past the edge opens on it.
  createEffect(() => reveal(refs.get(props.value)));

  function focusAt(index: number) {
    const list = values();
    if (list.length === 0) return;
    const el = refs.get(list[((index % list.length) + list.length) % list.length]!);
    el?.focus({ preventScroll: true });
    reveal(el);
  }

  function onKeyDown(event: KeyboardEvent, index: number) {
    if (props.semantics !== "tabs") return;
    const last = values().length - 1;
    const to =
      event.key === "ArrowRight"
        ? index + 1
        : event.key === "ArrowLeft"
          ? index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (to === null) return;
    event.preventDefault();
    focusAt(to);
  }

  const track = (
    <div
      role={ROLE[props.semantics]}
      aria-label={props.label}
      class={props.scroll ? TRACK : `${TRACK} ${props.class ?? ""}`.trim()}
    >
      <span ref={pill.track} aria-hidden="true" class={CLIP}>
        <span data-segmented-glass class={GLASS} style={pill.style()} />
      </span>
      <For each={values()}>
        {(value, index) => {
          const item = () => byValue().get(value)!;
          const chosen = () => isChosen(value);
          return (
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a radio whose choice can be refused cannot be a native one: it has moved its own state by the time the handler runs.
            <button
              ref={(el) => {
                refs.set(value, el);
                onCleanup(() => {
                  if (refs.get(value) === el) refs.delete(value);
                });
                pill.item(value)(el);
                // The app's tooltip attribute, set on the element rather than
                // spread, so the button's other bindings stay their own.
                createEffect(() => {
                  const attribute = props.tipAttribute;
                  if (!attribute) return;
                  if (props.iconOnly) el.setAttribute(attribute, item().label);
                  else el.removeAttribute(attribute);
                  onCleanup(() => el.removeAttribute(attribute));
                });
              }}
              type="button"
              class={ITEM}
              data-chosen={chosen() ? "" : undefined}
              role={
                props.semantics === "tabs"
                  ? "tab"
                  : props.semantics === "radio"
                    ? "radio"
                    : undefined
              }
              id={props.semantics === "tabs" ? props.tabId?.(value) : undefined}
              aria-controls={props.semantics === "tabs" ? props.panelId?.(value) : undefined}
              aria-selected={props.semantics === "tabs" ? chosen() : undefined}
              aria-checked={props.semantics === "radio" ? chosen() : undefined}
              aria-current={props.semantics === "current" && chosen() ? "page" : undefined}
              tabindex={
                props.semantics === "tabs"
                  ? chosen() || (unmatched() && index() === 0)
                    ? 0
                    : -1
                  : undefined
              }
              aria-label={item().name}
              aria-describedby={item().describedBy}
              onKeyDown={(event) => onKeyDown(event, index())}
              onPointerEnter={() => props.onIntent?.(value)}
              onFocus={() => props.onIntent?.(value)}
              onClick={() => {
                if (!chosen()) props.onChange(value);
              }}
            >
              <Show when={item().icon}>
                {(icon) => (
                  <Dynamic component={icon()} aria-hidden="true" strokeWidth={1.75} class={ICON} />
                )}
              </Show>
              <span class={props.iconOnly ? "base:sr-only" : undefined}>{item().label}</span>
              {item().after?.(chosen())}
            </button>
          );
        }}
      </For>
    </div>
  );

  return (
    <Show when={props.scroll} fallback={track}>
      <div ref={scroller} class={`${SCROLLER} ${props.class ?? ""}`.trim()}>
        {track}
      </div>
    </Show>
  );
}
