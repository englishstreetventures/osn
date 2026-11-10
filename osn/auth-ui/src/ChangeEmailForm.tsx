import {
  describeAuthError,
  type AccountClient,
  type StepUpClient,
  type StepUpToken,
} from "@osn/client";
import { Button } from "@shared/ui/ui/button";
import { Field, type FieldControlProps } from "@shared/ui/ui/field";
import { Notice } from "@shared/ui/ui/notice";
import { createSignal, createUniqueId, Show } from "solid-js";

import { describedBy, fieldError, type FieldError } from "./error-lines";
import { StepUpDialog, type RunPasskeyCeremony } from "./StepUpDialog";

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
  /** Fires after a successful email swap with the new address. */
  onChanged?: (newEmail: string) => void;
  /** Forwarded to the step-up dialog so passkeys work when available. */
  runPasskeyCeremony?: RunPasskeyCeremony;
}

type Phase = "enter_email" | "enter_code" | "step_up" | "done";

export function ChangeEmailForm(props: ChangeEmailFormProps) {
  const [phase, setPhase] = createSignal<Phase>("enter_email");
  const [newEmail, setNewEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const [stepUp, setStepUp] = createSignal<StepUpToken | null>(null);
  const [busy, setBusy] = createSignal(false);
  // Each phase's line sits under its one field, tied to it.
  const [error, setError] = createSignal<FieldError | null>(null);
  const errorId = createUniqueId();

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      await props.accountClient.changeEmailBegin({
        newEmail: newEmail(),
      });
      setPhase("enter_code");
    } catch (e) {
      setError(fieldError(describeAuthError(e, "details"), e));
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
        code: code(),
        stepUpToken: stepUp()!.token,
      });
      setPhase("done");
      props.onChanged?.(result.email);
    } catch (e) {
      setError(fieldError(describeAuthError(e, "code"), e));
    } finally {
      setBusy(false);
    }
  }

  /** The phase's error line, under its field. */
  const errorLine = () => (
    <Show when={error()}>
      {(line) => (
        <Notice tone="danger" size="inline" alert id={errorId}>
          {line().text}
        </Notice>
      )}
    </Show>
  );
  /**
   * For the phase's field: its id, the field's own description, then the
   * line, and a mark on a refused input.
   */
  const tie = (field: FieldControlProps) => ({
    id: field.id,
    "aria-describedby": describedBy(field["aria-describedby"], error() && errorId),
    "aria-invalid": error()?.invalid || undefined,
  });

  return (
    <div class="flex flex-col gap-3">
      <h2 class="text-lg font-semibold">Change email</h2>

      <Show when={phase() === "enter_email"}>
        <Field labelTreatment="plain" label="New email">
          {(field) => (
            <>
              <input
                type="email"
                class="bg-background aria-[invalid=true]:border-ui-danger rounded-md border px-3 py-2"
                value={newEmail()}
                onInput={(e) => setNewEmail(e.currentTarget.value)}
                {...tie(field)}
              />
              {errorLine()}
            </>
          )}
        </Field>
        <Button onClick={begin} disabled={busy() || !newEmail()}>
          Send verification code
        </Button>
      </Show>

      <Show when={phase() === "enter_code"}>
        <p class="text-muted-foreground text-sm">
          We sent a 6-digit code to {newEmail()}. Enter it below to continue.
        </p>
        <Field labelTreatment="plain" label="Code">
          {(field) => (
            <>
              <input
                inputmode="numeric"
                maxLength={6}
                class="bg-background aria-[invalid=true]:border-ui-danger rounded-md border px-3 py-2 font-mono tracking-widest"
                value={code()}
                onInput={(e) => setCode(e.currentTarget.value)}
                {...tie(field)}
              />
              {errorLine()}
            </>
          )}
        </Field>
        <Button onClick={complete} disabled={busy() || code().length !== 6}>
          Confirm identity &amp; change email
        </Button>
      </Show>

      <Show when={phase() === "step_up"}>
        <StepUpDialog
          client={props.stepUpClient}
          runPasskeyCeremony={props.runPasskeyCeremony}
          purpose="email_change"
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
