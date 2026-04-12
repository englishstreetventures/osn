import type { RegistrationClient } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { createSignal, Show, onCleanup } from "solid-js";
import { toast } from "solid-toast";

type Step = "details" | "verify" | "passkey" | "done";

const HANDLE_RE = /^[a-z0-9_]{1,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface RegisterProps {
  /**
   * Registration client injected by the consuming app. Usually built once at
   * app boot with `createRegistrationClient({ issuerUrl })` and passed in —
   * keeping the construction caller-side means the shared component doesn't
   * need to know about any app's env config.
   */
  client: RegistrationClient;
  onCancel: () => void;
}

export function Register(props: RegisterProps) {
  const { adoptSession } = useAuth();
  const client = props.client;
  // Feature-detect on each mount so test code can toggle the underlying
  // mock between renders. Calling once per mount is negligible cost.
  const passkeySupported = browserSupportsWebAuthn();

  const [step, setStep] = createSignal<Step>("details");
  const [email, setEmail] = createSignal("");
  const [handle, setHandle] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");
  const [otp, setOtp] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [userId, setUserId] = createSignal<string | null>(null);
  const [enrollmentToken, setEnrollmentToken] = createSignal<string | null>(null);

  // Live handle availability check (debounced).
  // "invalid" = local format check failed; "error" = server/network failure
  // while checking availability. Keeping these distinct prevents us from
  // telling the user their perfectly-valid handle is the wrong format just
  // because OSN was unreachable.
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
        // Guard against stale results if the user kept typing.
        if (handle() !== next) return;
        setHandleStatus(available ? "available" : "taken");
      } catch {
        // Local format was already validated above, so any error here is a
        // network/server failure — surface that rather than lying about the
        // format.
        if (handle() !== next) return;
        setHandleStatus("error");
      }
    }, 300);
  }

  // P-I2: inlined as a plain function. Solid's fine-grained reactivity
  // re-evaluates this on every read; the computation is cheap enough that
  // wrapping it in createMemo costs more than it saves.
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
   * Verifies the OTP, persists the new Session immediately, then either
   * advances the user to the passkey step (if WebAuthn is supported) or
   * jumps straight to "done" (P-I1: no createEffect; the branch is
   * imperative right after the state transition).
   *
   * Crucially, `adoptSession` happens BEFORE any passkey work — once the
   * user has verified their email, they're signed in. A flaky WebAuthn
   * ceremony or an unsupported environment can no longer leave them
   * stranded between "verified" and "logged in".
   */
  async function submitOtp(e: Event) {
    e.preventDefault();
    if (busy() || otp().length !== 6) return;
    setBusy(true);
    try {
      const result = await client.completeRegistration({ email: email(), code: otp() });
      setUserId(result.userId);
      setEnrollmentToken(result.enrollmentToken);
      // Sign them in *now* — passkey enrolment is an upsell, not a gate.
      await adoptSession(result.session);
      toast.success("Email verified");
      if (passkeySupported) {
        setStep("passkey");
      } else {
        toast.success(`Welcome, @${handle()}`);
        setStep("done");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Invalid code");
    } finally {
      setBusy(false);
    }
  }

  async function enrollPasskey() {
    const id = userId();
    const token = enrollmentToken();
    if (!id || !token || busy()) return;
    setBusy(true);
    try {
      const options = (await client.passkeyRegisterBegin({
        userId: id,
        enrollmentToken: token,
      })) as Parameters<typeof startRegistration>[0]["optionsJSON"];
      const attestation = await startRegistration({ optionsJSON: options });
      await client.passkeyRegisterComplete({
        userId: id,
        enrollmentToken: token,
        attestation,
      });
      toast.success(`Welcome, @${handle()}`);
      setStep("done");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Passkey setup failed");
    } finally {
      setBusy(false);
    }
  }

  function skipPasskeyForNow() {
    // The user is already signed in (we adopted the session at submitOtp
    // time). Skipping is purely a UI advance.
    toast.success(`Welcome, @${handle()}`);
    setStep("done");
  }

  return (
    <div class="mx-auto max-w-sm px-4 py-8">
      <div class="mb-6 flex items-center justify-between">
        <h2 class="text-foreground text-2xl font-bold">Create your OSN account</h2>
        <button
          type="button"
          onClick={props.onCancel}
          class="text-muted-foreground hover:text-foreground text-sm"
        >
          Cancel
        </button>
      </div>

      <Show when={step() === "details"}>
        <form onSubmit={submitDetails} class="flex flex-col gap-4">
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium">Email</span>
            <input
              type="email"
              required
              autocomplete="email"
              value={email()}
              onInput={(e) => setEmail(e.currentTarget.value)}
              class="border-input bg-background rounded-md border px-3 py-2 text-sm"
            />
          </label>

          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium">Handle</span>
            <div class="flex items-center gap-2">
              <span class="text-muted-foreground">@</span>
              <input
                type="text"
                required
                autocomplete="username"
                value={handle()}
                onInput={(e) => onHandleInput(e.currentTarget.value)}
                placeholder="lowercase, numbers, _"
                class="border-input bg-background flex-1 rounded-md border px-3 py-2 text-sm"
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
          </label>

          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium">Display name (optional)</span>
            <input
              type="text"
              value={displayName()}
              onInput={(e) => setDisplayName(e.currentTarget.value)}
              class="border-input bg-background rounded-md border px-3 py-2 text-sm"
            />
          </label>

          <button
            type="submit"
            disabled={!detailsValid() || busy()}
            class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy() ? "Sending…" : "Send verification code"}
          </button>
        </form>
      </Show>

      <Show when={step() === "verify"}>
        <form onSubmit={submitOtp} class="flex flex-col gap-4">
          <p class="text-muted-foreground text-sm">
            We sent a 6-digit code to <strong>{email()}</strong>. Enter it below to verify.
          </p>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium">Verification code</span>
            <input
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxLength={6}
              required
              value={otp()}
              onInput={(e) => setOtp(e.currentTarget.value.replace(/\D/g, "").slice(0, 6))}
              class="border-input bg-background rounded-md border px-3 py-2 text-center text-sm tracking-[0.5em]"
            />
          </label>
          <button
            type="submit"
            disabled={otp().length !== 6 || busy()}
            class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy() ? "Verifying…" : "Verify email"}
          </button>
          <button
            type="button"
            onClick={() => setStep("details")}
            class="text-muted-foreground hover:text-foreground text-xs"
          >
            ← Use a different email
          </button>
        </form>
      </Show>

      <Show when={step() === "passkey"}>
        <Show
          when={passkeySupported}
          fallback={
            <p class="text-muted-foreground text-sm">
              Signing you in… (passkeys aren&apos;t supported in this environment — you can add one
              later once we ship the mobile app).
            </p>
          }
        >
          <div class="flex flex-col gap-4">
            <p class="text-muted-foreground text-sm">
              Set up a passkey so you can sign back in with Face ID, Touch ID, or your device PIN —
              no password required.
            </p>
            <button
              type="button"
              onClick={enrollPasskey}
              disabled={busy()}
              class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md py-2 text-sm font-medium disabled:opacity-50"
            >
              {busy() ? "Setting up…" : "Create passkey"}
            </button>
            <button
              type="button"
              onClick={skipPasskeyForNow}
              disabled={busy()}
              class="text-muted-foreground hover:text-foreground text-xs"
            >
              Skip for now (you can add one later)
            </button>
          </div>
        </Show>
      </Show>

      <Show when={step() === "done"}>
        <p class="text-muted-foreground text-sm">You&apos;re all set. Loading Pulse…</p>
      </Show>
    </div>
  );
}
