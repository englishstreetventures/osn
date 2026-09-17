import { Show, type JSX } from "solid-js";

/**
 * One figure, said loudly: 84 guests, 12 days, $4,200 left.
 *
 * `tabular-nums` is what keeps a counting number from shuffling its own width
 * as it ticks — a figure that reflows while it updates reads as broken rather
 * than as live.
 *
 * The label sits below the figure, not above it. Someone scanning a grid of
 * these reads the numbers first and looks for the word only when one of them is
 * surprising.
 */
export function Stat(props: {
  /** Already formatted — this component knows nothing about money or dates. */
  value: JSX.Element;
  label: string;
  /** A trailing note: "of 120", "since Tuesday". */
  hint?: string;
}) {
  return (
    <div class="base:flex base:flex-col base:gap-0.5">
      <p class="base:font-ui-display base:text-ui-xl base:font-light base:leading-ui-none base:tabular-nums base:text-ui-accent-ink">
        {props.value}
      </p>
      <p class="base:font-ui-body base:text-ui-base base:text-ui-ink">{props.label}</p>
      <Show when={props.hint}>
        <p class="base:font-ui-body base:text-ui-xs base:text-ui-ink-secondary">{props.hint}</p>
      </Show>
    </div>
  );
}
