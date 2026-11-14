import {
  describeAuthError,
  type StepUpClient,
  type StepUpEmailRequest,
  type StepUpPurpose,
  type StepUpToken,
  type TotpClient,
} from "@osn/client";
import { Button } from "@shared/ui/ui/button";
import { Dialog, DialogContent, DialogDescription } from "@shared/ui/ui/dialog";
import { labelVariants } from "@shared/ui/ui/label";
import { Notice } from "@shared/ui/ui/notice";
import { OtpInput } from "@shared/ui/ui/otp-input";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";
import {
  createResource,
  createSignal,
  createUniqueId,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  type JSX,
} from "solid-js";

import { AuthHeader } from "./AuthHeader";
import { CheckEmailView, type CheckEmailStatus } from "./CheckEmailView";
import {
  describedBy,
  fieldError,
  inputError,
  plainError,
  statusOf,
  type FieldError,
} from "./error-lines";
import { createLinkPoll, type LinkPollStep } from "./link-poll";
import { describePasskeyError } from "./passkey-errors";
import { StepLink, stepAction, ViewStep } from "./ViewParts";

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
 * How long after closing the sheet hands its outcome over even though the
 * exit fade has not ended. The fade is the host's `--ui-dur-exit` (80ms in
 * Musubi). A tab the browser has hidden runs no animation, so its end never
 * comes; without this the token would wait for the person to come back.
 */
const EXIT_FALLBACK_MS = 300;

/**
 * The step-up (sudo) ceremony, as a sheet: it asks for a fresh factor before a
 * gated action and hands the host a short-lived step-up token through
 * `onToken`. Three factors: passkey, a link emailed to the account's own
 * address, and an authenticator app. Which of them appear depends on the
 * ceremony (see {@link PURPOSE_FACTORS}) and on what the account has set up.
 *
 * It is open while mounted: a host mounts it when an action needs it and
 * removes it on `onToken` or `onCancel`. It is `@shared/ui`'s `Dialog` with
 * `presentation="sheet"`, a bottom sheet below `md` and a centred card above.
 *
 * Under its title, one line says why: the host's `warning` or `reason`.
 * The actions sit in its footer, Cancel first, then the step's one primary:
 * "Use passkey" on the factor list, Confirm on the code step, nothing on the
 * emailed link's wait. The other factors stay above the footer.
 *
 * The emailed link swaps the factors for `CheckEmailView` inside the sheet:
 * the number to type on the link's page, Resend, "Use another method" and
 * Cancel. The sheet polls until the link is confirmed, on this device or
 * another. The claim secret and the number live in memory only, and go when
 * the person goes back or closes the sheet.
 */
export interface StepUpDialogProps {
  client: StepUpClient;
  /**
   * Receives the step-up token, once, after the sheet has closed. The host
   * removes the sheet and goes on with the gated action.
   */
  onToken: (token: StepUpToken) => void;
  /**
   * Called, once, after the sheet has closed without a token: Cancel, Escape
   * or a press outside it.
   */
  onCancel: () => void;
  /** Executes the browser-side WebAuthn assertion. */
  runPasskeyCeremony?: RunPasskeyCeremony;
  /**
   * TOTP client, for the "enter a code from your authenticator app" factor.
   * Omit it and that factor is never offered.
   *
   * The sheet asks `GET /totp/status` itself rather than taking a boolean,
   * so a host cannot wire the client and the flag inconsistently and end up
   * offering a factor the account has not set up. A failed status read leaves
   * the factor hidden and never blocks the other two.
   */
  totpClient?: TotpClient;
  /**
   * **The host cannot deliver mail**: suppress the emailed-link factor and
   * drive the passkey ceremony directly. With this set the sheet auto-starts
   * the passkey ceremony on mount and offers a retry on failure — unless a
   * `warning` is given: then the sheet shows its factors and waits for a
   * press, so the warning is read before the browser's prompt covers it.
   *
   * It suppresses the emailed link and **nothing else**. An authenticator app
   * needs no delivery, so it cannot fail the way this prop exists to prevent,
   * and it stays on offer wherever the ceremony and the account allow it —
   * which is why the name is not the whole story and this paragraph is here.
   * Where no authenticator is enrolled the sheet really is passkey-only, the
   * state the name was written for.
   *
   * @see wiki/osn/passkey-primary.md — the settled meaning, and why the
   * prop was not renamed.
   */
  passkeyOnly?: boolean;
  /**
   * The sheet's title, which names it. Defaults to "Confirm it's you". Where
   * a destructive action leads here, the title names the action ("Remove
   * Device passkey?") and `warning` says what it costs.
   */
  title?: string;
  /**
   * Why the sheet is asking, as the whole sentence the sheet shows under its
   * title: "To generate recovery codes, confirm it's you." It is the sheet's
   * description, printed as given. Ignored when `warning` is given, which is
   * then the one line.
   */
  reason?: string;
  /**
   * What a destructive action costs, as the one line under the title ("You'll
   * need another credential to sign in. Confirm it's you to remove it."). The
   * sheet's description: a screen reader hears it as the sheet opens. There is
   * no red button: the factor the person picks commits the action.
   */
  warning?: string;
  /**
   * Ceremony the minted token is for. Endpoints that name a purpose reject
   * tokens minted for a different one, so a token this sheet produces for
   * one action can't be replayed at another. The emailed link is fixed to one
   * purpose when it is sent, so without a purpose it is not offered.
   */
  purpose?: StepUpPurpose;
}

