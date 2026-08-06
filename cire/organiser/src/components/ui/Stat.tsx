import { type JSX, Show } from "solid-js";

/**
 * One figure, said loudly: 84 guests, 12 days, $4,200 left.
 *
 * The serif at 2rem is the portal's one piece of decorative typography that
 * carries information rather than ornament, and `tabular-nums` is what keeps a
 * counting number from shuffling its own width as it ticks.
 *
 * The label is below the figure, not above it. A host scanning the Overview
 * grid reads the numbers first and looks for the word only when one of them is
 * surprising.
 */
export default function Stat(props: {
  /** Already formatted — this component does not know about money or dates. */
  value: JSX.Element;
  label: string;
  /** A trailing note: "of 120", "since Tuesday". */
  hint?: string;
}) {
  return (
    <div class="flex flex-col gap-0.5">
      <p class="font-display text-gold text-[2rem] leading-none font-light tabular-nums">
        {props.value}
      </p>
      <p class="font-body text-text text-[0.9rem]">{props.label}</p>
      <Show when={props.hint}>
        <p class="font-body text-text-muted text-[0.76rem]">{props.hint}</p>
      </Show>
    </div>
  );
}
