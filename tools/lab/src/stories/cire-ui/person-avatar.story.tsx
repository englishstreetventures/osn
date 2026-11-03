import { avatarTriggerClass } from "@cire/ui/avatar-trigger-class";
import PersonAvatar from "@cire/ui/person-avatar";
import { For, type JSX } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";
import { Caption, Eyebrow, Gallery, Mono, Readout } from "../design-system/chrome.tsx";
import { type CireTheme, cireStyle } from "./cire-mapping.ts";

export const meta = { title: "cire/ui/PersonAvatar", layout: "padded" as const };

type ThemeChoice = CireTheme | "both";

const THEME_OPTIONS = ["both", "dark", "light"] as const;

function themesFor(choice: ThemeChoice): CireTheme[] {
  return choice === "both" ? ["dark", "light"] : [choice];
}

/** The portals' motion clock, which `cireStyle` leaves out: the edge fades on it. */
const PORTAL_MOTION: JSX.CSSProperties = {
  "--dur-fast": "120ms",
  "--ease-out": "cubic-bezier(0.22, 1, 0.36, 1)",
};

/**
 * A drawn portrait in the lab's own `public/fixtures/`, addressed from the
 * lab's origin. The part draws a photo only from an https URL, so it shows
 * when the lab is served over https (`bun run dev:lab`, through portless);
 * over plain http the guard refuses it and the fallback shows instead.
 */
const PORTRAIT = new URL("/fixtures/avatar-portrait.svg", window.location.origin).toString();

/** An https URL on a reserved name, so the request fails at once. */
const DEAD = "https://avatars.cire.invalid/gone.png";

function CirePanel(props: { theme: CireTheme; children: JSX.Element }) {
  return (
    <div
      class="rounded-ui-lg border-ui-hairline bg-ui-ground text-ui-ink flex min-w-0 flex-1 basis-80 flex-col gap-5 border p-5"
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

function Labelled(props: { name: string; children: JSX.Element }) {
  return (
    <div class="flex flex-col items-start gap-2">
      {props.children}
      <span class="text-ui-xs text-ui-ink-secondary">{props.name}</span>
    </div>
  );
}

function story(title: string, intro: JSX.Element, body: () => JSX.Element): Story<ThemeArgs> {
  return {
    args: { cireTheme: "both" },
    controls: themeControl,
    render: (args) => (
      <Gallery title={`cire/ui PersonAvatar — ${title}`} intro={intro}>
        <Panels theme={args.cireTheme}>{body()}</Panels>
      </Gallery>
    ),
  };
}

export const Photo = story(
  "photo",
  <>
    A photo from an https URL, with no <Mono>Referer</Mono>: as a face on a task (28px, 32px) and as
    an account's circle (36px, 40px), which keeps its hairline round the photo. Over plain http the
    lab's own fixture is refused, as any non-https URL is, and the fallback shows.
  </>,
  () => (
    <div class="flex flex-wrap items-end gap-6">
      <Labelled name="blank · 28px">
        <PersonAvatar fallback="blank" url={PORTRAIT} class="size-7" />
      </Labelled>
      <Labelled name="blank · 32px">
        <PersonAvatar fallback="blank" url={PORTRAIT} class="size-8" />
      </Labelled>
      <Labelled name="initial · 36px">
        <PersonAvatar fallback="initial" name="Ada" url={PORTRAIT} class="size-9" />
      </Labelled>
      <Labelled name="initial · 40px">
        <PersonAvatar fallback="initial" name="Ada" url={PORTRAIT} class="size-10" />
      </Labelled>
    </div>
  ),
);

export const FailedBlank = story(
  "failed, blank",
  <>
    A photo that will not load, on a face in a stack or a list: the empty avatar, a figure in the
    page's colour cut from a disc of faint ink. Never initials.
  </>,
  () => (
    <div class="flex flex-wrap items-end gap-6">
      <Labelled name="28px">
        <PersonAvatar fallback="blank" url={DEAD} class="size-7" />
      </Labelled>
      <Labelled name="32px">
        <PersonAvatar fallback="blank" url={DEAD} class="size-8" />
      </Labelled>
    </div>
  ),
);

/** One initial, captioned with its painted size and weight. */
function MeasuredInitial(props: { name: string; size: "size-9" | "size-10"; label: string }) {
  let wrap: HTMLDivElement | undefined;
  const letter = () => wrap?.querySelector("[aria-hidden] span span") ?? undefined;
  return (
    <div
      class="flex flex-col items-start gap-2"
      ref={(el) => {
        wrap = el;
      }}
    >
      <PersonAvatar fallback="initial" name={props.name} url={DEAD} class={props.size} />
      <Caption
        name={<Mono>{props.label}</Mono>}
        value={
          <>
            <Readout of={letter} property="font-size" /> ·{" "}
            <Readout of={letter} property="font-weight" />
          </>
        }
      />
    </div>
  );
}

export const FailedInitial = story(
  "failed, initial",
  <>
    A photo that will not load, on an account's circle: the name's first letter in readable gold,
    semibold, at half the circle's inside width, inside a hairline with no fill of its own. cire's
    Cormorant is not loaded here, so judge the face in the app.
  </>,
  () => (
    <div class="flex flex-wrap items-end gap-6">
      <MeasuredInitial name="Ada" size="size-9" label="36px · trigger" />
      <MeasuredInitial name="Wren" size="size-10" label="40px · guest card" />
      <MeasuredInitial name="jo" size="size-9" label="36px · 'jo'" />
      <MeasuredInitial name="Quinn" size="size-10" label="40px · 'Quinn'" />
    </div>
  ),
);

export const Ring = story(
  "ring",
  <>
    Three faces overlapping by 8px, each with a 2px band in the page's colour outside its circle,
    then a count, as a task's holders draw them. The band is outside, so each photo keeps its 28px.
  </>,
  () => (
    <div class="flex items-center">
      <span class="relative">
        <PersonAvatar fallback="blank" ring url={PORTRAIT} class="size-7" />
      </span>
      <span class="relative -ml-2">
        <PersonAvatar fallback="blank" ring url={DEAD} class="size-7" />
      </span>
      <span class="relative -ml-2">
        <PersonAvatar fallback="blank" ring url={PORTRAIT} class="size-7" />
      </span>
      <span class="border-ui-hairline-strong bg-ui-surface-raised text-ui-ink text-ui-xs ring-ui-ground relative -ml-2 flex h-7 min-w-7 items-center justify-center rounded-full border px-1.5 ring-2">
        +2
      </span>
    </div>
  ),
);

export const Trigger = story(
  "account trigger",
  <>
    <Mono>avatarTriggerClass</Mono> around an <Mono>initial</Mono> avatar, at the end of a mock top
    bar. Point at it: the circle's edge turns to the soft gold. Tab to it: the house ring, at once.
  </>,
  () => (
    <div class="border-ui-hairline flex h-14 items-center gap-2 border-b px-4">
      <span class="text-ui-xs tracking-ui-widest text-ui-ink-secondary uppercase">
        All weddings
      </span>
      <div class="ml-auto flex items-center gap-2">
        <button type="button" aria-label="Account menu" class={avatarTriggerClass}>
          <PersonAvatar fallback="initial" name="Ada" url={DEAD} class="size-full" />
        </button>
        <button type="button" aria-label="Account menu, with a photo" class={avatarTriggerClass}>
          <PersonAvatar fallback="initial" name="Ada" url={PORTRAIT} class="size-full" />
        </button>
      </div>
    </div>
  ),
);
