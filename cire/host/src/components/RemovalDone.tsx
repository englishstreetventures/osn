import { buttonClass } from "@cire/ui/button";
import Eyebrow from "@cire/ui/eyebrow";
import {
  signInCardClass,
  signInFrameClass,
  signInHeaderClass,
  signInTitleClass,
} from "@cire/ui/sign-in-card-class";
import { onMount } from "solid-js";

import { OSN_ACCOUNT_URL } from "../lib/osn";

/**
 * After a person removes their Cire data: they are signed out of Cire, so the
 * page drops the dashboard and its chrome and stands as the sign-in page
 * does, in its frame, header and card from `@cire/ui`, with the product's
 * name over a heading (DESIGN.md §7, Leaving Cire). Focus goes to the
 * heading, so a screen reader hears where it is, and a keyboard sees the
 * house ring.
 *
 * Its own module: `OrganiserApp` draws it only after a removal, and the
 * removal screen itself is a chunk of its own.
 */
export default function RemovalDone() {
  let heading: HTMLHeadingElement | undefined;
  onMount(() => heading?.focus());
  return (
    <main class={signInFrameClass} data-removal-done>
      <header class={signInHeaderClass}>
        <Eyebrow>Cire · Host portal</Eyebrow>
        <h1 ref={heading} tabIndex={-1} class={`${signInTitleClass} leading-ui-tight`}>
          Your Cire data is removed
        </h1>
      </header>
      <div class={`${signInCardClass} gap-5`}>
        <div class="flex flex-col gap-2">
          <p class="font-body text-text text-ui-sm leading-ui-normal">
            You're signed out of Cire. Your Musubi account stays as it was.
          </p>
          <p class="font-body text-text-muted text-ui-sm leading-ui-normal">
            You can sign in to Cire again whenever you like, and start fresh with no weddings.
          </p>
        </div>
        <div class="flex flex-wrap gap-3">
          <a href="/login/" class={buttonClass({ variant: "outline" })}>
            Sign in again
          </a>
          {/* The same tab, unlike the portal's other pills that leave it: the
              person is signed out, and this page has nothing left to keep
              open (DESIGN.md §7, Leaving Cire). */}
          <a href={OSN_ACCOUNT_URL} class={buttonClass({ variant: "outline" })}>
            Go to Musubi
          </a>
        </div>
      </div>
    </main>
  );
}
