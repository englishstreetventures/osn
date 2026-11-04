import Skeleton, { type SkeletonStandIn } from "@cire/ui/skeleton";
import { For, type JSX } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";
import {
  Caption,
  Eyebrow,
  Gallery,
  Mono,
  Readout,
  Rule,
  Section,
} from "../design-system/chrome.tsx";
import { type CireTheme, cireStyle } from "./cire-mapping.ts";

export const meta = { title: "cire/ui/Skeleton", layout: "padded" as const };

type ThemeChoice = CireTheme | "both";
const THEME_OPTIONS = ["both", "dark", "light"] as const;
const themesFor = (choice: ThemeChoice): CireTheme[] =>
  choice === "both" ? ["dark", "light"] : [choice];

/**
 * The motion tokens the pulse reads beyond the contract, as every cire app
 * declares them (`cire/host/src/styles/global.css`): the scale and the house
 * in-out curve. The lab declares neither, and Tailwind's own `--ease-in-out`
 * is a different curve.
 */
const MOTION = {
  "--motion-scale": "1",
  "--ease-in-out": "cubic-bezier(0.65, 0, 0.35, 1)",
} satisfies JSX.CSSProperties;

function CirePanel(props: { theme: CireTheme; style?: JSX.CSSProperties; children: JSX.Element }) {
  return (
    <div
      class="rounded-ui-lg border-ui-hairline bg-ui-ground text-ui-ink flex min-w-0 flex-1 basis-80 flex-col gap-5 border p-5"
      style={{ ...cireStyle(props.theme), ...MOTION, ...props.style }}
    >
      <Eyebrow>cire · {props.theme}</Eyebrow>
      {props.children}
    </div>
  );
}

function Panels(props: {
  theme: ThemeChoice;
  style?: JSX.CSSProperties;
  children: () => JSX.Element;
}) {
  return (
    <div class="flex flex-wrap items-start gap-6">
      <For each={themesFor(props.theme)}>
        {(theme) => (
          <CirePanel theme={theme} style={props.style}>
            {props.children()}
          </CirePanel>
        )}
      </For>
    </div>
  );
}

interface ThemeArgs extends StoryArgs {
  cireTheme: ThemeChoice;
}
const themeControl = { cireTheme: { kind: "select" as const, options: THEME_OPTIONS } };

/**
 * One block, captioned with the corner and the fill the browser painted. The
 * ref is on a wrapper, since `Skeleton` takes none; the block is its child.
 */
function Measured(props: { standsFor: SkeletonStandIn; class: string; use: string }) {
  let wrap: HTMLDivElement | undefined;
  const block = () => wrap?.firstElementChild ?? undefined;
  return (
    <div class="flex flex-col gap-2">
      <div
        ref={(node) => {
          wrap = node;
        }}
      >
        <Skeleton standsFor={props.standsFor} class={props.class} />
      </div>
      <Caption
        name={
          <>
            <Mono>standsFor="{props.standsFor}"</Mono> — {props.use}
          </>
        }
        value={
          <>
            border-radius <Readout of={block} property="border-top-left-radius" /> · background{" "}
            <Readout of={block} property="background-color" />
          </>
        }
      />
    </div>
  );
}

function standInStory(standsFor: SkeletonStandIn, cls: string, use: string, intro: JSX.Element) {
  return {
    args: { cireTheme: "both" },
    controls: themeControl,
    render: (args) => (
      <Gallery title={`cire/ui Skeleton — ${standsFor}`} intro={intro}>
        <Panels theme={args.cireTheme}>
          {() => <Measured standsFor={standsFor} class={cls} use={use} />}
        </Panels>
      </Gallery>
    ),
  } satisfies Story<ThemeArgs>;
}

/** The default: a card or a list card, 16px, the full surface. */
export const Card = standInStory(
  "card",
  "h-20",
  "an event, a household, an overview card, a co-host",
  <>
    The default: the <Mono>lg</Mono> corner, 16px in cire, at the full surface and no edge, though
    the card it stands for wears a hairline. It pulses for 2s on the app's
    <Mono>--motion-scale</Mono> and <Mono>--ease-in-out</Mono>, as <Mono>Loading</Mono> does.
  </>,
);