type Mode = "choose" | "passkey" | "email" | "totp";

/** Runs `onGone` when the sheet's content unmounts, its exit fade over. */
function OnUnmount(props: { onGone: () => void }): JSX.Element {
  onCleanup(() => props.onGone());
  return null;
}

export function StepUpDialog(props: StepUpDialogProps) {
  // Read before the host's update lands: the host disables its opener in the
  // same update that mounts this sheet, and a disabled control can drop focus
  // to the page before the sheet's own focus hooks run.
  const opener =
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  // With a warning the sheet waits for a press, even with `passkeyOnly`: the
  // warning is the one confirmation before a destructive action, and the
  // browser's prompt would cover it.
  const autoStart = () => props.passkeyOnly && !props.warning;
  const start = (): Mode => (autoStart() ? "passkey" : "choose");
  const [mode, setMode] = createSignal<Mode>(start());
  const [code, setCode] = createSignal("");
  // The call under way, so only the button that started it shows the wait.
  const [waiting, setWaiting] = createSignal<"passkey" | "emailBegin" | "totp" | null>(null);
  const busy = () => waiting() !== null;
  // On the code step the line sits under the code boxes and is tied to them;
  // on the others, above the factor buttons.
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
  // Which emailed-link wait is current. Starting one, going back and closing
  // each move it on, and every answer checks it after its `await`, so an
  // answer for a wait the person has left writes nothing and starts nothing.
  let emailRun = 0;

  // The sheet is open until it closes itself, once, with one outcome. The
  // outcome goes to the host when the content unmounts (its exit fade over),
  // or after EXIT_FALLBACK_MS if that never comes, and never to a host that
  // has already removed the sheet.
  const [open, setOpen] = createSignal(true);
  const closing = () => !open();
  let outcome: (() => void) | undefined;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    clearTimeout(fallback);
  });

  // Factor buttons, so going back can put focus on the one just left, and
  // the sheet can open on the passkey.
  let passkeyFactor: HTMLButtonElement | undefined;
  let emailFactor: HTMLButtonElement | undefined;
  let totpFactor: HTMLButtonElement | undefined;

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
  // whole tab, this sheet included, for its fallback until the status lands.
  const totp = () => (totpStatus.state === "ready" ? totpStatus.latest : undefined);
  const totpOffered = () => factors().totp && totp()?.enrolled === true;
  const emailOffered = () => factors().email && !props.passkeyOnly;

  // Passkey-only contexts skip the factor picker — kick the ceremony off as
  // soon as the sheet mounts so the user lands straight on the platform
  // authenticator prompt.
  onMount(() => {
    if (autoStart()) void startPasskey();
  });

  /** Ends any emailed-link wait on this side: the poll, the secret, the number. */
  function endEmailWait() {
    emailRun += 1;
    linkPoll.stop();
    setLink(null);
    setPairingCode(undefined);
    setLinkError(undefined);
    setLinkStatus("waiting");
  }

  /** Closes the sheet with `deliver` as its one outcome; later calls do nothing. */
  function close(deliver: () => void) {
    if (outcome) return;
    outcome = deliver;
    endEmailWait();
    setOpen(false);
    fallback = setTimeout(handOver, EXIT_FALLBACK_MS);
  }

  function handOver() {
    const deliver = outcome;
    if (!deliver || disposed) return;
    outcome = () => {};
    clearTimeout(fallback);
    deliver();
  }

  function cancel() {
    if (busy() || closing()) return;
    close(props.onCancel);
  }

  /** Back to the factors, ending the step on screen; focus on the factor just left. */
  function goBack() {
    if (busy() || closing()) return;
    const left = mode();
    endEmailWait();
    setCode("");
    setError(null);
    setMode(start());
    (left === "email" ? emailFactor : left === "totp" ? totpFactor : passkeyFactor)?.focus();
  }

  async function startPasskey() {
    if (busy() || closing()) return;
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
      close(() => props.onToken(token));
    } catch (e) {
      setError(plainError(describePasskeyError(e, "authentication")));
    } finally {
      setWaiting(null);
    }
  }

  /**
   * Sends a new link (a new request, with its own number) and waits on it,
   * unless the wait `run` names is no longer current when the answer comes.
   * Says whether it started the wait.
   */
  async function sendLink(purpose: StepUpPurpose, run: number): Promise<boolean> {
    const begun = await props.client.emailBegin({ purpose });
    if (disposed || run !== emailRun) return false;
    setLink(begun);
    setPairingCode(begun.pairingCode);
    setLinkError(undefined);
    setLinkStatus("waiting");
    linkPoll.start();
    return true;
  }

  async function startEmail() {
    const purpose = props.purpose;
    if (busy() || closing() || purpose === undefined) return;
    setWaiting("emailBegin");
    setError(null);
    emailRun += 1;
    try {
      if (await sendLink(purpose, emailRun)) setMode("email");
    } catch (e) {
      setError(plainError(describeAuthError(e)));
    } finally {
      setWaiting(null);
    }
  }

  /**
   * One poll of the link this sheet waits on. Any answer about a request this
   * sheet no longer waits on — cancelled, gone, or replaced by a new one — is
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
      close(() => props.onToken(answer.token));
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
   * rejection is how the view learns that no new link went. An answer that
   * comes after the person left this wait changes nothing.
   */
  async function resendLink() {
    const request = link();
    const purpose = props.purpose;
    const run = emailRun;
    if (!request || purpose === undefined || closing()) return;
    if (linkStatus() === "expired") {
      try {
        await sendLink(purpose, run);
      } catch (err) {
        if (run !== emailRun) return;
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
      if (run !== emailRun) return;
      setLinkError(RESEND_FAILED_LINE);
      setLinkStatus("error");
      throw err;
    }
    if (disposed || run !== emailRun) return;
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

  function startTotp() {
    if (busy() || closing()) return;
    // No `begin` half: TOTP is challenge-free, so there is nothing for the
    // server to mint, park or send. `GET /totp/status` already answered the
    // only question — whether the factor exists at all.
    setError(null);
    setCode("");
    setMode("totp");
  }

  async function completeTotp() {
    if (busy() || closing()) return;
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
      close(() => props.onToken(token));
    } catch (e) {
      // With no answer the server may still have taken the code, and it
      // counts the same code again toward the lockout, so none is kept to
      // send again; the line asks for a new one.
      if (statusOf(e) === 0) setCode("");
      setError(fieldError(describeAuthError(e, "code"), e));
    } finally {
      setWaiting(null);
    }
  }

  /**
   * Focus back to the control that opened the sheet, if it is still in the
   * page. Kobalte marks the event `defaultPrevented` when focus is already on
   * something focusable outside the sheet — the host's next step, mounted
   * once it had the token — and that focus stays.
   */
  function onCloseAutoFocus(event: Event) {
    if (event.defaultPrevented || !opener?.isConnected) return;
    event.preventDefault();
    opener.focus();
  }
  /**
   * Focus on "Use passkey" as the sheet opens: the one primary, which sits in
   * the footer after the other factors, so Kobalte's first tabbable would be
   * "Email me a link" (Enter would send an email) or Cancel.
   */
  function onOpenAutoFocus(event: Event) {
    if (!passkeyFactor) return;
    event.preventDefault();
    passkeyFactor.focus();
  }
  // `DialogContent` passes every prop on to Kobalte's `Dialog.Content`, whose
  // focus hooks these are; its own type names only a `div`'s props.
  const focusHooks = { onOpenAutoFocus, onCloseAutoFocus };

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

  /** Back to the factors: a standalone link at the body's foot, above the footer. */
  const anotherMethod = () => (
    <StepLink host="dialog" onClick={goBack} disabled={busy()}>
      Use another method
    </StepLink>
  );

  /** The one line under the title: the warning when there is one, else the reason. */
  const line = () => props.warning ?? props.reason;

  /**
   * The step's one action, the footer's: "Use passkey" on the factor list
   * (and the `passkeyOnly` wait), Confirm on the code step, none on the
   * emailed link's wait.
   */
  const action = () => (
    <Switch>
      <Match when={mode() === "choose" || mode() === "passkey"}>
        <Button
          ref={passkeyFactor}
          {...stepAction("dialog")}
          onClick={startPasskey}
          busy={waiting() === "passkey"}
          disabled={busy() && waiting() !== "passkey"}
        >
          {waiting() === "passkey"
            ? "Waiting for your passkey…"
            : mode() === "passkey" && error() && props.runPasskeyCeremony
              ? "Try again"
              : "Use passkey"}
        </Button>
      </Match>
      <Match when={mode() === "totp"}>
        <Button {...stepAction("dialog")} onClick={completeTotp} busy={busy()}>
          {busy() ? "Checking…" : "Confirm"}
        </Button>
      </Match>
    </Switch>
  );

  return (
    <Dialog
      open={open()}
      // Escape and a press outside close it, as Cancel does — but never while
      // a call the sheet started runs, since Cancel is disabled then too.
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
    >
      <DialogContent presentation="sheet" class="md:max-w-sm" {...focusHooks}>
        <OnUnmount onGone={() => queueMicrotask(handOver)} />
        {/* A title can carry a passkey's name, one word of up to 64
            characters; `AuthHeader` breaks it anywhere. */}
        <AuthHeader host="dialog" title={props.title ?? "Confirm it's you"} />
        {/* Body and footer go `inert` together while the sheet closes. */}
        <div class="flex flex-col" inert={closing() || undefined}>
          <ViewStep
            host="dialog"
            onCancel={cancel}
            cancelDisabled={busy()}
            action={action()}
            links={<Show when={mode() === "email" || mode() === "totp"}>{anotherMethod()}</Show>}
          >
            {/* The one line under the title, and the sheet's description. It
                can name a passkey too, so it breaks anywhere as the title does. */}
            <Show when={line()}>
              {(text) => (
                <DialogDescription>
                  <span class="wrap-anywhere">{text()}</span>
                </DialogDescription>
              )}
            </Show>
            {/* A step-up failure is the reason the user cannot proceed, so it is
                announced rather than left for them to notice. */}
            <Show when={!onCodeStep()}>{errorLine()}</Show>
            {/* The other factors; "Use passkey", the one primary, is the
                footer's. */}
            <Show
              when={
                (mode() === "choose" || mode() === "passkey") && (emailOffered() || totpOffered())
              }
            >
              <div class="flex flex-col gap-2">
                <Show when={emailOffered()}>
                  <Button
                    ref={emailFactor}
                    variant="outline"
                    class="max-md:h-10"
                    onClick={startEmail}
                    busy={waiting() === "emailBegin"}
                    disabled={busy() && waiting() !== "emailBegin"}
                  >
                    {waiting() === "emailBegin" ? "Sending…" : "Email me a link"}
                  </Button>
                </Show>
                {/* An authenticator code needs no delivery, so it survives the
                    no-mail mode `passkeyOnly` puts the sheet in. */}
                <Show when={totpOffered()}>
                  <Button
                    ref={totpFactor}
                    variant="outline"
                    class="max-md:h-10"
                    onClick={startTotp}
                    disabled={busy()}
                  >
                    Use your authenticator app
                  </Button>
                </Show>
              </div>
            </Show>
            {/* Mounted inside the sheet that is already open, so the view's
                heading takes focus as it appears. Every way out stays open while
                a Resend runs: leaving ends the request on this side, and the
                answer is dropped. */}
            <Show when={mode() === "email"}>
              <CheckEmailView
                purpose="step-up"
                status={linkStatus()}
                errorMessage={linkError()}
                pairingCode={pairingCode()}
                resendWaitSeconds={RESEND_WAIT_SECONDS}
                onResend={resendLink}
              />
            </Show>
            <Show when={mode() === "totp"}>{codeRow("Code from your authenticator app")}</Show>
          </ViewStep>
        </div>
      </DialogContent>
    </Dialog>
  );
}
