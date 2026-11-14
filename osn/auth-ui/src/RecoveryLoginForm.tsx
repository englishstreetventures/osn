import {
  describeAuthError,
  type EmailRecoveryRequest,
  type RecoveryClient,
  type RecoveryProfile,
  type RegistrationClient,
  type Session,
} from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { Button } from "@shared/ui/ui/button";
import { Field, type FieldControlProps } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { labelVariants } from "@shared/ui/ui/label";
import { Notice } from "@shared/ui/ui/notice";
import { OtpInput } from "@shared/ui/ui/otp-input";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { createSignal, createUniqueId, onCleanup, onMount, Show, type JSX } from "solid-js";

import { CheckEmailView, type CheckEmailStatus } from "./CheckEmailView";
import { describedBy, fieldError, plainError, type FieldError } from "./error-lines";
import { createLinkPoll, type LinkPollStep } from "./link-poll";
import { describePasskeyError } from "./passkey-errors";
import { storedWait, writeStoredWait, type Waiting } from "./pending-recovery";
import type { RunPasskeyRegistration } from "./StepUpDialog";
import { TurnstileWidget, turnstileEnabled } from "./TurnstileWidget";
import { StepLink, stepAction, ViewStep } from "./ViewParts";

/**
 * Every way back into an account that is not a passkey.
 *
 * Mounted from the "Lost your passkey?" link on `<SignIn>`. Three factors, and
 * the first is unlike the other two:
 *
 * 1. **A recovery code** mints an ordinary session. The user is signed in and
 *    can do anything; this component adopts the session and hands off.
 * 2. **An emailed link** and **3. an authenticator-app code** each mint a
 *    *restricted* recovery session, whose one permitted action is enrolling a
 *    passkey. So those two paths end in an enrolment screen, not a signed-in
 *    app — see `wiki/osn/account-recovery-factors.md` §B.
 *
 * The emailed link
 * ----------------
 * This tab begins, shows `CheckEmailView` with the request's number, and
 * polls with the claim secret; the person opens the link on any device and
 * types the number there. The restricted session comes to this tab, never to
 * the device that opened the link. The wait is kept in this tab's
 * `sessionStorage` (the request, its claim secret, the address — never the
 * number), so a reload or a discarded tab resumes it; the number comes back
 * from the first poll. See `wiki/osn/email-links.md`.
 *
 * Why the restricted paths never adopt their session
 * --------------------------------------------------
 * Adopting early unmounts this component: `@musubi/social` hides its auth
 * dialogs the moment `session()` is truthy, which is the trap
 * `wiki/osn/passkey-primary.md` records against registration.
 *
 * Adopting *late* is no better, and this is where the resemblance to
 * `<Register>` stops. `<Register>` holds an `osn-access` token; these paths
 * hold `osn-recovery`, and `POST /passkey/register/complete` returns no new
 * token set — it lifts the restriction on the session row, but cannot rewrite
 * a token already in the browser. Publishing it would announce a signed-in
 * user whose token every ordinary route rejects.
 *
 * So a successful factor recovery ends by handing the user back to sign-in
 * with a passkey they now hold. That costs one ceremony and buys something:
 * the new credential is proven to work while the user is still in a position
 * to recover again if it does not.
 *
 * Keeping the held session alive
 * ------------------------------
 * Holding the session also means holding it outside `authFetch`, so nothing
 * refreshes it silently. The access token would die at the ordinary
 * `accessTokenTtl` while the row behind it stayed usable for the rest of its
 * fifteen minutes, and the user would be sent back to the start with two
 * thirds of the window unspent. This screen therefore redeems the refresh
 * cookie itself, through `refreshHeldSession` — a grant that returns a fresh
 * token set without adopting it. Rotation carries the row's absolute deadline
 * forward rather than extending it, so refreshing can renew the token but can
 * never buy more time than the session was granted.
 */

