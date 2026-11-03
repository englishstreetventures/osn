import Wordmark, { WordmarkPlaceholder } from "@cire/ui/wordmark";
import { createSignal, For, type JSX, onMount } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";
import { Caption, Eyebrow, Gallery, Mono, Readout, Rule } from "../design-system/chrome.tsx";
import { type CireTheme, cireStyle } from "./cire-mapping.ts";

export const meta = { title: "cire/ui/Wordmark", layout: "padded" as const };

type ThemeChoice = CireTheme | "both";

const THEME_OPTIONS = ["both", "dark", "light"] as const;

function themesFor(choice: ThemeChoice): CireTheme[] {
  return choice === "both" ? ["dark", "light"] : [choice];
}

/**
 * The portals' motion clock, which `cireStyle` leaves out: the wash fades on
 * `--dur-fast` and `--ease-out` (`cire/host/src/styles/global.css`).
 */
const PORTAL_MOTION: JSX.CSSProperties = {
  "--dur-fast": "120ms",
  "--ease-out": "cubic-bezier(0.22, 1, 0.36, 1)",
};

/** A wrapper that carries cire's whole `--ui-*` mapping for one theme. */
function CirePanel(props: { theme: CireTheme; children: JSX.Element }) {
  return (
    <div
      class="rounded-ui-lg border-ui-hairline bg-ui-ground text-ui-ink flex min-w-0 flex-1 basis-96 flex-col gap-5 border p-5"
      style={{ ...cireStyle(props.theme), ...PORTAL_MOTION }}
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
 * The host top bar's left end, as `TopBar.tsx` lays it out: a hairline-bottomed
 * row, `gap-2`, the mark, a 1px divider, the section's label. The 16px padding
 * stands in for the page frame's gutter.
 */
function Bar(props: { mark: JSX.Element; class?: string; ref?: (el: HTMLDivElement) => void }) {
  return (
    <div
      ref={props.ref}
      class={`border-ui-hairline flex h-14 items-center gap-2 border-b px-4 ${props.class ?? ""}`}
    >
      {props.mark}
      <span data-divider aria-hidden="true" class="bg-ui-hairline h-5 w-px shrink-0" />
      <span class="text-ui-xs tracking-ui-widest text-ui-ink-secondary truncate uppercase">
        All weddings
      </span>
    </div>
  );
}

/** The mark at rest in its bar, with the star's painted ink. */
function AtRestBar() {
  let row: HTMLDivElement | undefined;
  const star = () => row?.querySelector("button > span") ?? undefined;
  return (
    <div class="flex flex-col gap-2">
      <Bar
        ref={(el) => {
          row = el;
        }}
        mark={<Wordmark label="Cire — all weddings" onClick={() => {}} />}
      />
      <Caption
        name={<Mono>Wordmark</Mono>}
        value={
          <>
            star <Readout of={star} property="color" /> · corner{" "}
            <Readout
              of={() => row?.querySelector("button") ?? undefined}
              property="border-top-left-radius"
            />
          </>
        }
      />
    </div>
  );
}

export const AtRest: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui Wordmark — at rest"
      intro={
        <>
          The top bar's way home in both portals: a readable-gold ✦ and "Cire" in the display face,
          named by its <Mono>label</Mono> alone. The colours are the host portal's ramps; cire's
          Cormorant is not loaded here, so the word draws in the platform serif. Judge the face in
          the app.
        </>
      }
    >
      <Panels theme={args.cireTheme}>
        <AtRestBar />
      </Panels>
    </Gallery>
  ),
};

/** The mark live: point at it for the wash, Tab to it for the ring and its gap. */
function LiveBar() {
  let row: HTMLDivElement | undefined;
  const [gap, setGap] = createSignal("Tab to the mark to measure its ring");
  const measure = (event: FocusEvent) => {
    const button = event.target as HTMLElement;
    if (!button.matches(":focus-visible")) return;
    const style = getComputedStyle(button);
    const reach = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
    const divider = row?.querySelector("[data-divider]");
    if (!divider) return;
    const clear =
      divider.getBoundingClientRect().left - (button.getBoundingClientRect().right + reach);
    setGap(
      `ring ${style.outlineWidth} at ${style.outlineOffset} · ${clear.toFixed(1)}px clear of the divider`,
    );
  };
  return (
    <div class="flex flex-col gap-2">
      <Bar
        ref={(el) => {
          row = el;
        }}
        mark={
          <span class="contents" onFocusIn={measure}>
            <Wordmark label="Cire — all weddings" onClick={() => {}} />
          </span>
        }
      />
      <Caption
        name={<Mono>hover · focus</Mono>}
        value={
          <>
            {gap()} · fades{" "}
            <Readout
              of={() => row?.querySelector("button") ?? undefined}
              property="transition-property"
            />
          </>
        }
      />
    </div>
  );
}

export const States: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui Wordmark — hover and focus"
      intro={
        <>
          Point at the mark to see the wash, the surface at 60% on the 6px corner; the star keeps
          its ink. Tab to it to see the house ring, 2px at a 2px offset, which lands at once: only
          the wash fades. The box pulls 4px left and none right, so the ring clears the divider by
          4px. A static story holds neither state; <Mono>wordmark.browser.test.tsx</Mono> reads
          both.
        </>
      }
    >
      <Panels theme={args.cireTheme}>
        <LiveBar />
      </Panels>
      <Rule>The ring never touches the divider, in either ramp.</Rule>
    </Gallery>
  ),
};

/** The boot bar's still copy over the real bar, with both left edges. */
function Overlay() {
  let real: HTMLDivElement | undefined;
  let boot: HTMLDivElement | undefined;
  const [edges, setEdges] = createSignal("unmeasured");
  onMount(() => requestAnimationFrame(() => read()));
  const read = () => {
    const a = real?.querySelector("button")?.getBoundingClientRect().left;
    const b = boot?.querySelector("span[aria-hidden]")?.getBoundingClientRect().left;
    if (a === undefined || b === undefined) return;
    setEdges(
      `island ${a.toFixed(1)}px · boot ${b.toFixed(1)}px · ${Math.abs(a - b) < 0.5 ? "the same" : "they differ"}`,
    );
  };
  return (
    <div class="flex flex-col gap-2">
      <div class="relative">
        <Bar
          ref={(el) => {
            real = el;
          }}
          mark={<Wordmark label="Cire — all weddings" onClick={() => {}} />}
        />
        <div
          aria-hidden="true"
          class="[&_span]:text-ui-danger pointer-events-none absolute inset-0 opacity-70"
          ref={(el) => {
            boot = el;
          }}
        >
          <div class="flex h-14 items-center gap-2 px-4">
            <WordmarkPlaceholder />
          </div>
        </div>
      </div>
      <Caption name={<Mono>WordmarkPlaceholder over Wordmark</Mono>} value={edges()} />
    </div>
  );
}

export const Placeholder: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui Wordmark — the boot bar's copy"
      intro={
        <>
          <Mono>WordmarkPlaceholder</Mono> is what each portal's <Mono>index.astro</Mono> paints in
          the static bar before the island mounts: the same box and glyphs, with no role, no tab
          stop and no hover. Here it is laid over the real mark in red. Where the two agree the red
          covers the mark; any offset shows as a double.
        </>
      }
    >
      <Panels theme={args.cireTheme}>
        <Overlay />
      </Panels>
      <Rule>The two left edges match, so the swap moves nothing.</Rule>
    </Gallery>
  ),
};
