import { describeAuthError } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { Button } from "@shared/ui/ui/button";
import { Notice } from "@shared/ui/ui/notice";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";

import { osnAuth } from "../lib/auth";
import { useShellDialogs } from "./ShellDialogs";

/**
 * What the shell says about the session itself, above every page.
 *
 * **Signed out.** When the runtime ends the session — a refused renewal, or
 * another tab signing out or into another account — the page says so and
 * offers Sign in, rather than dropping to signed-out views with no word. One
 * notice however many requests failed: the runtime reports an end once, and
 * this holds one flag. A cold load with no session and a log out from this
 * tab say nothing; neither is an end the runtime reports. A new session
 * clears it.
 *
 * **Profiles failed.** The account's profile list did not load. The shell
 * keeps the last list it had; this says the list is stale, and offers to list
 * again.
 */
export function ShellNotices() {
  const { session, profilesError, refetchProfiles } = useAuth();
  const dialogs = useShellDialogs();
  const [signedOut, setSignedOut] = createSignal(false);

  onCleanup(
    osnAuth.onSessionChange((change) => {
      if (change.kind === "ended") setSignedOut(true);
    }),
  );
  createEffect(() => {
    if (session()) setSignedOut(false);
  });

  const listFailed = () => (session() && !signedOut() ? profilesError() : undefined);

  return (
    <Show when={signedOut() || listFailed() !== undefined}>
      <div class="mx-auto flex w-full max-w-2xl flex-col gap-3 px-4 pt-6 md:px-8 md:pt-8">
        <Show when={signedOut()}>
          <Notice tone="info" size="sm" alert>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span>You've been signed out.</span>
              <Button variant="secondary" size="sm" onClick={() => dialogs.open("sign-in")}>
                Sign in
              </Button>
            </div>
          </Notice>
        </Show>
        <Show when={listFailed() !== undefined}>
          <Notice tone="danger" size="inline" alert>
            {["Your profiles didn't load.", failureDetail(listFailed())].filter(Boolean).join(" ")}{" "}
            <button
              type="button"
              class="cursor-pointer font-medium underline underline-offset-4"
              onClick={() => void refetchProfiles()}
            >
              Try again
            </button>
          </Notice>
        </Show>
      </div>
    </Show>
  );
}

/**
 * The copy map's sentence, only when it says more than "didn't load" beside
 * a Try again: a `429` says to wait, status `0` to check the connection.
 */
function failureDetail(err: unknown): string | undefined {
  let status: unknown;
  try {
    status =
      typeof err === "object" && err !== null ? (err as { status?: unknown }).status : undefined;
  } catch {
    // A throwing getter is not a status.
    return undefined;
  }
  return status === 429 || status === 0 ? describeAuthError(err) : undefined;
}
