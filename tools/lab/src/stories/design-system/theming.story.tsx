import {
  ALL_COLOR_TOKENS,
  CONTRACT_SCALAR_TOKENS,
  CONTRACT_SCALES,
  WCAG_TEXT,
} from "@shared/design-tokens";
import { Button } from "@shared/ui/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@shared/ui/ui/card";
import { Chip } from "@shared/ui/ui/chip";
import { Input } from "@shared/ui/ui/input";
import { Meter } from "@shared/ui/ui/meter";
import { Notice } from "@shared/ui/ui/notice";
import { Stat } from "@shared/ui/ui/stat";
import { type JSX, Show } from "solid-js";

import { theme } from "../../lab/state.ts";
import type { Story, StoryArgs } from "../../lab/types.ts";
import { ContrastCell, Eyebrow, Gallery, Mono, type Revision, Rule, Section } from "./chrome.tsx";
import type { ColorToken, LeadingStep, RadiusToken, TextStep, TrackingStep } from "./utilities.ts";

export const meta = { title: "design-system/theming", layout: "padded" as const };

type CireTheme = "dark" | "light";

/**
 * cire's mapping of the contract, resolved through its ramp by hand.
 *
 * Copied from `cire/host/src/styles/global.css` — the `:root` ramp for dark and
 * the `:root[data-theme="light"]` ramp for light, followed through the
 * `--ui-*: var(--…)` block at the bottom of that file. Every colour is the
 * literal that block resolves to; nothing here is invented. The fonts are
 * left out: cire's faces are self-hosted by its Astro pipeline and are not
 * loaded in the lab, so a mapping to them would render the platform fallback
 * while claiming to be cire.
 */
const CIRE_COLOR = {
  dark: {
    "--ui-ground": "oklch(16.8% 0.026 148)",
    "--ui-ground-deep": "oklch(13.2% 0.021 148)",
    "--ui-surface": "oklch(20.6% 0.028 149)",
    "--ui-surface-raised": "oklch(24.4% 0.032 149)",
    "--ui-surface-sunk": "oklch(14.4% 0.022 148)",
    "--ui-hairline": "oklch(85% 0.06 145 / 0.11)",
    "--ui-hairline-strong": "oklch(85% 0.06 145 / 0.44)",
    "--ui-ink": "oklch(94.6% 0.011 90)",
    "--ui-ink-secondary": "oklch(94.6% 0.011 90 / 0.58)",
    "--ui-ink-tertiary": "oklch(94.6% 0.011 90 / 0.4)",
    "--ui-accent": "oklch(75% 0.085 82)",
    "--ui-accent-strong": "oklch(82% 0.085 82)",
    "--ui-accent-soft": "oklch(75% 0.085 82 / 0.3)",
    "--ui-accent-ink": "oklch(84% 0.072 84)",
    "--ui-on-accent": "oklch(16.8% 0.026 148)",
    "--ui-success": "oklch(76% 0.142 147)",
    "--ui-warn": "oklch(80% 0.125 78)",
    "--ui-danger": "oklch(68% 0.14 21)",
    "--ui-on-danger": "oklch(16.8% 0.026 148)",
    "--ui-focus": "oklch(75% 0.085 82)",
  },
  light: {
    "--ui-ground": "oklch(88.6% 0.011 92)",
    "--ui-ground-deep": "oklch(84.5% 0.014 92)",
    "--ui-surface": "oklch(92.4% 0.009 92)",
    "--ui-surface-raised": "oklch(95.2% 0.007 92)",
    "--ui-surface-sunk": "oklch(85.8% 0.013 92)",
    "--ui-hairline": "oklch(44% 0.022 340 / 0.18)",
    "--ui-hairline-strong": "oklch(44% 0.022 340 / 0.74)",
    "--ui-ink": "oklch(27% 0.018 340)",
    "--ui-ink-secondary": "oklch(44% 0.022 340)",
    "--ui-ink-tertiary": "oklch(44% 0.022 340 / 0.74)",
    "--ui-accent": "oklch(64% 0.095 78)",
    "--ui-accent-strong": "oklch(70% 0.095 78)",
    "--ui-accent-soft": "oklch(64% 0.095 78 / 0.34)",
    "--ui-accent-ink": "oklch(46% 0.082 74)",
    "--ui-on-accent": "oklch(24% 0.018 340)",
    "--ui-success": "oklch(43% 0.115 148)",
    "--ui-warn": "oklch(45% 0.105 62)",
    "--ui-danger": "oklch(50% 0.15 25)",
    "--ui-on-danger": "oklch(88.6% 0.011 92)",
    "--ui-focus": "oklch(38% 0.072 141)",
  },
} as const satisfies Record<CireTheme, Record<ColorToken, string>>;

