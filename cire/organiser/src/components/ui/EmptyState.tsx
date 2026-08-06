import { type JSX, Show } from "solid-js";

/**
 * What a list says when there is nothing in it yet.
 *
 * A dashed border rather than a solid one: the box is a placeholder for content
 * that will arrive, and the dashes say so without a sentence having to.
 *
 * The seven hand-written copies of this shape all set `items-start` *and*
 * `text-center`, so a one-line title read centred inside its own box and
 * left-aligned against the box's edges — two rules fighting, and the fight
 * visible. Centred is what they were reaching for.
 */
export default function EmptyState(props: {
  title: string;
  description?: string;
  /** The one thing to do about it — an "Add the first guest" button. */
  action?: JSX.Element;
}) {
  return (
    <div class="border-border bg-surface/30 flex flex-col items-center gap-2 rounded-sm border border-dashed p-8 text-center">
      <p class="font-display text-text text-[1.05rem] font-light">{props.title}</p>
      <Show when={props.description}>
        <p class="font-body text-text-muted max-w-prose text-[0.82rem] leading-relaxed">
          {props.description}
        </p>
      </Show>
      <Show when={props.action}>
        <div class="mt-2">{props.action}</div>
      </Show>
    </div>
  );
}
