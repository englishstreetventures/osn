import { Orb, type OrbProps, type OrbState } from "@shared/ui/ui/orb";
import { createMemo, For } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";
import { themeVersion } from "../design-system/measure.ts";

export const meta = { title: "shared/ui/Orb", layout: "padded" as const };

const STATES = [
  "working",
  "searching",
  "solving",
  "listening",
  "connecting",
  "weaving",
  "composing",
  "breathing",
  "shaping",
] as const satisfies readonly OrbState[];

const SIZES = [64, 20] as const satisfies readonly OrbProps["size"][];

/**
 * Whether the lab is on its dark theme. Read through `themeVersion()`, which
 * bumps after `<html class>` changes, so an orb's ink follows the toggle.
 */
function usePageDark(): () => boolean {
  return createMemo(() => {
    themeVersion();
    return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  });
}

/**
 * The nine states at both sizes on the page's own ground, ink following the
 * light · dark toggle. Under reduced motion each holds its still frame.
 */
export const States = () => {
  const dark = usePageDark();
  return (
    <div class="flex flex-col gap-8">
      <For each={SIZES}>
        {(size) => (
          <section class="flex flex-col gap-3">
            <h2 class="text-meta text-muted-foreground">{size}px</h2>
            <div class="flex flex-wrap gap-6">
              <For each={STATES}>
                {(state) => (
                  <figure class="flex w-20 flex-col items-center gap-2">
                    <Orb state={state} size={size} dark={dark()} />
                    <figcaption class="text-meta text-muted-foreground">{state}</figcaption>
                  </figure>
                )}
              </For>
            </div>
          </section>
        )}
      </For>
    </div>
  );
};

/**
 * The 20px orb on the accent fill, beside a label, as a busy filled button
 * draws it. The fill is the inverse of the page's ground, so the ink is too.
 */
export const OnAccent = () => {
  const dark = usePageDark();
  return (
    <div class="flex flex-wrap gap-3">
      <For each={STATES}>
        {(state) => (
          <span class="bg-ui-accent text-ui-on-accent rounded-ui-pill inline-flex items-center gap-2 px-4 py-2">
            <Orb state={state} size={20} dark={!dark()} />
            <span class="text-ui-sm">{state}</span>
          </span>
        )}
      </For>
    </div>
  );
};

interface PlaygroundArgs extends StoryArgs {
  state: OrbState;
  size: number;
  dark: boolean;
}

/** One orb with live args. `dark` is set by hand here, not by the theme. */
export const Playground: Story<PlaygroundArgs> = {
  layout: "centered",
  args: { state: "working", size: 64, dark: false },
  controls: {
    state: { kind: "select", options: STATES },
    size: { kind: "select", options: SIZES },
  },
  render: (args) => <Orb state={args.state} size={args.size === 20 ? 20 : 64} dark={args.dark} />,
};
