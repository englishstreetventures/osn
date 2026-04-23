import type { RegistrationClient, Session } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { createSignal, Show, onCleanup } from "solid-js";
import { toast } from "solid-toast";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { OtpInput, type OtpStatus } from "../components/ui/otp-input";

type Step = "details" | "verify" | "passkey" | "done";

const HANDLE_RE = /^[a-z0-9_]{1,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface RegisterProps {
  client: RegistrationClient;
  onCancel: () => void;
}

export function Register(props: RegisterProps) {
  const { adoptSession } = useAuth();
  const client = props.client;
  // Feature-detect on each mount so test code can toggle the underlying mock.
  const webauthnSupported = browserSupportsWebAuthn();

  const [step, setStep] = createSignal<Step>("details");
  const [email, setEmail] = createSignal("");
  const [handle, setHandle] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");
  const [otp, setOtp] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [otpStatus, setOtpStatus] = createSignal<OtpStatus>("idle");
  const [resendCooldown, setResendCooldown] = createSignal(0);
  const [profileId, setProfileId] = createSignal<string | null>(null);
  const [accessToken, setAccessToken] = createSignal<string | null>(null);
  const [passkeyError, setPasskeyError] = createSignal<string | null>(null);

  const [handleStatus, setHandleStatus] = createSignal<
    "idle" | "checking" | "available" | "taken" | "invalid" | "error"
  >("idle");
  let handleTimer: ReturnType<typeof setTimeout> | null = null;
  onCleanup(() => {
    if (handleTimer) clearTimeout(handleTimer);
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
      try {
        const { available } = await client.checkHandle(next);
        if (handle() !== next) return;
        setHandleStatus(available ? "available" : "taken");
      } catch {
        if (handle() !== next) return;
        setHandleStatus("error");
      }
    }, 300);
  }

  const detailsValid = () => EMAIL_RE.test(email()) && handleStatus() === "available";

  async function submitDetails(e: Event) {
    e.preventDefault();
    if (!detailsValid() || busy()) return;
    setBusy(true);
    try {
      await client.beginRegistration({
        email: email(),
        handle: handle(),
        displayName: displayName().trim() || undefined,
      });
      toast.success("Verification code sent");
      setStep("verify");
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
        displayName: displayName().trim() || undefined,
      });
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
              <Label for="reg-display-name">Display name (optional)</Label>
              <Input
                id="reg-display-name"
                type="text"
                value={displayName()}
                onInput={(e) => setDisplayName(e.currentTarget.value)}
              />
            </div>

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
            <Show when={otpStatus() === "error"}>
              <button
                type="button"
                onClick={resendCode}
                class="text-primary text-sm font-medium hover:underline disabled:opacity-50"
                disabled={busy() || resendCooldown() > 0}
              >
                {resendCooldown() > 0 ? `Resend code (${resendCooldown()}s)` : "Resend code"}
              </button>
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
