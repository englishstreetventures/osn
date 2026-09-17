import { CONTRACT_SCALAR_TOKENS } from "@shared/design-tokens";
import { Button } from "@shared/ui/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@shared/ui/ui/card";
import { Input } from "@shared/ui/ui/input";
import { createSignal, For, onCleanup } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";
import { Caption, Gallery, Mono, Readout, Rule, Section } from "./chrome.tsx";
import { type RadiusToken, ROUNDED } from "./utilities.ts";

export const meta = { title: "design-system/shape-motion", layout: "padded" as const };

const RADIUS_TOKENS = CONTRACT_SCALAR_TOKENS.radius;

function RadiusBox(props: { token: RadiusToken }) {
  let el!: HTMLDivElement;
  return (
    <div class="flex w-40 flex-col gap-2">
      <div
        ref={el}
        class={`${ROUNDED[props.token]} border-ui-hairline-strong bg-ui-surface h-20 w-full border-2`}
      />
      <Caption
        name={
          <div class="flex flex-col">
            <Mono>{props.token}</Mono>
            <Mono muted>{ROUNDED[props.token]}</Mono>
          </div>
        }
        value={<Readout of={() => el} property="border-top-left-radius" />}
      />
    </div>
  );
}

interface RadiusArgs extends StoryArgs {
  step: number;
}

/**
 * Five sized steps and one role. `control` is not a size: how round a button
 * is turns out to be an app-level decision independent of how round a card is
 * — musubi's house style is pill CTAs, cire's a sharp 4px, pulse between them.
 */
export const Radius: Story<RadiusArgs> = {
  args: { step: 2 },
  controls: { step: { kind: "range", min: 0, max: RADIUS_TOKENS.length - 1, step: 1 } },
  render: (args) => {
    const chosen = () => RADIUS_TOKENS[Math.min(RADIUS_TOKENS.length - 1, Math.max(0, args.step))];
    return (
      <Gallery
        title="Radius"
        intro={
          <>
            <Mono>hair</Mono> is a 2px softening that reads as "not a raw rectangle";{" "}
            <Mono>pill</Mono> is fully round. Everything between is the app's house style — cire
            maps <Mono>lg</Mono> to the same 6px as <Mono>md</Mono>, because nothing there is
            rounder than 6px except a pill.
          </>
        }
      >
        <Section title="The scale, and the role" eyebrow={`${RADIUS_TOKENS.length} tokens`}>
          <div class="flex flex-wrap gap-4">
            <For each={RADIUS_TOKENS}>{(token) => <RadiusBox token={token} />}</For>
          </div>
        </Section>
        <Section title="Why control is a role" eyebrow="a button and a card, independently round">
          <Rule>
            A shared control that picked one of the sized steps would be overridden at every call
            site in at least one app — which is exactly what{" "}
            <Mono>{'<Button class="rounded-pill">'}</Mono> ×16 in musubi was. It defaults to{" "}
            <Mono>md</Mono> rather than to a literal, so an app with no opinion gets its own mid
            radius and not this package's.
          </Rule>
          <div class="flex flex-wrap items-start gap-6">
            <div class="flex flex-col gap-3">
              <div class="flex items-center gap-3">
                <Button>rounded-ui-control</Button>
                <Input class="w-44" placeholder="rounded-ui-control" />
              </div>
              <Mono muted>--ui-radius-control</Mono>
            </div>
            <div class="flex flex-col gap-3">
              <Card class="w-64">
                <CardHeader>
                  <CardTitle>rounded-ui-lg</CardTitle>
                  <CardDescription>A card keeps the sized step.</CardDescription>
                </CardHeader>
                <CardContent>
                  <p class="text-ui-sm text-ui-ink-secondary">
                    The two radii change independently.
                  </p>
                </CardContent>
              </Card>
              <Mono muted>--ui-radius-lg</Mono>
            </div>
          </div>
        </Section>
        <Section title="Step through it" eyebrow={`step ${args.step} · ${ROUNDED[chosen()]}`}>
          <div
            class={`${ROUNDED[chosen()]} border-ui-hairline-strong bg-ui-surface-sunk flex h-32 w-72 items-center justify-center border-2`}
          >
            <Mono>{chosen()}</Mono>
          </div>
        </Section>
      </Gallery>
    );
  },
};

function ElevatedCard(props: { token: string; label: string }) {
  let el!: HTMLDivElement;
  return (
    <div class="flex w-64 flex-col gap-2">
      <div
        ref={el}
        class="rounded-ui-lg bg-ui-surface-raised text-ui-base text-ui-ink p-5"
        style={{ "box-shadow": `var(${props.token})` }}
      >
        {props.label}
      </div>
      <Caption
        name={<Mono>{props.token}</Mono>}
        value={<Readout of={() => el} property="box-shadow" />}
      />
    </div>
  );
}

/**
 * Two elevations, on a raised surface over the page. Plain custom properties
 * rather than `@theme` entries: a component consumes them inside its own rule
 * as `box-shadow: var(--ui-elev-1)`, and aliasing them would generate
 * utilities nobody spells.
 */
