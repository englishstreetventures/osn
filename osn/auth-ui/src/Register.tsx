import {
  describeAuthError,
  type EmailVerificationNonce,
  type PreviousRegistration,
  type RegistrationClient,
  type RegistrationStatus,
  type Session,
} from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { toast } from "@shared/toast";
import { Button } from "@shared/ui/ui/button";
import { Field } from "@shared/ui/ui/field";
import { InfoPopover } from "@shared/ui/ui/info-popover";
import { Input } from "@shared/ui/ui/input";
import { Label } from "@shared/ui/ui/label";
import { Notice } from "@shared/ui/ui/notice";
import { UsernameInput } from "@shared/ui/ui/username-input";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { createEffect, createSignal, createUniqueId, on, Show, onCleanup, onMount } from "solid-js";

import { AuthHeader } from "./AuthHeader";
import { CheckEmailView, type CheckEmailStatus } from "./CheckEmailView";
import { describedBy } from "./error-lines";
import { describePasskeyError } from "./passkey-errors";
import {
  PENDING_KEY,
  PREVIOUS_KEY,
  readStored,
  storedWaiting,
  writeStored,
  type Waiting,
} from "./pending-sign-up";
import { TurnstileWidget, turnstileEnabled } from "./TurnstileWidget";
import { stepAction, ViewStep } from "./ViewParts";

type Step = "details" | "verify" | "passkey" | "done";

/** The first poll waits this long after the link is sent; each later one longer, up to the cap. */
const POLL_FIRST_MS = 2_000;
const POLL_GROWTH = 1.5;
const POLL_MAX_MS = 10_000;

/**
 * What the waiting view says when the request has sent every link it may: an
 * answer, not a failed call, so it is this view's own sentence. Every failed
 * call reads `describeAuthError`'s.
 */
const LIMIT_LINE =
  "We've sent all the links we can for this sign-up. Use the newest one, or go back and start again.";
const CONFLICT_LINE = "That handle was taken while you waited. Choose another.";

const HANDLE_RE = /^[a-z0-9_]{1,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BIRTHDATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// (COPPA) Mirrors the server's under-13 gate for immediate feedback. The
// server remains authoritative — it re-checks and returns 422 for under-13.
const MIN_AGE_YEARS = 13;

/** Whole years from a `YYYY-MM-DD` birthdate to now (UTC), birthday-aware. */
function ageInYears(birthdate: string): number {
  const b = new Date(`${birthdate}T00:00:00.000Z`);
  if (Number.isNaN(b.getTime())) return Number.NaN;
  const now = new Date();
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - b.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < b.getUTCDate())) age -= 1;
  return age;
}

interface RegisterBaseProps {
  client: RegistrationClient;
  /**
   * Fired once the account exists and its first passkey is enrolled — i.e.
   * the session is fully usable. Consumers that own navigation (e.g. a
   * standalone login page) redirect here; consumers that react to
   * `session()` directly can omit it.
   */
  onSuccess?: () => void;
  /**
   * Cloudflare Turnstile sitekey (public, build-time). When provided, the
   * "details" step renders the Turnstile challenge and gates "Send verification
   * link" on it (the token rides on `/register/begin`). Omitted/blank ⇒ no
   * widget, no gate (key-optional — matches osn-api skipping siteverify).
   */
  turnstileSiteKey?: string;
  /** Product name shown in this dialog's copy — e.g. "Musubi". */
  productName: string;
}

/**
 * What the view is mounted in, and where Cancel goes. See `AuthHeader`.
 *
 * - `"dialog"`: inside `@shared/ui`'s `Dialog`, whose name its title becomes.
 *   Cancel is the footer's, first beside each step's action, and reads
 *   "Cancel". It ends a sign-up link's wait, then calls `onCancel`, and
 *   closes nothing itself; Escape and a press outside are the host's
 *   `onOpenChange`.
 * - `"page"`: on a page such as `/authorize`, with no padding at the sides.
 *   Cancel sits at the title row's end, in the page's words where going back
 *   means something else, such as "Sign in instead" (`cancelLabel`).
 */
export type RegisterProps = RegisterBaseProps &
  (
    | { host: "dialog"; /** Called by Cancel. */ onCancel: () => void }
    | { host: "page"; /** Called by Cancel. */ onCancel: () => void; cancelLabel?: string }
  );

