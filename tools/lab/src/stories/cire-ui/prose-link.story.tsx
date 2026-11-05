import { type ProseLinkTone, proseLinkClass } from "@cire/ui/button";
import { Notice } from "@shared/ui/ui/notice";
import { For, type JSX } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";
import { Caption, Eyebrow, Gallery, Mono, Readout, Rule } from "../design-system/chrome.tsx";
import { type CireTheme, cireStyle } from "./cire-mapping.ts";

export const meta = { title: "cire/ui/Prose link", layout: "padded" as const };

/**
 * `proseLinkClass`: the classes for a link set inside a sentence. Underlined
 * at rest at a 2px offset, inline so it wraps with the words around it, and
 * the sentence's own type size and weight. Each story shows both of cire's
 * ramps.
 */

type ThemeChoice = CireTheme | "both";

const THEME_OPTIONS = ["both", "dark", "light"] as const;

const TONES = ["accent", "muted"] as const satisfies readonly ProseLinkTone[];

const TONE_USE = {
  accent: "Readable gold: a link the sentence is about — the privacy notice, a listing to edit.",
  muted: "Secondary ink that brightens on hover: a way round to another screen, a shop page.",
} satisfies Record<ProseLinkTone, string>;

function themesFor(choice: ThemeChoice): CireTheme[] {
  return choice === "both" ? ["dark", "light"] : [choice];
}

/** A wrapper that carries cire's whole `--ui-*` mapping for one theme. */
function CirePanel(props: { theme: CireTheme; children: JSX.Element }) {
  return (
    <div
      class="rounded-ui-lg border-ui-hairline bg-ui-ground text-ui-ink flex min-w-0 flex-1 basis-80 flex-col gap-5 border p-5"
      style={cireStyle(props.theme)}
      data-theme-panel={props.theme}
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

/** One tone in a sentence, captioned with what the browser painted. */
function Measured(props: { tone: ProseLinkTone }) {
  let link: HTMLAnchorElement | undefined;
  return (
    <div class="flex flex-col gap-2">
      <p class="text-ui-base text-ui-ink leading-ui-normal">
        Dietary needs go to the caterer for this wedding. See our{" "}
        <a
          href="#privacy"
          class={proseLinkClass({ tone: props.tone })}
          ref={(node) => {
            link = node;
          }}
        >
          privacy notice
        </a>
        .
      </p>
      <Caption
        name={<Mono>tone="{props.tone}"</Mono>}
        value={
          <>
            colour <Readout of={() => link} property="color" /> · underline{" "}
            <Readout of={() => link} property="text-decoration-line" /> at{" "}
            <Readout of={() => link} property="text-underline-offset" />
          </>
        }
      />
      <p class="text-ui-xs leading-ui-snug text-ui-ink-secondary">{TONE_USE[props.tone]}</p>
    </div>
  );
}

/** Each tone inside a sentence. `accent` is the default. */
export const Tones: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui proseLinkClass — tone"
      intro={
        <>
          A link inside a sentence, underlined at rest so colour is not the only thing marking it.
          Two inks; no type size or weight of its own. The colours are the host portal's ramps; the
          guest site paints <Mono>accent</Mono> in the couple's readable gold, so judge that in the
          app. cire's fonts are not loaded here.
        </>
      }
    >
      <Panels theme={args.cireTheme}>
        <For each={TONES}>{(tone) => <Measured tone={tone} />}</For>
      </Panels>
      <Rule>
        Hover the muted link: it brightens to the body ink. The accent link does not change.
      </Rule>
    </Gallery>
  ),
};

/** Each tone in a paragraph narrow enough that the link has to wrap. */
export const Wrapping: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui proseLinkClass — wrapping"
      intro={
        <>
          A 10rem paragraph. The link breaks across lines with the sentence and the underline
          follows each line. A <Mono>buttonClass</Mono> link would hold its words on one line and
          push out of the column.
        </>
      }
    >
      <Panels theme={args.cireTheme}>
        <For each={TONES}>
          {(tone) => (
            <div class="flex flex-col gap-1.5">
              <Mono muted>{tone}</Mono>
              <p class="text-ui-sm text-ui-ink leading-ui-normal w-40">
                Your guest won't see this invitation, so please share{" "}
                <a href="#privacy" class={proseLinkClass({ tone })}>
                  the privacy notice that explains what we keep
                </a>{" "}
                with them.
              </p>
            </div>
          )}
        </For>
      </Panels>
    </Gallery>
  ),
};

/** The accent tone inside a tinted notice: readable gold whatever the box. */
export const InANotice: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui proseLinkClass — inside a notice"
      intro={
        <>
          A link inside a <Mono>Notice</Mono> keeps the readable gold rather than the notice's own
          ink (englishstreetventures/osn#1838): the vendor portal's warning about a listing that
          already exists, and the gift list's signed-out note.
        </>
      }
    >
      <Panels theme={args.cireTheme}>
        <Notice tone="warn">
          Bloom &amp; Co already has a directory listing, and an organisation can have only one.
          Pick another organisation, or{" "}
          <a href="#listing" class={proseLinkClass()}>
            edit Bloom &amp; Co's listing
          </a>
          .
        </Notice>
        <Notice size="sm" tone="accent" fill="none">
          Your invite session has ended. Enter your invite code again on{" "}
          <a href="#invite" class={proseLinkClass()}>
            the invitation
          </a>{" "}
          to reserve a gift.
        </Notice>
      </Panels>
    </Gallery>
  ),
};

/** Tab through to see the focus ring, which follows each line of a wrapped link. */
export const Focus: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui proseLinkClass — focus"
      intro={
        <>
          Press Tab. The ring is 2px of <Mono>--ui-focus</Mono>, 2px out, and arrives at once: the
          link's transition names its colours only.
        </>
      }
    >
      <Panels theme={args.cireTheme}>
        <For each={TONES}>
          {(tone) => (
            <p class="text-ui-sm text-ui-ink leading-ui-normal w-48">
              Read{" "}
              <a href="#privacy" class={proseLinkClass({ tone })}>
                cireweddings.com/privacy/guests
              </a>{" "}
              before you send.
            </p>
          )}
        </For>
      </Panels>
    </Gallery>
  ),
};