interface RecoveryLoginFormBaseProps {
  client: RecoveryClient;
  /**
   * Needed by the two restricted paths, which end in passkey enrolment.
   * Without it — or without `runPasskeyRegistration` — neither is offered,
   * because neither could be finished.
   */
  registrationClient?: RegistrationClient;
  /**
   * Executes the browser-side WebAuthn attestation. Kept caller-side, as
   * everywhere else in this package, so the host picks the WebAuthn wrapper
   * and the enrolment ceremony stays out of this package's import graph.
   */
  runPasskeyRegistration?: RunPasskeyRegistration;
  /**
   * Cloudflare Turnstile sitekey. When provided, the email path renders the
   * challenge and rides the token on `/login/recovery/email/begin`.
   */
  turnstileSiteKey?: string;
  /**
   * The product the recovery email is about, named on the emailed link's
   * waiting screen where it says to look in the junk or spam folder.
   */
  productName?: string;
  onSuccess?: () => void;
  /**
   * Back to sign-in: "Back to sign in" on the chooser, shown only when this
   * is given, and "Sign in with your new passkey" once a passkey is added.
   */
  onCancel?: () => void;
}

/**
 * What the form is mounted in. `SignIn` passes its own.
 *
 * - `"dialog"`: each step's action sits in a `DialogFooter`, Cancel first.
 *   `onDismiss` is that Cancel, which leaves the dialog; it is held while a
 *   call this form started runs, and not while a Resend runs.
 * - `"page"`: each step's action spans the column under it, its ways back
 *   centred under that, with no Cancel.
 */
export type RecoveryLoginFormProps = RecoveryLoginFormBaseProps &
  ({ host: "dialog"; onDismiss: () => void } | { host: "page" });

/**
 * Seconds before Resend unlocks. A request lives ten minutes and sends at most
 * three links, each counted against the account's links a day from this
 * address; two minutes covers ordinary mail delay, and spaces a request's
 * three links over at least four minutes.
 */
const RESEND_WAIT_SECONDS = 120;

const LIMIT_LINE =
  "We've sent all the links we can for this request. Use the newest one, or go back and start again.";
const RESEND_FAILED_LINE = "We couldn't send a new link just now. Try again in a moment.";

export { hasPendingRecovery } from "./pending-recovery";

type View =
  | "choose"
  | "code"
  | "email-identify"
  | "email-verify"
  | "totp"
  | "enrol"
  | "enrolled"
  | "expired";

/** A restricted session, held rather than published. */
interface HeldRecovery {
  session: Session;
  profile: RecoveryProfile;
}

/**
 * How long before the held token expires the screen goes and gets another one.
 *
 * Precondition: the issuer's `accessTokenTtl` must exceed this, or the very
 * first token already sits inside the lead and no refresh is ever scheduled.
 * The default is 300 s against 30 s here. Enrolment survives a violation
 * anyway — `enrolPasskey` refreshes on demand — but the background loop would
 * not run.
 */
const REFRESH_LEAD_MS = 30_000;

/**
 * Floor on the halving retry after a refused grant. `@osn/client` reports a
 * dead cookie and a cold isolate as the same failure, so a refusal inside the
 * lead is worth retrying; below this gap there is no time left to spend and the
 * honest answer is the expiry screen.
 */
const MIN_RETRY_GAP_MS = 2_000;

