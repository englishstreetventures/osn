import {
  describeAuthError,
  type StepUpClient,
  type StepUpEmailRequest,
  type StepUpPurpose,
  type StepUpToken,
  type TotpClient,
} from "@osn/client";
import { Button } from "@shared/ui/ui/button";
import { labelVariants } from "@shared/ui/ui/label";
import { Notice } from "@shared/ui/ui/notice";
import { OtpInput } from "@shared/ui/ui/otp-input";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";
import { createResource, createSignal, createUniqueId, onCleanup, onMount, Show } from "solid-js";

import { CheckEmailView, type CheckEmailStatus } from "./CheckEmailView";
import { describedBy, fieldError, inputError, plainError, type FieldError } from "./error-lines";
import { createLinkPoll, type LinkPollStep } from "./link-poll";
import { describePasskeyError } from "./passkey-errors";

/**
 * Runs the browser-side WebAuthn assertion and resolves with the signed
 * assertion — the exact JSON `@simplewebauthn/browser`'s `startAuthentication`
 * produces, which the OSN API expects verbatim at
 * `/step-up/passkey/complete`. Nothing in `@osn/auth-ui` reads a field off it; it
 * is forwarded whole.
 *
 * The ceremony itself stays caller-side (this package imports the response
 * types, not the runtime) so hosts can wire their own WebAuthn wrapper.
 *
 * `options` is the standard lib.dom `PublicKeyCredentialRequestOptionsJSON`,
 * exactly what `StepUpClient.passkeyBegin` resolves with. Nothing in `@osn/auth-ui`
 * reads a field off it — it is forwarded whole — but naming the shape keeps
 * every host from asserting its way out of `unknown` at the call site.
 */
export type RunPasskeyCeremony = (
  options: PublicKeyCredentialRequestOptionsJSON,
) => Promise<AuthenticationResponseJSON>;

/**
 * Enrolment counterpart of {@link RunPasskeyCeremony}: runs the WebAuthn
 * attestation ceremony and resolves with the attestation JSON
 * `startRegistration` produces, forwarded whole to `/passkeys/register/complete`.
 */
export type RunPasskeyRegistration = (
  options: PublicKeyCredentialCreationOptionsJSON,
) => Promise<RegistrationResponseJSON>;

/**
 * Which factors the server will accept for each ceremony.
 *
 * A step-up token records the factor that minted it as an AMR value, and the
 * gated endpoint checks that value against an allow-list. Offering a factor
 * the allow-list refuses is not a smaller menu — it is a dead end: the
 * ceremony succeeds, a token is minted, and the call it was minted for fails.
 * So the dialog offers a factor only where the purpose admits it.
 *
 * A passkey (`webauthn`) is admitted everywhere and is therefore not listed.
 *
 * This mirrors the **defaults** in `osn/api/src/services/auth/context.ts`
 * (`recoveryGenerateAllowedAmr`, `passkeyRegisterAllowedAmr`,
 * `passkeyDeleteAllowedAmr`, `emailChangeAllowedAmr`). Three of those four are
 * `AuthConfig` fields, so a deployment that narrows one reintroduces the dead
 * end here; no deployment sets them today.
 *
 * The two `false` entries each have a reason worth keeping:
 * `passkey_delete` (which gates rename as well) stays WebAuthn-only because
 * the caller necessarily holds a passkey already, so requiring one costs
 * nothing; `email_change` admits the emailed link because it proves control of
 * the current mailbox, which an authenticator seed does not.
 */
const PURPOSE_FACTORS = {
  recovery_generate: { email: true, totp: true },
  security_event_ack: { email: true, totp: true },
  account_delete: { email: true, totp: true },
  account_export: { email: true, totp: true },
  pulse_app_delete: { email: true, totp: true },
  zap_app_delete: { email: true, totp: true },
  passkey_register: { email: true, totp: true },
  totp_enroll: { email: true, totp: true },
  totp_disable: { email: true, totp: true },
  passkey_delete: { email: false, totp: false },
  email_change: { email: true, totp: false },
  // `satisfies` rather than an annotation: it still fails to compile when a
  // new `StepUpPurpose` is added without a row here, which is the whole point
  // of the table, but keeps the literal's own types.
} satisfies Record<StepUpPurpose, { email: boolean; totp: boolean }>;

