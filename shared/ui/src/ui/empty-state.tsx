import { Show, type JSX } from "solid-js";

/**
 * What a list says when there is nothing in it yet.
 *
 * A dashed border rather than a solid one: the box is a placeholder for content
 * that will arrive, and the dashes say so without a sentence having to.
 *
 * Two lessons from the copies this replaces, both worth keeping. The organiser
 * portal had seven hand-written versions that all set `items-start` *and*
 * `text-center`, so a one-line title read centred inside its own box and
 * left-aligned against the box's edges — two rules fighting, and the fight
 * visible. And the vendor portal had a version with no border at all, which is
 * the one that reads as a bug: an empty list with nothing drawn around it looks
 * like a list that failed to load.
 */
export function EmptyState(props: {
  title: string;
  description?: string;
  /** The one thing to do about it — an "Add the first guest" button. */
  action?: JSX.Element;
}) {
  return (
    <div class="base:flex base:flex-col base:items-center base:gap-2 base:rounded-ui-sm base:border base:border-dashed base:border-ui-hairline base:bg-ui-surface/30 base:p-8 base:text-center">
      <p class="base:font-ui-display base:text-ui-md base:font-light base:text-ui-ink">
        {props.title}
      </p>
      <Show when={props.description}>
        <p class="base:max-w-prose base:font-ui-body base:text-ui-sm base:leading-ui-relaxed base:text-ui-ink-secondary">
          {props.description}
        </p>
      </Show>
      <Show when={props.action}>
        <div class="base:mt-2">{props.action}</div>
      </Show>
    </div>
  );
}
