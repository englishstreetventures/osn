import { Card } from "@shared/ui/ui/card";
import { Notice } from "@shared/ui/ui/notice";
import { Skeleton } from "@shared/ui/ui/skeleton";
import { For, Show, type JSX } from "solid-js";

import { PRODUCT_NAME } from "../lib/auth";
import { ResponsiveSkeleton } from "./ResponsiveSkeleton";
import { LOAD_FAILED } from "./ShellFrame";

/**
 * The window screen's box, and the frame `App.tsx` draws in its place while
 * the screen's chunk loads, or for good if that chunk fails.
 *
 * The screen and the frame are built from these same parts, so the frame is
 * the loading screen's own shape: the product name over one card, its heading,
 * a block where the date goes, the line under it and a block for each button.
 * Nothing moves when the screen lands (`DESIGN.md` §Layout).
 *
 * This module is in the entry chunk, beside `ShellFrame.tsx`.
 */

export const WINDOW_HEADING = "Your account is set to be deleted";

/**
 * The line under the date. Keeping is refused from the instant on, which can
 * fall early in the day the date names, so the offer ends as that day starts.
 */
export const BEFORE_THAT_DAY =
  "Before that day, you can keep it. Your profiles and handles come back as they were.";

/** The window screen's column: the product name over one card, centred both ways. */
export function WindowColumn(props: { children: JSX.Element }) {
  return (
    <main class="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-6 py-10">
      <p class="text-foreground text-title text-center font-medium" translate="no">
        {PRODUCT_NAME}
      </p>
      <Card padding="lg" class="flex flex-col gap-6">
        {props.children}
      </Card>
    </main>
  );
}

/**
 * The card's heading: the page's `h1` on the shell's screen, an `h2` on
 * `/authorize`, where the app's name above the card is the `h1`.
 */
export function WindowHeading(props: { level?: 1 | 2; children: JSX.Element }) {
  return (
    <Show
      when={props.level === 2}
      fallback={<h1 class="text-foreground text-title font-medium">{props.children}</h1>}
    >
      <h2 class="text-foreground text-title font-medium">{props.children}</h2>
    </Show>
  );
}

/**
 * The line `/authorize` adds under the keep offer, just above the buttons it
 * explains: which app, that the person is not signed in to it, and that keeping
 * the account carries the sign-in on. The name is the app's own words, so it
 * breaks anywhere rather than widen the card, and a page translator leaves it.
 */
export function AppLine(props: { name: string }) {
  return (
    <p class="text-muted-foreground text-body wrap-anywhere">
      You're not signed in to <span translate="no">{props.name}</span>. Keep your account to carry
      on signing in.
    </p>
  );
}

/**
 * The date's sentence while it loads: the two lines' room the sentence keeps
 * at every width (`DeletionWindow`), since the year's longest day ("We delete
 * it on or shortly after Wednesday, September 30, 2026.") takes two from `md`
 * as well as below it.
 */
export function WindowDateLoading() {
  return <Skeleton standsFor="line" height={9} />;
}

/**
 * The window screen's buttons while its code loads: each as wide as the card,
 * 44px below `md`. Three on the shell's screen; four on `/authorize`, which
 * adds Back to the app.
 */
function ButtonsLoading(props: { count: 3 | 4 }) {
  return (
    <div class="flex flex-col gap-2">
      <For each={Array.from({ length: props.count })}>
        {() => <ResponsiveSkeleton standsFor="control" height={10} phoneHeight={11} />}
      </For>
    </div>
  );
}

/**
 * The window screen's card while its chunk loads: the loading screen's shape,
 * every button a block. If the chunk fails (offline, or a chunk a deploy
 * renamed), the heading stays and the shell's failed-load line takes the rest.
 * The consent page draws it in its own card for the screen it shows an app's
 * sign-in (`AuthorizePage.tsx`), with `app` set to the app's name: the heading
 * an `h2`, the line naming the app, and four blocks, as that screen draws them.
 */
export function WindowLoading(props: { failed: boolean; app?: string }) {
  const level = () => (props.app === undefined ? 1 : 2);
  return (
    <Show
      when={!props.failed}
      fallback={
        <div class="flex flex-col gap-2">
          <WindowHeading level={level()}>{WINDOW_HEADING}</WindowHeading>
          <Notice tone="danger" size="inline" alert>
            {LOAD_FAILED}
          </Notice>
        </div>
      }
    >
      <div aria-busy="true" class="flex flex-col gap-6">
        <div class="flex flex-col gap-2">
          <WindowHeading level={level()}>{WINDOW_HEADING}</WindowHeading>
          <WindowDateLoading />
          <p class="text-muted-foreground text-body">{BEFORE_THAT_DAY}</p>
          <Show when={props.app}>{(name) => <AppLine name={name()} />}</Show>
        </div>
        <ButtonsLoading count={props.app === undefined ? 3 : 4} />
      </div>
    </Show>
  );
}

/** The window screen while its chunk loads, in the screen's own column. */
export function DeletionWindowFrame(props: { failed: boolean }) {
  return (
    <WindowColumn>
      <WindowLoading failed={props.failed} />
    </WindowColumn>
  );
}