/**
 * Seconds before Resend unlocks. A mailbox gets three resent step-up links a
 * day (`osn/api/src/services/auth/constants.ts`); at the 30-second default a
 * person would spend them in under two minutes.
 */
const RESEND_WAIT_SECONDS = 120;

const LIMIT_LINE =
  "We've sent all the links we can for this request. Use the newest one, or cancel and start again.";
const RESEND_FAILED_LINE = "We couldn't send a new link just now. Try again in a moment.";

/**
 * Modal that drives the step-up (sudo) ceremony and yields a short-lived
 * step-up token to the caller via `onToken`. Three factors: passkey, a link
 * emailed to the account's own address, and an authenticator app. Which of
 * them appear depends on the ceremony (see {@link PURPOSE_FACTORS}) and on
 * what the account has set up.
 *
 * The emailed link swaps the factors for `CheckEmailView` inside this panel:
 * the number to type on the link's page, Resend, and Cancel. This panel polls
 * until the link is confirmed, on this device or another, and hands the token
 * to `onToken`. The claim secret and the number live in memory only.
 */
export interface StepUpDialogProps {
  client: StepUpClient;
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
   * TOTP client, for the "enter a code from your authenticator app" factor.
   * Omit it and that factor is never offered.
   *
   * The dialog asks `GET /totp/status` itself rather than taking a boolean,
   * so a host cannot wire the client and the flag inconsistently and end up
   * offering a factor the account has not set up. A failed status read leaves
   * the factor hidden and never blocks the other two.
   */
  totpClient?: TotpClient;
  /**
   * **The host cannot deliver mail**: suppress the emailed-link factor and
   * drive the passkey ceremony directly. With this set the dialog auto-starts
   * the passkey ceremony on mount and offers a retry on failure, and the
   * "choose a method" helper line goes with the factor picker.
   *
   * It suppresses the emailed link and **nothing else**. An authenticator app
   * needs no delivery, so it cannot fail the way this prop exists to prevent,
   * and it stays on offer wherever the ceremony and the account allow it —
   * which is why the name is not the whole story and this paragraph is here.
   * Where no authenticator is enrolled the dialog really is passkey-only, the
   * state the name was written for.
   *
   * @see wiki/osn/passkey-primary.md — the settled meaning, and why the
   * prop was not renamed.
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
   * one action can't be replayed at another. The emailed link is fixed to one
   * purpose when it is sent, so without a purpose it is not offered.
   */
  purpose?: StepUpPurpose;
}

type Mode = "choose" | "passkey" | "email" | "totp";

