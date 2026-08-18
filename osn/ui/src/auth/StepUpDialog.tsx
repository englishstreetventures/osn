import type { StepUpClient, StepUpPurpose, StepUpToken } from "@osn/client";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";
import { createSignal, onMount, Show } from "solid-js";

import { Button } from "../components/ui/button";

/**
 * Runs the browser-side WebAuthn assertion and resolves with the signed
 * assertion — the exact JSON `@simplewebauthn/browser`'s `startAuthentication`
 * produces, which the OSN API expects verbatim at
 * `/step-up/passkey/complete`. Nothing in `@osn/ui` reads a field off it; it
 * is forwarded whole.
 *
 * The ceremony itself stays caller-side (this package imports the response
 * types, not the runtime) so hosts can wire their own WebAuthn wrapper. Pass
 * something like:
 *
 *   runPasskeyCeremony: (options) =>
 *     startAuthentication({ optionsJSON: options as PublicKeyCredentialRequestOptionsJSON })
 *
 * `options` stays `unknown` because it is whatever `StepUpClient.passkeyBegin`
 * returned: the challenge is minted and parsed by the server and the caller's
 * WebAuthn library respectively, never by this package.
 */
export type RunPasskeyCeremony = (options: unknown) => Promise<AuthenticationResponseJSON>;

/**
 * Enrolment counterpart of {@link RunPasskeyCeremony}: runs the WebAuthn
 * attestation ceremony and resolves with the attestation JSON
 * `startRegistration` produces, forwarded whole to `/passkeys/register/complete`.
 */
export type RunPasskeyRegistration = (options: unknown) => Promise<RegistrationResponseJSON>;

/**
 * Modal that drives the step-up (sudo) ceremony and yields a short-lived
 * step-up token to the caller via `onToken`. Supports two factors:
 * passkey and OTP — the user picks whichever one is set up.
 */
export interface StepUpDialogProps {
  client: StepUpClient;
  accessToken: string;
  /**
   * Fires as soon as a step-up token is successfully minted. The caller
   * should close the dialog and proceed with the gated action.
   */
  onToken: (token: StepUpToken) => void;
  /** Called when the user cancels the ceremony without completing it. */
  onCancel: () => void;
  /** Executes the browser-side WebAuthn assertion. */
  runPasskeyCeremony?: RunPasskeyCeremony;
  /**
   * Passkey-only mode: suppress the OTP ("email me a code") factor entirely
   * and drive the passkey ceremony directly. Set this for accounts whose host
   * has no deliverable transactional email, so offering OTP would send the
   * user down a dead-end path that never receives a code. With this set the
   * dialog auto-starts the passkey ceremony on mount and offers a retry on
   * failure — and, with no factor picker, the "choose a method" helper line is
   * suppressed too.
   */
  passkeyOnly?: boolean;
  /**
   * Optional heading override. Defaults to "Confirm it's you".
   */
  title?: string;
  /**
   * Optional one-liner explaining WHY re-authentication is needed (e.g.
   * "to generate recovery codes"). Rendered under the heading so the user
   * isn't asked to re-auth without context.
   */
  reason?: string;
  /**
   * Ceremony the minted token is for. Endpoints that name a purpose reject
   * tokens minted for a different one, so a token this dialog produces for
   * one action can't be replayed at another.
   */
  purpose?: StepUpPurpose;
}

type Mode = "choose" | "passkey" | "otp";

export function StepUpDialog(props: StepUpDialogProps) {
  const [mode, setMode] = createSignal<Mode>(props.passkeyOnly ? "passkey" : "choose");
  const [code, setCode] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Passkey-only contexts skip the factor picker — kick the ceremony off as
  // soon as the dialog mounts so the user lands straight on the platform
  // authenticator prompt.
  onMount(() => {
    if (props.passkeyOnly) void startPasskey();
  });

  async function startPasskey() {
    if (!props.runPasskeyCeremony) {
      setError("Passkey ceremony not available in this context");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const begin = await props.client.passkeyBegin({ accessToken: props.accessToken });
      const assertion = await props.runPasskeyCeremony(begin.options);
      const token = await props.client.passkeyComplete({
        accessToken: props.accessToken,
        assertion,
        purpose: props.purpose,
      });
      props.onToken(token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Step-up failed");
    } finally {
      setBusy(false);
    }
  }

  async function startOtp() {
    setBusy(true);
    setError(null);
    try {
      await props.client.otpBegin({ accessToken: props.accessToken });
      setMode("otp");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send code");
    } finally {
      setBusy(false);
    }
  }

  async function completeOtp() {
    if (code().length !== 6) {
      setError("Enter the 6-digit code");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = await props.client.otpComplete({
        accessToken: props.accessToken,
        code: code(),
        purpose: props.purpose,
      });
      props.onToken(token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid or expired code");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="flex flex-col gap-3 p-4">
      <h2 class="text-lg font-semibold">{props.title ?? "Confirm it's you"}</h2>
      <Show when={props.reason}>
        {(reason) => <p class="text-muted-foreground text-sm">Re-authenticate {reason()}.</p>}
      </Show>
      {/* Passkey-only mode has no factor picker, so the "choose a method"
          helper line would be misleading — the ceremony auto-starts. */}
      <Show when={!props.passkeyOnly}>
        <p class="text-muted-foreground text-sm">
          This action needs a fresh authentication. Choose a method below.
        </p>
      </Show>
      <Show when={error()}>{(msg) => <p class="text-destructive text-sm">{msg()}</p>}</Show>
      <Show when={!props.passkeyOnly && mode() === "choose"}>
        <div class="flex flex-col gap-2">
          <Button onClick={startPasskey} disabled={busy()}>
            Use passkey
          </Button>
          <Button variant="outline" onClick={startOtp} disabled={busy()}>
            Email me a code
          </Button>
          <Button variant="ghost" onClick={props.onCancel} disabled={busy()}>
            Cancel
          </Button>
        </div>
      </Show>
      <Show when={props.passkeyOnly}>
        <div class="flex flex-col gap-2">
          <Show when={busy()}>
            <p class="text-muted-foreground text-sm" aria-live="polite">
              Waiting for your passkey…
            </p>
          </Show>
          <Show when={!busy()}>
            <Button onClick={startPasskey}>{error() ? "Try again" : "Use passkey"}</Button>
          </Show>
          <Button variant="ghost" onClick={props.onCancel} disabled={busy()}>
            Cancel
          </Button>
        </div>
      </Show>
      <Show when={mode() === "otp"}>
        <div class="flex flex-col gap-2">
          <label class="flex flex-col gap-1 text-sm">
            Code
            <input
              class="bg-background rounded-md border px-3 py-2 font-mono tracking-widest"
              inputmode="numeric"
              maxLength={6}
              value={code()}
              onInput={(e) => setCode(e.currentTarget.value)}
            />
          </label>
          <Button onClick={completeOtp} disabled={busy()}>
            Confirm
          </Button>
          <Button variant="ghost" onClick={props.onCancel} disabled={busy()}>
            Cancel
          </Button>
        </div>
      </Show>
    </div>
  );
}
