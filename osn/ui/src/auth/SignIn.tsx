import type { LoginClient } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { createSignal, Show, onMount } from "solid-js";
import { toast } from "solid-toast";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { clsx } from "../lib/utils";

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
          <Button variant="ghost" size="sm" onClick={props.onCancel}>
            Cancel
          </Button>
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
              class={clsx(
                "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                method() === "passkey"
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-foreground hover:bg-muted",
              )}
            >
              Passkey
            </button>
          </Show>
          <button
            type="button"
            role="tab"
            aria-selected={method() === "otp"}
            onClick={() => switchMethod("otp")}
            class={clsx(
              "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
              method() === "otp"
                ? "bg-primary text-primary-foreground"
                : "bg-background text-foreground hover:bg-muted",
            )}
          >
            Code
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={method() === "magic"}
            onClick={() => switchMethod("magic")}
            class={clsx(
              "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
              method() === "magic"
                ? "bg-primary text-primary-foreground"
                : "bg-background text-foreground hover:bg-muted",
            )}
          >
            Magic link
          </button>
        </div>
      </Show>

      {/* Passkey */}
      <Show when={method() === "passkey" && step() === "identifier"}>
        <form onSubmit={submitPasskey} class="flex flex-col gap-4">
          <div class="flex flex-col gap-1">
            <Label for="si-passkey-id">Email or @handle</Label>
            <Input
              id="si-passkey-id"
              type="text"
              required
              autocomplete="username webauthn"
              value={identifier()}
              onInput={(e) => setIdentifier(e.currentTarget.value)}
            />
          </div>
          <Button type="submit" disabled={busy() || !identifier().trim()}>
            {busy() ? "Verifying…" : "Continue with passkey"}
          </Button>
        </form>
      </Show>

      {/* OTP — identifier step */}
      <Show when={method() === "otp" && step() === "identifier"}>
        <form onSubmit={submitOtpIdentifier} class="flex flex-col gap-4">
          <div class="flex flex-col gap-1">
            <Label for="si-otp-id">Email or @handle</Label>
            <Input
              id="si-otp-id"
              type="text"
              required
              autocomplete="username"
              value={identifier()}
              onInput={(e) => setIdentifier(e.currentTarget.value)}
            />
          </div>
          <Button type="submit" disabled={busy() || !identifier().trim()}>
            {busy() ? "Sending…" : "Send verification code"}
          </Button>
        </form>
      </Show>

      {/* OTP — code step */}
      <Show when={method() === "otp" && step() === "otpCode"}>
        <form onSubmit={submitOtpCode} class="flex flex-col gap-4">
          <p class="text-muted-foreground text-sm">
            If <strong>{identifier()}</strong> matches an account, we sent a 6-digit code. Enter it
            below.
          </p>
          <div class="flex flex-col gap-1">
            <Label for="si-otp-code">Verification code</Label>
            <Input
              id="si-otp-code"
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxLength={6}
              required
              value={otpCode()}
              onInput={(e) => setOtpCode(e.currentTarget.value.replace(/\D/g, "").slice(0, 6))}
              class="text-center tracking-[0.5em]"
            />
          </div>
          <Button type="submit" disabled={busy() || otpCode().length !== 6}>
            {busy() ? "Verifying…" : "Sign in"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setStep("identifier")}>
            ← Use a different identifier
          </Button>
        </form>
      </Show>

      {/* Magic link — identifier step */}
      <Show when={method() === "magic" && step() === "identifier"}>
        <form onSubmit={submitMagic} class="flex flex-col gap-4">
          <div class="flex flex-col gap-1">
            <Label for="si-magic-id">Email or @handle</Label>
            <Input
              id="si-magic-id"
              type="text"
              required
              autocomplete="username"
              value={identifier()}
              onInput={(e) => setIdentifier(e.currentTarget.value)}
            />
          </div>
          <Button type="submit" disabled={busy() || !identifier().trim()}>
            {busy() ? "Sending…" : "Send magic link"}
          </Button>
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
