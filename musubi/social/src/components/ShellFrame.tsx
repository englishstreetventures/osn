import { Show, type JSX } from "solid-js";

import { PRODUCT_NAME } from "../lib/auth";

/**
 * The boxes the two shells are built in, and the frames `App.tsx` draws in
 * their place while a shell's chunk loads.
 *
 * The shells are split out of the entry chunk, so on a cold load the page can
 * paint before its shell arrives. A frame of the same box holds the shell's
 * place, so the page never moves when the shell lands. The shells and the
 * frames are built from these same parts, so the two cannot drift apart.
 *
 * This module is in the entry chunk: it imports nothing a shell's chunk would
 * otherwise carry alone.
 */

const LOAD_FAILED = `${PRODUCT_NAME} could not finish loading. Reload and try again.`;

/**
 * The theme toggle's square: 28px in the rail, 40px in the phone top bar,
 * where every control meets the touch floor. `ThemeToggle` draws it, and the
 * rail's frame leaves the same square empty.
 */
export const TOGGLE_BOX = {
  rail: "h-7 w-7",
  bar: "h-10 w-10",
} satisfies Readonly<Record<"rail" | "bar", string>>;

/** The desktop rail's box: 240px, the viewport's height, a hairline on its right. */
export function RailAside(props: { children?: JSX.Element }) {
  return (
    <aside class="border-border hidden h-dvh w-60 shrink-0 flex-col border-r md:flex">
      {props.children}
    </aside>
  );
}

/**
 * The rail's top row: the wordmark, and the theme toggle. The frame leaves the
 * toggle's square empty, so the row is the same height either way.
 */
export function RailHead(props: { toggle?: JSX.Element }) {
  return (
    <div class="flex items-center justify-between px-4 pt-6 pb-1">
      <div class="flex items-baseline gap-1.5">
        <span class="text-foreground text-title font-medium">{PRODUCT_NAME}</span>
        <span class="text-subtle text-meta tracking-ui-wide uppercase">Social</span>
      </div>
      {props.toggle ?? <div class={TOGGLE_BOX.rail} aria-hidden="true" />}
    </div>
  );
}

/** The rail's place while its chunk loads, and what stays if the load fails. */
export function RailFrame(props: { failed: boolean }) {
  return (
    <RailAside>
      <RailHead />
      <Show when={props.failed}>
        <p role="alert" class="text-destructive text-meta px-4 pt-5">
          {LOAD_FAILED}
        </p>
      </Show>
    </RailAside>
  );
}

/**
 * The phone shell's top bar, above the scroll column: the wordmark on the
 * left, `end` on the right, in a 48px row (`--topbar-h`) clear of the notch.
 *
 * The product name alone, without the rail's small-caps "Social" tag: at
 * 320px the signed-out bar has no room for the tag beside "Sign in" and
 * "Create account".
 */
export function TopBarHeader(props: { end?: JSX.Element }) {
  return (
    <header class="border-border bg-background pt-safe px-safe border-b md:hidden">
      <div class="flex h-(--topbar-h) items-center justify-between px-4">
        <span class="text-foreground text-title font-medium">{PRODUCT_NAME}</span>
        {props.end}
      </div>
    </header>
  );
}

/** The top bar's place while the phone shell's chunk loads, and what stays if the load fails. */
export function TopBarFrame(props: { failed: boolean }) {
  return (
    <TopBarHeader
      end={
        <Show when={props.failed}>
          <p role="alert" class="text-destructive text-meta ml-4 min-w-0 text-right">
            {LOAD_FAILED}
          </p>
        </Show>
      }
    />
  );
}
