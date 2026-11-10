import { describeAuthError, type RegistrationClient, type Session } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { toast } from "@shared/toast";
import { Button } from "@shared/ui/ui/button";
import { InfoPopover } from "@shared/ui/ui/info-popover";
import { Input } from "@shared/ui/ui/input";
import { Label } from "@shared/ui/ui/label";
import { Notice } from "@shared/ui/ui/notice";
import { OtpInput, type OtpStatus } from "@shared/ui/ui/otp-input";
import { UsernameInput } from "@shared/ui/ui/username-input";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { createSignal, createUniqueId, Show, onCleanup } from "solid-js";

import { describedBy } from "./error-lines";
import { describePasskeyError } from "./passkey-errors";
import { TurnstileWidget, turnstileEnabled } from "./TurnstileWidget";

type Step = "details" | "verify" | "passkey" | "done";

const HANDLE_RE = /^[a-z0-9_]{1,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BIRTHDATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// (COPPA) Mirrors the server's under-13 gate for immediate feedback. The
// server remains authoritative — it re-checks and returns 422 for under-13.
const MIN_AGE_YEARS = 13;

/** Whole years from a `YYYY-MM-DD` birthdate to now (UTC), birthday-aware. */
function ageInYears(birthdate: string): number {
  const b = new Date(`${birthdate}T00:00:00.000Z`);
  if (Number.isNaN(b.getTime())) return Number.NaN;
  const now = new Date();
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - b.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < b.getUTCDate())) age -= 1;
  return age;
}

interface RegisterProps {
  client: RegistrationClient;
  onCancel: () => void;
  /**
   * Fired once the account exists and its first passkey is enrolled — i.e.
   * the session is fully usable. Consumers that own navigation (e.g. a
   * standalone login page) redirect here; consumers that react to
   * `session()` directly can omit it.
   */
  onSuccess?: () => void;
  /**
   * Cloudflare Turnstile sitekey (public, build-time). When provided, the
   * "details" step renders the Turnstile challenge and gates "Send verification
   * code" on it (the token rides on `/register/begin`). Omitted/blank ⇒ no
   * widget, no gate (key-optional — matches osn-api skipping siteverify).
   */
  turnstileSiteKey?: string;
  /** Product name shown in this dialog's copy — e.g. "Musubi". */
  productName: string;
}

