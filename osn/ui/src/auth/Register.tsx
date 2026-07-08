import type { RegistrationClient, Session } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { createSignal, Show, onCleanup } from "solid-js";
import { toast } from "solid-toast";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { OtpInput, type OtpStatus } from "../components/ui/otp-input";
import { TurnstileWidget, turnstileEnabled } from "./TurnstileWidget";

type Step = "details" | "verify" | "passkey" | "done";

const HANDLE_RE = /^[a-z0-9_]{1,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BIRTHDATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// C-H8 (COPPA): mirror the server's under-13 gate for immediate feedback. The
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
  const [passkeyError, setPasskeyError] = createSignal<string | null>(null);
  // Turnstile token — REQUIRED only when a sitekey is provided.
  const [turnstileToken, setTurnstileToken] = createSignal<string | null>(null);
  const turnstileOn = () => turnstileEnabled(props.turnstileSiteKey);
  // Bound to the widget once it mounts; forces a fresh token after the current
  // one is redeemed by `/register/begin` (tokens are single-use — Cloudflare
  // only auto-refreshes on the ~300s expiry, not on consumption).
  let resetTurnstile: (() => void) | undefined;

  const [handleStatus, setHandleStatus] = createSignal<
    "idle" | "checking" | "available" | "taken" | "invalid" | "error"
  >("idle");
  let handleTimer: ReturnType<typeof setTimeout> | null = null;
  // Cancels the previous in-flight availability probe when a new one fires,
  // so debounced typing bursts never stack requests (P-W10).
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

  // C-H8: a birthdate that both parses and clears the under-13 gate. The
  // server re-checks authoritatively (422 on under-13); this is UX only.
  const birthdateOk = () =>
    BIRTHDATE_RE.test(birthdate()) && ageInYears(birthdate()) >= MIN_AGE_YEARS;

  const detailsValid = () =>
    EMAIL_RE.test(email()) &&
    handleStatus() === "available" &&
    birthdateOk() &&
    (!turnstileOn() || turnstileToken() !== null);

  async function submitDetails(e: Event) {
    e.preventDefault();
    if (!detailsValid() || busy()) return;
    setBusy(true);
    try {
      await client.beginRegistration({
        email: email(),
        handle: handle(),
        birthdate: birthdate(),
        displayName: displayName().trim() || undefined,
        turnstileToken: turnstileToken() ?? undefined,
      });
      // Token redeemed by `/begin`; retire it + request a fresh one so a later
      // resend (or a retry after a transient error) never replays a single-use
      // token and gets rejected `timeout-or-duplicate`.
      if (turnstileOn()) resetTurnstile?.();
      toast.success("Verification code sent");
      setStep("verify");
      startResendCooldown();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send code");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Verifies the OTP and persists the session. The session is adopted
   * immediately so the passkey step's fetch calls are authenticated, but
   * the UI refuses to dismiss until enrollment succeeds — the "every
   * account has ≥1 passkey" invariant rests on that refusal combined
   * with the server-side last-passkey guard on `DELETE /passkeys/:id`.
   */
  async function submitOtp(e: Event) {
    e.preventDefault();
    const value = otp();
    if (busy() || value.length !== 6) return;
    setBusy(true);
    setOtpStatus("verifying");
    try {
      const result = await client.completeRegistration({ email: email(), code: value });
      setProfileId(result.profileId);
      setAccessToken(result.session.accessToken);
      setOtpStatus("accepted");
      await adoptSession(result.session as Session);
      toast.success("Email verified");
      setStep("passkey");
    } catch (err) {
      setOtpStatus("error");
      toast.error(err instanceof Error ? err.message : "Invalid code");
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
    if (busy() || resendCooldown() > 0) return;
    setBusy(true);
    try {
      await client.beginRegistration({
        email: email(),
        handle: handle(),
        birthdate: birthdate(),
        displayName: displayName().trim() || undefined,
        // Turnstile tokens are single-use. We reset the widget after every
        // redeeming call, so the value here is a fresh, unconsumed token.
        turnstileToken: turnstileToken() ?? undefined,
      });
      if (turnstileOn()) resetTurnstile?.();
      setOtp("");
      setOtpStatus("idle");
      startResendCooldown();
      toast.success("New code sent");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not resend code");
    } finally {
      setBusy(false);
    }
  }

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
      setStep("done");
      props.onSuccess?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Passkey setup failed";
      setPasskeyError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="mx-auto max-w-sm px-4 py-8">
      <div class="mb-6 flex items-center justify-between">
        <h2 class="text-foreground text-2xl font-bold">Create your OSN account</h2>
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
              Creating an account on OSN needs a passkey or security key — something this browser
              doesn&apos;t support. Try a device with WebAuthn (iOS 16+, Android 9+, a recent
              desktop browser), or plug in a FIDO2 security key.
            </p>
          </div>
        }
      >
        <Show when={step() === "details"}>
          <form onSubmit={submitDetails} class="flex flex-col gap-4">
            <div class="flex flex-col gap-1">
              <Label for="reg-email">Email</Label>
              <Input
                id="reg-email"
                type="email"
                required
                autocomplete="email"
                value={email()}
                onInput={(e) => setEmail(e.currentTarget.value)}
              />
              <Show when={email() && !EMAIL_RE.test(email())}>
                <span class="text-destructive text-xs">Please enter a valid email address</span>
              </Show>
            </div>

            <div class="flex flex-col gap-1">
              <Label for="reg-handle">Handle</Label>
              <div class="flex items-center gap-2">
                <span class="text-muted-foreground">@</span>
                <Input
                  id="reg-handle"
                  type="text"
                  required
                  autocomplete="username"
                  value={handle()}
                  onInput={(e) => onHandleInput(e.currentTarget.value)}
                  placeholder="lowercase, numbers, _"
                  class="flex-1"
                />
              </div>
              <Show when={handleStatus() === "checking"}>
                <span class="text-muted-foreground text-xs">Checking…</span>
              </Show>
              <Show when={handleStatus() === "available"}>
                <span class="text-xs text-green-600">@{handle()} is available</span>
              </Show>
              <Show when={handleStatus() === "taken"}>
                <span class="text-destructive text-xs">@{handle()} is taken</span>
              </Show>
              <Show when={handleStatus() === "invalid"}>
                <span class="text-destructive text-xs">
                  1–30 chars: lowercase letters, numbers, underscores
                </span>
              </Show>
              <Show when={handleStatus() === "error"}>
                <span class="text-destructive text-xs">
                  Couldn&apos;t check availability — try again
                </span>
              </Show>
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
              />
              <Show when={BIRTHDATE_RE.test(birthdate()) && !birthdateOk()}>
                <span class="text-destructive text-xs">OSN is for users 13 and older</span>
              </Show>
              <Show when={!birthdate()}>
                <span class="text-muted-foreground text-xs">
                  You must be 13 or older to use OSN
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
            <Show when={otpStatus() === "error"}>
              <p class="text-destructive text-sm">Incorrect code. Please try again</p>
            </Show>
            <Show when={otpStatus() === "verifying"}>
              <p class="text-muted-foreground text-sm">Verifying your code…</p>
            </Show>
            <Show when={otpStatus() === "accepted"}>
              <p class="text-sm text-green-600">Accepted</p>
            </Show>
            <Button type="submit" disabled={otp().length !== 6 || busy()}>
              {busy() ? "Verifying…" : "Verify email"}
            </Button>
            <button
              type="button"
              onClick={resendCode}
              class="text-primary text-sm font-medium hover:underline disabled:opacity-50"
              disabled={busy() || resendCooldown() > 0}
            >
              {resendCooldown() > 0 ? `Resend code (${resendCooldown()}s)` : "Resend code"}
            </button>
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
            <Button onClick={enrollPasskey} disabled={busy()}>
              {busy() ? "Setting up…" : "Enroll credential"}
            </Button>
            <Show when={passkeyError()}>
              {(msg) => <p class="text-destructive text-sm">{msg()}</p>}
            </Show>
          </div>
        </Show>

        <Show when={step() === "done"}>
          <p class="text-muted-foreground text-sm">You&apos;re all set. Loading Pulse…</p>
        </Show>
      </Show>
    </div>
  );
}