export function StepUpDialog(props: StepUpDialogProps) {
  const [mode, setMode] = createSignal<Mode>(props.passkeyOnly ? "passkey" : "choose");
  const [code, setCode] = createSignal("");
  // The call under way, so only the button that started it shows the wait.
  const [waiting, setWaiting] = createSignal<"passkey" | "emailBegin" | "totp" | null>(null);
  const busy = () => waiting() !== null;
  // On the two code steps the line sits under the code field and is tied to
  // it; on the others, above the factor buttons.
  const [error, setError] = createSignal<FieldError | null>(null);
  const errorId = createUniqueId();
  const codeLabelId = createUniqueId();
  const onCodeStep = () => mode() === "totp";

  // The link for the email factor, in memory only: whoever holds the claim
  // secret gets the token.
  const [link, setLink] = createSignal<StepUpEmailRequest | null>(null);
  const [pairingCode, setPairingCode] = createSignal<string | undefined>(undefined);
  const [linkStatus, setLinkStatus] = createSignal<CheckEmailStatus>("waiting");
  const [linkError, setLinkError] = createSignal<string | undefined>(undefined);
  const linkPoll = createLinkPoll(pollLink);
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  // An unbound ceremony names no purpose, so there is no allow-list to look
  // up: the emailed link, which is fixed to one purpose, is not offered.
  const factors = () =>
    props.purpose === undefined ? { email: false, totp: true } : PURPOSE_FACTORS[props.purpose];

  const [totpStatus] = createResource(
    () => props.totpClient,
    async (client: TotpClient) => {
      try {
        return await client.status();
      } catch {
        // Whether an authenticator exists is not worth failing a ceremony
        // over — the user still has a passkey, and may still have email.
        return null;
      }
    },
  );

  // `state` first, never `totpStatus()`: a loading resource read in a
  // component joins its host's Suspense boundary, and Settings would swap the
  // whole tab, this dialog included, for its fallback until the status lands.
  const totp = () => (totpStatus.state === "ready" ? totpStatus.latest : undefined);
  const totpOffered = () => factors().totp && totp()?.enrolled === true;
  const emailOffered = () => factors().email && !props.passkeyOnly;

  // Passkey-only contexts skip the factor picker — kick the ceremony off as
  // soon as the dialog mounts so the user lands straight on the platform
  // authenticator prompt.
  onMount(() => {
    if (props.passkeyOnly) void startPasskey();
  });

  async function startPasskey() {
    if (busy()) return;
    if (!props.runPasskeyCeremony) {
      // Retrying cannot help here, so the line offers no retry.
      setError(plainError("A passkey can't be used here."));
      return;
    }
    setWaiting("passkey");
    setError(null);
    try {
      const begin = await props.client.passkeyBegin();
      const assertion = await props.runPasskeyCeremony(begin.options);
      const token = await props.client.passkeyComplete({
        assertion,
        purpose: props.purpose,
      });
      props.onToken(token);
    } catch (e) {
      setError(plainError(describePasskeyError(e, "authentication")));
    } finally {
      setWaiting(null);
    }
  }

  /** Sends a new link (a new request, with its own number) and waits on it. */
  async function sendLink(purpose: StepUpPurpose) {
    const begun = await props.client.emailBegin({ purpose });
    setLink(begun);
    setPairingCode(begun.pairingCode);
    setLinkError(undefined);
    setLinkStatus("waiting");
    linkPoll.start();
  }

  async function startEmail() {
    const purpose = props.purpose;
    if (busy() || purpose === undefined) return;
    setWaiting("emailBegin");
    setError(null);
    try {
      await sendLink(purpose);
      setMode("email");
    } catch (e) {
      setError(plainError(describeAuthError(e)));
    } finally {
      setWaiting(null);
    }
  }

  /**
   * One poll of the link this panel waits on. Any answer about a request this
   * panel no longer waits on — cancelled, gone, or replaced by a new one — is
   * dropped, a token included: the person said stop, and a token nobody
   * presents expires unused.
   */
  async function pollLink(): Promise<LinkPollStep> {
    const request = link();
    if (!request) return "stop";
    const answer = await props.client.emailStatus({
      requestId: request.requestId,
      claimSecret: request.claimSecret,
    });
    if (disposed || link() !== request) return "stop";
    if (answer.status === "complete") {
      setLink(null);
      setPairingCode(undefined);
      props.onToken(answer.token);
      return "stop";
    }
    if (answer.status === "pending") {
      if (answer.pairingCode !== undefined) setPairingCode(answer.pairingCode);
      return "wait";
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
    const request = link();
    const purpose = props.purpose;
    if (!request || purpose === undefined) return;
    if (linkStatus() === "expired") {
      try {
        await sendLink(purpose);
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
      answer = await props.client.emailResend({
        requestId: request.requestId,
        claimSecret: request.claimSecret,
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

  function cancelEmail() {
    setLink(null);
    linkPoll.stop();
    setPairingCode(undefined);
    props.onCancel();
  }

  function startTotp() {
    // No `begin` half: TOTP is challenge-free, so there is nothing for the
    // server to mint, park or send. `GET /totp/status` already answered the
    // only question — whether the factor exists at all.
    setError(null);
    setCode("");
    setMode("totp");
  }

  async function completeTotp() {
    if (busy()) return;
    if (code().length !== 6) {
      setError(inputError("Enter the 6-digit code."));
      return;
    }
    setWaiting("totp");
    setError(null);
    try {
      const token = await props.client.totpComplete({
        code: code(),
        purpose: props.purpose,
      });
      props.onToken(token);
    } catch (e) {
      setError(fieldError(describeAuthError(e, "code"), e));
    } finally {
      setWaiting(null);
    }
  }

  /** The error line, wherever the step on screen draws it. */
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
   * The code step's row of boxes under the span `label` names, described by
   * the line and marked invalid (`error`) only on a refused code. Focus lands
   * in box 1 as the step opens.
   */
  const codeRow = (label: string) => (
    <div class="flex flex-col gap-1.5">
      <span class={labelVariants()} id={codeLabelId}>
        {label}
      </span>
      <OtpInput
        value={code()}
        onChange={setCode}
        status={error()?.invalid ? "error" : busy() ? "verifying" : "idle"}
        autofocus
        aria-labelledby={codeLabelId}
        aria-describedby={describedBy(error() && errorId)}
      />
      {errorLine()}
    </div>
  );

  // It draws no edge, so its side padding only indents it; below `md` it
  // drops, and a code step's row takes its host's whole column.
  return (
    <div class="flex flex-col gap-3 p-4 max-md:px-0">
      <h2 class="text-lg font-semibold">{props.title ?? "Confirm it's you"}</h2>
      <Show when={props.reason}>
        {(reason) => <p class="text-muted-foreground text-sm">Re-authenticate {reason()}.</p>}
      </Show>
      {/* Passkey-only mode has no factor picker, so the "choose a method"
          helper line would be misleading — the ceremony auto-starts. The
          email wait has chosen already. */}
      <Show when={!props.passkeyOnly && mode() !== "email"}>
        <p class="text-muted-foreground text-sm">
          This action needs a fresh authentication. Choose a method below.
        </p>
      </Show>
      {/* A step-up failure is the reason the user cannot proceed, so it is
          announced rather than left for them to notice. */}
      <Show when={!onCodeStep()}>{errorLine()}</Show>
      <Show when={!props.passkeyOnly && mode() === "choose"}>
        <div class="flex flex-col gap-2">
          <Button
            onClick={startPasskey}
            busy={waiting() === "passkey"}
            disabled={busy() && waiting() !== "passkey"}
          >
            {waiting() === "passkey" ? "Waiting for your passkey…" : "Use passkey"}
          </Button>
          <Show when={emailOffered()}>
            <Button
              variant="outline"
              onClick={startEmail}
              busy={waiting() === "emailBegin"}
              disabled={busy() && waiting() !== "emailBegin"}
            >
              {waiting() === "emailBegin" ? "Sending…" : "Use email instead"}
            </Button>
          </Show>
          <Show when={totpOffered()}>
            <Button variant="outline" onClick={startTotp} disabled={busy()}>
              Use your authenticator app
            </Button>
          </Show>
          <Button variant="ghost" onClick={props.onCancel} disabled={busy()}>
            Cancel
          </Button>
        </div>
      </Show>
      <Show when={props.passkeyOnly && mode() === "passkey"}>
        <div class="flex flex-col gap-2">
          <Show when={busy()}>
            <p class="text-muted-foreground text-sm" aria-live="polite">
              Waiting for your passkey…
            </p>
          </Show>
          <Show when={!busy()}>
            <Button onClick={startPasskey}>
              {error() && props.runPasskeyCeremony ? "Try again" : "Use passkey"}
            </Button>
          </Show>
          {/* An authenticator code needs no delivery, so it survives the
              no-mail mode this dialog was put in. */}
          <Show when={totpOffered()}>
            <Button variant="outline" onClick={startTotp} disabled={busy()}>
              Use your authenticator app
            </Button>
          </Show>
          <Button variant="ghost" onClick={props.onCancel} disabled={busy()}>
            Cancel
          </Button>
        </div>
      </Show>
      {/* Mounted inside the panel that is already open, so the view's heading
          keeps the focus it takes. */}
      <Show when={mode() === "email"}>
        <div class="flex flex-col gap-2">
          <CheckEmailView
            purpose="step-up"
            status={linkStatus()}
            errorMessage={linkError()}
            pairingCode={pairingCode()}
            resendWaitSeconds={RESEND_WAIT_SECONDS}
            onResend={resendLink}
          />
          <Button variant="ghost" onClick={cancelEmail}>
            Cancel
          </Button>
        </div>
      </Show>
      <Show when={mode() === "totp"}>
        <div class="flex flex-col gap-2">
          {codeRow("Code from your authenticator app")}
          <Button onClick={completeTotp} busy={busy()}>
            {busy() ? "Checking…" : "Confirm"}
          </Button>
          <Button variant="ghost" onClick={props.onCancel} disabled={busy()}>
            Cancel
          </Button>
        </div>
      </Show>
    </div>
  );
}
