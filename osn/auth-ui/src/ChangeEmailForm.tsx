import {
  describeAuthError,
  type AccountClient,
  type EmailChangeRequest,
  type StepUpClient,
  type StepUpToken,
} from "@osn/client";
import { Button } from "@shared/ui/ui/button";
import { Field, type FieldControlProps } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { Notice } from "@shared/ui/ui/notice";
import { createSignal, createUniqueId, Show } from "solid-js";

import { CheckEmailView, type CheckEmailStatus } from "./CheckEmailView";
import { describedBy, fieldError, type FieldError } from "./error-lines";
import { createLinkPoll, type LinkPollStep } from "./link-poll";
import { StepUpDialog, type RunPasskeyCeremony } from "./StepUpDialog";

/**
 * Settings-panel surface for changing the account email:
 *   1. Enter the new address → a link is mailed there.
 *   2. Wait (`CheckEmailView`) while the link is confirmed, on any device,
 *      with the number this panel shows.
 *   3. Confirm it's you (`StepUpDialog`, purpose `email_change`: a passkey or
 *      a link to the CURRENT address) → the email swaps and every other
 *      session is revoked.
 *
 * A sensitive action because an email change downstream controls account
 * recovery: a stolen access token alone must not be enough to pivot into
 * permanent takeover. The claim secret and the number live in memory only.
 */
export interface ChangeEmailFormProps {
  accountClient: AccountClient;
  stepUpClient: StepUpClient;
  /** Fires after a successful email swap with the new address. */
  onChanged?: (newEmail: string) => void;
  /** Forwarded to the step-up dialog so passkeys work when available. */
  runPasskeyCeremony?: RunPasskeyCeremony;
}

type Phase = "enter_email" | "check_email" | "step_up" | "finishing" | "done";

/**
 * Seconds before Resend unlocks. A mailbox gets three resent links a day
 * (`osn/api/src/services/auth/constants.ts`); at the 30-second default a
 * person would spend them in under two minutes.
 */
const RESEND_WAIT_SECONDS = 120;

const LIMIT_LINE =
  "We've sent all the links we can for this request. Use the newest one, or start again.";
const RESEND_FAILED_LINE = "We couldn't send a new link just now. Try again in a moment.";

