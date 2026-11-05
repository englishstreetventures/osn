import { eyebrowClass } from "@cire/ui/eyebrow";
import { signInCardClass } from "@cire/ui/sign-in-card-class";
import SignInPanel, { type SignInAuth } from "@cire/ui/sign-in-panel";
import { For, type JSX } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";
import { Eyebrow, Gallery, Mono } from "../design-system/chrome.tsx";
import { type CireTheme, cireStyle } from "./cire-mapping.ts";

export const meta = { title: "cire/ui/SignInPanel", layout: "padded" as const };

type ThemeChoice = CireTheme | "both";

const THEME_OPTIONS = ["both", "dark", "light"] as const;

function themesFor(choice: ThemeChoice): CireTheme[] {
  return choice === "both" ? ["dark", "light"] : [choice];
}

/**
 * The portals' lit top edge, `--inner-lip` (`cire/host/src/styles/global.css`),
 * which `cireStyle` leaves out: the card reads it for its lip.
 */
const INNER_LIP = {
  dark: "inset 0 1px 0 oklch(100% 0 0 / 0.045)",
  light: "inset 0 1px 0 oklch(100% 0 0 / 0.6)",
} as const satisfies Record<CireTheme, string>;

/**
 * A stand-in for `@shared/rp-auth` that never leaves the page: a press does
 * nothing, so "Connecting to musubi…" stays up; there is no session to resume;
 * the marker is the story's.
 */
function stubAuth(marker: string | null): SignInAuth {
  return {
    startSignIn: () => {},
    resumeSession: () => Promise.resolve(false),
    readAuthError: () => marker,
    clearAuthError: () => {},
  };
}

/** The sign-in page's body, as `sign-in-card.astro` draws it, at its 30rem measure. */
function SignInPage(props: { theme: CireTheme; marker: string | null }) {
  return (
    <div
      class="rounded-ui-lg border-ui-hairline bg-ui-ground text-ui-ink @container flex min-w-0 flex-1 basis-96 flex-col gap-5 border p-5"
      style={{ ...cireStyle(props.theme), "--inner-lip": INNER_LIP[props.theme] }}
    >
      <Eyebrow>cire · {props.theme}</Eyebrow>
      <div class="mx-auto flex w-full max-w-120 flex-col py-6">
        <header class="mb-8 flex flex-col gap-1.5 text-center">
          <p class={eyebrowClass()}>Cire · Host portal</p>
          <h1 class="font-ui-display text-ui-ink leading-ui-none text-[clamp(1.9rem,5cqi,2.6rem)] font-light">
            Sign in
          </h1>
        </header>
        <div class={signInCardClass}>
          <SignInPanel apiBase="https://api.cire.example" auth={stubAuth(props.marker)} />
        </div>
      </div>
    </div>
  );
}

function Panels(props: { theme: ThemeChoice; marker: string | null }) {
  return (
    <div class="flex flex-wrap items-start gap-6">
      <For each={themesFor(props.theme)}>
        {(theme) => <SignInPage theme={theme} marker={props.marker} />}
      </For>
    </div>
  );
}

interface ThemeArgs extends StoryArgs {
  cireTheme: ThemeChoice;
}

const themeControl = { cireTheme: { kind: "select" as const, options: THEME_OPTIONS } };

const FONTS: JSX.Element = (
  <>
    The colours are the host portal's ramps; cire's faces are not loaded here, so judge the type in
    the app.
  </>
);

function state(title: string, intro: JSX.Element, marker: string | null): Story<ThemeArgs> {
  return {
    args: { cireTheme: "both" },
    controls: themeControl,
    render: (args) => (
      <Gallery
        title={`cire/ui SignInPanel — ${title}`}
        intro={
          <>
            {intro} {FONTS}
          </>
        }
      >
        <Panels theme={args.cireTheme} marker={marker} />
      </Gallery>
    ),
  };
}

export const Idle = state(
  "idle",
  <>
    Both portals' sign-in: the opaque card at the largest padding with its lit top edge, the copy at
    the small step and one large pill, under the portal's label and a roman heading.
  </>,
  null,
);

export const Connecting = state(
  "connecting",
  <>
    Press <Mono>Continue with musubi</Mono>: the label turns to "Connecting to musubi…" at full
    strength, and a second press does nothing. This story's sign-in never leaves the page, so the
    label stays; in the app a Back from musubi, or ten seconds with the browser still here, puts it
    back.
  </>,
  null,
);

export const Declined = state(
  "declined",
  <>
    Back from musubi with <Mono>?auth_error=sign_in_declined</Mono>: the danger notice, read out as
    an alert, above the same button.
  </>,
  "sign_in_declined",
);

export const Failed = state(
  "failed",
  <>
    <Mono>sign_in_failed</Mono>: the exchange did not complete.
  </>,
  "sign_in_failed",
);

export const Unavailable = state(
  "unavailable",
  <>
    <Mono>sign_in_unavailable</Mono>: the tier has no sign-in configured, on either portal.
  </>,
  "sign_in_unavailable",
);

export const UnknownMarker = state(
  "unknown marker",
  <>
    A marker the panel does not know (<Mono>something_new</Mono>) gets the failed line, never the
    raw marker.
  </>,
  "something_new",
);