export function Register(props: RegisterProps) {
  const { adoptSession } = useAuth();
  const client = props.client;
  // Feature-detect on each mount so test code can toggle the underlying mock.
  const webauthnSupported = browserSupportsWebAuthn();

  const [step, setStep] = createSignal<Step>("details");
  const [email, setEmail] = createSignal("");
  const [handle, setHandle] = createSignal("");
  const [birthdate, setBirthdate] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");
  const [otp, setOtp] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [otpStatus, setOtpStatus] = createSignal<OtpStatus>("idle");
  const [resendCooldown, setResendCooldown] = createSignal(0);
  const [profileId, setProfileId] = createSignal<string | null>(null);
  const [accessToken, setAccessToken] = createSignal<string | null>(null);
  // Held, not published, between OTP verify and passkey enrollment. See
  // `submitOtp` for why the hand-off to `adoptSession` waits.
  const [session, setSession] = createSignal<Session | null>(null);
  // One line per step, each where its step's action is: a refused send above
  // "Send verification code", a refused code under the code, a refused resend
  // under "Resend code", a failed enrolment above "Enroll credential".
  const [detailsError, setDetailsError] = createSignal<string | null>(null);
  const [codeError, setCodeError] = createSignal<string | null>(null);
  const [resendError, setResendError] = createSignal<string | null>(null);
  const [passkeyError, setPasskeyError] = createSignal<string | null>(null);
  // The email line waits until the field is left, so it is not announced on
  // every keystroke of an address still being typed.
  const [emailLeft, setEmailLeft] = createSignal(false);
  const emailErrorId = createUniqueId();
  const birthdateHintId = createUniqueId();
  const birthdateErrorId = createUniqueId();
  // Turnstile token — REQUIRED only when a sitekey is provided.
  const [turnstileToken, setTurnstileToken] = createSignal<string | null>(null);
  const turnstileOn = () => turnstileEnabled(props.turnstileSiteKey);
  // Bound to the mounted widget — the details step's, then the code step's own
  // for "Resend code". Forces a fresh token after `/register/begin` has spent
  // the current one (tokens are single-use — Cloudflare only refreshes a token
  // when it expires, ~300s, never when it is spent).
  let resetTurnstile: (() => void) | undefined;

  // Names all three jobs the address does, so the choice of address is made
  // knowing the second: an emailed code is a way back into an account whose
  // passkeys are all gone.
  const emailUses = () =>
    `We send a six-digit code here to confirm the address — your ${props.productName} account is not created until you enter it. It is also how you get back in if you lose every device with a passkey on it, so use an address you will still be reading in a year. Security notices come here too, such as a recovery code being created or used.`;

  const [handleStatus, setHandleStatus] = createSignal<
    "idle" | "checking" | "available" | "taken" | "invalid" | "error"
  >("idle");
  let handleTimer: ReturnType<typeof setTimeout> | null = null;
  // Cancels the previous in-flight availability probe when a new one fires,
  // so debounced typing bursts never stack requests.
  let handleAbort: AbortController | null = null;
  onCleanup(() => {
    if (handleTimer) clearTimeout(handleTimer);
    handleAbort?.abort();
  });

  function onHandleInput(value: string) {
    const next = value.toLowerCase().replace(/[^a-z0-9_]/g, "");
    setHandle(next);
    if (handleTimer) clearTimeout(handleTimer);
    if (!next) {
      setHandleStatus("idle");
      return;
    }
    if (!HANDLE_RE.test(next)) {
      setHandleStatus("invalid");
      return;
    }
    setHandleStatus("checking");
    handleTimer = setTimeout(async () => {
      handleAbort?.abort();
      const controller = new AbortController();
      handleAbort = controller;
      try {
        const { available } = await client.checkHandle(next, controller.signal);
        if (handle() !== next) return;
        setHandleStatus(available ? "available" : "taken");
      } catch {
        // An aborted probe was superseded (or unmounted) — never an error state.
        if (controller.signal.aborted || handle() !== next) return;
        setHandleStatus("error");
      }
    }, 300);
  }

  // A birthdate that both parses and clears the under-13 gate. The
  // server re-checks authoritatively (422 on under-13); this is UX only.
  const birthdateOk = () =>
    BIRTHDATE_RE.test(birthdate()) && ageInYears(birthdate()) >= MIN_AGE_YEARS;
  const underAge = () => BIRTHDATE_RE.test(birthdate()) && !birthdateOk();
  const emailMalformed = () => emailLeft() && email() !== "" && !EMAIL_RE.test(email());

  const detailsValid = () =>
    EMAIL_RE.test(email()) &&
    handleStatus() === "available" &&
    birthdateOk() &&
    (!turnstileOn() || turnstileToken() !== null);

  async function submitDetails(e: Event) {
    e.preventDefault();
    if (!detailsValid() || busy()) return;
    setBusy(true);
    setDetailsError(null);
    try {
      await spendingToken(() =>
        client.beginRegistration({
          email: email(),
          handle: handle(),
          birthdate: birthdate(),
          displayName: displayName().trim() || undefined,
          turnstileToken: turnstileToken() ?? undefined,
        }),
      );
      toast.success("Verification code sent");
      setResendError(null);
      setCodeError(null);
      // The cooldown first: the code step mounts its widget only once a
      // resend is possible.
      startResendCooldown();
      setStep("verify");
    } catch (err) {
      // The server answers a taken email or handle the same as a free one, so
      // this never says which; a 422 is the age gate, a 429 says to wait.
      setDetailsError(describeAuthError(err, "details"));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Verifies the OTP and parks the new session in a signal — it is NOT
   * adopted here. The passkey step authenticates with the access token
   * directly, so nothing in the flow needs a published session, and
   * publishing one early would announce a signed-in user whose account
   * still has zero passkeys. Consumers act on that announcement:
   * `@musubi/social` hides its auth dialogs the moment `session()` is
   * truthy, which unmounted this component mid-flow and skipped
   * enrollment altogether. `enrollPasskey` adopts it once the credential
   * exists — that, plus the server-side last-passkey guard on
   * `DELETE /passkeys/:id`, is what holds up the "every account has ≥1
   * passkey" invariant.
   */
  async function submitOtp(e: Event) {
    e.preventDefault();
    const value = otp();
    if (busy() || value.length !== 6) return;
    setBusy(true);
    setOtpStatus("verifying");
    setCodeError(null);
    try {
      const result = await client.completeRegistration({ email: email(), code: value });
      setProfileId(result.profileId);
      setAccessToken(result.session.accessToken);
      setSession(result.session as Session);
      setOtpStatus("accepted");
      toast.success("Email verified");
      setStep("passkey");
    } catch (err) {
      setOtpStatus("error");
      setCodeError(describeAuthError(err, "code"));
    } finally {
      setBusy(false);
    }
  }

  function startResendCooldown() {
    setResendCooldown(30);
    const id = setInterval(() => {
      setResendCooldown((n) => {
        if (n <= 1) {
          clearInterval(id);
          return 0;
        }
        return n - 1;
      });
    }, 1000);
  }

  async function resendCode() {
    if (busy() || resendCooldown() > 0 || (turnstileOn() && turnstileToken() === null)) return;
    setBusy(true);
    setResendError(null);
    try {
      await spendingToken(() =>
        client.beginRegistration({
          email: email(),
          handle: handle(),
          birthdate: birthdate(),
          displayName: displayName().trim() || undefined,
          // The code step's own widget's token: every spending call resets
          // the widget, so this one is unspent.
          turnstileToken: turnstileToken() ?? undefined,
        }),
      );
      setOtp("");
      setOtpStatus("idle");
      setCodeError(null);
      startResendCooldown();
      toast.success("New code sent");
    } catch (err) {
      setResendError(describeAuthError(err, "details"));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Runs a call that spends the Turnstile token. The server checks the token
   * before it answers, so a refusal has spent it too: on a failure the widget
   * stays on screen and is asked for a fresh token. On a success the widget
   * goes away (the step moves on, or the resend cooldown starts), so the
   * spent token is dropped instead of running a challenge nobody will use.
   */
  async function spendingToken<T>(call: () => Promise<T>): Promise<T> {
    try {
      const result = await call();
      setTurnstileToken(null);
      return result;
    } catch (err) {
      if (turnstileOn()) resetTurnstile?.();
      throw err;
    }
  }

  /**
   * Enrolls the account's first credential, then signs the user in. The
   * order matters: `adoptSession` is what tells the rest of the app a user
   * is present, and until the credential exists there is no account worth
   * announcing — a failed or abandoned ceremony leaves the user signed out,
   * still on this step, able to try again.
   */
  async function enrollPasskey() {
    const id = profileId();
    const token = accessToken();
    if (!id || !token || busy()) return;
    setBusy(true);
    setPasskeyError(null);
    try {
      const options = (await client.passkeyRegisterBegin({
        profileId: id,
        accessToken: token,
      })) as Parameters<typeof startRegistration>[0]["optionsJSON"];
      const attestation = await startRegistration({ optionsJSON: options });
      await client.passkeyRegisterComplete({
        profileId: id,
        accessToken: token,
        attestation,
      });
      toast.success(`Welcome, @${handle()}`);
      const next = session();
      if (next) await adoptSession(next);
      // "done" comes last, after the session is actually published. It is the
      // one step with no error slot and no retry button, so anything that can
      // still fail has to fail while the passkey step is on screen — and
      // `adoptSession` can: it writes to `localStorage`, which throws when
      // storage is disabled or full.
      setStep("done");
      props.onSuccess?.();
    } catch (err) {
      setPasskeyError(describePasskeyError(err, "registration"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="mx-auto max-w-sm px-4 py-8">
      <div class="mb-6 flex items-center justify-between">
        <h2 class="text-foreground text-2xl font-bold">Create your {props.productName} account</h2>
        <Button variant="ghost" size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>

      {/* Gate the flow behind WebAuthn support: registration demands an
          enrolled passkey or security key, so there is no path forward from
          a browser without WebAuthn. */}
      <Show
        when={webauthnSupported}
        fallback={
          <div class="flex flex-col gap-4">
            <p class="text-muted-foreground text-sm">
              Creating an account on {props.productName} needs a passkey or security key — something
              this browser doesn&apos;t support. Try a device with WebAuthn (iOS 16+, Android 9+, a
              recent desktop browser), or plug in a FIDO2 security key.
            </p>
          </div>
        }
      >
        <Show when={step() === "details"}>
          <form onSubmit={submitDetails} class="flex flex-col gap-4">
            <div class="flex flex-col gap-1">
              <div class="flex items-center">
                <Label for="reg-email">Email</Label>
                <InfoPopover
                  label="What this address is used for"
                  glyph="i"
                  placement="top"
                  body={emailUses()}
                />
              </div>
              <Input
                id="reg-email"
                type="email"
                required
                autocomplete="email"
                value={email()}
                onInput={(e) => setEmail(e.currentTarget.value)}
                onBlur={() => setEmailLeft(true)}
                aria-describedby={emailMalformed() ? emailErrorId : undefined}
                aria-invalid={emailMalformed() || undefined}
              />
              <Show when={emailMalformed()}>
                <Notice tone="danger" size="inline" alert id={emailErrorId}>
                  Please enter a valid email address
                </Notice>
              </Show>
            </div>

            <div class="flex flex-col gap-1">
              <Label for="reg-handle">Handle</Label>
              <UsernameInput
                id="reg-handle"
                required
                value={handle()}
                onInput={onHandleInput}
                status={handleStatus()}
                placeholder="lowercase, numbers, _"
                invalidMessage="1–30 chars: lowercase letters, numbers, underscores"
              />
            </div>

            <div class="flex flex-col gap-1">
              <Label for="reg-birthdate">Date of birth</Label>
              <Input
                id="reg-birthdate"
                type="date"
                required
                autocomplete="bday"
                value={birthdate()}
                onInput={(e) => setBirthdate(e.currentTarget.value)}
                aria-describedby={describedBy(
                  !birthdate() && birthdateHintId,
                  underAge() && birthdateErrorId,
                )}
                aria-invalid={underAge() || undefined}
              />
              <Show when={underAge()}>
                <Notice tone="danger" size="inline" alert id={birthdateErrorId}>
                  {props.productName} is for users 13 and older
                </Notice>
              </Show>
              <Show when={!birthdate()}>
                <span id={birthdateHintId} class="text-muted-foreground text-xs">
                  You must be 13 or older to create an account.
                </span>
              </Show>
            </div>

            <div class="flex flex-col gap-1">
              <Label for="reg-display-name">Display name (optional)</Label>
              <Input
                id="reg-display-name"
                type="text"
                value={displayName()}
                onInput={(e) => setDisplayName(e.currentTarget.value)}
              />
            </div>

            {/* Turnstile challenge — renders only when a sitekey is provided. */}
            <TurnstileWidget
              siteKey={props.turnstileSiteKey}
              onToken={setTurnstileToken}
              onReady={(c) => (resetTurnstile = c.reset)}
            />

            <Show when={detailsError()}>
              {(msg) => (
                <Notice tone="danger" size="inline" alert>
                  {msg()}
                </Notice>
              )}
            </Show>
            <Button type="submit" disabled={!detailsValid() || busy()}>
              {busy() ? "Sending…" : "Send verification code"}
            </Button>
          </form>
        </Show>

        <Show when={step() === "verify"}>
          <form onSubmit={submitOtp} class="flex flex-col gap-4">
            <p class="text-muted-foreground text-sm">
              We sent a 6-digit code to <strong>{email()}</strong>. Enter it below to verify.
            </p>
            <OtpInput
              value={otp()}
              onChange={setOtp}
              status={otpStatus()}
              disabled={busy()}
              autofocus
            />
            {/* Announced, but not yet tied to the boxes: `OtpInput` takes no
                `aria-describedby` until englishstreetventures/osn#2041. */}
            <Show when={codeError()}>
              {(msg) => (
                <Notice tone="danger" size="inline" alert>
                  {msg()}
                </Notice>
              )}
            </Show>
            <Show when={otpStatus() === "verifying"}>
              <p class="text-muted-foreground text-sm">Verifying your code…</p>
            </Show>
            <Show when={otpStatus() === "accepted"}>
              <p class="text-ui-success text-sm">Accepted</p>
            </Show>
            <Button type="submit" disabled={otp().length !== 6 || busy()}>
              {busy() ? "Verifying…" : "Verify email"}
            </Button>
            {/* A resend spends a token like the first send, and the details
                step's widget went with that step. Mounted only once a resend
                is possible, so a sign-up that never resends runs one
                challenge. */}
            <Show when={resendCooldown() === 0}>
              <TurnstileWidget
                siteKey={props.turnstileSiteKey}
                onToken={setTurnstileToken}
                onReady={(c) => (resetTurnstile = c.reset)}
              />
            </Show>
            <button
              type="button"
              onClick={resendCode}
              class="text-primary text-sm font-medium hover:underline disabled:opacity-50"
              disabled={
                busy() || resendCooldown() > 0 || (turnstileOn() && turnstileToken() === null)
              }
            >
              {resendCooldown() > 0 ? `Resend code (${resendCooldown()}s)` : "Resend code"}
            </button>
            <Show when={resendError()}>
              {(msg) => (
                <Notice tone="danger" size="inline" alert>
                  {msg()}
                </Notice>
              )}
            </Show>
            <Button variant="ghost" size="sm" onClick={() => setStep("details")}>
              ← Use a different email
            </Button>
          </form>
        </Show>

        <Show when={step() === "passkey"}>
          <div class="flex flex-col gap-4">
            <p class="text-muted-foreground text-sm">
              Enroll a passkey or security key so you can sign back in. This is required to finish
              creating your account.
            </p>
            <Show when={passkeyError()}>
              {(msg) => (
                <Notice tone="danger" size="inline" alert>
                  {msg()}
                </Notice>
              )}
            </Show>
            <Button onClick={enrollPasskey} disabled={busy()}>
              {busy() ? "Setting up…" : "Enroll credential"}
            </Button>
          </div>
        </Show>

        <Show when={step() === "done"}>
          <p class="text-muted-foreground text-sm">
            You&apos;re all set. Loading {props.productName}…
          </p>
        </Show>
      </Show>
    </div>
  );
}