/** The same in both of cire's themes: the house is stationery, not app-store chrome. */
const CIRE_RADIUS = {
  "--ui-radius-hair": "2px",
  "--ui-radius-sm": "4px",
  "--ui-radius-md": "6px",
  "--ui-radius-lg": "6px",
  "--ui-radius-pill": "999px",
  "--ui-radius-control": "4px",
  /* The one place the stationery house is round: a sheet's grip is measured
     against the screen edge it is pulled from, not against a card's corner. */
  "--ui-radius-sheet": "28px",
} as const satisfies Record<RadiusToken, string>;

const CIRE_TEXT = {
  "--ui-text-xs": "0.72rem",
  "--ui-text-sm": "0.82rem",
  "--ui-text-base": "0.9rem",
  "--ui-text-md": "1.05rem",
  "--ui-text-lg": "1.3rem",
  "--ui-text-xl": "1.75rem",
  "--ui-text-2xl": "2.5rem",
} as const satisfies Record<`--ui-text-${TextStep}`, string>;

const CIRE_TRACKING = {
  "--ui-tracking-tight": "-0.02em",
  "--ui-tracking-normal": "0em",
  "--ui-tracking-wide": "0.04em",
  "--ui-tracking-wider": "0.1em",
  "--ui-tracking-widest": "0.16em",
  "--ui-tracking-ultra": "0.2em",
} as const satisfies Record<`--ui-tracking-${TrackingStep}`, string>;

const CIRE_LEADING = {
  "--ui-leading-none": "1.1",
  "--ui-leading-tight": "1.2",
  "--ui-leading-snug": "1.4",
  "--ui-leading-normal": "1.6",
  "--ui-leading-relaxed": "1.75",
} as const satisfies Record<`--ui-leading-${LeadingStep}`, string>;

function cireStyle(which: CireTheme): JSX.CSSProperties {
  return { ...CIRE_COLOR[which], ...CIRE_RADIUS, ...CIRE_TEXT, ...CIRE_TRACKING, ...CIRE_LEADING };
}

/**
 * Every token an app would map, set to `initial` — the guaranteed-invalid
 * value for an unregistered custom property — so each `var(--ui-x, fallback)`
 * inside takes its fallback. This is what an app that adopted the contract and
 * mapped nothing looks like: legible, and nobody's brand.
 */
function unmappedStyle(): JSX.CSSProperties {
  const style: JSX.CSSProperties = {};
  const tokens: string[] = [
    ...ALL_COLOR_TOKENS,
    ...CONTRACT_SCALAR_TOKENS.radius,
    ...CONTRACT_SCALAR_TOKENS.fontFamily,
    ...Object.keys(CONTRACT_SCALES.text).map((s) => `--ui-text-${s}`),
    ...Object.keys(CONTRACT_SCALES.tracking).map((s) => `--ui-tracking-${s}`),
    ...Object.keys(CONTRACT_SCALES.leading).map((s) => `--ui-leading-${s}`),
    ...Object.keys(CONTRACT_SCALES.measure).map((s) => `--ui-measure-${s}`),
  ];
  for (const token of tokens) style[token as `-${string}`] = "initial";
  return style;
}

/** The same components, whatever the wrapper says they should look like. */
function Specimen(props: { revision: Revision }) {
  return (
    <div class="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Rooftop, Friday</CardTitle>
          <CardDescription>Carlton North · 7:00pm</CardDescription>
        </CardHeader>
        <CardContent class="flex flex-col gap-3">
          <p class="text-ui-base leading-ui-normal text-ui-ink-secondary">
            Twelve people are going and four are undecided.
          </p>
          <Meter value={68} max={100} label="Replied" />
        </CardContent>
      </Card>
      <div class="flex flex-wrap items-center gap-2">
        <Button>Going</Button>
        <Button variant="outline">Maybe</Button>
        <Button variant="destructive">Leave</Button>
      </div>
      <Input placeholder="Your name" />
      <div class="flex flex-wrap items-center gap-2">
        <Chip>draft</Chip>
        <Chip tone="success">live</Chip>
        <Chip tone="pending">awaiting</Chip>
        <Chip tone="accent">quoted</Chip>
      </div>
      <Notice tone="warn">Three guests have no email address.</Notice>
      <Stat value="84" label="Replied" hint="of 120 invited" />
      <div class="border-ui-hairline flex flex-col gap-2 border-t pt-4">
        <Eyebrow>measured inside this column</Eyebrow>
        <div class="grid grid-cols-2 gap-3">
          <ContrastCell
            fg="--ui-ink"
            bg="--ui-ground"
            min={WCAG_TEXT}
            sample="ink"
            revision={props.revision}
          />
          <ContrastCell
            fg="--ui-on-accent"
            bg="--ui-accent"
            min={WCAG_TEXT}
            sample="on-accent"
            revision={props.revision}
          />
        </div>
      </div>
    </div>
  );
}

