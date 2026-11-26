import {
  describeAuthError,
  extractJwtSub,
  isRestrictedToken,
  type HeldSession,
  type EmailVerificationNonce,
  type PreviousRegistration,
  type RegistrationClient,
  type RegistrationStatus,
} from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { toast } from "@shared/toast";
import { Button, buttonVariants } from "@shared/ui/ui/button";
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
import { HANDLE_HINT, HANDLE_TOO_LONG } from "./handle-copy";
import { describePasskeyError } from "./passkey-errors";
import {
  clearLive,
  forgetDraft,
  forgetEnrolling,
  forgetPrevious,
  keepEnrolling,
  keepPrevious,
  PENDING_KEY,
  PREVIOUS_KEY,
  readLive,
  storedDraft,
  storedEnrolling,
  storedPrevious,
  storedWaiting,
  writeDraft,
  writeLive,
  writeStored,
  type Waiting,
} from "./pending-sign-up";
import { TurnstileWidget, turnstileEnabled } from "./TurnstileWidget";
import { stepAction, SwitchLine, ViewStep } from "./ViewParts";

type Step = "details" | "verify" | "passkey" | "ran-out" | "added" | "done";

/** The sign-up's session ended before its passkey was added. */
class Ended extends Error {}
/** The renewal is this account's ordinary session: its passkey is in already. */
class AlreadyIn extends Error {
  constructor(readonly session: HeldSession["session"]) {
    super("The account's session is an ordinary one");
  }
}

/** The issuer refused a renewal: the session behind the cookie has ended. */
function sessionRefused(err: unknown): boolean {
  return (err as { refused?: unknown } | null)?.refused === true;
}

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

/**
 * The countdown label's box: tabular figures, and an unseen two-digit label in
 * the same cell, so the button holds one width from 60 to 1 and Cancel beside
 * it never moves as the label loses a digit.
 */
const COUNTDOWN_BOX = "inline-grid tabular-nums";
const COUNTDOWN_CELL = "col-start-1 row-start-1";
const BIRTHDATE_FUTURE = "That date is in the future. Enter your date of birth.";
const BIRTHDATE_EARLY = "Check the year. That date is more than 120 years ago.";
/** The earliest date of birth the field takes, in years before today. */
const OLDEST_YEARS = 120;
/**
 * The new account's session ended before its first passkey: the account and
 * its address are kept, and the emailed recovery link is the way back in.
 */
const RAN_OUT_HEADING = "This sign-up ran out of time";
const RAN_OUT_LINE =
  "Your account is saved, but it has no passkey yet. Sign in, choose “Lost your passkey?”, and confirm your email to add one.";
/** The passkey is in, but this browser holds no session for the account. */
const ADDED_HEADING = "Your passkey is added";
const ADDED_LINE = "Sign in with it to finish.";
/** The passkey is in, and signing the person in failed in a way a retry may mend. */
const NOT_SIGNED_IN_LINE = "Your passkey is added, but we couldn't sign you in. Try again.";
/**
 * How long Send stays held after the server answers a sign-up's begin with a
 * rate limit: begins are counted by the minute (`registerBegin` in
 * `osn/api/src/routes/auth/limiters.ts`), so a minute from the refusal the
 * window has turned.
 */
const SEND_WAIT_MS = 60_000;
/**
 * How long a sign-up's session lives before its first passkey (osn-api's
 * `RECOVERY_SESSION_TTL_SEC`): when the stored enrolment stops reopening the
 * passkey step. The server's own deadline decides; this only stops a stale
 * marker reopening the view.
 */
const ENROLMENT_WINDOW_MS = 15 * 60_000;

