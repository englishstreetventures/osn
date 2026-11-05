import SkeletonOutline from "@cire/ui/skeleton-outline";
import { For, type JSX, Show } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";
import { Caption, Eyebrow, Gallery, Mono, Rule, Section } from "../design-system/chrome.tsx";
import { type CireTheme, cireStyle } from "./cire-mapping.ts";

export const meta = { title: "cire/ui/SkeletonOutline", layout: "padded" as const };

type ThemeChoice = CireTheme | "both";
const THEME_OPTIONS = ["both", "dark", "light"] as const;
const themesFor = (choice: ThemeChoice): CireTheme[] =>
  choice === "both" ? ["dark", "light"] : [choice];

/**
 * The motion tokens the pulse reads beyond the contract, as every cire app
 * declares them (`cire/host/src/styles/global.css`): the scale and the house
 * in-out curve. The lab declares neither.
 */
const MOTION = {
  "--motion-scale": "1",
  "--ease-in-out": "cubic-bezier(0.65, 0, 0.35, 1)",
} satisfies JSX.CSSProperties;

function CirePanel(props: { theme: CireTheme; style?: JSX.CSSProperties; children: JSX.Element }) {
  return (
    <div
      class="rounded-ui-lg border-ui-hairline bg-ui-ground text-ui-ink flex min-w-0 flex-1 basis-96 flex-col gap-5 border p-5"
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

/** Each piece drawn hollow, then the same markup as it lands. */
function Pair(props: { children: () => JSX.Element }) {
  return (
    <div class="flex flex-col gap-3">
      <Caption name="Loading" value={<Mono>SkeletonOutline</Mono>} />
      <SkeletonOutline>{props.children()}</SkeletonOutline>
      <Caption name="Loaded" value="the same markup" />
      {props.children()}
    </div>
  );
}

// ── Fixtures: markup shaped like the host's rows, with the lab's own words ──

function Legend() {
  return (
    <dl class="text-ui-sm text-ui-ink-secondary flex flex-wrap gap-x-4 gap-y-1">
      <For
        each={[
          ["Attending", "64"],
          ["Declined", "12"],
          ["Maybe", "4"],
          ["No reply", "40"],
          ["Invited", "120"],
        ]}
      >
        {([term, count]) => (
          <div class="flex items-center gap-1.5">
            <dt class="tracking-ui-wider uppercase">{term}</dt>
            <dd class="text-ui-ink">{count}</dd>
          </div>
        )}
      </For>
    </dl>
  );
}

function Disc(props: { stacked?: boolean }) {
  return (
    <span class={`inline-flex items-center ${props.stacked ? "flex-col gap-1" : "gap-1.5"}`}>
      <span
        data-skeleton="block"
        aria-hidden="true"
        class="bg-ui-accent text-ui-on-accent inline-flex size-4 items-center justify-center rounded-full"
      />
      <span class="text-ui-accent-ink text-ui-xs tracking-ui-wider uppercase">Attending</span>
    </span>
  );
}

function Pill(props: { children: JSX.Element }) {
  return (
    <button
      type="button"
      class="border-ui-hairline-strong rounded-ui-control text-ui-sm border px-3 py-1"
    >
      {props.children}
    </button>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 10 10" class="size-3" aria-hidden="true">
      <path d="M1 3l4 4 4-4" stroke="currentColor" fill="none" />
    </svg>
  );
}

const ROWS = [
  ["Chiamaka Okonkwo", "Okonkwo", "Vegetarian"],
  ["Hamish MacLeod", "MacLeod", "--"],
  ["Elif Haddad", "Haddad", "No nuts, dairy free"],
] as const;

function TableRows() {
  return (
    <table class="border-ui-hairline rounded-ui-sm text-ui-base w-full table-fixed border-separate border-spacing-0 border text-left">
      <thead>
        <tr>
          <th class="bg-ui-ground border-ui-hairline border-b px-3 py-2 font-normal">
            <button
              type="button"
              data-skeleton="text"
              class="text-ui-accent-ink text-ui-sm tracking-ui-wider inline-flex items-center gap-1 uppercase"
            >
              Guest
              <Chevron />
            </button>
          </th>
          <th class="text-ui-accent-ink text-ui-sm tracking-ui-wider bg-ui-ground border-ui-hairline border-b px-3 py-2 font-normal uppercase">
            Status
          </th>
          <th class="bg-ui-ground border-ui-hairline w-20 border-b px-3 py-2">
            <span class="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <For each={ROWS}>
          {([name, household, dietary]) => (
            <tr>
              <td class="border-ui-hairline/40 border-b px-3 py-2">
                <span class="block truncate">{name}</span>
                <span class="text-ui-ink-secondary text-ui-sm block truncate">
                  {household} · {dietary}
                </span>
              </td>
              <td class="border-ui-hairline/40 border-b px-3 py-2">
                <Disc />
              </td>
              <td class="border-ui-hairline/40 border-b px-3 py-2 text-right">
                <Pill>Edit</Pill>
              </td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );
}

function PhoneRow() {
  return (
    <ul class="border-ui-hairline rounded-ui-sm w-80 max-w-full border">
      <li class="flex items-start gap-3 px-3 py-3">
        <div class="flex w-20 shrink-0 justify-center pt-0.5">
          <Disc stacked />
        </div>
        <div class="text-ui-base min-w-0 flex-1">
          <span class="block truncate">Chiamaka Okonkwo</span>
          <span class="text-ui-ink-secondary text-ui-sm block">
            Okonkwo · replied for the household, with a note that runs to a second line
          </span>
        </div>
        <label class="inline-flex items-center gap-2">
          <input type="checkbox" role="switch" aria-checked="true" class="sr-only" checked />
          <span class="border-ui-accent bg-ui-accent inline-flex h-5 w-9 items-center rounded-full border p-0.5">
            <span class="bg-ui-on-accent size-3.5 translate-x-4 rounded-full" />
          </span>
          <span class="sr-only">Plus-one</span>
        </label>
      </li>
    </ul>
  );
}

/** Each run of words a bar per wrapped line; dots and dashes draw nothing. */
export const Bars: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui SkeletonOutline — bars"
      intro={
        <>
          Each run of words or digits is a bar the height of its letters, one per wrapped line, with
          a 4px corner at both ends of every line, at the ink's 10%. The legend's five pairs are ten
          bars; a dot or a dash between words draws nothing.
        </>
      }
    >
      <Panels theme={args.cireTheme}>
        {() => (
          <>
            <Section title="Legend line">
              <Pair>{() => <Legend />}</Pair>
            </Section>
            <Section title="A sentence that wraps">
              <Pair>
                {() => (
                  <p class="text-ui-sm text-ui-ink-secondary w-64 max-w-full">
                    Saving without changing these keeps the dietary requirements already given.
                  </p>
                )}
              </Pair>
            </Section>
          </>
        )}
      </Panels>
    </Gallery>
  ),
};

/** A table's rows in their frame: blocks for boxed controls and discs, a glyph block, hairlines kept. */
export const TableInPlace: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui SkeletonOutline — table rows"
      intro={
        <>
          The frame, the head row's ground and the hairlines stay as they are, and still. The Edit
          pill and the status disc (<Mono>data-skeleton="block"</Mono>) are one block each; the
          sortable head is a button marked <Mono>data-skeleton="text"</Mono>, so its word is a bar
          and its chevron a small glyph block.
        </>
      }
    >
      <Panels theme={args.cireTheme}>{() => <Pair>{() => <TableRows />}</Pair>}</Panels>
      <Section title="What to look at">
        <Rule>
          The loading table and the loaded one are the same height, row for row. Only the bars,
          blocks and glyph pulse.
        </Rule>
      </Section>
    </Gallery>
  ),
};

