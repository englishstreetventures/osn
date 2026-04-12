import type { LoginClient } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { createSignal, Show, onMount } from "solid-js";
import { toast } from "solid-toast";

/**
 * Shared first-party sign-in component. Drives the new `/login/*` endpoints
 * through an injected `LoginClient`, talks to `AuthProvider.adoptSession`
 * from `@osn/client/solid`, and never redirects the browser — registration
 * and sign-in are both fully in-app for first-party OSN apps.
 *
 * Third-party OAuth consumers continue to use `useAuth().login()` + the
 * hosted HTML at `/authorize`; this component is for first-party use only.
 */

type Method = "passkey" | "otp" | "magic";
type Step = "identifier" | "otpCode" | "magicSent" | "done";

export interface SignInProps {
  /**
   * Login client injected by the consuming app. Build it once at boot with
   * `createLoginClient({ issuerUrl })` and pass it in — keeping construction
   * caller-side means the shared component doesn't need app-level env config.
   */
  client: LoginClient;
  /** Fires after the session has been adopted successfully. */
  onSuccess?: () => void;
  /** Fires when the user cancels (typically hides the modal / resets route). */
  onCancel?: () => void;
  /** Which tab to show initially. Defaults to "passkey" when supported, else "otp". */
  defaultMethod?: Method;
}