export function RecoveryLoginForm(props: RecoveryLoginFormProps) {
  const { adoptSession, refreshHeldSession } = useAuth();

  // Feature-detected on mount, matching `SignIn`, so a test can toggle the
  // underlying mock between renders.
  const [webauthnSupported, setWebauthnSupported] = createSignal(false);

  const [view, setView] = createSignal<View>("choose");
  const [identifier, setIdentifier] = createSignal("");
  const [email, setEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  // One line, drawn by whichever step is on screen: above that step's action,
  // or under the code boxes on the authenticator-code step.
  const [error, setError] = createSignal<FieldError | null>(null);
  const errorId = createUniqueId();
  const totpCodeLabelId = createUniqueId();
  const [held, setHeld] = createSignal<HeldRecovery | null>(null);
  const [turnstileToken, setTurnstileToken] = createSignal<string | null>(null);
  const turnstileOn = () => turnstileEnabled(props.turnstileSiteKey);
  let resetTurnstile: (() => void) | undefined;

  // The emailed link's request, and what the waiting view says about it. The
  // number is memory only — never stored, logged or put in a URL.
  const [waiting, setWaiting] = createSignal<Waiting | null>(null);
  const [pairingCode, setPairingCode] = createSignal<string | undefined>(undefined);
  const [linkStatus, setLinkStatus] = createSignal<CheckEmailStatus>("waiting");
  const [linkError, setLinkError] = createSignal<string | undefined>(undefined);
  const linkPoll = createLinkPoll(pollRecovery);

  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Identifies the recovery attempt a pending grant belongs to.
   *
   * Clearing the timer is not enough to stop the refresh loop. A grant already
   * on the wire keeps running, and its continuation arms the next timer — so an
   * unmount, a "Start again" or a finished enrolment would each leave a loop
   * rotating the session on a screen that no longer exists. Once the user has
   * signed in with the new passkey that is an ordinary session, which the
   * issuer never refuses, so the loop would have no stop condition at all.
   *
   * Every continuation compares this before it writes any state or arms
   * anything. Bumped on all five transitions out of a held session.
   */
  let epoch = 0;

  /**
   * Serialises the requests that touch the session, and nothing else.
   *
   * A grant rotates the session server-side: it deletes the old row and inserts
   * a new one. An enrolment request in flight across that swap resolves to
   * neither row and is refused — 409 on `/complete`, or the step-up bypass
   * silently dropped on `/begin`. So grants and enrolment legs take turns.
   *
   * The WebAuthn ceremony deliberately sits OUTSIDE this. A prompt lasts as
   * long as the user does, and holding the lock across it would guarantee the
   * expired token is the one `/complete` sends — the exact failure this file
   * exists to remove. A rotation landing mid-prompt is harmless: the server
   * resolves the caller from the cookie first, and the cookie moves with the
   * rotation.
   */
  let inFlight: Promise<unknown> = Promise.resolve();
  function serialise<T>(op: () => Promise<T>): Promise<T> {
    const next = inFlight.then(op, op);
    inFlight = next.catch(() => {});
    return next;
  }

  /**
   * Set once the form unmounts. The epoch stops a continuation that captured
   * it; this stops one that would start a new loop after the screen has gone,
   * such as a recovery answer that lands once the person has left the dialog.
   * No timer is armed after it is set.
   */
  let disposed = false;

  onCleanup(() => {
    disposed = true;
    epoch += 1;
    clearTimeout(expiryTimer);
  });

  /**
   * A restricted session can do exactly one thing, and that one thing is a
   * WebAuthn ceremony. On a browser that cannot run one it can do nothing at
   * all — so offering either path there would mint a credential the user
   * cannot use and strand them. The recovery-code path is unaffected: it
   * mints an ordinary session.
   *
   * The same rule covers the pieces this component needs to finish the job.
   * A path is offered only when everything it requires is present.
   */
  const restrictedFactorsAvailable = () =>
    webauthnSupported() &&
    props.registrationClient !== undefined &&
    props.runPasskeyRegistration !== undefined;

  onMount(() => {
    setWebauthnSupported(browserSupportsWebAuthn());
    // A wait this tab began before a reload resumes on the waiting view and
    // polls at once: its number is not kept, and the link may have been
    // confirmed while the tab was gone. Where the session could not be used,
    // there is nothing to wait for.
    const resumed = storedWait();
    if (!resumed) return;
    if (!restrictedFactorsAvailable()) {
      writeStoredWait(null);
      return;
    }
    setEmail(resumed.email);
    setWaiting(resumed);
    setView("email-verify");
    linkPoll.now();
  });

  /** The screen the session is finished on. Also a state transition, so it bumps. */
  function expire() {
    epoch += 1;
    clearTimeout(expiryTimer);
    setHeld(null);
    setError(null);
    setView("expired");
  }

  /**
   * Arms the end of the session.
   *
   * The issuer caps a restricted session's access token at the life its own row
   * has left, so once a token arrives with less than the lead on it, that token
   * IS the deadline and no further grant can move it. Waiting it out is
   * therefore the honest end of the window, and it needs no copy of the
   * server's fifteen minutes on this side.
   */
  function armExpiry(session: Session) {
    clearTimeout(expiryTimer);
    if (disposed) return;
    expiryTimer = setTimeout(expire, Math.max(0, session.expiresAt - Date.now()));
  }

  /**
   * Arms the next grant, or the expiry screen when another grant cannot help.
   *
   * A held session is outside `authFetch`, so nothing refreshes it silently and
   * the token would otherwise die at `accessTokenTtl` — five minutes — while
   * the row behind it stays usable for fifteen.
   */
  function scheduleRefresh(session: Session) {
    clearTimeout(expiryTimer);
    if (disposed) return;
    const untilExpiry = session.expiresAt - Date.now();
    if (untilExpiry <= REFRESH_LEAD_MS) {
      armExpiry(session);
      return;
    }
    const mine = epoch;
    expiryTimer = setTimeout(() => void refreshHeld(mine), untilExpiry - REFRESH_LEAD_MS);
  }

  /**
   * A refused grant usually means the row reached its absolute deadline, but
   * `@osn/client` reports a transient 5xx the same way — and it gives up after
   * about 0.6 s of retries. Ending the session on one cold isolate would cost
   * the user the ten minutes this change exists to give back, so spend what is
   * left of the lead on halving retries first. Each halving consumes real time,
   * so the floor terminates it.
   */
  function scheduleRetry(session: Session) {
    clearTimeout(expiryTimer);
    if (disposed) return;
    const gap = (session.expiresAt - Date.now()) / 2;
    if (gap < MIN_RETRY_GAP_MS) {
      armExpiry(session);
      return;
    }
    const mine = epoch;
    expiryTimer = setTimeout(() => void refreshHeld(mine), gap);
  }

  /** Redeems the refresh cookie for a fresh token, keeping the session held. */
  async function refreshHeld(mine: number) {
    const current = held();
    if (mine !== epoch || !current) return;
    try {
      const { session } = await serialise(refreshHeldSession);
      if (mine !== epoch) return;
      setHeld({ ...current, session });
      scheduleRefresh(session);
    } catch {
      if (mine !== epoch) return;
      scheduleRetry(current.session);
    }
  }

  function beginRestricted(result: HeldRecovery) {
    if (disposed) return;
    epoch += 1;
    setHeld(result);
    scheduleRefresh(result.session);
    setCode("");
    setError(null);
    setView("enrol");
  }

  /** Waits on `request`, in this tab and in its storage; its number in memory only. */
  function waitOn(request: Waiting, number: string) {
    setPairingCode(number);
    setWaiting(request);
    setLinkStatus("waiting");
    setLinkError(undefined);
    setView("email-verify");
    writeStoredWait(request);
    linkPoll.start();
  }

  /** Stops waiting on the current request, here and in storage. */
  function leaveWait() {
    linkPoll.stop();
    setWaiting(null);
    setPairingCode(undefined);
    writeStoredWait(null);
  }

  /**
   * One poll of the request this tab waits on. The restricted session's
   * cookie is in this browser once the poll completes, whatever the person did
   * meanwhile, so a completing answer is never dropped; any other answer about
   * a request this tab no longer waits on is stale.
   */
  async function pollRecovery(): Promise<LinkPollStep> {
    const request = waiting();
    if (!request) return "stop";
    const answer = await props.client.emailRecoveryStatus({
      requestId: request.requestId,
      claimSecret: request.claimSecret,
    });
    if (answer.status === "complete") {
      leaveWait();
      beginRestricted({ session: answer.session, profile: answer.profile });
      return "stop";
    }
    if (waiting() !== request) return "wait";
    if (answer.status === "pending") {
      if (answer.pairingCode !== undefined) setPairingCode(answer.pairingCode);
      return "wait";
    }
    writeStoredWait(null);
    setLinkError(undefined);
    setLinkStatus("expired");
    return "stop";
  }

  /** Back to the address, kept, where Turnstile can run again before a new request. */
  function backToIdentify() {
    leaveWait();
    setError(null);
    setView("email-identify");
  }

  /**
   * Resend in the waiting view. A live request gets another link of its own,
   * so a link already on its way still works; an expired one goes back to the
   * address. A rejection is how the view learns that no new link went.
   */
  async function resendLink() {
    const request = waiting();
    if (!request) return;
    if (linkStatus() === "expired") {
      backToIdentify();
      return;
    }
    setLinkStatus("waiting");
    setLinkError(undefined);
    let answer: { status: "sent" | "limit" | "expired" };
    try {
      answer = await props.client.emailRecoveryResend({
        requestId: request.requestId,
        claimSecret: request.claimSecret,
      });
    } catch (err) {
      setLinkError(RESEND_FAILED_LINE);
      setLinkStatus("error");
      throw err;
    }
    if (answer.status === "sent") {
      linkPoll.start();
      return;
    }
    if (answer.status === "limit") {
      setLinkError(LIMIT_LINE);
      setLinkStatus("error");
      throw new Error(LIMIT_LINE);
    }
    linkPoll.stop();
    writeStoredWait(null);
    setLinkStatus("expired");
    throw new Error("The link expired");
  }

  function restart() {
    leaveWait();
    epoch += 1;
    clearTimeout(expiryTimer);
    setHeld(null);
    setCode("");
    setError(null);
    setView("choose");
  }

  async function submitRecoveryCode(e: Event) {
    e.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await props.client.loginWithRecoveryCode({
        identifier: identifier().trim(),
        code: code().trim(),
      });
      await adoptSession(result.session);
      props.onSuccess?.();
    } catch (err) {
      // The server answers a wrong identifier and a wrong code alike, so the
      // sentence names both and blames neither; a 429 says to wait.
      setError(fieldError(describeAuthError(err, "recovery"), err));
    } finally {
      setBusy(false);
    }
  }

  async function sendEmailLink(e: Event) {
    e.preventDefault();
    if (busy() || !email().trim()) return;
    if (turnstileOn() && !turnstileToken()) {
      setError(plainError("Please complete the verification challenge below."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const address = email().trim();
      let begun: EmailRecoveryRequest;
      try {
        begun = await props.client.emailRecoveryBegin({
          identifier: address,
          turnstileToken: turnstileToken() ?? undefined,
        });
      } finally {
        // The server checks the token before it answers, so the call has
        // spent it whether it was accepted or refused, and Cloudflare only
        // refreshes a token when it expires — so a second send (a typo, a
        // new link) would replay a spent token and be refused.
        if (turnstileOn()) resetTurnstile?.();
      }
      waitOn(
        {
          requestId: begun.requestId,
          claimSecret: begun.claimSecret,
          expiresAt: begun.expiresAt,
          email: address,
        },
        begun.pairingCode,
      );
    } catch (err) {
      setError(fieldError(describeAuthError(err, "details"), err));
    } finally {
      setBusy(false);
    }
  }

  async function verifyTotpCode() {
    if (busy() || code().length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      beginRestricted(
        await props.client.totpRecoveryComplete({
          identifier: identifier().trim(),
          code: code(),
        }),
      );
    } catch (err) {
      // Email or @handle plus a code, refused alike whichever was wrong.
      setError(fieldError(describeAuthError(err, "recovery"), err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * The token to send on the next leg, refreshed first when it is close enough
   * to expiry to die mid-request.
   *
   * The WebAuthn challenge outlives the refresh lead several times over, so a
   * ceremony begun just before a scheduled grant can easily end after the token
   * it started with is dead. Asking for a fresh one at each leg is what makes a
   * slow prompt safe, and it is why the ceremony itself needs no lock.
   *
   * Returns null when the grant is refused: the row has reached its absolute
   * deadline, and the caller shows the timed-out screen rather than an error.
   */
  async function freshToken(): Promise<string | null> {
    const current = held();
    if (!current) return null;
    if (current.session.expiresAt - Date.now() > REFRESH_LEAD_MS) {
      return current.session.accessToken;
    }
    const mine = epoch;
    try {
      const { session } = await serialise(refreshHeldSession);
      if (mine !== epoch) return null;
      setHeld({ ...current, session });
      scheduleRefresh(session);
      return session.accessToken;
    } catch {
      return null;
    }
  }

  async function enrolPasskey() {
    const recovery = held();
    const client = props.registrationClient;
    const run = props.runPasskeyRegistration;
    if (!recovery || !client || !run || busy()) return;
    setBusy(true);
    setError(null);
    try {
      const beginToken = await freshToken();
      if (beginToken === null) {
        expire();
        return;
      }
      // No step-up token: a recovery-audience caller is admitted past that
      // gate on the factor its session recorded. Losing the device does not
      // delete its passkey row, so the gate would otherwise block the common
      // recovery case outright.
      const options = await serialise(() =>
        client.passkeyRegisterBegin({
          profileId: recovery.profile.id,
          accessToken: beginToken,
        }),
      );
      const attestation = await run(options);
      // Re-read rather than reuse `beginToken`: the ceremony may have outlived
      // it, and a grant may have replaced the held session while it ran.
      const completeToken = await freshToken();
      if (completeToken === null) {
        expire();
        return;
      }
      await serialise(() =>
        client.passkeyRegisterComplete({
          profileId: recovery.profile.id,
          accessToken: completeToken,
          attestation,
        }),
      );
      epoch += 1;
      clearTimeout(expiryTimer);
      setHeld(null);
      setView("enrolled");
    } catch (err) {
      setError(plainError(describePasskeyError(err, "registration")));
    } finally {
      setBusy(false);
    }
  }

  /** This step's error line, wherever the step draws it. */
  const errorLine = () => (
    <Show when={error()}>
      {(line) => (
        <Notice tone="danger" size="inline" alert id={errorId}>
          {line().text}
        </Notice>
      )}
    </Show>
  );
  /**
   * For a field the line is about: its id, the field's own description, then
   * the line, and a mark on a refused input.
   */
  const tie = (field: FieldControlProps) => ({
    id: field.id,
    "aria-describedby": describedBy(field["aria-describedby"], error() && errorId),
    "aria-invalid": error()?.invalid || undefined,
  });
  /**
   * For a row of code boxes: named by the span above it, described by the
   * line, and marked invalid (`error`) only on a refused input.
   */
  const codeRow = (labelId: string) => ({
    "aria-labelledby": labelId,
    "aria-describedby": describedBy(error() && errorId),
    status: error()?.invalid
      ? ("error" as const)
      : busy()
        ? ("verifying" as const)
        : ("idle" as const),
  });

  // The dialog's way out, first in each step's footer. On the emailed link's
  // wait it ends the wait on this side first, as Back does, so the request and
  // its claim secret leave this tab's storage with the dialog.
  const dismiss = () => {
    if (props.host !== "dialog") return undefined;
    const onDismiss = props.onDismiss;
    return () => {
      if (view() === "email-verify") leaveWait();
      onDismiss();
    };
  };
  /** One step: Cancel in a dialog, the step's own action, its ways back. */
  const step = (parts: { action?: JSX.Element; links?: JSX.Element; children: JSX.Element }) => (
    <ViewStep
      host={props.host}
      onCancel={dismiss()}
      cancelDisabled={busy()}
      action={parts.action}
      links={parts.links}
    >
      {parts.children}
    </ViewStep>
  );
  /** A way back inside the form, held while a call it started runs. */
  const backLink = (label: string, onClick: () => void) => (
    <StepLink host={props.host} onClick={onClick} disabled={busy()}>
      {label}
    </StepLink>
  );
  // The chooser's other factors take the step-up sheet's factor buttons:
  // Button's own size, 40px tall below `md` in a sheet.
  const factorClass = () => (props.host === "dialog" ? "max-md:h-10" : undefined);
  const line = "text-ui-sm leading-ui-snug text-ui-ink-secondary";

  return (
    <div class="flex flex-col">
      <Show when={view() === "choose"}>
        {step({
          // A recovery code needs nothing but the code, so it is the step's
          // one action; the factors that end in a new passkey sit above it.
          action: (
            <Button {...stepAction(props.host)} onClick={() => setView("code")}>
              Use a recovery code
            </Button>
          ),
          links: <Show when={props.onCancel}>{(back) => backLink("Back to sign in", back())}</Show>,
          children: (
            <>
              <p class={line}>Pick how you'd like to prove this account is yours.</p>
              <Show when={restrictedFactorsAvailable()}>
                <div class="flex flex-col gap-2">
                  <Button
                    variant="outline"
                    class={factorClass()}
                    onClick={() => setView("email-identify")}
                  >
                    Email me a link
                  </Button>
                  <Button variant="outline" class={factorClass()} onClick={() => setView("totp")}>
                    Use your authenticator app
                  </Button>
                </div>
              </Show>
              {/* Where a WebAuthn ceremony cannot run, the two restricted factors
                  are useless and the honest answer is the list of things that do
                  work. Same copy as the unsupported-browser screen on sign-in. */}
              <Show when={!restrictedFactorsAvailable()}>
                <div class="flex flex-col gap-2">
                  {/* A blocker that stops these two ways here: an info notice. */}
                  <Notice tone="info" size="sm">
                    The other ways back in need a passkey ceremony, which this browser can't run.
                  </Notice>
                  <p class={line}>You can:</p>
                  <ul class={`${line} list-inside list-disc`}>
                    <li>
                      Sign in on a device that supports passkeys (iOS 16+, Android 9+, recent
                      desktop browsers).
                    </li>
                    <li>
                      Use your phone via the QR / Bluetooth cross-device flow your password manager
                      offers.
                    </li>
                    <li>Plug in a FIDO2 security key and reload the page.</li>
                  </ul>
                </div>
              </Show>
            </>
          ),
        })}
      </Show>

      {/* A step with a form wraps all of it, footer included, so Enter in a
          field submits. */}
      <Show when={view() === "code"}>
        <form onSubmit={submitRecoveryCode} class="flex flex-col">
          {step({
            action: (
              <Button
                type="submit"
                {...stepAction(props.host)}
                busy={busy()}
                disabled={!busy() && (!identifier() || !code())}
              >
                {busy() ? "Signing in…" : "Sign in with recovery code"}
              </Button>
            ),
            links: backLink("Back", restart),
            children: (
              <>
                <p class={line}>
                  Enter your email or @handle plus one of your saved recovery codes. All other
                  signed-in sessions will be revoked.
                </p>
                <Field labelTreatment="plain" label="Email or @handle">
                  {(field) => (
                    <Input
                      autocomplete="username"
                      autocapitalize="none"
                      spellcheck={false}
                      value={identifier()}
                      onInput={(e) => setIdentifier(e.currentTarget.value)}
                      required
                      {...tie(field)}
                    />
                  )}
                </Field>
                <Field labelTreatment="plain" label="Recovery code">
                  {(field) => (
                    <Input
                      autocomplete="one-time-code"
                      spellcheck={false}
                      placeholder="xxxx-xxxx-xxxx-xxxx"
                      value={code()}
                      onInput={(e) => setCode(e.currentTarget.value)}
                      required
                      {...tie(field)}
                    />
                  )}
                </Field>
                {errorLine()}
              </>
            ),
          })}
        </form>
      </Show>

      <Show when={view() === "email-identify"}>
        <form onSubmit={sendEmailLink} class="flex flex-col">
          {step({
            action: (
              // The other reasons apply only while idle: the send spends the
              // token, and the widget drops it before the wait ends.
              <Button
                type="submit"
                {...stepAction(props.host)}
                busy={busy()}
                disabled={!busy() && (!email().trim() || (turnstileOn() && !turnstileToken()))}
              >
                {busy() ? "Sending…" : "Send the link"}
              </Button>
            ),
            links: backLink("Back", restart),
            children: (
              <>
                <p class={line}>
                  We'll send a link to the address on the account. Open it on any device to get back
                  in here.
                </p>
                {/* Email only, not "handle or email": this endpoint refuses a
                    handle — it puts mail in somebody's inbox and a handle is
                    public — and the refusal is flattened on the wire, so asking
                    for the wrong thing produces an error with nothing in it. */}
                <Field labelTreatment="plain" label="Email address on the account">
                  {(field) => (
                    <Input
                      type="email"
                      autocomplete="email"
                      autocapitalize="none"
                      value={email()}
                      onInput={(e) => setEmail(e.currentTarget.value)}
                      required
                      {...tie(field)}
                    />
                  )}
                </Field>
                <TurnstileWidget
                  siteKey={props.turnstileSiteKey}
                  onToken={setTurnstileToken}
                  onReady={(c) => (resetTurnstile = c.reset)}
                  alternative="A recovery code doesn't need this challenge: go back and choose “Use a recovery code”."
                />
                {errorLine()}
              </>
            ),
          })}
        </form>
      </Show>

      {/* A wait commits nothing of its own, so in a dialog Cancel stands
          alone. Every way out stays open while a Resend runs, as on the
          step-up sheet's wait: leaving ends the wait on this side. */}
      <Show when={view() === "email-verify"}>
        {step({
          links: backLink("Back", restart),
          children: (
            // The same status and error whether or not the address has an
            // account: a request for one with no account waits and expires
            // like any other.
            <CheckEmailView
              purpose="recovery"
              productName={props.productName}
              email={waiting()?.email}
              status={linkStatus()}
              errorMessage={linkError()}
              pairingCode={pairingCode()}
              resendWaitSeconds={RESEND_WAIT_SECONDS}
              onResend={resendLink}
              onChangeEmail={backToIdentify}
            />
          ),
        })}
      </Show>

      <Show when={view() === "totp"}>
        {step({
          action: (
            <Button
              {...stepAction(props.host)}
              onClick={verifyTotpCode}
              busy={busy()}
              disabled={!busy() && (!identifier().trim() || code().length !== 6)}
            >
              {busy() ? "Checking…" : "Continue"}
            </Button>
          ),
          links: backLink("Back", restart),
          children: (
            <>
              <p class={line}>
                Enter your email or @handle, then the current code from your authenticator app.
              </p>
              <Field labelTreatment="plain" label="Email or @handle">
                {(field) => (
                  <Input
                    autocomplete="username"
                    autocapitalize="none"
                    spellcheck={false}
                    value={identifier()}
                    onInput={(e) => setIdentifier(e.currentTarget.value)}
                    required
                    {...tie(field)}
                  />
                )}
              </Field>
              <div class="flex flex-col gap-1.5">
                <span class={labelVariants()} id={totpCodeLabelId}>
                  Code from your authenticator app
                </span>
                <OtpInput value={code()} onChange={setCode} {...codeRow(totpCodeLabelId)} />
                {errorLine()}
              </div>
            </>
          ),
        })}
      </Show>

      <Show when={view() === "enrol"}>
        {step({
          action: (
            <Button {...stepAction(props.host)} onClick={enrolPasskey} busy={busy()}>
              {busy() ? "Waiting for your passkey…" : error() ? "Try again" : "Add a passkey"}
            </Button>
          ),
          links: <Show when={error()}>{backLink("Start again", restart)}</Show>,
          children: (
            <>
              <h3 class="text-ui-ink text-ui-base font-medium">Add a passkey to get back in</h3>
              {/* Say plainly what this is. A user who has just proved who they
                  are and is then shown a bare button will not know why they
                  are not simply signed in. */}
              <p class={line}>
                You're in a <strong>recovery session</strong>. It can do one thing — add a passkey
                to this account — and it's short-lived, so do it now. Every other session on the
                account has been signed out.
              </p>
              {errorLine()}
            </>
          ),
        })}
      </Show>

      <Show when={view() === "enrolled"}>
        {step({
          action: (
            <Button {...stepAction(props.host)} onClick={() => props.onCancel?.()}>
              Sign in with your new passkey
            </Button>
          ),
          children: (
            <>
              <h3 class="text-ui-ink text-ui-base font-medium">You're back in</h3>
              <p class={line}>
                This device now has a passkey for your account. Sign in with it to finish — that
                also proves the new passkey works.
              </p>
            </>
          ),
        })}
      </Show>

      <Show when={view() === "expired"}>
        {step({
          action: (
            <Button {...stepAction(props.host)} onClick={restart}>
              Start again
            </Button>
          ),
          children: (
            <>
              {/* Its own state, not a 401 toast. Somebody who has just proved
                  who they are and then meets a generic error concludes the
                  product is broken, and stops. */}
              <h3 class="text-ui-ink text-ui-base font-medium">That recovery session timed out</h3>
              <p class={line}>
                Recovery sessions are deliberately short. Nothing has gone wrong and your account is
                fine — start again and you'll get a fresh one.
              </p>
            </>
          ),
        })}
      </Show>
    </div>
  );
}
