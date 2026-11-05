import { cardClass } from "@cire/ui/card";
import CireEyebrow, { type EyebrowTone } from "@cire/ui/eyebrow";
import { For, type JSX } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";
import { Caption, Eyebrow, Gallery, Mono, Readout, Rule } from "../design-system/chrome.tsx";
import { type CireTheme, cireStyle } from "./cire-mapping.ts";

export const meta = { title: "cire/ui/Eyebrow", layout: "padded" as const };

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

const TONE_USE = {
  accent: "Readable gold: a section's or a card's lead.",
  muted: "Neutral grey: a label over a figure, a group of fields.",
} satisfies Record<EyebrowTone, string>;

/** One eyebrow over the line it leads, captioned with what the browser painted. */
function Measured(props: { tone: EyebrowTone }) {
  let wrap: HTMLDivElement | undefined;
  return (
    <div class="flex flex-col gap-2">
      <div
        class={cardClass()}
        ref={(node) => {
          wrap = node;
        }}
      >
        <CireEyebrow tone={props.tone}>Spent so far</CireEyebrow>
        <p class="text-ui-md text-ui-ink">$18,400 of $30,000</p>
      </div>
      <Caption
        name={<Mono>tone="{props.tone}"</Mono>}
        value={
          <>
            letter-spacing{" "}
            <Readout of={() => wrap?.firstElementChild ?? undefined} property="letter-spacing" /> ·
            colour <Readout of={() => wrap?.firstElementChild ?? undefined} property="color" />
          </>
        }
      />
      <p class="text-ui-xs leading-ui-snug text-ui-ink-secondary">{TONE_USE[props.tone]}</p>
    </div>
  );
}

/** The two tones, in a card and over a section heading. `accent` is the default. */
export const Tones: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui Eyebrow — tone"
      intro={
        <>
          One size, the <Mono>widest</Mono> letter-spacing (0.16em) and two inks. The colours are
          the host portal's ramps; the guest site paints <Mono>accent</Mono> in the couple's own
          readable gold and the marketing site in its gold, so judge those in the app. cire's fonts
          are not loaded here.
        </>
      }
    >
      <Panels theme={args.cireTheme}>
        <For each={Object.keys(TONE_USE) as EyebrowTone[]}>
          {(tone) => <Measured tone={tone} />}
        </For>
        <div class="flex flex-col gap-1">
          <CireEyebrow>Guests</CireEyebrow>
          <h2 class="text-ui-lg text-ui-ink">Who is coming</h2>
        </div>
      </Panels>
    </Gallery>
  ),
};

/** Each element `as` renders, in the parent it belongs in. */
export const Elements: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui Eyebrow — elements"
      intro={
        <>
          The same label as each element a cire screen writes it as. A heading when the label names
          its section, a <Mono>legend</Mono> for a group of fields, a <Mono>dt</Mono> in a list of
          terms. Every one should look the same.
        </>
      }
    >
      <Panels theme={args.cireTheme}>
        <CireEyebrow>as p (the default)</CireEyebrow>
        <div>
          <CireEyebrow as="span">as span</CireEyebrow>
        </div>
        <CireEyebrow as="h2">as h2</CireEyebrow>
        <CireEyebrow as="h3">as h3</CireEyebrow>
        <fieldset class="flex flex-col gap-1">
          <CireEyebrow as="legend" tone="muted">
            as legend, muted
          </CireEyebrow>
          <label class="text-ui-sm text-ui-ink flex items-center gap-2">
            <input type="checkbox" /> Count guests at the reception
          </label>
        </fieldset>
        <dl class="flex flex-col gap-1">
          <CireEyebrow as="dt">as dt</CireEyebrow>
          <dd class="text-ui-sm text-ui-ink">Forty-two</dd>
        </dl>
      </Panels>
      <Rule>
        Every label is 0.16em apart, at the extra-small step, in the same ink for its tone.
      </Rule>
    </Gallery>
  ),
};
