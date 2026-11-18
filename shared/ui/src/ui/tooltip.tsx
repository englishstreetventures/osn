import { Tooltip as KobalteTooltip } from "@kobalte/core/tooltip";
import { batch, createSignal, splitProps, type JSX } from "solid-js";

import type { SafeProps } from "./props";

/**
 * The element Kobalte's trigger renders as: a plain inline `<span>`.
 *
 * Kobalte's trigger is a `<button>` by default, which puts every badge in the
 * tab order. It also adds two attributes this span must not carry. `type` is a
 * button's, and `aria-describedby` points at the open panel, which Chrome then
 * exposes as the trigger's description, so a screen reader hears the words a
 * second time even though the panel is `aria-hidden`. Kobalte sets that
 * attribute before the caller's props, and Solid's `mergeProps` skips
 * `undefined`, so a caller cannot clear it; only the element can decline it.
 * Everything else is spread: the ref the panel is positioned against and the
 * pointer handlers that open it.
 */
function TriggerSpan(props: SafeProps<"span"> & { type?: string }) {
  const [, rest] = splitProps(props, ["type", "aria-describedby"]);
  return <span {...rest} />;
}

/** How long the pointer rests on a label before its panel opens. */
const OPEN_DELAY = 400;

/**
 * How long a panel stays once the pointer leaves its label: none. Kobalte's
 * safe area still keeps it while the pointer crosses the gap onto it, so the
 * panel can be hovered (WCAG 2.1 SC 1.4.13); leaving anywhere else closes it.
 */
const CLOSE_DELAY = 0;

/** How soon after one panel closes the next opens with no wait and no entry. */
const SKIP_DELAY = 300;

interface TooltipProps {
  /**
   * The explanation. A screen reader gets it once, as hidden text after the
   * children; a mouse user sees it in a panel on hover. One string feeds both,
   * so neither copy can drift from the other.
   */
  text: string;
  /** What the pointer rests on: a badge, a glyph. Passive, never a control. */
  children: JSX.Element;
}

/**
 * A short label that explains itself on hover.
 *
 * The panel is for the eye only. It is `aria-hidden`, and nothing points at it,
 * because the same words already sit in the trigger as `sr-only` text. The
 * hidden copy is `normal-case`, because a trigger inside an `uppercase` run
 * would otherwise pass the transform to a screen reader as capitals.
 *
 * Hover only. The trigger is not focusable, so it adds no tab stop, and Kobalte
 * ignores touch, so keyboard and touch users never see the panel. Use it where
 * the explanation is a convenience; an explanation a reader needs belongs in
 * visible text.
 *
 * The panel portals to `<body>`. Inside a modal `<dialog>` that paints under
 * the top layer, so this is not for a trigger inside a `Modal`.
 *
 * ## Timing and motion
 *
 * A panel opens {@link OPEN_DELAY}ms after the pointer arrives, grows from the
 * label with a fade and the shared entry scale, and goes the moment the pointer
 * leaves, with no exit. Moving from one label to the next within
 * {@link SKIP_DELAY}ms of a panel closing opens the next at once, and that
 * panel does not animate: a row of badges read one after another shows each
 * explanation in place rather than replaying the entry on every one.
 *
 * Kobalte opens those at once but gives the panel nothing to say so, and its
 * warm-up state is shared by every Kobalte tooltip on the page, cire's sidebar
 * ones included. So the open is measured instead: an open that lands sooner
 * than half the delay after the pointer arrived is an instant one. Kobalte's
 * delayed open is a timer of the full delay, never early, so half of it parts
 * the two with room for timer jitter. The root is controlled, so the panel
 * mounts once with `data-instant` already on it.
 *
 * Reduced motion needs nothing here: `tokens.css` switches `animate-in` off
 * for the whole page.
 */
export function Tooltip(props: TooltipProps) {
  const [open, setOpen] = createSignal(false);
  const [instant, setInstant] = createSignal(false);
  let arrivedAt = Number.NEGATIVE_INFINITY;
  const onOpenChange = (next: boolean) =>
    batch(() => {
      setInstant(next && performance.now() - arrivedAt < OPEN_DELAY / 2);
      setOpen(next);
    });
  return (
    <KobalteTooltip
      placement="top"
      gutter={4}
      openDelay={OPEN_DELAY}
      closeDelay={CLOSE_DELAY}
      skipDelayDuration={SKIP_DELAY}
      open={open()}
      onOpenChange={onOpenChange}
    >
      {/* `inline-block`, so the box the panel is placed against is the whole
          of the children. An inline span's box is its last line box only, and a
          badge that wraps to two lines would have its first line covered. */}
      <KobalteTooltip.Trigger
        as={TriggerSpan}
        class="base:inline-block"
        // Kobalte calls this before its own handler, so the time is set before
        // an open it triggers at once.
        onPointerEnter={() => (arrivedAt = performance.now())}
      >
        {props.children}
        <span class="base:sr-only base:normal-case">{props.text}</span>
      </KobalteTooltip.Trigger>
      <KobalteTooltip.Portal>
        <KobalteTooltip.Content
          aria-hidden="true"
          data-instant={instant() ? "" : undefined}
          class="base:bg-ui-surface-raised base:text-ui-ink base:border-ui-hairline base:z-50 base:max-w-ui-xs base:rounded-ui-md base:border base:px-2 base:py-1 base:text-ui-xs base:leading-ui-snug base:shadow-md base:origin-(--kb-popper-content-transform-origin) base:data-[expanded]:not-data-[instant]:animate-in base:data-[expanded]:fade-in-0 base:data-[expanded]:zoom-in"
        >
          {props.text}
        </KobalteTooltip.Content>
      </KobalteTooltip.Portal>
    </KobalteTooltip>
  );
}