function Column(props: {
  title: string;
  note: JSX.Element;
  style?: JSX.CSSProperties;
  revision: Revision;
}) {
  return (
    <div
      class="rounded-ui-lg border-ui-hairline bg-ui-ground text-ui-ink flex min-w-72 flex-1 flex-col gap-4 border p-5"
      style={props.style}
    >
      <div class="flex flex-col gap-1">
        <h2 class="text-ui-md text-ui-ink font-semibold">{props.title}</h2>
        <p class="text-ui-xs leading-ui-snug text-ui-ink-secondary">{props.note}</p>
      </div>
      <Specimen revision={props.revision} />
    </div>
  );
}

interface SideBySideArgs extends StoryArgs {
  cireTheme: "dark" | "light" | "follow";
  showUnmapped: boolean;
}

/**
 * The contract's central claim, made visible: a wrapper that redefines
 * `--ui-*` re-themes every shared component inside it, and nothing else
 * changes. The page column follows the lab toggle; the cire column is a `div`
 * with cire's ramp as inline custom properties; the unmapped column sets every
 * token to `initial` and shows the package's fallbacks.
 */
export const SideBySide: Story<SideBySideArgs> = {
  args: { cireTheme: "dark", showUnmapped: true },
  controls: { cireTheme: { kind: "select", options: ["dark", "light", "follow"] } },
  render: (args) => {
    const cire = (): CireTheme => (args.cireTheme === "follow" ? theme() : args.cireTheme);
    const revision: Revision = () => `${args.cireTheme}:${theme()}`;
    return (
      <Gallery
        title="One component set, three mappings"
        intro={
          <>
            <Mono>@theme inline</Mono> makes <Mono>bg-ui-surface</Mono> compile to{" "}
            <Mono>background-color: var(--ui-surface, …)</Mono>, resolved <em>at the element</em>{" "}
            rather than at <Mono>:root</Mono>. So a subtree that redefines a token is followed — a
            wedding's palette inside the organiser's chrome, a themed section on a landing page,
            this story. Without <Mono>inline</Mono> every column here would show the page theme. The
            contrast cells at the foot of each column are measured from that column's own paint.
          </>
        }
      >
        <div class="flex flex-wrap items-start gap-6">
          <Column
            title="The page"
            note={
              <>
                musubi's mapping, from <Mono>App.css</Mono>. Follows the light · dark toggle.
              </>
            }
            revision={revision}
          />
          <Column
            title={`cire · ${cire()}`}
            note={
              <>
                cire's ramp as inline <Mono>--ui-*</Mono> on this column's <Mono>div</Mono>. Gold is
                the accent, so <Mono>on-accent</Mono> is dark in both themes.
              </>
            }
            style={cireStyle(cire())}
            revision={revision}
          />
          <Show when={args.showUnmapped}>
            <Column
              title="Unmapped"
              note={
                <>
                  Every token set to <Mono>initial</Mono>: the package's fallbacks, a neutral
                  greyscale. Legible rather than correct — the intended failure.
                </>
              }
              style={unmappedStyle()}
              revision={revision}
            />
          </Show>
        </div>
        <Section title="What to look at">
          <Rule>
            The same <Mono>Button</Mono>, <Mono>Card</Mono>, <Mono>Chip</Mono> and{" "}
            <Mono>Notice</Mono> imports render in each column. The type scale moves too — cire's{" "}
            <Mono>sm</Mono> is 0.82rem where musubi's is 13px — and so does the control radius: pill
            on the page, 4px in cire, 6px unmapped. Flip the toggle: only the page column changes,
            unless <Mono>cireTheme</Mono> is set to follow.
          </Rule>
        </Section>
      </Gallery>
    );
  },
};

/** A themed subtree inside an unthemed one, at depth — the property holds however far down it is used. */
export const Nested = () => (
  <Gallery
    title="Nested"
    intro={
      <>
        A cire-mapped panel inside a musubi card inside the page. The inner components read their
        tokens from the nearest scope that defines them, which is what lets an organiser preview a
        wedding's palette without leaving the portal's own chrome.
      </>
    }
  >
    <div class="max-w-ui-md">
      <Card>
        <CardHeader>
          <CardTitle>Invite preview</CardTitle>
          <CardDescription>The portal's card, in the page's mapping.</CardDescription>
        </CardHeader>
        <CardContent>
          <div
            class="rounded-ui-md border-ui-hairline bg-ui-ground flex flex-col gap-3 border p-4"
            style={cireStyle("dark")}
          >
            <Eyebrow>inside: cire, dark</Eyebrow>
            <p class="text-ui-base leading-ui-normal text-ui-ink">
              You are invited. Every token this paragraph and these controls read is the panel's.
            </p>
            <div class="flex items-center gap-2">
              <Button>RSVP</Button>
              <Chip tone="accent">quoted</Chip>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  </Gallery>
);
