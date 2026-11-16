import { describeAuthError } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { toast } from "@shared/toast";
import { Button } from "@shared/ui/ui/button";
import { Card } from "@shared/ui/ui/card";
import { Notice } from "@shared/ui/ui/notice";
import { createSignal, Match, onMount, Show, Switch } from "solid-js";

import { formatMoment, statusOf } from "../lib/account-deletion";
import { PRODUCT_NAME } from "../lib/auth";
import { accountClient } from "../lib/authClients";
import { createStepUp } from "../lib/step-up";
import { createAccountData } from "./AccountDataActions";
import { ResponsiveSkeleton } from "./ResponsiveSkeleton";

type Status =
  | { state: "loading" }
  | { state: "ready"; scheduledFor: number }
  | { state: "failed"; error: unknown };

/**
 * The one screen a session pending deletion sees, in place of the shell, its
 * notices and banners and the page: when the account is deleted, Keep my
 * account, Download my data, and Sign out. It sends only what a pending
 * session may: the deletion's status, the data download and the restore.
 *
 * Kept: the session renews to an ordinary token and the app comes back, with
 * a toast. Too late (`cancelled: false`, and the status still pending): it
 * says so and offers Sign out alone; kept from another device meanwhile, the
 * app comes back as after a keep here. A status read refused at 401 signs out; any other failure says what
 * did not load, with Try again.
 */
export default function DeletionWindow() {
  const { logout, renewSession } = useAuth();
  const data = createAccountData();
  const stepUp = createStepUp();
  const [status, setStatus] = createSignal<Status>({ state: "loading" });
  const [keeping, setKeeping] = createSignal(false);
  const [keepError, setKeepError] = createSignal<string | null>(null);
  /** The restore was refused because the window has closed. */
  const [closed, setClosed] = createSignal(false);
  /** The account is back, but the session did not renew: a reload brings the app. */
  const [kept, setKept] = createSignal(false);

  async function readStatus() {
    setStatus({ state: "loading" });
    try {
      const answer = await accountClient.getAccountDeletionStatus();
      if (answer.scheduled) {
        setStatus({ state: "ready", scheduledFor: answer.scheduledFor });
        return;
      }
      // Nothing pending any more (kept from another device): renew to an
      // ordinary session, which brings the app back.
      await renewSession();
      setStatus({ state: "failed", error: undefined });
    } catch (err) {
      if (statusOf(err) === 401) {
        void logout();
        return;
      }
      setStatus({ state: "failed", error: err });
    }
  }
  onMount(() => void readStatus());

  async function keep() {
    if (keeping() || stepUp.open()) return;
    setKeepError(null);
    const token = await stepUp.ask({
      purpose: "account_restore",
      reason: "To keep your account, confirm it's you.",
    });
    if (token === null) return;
    setKeeping(true);
    try {
      const { cancelled } = await accountClient.cancelAccountDeletion({ stepUpToken: token });
      // `cancelled: false` is also the answer when another device kept the
      // account first: a fresh read tells the two apart.
      if (!cancelled && (await accountClient.getAccountDeletionStatus()).scheduled) {
        setClosed(true);
        return;
      }
      toast.success("Your account is back");
      await renewSession().catch(() => setKept(true));
    } catch (err) {
      setKeepError(`Couldn't keep your account. ${describeAuthError(err)}`);
    } finally {
      setKeeping(false);
    }
  }

  const busy = () => keeping() || data.downloading();
  const scheduledFor = () => {
    const current = status();
    return current.state === "ready" ? current.scheduledFor : undefined;
  };

  return (
    <main class="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-6 py-10">
      <p class="text-foreground text-title text-center font-medium" translate="no">
        {PRODUCT_NAME}
      </p>
      <Card padding="lg" class="flex flex-col gap-6">
        <Switch>
          <Match when={closed()}>
            <div class="flex flex-col gap-2">
              <h1 class="text-foreground text-title font-medium">
                It's too late to keep this account
              </h1>
              <p class="text-muted-foreground text-body">
                The 7 days to keep it have ended, and it is being deleted.
              </p>
            </div>
            <Button size="lg" class="w-full max-md:h-11" onClick={() => void logout()}>
              Sign out
            </Button>
          </Match>

          <Match when={kept()}>
            <div class="flex flex-col gap-2">
              <h1 class="text-foreground text-title font-medium">Your account is back</h1>
              <p class="text-muted-foreground text-body">Reload to carry on.</p>
            </div>
            <Button size="lg" class="w-full max-md:h-11" onClick={() => location.reload()}>
              Reload
            </Button>
          </Match>

          <Match when={true}>
            <div class="flex flex-col gap-2">
              <h1 class="text-foreground text-title font-medium">
                Your account is set to be deleted
              </h1>
              <Switch>
                <Match when={status().state === "loading"}>
                  {/* The date's sentence: one line from `md`, two below it. */}
                  <div aria-busy="true">
                    <ResponsiveSkeleton standsFor="line" height={4.5} phoneHeight={9} />
                  </div>
                </Match>
                <Match when={scheduledFor()}>
                  {(at) => (
                    <p class="text-foreground text-body">
                      We delete it on{" "}
                      <time datetime={new Date(at() * 1_000).toISOString()}>
                        {formatMoment(at())}
                      </time>
                      .
                    </p>
                  )}
                </Match>
                <Match when={status().state === "failed"}>
                  <Notice tone="danger" size="inline" alert>
                    Your deletion date didn't load.
                    {loadDetail(status())}{" "}
                    <button
                      type="button"
                      class="focus-visible:ring-ui-focus cursor-pointer font-medium underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-hidden"
                      onClick={() => void readStatus()}
                    >
                      Try again
                    </button>
                  </Notice>
                </Match>
              </Switch>
              <p class="text-muted-foreground text-body">
                Until then, you can keep it. Your profiles and handles come back as they were.
              </p>
            </div>

            <Show when={keepError()}>
              {(line) => (
                <Notice tone="danger" size="inline" alert>
                  {line()}
                </Notice>
              )}
            </Show>

            <div class="flex flex-col gap-2">
              <Button
                size="lg"
                class="w-full max-md:h-11"
                busy={keeping()}
                disabled={!keeping() && data.downloading()}
                onClick={() => void keep()}
              >
                {keeping() ? "Restoring…" : "Keep my account"}
              </Button>
              <Button
                variant="secondary"
                size="lg"
                class="w-full max-md:h-11"
                busy={data.downloading()}
                disabled={!data.downloading() && keeping()}
                onClick={() => void data.download()}
              >
                {data.downloading() ? "Downloading…" : "Download my data"}
              </Button>
              <Button
                variant="ghost"
                size="lg"
                class="w-full max-md:h-11"
                disabled={busy()}
                onClick={() => void logout()}
              >
                Sign out
              </Button>
            </div>
          </Match>
        </Switch>
      </Card>
      <stepUp.Sheet />
      <data.Sheet />
    </main>
  );
}

/** The copy map's sentence after the lead, only when it adds something: a wait, or the connection. */
function loadDetail(status: Status): string {
  if (status.state !== "failed") return "";
  const code = statusOf(status.error);
  return code === 429 || code === 0 ? ` ${describeAuthError(status.error)}` : "";
}
