import { Card } from "@shared/ui/ui/card";
import { Notice } from "@shared/ui/ui/notice";
import { Skeleton } from "@shared/ui/ui/skeleton";
import { Show, type JSX } from "solid-js";

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

/** The line under the date. */
export const UNTIL_THEN =
  "Until then, you can keep it. Your profiles and handles come back as they were.";

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

export function WindowHeading(props: { children: JSX.Element }) {
  return <h1 class="text-foreground text-title font-medium">{props.children}</h1>;
}

/**
 * The date's sentence while it loads: the two lines' room the sentence keeps
 * at every width (`DeletionWindow`), since the year's longest date ("Wednesday,
 * September 30, 2026 at 12:00 PM") takes two from `md` as well as below it.
 */
export function WindowDateLoading() {
  return <Skeleton standsFor="line" height={9} />;
}

/** The window screen's buttons while its code loads: each as wide as the card, 44px below `md`. */
function ButtonsLoading() {
  return (
    <div class="flex flex-col gap-2">
      <ResponsiveSkeleton standsFor="control" height={10} phoneHeight={11} />
      <ResponsiveSkeleton standsFor="control" height={10} phoneHeight={11} />
      <ResponsiveSkeleton standsFor="control" height={10} phoneHeight={11} />
    </div>
  );
}

/**
 * The window screen while its chunk loads: the loading screen's shape, every
 * button a block. If the chunk fails (offline, or a chunk a deploy renamed),
 * the heading stays and the shell's failed-load line takes the rest.
 */
export function DeletionWindowFrame(props: { failed: boolean }) {
  return (
    <WindowColumn>
      <Show
        when={!props.failed}
        fallback={
          <div class="flex flex-col gap-2">
            <WindowHeading>{WINDOW_HEADING}</WindowHeading>
            <Notice tone="danger" size="inline" alert>
              {LOAD_FAILED}
            </Notice>
          </div>
        }
      >
        <div aria-busy="true" class="flex flex-col gap-6">
          <div class="flex flex-col gap-2">
            <WindowHeading>{WINDOW_HEADING}</WindowHeading>
            <WindowDateLoading />
            <p class="text-muted-foreground text-body">{UNTIL_THEN}</p>
          </div>
          <ButtonsLoading />
        </div>
      </Show>
    </WindowColumn>
  );
}
