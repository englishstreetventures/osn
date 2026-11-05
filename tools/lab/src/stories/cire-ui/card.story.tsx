import Card, {
  CardCta,
  type CardFill,
  type CardPadding,
  type CardTone,
  cardClass,
} from "@cire/ui/card";
import CireEyebrow from "@cire/ui/eyebrow";
import { For, type JSX, Show } from "solid-js";

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

export const meta = { title: "cire/ui/Card", layout: "padded" as const };

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

/**
 * The three ways a card is drawn: plain, the accent tone, and the whole
 * rectangle as one control. Each takes the large corner, 16px in cire.
 */
export const Cards: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui Card"
      intro={
        <>
          One border and the <Mono>lg</Mono> corner, which cire maps to 16px, at the default padding
          and fill; the next three stories show the other steps. The interactive card is a{" "}
          <Mono>&lt;button&gt;</Mono> wearing <Mono>cardClass</Mono>; hover it to see the border and
          fill answer. cire's fonts are not loaded here, so the type is the lab's: judge the face in
          the app.
        </>
      }
    >
      <Panels theme={args.cireTheme}>
        <Section title="Plain">
          <Card>
            <p class="text-ui-sm text-ui-ink">Guests who have replied</p>
            <p class="text-ui-xs text-ui-ink-secondary">Forty-two of sixty so far.</p>
          </Card>
        </Section>
        <Section title="With an eyebrow">
          <Card>
            <CireEyebrow>Next step</CireEyebrow>
            <p class="text-ui-sm text-ui-ink">Send your invitations</p>
            <p class="text-ui-xs text-ui-ink-secondary">Guests get a link by email.</p>
          </Card>
          <Card tone="accent">
            <CireEyebrow>Needs you</CireEyebrow>
            <p class="text-ui-sm text-ui-ink">Three enquiries are waiting</p>
          </Card>
        </Section>
        <Section title="Interactive">
          <button type="button" class={cardClass({ interactive: true })}>
            <CireEyebrow>Guests</CireEyebrow>
            <p class="text-ui-sm text-ui-ink">Manage your guest list</p>
            <CardCta>Open guests</CardCta>
          </button>
        </Section>
      </Panels>
      <Section title="What to look at">
        <Rule>
          Every card has the same 16px corner. The accent card differs in its border colour alone.
        </Rule>
      </Section>
    </Gallery>
  ),
};

/**
 * One `Card` with the props given, captioned with what the browser painted for
 * the property the step changes. The ref is on a wrapper, since `Card` takes
 * none; the card is its first child.
 */
function Measured(props: {
  name: string;
  property: string;
  padding?: CardPadding;
  fill?: CardFill;
  tone?: CardTone;
  children: JSX.Element;
}) {
  let wrap: HTMLDivElement | undefined;
  return (
    <div class="flex flex-col gap-2">
      <div
        ref={(node) => {
          wrap = node;
        }}
      >
        <Card padding={props.padding} fill={props.fill} tone={props.tone}>
          {props.children}
        </Card>
      </div>
      <Caption
        name={<Mono>{props.name}</Mono>}
        value={
          <>
            {props.property}{" "}
            <Readout of={() => wrap?.firstElementChild ?? undefined} property={props.property} />
          </>
        }
      />
    </div>
  );
}

const PADDING_USE = {
  sm: "A filter bar, or a small card in a list.",
  md: "The ordinary card, and the default.",
  lg: "A panel that holds a whole form.",
  xl: "The sign-in card, alone on its page.",
} satisfies Record<CardPadding, string>;

/** The four padding steps, each measured. `md` is the default. */
export const Paddings: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui Card — padding"
      intro={
        <>
          Four steps: <Mono>sm</Mono> 16px, <Mono>md</Mono> 20px (the default), <Mono>lg</Mono> 24px
          and <Mono>xl</Mono> 32px. Each caption is the padding the browser painted.
        </>
      }
    >
      <Panels theme={args.cireTheme}>
        <For each={Object.keys(PADDING_USE) as CardPadding[]}>
          {(padding) => (
            <Measured name={`padding="${padding}"`} property="padding-top" padding={padding}>
              <p class="text-ui-sm text-ui-ink">{PADDING_USE[padding]}</p>
            </Measured>
          )}
        </For>
      </Panels>
    </Gallery>
  ),
};

const FILL_USE = {
  wash: "The surface at 30%: the default, so a grid of cards reads as one layer.",
  well: "The sunk surface, for a box holding something already on the page.",
  opaque: "The surface itself, for a card that must let nothing behind it through.",
  none: "No ground, for a card set on something that already has one.",
} satisfies Record<CardFill, string>;

/** The four fills, each measured, on cire's page ground. `wash` is the default. */
export const Fills: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui Card — fill"
      intro={
        <>
          Four fills, each on cire's page ground. The caption is the background colour the browser
          painted; <Mono>none</Mono> paints none. On the guest site and the marketing site the sunk
          surface is the page ground itself, so there a <Mono>well</Mono> card shows its border
          alone: judge that in the app.
        </>
      }
    >
      <Panels theme={args.cireTheme}>
        <For each={Object.keys(FILL_USE) as CardFill[]}>
          {(fill) => (
            <Measured name={`fill="${fill}"`} property="background-color" fill={fill}>
              <p class="text-ui-sm text-ui-ink">{FILL_USE[fill]}</p>
            </Measured>
          )}
        </For>
      </Panels>
    </Gallery>
  ),
};

const TONE_USE = {
  default: "The hairline, for every ordinary card.",
  accent: "The gold rule, for the loudest card on its screen.",
  danger: "The red rule, for the card that holds an action nobody can undo.",
} satisfies Record<CardTone, string>;

/** The three tones. A tone changes the border and nothing else. */
export const Tones: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui Card — tone"
      intro={
        <>
          A tone is the border colour alone; the fill and padding are their own options. The caption
          is the border colour the browser painted.
        </>
      }
    >
      <Panels theme={args.cireTheme}>
        <For each={Object.keys(TONE_USE) as CardTone[]}>
          {(tone) => (
            <Measured name={`tone="${tone}"`} property="border-top-color" tone={tone}>
              <Show when={tone === "danger"} fallback={<CireEyebrow>{tone}</CireEyebrow>}>
                <p class="text-ui-sm text-ui-danger">Delete this wedding</p>
              </Show>
              <p class="text-ui-xs text-ui-ink-secondary">{TONE_USE[tone]}</p>
            </Measured>
          )}
        </For>
      </Panels>
    </Gallery>
  ),
};
