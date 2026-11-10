import { Button, type ButtonProps } from "@shared/ui/ui/button";
import { Orb, type OrbProps, type OrbState } from "@shared/ui/ui/orb";
import { For } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";

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

const VARIANTS = [
  "default",
  "destructive",
  "outline",
  "secondary",
  "ghost",
  "link",
] as const satisfies readonly NonNullable<ButtonProps["variant"]>[];

/**
 * The nine states at both sizes on the page's own ground. The ink is the text
 * colour, so it follows the light · dark toggle with nothing set here. Each
 * orb moves for five seconds, then holds its still frame; reload to see the
 * motion again. Under reduced motion each holds its still frame from the start.
 */
export const States = () => (
  <div class="flex flex-col gap-8">
    <For each={SIZES}>
      {(size) => (
        <section class="flex flex-col gap-3">
          <h3 class="text-meta text-subtle">{size}px</h3>
          <div class="flex flex-wrap gap-6">
            <For each={STATES}>
              {(state) => (
                <figure class="flex w-20 flex-col items-center gap-2">
                  <Orb state={state} size={size} />
                  <figcaption class="text-meta text-subtle">{state}</figcaption>
                </figure>
              )}
            </For>
          </div>
        </section>
      )}
    </For>
  </div>
);

/**
 * The 20px orb inside a `Button` of each variant, beside its label, at full
 * strength, so its ink can be judged: each orb takes it from its button's text
 * colour, light on the filled variants in the light theme, dark on the rest.
 * A busy `Button` draws this orb itself, dimmed: `shared/ui/Button` → `Busy`.
 */
export const InButtons = () => (
  <div class="flex flex-col gap-6">
    <div class="flex flex-wrap items-center gap-3">
      <For each={VARIANTS}>
        {(variant) => (
          <Button variant={variant}>
            <Orb size={20} />
            {variant}
          </Button>
        )}
      </For>
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <For each={STATES}>
        {(state) => (
          <Button>
            <Orb state={state} size={20} />
            {state}
          </Button>
        )}
      </For>
    </div>
  </div>
);

interface PlaygroundArgs extends StoryArgs {
  state: OrbState;
  size: number;
}

/**
 * One orb with live args. Like every orb it moves for five seconds and then
 * holds still, an arg change included; reload the story to see it move again.
 */
export const Playground: Story<PlaygroundArgs> = {
  layout: "centered",
  args: { state: "working", size: 64 },
  controls: {
    state: { kind: "select", options: STATES },
    size: { kind: "select", options: SIZES },
  },
  render: (args) => <Orb state={args.state} size={args.size === 20 ? 20 : 64} />,
};
