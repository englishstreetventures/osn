import { type JSX, Show } from "solid-js";

/**
 * What a list says when there is nothing in it yet.
 *
 * A dashed border rather than a solid one: the box is a placeholder for content
 * that will arrive, and the dashes say so without a sentence having to.
 *
 * The portal had two shapes for this and neither was this one — a bordered card
 * with a gold eyebrow for "no organisations yet", and a bare grey line of text
 * for "no enquiries yet". The second is the one that reads as a bug: an empty
 * list with nothing drawn around it looks like a list that failed to load.
 */
export default function EmptyState(props: {
  title: string;
  description?: string;
  /** The one thing to do about it — a "Create one in musubi" link. */
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
