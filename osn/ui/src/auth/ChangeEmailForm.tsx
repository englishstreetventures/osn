import type { AccountClient, StepUpClient, StepUpToken } from "@osn/client";
import { createSignal, Show } from "solid-js";

import { Button } from "../components/ui/button";
import { StepUpDialog } from "./StepUpDialog";

/**
 * Settings-panel surface for changing the account email. Two-phase:
 *   1. Enter the new address → OTP is sent.
 *   2. Enter the OTP + complete a step-up ceremony → email swaps and
 *      every other session is revoked.
 *
 * The step-up token is obtained via the passkey/OTP dialog below. We
 * treat this as a "sensitive action" because an email change downstream
 * controls account recovery — stolen access tokens alone should not be
 * enough to pivot into permanent takeover.
 */
export interface ChangeEmailFormProps {
  accountClient: AccountClient;
  stepUpClient: StepUpClient;
  accessToken: string;
  /** Fires after a successful email swap with the new address. */
  onChanged?: (newEmail: string) => void;
  /** Forwarded to the step-up dialog so passkeys work when available. */
  runPasskeyCeremony?: (options: unknown) => Promise<unknown>;
}

type Phase = "enter_email" | "enter_code" | "step_up" | "done";

export function ChangeEmailForm(props: ChangeEmailFormProps) {
  const [phase, setPhase] = createSignal<Phase>("enter_email");
  const [newEmail, setNewEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const [stepUp, setStepUp] = createSignal<StepUpToken | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      await props.accountClient.changeEmailBegin({
        accessToken: props.accessToken,
        newEmail: newEmail(),
      });
      setPhase("enter_code");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start email change");
    } finally {
      setBusy(false);
    }
  }

  async function complete() {
    if (!stepUp()) {
      setPhase("step_up");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await props.accountClient.changeEmailComplete({
        accessToken: props.accessToken,
        code: code(),
        stepUpToken: stepUp()!.token,
      });
      setPhase("done");
      props.onChanged?.(result.email);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not complete email change");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="flex flex-col gap-3">
      <h2 class="text-lg font-semibold">Change email</h2>
      <Show when={error()}>{(msg) => <p class="text-destructive text-sm">{msg()}</p>}</Show>

      <Show when={phase() === "enter_email"}>
        <label class="flex flex-col gap-1 text-sm">
          New email
          <input
            type="email"
            class="bg-background rounded-md border px-3 py-2"
            value={newEmail()}
            onInput={(e) => setNewEmail(e.currentTarget.value)}
          />
        </label>
        <Button onClick={begin} disabled={busy() || !newEmail()}>
          Send verification code
        </Button>
      </Show>

      <Show when={phase() === "enter_code"}>
        <p class="text-muted-foreground text-sm">
          We sent a 6-digit code to {newEmail()}. Enter it below to continue.
        </p>
        <label class="flex flex-col gap-1 text-sm">
          Code
          <input
            inputmode="numeric"
            maxLength={6}
            class="bg-background rounded-md border px-3 py-2 font-mono tracking-widest"
            value={code()}
            onInput={(e) => setCode(e.currentTarget.value)}
          />
        </label>
        <Button onClick={complete} disabled={busy() || code().length !== 6}>
          Confirm identity &amp; change email
        </Button>
      </Show>

      <Show when={phase() === "step_up"}>
        <StepUpDialog
          client={props.stepUpClient}
          accessToken={props.accessToken}
          runPasskeyCeremony={props.runPasskeyCeremony}
          onToken={(tok) => {
            setStepUp(tok);
            setPhase("enter_code");
            void complete();
          }}
          onCancel={() => setPhase("enter_code")}
        />
      </Show>

      <Show when={phase() === "done"}>
        <p class="text-sm">Your email is now {newEmail()}.</p>
      </Show>
    </div>
  );
}
