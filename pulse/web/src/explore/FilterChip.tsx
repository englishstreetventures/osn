import type { JSX } from "solid-js";

/**
 * A pill in the explore filter rail: category, or "More filters".
 *
 * The two call sites in `FilterRail` carried the same fourteen classes written
 * out twice, differing in one token — the inactive label colour — which is
 * drift rather than intent.
 *
 * ## `aria-pressed`, which neither call site had
 *
 * The rail's selected chip is marked by inverting its colours and nothing else,
 * so to a screen-reader user every chip was an unlabelled toggle reading the
 * same in both states. `aria-pressed` is the state in words; the inversion stays
 * as the visual carrier for everyone else.
 *
 * ## Not `@shared/ui`'s `Chip`
 *
 * That one is a `<span>` that *names* a state — "live", "quoted" — and is not
 * interactive at all. Same word, different component: this one is a toggle.
 */
export function FilterChip(props: {
  pressed: boolean;
  onPress: () => void;
  /** Muted when the chip is a control rather than a category — "More filters". */
  tone?: "default" | "muted";
  children: JSX.Element;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      class={`text-ui-sm inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 font-medium transition-colors ${
        props.pressed
          ? "border-foreground bg-foreground text-background"
          : `border-border bg-card hover:bg-secondary ${
              props.tone === "muted" ? "text-muted-foreground" : "text-foreground"
            }`
      }`}
      onClick={() => props.onPress()}
    >
      {props.children}
    </button>
  );
}
