import type { RecoveryClient, RecoveryProfile, RegistrationClient, Session } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { createSignal, onCleanup, onMount, Show } from "solid-js";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { OtpInput } from "../components/ui/otp-input";
import type { RunPasskeyRegistration } from "./StepUpDialog";
import { TurnstileWidget, turnstileEnabled } from "./TurnstileWidget";

/**
 * Every way back into an account that is not a passkey.
 *
 * Mounted from the "Lost your passkey?" link on `<SignIn>`. Three factors, and
 * the first is unlike the other two:
 *
 * 1. **A recovery code** mints an ordinary session. The user is signed in and
 *    can do anything; this component adopts the session and hands off.
 * 2. **An emailed code** and **3. an authenticator-app code** each mint a
 *    *restricted* recovery session, whose one permitted action is enrolling a
 *    passkey. So those two paths end in an enrolment screen, not a signed-in
 *    app — see `wiki/architecture/account-recovery-factors.md` §B.
 *
 * Why the restricted paths never adopt their session
 * --------------------------------------------------
 * Adopting early unmounts this component: `@musubi/social` hides its auth
 * dialogs the moment `session()` is truthy, which is the trap
 * `wiki/systems/passkey-primary.md` records against registration.
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

export interface RecoveryLoginFormProps {
  client: RecoveryClient;
  /**
   * Needed by the two restricted paths, which end in passkey enrolment.
   * Without it — or without {@link RecoveryLoginFormProps.runPasskeyRegistration} —
   * neither is offered, because neither could be finished.
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
  onSuccess?: () => void;
  onCancel?: () => void;
}

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
  onMount(() => setWebauthnSupported(browserSupportsWebAuthn()));

  const [view, setView] = createSignal<View>("choose");
  const [identifier, setIdentifier] = createSignal("");
  const [email, setEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [held, setHeld] = createSignal<HeldRecovery | null>(null);
  const [turnstileToken, setTurnstileToken] = createSignal<string | null>(null);
  const turnstileOn = () => turnstileEnabled(props.turnstileSiteKey);
  let resetTurnstile: (() => void) | undefined;

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

  onCleanup(() => {
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
    epoch += 1;
    setHeld(result);
    scheduleRefresh(result.session);
    setCode("");
    setError(null);
    setView("enrol");
  }

  function restart() {
    epoch += 1;
    clearTimeout(expiryTimer);
    setHeld(null);
    setCode("");
    setError(null);
    setView("choose");
  }

  async function submitRecoveryCode(e: Event) {
    e.preventDefault();
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
      // Generic message — the server deliberately doesn't distinguish "wrong
      // identifier" from "wrong code" to avoid a user-existence oracle.
      setError("That recovery code didn't work. Double-check the code and identifier.");
      void err;
    } finally {
      setBusy(false);
    }
  }

  async function sendEmailCode(e: Event) {
    e.preventDefault();
    if (busy() || !email().trim()) return;
    if (turnstileOn() && !turnstileToken()) {
      setError("Please complete the verification challenge below.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.client.emailRecoveryBegin({
        identifier: email().trim(),
        turnstileToken: turnstileToken() ?? undefined,
      });
      // The token has now been redeemed and Cloudflare only auto-refreshes on
      // expiry, not on consumption — so a second send (a typo, a resend)
      // would replay a spent token and be rejected.
      if (turnstileOn()) resetTurnstile?.();
      setCode("");
      setView("email-verify");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send a code");
    } finally {
      setBusy(false);
    }
  }

  async function verifyEmailCode() {
    if (busy() || code().length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      beginRestricted(
        await props.client.emailRecoveryComplete({
          identifier: email().trim(),
          code: code(),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code didn't work");
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
      setError(err instanceof Error ? err.message : "That code didn't work");
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
      setError(err instanceof Error ? err.message : "Couldn't add a passkey");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="flex flex-col gap-4">
      {/* Operand order is load-bearing: `&&` yields its LAST operand, so
          putting the predicate first is what makes `msg()` the message rather
          than the boolean `true`, which Solid renders as nothing. */}
      <Show when={view() !== "expired" && error()}>
        {(msg) => (
          <p class="text-destructive text-sm" role="alert">
            {msg()}
          </p>
        )}
      </Show>

      <Show when={view() === "choose"}>
        <div class="flex flex-col gap-3">
          <p class="text-muted-foreground text-sm">
            Pick how you'd like to prove this account is yours.
          </p>
          <Button onClick={() => setView("code")}>Use a recovery code</Button>
          <Show when={restrictedFactorsAvailable()}>
            <Button variant="outline" onClick={() => setView("email-identify")}>
              Email me a code
            </Button>
            <Button variant="outline" onClick={() => setView("totp")}>
              Use my authenticator app
            </Button>
          </Show>
          {/* Where a WebAuthn ceremony cannot run, the two restricted factors
              are useless and the honest answer is the list of things that do
              work. Same copy as the unsupported-browser screen on sign-in. */}
          <Show when={!restrictedFactorsAvailable()}>
            <div class="text-muted-foreground flex flex-col gap-2 text-sm">
              <p>
                The other ways back in need a passkey ceremony, which this browser can't run. You
                can:
              </p>
              <ul class="list-inside list-disc">
                <li>
                  Sign in on a device that supports passkeys (iOS 16+, Android 9+, recent desktop
                  browsers).
                </li>
                <li>
                  Use your phone via the QR / Bluetooth cross-device flow your password manager
                  offers.
                </li>
                <li>Plug in a FIDO2 security key and reload the page.</li>
              </ul>
            </div>
          </Show>
          <Show when={props.onCancel}>
            {(cancel) => (
              <Button variant="ghost" onClick={cancel()}>
                Back to sign in
              </Button>
            )}
          </Show>
        </div>
      </Show>

      <Show when={view() === "code"}>
        <form onSubmit={submitRecoveryCode} class="flex flex-col gap-3">
          <p class="text-muted-foreground text-sm">
            Enter your handle or email plus one of your saved recovery codes. All other signed-in
            sessions will be revoked.
          </p>
          <div class="flex flex-col gap-1">
            <Label for="recovery-identifier">Handle or email</Label>
            <Input
              id="recovery-identifier"
              autocomplete="username"
              value={identifier()}
              onInput={(e) => setIdentifier(e.currentTarget.value)}
              required
            />
          </div>
          <div class="flex flex-col gap-1">
            <Label for="recovery-code">Recovery code</Label>
            <Input
              id="recovery-code"
              autocomplete="one-time-code"
              placeholder="xxxx-xxxx-xxxx-xxxx"
              value={code()}
              onInput={(e) => setCode(e.currentTarget.value)}
              required
            />
          </div>
          <div class="flex gap-2">
            <Button type="submit" disabled={busy() || !identifier() || !code()}>
              {busy() ? "Signing in…" : "Sign in with recovery code"}
            </Button>
            <Button type="button" variant="ghost" onClick={restart} disabled={busy()}>
              Back
            </Button>
          </div>
        </form>
      </Show>

      <Show when={view() === "email-identify"}>
        <form onSubmit={sendEmailCode} class="flex flex-col gap-3">
          <p class="text-muted-foreground text-sm">
            We'll send a six-digit code to the address on the account.
          </p>
          <div class="flex flex-col gap-1">
            {/* Email only, not "handle or email": this endpoint refuses a
                handle — it puts mail in somebody's inbox and a handle is
                public — and the refusal is flattened on the wire, so asking
                for the wrong thing produces an error with nothing in it. */}
            <Label for="recovery-email">Email address on the account</Label>
            <Input
              id="recovery-email"
              type="email"
              autocomplete="email"
              value={email()}
              onInput={(e) => setEmail(e.currentTarget.value)}
              required
            />
          </div>
          <TurnstileWidget
            siteKey={props.turnstileSiteKey}
            onToken={setTurnstileToken}
            onReady={(c) => (resetTurnstile = c.reset)}
          />
          <div class="flex gap-2">
            <Button
              type="submit"
              disabled={busy() || !email().trim() || (turnstileOn() && !turnstileToken())}
            >
              {busy() ? "Sending…" : "Send the code"}
            </Button>
            <Button type="button" variant="ghost" onClick={restart} disabled={busy()}>
              Back
            </Button>
          </div>
        </form>
      </Show>

      <Show when={view() === "email-verify"}>
        <div class="flex flex-col gap-3">
          <p class="text-muted-foreground text-sm">
            If that address has an account, a code is on its way. Enter it below.
          </p>
          <div class="flex flex-col gap-2">
            <span class="text-sm font-medium">Code from your email</span>
            <OtpInput
              value={code()}
              onChange={setCode}
              status={error() ? "error" : busy() ? "verifying" : "idle"}
              autofocus
            />
          </div>
          <div class="flex gap-2">
            <Button onClick={verifyEmailCode} disabled={busy() || code().length !== 6}>
              {busy() ? "Checking…" : "Continue"}
            </Button>
            <Button variant="ghost" onClick={restart} disabled={busy()}>
              Back
            </Button>
          </div>
        </div>
      </Show>

      <Show when={view() === "totp"}>
        <div class="flex flex-col gap-3">
          <p class="text-muted-foreground text-sm">
            Enter your handle or email, then the current code from your authenticator app.
          </p>
          <div class="flex flex-col gap-1">
            <Label for="totp-recovery-identifier">Handle or email</Label>
            <Input
              id="totp-recovery-identifier"
              autocomplete="username"
              value={identifier()}
              onInput={(e) => setIdentifier(e.currentTarget.value)}
              required
            />
          </div>
          <div class="flex flex-col gap-2">
            <span class="text-sm font-medium">Code from your authenticator app</span>
            <OtpInput
              value={code()}
              onChange={setCode}
              status={error() ? "error" : busy() ? "verifying" : "idle"}
            />
          </div>
          <div class="flex gap-2">
            <Button
              onClick={verifyTotpCode}
              disabled={busy() || !identifier().trim() || code().length !== 6}
            >
              {busy() ? "Checking…" : "Continue"}
            </Button>
            <Button variant="ghost" onClick={restart} disabled={busy()}>
              Back
            </Button>
          </div>
        </div>
      </Show>

      <Show when={view() === "enrol"}>
        <div class="flex flex-col gap-3">
          <h3 class="text-lg font-semibold">Add a passkey to get back in</h3>
          {/* Say plainly what this is. A user who has just proved who they are
              and is then shown a bare button will not know why they are not
              simply signed in. */}
          <p class="text-muted-foreground text-sm">
            You're in a <strong>recovery session</strong>. It can do one thing — add a passkey to
            this account — and it's short-lived, so do it now. Every other session on the account
            has been signed out.
          </p>
          <div class="flex gap-2">
            <Button onClick={enrolPasskey} disabled={busy()}>
              {busy() ? "Waiting for your passkey…" : error() ? "Try again" : "Add a passkey"}
            </Button>
            <Show when={error()}>
              <Button variant="ghost" onClick={restart} disabled={busy()}>
                Start again
              </Button>
            </Show>
          </div>
        </div>
      </Show>

      <Show when={view() === "enrolled"}>
        <div class="flex flex-col gap-3">
          <h3 class="text-lg font-semibold">You're back in</h3>
          <p class="text-muted-foreground text-sm">
            This device now has a passkey for your account. Sign in with it to finish — that also
            proves the new passkey works.
          </p>
          <Button onClick={() => props.onCancel?.()}>Sign in with your new passkey</Button>
        </div>
      </Show>

      <Show when={view() === "expired"}>
        <div class="flex flex-col gap-3">
          {/* Its own state, not a 401 toast. Somebody who has just proved who
              they are and then meets a generic error concludes the product is
              broken, and stops. */}
          <h3 class="text-lg font-semibold">That recovery session timed out</h3>
          <p class="text-muted-foreground text-sm">
            Recovery sessions are deliberately short. Nothing has gone wrong and your account is
            fine — start again and you'll get a fresh one.
          </p>
          <Button onClick={restart}>Start again</Button>
        </div>
      </Show>
    </div>
  );
}
