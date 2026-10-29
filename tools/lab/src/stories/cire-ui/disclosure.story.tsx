import Disclosure, { type DisclosureTone } from "@cire/ui/disclosure";
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

export const meta = { title: "cire/ui/Disclosure", layout: "padded" as const };

type ThemeChoice = CireTheme | "both";

const THEME_OPTIONS = ["both", "dark", "light"] as const;

function themesFor(choice: ThemeChoice): CireTheme[] {
  return choice === "both" ? ["dark", "light"] : [choice];
}

/** A wrapper that carries cire's whole `--ui-*` mapping for one theme. */
function CirePanel(props: { theme: CireTheme; children: JSX.Element }) {
  return (
    <div
      class="rounded-ui-lg border-ui-hairline bg-ui-ground text-ui-ink flex min-w-0 flex-1 basis-80 flex-col gap-5 border p-5"
      style={cireStyle(props.theme)}
    >
      <Eyebrow>cire · {props.theme}</Eyebrow>
      {props.children}
    </div>
  );
}

function Panels(props: { theme: ThemeChoice; children: JSX.Element }) {
  return (
    <div class="flex flex-wrap items-start gap-6">
      <For each={themesFor(props.theme)}>
        {(theme) => <CirePanel theme={theme}>{props.children}</CirePanel>}
      </For>
    </div>
  );
}

interface ThemeArgs extends StoryArgs {
  cireTheme: ThemeChoice;
}

const themeControl = { cireTheme: { kind: "select" as const, options: THEME_OPTIONS } };

/** The marker of the first disclosure inside `wrap`, found as the browser lays it out. */
function markerIn(wrap: Element | undefined): Element | undefined {
  const summary = wrap?.querySelector("details > summary");
  return summary ? [...summary.children].find((el) => el.getAttribute("aria-hidden")) : undefined;
}

/** One disclosure, captioned with the turn the browser painted on its marker. */
function Measured(props: { label: string; children: JSX.Element }) {
  let wrap: HTMLDivElement | undefined;
  return (
    <div class="flex min-w-0 flex-col gap-2">
      <div
        ref={(node) => {
          wrap = node;
        }}
      >
        {props.children}
      </div>
      <Caption
        name={<Mono>{props.label}</Mono>}
        value={
          <>
            marker rotate <Readout of={() => markerIn(wrap)} property="rotate" />
          </>
        }
      />
    </div>
  );
}

/** Closed beside open, both at the top of their row. */
function Pair(props: { tone: DisclosureTone; summary: string; children: JSX.Element }) {
  return (
    <div class="grid grid-cols-2 items-start gap-3">
      <Measured label="closed">
        <Disclosure tone={props.tone} summary={props.summary}>
          {props.children}
        </Disclosure>
      </Measured>
      <Measured label="open">
        <Disclosure tone={props.tone} summary={props.summary} open>
          {props.children}
        </Disclosure>
      </Measured>
    </div>
  );
}

/** The card tone, closed and open: Card's box with the well fill and a leading `›`. */
export const CardTone: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui Disclosure — card"
      intro={
        <>
          The default tone. Card's border, its 16px corner and the <Mono>well</Mono> fill; the
          summary row and the body pad themselves, so the whole row opens it. The leading{" "}
          <Mono>›</Mono> is the readable gold and turns a quarter as it opens. Click one to see the
          body fade in and the marker turn; cire's fonts are not loaded here, so judge the face in
          the app.
        </>
      }
    >
      <Panels theme={args.cireTheme}>
        <Pair tone="card" summary="Arrange tables">
          <p class="text-ui-sm text-ui-ink-secondary">
            Drag a table to move it. Tables keep their order on the printed plan.
          </p>
        </Pair>
      </Panels>
    </Gallery>
  ),
};

/** The rule tone, closed and open: a hairline under the row and a trailing `+`. */
export const RuleTone: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui Disclosure — rule"
      intro={
        <>
          An FAQ entry: the question in the display face at the large step, a hairline under the row
          and no fill. The trailing <Mono>+</Mono> is the readable gold and turns into ×.
        </>
      }
    >
      <Panels theme={args.cireTheme}>
        <Pair tone="rule" summary="Is there parking?">
          <p class="text-ui-base leading-ui-normal text-ui-ink-secondary">
            Yes, behind the hall. It fills by six.
          </p>
        </Pair>
      </Panels>
    </Gallery>
  ),
};

const CHANGES = [
  { what: "Renamed the reception to Dinner", who: "Mei", when: "Today, 10:42" },
  { what: "Moved the ceremony to 3:30 pm", who: "Sam", when: "Yesterday" },
  { what: "Added the Lee household", who: "Mei", when: "Mon 27 Oct" },
] as const;

/** A card disclosure holding a list, open: change history's shape. */
export const Rows: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui Disclosure — rows"
      intro={
        <>
          The body is a column with Card's 12px gap, inset to line up with the summary's contents. A
          caller that needs a different gap lays out its own children.
        </>
      }
    >
      <Panels theme={args.cireTheme}>
        <Disclosure summary="Change history" open>
          <For each={CHANGES}>
            {(change) => (
              <div class="flex items-baseline justify-between gap-3">
                <p class="text-ui-sm text-ui-ink">{change.what}</p>
                <p class="text-ui-xs text-ui-ink-secondary shrink-0">
                  {change.who} · {change.when}
                </p>
              </div>
            )}
          </For>
        </Disclosure>
      </Panels>
    </Gallery>
  ),
};

/** A closed disclosure inside an open one: each marker follows its own. */
export const Nested: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui Disclosure — nested"
      intro={
        <>
          The import guide holds its formatting tips. The inner one is <Mono>nested</Mono>, so it
          takes the small corner, and its marker stays put while the outer one is open: each turns
          with its own disclosure only.
        </>
      }
    >
      <Panels theme={args.cireTheme}>
        <Measured label="outer open, inner closed">
          <Disclosure summary="How to structure your sheet" open>
            <p class="text-ui-sm text-ui-ink-secondary">
              Download the starter template, fill in your details, then upload it.
            </p>
            <Measured label="inner">
              <Disclosure summary="Formatting tips" nested>
                <p class="text-ui-sm text-ui-ink-secondary">
                  Dates as 2026-11-14 15:30, and the timezone as Australia/Sydney.
                </p>
              </Disclosure>
            </Measured>
          </Disclosure>
        </Measured>
      </Panels>
      <Section title="What to look at">
        <Rule>
          The outer marker reads 90deg and the inner one none. Open the inner one: only its own
          marker turns.
        </Rule>
      </Section>
    </Gallery>
  ),
};
