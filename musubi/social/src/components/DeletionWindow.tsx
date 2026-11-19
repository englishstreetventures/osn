import { InlineAction } from "@osn/auth-ui/InlineAction";
import { describeAuthError } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { toast } from "@shared/toast";
import { Button } from "@shared/ui/ui/button";
import { Notice } from "@shared/ui/ui/notice";
import { createSignal, Match, onMount, Show, Switch } from "solid-js";

import { localDay, statusOf } from "../lib/account-deletion";
import { accountClient } from "../lib/authClients";
import { createStepUp } from "../lib/step-up";
import { createAccountData } from "./AccountDataActions";
import {
  BEFORE_THAT_DAY,
  WINDOW_HEADING,
  WindowColumn,
  WindowDateLoading,
  WindowHeading,
} from "./DeletionWindowFrame";

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
 * app comes back as after a keep here, or says the account is back and offers
 * Reload when the renewal does not bring the app. A status read refused at 401
 * signs out; any other failure says what did not load, with Try again.
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
      // ordinary session, which brings the app back. Still here after that,
      // the session did not turn ordinary: the account is back all the same,
      // and a reload brings the app.
      await renewSession();
      setKept(true);
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
    <>
      <WindowColumn>
        <Switch>
          <Match when={closed()}>
            <div class="flex flex-col gap-2">
              <WindowHeading>It's too late to keep this account</WindowHeading>
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
              <WindowHeading>Your account is back</WindowHeading>
              <p class="text-muted-foreground text-body">Reload to carry on.</p>
            </div>
            <Button size="lg" class="w-full max-md:h-11" onClick={() => location.reload()}>
              Reload
            </Button>
          </Match>

          <Match when={true}>
            <div class="flex flex-col gap-2">
              <WindowHeading>{WINDOW_HEADING}</WindowHeading>
              <Switch>
                <Match when={status().state === "loading"}>
                  <div aria-busy="true">
                    <WindowDateLoading />
                  </div>
                </Match>
                <Match when={scheduledFor()}>
                  {(at) => {
                    // The day, not a clock time: the erasure starts at the
                    // instant and can finish hours after it.
                    const day = () => localDay(at());
                    return (
                      // Two lines' room at every width, so a date of one line
                      // leaves the card as tall as its placeholder.
                      <p class="text-foreground text-body min-h-9">
                        We delete it on or shortly after{" "}
                        <time datetime={day().date}>{day().words}</time>.
                      </p>
                    );
                  }}
                </Match>
                <Match when={status().state === "failed"}>
                  <Notice tone="danger" size="inline" alert>
                    Your deletion date didn't load.
                    {loadDetail(status())}{" "}
                    <InlineAction onClick={() => void readStatus()}>Try again</InlineAction>
                  </Notice>
                </Match>
              </Switch>
              {/* "That day" names the date, so it follows only a date on
                  screen. Without one, the window's length stands in: keeping
                  is refused from its end, though the erasure can come later. */}
              <p class="text-muted-foreground text-body">
                {status().state === "failed"
                  ? "You can keep it for 7 days after you asked. Your profiles and handles come back as they were."
                  : BEFORE_THAT_DAY}
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
      </WindowColumn>
      <stepUp.Sheet />
      <data.Sheet />
    </>
  );
}

/** The copy map's sentence after the lead, only when it adds something: a wait, or the connection. */
function loadDetail(status: Status): string {
  if (status.state !== "failed") return "";
  const code = statusOf(status.error);
  return code === 429 || code === 0 ? ` ${describeAuthError(status.error)}` : "";
}
