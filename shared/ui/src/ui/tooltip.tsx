import { Tooltip as KobalteTooltip } from "@kobalte/core/tooltip";
import { splitProps, type JSX } from "solid-js";

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
 */
export function Tooltip(props: TooltipProps) {
  return (
    <KobalteTooltip placement="top" gutter={4}>
      {/* `inline-block`, so the box the panel is placed against is the whole
          of the children. An inline span's box is its last line box only, and a
          badge that wraps to two lines would have its first line covered. */}
      <KobalteTooltip.Trigger as={TriggerSpan} class="base:inline-block">
        {props.children}
        <span class="base:sr-only base:normal-case">{props.text}</span>
      </KobalteTooltip.Trigger>
      <KobalteTooltip.Portal>
        <KobalteTooltip.Content
          aria-hidden="true"
          // `motion-safe:`, so a reader who has turned motion down gets the
          // panel without the movement whatever stylesheet the app brings.
          class="base:bg-ui-surface-raised base:text-ui-ink base:border-ui-hairline base:z-50 base:max-w-ui-xs base:rounded-ui-md base:border base:px-2 base:py-1 base:text-ui-xs base:leading-ui-snug base:shadow-md base:motion-safe:data-[expanded]:animate-in base:motion-safe:data-[closed]:animate-out base:data-[closed]:fade-out-0 base:data-[expanded]:fade-in-0 base:data-[closed]:zoom-out-95 base:data-[expanded]:zoom-in-95"
        >
          {props.text}
        </KobalteTooltip.Content>
      </KobalteTooltip.Portal>
    </KobalteTooltip>
  );
}