/** A stacked phone row: a disc, words that wrap, and a switch's track as one block. */
export const PhoneInPlace: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui SkeletonOutline — phone row"
      intro={
        <>
          A switch draws its track after a hidden input; the outline fills the track as one block.
          The muted line wraps, so it draws two bars.
        </>
      }
    >
      <Panels theme={args.cireTheme}>{() => <Pair>{() => <PhoneRow />}</Pair>}</Panels>
    </Gallery>
  ),
};

const WIDTHS = { "390px": "w-[390px]", "320px": "w-[320px]", "240px": "w-[240px]" } as const;
type Width = keyof typeof WIDTHS;
const SCALES = { "1×": "1", "4× slower": "4" } as const;
type Scale = keyof typeof SCALES;

interface PlaygroundArgs extends ThemeArgs {
  width: Width;
  scale: Scale;
  loaded: boolean;
}

export const Playground: Story<PlaygroundArgs> = {
  args: { cireTheme: "both", width: "390px", scale: "1×", loaded: false },
  controls: {
    ...themeControl,
    width: { kind: "select", options: Object.keys(WIDTHS) },
    scale: { kind: "select", options: Object.keys(SCALES) },
    loaded: { kind: "boolean" },
  },
  render: (args) => (
    <Panels theme={args.cireTheme} style={{ "--motion-scale": SCALES[args.scale] }}>
      {() => (
        <div class={`${WIDTHS[args.width]} flex max-w-full flex-col gap-4`}>
          <Show
            when={args.loaded}
            fallback={
              <SkeletonOutline>
                <div class="flex flex-col gap-4">
                  <Legend />
                  <PhoneRow />
                </div>
              </SkeletonOutline>
            }
          >
            <Legend />
            <PhoneRow />
          </Show>
        </div>
      )}
    </Panels>
  ),
};