export function ChangeEmailForm(props: ChangeEmailFormProps) {
  const [phase, setPhase] = createSignal<Phase>("enter_email");
  const [newEmail, setNewEmail] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  // The address phase's line sits under its field, tied to it.
  const [error, setError] = createSignal<FieldError | null>(null);
  const errorId = createUniqueId();
  const [request, setRequest] = createSignal<EmailChangeRequest | null>(null);
  const [pairingCode, setPairingCode] = createSignal<string | undefined>(undefined);
  const [linkStatus, setLinkStatus] = createSignal<CheckEmailStatus>("waiting");
  const [linkError, setLinkError] = createSignal<string | undefined>(undefined);
  const linkPoll = createLinkPoll(pollLink);

  /** A new request to the address typed, with its own number, and the wait on it. */
  async function sendLink() {
    const begun = await props.accountClient.changeEmailBegin({ newEmail: newEmail() });
    setRequest(begun);
    setPairingCode(begun.pairingCode);
    setLinkError(undefined);
    setLinkStatus("waiting");
    linkPoll.start();
  }

  async function begin() {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await sendLink();
      setPhase("check_email");
    } catch (e) {
      setError(fieldError(describeAuthError(e, "details"), e));
    } finally {
      setBusy(false);
    }
  }

  /** One poll: still waiting, gone, or confirmed — then on to the step-up. */
  async function pollLink(): Promise<LinkPollStep> {
    const current = request();
    if (!current) return "stop";
    const answer = await props.accountClient.changeEmailStatus({
      requestId: current.requestId,
      claimSecret: current.claimSecret,
    });
    if (request() !== current) return "stop";
    if (answer.status === "pending") {
      if (answer.pairingCode !== undefined) setPairingCode(answer.pairingCode);
      return "wait";
    }
    if (answer.status === "confirmed") {
      setPhase("step_up");
      return "stop";
    }
    setLinkStatus("expired");
    return "stop";
  }

  /**
   * Resend in the waiting view. A live request gets another link of its own;
   * an expired one is replaced by a new request, with a new number. A
   * rejection is how the view learns that no new link went.
   */
  async function resendLink() {
    const current = request();
    if (!current) return;
    if (linkStatus() === "expired") {
      try {
        await sendLink();
      } catch (err) {
        setLinkError(RESEND_FAILED_LINE);
        setLinkStatus("error");
        throw err;
      }
      return;
    }
    setLinkStatus("waiting");
    setLinkError(undefined);
    let answer: { status: "sent" | "limit" | "expired" };
    try {
      answer = await props.accountClient.changeEmailResend({
        requestId: current.requestId,
        claimSecret: current.claimSecret,
      });
    } catch (err) {
      setLinkError(RESEND_FAILED_LINE);
      setLinkStatus("error");
      throw err;
    }
    if (answer.status === "sent") {
      linkPoll.start();
      return;
    }
    if (answer.status === "limit") {
      setLinkError(LIMIT_LINE);
      setLinkStatus("error");
      throw new Error(LIMIT_LINE);
    }
    linkPoll.stop();
    setLinkStatus("expired");
    throw new Error("The link expired");
  }

  /** Back to the address, kept. The request is left to expire. */
  function changeAddress() {
    linkPoll.stop();
    setRequest(null);
    setPairingCode(undefined);
    setError(null);
    setPhase("enter_email");
  }

  async function complete(stepUp: StepUpToken) {
    const current = request();
    if (!current) return;
    setPhase("finishing");
    setBusy(true);
    try {
      const result = await props.accountClient.changeEmailComplete({
        requestId: current.requestId,
        claimSecret: current.claimSecret,
        stepUpToken: stepUp.token,
      });
      setRequest(null);
      setPairingCode(undefined);
      setNewEmail(result.email);
      setPhase("done");
      props.onChanged?.(result.email);
    } catch (e) {
      // Back to the wait: the poll says whether the request can still be
      // completed (a step-up again) or is spent (a new link).
      setLinkError(describeAuthError(e));
      setLinkStatus("error");
      setPhase("check_email");
      linkPoll.start();
    } finally {
      setBusy(false);
    }
  }

  /** The address phase's error line, under its field. */
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
   * For the address field: its id, the field's own description, then the
   * line, and a mark on a refused input.
   */
  const tie = (field: FieldControlProps) => ({
    id: field.id,
    "aria-describedby": describedBy(field["aria-describedby"], error() && errorId),
    "aria-invalid": error()?.invalid || undefined,
  });

  return (
    <div class="flex flex-col gap-3">
      <h2 class="text-ui-ink text-ui-md font-ui-title">Change email</h2>

      <Show when={phase() === "enter_email"}>
        <Field labelTreatment="plain" label="New email">
          {(field) => (
            <>
              <Input
                type="email"
                autocomplete="email"
                value={newEmail()}
                onInput={(e) => setNewEmail(e.currentTarget.value)}
                {...tie(field)}
              />
              {errorLine()}
            </>
          )}
        </Field>
        <Button onClick={begin} busy={busy()} disabled={!busy() && !newEmail()}>
          {busy() ? "Sending…" : "Send a link"}
        </Button>
      </Show>

      {/* Mounted inside the panel that is already open, so the view's heading
          keeps the focus it takes. */}
      <Show when={phase() === "check_email"}>
        <CheckEmailView
          purpose="email-change"
          email={newEmail()}
          status={linkStatus()}
          errorMessage={linkError()}
          pairingCode={pairingCode()}
          resendWaitSeconds={RESEND_WAIT_SECONDS}
          onResend={resendLink}
          onChangeEmail={changeAddress}
        />
      </Show>

      <Show when={phase() === "step_up"}>
        <StepUpDialog
          client={props.stepUpClient}
          runPasskeyCeremony={props.runPasskeyCeremony}
          purpose="email_change"
          reason="to change your email"
          onToken={(tok) => void complete(tok)}
          onCancel={changeAddress}
        />
      </Show>

      <Show when={phase() === "finishing"}>
        <p class="text-ui-sm leading-ui-snug text-ui-ink-secondary" aria-live="polite">
          Changing your email…
        </p>
      </Show>

      <Show when={phase() === "done"}>
        <p class="text-ui-sm leading-ui-snug text-ui-ink">Your email is now {newEmail()}.</p>
      </Show>
    </div>
  );
}
