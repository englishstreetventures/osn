import Card, { CardCta, CardEyebrow, cardClass } from "@cire/ui/card";
import { For, type JSX } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";
import { Eyebrow, Gallery, Mono, Rule, Section } from "../design-system/chrome.tsx";
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
          One border, one padding and the <Mono>lg</Mono> corner, which cire maps to 16px. The
          interactive card is a <Mono>&lt;button&gt;</Mono> wearing <Mono>cardClass</Mono>; hover it
          to see the border and fill answer. cire's fonts are not loaded here, so the type is the
          lab's: judge the face in the app.
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
            <CardEyebrow>Next step</CardEyebrow>
            <p class="text-ui-sm text-ui-ink">Send your invitations</p>
            <p class="text-ui-xs text-ui-ink-secondary">Guests get a link by email.</p>
          </Card>
          <Card tone="accent">
            <CardEyebrow>Needs you</CardEyebrow>
            <p class="text-ui-sm text-ui-ink">Three enquiries are waiting</p>
          </Card>
        </Section>
        <Section title="Interactive">
          <button type="button" class={cardClass({ interactive: true })}>
            <CardEyebrow>Guests</CardEyebrow>
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
