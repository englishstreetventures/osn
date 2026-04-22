import type { StepUpClient, StepUpToken } from "@osn/client";
import { createSignal, Show } from "solid-js";

import { Button } from "../components/ui/button";

/**
 * Modal that drives the step-up (sudo) ceremony and yields a short-lived
 * step-up token to the caller via `onToken`. Supports two factors:
 * passkey and OTP — the user picks whichever one is set up.
 *
 * The WebAuthn browser ceremony is performed by the caller-supplied
 * `runPasskeyCeremony` callback so this component stays free of
 * `@simplewebauthn/browser`. Pass something like:
 *
 *   runPasskeyCeremony: (options) =>
 *     startAuthentication({ optionsJSON: options as PublicKeyCredentialRequestOptionsJSON })
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
  /**
   * Executes the browser-side WebAuthn assertion. Returns the signed
   * assertion JSON (the shape `@simplewebauthn/browser`'s
   * `startAuthentication` produces).
   */
  runPasskeyCeremony?: (options: unknown) => Promise<unknown>;
}

type Mode = "choose" | "passkey" | "otp";

export function StepUpDialog(props: StepUpDialogProps) {
  const [mode, setMode] = createSignal<Mode>("choose");
  const [code, setCode] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

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
      <h2 class="text-lg font-semibold">Confirm it's you</h2>
      <p class="text-muted-foreground text-sm">
        This action needs a fresh authentication. Choose a method below.
      </p>
      <Show when={error()}>{(msg) => <p class="text-destructive text-sm">{msg()}</p>}</Show>
      <Show when={mode() === "choose"}>
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