export const Elevation = () => (
  <Gallery
    title="Elevation"
    intro={
      <>
        Two shadows. <Mono>elev-1</Mono> lifts a card off the page; <Mono>elev-2</Mono> is a menu or
        popover floating above everything else. Both fall back to a neutral grey shadow, and an app
        that maps its own — cire maps a darker pair on its dark ramp — keeps its own depth.
      </>
    }
  >
    <Section title="On the page">
      <div class="rounded-ui-lg bg-ui-ground flex flex-wrap gap-8 p-8">
        <For each={CONTRACT_SCALAR_TOKENS.elevation}>
          {(token, i) => (
            <ElevatedCard token={token} label={i() === 0 ? "A card, lifted" : "A menu, floating"} />
          )}
        </For>
      </div>
    </Section>
  </Gallery>
);

/**
 * The focus ring's width and offset, with the ring forced on so it can be seen
 * without a keyboard. The colour is `--ui-focus`, its own token with a 3:1
 * floor — see the colour story.
 */
export const FocusRing = () => {
  let ring!: HTMLDivElement;
  return (
    <Gallery
      title="Focus ring"
      intro={
        <>
          One ring everywhere, never animated, always visible: <Mono>--ui-focus-width</Mono> and{" "}
          <Mono>--ui-focus-offset</Mono> are read inside a component's own{" "}
          <Mono>:focus-visible</Mono> rule, so they are custom properties rather than utilities.
        </>
      }
    >
      <Section title="Forced on">
        <div class="flex flex-wrap items-center gap-8 p-2">
          <div
            ref={ring}
            class="rounded-ui-control flex flex-col gap-2"
            style={{
              outline: "var(--ui-focus-width) solid var(--ui-focus)",
              "outline-offset": "var(--ui-focus-offset)",
            }}
          >
            <Button variant="outline">Focused</Button>
          </div>
          <div class="text-ui-xs text-ui-ink-secondary flex flex-col gap-1">
            <span>
              width <Readout of={() => ring} property="outline-width" />
            </span>
            <span>
              offset <Readout of={() => ring} property="outline-offset" />
            </span>
            <span>
              colour <Readout of={() => ring} property="outline-color" />
            </span>
          </div>
        </div>
      </Section>
    </Gallery>
  );
};

interface MotionArgs extends StoryArgs {
  loop: boolean;
}

const DURATIONS = CONTRACT_SCALAR_TOKENS.motion.filter((t) => t.startsWith("--ui-dur-"));
const EASINGS = CONTRACT_SCALAR_TOKENS.motion.filter((t) => t.startsWith("--ui-ease-"));

/**
 * The track is 16rem wide with 0.25rem of padding each side and the puck is
 * 1.5rem, so the far end is 14rem away. A `%` inside `translateX` is the
 * puck's own width, not the track's, which is why the distance is a length.
 */
function Puck(props: { duration: string; easing: string; gone: boolean }) {
  return (
    <div class="rounded-ui-pill bg-ui-surface-sunk h-8 w-64 p-1">
      <div
        class="rounded-ui-pill bg-ui-accent h-6 w-6"
        style={{
          transition: `transform var(${props.duration}) var(${props.easing})`,
          transform: props.gone ? "translateX(14rem)" : "translateX(0)",
        }}
      />
    </div>
  );
}

/**
 * Three durations by two easings. A duration you cannot see is a number; press
 * play and the six pucks leave together and arrive apart.
 */
export const Motion: Story<MotionArgs> = {
  args: { loop: false },
  render: (args) => {
    const [gone, setGone] = createSignal(false);
    let root!: HTMLDivElement;
    const timer = setInterval(() => {
      if (args.loop) setGone((g) => !g);
    }, 1400);
    onCleanup(() => clearInterval(timer));

    return (
      <Gallery
        title="Motion"
        intro={
          <>
            <Mono>fast</Mono> for a hover or a toggle, <Mono>base</Mono> for a panel,{" "}
            <Mono>slow</Mono> for something that moves across the screen. <Mono>ease-out</Mono> is
            for things arriving; <Mono>ease-in-out</Mono> for things that go somewhere and stay
            there. Custom properties, read inside a component's own <Mono>transition</Mono>.
          </>
        }
      >
        <Section title="Durations × easings">
          <div class="flex items-center gap-3">
            <Button onClick={() => setGone((g) => !g)}>{gone() ? "Back" : "Play"}</Button>
            <span class="text-ui-xs text-ui-ink-secondary">
              or tick <Mono>loop</Mono> in the args panel
            </span>
          </div>
          <div ref={root} class="flex flex-wrap gap-x-12 gap-y-4">
            <For each={EASINGS}>
              {(easing) => (
                <div class="flex flex-col gap-3">
                  <Mono>{easing}</Mono>
                  <For each={DURATIONS}>
                    {(duration) => (
                      <div class="flex items-center gap-4">
                        <div class="text-ui-xs w-28 shrink-0">
                          <Mono muted>{duration}</Mono>
                        </div>
                        <Puck duration={duration} easing={easing} gone={gone()} />
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        </Section>
        <Section title="Resolved" eyebrow="what this page maps them to">
          <div class="text-ui-xs text-ui-ink-secondary flex flex-wrap gap-x-8 gap-y-2">
            <For each={CONTRACT_SCALAR_TOKENS.motion}>
              {(token) => (
                <span>
                  <Mono>{token}</Mono> <Readout of={() => root} property={token} />
                </span>
              )}
            </For>
          </div>
        </Section>
      </Gallery>
    );
  },
};
