import { describeAuthError } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { Button } from "@shared/ui/ui/button";
import { Notice } from "@shared/ui/ui/notice";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";

import { osnAuth } from "../lib/auth";
import { PageCacheScope } from "../lib/page-cache";
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
  const { session, profiles, profilesError, refetchProfiles } = useAuth();
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
    <>
      {/* Here because the shell mounts this once, on every route but the bare
          ones, and keeps it across navigation and the breakpoint switch: the
          page cache follows the session with no page reading it, and is
          cleared when the shell goes. In the shell's lazy chunk rather than
          the entry. */}
      <PageCacheScope />
      <Show when={signedOut() || listFailed() !== undefined}>
        <div class="mx-auto flex w-full max-w-2xl flex-col gap-3 px-4 pt-6 md:px-8 md:pt-8">
          <Show when={signedOut()}>
            <Notice tone="info" size="sm" alert>
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span>You've been signed out.</span>
                {/* Opens once the dialogs' chunk is in, fetching it again if
                  it failed: a click never opens a dialog later, unasked. */}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    void dialogs.load().then(
                      () => dialogs.open("sign-in"),
                      () => {},
                    )
                  }
                >
                  Sign in
                </Button>
              </div>
            </Notice>
          </Show>
          <Show when={listFailed() !== undefined}>
            <Notice tone="danger" size="inline" alert>
              {["Your profiles didn't load.", failureDetail(listFailed())]
                .filter(Boolean)
                .join(" ")}{" "}
              {/* Gone while a retry is out, so clicks never stack up requests
                against the rate limit the line may be naming. */}
              <Show when={!profiles.loading}>
                <button
                  type="button"
                  class="focus-visible:ring-ui-focus cursor-pointer font-medium underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-hidden"
                  onClick={() => void refetchProfiles()}
                >
                  Try again
                </button>
              </Show>
            </Notice>
          </Show>
        </div>
      </Show>
    </>
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