export function Register(props: RegisterProps) {
  const { adoptSession } = useAuth();
  const client = props.client;
  // Feature-detect on each mount so test code can toggle the underlying mock.
  const webauthnSupported = browserSupportsWebAuthn();

  const resumed = storedWaiting();
  const [step, setStep] = createSignal<Step>(resumed ? "verify" : "details");
  const [email, setEmail] = createSignal(resumed?.email ?? "");
  const [handle, setHandle] = createSignal(resumed?.handle ?? "");
  const [birthdate, setBirthdate] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");
  // One signal per call, so only the button that started a wait shows it.
  const [sending, setSending] = createSignal(false);
  const [resending, setResending] = createSignal(false);
  const [enrolling, setEnrolling] = createSignal(false);
  // The request this tab waits on, and what the waiting view says about it.
  const [waiting, setWaiting] = createSignal<Waiting | null>(resumed);
  // The number the waiting view shows: from the begin, or, after a reload,
  // from the first poll. Memory only — never stored, logged or put in a URL.
  const [pairingCode, setPairingCode] = createSignal<string | undefined>(undefined);
  const [linkStatus, setLinkStatus] = createSignal<CheckEmailStatus>("waiting");
  const [linkError, setLinkError] = createSignal<string | undefined>(undefined);
  // A refused send, above "Send verification link".
  const [detailsError, setDetailsError] = createSignal<string | null>(null);
  // The wait ended because someone took the handle: a line under the handle,
  // which the field names while it shows.
  const [handleTaken, setHandleTaken] = createSignal(false);
  const [profileId, setProfileId] = createSignal<string | null>(null);
  const [accessToken, setAccessToken] = createSignal<string | null>(null);
  // Held, not published, between the account being made and passkey
  // enrollment. See `finish` for why the hand-off to `adoptSession` waits.
  const [session, setSession] = createSignal<Session | null>(null);
  const [passkeyError, setPasskeyError] = createSignal<string | null>(null);
  // The email line waits until the field is left, so it is not announced on
  // every keystroke of an address still being typed.
  const [emailLeft, setEmailLeft] = createSignal(false);
  const emailId = createUniqueId();
  const emailErrorId = createUniqueId();
  const birthdateErrorId = createUniqueId();
  const handleTakenId = createUniqueId();
  // Turnstile token — REQUIRED only when a sitekey is provided.
  const [turnstileToken, setTurnstileToken] = createSignal<string | null>(null);
  const turnstileOn = () => turnstileEnabled(props.turnstileSiteKey);
  // Bound to the details step's widget once it mounts. Forces a fresh token
  // after `/register/begin` refused the current one (tokens are single-use —
  // Cloudflare only refreshes a token when it expires, ~300s, never when it is
  // spent).
  let resetTurnstile: (() => void) | undefined;
  // The handle box, for focus when a wait ends because the handle was taken.
  let handleField: HTMLInputElement | undefined;
  // The browser Email Verification API field. The proposal has no feature
  // detection: the form carries the hidden field whenever osn-api hands out a
  // nonce (its flag is on), and a browser with the API fills it when the
  // person picks their address and submits. The nonce secret stays here, in
  // memory, and goes with the field's value at begin; each nonce is good for
  // one begin, so the details step fetches a fresh one each time it shows.
  const [verificationNonce, setVerificationNonce] = createSignal<EmailVerificationNonce | null>(
    null,
  );
  let verificationField: HTMLInputElement | undefined;
  let nonceRequest = 0;
  async function loadVerificationNonce() {
    const ask = client.emailVerificationNonce;
    const request = ++nonceRequest;
    setVerificationNonce(null);
    if (!ask) return;
    const minted = await ask.call(client).catch(() => null);
    if (request === nonceRequest && step() === "details") setVerificationNonce(minted);
  }
  createEffect(
    on(step, (current) => {
      if (current === "details") void loadVerificationNonce();
    }),
  );

  // Names all three jobs the address does, so the choice of address is made
  // knowing the second: the address is a way back into an account whose
  // passkeys are all gone.
  const emailUses = () =>
    `We email a link here to confirm the address — your ${props.productName} account is not created until you confirm it. It is also how you get back in if you lose every device with a passkey on it, so use an address you will still be reading in a year. Security notices come here too, such as a recovery code being created or used.`;

  const [handleStatus, setHandleStatus] = createSignal<
    "idle" | "checking" | "available" | "taken" | "invalid" | "error"
  >("idle");
  let handleTimer: ReturnType<typeof setTimeout> | null = null;
  // Cancels the previous in-flight availability probe when a new one fires,
  // so debounced typing bursts never stack requests.
  let handleAbort: AbortController | null = null;
  onCleanup(() => {
    if (handleTimer) clearTimeout(handleTimer);
    handleAbort?.abort();
  });

  function onHandleInput(value: string) {
    const next = value.toLowerCase().replace(/[^a-z0-9_]/g, "");
    // The handle-taken line is about the handle that was taken; a new handle
    // answers it, and the field's own check takes over.
    if (next !== handle()) setHandleTaken(false);
    setHandle(next);
    if (handleTimer) clearTimeout(handleTimer);
    if (!next) {
      setHandleStatus("idle");
      return;
    }
    if (!HANDLE_RE.test(next)) {
      setHandleStatus("invalid");
      return;
    }
    setHandleStatus("checking");
    handleTimer = setTimeout(async () => {
      handleAbort?.abort();
      const controller = new AbortController();
      handleAbort = controller;
      try {
        const { available } = await client.checkHandle(next, controller.signal);
        if (handle() !== next) return;
        setHandleStatus(available ? "available" : "taken");
      } catch {
        // An aborted probe was superseded (or unmounted) — never an error state.
        if (controller.signal.aborted || handle() !== next) return;
        setHandleStatus("error");
      }
    }, 300);
  }

  // A birthdate that both parses and clears the under-13 gate. The
  // server re-checks authoritatively (422 on under-13); this is UX only.
  const birthdateOk = () =>
    BIRTHDATE_RE.test(birthdate()) && ageInYears(birthdate()) >= MIN_AGE_YEARS;
  const underAge = () => BIRTHDATE_RE.test(birthdate()) && !birthdateOk();
  const emailMalformed = () => emailLeft() && email() !== "" && !EMAIL_RE.test(email());

  const detailsValid = () =>
    EMAIL_RE.test(email()) &&
    handleStatus() === "available" &&
    birthdateOk() &&
    (!turnstileOn() || turnstileToken() !== null);

  // ---------------------------------------------------------------------------
  // Waiting on the link
  //
  // The tab polls the request it holds until the link is confirmed, on this
  // device or any other. One poll at a time: a poll that would start while
  // one is out is merged into it. The first waits two seconds, each later one
  // half as long again, up to ten. Coming back to the tab (focus, or the page
  // becoming visible) polls at once and starts the waits again from two
  // seconds, since that is when the person has most likely just confirmed.
  // ---------------------------------------------------------------------------

  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollDelay = POLL_FIRST_MS;
  let polling = false;
  let disposed = false;

  function stopPolling() {
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollTimer = undefined;
  }

  function schedulePoll(delay: number) {
    stopPolling();
    if (disposed || !waiting()) return;
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      void pollNow();
    }, delay);
  }

  function startPolling() {
    pollDelay = POLL_FIRST_MS;
    schedulePoll(pollDelay);
  }

  async function pollNow() {
    const request = waiting();
    if (disposed || !request || polling) return;
    stopPolling();
    polling = true;
    let answer: RegistrationStatus | null = null;
    try {
      answer = await client.registrationStatus({
        requestId: request.requestId,
        claimSecret: request.claimSecret,
      });
    } catch {
      // No answer about the request: a network failure, a rate limit or a
      // server error. The wait goes on, at the longest interval.
    } finally {
      polling = false;
    }
    // The account exists and this browser holds its session cookie whatever
    // the person did meanwhile, so a completing answer is never dropped: the
    // view takes it to the passkey step, and once the view is gone it is
    // handed over without one.
    if (answer?.status === "complete") {
      if (disposed) void handOver(answer);
      else finish(answer);
      return;
    }
    if (disposed) return;
    // Any other answer about a request this tab no longer waits on is stale.
    if (waiting() !== request) return;
    if (answer === null) {
      pollDelay = POLL_MAX_MS;
      schedulePoll(pollDelay);
    } else if (answer.status === "pending") {
      if (answer.pairingCode !== undefined) setPairingCode(answer.pairingCode);
      pollDelay = Math.min(pollDelay * POLL_GROWTH, POLL_MAX_MS);
      schedulePoll(pollDelay);
    } else if (answer.status === "expired") {
      writeStored(PENDING_KEY, null);
      setLinkError(undefined);
      setLinkStatus("expired");
    } else {
      // The handle went to someone else while the person waited. The request
      // is spent; the details step offers the handle check again, reads the
      // reason out, and puts focus where the person picks another handle.
      writeStored(PENDING_KEY, null);
      setWaiting(null);
      setDetailsError(null);
      setHandleTaken(true);
      setStep("details");
      onHandleInput(handle());
      handleField?.focus();
    }
  }

  function pollOnReturn() {
    if (!waiting() || linkStatus() === "expired") return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    pollDelay = POLL_FIRST_MS;
    void pollNow();
  }

  onMount(() => {
    window.addEventListener("focus", pollOnReturn);
    document.addEventListener("visibilitychange", pollOnReturn);
    // A resumed wait polls at once: its number is not kept, and the link may
    // have been confirmed while the tab was gone.
    if (waiting()) void pollNow();
  });
  onCleanup(() => {
    disposed = true;
    stopPolling();
    window.removeEventListener("focus", pollOnReturn);
    document.removeEventListener("visibilitychange", pollOnReturn);
  });

  /** Waits on `request`, in this tab and in its storage; its number in memory only. */
  function waitOn(request: Waiting, code: string) {
    setPairingCode(code);
    setWaiting(request);
    setLinkStatus("waiting");
    setLinkError(undefined);
    setStep("verify");
    writeStored(PENDING_KEY, request);
    startPolling();
  }

  /**
   * Stops waiting on the current request and keeps it as the one the next
   * begin retires, so the address is free again at once.
   */
  function leaveRequest() {
    const request = waiting();
    stopPolling();
    setWaiting(null);
    setPairingCode(undefined);
    writeStored(PENDING_KEY, null);
    if (request) {
      const previous: PreviousRegistration = {
        requestId: request.requestId,
        claimSecret: request.claimSecret,
      };
      writeStored(PREVIOUS_KEY, previous);
    }
  }

  function backToDetails() {
    leaveRequest();
    setStep("details");
    // The handle's last answer may be old by now.
    if (handle()) onHandleInput(handle());
  }

  function cancel() {
    if (step() === "verify") leaveRequest();
    props.onCancel();
  }

  async function submitDetails(e: Event) {
    e.preventDefault();
    if (!detailsValid() || sending()) return;
    setSending(true);
    setDetailsError(null);
    try {
      const input: Parameters<RegistrationClient["beginRegistration"]>[0] = {
        email: email(),
        handle: handle(),
        birthdate: birthdate(),
        displayName: displayName().trim() || undefined,
        turnstileToken: turnstileToken() ?? undefined,
      };
      const previous = readStored<PreviousRegistration>(PREVIOUS_KEY);
      if (previous) input.previous = previous;
      // What the browser put in the hidden field, if it has the API.
      const nonce = verificationNonce();
      const verification = verificationField?.value ?? "";
      if (nonce && verification) {
        input.emailVerificationToken = verification;
        input.nonceSecret = nonce.nonceSecret;
      }
      let begun: Awaited<ReturnType<RegistrationClient["beginRegistration"]>>;
      try {
        begun = await spendingToken(() => client.beginRegistration(input));
      } finally {
        // A nonce is good for one begin, refused or not.
        if (input.emailVerificationToken) void loadVerificationNonce();
      }
      writeStored(PREVIOUS_KEY, null);
      // A browser token that verified has confirmed the address already: the
      // first poll makes the account, and the person goes straight to the
      // passkey step without a "check your email" screen. Any other answer
      // waits on the link as every sign-up does.
      if (input.emailVerificationToken) {
        const first = await client
          .registrationStatus({ requestId: begun.requestId, claimSecret: begun.claimSecret })
          .catch(() => null);
        if (first?.status === "complete") {
          finish(first);
          return;
        }
      }
      waitOn(
        {
          requestId: begun.requestId,
          claimSecret: begun.claimSecret,
          expiresAt: begun.expiresAt,
          email: email(),
          handle: handle(),
        },
        begun.pairingCode,
      );
    } catch (err) {
      // The server answers a taken email or handle the same as a free one, so
      // this never says which; a 422 is the age gate, a 429 says to wait.
      setDetailsError(describeAuthError(err, "details"));
    } finally {
      setSending(false);
    }
  }

  /**
   * Runs a call that spends the Turnstile token. The server checks the token
   * before it answers, so a refusal has spent it too: on a failure the widget
   * stays on screen and is asked for a fresh token. On a success the details
   * step, and its widget, go away, so the spent token is dropped; coming back
   * to the details mounts a new widget, which hands over a fresh one.
   */
  async function spendingToken<T>(call: () => Promise<T>): Promise<T> {
    try {
      const result = await call();
      setTurnstileToken(null);
      return result;
    } catch (err) {
      if (turnstileOn()) resetTurnstile?.();
      throw err;
    }
  }

  /**
   * Resend in the waiting view. A live request gets another link of its own,
   * so a link already on its way still works; an expired one goes back to the
   * details, where Turnstile can run again before a new sign-up begins. A
   * rejection is how the view learns that no new link went.
   */
  async function resendLink() {
    const request = waiting();
    if (!request) return;
    if (linkStatus() === "expired") {
      backToDetails();
      return;
    }
    setLinkStatus("waiting");
    setLinkError(undefined);
    let answer: { status: "sent" | "limit" | "expired" };
    setResending(true);
    try {
      answer = await client.resendRegistrationLink({
        requestId: request.requestId,
        claimSecret: request.claimSecret,
      });
    } catch (err) {
      setLinkError(describeAuthError(err));
      setLinkStatus("error");
      throw err;
    } finally {
      setResending(false);
    }
    if (answer.status === "sent") {
      startPolling();
      return;
    }
    if (answer.status === "limit") {
      setLinkError(LIMIT_LINE);
      setLinkStatus("error");
      throw new Error(LIMIT_LINE);
    }
    stopPolling();
    writeStored(PENDING_KEY, null);
    setLinkStatus("expired");
    throw new Error("The link expired");
  }

  /**
   * Parks the new account's session in a signal — it is NOT adopted here.
   * The passkey step authenticates with the access token directly, so
   * nothing in the flow needs a published session, and publishing one early
   * would announce a signed-in user whose account still has zero passkeys.
   * Consumers act on that announcement: `@musubi/social` hides its auth
   * dialogs the moment `session()` is truthy, which unmounted this component
   * mid-flow and skipped enrollment altogether. `enrollPasskey` adopts it
   * once the credential exists — that, plus the server-side last-passkey
   * guard on `DELETE /passkeys/:id`, is what holds up the "every account has
   * ≥1 passkey" invariant.
   */
  function finish(done: Extract<RegistrationStatus, { status: "complete" }>) {
    stopPolling();
    setWaiting(null);
    setPairingCode(undefined);
    writeStored(PENDING_KEY, null);
    writeStored(PREVIOUS_KEY, null);
    setProfileId(done.profileId);
    setAccessToken(done.session.accessToken);
    setSession(done.session);
    setHandle(done.handle);
    toast.success("Email verified");
    setStep("passkey");
  }

  /**
   * A completing answer that lands after the view is gone — the dialog was
   * closed while the poll was out. There is no passkey step left to hold the
   * session for, so it is published at once, as the cookie the answer set
   * would publish it on the next load, and the stored wait and the request
   * left for retiring are cleared so no later dialog resumes or retires it.
   * Nothing here touches the view.
   */
  async function handOver(done: Extract<RegistrationStatus, { status: "complete" }>) {
    writeStored(PENDING_KEY, null);
    writeStored(PREVIOUS_KEY, null);
    try {
      await adoptSession(done.session);
    } catch {
      // Storage refused the session; the cookie still signs the browser in
      // on its next load, and there is no view to say so.
    }
  }

  /**
   * Enrolls the account's first credential, then signs the user in. The
   * order matters: `adoptSession` is what tells the rest of the app a user
   * is present, and until the credential exists there is no account worth
   * announcing — a failed or abandoned ceremony leaves the user signed out,
   * still on this step, able to try again.
   */
  async function enrollPasskey() {
    const id = profileId();
    const token = accessToken();
    if (!id || !token || enrolling()) return;
    setEnrolling(true);
    setPasskeyError(null);
    try {
      const options = (await client.passkeyRegisterBegin({
        profileId: id,
        accessToken: token,
      })) as Parameters<typeof startRegistration>[0]["optionsJSON"];
      const attestation = await startRegistration({ optionsJSON: options });
      await client.passkeyRegisterComplete({
        profileId: id,
        accessToken: token,
        attestation,
      });
      toast.success(`Welcome, @${handle()}`);
      const next = session();
      if (next) await adoptSession(next);
      // "done" comes last, after the session is actually published. It is the
      // one step with no error slot and no retry button, so anything that can
      // still fail has to fail while the passkey step is on screen — and
      // `adoptSession` can: it writes to `localStorage`, which throws when
      // storage is disabled or full.
      setStep("done");
      props.onSuccess?.();
    } catch (err) {
      setPasskeyError(describePasskeyError(err, "registration"));
    } finally {
      setEnrolling(false);
    }
  }

  const busyNow = () => sending() || resending() || enrolling();
  const title = () => `Create your ${props.productName} account`;
  // The dialog's way out, first in each step's footer; on a page it is the
  // title row's.
  const dismiss = () => (props.host === "dialog" ? cancel : undefined);
  const page = () => (props.host === "page" ? props : undefined);

  return (
    <div class="flex flex-col">
      <Show when={page()} fallback={<AuthHeader host="dialog" title={title()} />}>
        {(onPage) => (
          <AuthHeader
            host="page"
            title={title()}
            onCancel={cancel}
            cancelLabel={onPage().cancelLabel}
            cancelDisabled={busyNow()}
          />
        )}
      </Show>
      {/* Gate the flow behind WebAuthn support: registration demands an
          enrolled passkey or security key, so there is no path forward from
          a browser without WebAuthn. The blocker commits nothing, so in a
          dialog Cancel stands alone. */}
      <Show
        when={webauthnSupported}
        fallback={
          <ViewStep host={props.host} onCancel={dismiss()}>
            <Notice tone="info" size="sm">
              Creating an account on {props.productName} needs a passkey or security key — something
              this browser doesn&apos;t support. Try a device with WebAuthn (iOS 16+, Android 9+, a
              recent desktop browser), or plug in a FIDO2 security key.
            </Notice>
          </ViewStep>
        }
      >
        {/* The step sits inside the form, footer and all, so Enter in a
            field submits. */}
        <Show when={step() === "details"}>
          <form onSubmit={submitDetails} class="flex flex-col">
            <ViewStep
              host={props.host}
              onCancel={dismiss()}
              cancelDisabled={busyNow()}
              action={
                // Invalid only while idle: the send spends the token, and a
                // refused one drops it before the wait ends.
                <Button
                  type="submit"
                  {...stepAction(props.host)}
                  busy={sending()}
                  disabled={!sending() && !detailsValid()}
                >
                  {sending() ? "Sending…" : "Send verification link"}
                </Button>
              }
            >
              {/* A bare Label: the "i" beside it is a button, which a label
                  cannot hold, so this field is wired by hand. */}
              <div class="flex flex-col gap-1.5">
                <div class="flex items-center">
                  <Label for={emailId}>Email</Label>
                  <InfoPopover
                    label="What this address is used for"
                    glyph="i"
                    placement="top"
                    body={emailUses()}
                  />
                </div>
                <Input
                  id={emailId}
                  type="email"
                  required
                  autocomplete="email"
                  value={email()}
                  onInput={(e) => setEmail(e.currentTarget.value)}
                  onBlur={() => setEmailLeft(true)}
                  aria-describedby={emailMalformed() ? emailErrorId : undefined}
                  aria-invalid={emailMalformed() || undefined}
                />
                <Show when={emailMalformed()}>
                  <Notice tone="danger" size="inline" alert id={emailErrorId}>
                    Please enter a valid email address
                  </Notice>
                </Show>
                {/* The browser Email Verification API field: hidden, filled by a
                    browser that has the API when the form is submitted. */}
                <Show when={verificationNonce()} keyed>
                  {(minted) => (
                    <input
                      ref={verificationField}
                      type="hidden"
                      name="email-verification-token"
                      autocomplete="email-verification-token"
                      nonce={minted.nonce}
                    />
                  )}
                </Show>
              </div>

              <Field labelTreatment="plain" label="Handle">
                {(field) => (
                  <>
                    <UsernameInput
                      {...field}
                      ref={handleField}
                      required
                      spellcheck={false}
                      value={handle()}
                      onInput={onHandleInput}
                      aria-describedby={describedBy(
                        field["aria-describedby"],
                        handleTaken() && handleTakenId,
                      )}
                      aria-invalid={handleTaken() || undefined}
                      status={handleStatus()}
                      placeholder="lowercase, numbers, _"
                      invalidMessage="1–30 chars: lowercase letters, numbers, underscores"
                    />
                    <Show when={handleTaken()}>
                      <Notice tone="danger" size="inline" alert id={handleTakenId}>
                        {CONFLICT_LINE}
                      </Notice>
                    </Show>
                  </>
                )}
              </Field>

              {/* The hint goes once a date is in; the under-13 line comes with one. */}
              <Field
                labelTreatment="plain"
                label="Date of birth"
                hint={birthdate() ? undefined : "You must be 13 or older to create an account."}
              >
                {(field) => (
                  <>
                    <Input
                      id={field.id}
                      type="date"
                      required
                      autocomplete="bday"
                      value={birthdate()}
                      onInput={(e) => setBirthdate(e.currentTarget.value)}
                      aria-describedby={describedBy(
                        field["aria-describedby"],
                        underAge() && birthdateErrorId,
                      )}
                      aria-invalid={underAge() || undefined}
                    />
                    <Show when={underAge()}>
                      <Notice tone="danger" size="inline" alert id={birthdateErrorId}>
                        {props.productName} is for users 13 and older
                      </Notice>
                    </Show>
                  </>
                )}
              </Field>

              <Field labelTreatment="plain" label="Display name (optional)">
                {(field) => (
                  <Input
                    {...field}
                    type="text"
                    value={displayName()}
                    onInput={(e) => setDisplayName(e.currentTarget.value)}
                  />
                )}
              </Field>

              {/* Turnstile challenge — renders only when a sitekey is provided. */}
              <TurnstileWidget
                siteKey={props.turnstileSiteKey}
                onToken={setTurnstileToken}
                onReady={(c) => (resetTurnstile = c.reset)}
              />

              <Show when={detailsError()}>
                {(msg) => (
                  <Notice tone="danger" size="inline" alert>
                    {msg()}
                  </Notice>
                )}
              </Show>
            </ViewStep>
          </form>
        </Show>

        {/* A wait commits nothing of its own, so in a dialog Cancel stands
            alone. */}
        <Show when={step() === "verify" ? waiting() : null}>
          {(request) => (
            <ViewStep host={props.host} onCancel={dismiss()} cancelDisabled={busyNow()}>
              <CheckEmailView
                purpose="sign-up"
                email={request().email}
                pairingCode={pairingCode()}
                status={linkStatus()}
                errorMessage={linkError()}
                onResend={resendLink}
                onChangeEmail={backToDetails}
              />
            </ViewStep>
          )}
        </Show>

        <Show when={step() === "passkey"}>
          <ViewStep
            host={props.host}
            onCancel={dismiss()}
            cancelDisabled={busyNow()}
            action={
              <Button {...stepAction(props.host)} onClick={enrollPasskey} busy={enrolling()}>
                {enrolling() ? "Waiting for your passkey…" : "Add a passkey"}
              </Button>
            }
          >
            <p class="text-ui-sm leading-ui-snug text-ui-ink-secondary">
              Add a passkey or security key so you can sign back in. This is required to finish
              creating your account.
            </p>
            <Show when={passkeyError()}>
              {(msg) => (
                <Notice tone="danger" size="inline" alert>
                  {msg()}
                </Notice>
              )}
            </Show>
          </ViewStep>
        </Show>

        {/* The host closes the dialog on success, so this line has no footer. */}
        <Show when={step() === "done"}>
          <ViewStep host={props.host}>
            <p class="text-ui-sm leading-ui-snug text-ui-ink-secondary">
              You&apos;re all set. Loading {props.productName}…
            </p>
          </ViewStep>
        </Show>
      </Show>
    </div>
  );
}