/** A table's rows: the 6px corner of `Table`'s frame. */
export const Row = standInStory(
  "row",
  "h-14",
  "an RSVP table row (h-14); a household is h-28",
  <>
    The <Mono>sm</Mono> corner, 6px, which <Mono>Table</Mono>'s frame takes, at the full surface.
  </>,
);

/** A filter or a search field: 14px, the surface at 60%. */
export const Field = standInStory(
  "field",
  "h-7 w-64 max-w-full",
  "the guest list's search, the RSVP filter row",
  <>
    The <Mono>field</Mono> corner, 14px, at 60% of the surface: a toolbar piece is lighter than the
    blocks under it. At 28px tall the corner reads as a pill, as the filter it stands for does.
  </>,
);

/** A chip strip or a tab track: a pill, the surface at 60%. */
export const Pill = standInStory(
  "pill",
  "h-7 w-56 max-w-full",
  "the RSVP page's event tabs",
  <>A pill at 60% of the surface, for a strip of chips or a tab track in the view bar.</>,
);

/**
 * The four shapes where the host portal draws them, at the host's classes: the
 * RSVP view bar's first row (its divider, then the event tabs' pill), its
 * second row (the filter), the legend's room, then the table's head row and
 * rows a hairline apart; and the overview's band over its grid of cards.
 */
export const InPlace: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui Skeleton — in place"
      intro={
        <>
          The RSVP page while its replies load, then the overview's band and cards. The view bar
          keeps its divider beside the pill, so nothing moves sideways when the tabs arrive. The
          legend's line is held as empty room over the table. The blocks are placed and sized here
          as the host places and sizes them at 1280px.
        </>
      }
    >
      <Panels theme={args.cireTheme}>
        {() => (
          <>
            <Section title="View bar and table">
              <div class="border-ui-hairline flex flex-col gap-2 border-b pb-2">
                <div class="flex items-center gap-2">
                  <span aria-hidden="true" class="bg-ui-hairline h-5 w-px shrink-0" />
                  <Skeleton standsFor="pill" class="mr-auto h-7 w-56 max-w-full min-w-0" />
                </div>
                <Skeleton standsFor="field" class="h-7 w-full" />
              </div>
              <div class="flex flex-col gap-4">
                <div aria-hidden="true" class="h-5" />
                <div class="flex flex-col gap-px">
                  <Skeleton standsFor="row" class="h-10.5" />
                  <For each={[1, 2, 3]}>{() => <Skeleton standsFor="row" class="h-14" />}</For>
                </div>
              </div>
            </Section>
            <Section title="Overview">
              <div class="flex flex-col gap-4">
                <Skeleton class="h-47" />
                {/* The host's `auto-grid` at a 15rem minimum, written out. */}
                <div class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-4">
                  <For each={[1, 2, 3]}>{() => <Skeleton class="h-86" />}</For>
                </div>
              </div>
            </Section>
          </>
        )}
      </Panels>
      <Section title="What to look at">
        <Rule>
          The blocks pulse together and at one pace. The toolbar pieces are fainter than the rows
          and cards under them.
        </Rule>
      </Section>
    </Gallery>
  ),
};

/** Tailwind writes only the classes it finds in source, so each height is a literal here. */
const HEIGHTS = {
  "28px (h-7)": "h-7",
  "56px (h-14)": "h-14",
  "80px (h-20)": "h-20",
  "112px (h-28)": "h-28",
  "232px (h-58)": "h-58",
} as const;

type Height = keyof typeof HEIGHTS;

const SCALES = { "1×": "1", "4× slower": "4" } as const;

type Scale = keyof typeof SCALES;

interface PlaygroundArgs extends ThemeArgs {
  standsFor: SkeletonStandIn;
  height: Height;
  scale: Scale;
}

export const Playground: Story<PlaygroundArgs> = {
  args: { cireTheme: "both", standsFor: "card", height: "80px (h-20)", scale: "1×" },
  controls: {
    ...themeControl,
    standsFor: { kind: "select", options: ["card", "row", "field", "pill"] },
    height: { kind: "select", options: Object.keys(HEIGHTS) },
    scale: { kind: "select", options: Object.keys(SCALES) },
  },
  render: (args) => (
    <Panels theme={args.cireTheme} style={{ "--motion-scale": SCALES[args.scale] }}>
      {() => (
        <Measured
          standsFor={args.standsFor}
          class={`${HEIGHTS[args.height]} w-full`}
          use="playground"
        />
      )}
    </Panels>
  ),
};
