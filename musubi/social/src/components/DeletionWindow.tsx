import { InlineAction } from "@osn/auth-ui/InlineAction";
import { describeAuthError } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { toast } from "@shared/toast";
import { Button } from "@shared/ui/ui/button";
import { Card } from "@shared/ui/ui/card";
import { Notice } from "@shared/ui/ui/notice";
import { createEffect, createSignal, Match, onMount, Show, Switch, type JSX } from "solid-js";

import { localDay, statusOf } from "../lib/account-deletion";
import { accountClient } from "../lib/authClients";
import { createStepUp } from "../lib/step-up";
import { createAccountData } from "./AccountDataActions";
import { BackError, BackLabel } from "./DeletionWindowBack";
import {
  AppLine,
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

/** The app whose sign-in brought the person to the screen, on Musubi's `/authorize`. */
export interface DeletionWindowApp {
  /** The app's name, as its registration has it. */
  name: string;
  /**
   * Refuses the app's sign-in and leaves the page, sending the app the
   * refusal a Cancel sends. Rejects when it could not; the screen says so.
   */
  back: () => Promise<void>;
}

export interface DeletionWindowProps {
  /** Set on `/authorize`: the screen names the app and offers the way back to it. */
  app?: DeletionWindowApp;
  /**
   * With `app`: the account is kept (here, or from another device) and the
   * session renewed or not; the page carries the sign-in on. Without it, the
   * renewal brings the app back, or the screen offers Reload.
   */
  onKept?: () => void;
  /** With `app`: the session has ended; the page offers sign-in. */
  onSignedOut?: () => void;
}

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
 *
 * With `app`, on `/authorize`, it is a card inside that page: it says the
 * person is not signed in to the app and offers Back to it, on every state
 * that leaves, and hands each ending to the page — kept, or the session gone
 * however it went — instead of waiting for the shell to swap.
 */
export default function DeletionWindow(props: DeletionWindowProps) {
  const auth = useAuth();
  const { logout, renewSession } = auth;
  const data = createAccountData();
  const stepUp = createStepUp();
  const [status, setStatus] = createSignal<Status>({ state: "loading" });
  const [keeping, setKeeping] = createSignal(false);
  const [keepError, setKeepError] = createSignal<string | null>(null);
  /** The restore was refused because the window has closed. */
  const [closed, setClosed] = createSignal(false);
  /** The account is back, but the session did not renew: a reload brings the app. */
  const [kept, setKept] = createSignal(false);
  const [leaving, setLeaving] = createSignal(false);
  /** Why Back did not leave, for `BackError`; null while it has not failed. */
  const [backError, setBackError] = createSignal<unknown>(null);

  // On `/authorize` nothing else watches this session: once it is gone (Sign
  // out, a refused status read, or the runtime ending it) the page takes over.
  let handedBack = false;
  const signedOut = () => {
    if (handedBack || !props.onSignedOut) return;
    handedBack = true;
    props.onSignedOut();
  };
  createEffect(() => {
    if (!props.app) return;
    const session = auth.session;
    if (!session.loading && !session.error && session() === null) signedOut();
  });
  const signOut = async () => {
    await logout();
    signedOut();
  };
  /** The page carries on from a kept account; its session renewed first, when it could be. */
  const carryOn = async (): Promise<boolean> => {
    if (!props.onKept) return false;
    await renewSession().catch(() => undefined);
    props.onKept();
    return true;
  };

  async function back() {
    if (!props.app || leaving()) return;
    setBackError(null);
    setLeaving(true);
    try {
      // Resolves as the page leaves: the screen stays busy until it has gone.
      await props.app.back();
    } catch (err) {
      setBackError(err);
      setLeaving(false);
    }
  }

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
      // and a reload brings the app. On `/authorize` the page carries on.
      if (await carryOn()) return;
      await renewSession();
      setKept(true);
    } catch (err) {
      if (statusOf(err) === 401) {
        void signOut();
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
      if (await carryOn()) return;
      await renewSession().catch(() => setKept(true));
    } catch (err) {
      setKeepError(`Couldn't keep your account. ${describeAuthError(err)}`);
    } finally {
      setKeeping(false);
    }
  }

  const busy = () => keeping() || data.downloading() || leaving();
  /** On `/authorize` the app's name above the card is the page's `h1`. */
  const level = () => (props.app ? 2 : 1);
  const scheduledFor = () => {
    const current = status();
    return current.state === "ready" ? current.scheduledFor : undefined;
  };

  return (
    <>
      <Frame app={props.app}>
        <Switch>
          <Match when={closed()}>
            <div class="flex flex-col gap-2">
              <WindowHeading level={level()}>It's too late to keep this account</WindowHeading>
              <p class="text-muted-foreground text-body">
                The 7 days to keep it have ended, and it is being deleted.
              </p>
            </div>
            <Show when={props.app}>
              {(app) => <BackError name={app().name} error={backError()} />}
            </Show>
            <div class="flex flex-col gap-2">
              <Show when={props.app}>
                {(app) => (
                  <Button
                    size="lg"
                    class="w-full max-md:h-11"
                    busy={leaving()}
                    onClick={() => void back()}
                  >
                    <BackLabel name={app().name} leaving={leaving()} />
                  </Button>
                )}
              </Show>
              <Button
                variant={props.app ? "ghost" : "default"}
                size="lg"
                class="w-full max-md:h-11"
                disabled={leaving()}
                onClick={() => void signOut()}
              >
                Sign out
              </Button>
            </div>
          </Match>

          <Match when={kept()}>
            <div class="flex flex-col gap-2">
              <WindowHeading level={level()}>Your account is back</WindowHeading>
              <p class="text-muted-foreground text-body">Reload to carry on.</p>
            </div>
            <Button size="lg" class="w-full max-md:h-11" onClick={() => location.reload()}>
              Reload
            </Button>
          </Match>

          <Match when={true}>
            <div class="flex flex-col gap-2">
              <WindowHeading level={level()}>{WINDOW_HEADING}</WindowHeading>
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
              {/* "That day" names the date, so it follows the date or its
                  placeholder, never the failed read. There the window's
                  length stands in: keeping is refused from its end, though
                  the erasure can come later. */}
              <p class="text-muted-foreground text-body">
                {status().state === "failed"
                  ? "You can keep it for 7 days after you asked. Your profiles and handles come back as they were."
                  : BEFORE_THAT_DAY}
              </p>
              {/* Last, just above the buttons it explains: Keep carries the
                  sign-in on, Back to the app leaves it. */}
              <Show when={props.app}>{(app) => <AppLine name={app().name} />}</Show>
            </div>

            <Show when={keepError()}>
              {(line) => (
                <Notice tone="danger" size="inline" alert>
                  {line()}
                </Notice>
              )}
            </Show>
            <Show when={props.app}>
              {(app) => <BackError name={app().name} error={backError()} />}
            </Show>

            <div class="flex flex-col gap-2">
              <Button
                size="lg"
                class="w-full max-md:h-11"
                busy={keeping()}
                disabled={!keeping() && (data.downloading() || leaving())}
                onClick={() => void keep()}
              >
                {keeping() ? "Restoring…" : "Keep my account"}
              </Button>
              <Button
                variant="secondary"
                size="lg"
                class="w-full max-md:h-11"
                busy={data.downloading()}
                disabled={!data.downloading() && (keeping() || leaving())}
                onClick={() => void data.download()}
              >
                {data.downloading() ? "Downloading…" : "Download my data"}
              </Button>
              <Show when={props.app}>
                {(app) => (
                  <Button
                    variant="secondary"
                    size="lg"
                    class="w-full max-md:h-11"
                    busy={leaving()}
                    disabled={!leaving() && busy()}
                    onClick={() => void back()}
                  >
                    <BackLabel name={app().name} leaving={leaving()} />
                  </Button>
                )}
              </Show>
              <Button
                variant="ghost"
                size="lg"
                class="w-full max-md:h-11"
                disabled={busy()}
                onClick={() => void signOut()}
              >
                Sign out
              </Button>
            </div>
          </Match>
        </Switch>
      </Frame>
      <stepUp.Sheet />
      <data.Sheet />
    </>
  );
}

/**
 * The screen's own column, product name over one card; or, on `/authorize`,
 * the card alone, inside that page's column under the app's card.
 */
function Frame(props: { app: DeletionWindowApp | undefined; children: JSX.Element }) {
  return (
    <Show when={props.app} fallback={<WindowColumn>{props.children}</WindowColumn>}>
      <Card padding="lg" class="flex flex-col gap-6">
        {props.children}
      </Card>
    </Show>
  );
}

/** The copy map's sentence after the lead, only when it adds something: a wait, or the connection. */
function loadDetail(status: Status): string {
  if (status.state !== "failed") return "";
  const code = statusOf(status.error);
  return code === 429 || code === 0 ? ` ${describeAuthError(status.error)}` : "";
}
