import type { LoginClient, RecoveryClient } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { createSignal, Show, onMount } from "solid-js";
import { toast } from "solid-toast";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { RecoveryLoginForm } from "./RecoveryLoginForm";

/**
 * Shared sign-in component. WebAuthn (passkey or security key) is the only
 * primary login factor. If the environment lacks WebAuthn support we show
 * an informational screen rather than a broken form; users can still click
 * through to recovery-code login.
 *
 * Drives `/login/passkey/*` through an injected `LoginClient`, talks to
 * `AuthProvider.adoptSession` from `@osn/client/solid`, and never redirects
 * the browser.
 */

type View = "passkey" | "recovery";

export interface SignInProps {
  client: LoginClient;
  /** Needed for the "Lost your passkey?" escape hatch. */
  recoveryClient: RecoveryClient;
  onSuccess?: () => void;
  onCancel?: () => void;
}

export function SignIn(props: SignInProps) {
  const { adoptSession } = useAuth();
  const client = props.client;

  // Feature-detect on mount so test code can toggle the underlying mock
  // between renders without needing a fresh import.
  const [webauthnSupported, setWebauthnSupported] = createSignal(false);
  onMount(() => setWebauthnSupported(browserSupportsWebAuthn()));

  const [view, setView] = createSignal<View>("passkey");
  const [identifier, setIdentifier] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [signedIn, setSignedIn] = createSignal(false);

  function reportError(e: unknown, fallback: string) {
    const msg = e instanceof Error ? e.message : fallback;
    setError(msg);
    toast.error(msg);
  }

  async function finishWithSession(session: Parameters<typeof adoptSession>[0]) {
    await adoptSession(session);
    setSignedIn(true);
    toast.success("Signed in");
    props.onSuccess?.();
  }

  async function submitPasskey(e: Event) {
    e.preventDefault();
    if (busy() || !identifier().trim()) return;
    setBusy(true);
    setError(null);
    try {
      const trimmed = identifier().trim();
      const beginResult = (await client.passkeyBegin(trimmed)) as {
        options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
      };
      const assertion = await startAuthentication({ optionsJSON: beginResult.options });
      const { session } = await client.passkeyComplete({ identifier: trimmed, assertion });
      await finishWithSession(session);
    } catch (err) {
      reportError(err, "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Discoverable-credential (conditional-UI) flow. Kicks off on mount when
   * the browser supports `mediation: "conditional"` and the user has at
   * least one resident credential for the RP. The ceremony runs in the
   * background — if the user ignores the autofill prompt, nothing happens
   * and the regular identifier flow still works.
   */
  async function startConditionalPasskey() {
    if (typeof window === "undefined") return;
    const PKC: {
      isConditionalMediationAvailable?: () => Promise<boolean>;
    } =
      (
        window as unknown as {
          PublicKeyCredential?: { isConditionalMediationAvailable?: () => Promise<boolean> };
        }
      ).PublicKeyCredential ?? {};
    if (typeof PKC.isConditionalMediationAvailable !== "function") return;
    try {
      const available = await PKC.isConditionalMediationAvailable();
      if (!available) return;
      const beginResult = (await client.passkeyBegin()) as {
        options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
        challengeId?: string;
      };
      if (!beginResult.challengeId) return;
      const assertion = await startAuthentication({
        optionsJSON: beginResult.options,
        useBrowserAutofill: true,
      });
      const { session } = await client.passkeyComplete({
        challengeId: beginResult.challengeId,
        assertion,
      });
      await finishWithSession(session);
    } catch {
      // Silent fail — conditional UI is opportunistic. A real failure
      // surfaces when the user submits via the form.
    }
  }

  onMount(() => {
    if (webauthnSupported()) void startConditionalPasskey();
  });

  return (
    <div class="mx-auto max-w-sm px-4 py-8">
      <div class="mb-6 flex items-center justify-between">
        <h2 class="text-foreground text-2xl font-bold">
          {view() === "recovery" ? "Recover your account" : "Sign in to OSN"}
        </h2>
        <Show when={props.onCancel}>
          <Button variant="ghost" size="sm" onClick={props.onCancel}>
            Cancel
          </Button>
        </Show>
      </div>

      <Show when={signedIn()}>
        <p class="text-muted-foreground text-sm">You&apos;re all set.</p>
      </Show>

      {/* Primary WebAuthn flow */}
      <Show when={!signedIn() && view() === "passkey" && webauthnSupported()}>
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
            {busy() ? "Verifying…" : "Continue"}
          </Button>
          <button
            type="button"
            onClick={() => setView("recovery")}
            class="text-primary self-start text-sm font-medium hover:underline"
          >
            Lost your passkey?
          </button>
        </form>
      </Show>

      {/* No WebAuthn support in this environment */}
      <Show when={!signedIn() && view() === "passkey" && !webauthnSupported()}>
        <div class="flex flex-col gap-4">
          <p class="text-muted-foreground text-sm">
            OSN sign-in needs a passkey or security key, and this browser doesn&apos;t support
            WebAuthn. You can either:
          </p>
          <ul class="text-muted-foreground list-inside list-disc text-sm">
            <li>Sign in on a device that does (iOS 16+, Android 9+, recent desktop browsers).</li>
            <li>
              Use your phone via the QR / Bluetooth cross-device flow offered by your password
              manager on next try.
            </li>
            <li>Plug in a FIDO2 security key and reload the page.</li>
          </ul>
          <Button type="button" variant="secondary" onClick={() => setView("recovery")}>
            Use a recovery code instead
          </Button>
        </div>
      </Show>

      {/* Recovery escape hatch */}
      <Show when={!signedIn() && view() === "recovery"}>
        <RecoveryLoginForm
          client={props.recoveryClient}
          onSuccess={() => {
            setSignedIn(true);
            props.onSuccess?.();
          }}
          onCancel={() => setView("passkey")}
        />
      </Show>

      <Show when={error()}>
        <p class="text-destructive mt-3 text-xs">{error()}</p>
      </Show>
    </div>
  );
}