export function SignIn(props: SignInProps) {
  const { adoptSession } = useAuth();
  const client = props.client;

  // Feature-detect on mount so test code can toggle the underlying mock
  // between renders without needing a fresh import.
  const [passkeySupported, setPasskeySupported] = createSignal(false);
  onMount(() => setPasskeySupported(browserSupportsWebAuthn()));

  const [method, setMethod] = createSignal<Method>(props.defaultMethod ?? "passkey");
  const [step, setStep] = createSignal<Step>("identifier");
  const [identifier, setIdentifier] = createSignal("");
  const [otpCode, setOtpCode] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // If the requested default tab is passkey but the environment doesn't
  // support it, silently fall through to OTP. Done in an onMount to avoid
  // racing with the feature detection above.
  onMount(() => {
    if (method() === "passkey" && !passkeySupported()) setMethod("otp");
  });

  function switchMethod(next: Method) {
    setMethod(next);
    setStep("identifier");
    setOtpCode("");
    setError(null);
  }

  function reportError(e: unknown, fallback: string) {
    const msg = e instanceof Error ? e.message : fallback;
    setError(msg);
    toast.error(msg);
  }

  async function finishWithSession(session: Parameters<typeof adoptSession>[0]) {
    await adoptSession(session);
    setStep("done");
    toast.success("Signed in");
    props.onSuccess?.();
  }

  async function submitPasskey(e: Event) {
    e.preventDefault();
    if (busy() || !identifier().trim()) return;
    setBusy(true);
    setError(null);
    try {
      const beginResult = (await client.passkeyBegin(identifier().trim())) as {
        options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
      };
      const assertion = await startAuthentication({ optionsJSON: beginResult.options });
      const { session } = await client.passkeyComplete(identifier().trim(), assertion);
      await finishWithSession(session);
    } catch (err) {
      reportError(err, "Passkey sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  async function submitOtpIdentifier(e: Event) {
    e.preventDefault();
    if (busy() || !identifier().trim()) return;
    setBusy(true);
    setError(null);
    try {
      await client.otpBegin(identifier().trim());
      setStep("otpCode");
      toast.success("Verification code sent");
    } catch (err) {
      reportError(err, "Couldn't send code");
    } finally {
      setBusy(false);
    }
  }

  async function submitOtpCode(e: Event) {
    e.preventDefault();
    if (busy() || otpCode().length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const { session } = await client.otpComplete(identifier().trim(), otpCode());
      await finishWithSession(session);
    } catch (err) {
      reportError(err, "Invalid code");
    } finally {
      setBusy(false);
    }
  }

  async function submitMagic(e: Event) {
    e.preventDefault();
    if (busy() || !identifier().trim()) return;
    setBusy(true);
    setError(null);
    try {
      await client.magicBegin(identifier().trim());
      setStep("magicSent");
      toast.success("Magic link sent");
    } catch (err) {
      reportError(err, "Couldn't send magic link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="mx-auto max-w-sm px-4 py-8">
      <div class="mb-6 flex items-center justify-between">
        <h2 class="text-foreground text-2xl font-bold">Sign in to OSN</h2>
        <Show when={props.onCancel}>
          <button
            type="button"
            onClick={props.onCancel}
            class="text-muted-foreground hover:text-foreground text-sm"
          >
            Cancel
          </button>
        </Show>
      </div>

      <Show when={step() !== "done"}>
        <div class="mb-4 flex gap-2" role="tablist" aria-label="Sign-in method">
          <Show when={passkeySupported()}>
            <button
              type="button"
              role="tab"
              aria-selected={method() === "passkey"}
              onClick={() => switchMethod("passkey")}
              class="rounded-md border px-3 py-1.5 text-sm"
              classList={{
                "bg-primary text-primary-foreground": method() === "passkey",
                "bg-background text-foreground": method() !== "passkey",
              }}
            >
              Passkey
            </button>
          </Show>
          <button
            type="button"
            role="tab"
            aria-selected={method() === "otp"}
            onClick={() => switchMethod("otp")}
            class="rounded-md border px-3 py-1.5 text-sm"
            classList={{
              "bg-primary text-primary-foreground": method() === "otp",
              "bg-background text-foreground": method() !== "otp",
            }}
          >
            Code
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={method() === "magic"}
            onClick={() => switchMethod("magic")}
            class="rounded-md border px-3 py-1.5 text-sm"
            classList={{
              "bg-primary text-primary-foreground": method() === "magic",
              "bg-background text-foreground": method() !== "magic",
            }}
          >
            Magic link
          </button>
        </div>
      </Show>

      {/* Passkey */}
      <Show when={method() === "passkey" && step() === "identifier"}>
        <form onSubmit={submitPasskey} class="flex flex-col gap-4">
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium">Email or @handle</span>
            <input
              type="text"
              required
              autocomplete="username webauthn"
              value={identifier()}
              onInput={(e) => setIdentifier(e.currentTarget.value)}
              class="border-input bg-background rounded-md border px-3 py-2 text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={busy() || !identifier().trim()}
            class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy() ? "Verifying…" : "Continue with passkey"}
          </button>
        </form>
      </Show>

      {/* OTP — identifier step */}
      <Show when={method() === "otp" && step() === "identifier"}>
        <form onSubmit={submitOtpIdentifier} class="flex flex-col gap-4">
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium">Email or @handle</span>
            <input
              type="text"
              required
              autocomplete="username"
              value={identifier()}
              onInput={(e) => setIdentifier(e.currentTarget.value)}
              class="border-input bg-background rounded-md border px-3 py-2 text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={busy() || !identifier().trim()}
            class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy() ? "Sending…" : "Send verification code"}
          </button>
        </form>
      </Show>

      {/* OTP — code step */}
      <Show when={method() === "otp" && step() === "otpCode"}>
        <form onSubmit={submitOtpCode} class="flex flex-col gap-4">
          <p class="text-muted-foreground text-sm">
            If <strong>{identifier()}</strong> matches an account, we sent a 6-digit code. Enter it
            below.
          </p>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium">Verification code</span>
            <input
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxLength={6}
              required
              value={otpCode()}
              onInput={(e) => setOtpCode(e.currentTarget.value.replace(/\D/g, "").slice(0, 6))}
              class="border-input bg-background rounded-md border px-3 py-2 text-center text-sm tracking-[0.5em]"
            />
          </label>
          <button
            type="submit"
            disabled={busy() || otpCode().length !== 6}
            class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy() ? "Verifying…" : "Sign in"}
          </button>
          <button
            type="button"
            onClick={() => setStep("identifier")}
            class="text-muted-foreground hover:text-foreground text-xs"
          >
            ← Use a different identifier
          </button>
        </form>
      </Show>

      {/* Magic link — identifier step */}
      <Show when={method() === "magic" && step() === "identifier"}>
        <form onSubmit={submitMagic} class="flex flex-col gap-4">
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium">Email or @handle</span>
            <input
              type="text"
              required
              autocomplete="username"
              value={identifier()}
              onInput={(e) => setIdentifier(e.currentTarget.value)}
              class="border-input bg-background rounded-md border px-3 py-2 text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={busy() || !identifier().trim()}
            class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy() ? "Sending…" : "Send magic link"}
          </button>
        </form>
      </Show>

      {/* Magic link — sent state */}
      <Show when={method() === "magic" && step() === "magicSent"}>
        <p class="text-muted-foreground text-sm">
          If <strong>{identifier()}</strong> matches an account, we just emailed a sign-in link.
          Click it to finish signing in.
        </p>
      </Show>

      {/* Done state */}
      <Show when={step() === "done"}>
        <p class="text-muted-foreground text-sm">You&apos;re all set.</p>
      </Show>

      {/* Error display */}
      <Show when={error()}>
        <p class="text-destructive mt-3 text-xs">{error()}</p>
      </Show>
    </div>
  );
}