const HANDLE_RE = /^[a-z0-9_]{1,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BIRTHDATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// (COPPA) Mirrors the server's under-13 gate for immediate feedback. The
// server remains authoritative — it re-checks and returns 422 for under-13.
const MIN_AGE_YEARS = 13;

/** `date` as `YYYY-MM-DD` on the person's own calendar, as a date field reads it. */
function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The status a failed call carries, if any. */
function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Whether a call was answered with a refusal: a 4xx other than a rate limit.
 * No answer, a rate limit and a server error are not.
 */
function refused(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 429;
}

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
  /**
   * The host's own terms of service and privacy notice. The details step says
   * that creating an account agrees to the first and acknowledges the second,
   * linking each in a tab of its own so the form keeps what was typed.
   */
  legal: { termsHref: string; privacyHref: string };
  /**
   * Takes the person to the host's sign-in. Given, the details step ends with
   * "Already have an account? Sign in". A page whose Cancel already goes to
   * sign-in (`cancelLabel`) leaves it out.
   */
  onSignIn?: () => void;
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
  const { adoptSession, refreshHeldSession } = useAuth();
  const client = props.client;
  // Feature-detect on each mount so test code can toggle the underlying mock.
  const webauthnSupported = browserSupportsWebAuthn();

  // Where this tab left off: a link it waits on, a new account still to get
  // its passkey, and what was typed. A wait's address and handle are the ones
  // it was sent with.
  const resumed = storedWaiting();
  const enrolment = resumed ? null : storedEnrolling();
  const draft = storedDraft();
  const [step, setStep] = createSignal<Step>(
    resumed ? "verify" : enrolment ? "passkey" : "details",
  );
  const [email, setEmail] = createSignal(resumed?.email ?? draft.email);
  const [handle, setHandle] = createSignal(resumed?.handle ?? draft.handle);
  const [birthdate, setBirthdate] = createSignal(draft.birthdate);
  const [displayName, setDisplayName] = createSignal(draft.displayName);
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
  const [profileId, setProfileId] = createSignal<string | null>(enrolment?.profileId ?? null);
  // The handle the server made the account under, from its answer: what the
  // welcome names, whatever the handle field last held.
  const [registered, setRegistered] = createSignal<string | null>(enrolment?.handle ?? null);
  // The restricted session's token, held for the passkey step and never
  // published: it reaches only passkey enrolment. None after a reload, until
  // the press asks the cookie for one. See `finish`.
  const [accessToken, setAccessToken] = createSignal<string | null>(null);
  // The passkey is in; what is left is signing in.
  const [enrolled, setEnrolled] = createSignal(false);
  const [passkeyError, setPasskeyError] = createSignal<string | null>(null);
  // The email line waits until the field is left, so it is not announced on
  // every keystroke of an address still being typed.
  const [emailLeft, setEmailLeft] = createSignal(false);
  const emailId = createUniqueId();
  const emailErrorId = createUniqueId();
  const birthdateErrorId = createUniqueId();
  const handleTakenId = createUniqueId();
  const agreementId = createUniqueId();
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
  // Send, and the line above it: where focus goes when a rate limit holds
  // Send that held it.
  let sendButton: HTMLButtonElement | undefined;
  let detailsErrorLine: HTMLDivElement | undefined;
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

  // The field's range, on the person's own calendar: no later than today, no
  // earlier than 120 years ago. Read once per view; a view left open past
  // midnight keeps yesterday's, which refuses nothing a person could mean.
  const today = new Date();
  const latestBirthdate = localDate(today);
  const earliestBirthdate = localDate(
    new Date(today.getFullYear() - OLDEST_YEARS, today.getMonth(), today.getDate()),
  );
  // What is wrong with the date typed, if anything: outside the range, or
  // under 13. `YYYY-MM-DD` strings sort as the dates they name.
  const birthdateProblem = (): "future" | "early" | "under-age" | null => {
    const value = birthdate();
    if (!BIRTHDATE_RE.test(value)) return null;
    if (value > latestBirthdate) return "future";
    if (value < earliestBirthdate) return "early";
    // The server re-checks the age gate authoritatively (422 on under-13);
    // this is UX only.
    return ageInYears(value) >= MIN_AGE_YEARS ? null : "under-age";
  };
  const birthdateOk = () => BIRTHDATE_RE.test(birthdate()) && birthdateProblem() === null;
  const birthdateLine = () => {
    const problem = birthdateProblem();
    if (problem === "future") return BIRTHDATE_FUTURE;
    if (problem === "early") return BIRTHDATE_EARLY;
    if (problem === "under-age") return `${props.productName} is for users 13 and older`;
    return null;
  };
  const emailMalformed = () => emailLeft() && email() !== "" && !EMAIL_RE.test(email());

  // After a rate limit, Send waits out the minute. The time left is worked out
  // from a deadline on every tick, as `CheckEmailView`'s Resend does, so a tab
  // the browser held in the background shows the true time.
  const [sendWait, setSendWait] = createSignal(0);
  let sendDeadline = 0;
  let sendTimer: ReturnType<typeof setInterval> | undefined;
  function stopSendWait() {
    if (sendTimer !== undefined) clearInterval(sendTimer);
    sendTimer = undefined;
  }
  function tickSendWait() {
    const left = Math.max(0, Math.ceil((sendDeadline - Date.now()) / 1000));
    setSendWait(left);
    if (left === 0) stopSendWait();
  }
  function startSendWait() {
    stopSendWait();
    sendDeadline = Date.now() + SEND_WAIT_MS;
    tickSendWait();
    sendTimer = setInterval(tickSendWait, 1000);
  }
  onCleanup(stopSendWait);

  const detailsValid = () =>
    EMAIL_RE.test(email()) &&
    handleStatus() === "available" &&
    birthdateOk() &&
    (!turnstileOn() || turnstileToken() !== null);

  // What was typed goes into the tab's storage as it is typed, so closing the
  // dialog or reloading keeps it. A date of birth the form would refuse is
  // left out. Once the account is made there is nothing left to keep.
  createEffect(() => {
    const current = step();
    const draftNow = {
      email: email(),
      handle: handle(),
      birthdate: birthdateOk() ? birthdate() : "",
      displayName: displayName(),
    };
    if (current !== "details" && current !== "verify") return;
    writeDraft(draftNow);
  });

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
      if (disposed) handOver(answer, request.requestId);
      else finish(answer, request.requestId);
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
      unshare(request.requestId);
      setLinkError(undefined);
      setLinkStatus("expired");
    } else {
      // The handle went to someone else while the person waited. The request
      // is spent; the details step offers the handle check again, reads the
      // reason out, and puts focus where the person picks another handle.
      writeStored(PENDING_KEY, null);
      unshare(request.requestId);
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
    // An entry left by a request that has expired goes as the view opens.
    readLive();
    // Kept from before: the handle is checked again, since its last answer is
    // old, and a kept address is one the person has already left.
    if (step() === "details") {
      if (handle()) onHandleInput(handle());
      if (email()) setEmailLeft(true);
    }
    window.addEventListener("focus", pollOnReturn);
    document.addEventListener("visibilitychange", pollOnReturn);
    // A resumed wait polls at once: its number is not kept, and the link may
    // have been confirmed while the tab was gone.
    if (waiting()) void pollNow();
  });
  onCleanup(() => {
    disposed = true;
    stopPolling();
    stopLiveTimer();
    window.removeEventListener("focus", pollOnReturn);
    document.removeEventListener("visibilitychange", pollOnReturn);
  });

  // ---------------------------------------------------------------------------
  // The entry the browser's other tabs read
  //
  // While this tab's request lives, the browser keeps its request id, retire
  // secret and expiry in `localStorage` (`osn.signup.live`), and nothing about
  // the address. A tab that begins sends it as `previous`, and osn-api retires
  // the request when that begin is for its address, so the new link goes at
  // once. The retire secret can only end the request; the claim secret never
  // leaves this tab's `sessionStorage`. Every removal names the request it is
  // for, so this tab never removes an entry another tab wrote since.
  // ---------------------------------------------------------------------------

  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  let liveTimerFor: string | undefined;

  function stopLiveTimer() {
    if (liveTimer !== undefined) clearTimeout(liveTimer);
    liveTimer = undefined;
    liveTimerFor = undefined;
  }

  /**
   * Shares `request` with the browser's other tabs, `over` as `writeLive`
   * takes it, and removes it when it expires while this view is open.
   */
  function shareLive(request: Waiting, over: "any" | "own") {
    const retireSecret = request.retireSecret;
    if (!retireSecret) return;
    const written = writeLive(
      { requestId: request.requestId, retireSecret, expiresAt: request.expiresAt },
      over,
    );
    if (!written || disposed) return;
    stopLiveTimer();
    liveTimerFor = request.requestId;
    liveTimer = setTimeout(
      () => {
        liveTimer = undefined;
        liveTimerFor = undefined;
        clearLive(request.requestId);
      },
      Math.max(0, request.expiresAt * 1000 - Date.now()),
    );
  }

  /** Takes `requestId`, which has ended, out of the shared entry. */
  function unshare(requestId: string) {
    if (liveTimerFor === requestId) stopLiveTimer();
    clearLive(requestId);
  }

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
   * begin retires, so the address is free again at once. The shared entry
   * stays: the request still holds the address until a begin retires it, and
   * a tab opened after this one closes can do that.
   */
  function leaveRequest() {
    const request = waiting();
    stopPolling();
    setWaiting(null);
    setPairingCode(undefined);
    writeStored(PENDING_KEY, null);
    if (request) keepPrevious(request);
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

  /** Requests a begin from this view sent as `previous` and had refused. */
  const refusedPrevious = new Set<string>();

  /**
   * What a begin for `typed` sends as `previous`: the request this tab left
   * when it was for that address; else the browser's live sign-up (another
   * tab's, or this one's); else the request this tab left. osn-api retires it
   * only when it is for the address typed, so this begin's link goes at once;
   * for another address it is left alone. Never one this view had refused.
   */
  function previousFor(typed: string): PreviousRegistration | null {
    const usable = (p: PreviousRegistration | null | undefined) =>
      p && !refusedPrevious.has(p.requestId) ? p : null;
    const left = storedPrevious();
    const live = readLive();
    const sameAsLeft = left?.email?.trim().toLowerCase() === typed.trim().toLowerCase();
    return (
      (sameAsLeft ? usable(left?.previous) : null) ??
      usable(live && { requestId: live.requestId, retireSecret: live.retireSecret }) ??
      usable(left?.previous)
    );
  }

  async function submitDetails(e: Event) {
    e.preventDefault();
    if (!detailsValid() || sending() || sendWait() > 0) return;
    setSending(true);
    setDetailsError(null);
    const typed = email();
    const previous = previousFor(typed);
    try {
      const input: Parameters<RegistrationClient["beginRegistration"]>[0] = {
        email: typed,
        handle: handle(),
        birthdate: birthdate(),
        displayName: displayName().trim() || undefined,
        turnstileToken: turnstileToken() ?? undefined,
      };
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
      // Sent once: osn-api retired it, or it is for another address.
      if (previous) forgetPrevious(previous.requestId);
      // A browser token that verified has confirmed the address already: the
      // first poll makes the account, and the person goes straight to the
      // passkey step without a "check your email" screen. Any other answer
      // waits on the link as every sign-up does.
      if (input.emailVerificationToken) {
        const first = await client
          .registrationStatus({ requestId: begun.requestId, claimSecret: begun.claimSecret })
          .catch(() => null);
        if (first?.status === "complete") {
          finish(first, begun.requestId);
          return;
        }
      }
      const request: Waiting = {
        requestId: begun.requestId,
        claimSecret: begun.claimSecret,
        retireSecret: begun.retireSecret,
        expiresAt: begun.expiresAt,
        email: typed,
        handle: handle(),
      };
      waitOn(request, begun.pairingCode);
      shareLive(request, "any");
    } catch (err) {
      // A refusal may be of `previous` itself, as an osn-api of another
      // version reads it, so this view does not send it again, and the
      // request this tab left is forgotten. Another tab's entry stays for that
      // tab. A rate limit or no answer keeps it.
      if (previous && refused(err)) {
        refusedPrevious.add(previous.requestId);
        forgetPrevious(previous.requestId);
      }
      // The server answers a taken email or handle the same as a free one, so
      // this never says which; a 422 is the age gate, a 429 says to wait, and
      // Send waits out the minute with it.
      setDetailsError(describeAuthError(err, "details"));
      if (statusOf(err) === 429) startSendWait();
    } finally {
      // Busy kept focus on Send through the call. A wait that now disables it
      // would drop focus to the page, so it goes to the line saying why.
      const held = document.activeElement === sendButton;
      setSending(false);
      if (held && sendWait() > 0) detailsErrorLine?.focus();
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
      // Back into the shared entry if it has gone, never over another tab's.
      shareLive(request, "own");
      return;
    }
    if (answer.status === "limit") {
      setLinkError(LIMIT_LINE);
      setLinkStatus("error");
      throw new Error(LIMIT_LINE);
    }
    stopPolling();
    writeStored(PENDING_KEY, null);
    unshare(request.requestId);
    setLinkStatus("expired");
    throw new Error("The link expired");
  }

  /**
   * Keeps the new account's session for the passkey step, never publishing
   * it. Until the account has a passkey, osn-api makes that session a
   * restricted one: its token reaches only the passkey-enrolment routes, and
   * its cookie is no signed-in session to `/authorize` or to a `/token` grant
   * for anything but itself (`wiki/osn/passkey-primary.md` §Account-level
   * invariant). Publishing it would announce a signed-in user the app cannot
   * serve; `@musubi/social` would also close its dialog at once, skipping
   * enrolment. `enrollPasskey` publishes the session the cookie renews into
   * once the passkey is in.
   *
   * The account and its handle go into the tab's storage (no token), so a
   * reload, a closed dialog or a closed tab reopens on this step while the
   * session lasts. The draft goes: what it held is now the account's.
   */
  function finish(done: Extract<RegistrationStatus, { status: "complete" }>, requestId: string) {
    stopPolling();
    setWaiting(null);
    setPairingCode(undefined);
    keepAccount(done, requestId);
    setProfileId(done.profileId);
    setAccessToken(done.session.accessToken);
    setRegistered(done.handle);
    toast.success("Email verified");
    setStep("passkey");
  }

  /**
   * What the browser keeps once a sign-up has made its account: the account
   * to add a passkey to (`keepEnrolling`, for every tab, as the cookie is),
   * and nothing of the wait, the request left for retiring, the shared entry
   * for `requestId` or the draft, so no later dialog or tab resumes or retires
   * a request that is spent.
   */
  function keepAccount(
    done: Extract<RegistrationStatus, { status: "complete" }>,
    requestId: string,
  ) {
    writeStored(PENDING_KEY, null);
    writeStored(PREVIOUS_KEY, null);
    forgetDraft();
    clearLive(requestId);
    keepEnrolling({
      profileId: done.profileId,
      handle: done.handle,
      expiresAt: Date.now() + ENROLMENT_WINDOW_MS,
    });
  }

  /**
   * A completing answer that lands after the view is gone — the dialog was
   * closed while the poll was out. The account exists and the answer set the
   * cookie of its restricted session; there is no passkey step to hold the
   * token for, and the token reaches nothing else, so it is dropped. The
   * browser keeps the account, so the next `Register` opens on the passkey
   * step and asks the cookie for a token. Nothing here touches the view.
   */
  function handOver(done: Extract<RegistrationStatus, { status: "complete" }>, requestId: string) {
    keepAccount(done, requestId);
  }

  /**
   * The token the passkey step sends: the one held since the account was
   * made, or, after a reload or once it has expired (`fresh`), one the cookie
   * renews without publishing it. The renewal is the browser's cookie, which
   * another tab may have changed, so it is checked: a refusal, or a token for
   * any other profile, means the sign-up's session has ended (`Ended`); an
   * ordinary token for this profile means its passkey went in elsewhere and
   * the session is a full one already (`AlreadyIn`).
   */
  async function enrolmentToken(fresh: boolean): Promise<string> {
    const held = fresh ? null : accessToken();
    if (held) return held;
    let renewed: Awaited<ReturnType<typeof refreshHeldSession>>;
    try {
      renewed = await refreshHeldSession();
    } catch (err) {
      throw sessionRefused(err) ? new Ended() : err;
    }
    const token = renewed.session.accessToken;
    if (extractJwtSub(token) !== profileId()) throw new Ended();
    if (!isRestrictedToken(token)) throw new AlreadyIn(renewed.session);
    setAccessToken(token);
    return token;
  }

  /**
   * Runs `call` with the enrolment token, renewing it once if osn-api answers
   * 401. A 409 says the session behind the token has ended (`session_stale`).
   */
  async function withEnrolmentToken<T>(call: (token: string) => Promise<T>): Promise<T> {
    const ended = (err: unknown) => (statusOf(err) === 409 ? new Ended() : err);
    try {
      return await call(await enrolmentToken(false));
    } catch (err) {
      if (statusOf(err) !== 401) throw ended(err);
    }
    try {
      return await call(await enrolmentToken(true));
    } catch (err) {
      throw statusOf(err) === 401 ? new Ended() : ended(err);
    }
  }

  /**
   * Enrolls the account's first credential, then signs the user in. The
   * order matters: `adoptSession` is what tells the rest of the app a user
   * is present, and until the credential exists there is no account worth
   * announcing — a failed or abandoned ceremony leaves the user signed out,
   * still on this step, able to try again.
   *
   * Enrolling lifts the session's restriction on the server, but the token in
   * hand stays restricted, so the session is renewed from the cookie and
   * published only when the renewal is this account's ordinary one. Once the
   * passkey is in, a press only tries that renewal again.
   */
  async function enrollPasskey() {
    const id = profileId();
    const name = registered();
    if (!id || !name || enrolling()) return;
    setEnrolling(true);
    setPasskeyError(null);
    try {
      if (!enrolled()) {
        const options = (await withEnrolmentToken((token) =>
          client.passkeyRegisterBegin({ profileId: id, accessToken: token }),
        )) as Parameters<typeof startRegistration>[0]["optionsJSON"];
        const attestation = await startRegistration({ optionsJSON: options });
        await withEnrolmentToken((token) =>
          client.passkeyRegisterComplete({ profileId: id, accessToken: token, attestation }),
        );
        // The account has its passkey: nothing is left to reopen this step
        // for. Only this account's marker goes; another tab's sign-up may have
        // written its own over it since.
        forgetEnrolling(id);
        setEnrolled(true);
      }
      await signIn(name);
    } catch (err) {
      if (err instanceof Ended) {
        forgetEnrolling(id);
        setAccessToken(null);
        setStep("ran-out");
      } else if (err instanceof AlreadyIn) {
        forgetEnrolling(id);
        await publish(err.session, name).catch(() => setStep("added"));
      } else if (enrolled()) {
        setPasskeyError(NOT_SIGNED_IN_LINE);
      } else {
        setPasskeyError(describePasskeyError(err, "registration"));
      }
    } finally {
      setEnrolling(false);
    }
  }

  /**
   * Publishes the session the cookie renews into, now that the account has a
   * passkey, and only this account's ordinary one. A refused renewal, or one
   * that is still restricted or names anyone else, means this browser holds
   * no session for the account (it lapsed, or another tab's renewal moved
   * it): the passkey is in all the same, so the step says to sign in with it.
   * A renewal with no answer throws, and the press tries again.
   */
  async function signIn(name: string) {
    let renewed: Awaited<ReturnType<typeof refreshHeldSession>>;
    try {
      renewed = await refreshHeldSession();
    } catch (err) {
      if (!sessionRefused(err)) throw err;
      setStep("added");
      return;
    }
    const token = renewed.session.accessToken;
    if (isRestrictedToken(token) || extractJwtSub(token) !== profileId()) {
      setStep("added");
      return;
    }
    await publish(renewed.session, name);
  }

  /** Signs the person in with `session`, the account's own ordinary one, and ends the flow. */
  async function publish(session: HeldSession["session"], name: string) {
    setAccessToken(null);
    // Unwrapped on purpose: this is the ordinary session the passkey earned,
    // not the restricted one the step held.
    await adoptSession(session);
    toast.success(`Welcome, @${name}`);
    // "done" comes last, after the session is actually published. It is the
    // one step with no error slot and no retry button, so anything that can
    // still fail has to fail while the passkey step is on screen — and
    // `adoptSession` can: it writes to `localStorage`, which throws when
    // storage is disabled or full.
    setStep("done");
    props.onSuccess?.();
  }

  // The sign-in the ended steps send the person to: the host's, else Cancel,
  // which on a page such as `/authorize` is its "Sign in instead".
  const toSignIn = () => (props.onSignIn ?? props.onCancel)();

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
                // refused one drops it before the wait ends. Held while a
                // rate limit's minute runs, its seconds in the label (in
                // tabular figures, so the centred label does not shift).
                // Described by the agreement line, so a screen reader hears
                // what the send agrees to where it is pressed.
                <Button
                  ref={sendButton}
                  type="submit"
                  {...stepAction(props.host)}
                  busy={sending()}
                  disabled={!sending() && (!detailsValid() || sendWait() > 0)}
                  aria-describedby={agreementId}
                >
                  {sending() ? (
                    "Sending…"
                  ) : sendWait() > 0 ? (
                    <span class={COUNTDOWN_BOX}>
                      <span class={`${COUNTDOWN_CELL} text-center`}>
                        Try again in {sendWait()}s
                      </span>
                      <span aria-hidden="true" class={`${COUNTDOWN_CELL} invisible`}>
                        Try again in 00s
                      </span>
                    </span>
                  ) : (
                    "Send verification link"
                  )}
                </Button>
              }
              links={
                props.onSignIn && (
                  <SwitchLine
                    lead="Already have an account?"
                    action="Sign in"
                    onClick={props.onSignIn}
                    disabled={busyNow()}
                  />
                )
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
                    browser that has the API when the form is submitted. The nonce
                    goes on after the input is in the document: Chrome blanks a
                    nonce attribute set at insertion on a page with a header CSP,
                    and then sees none. */}
                <Show when={verificationNonce()} keyed>
                  {(minted) => {
                    onMount(() => verificationField?.setAttribute("nonce", minted.nonce));
                    return (
                      <input
                        ref={verificationField}
                        type="hidden"
                        name="email-verification-token"
                        autocomplete="email-verification-token"
                      />
                    );
                  }}
                </Show>
              </div>

              {/* The hint stands for the whole time the field shows, so the
                  lowercasing and the characters left out as the person types
                  are never a surprise. */}
              <Field labelTreatment="plain" label="Handle" hint={HANDLE_HINT}>
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
                      invalidMessage={HANDLE_TOO_LONG}
                    />
                    <Show when={handleTaken()}>
                      <Notice tone="danger" size="inline" alert id={handleTakenId}>
                        {CONFLICT_LINE}
                      </Notice>
                    </Show>
                  </>
                )}
              </Field>

              {/* The hint goes once a date is in; a line comes with a date the
                  form refuses — in the future, more than 120 years ago, or
                  under 13 — and the field's own range says the same. */}
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
                      min={earliestBirthdate}
                      max={latestBirthdate}
                      value={birthdate()}
                      onInput={(e) => setBirthdate(e.currentTarget.value)}
                      aria-describedby={describedBy(
                        field["aria-describedby"],
                        birthdateLine() !== null && birthdateErrorId,
                      )}
                      aria-invalid={birthdateLine() !== null || undefined}
                    />
                    <Show when={birthdateLine()}>
                      {(line) => (
                        <Notice tone="danger" size="inline" alert id={birthdateErrorId}>
                          {line()}
                        </Notice>
                      )}
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

              {/* Each link opens a tab of its own, so reading the host's page
                  keeps every field here as typed. Neither is held while the
                  send runs: neither leaves the view. */}
              <p id={agreementId} class="text-ui-sm leading-ui-snug text-ui-ink-secondary">
                By creating an account you agree to the{" "}
                <a
                  href={props.legal.termsHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  class={buttonVariants({ variant: "link", size: "inline" })}
                >
                  Terms of Service
                </a>{" "}
                and acknowledge the{" "}
                <a
                  href={props.legal.privacyHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  class={buttonVariants({ variant: "link", size: "inline" })}
                >
                  Privacy Notice
                </a>
                .
              </p>

              {/* Focus comes here, never by Tab, when a rate limit holds the
                  Send that held it. */}
              <Show when={detailsError()}>
                {(msg) => (
                  <div ref={detailsErrorLine} tabindex="-1" class="focus:outline-none">
                    <Notice tone="danger" size="inline" alert>
                      {msg()}
                    </Notice>
                  </div>
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
                productName={props.productName}
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
              // Once the passkey is in, a press only tries the sign-in again.
              <Button {...stepAction(props.host)} onClick={enrollPasskey} busy={enrolling()}>
                {enrolled()
                  ? enrolling()
                    ? "Signing in…"
                    : "Try again"
                  : enrolling()
                    ? "Waiting for your passkey…"
                    : "Add a passkey"}
              </Button>
            }
          >
            {/* Names the handle the server made the account under, so a
                handle edited after the link went is never silently replaced. */}
            <p class="text-ui-sm leading-ui-snug text-ui-ink-secondary">
              Add a passkey or security key so you can sign back in as{" "}
              <span class="text-ui-ink font-medium wrap-anywhere" translate="no">
                @{registered()}
              </span>
              . This is required to finish creating your account.
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

        {/* Two ends that leave the person signed out with an account: its
            session ran out before a passkey was added, or the passkey is in
            and this browser holds no session for it. Each has one way on,
            sign-in; neither offers the details again, whose address now has
            an account. */}
        <Show when={step() === "ran-out" || step() === "added"}>
          <ViewStep
            host={props.host}
            onCancel={dismiss()}
            action={
              <Button {...stepAction(props.host)} onClick={toSignIn}>
                {step() === "added" ? "Sign in with your new passkey" : "Sign in"}
              </Button>
            }
          >
            {/* The heading takes focus as the end appears: the passkey step's
                button that held it is gone, and nothing else would announce
                the change. */}
            <h3
              ref={(heading) => queueMicrotask(() => heading.focus())}
              tabindex="-1"
              class="text-ui-ink text-ui-base font-medium focus:outline-none"
            >
              {step() === "added" ? ADDED_HEADING : RAN_OUT_HEADING}
            </h3>
            <p class="text-ui-sm leading-ui-snug text-ui-ink-secondary">
              {step() === "added" ? ADDED_LINE : RAN_OUT_LINE}
            </p>
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
