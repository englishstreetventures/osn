import type {
  BegunRegistration,
  PreviousRegistration,
  RegistrationClient,
  RegistrationStatus,
  Session,
} from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { toast } from "@shared/toast";
import { Button } from "@shared/ui/ui/button";
import { InfoPopover } from "@shared/ui/ui/info-popover";
import { Input } from "@shared/ui/ui/input";
import { Label } from "@shared/ui/ui/label";
import { UsernameInput } from "@shared/ui/ui/username-input";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { createSignal, Show, onCleanup, onMount } from "solid-js";

import { CheckEmailView, type CheckEmailStatus } from "./CheckEmailView";
import { TurnstileWidget, turnstileEnabled } from "./TurnstileWidget";

type Step = "details" | "verify" | "passkey" | "done";

/**
 * A sign-up this tab is waiting on: the request, and the address and handle
 * the view names. Not its number, which is never stored: the view holds it in
 * memory, and a reloaded tab gets it back from its first poll.
 */
interface Waiting extends Omit<BegunRegistration, "pairingCode"> {
  readonly email: string;
  readonly handle: string;
}

/**
 * The sign-up this tab waits on, kept in `sessionStorage` so a reload — or a
 * phone discarding the tab while the person reads their mail — resumes the
 * wait rather than losing it. Per tab, never sent anywhere, never shared with
 * another site. No birthdate and no pairing number are kept.
 */
const PENDING_KEY = "osn.signup.pending";
/**
 * A sign-up this tab began and left (Cancel, a different email). The next
 * begin sends it as `previous`, which retires it, so the address is not held
 * by a request nobody waits on.
 */
const PREVIOUS_KEY = "osn.signup.previous";

/** The first poll waits this long after the link is sent; each later one longer, up to the cap. */
const POLL_FIRST_MS = 2_000;
const POLL_GROWTH = 1.5;
const POLL_MAX_MS = 10_000;

const LIMIT_LINE =
  "We've sent all the links we can for this sign-up. Use the newest one, or go back and start again.";
const RESEND_FAILED_LINE = "We couldn't send a new link just now. Try again in a moment.";
const CONFLICT_LINE = "That handle was taken while you waited. Choose another.";

function readStored<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage disabled or full: the wait lives in memory for this page.
  }
}

/** The stored wait, when it is whole and has not expired; clears one that has. */
function storedWaiting(): Waiting | null {
  const stored = readStored<Partial<Waiting>>(PENDING_KEY);
  if (
    !stored ||
    typeof stored.requestId !== "string" ||
    typeof stored.claimSecret !== "string" ||
    typeof stored.email !== "string" ||
    typeof stored.handle !== "string" ||
    typeof stored.expiresAt !== "number"
  ) {
    if (stored) writeStored(PENDING_KEY, null);
    return null;
  }
  if (stored.expiresAt * 1000 <= Date.now()) {
    writeStored(PENDING_KEY, null);
    return null;
  }
  return {
    requestId: stored.requestId,
    claimSecret: stored.claimSecret,
    email: stored.email,
    handle: stored.handle,
    expiresAt: stored.expiresAt,
  };
}

/**
 * Whether this tab is waiting on a sign-up link, so a host can reopen
 * `<Register>` after a reload and let it resume.
 */
export function hasPendingSignUp(): boolean {
  if (typeof sessionStorage === "undefined") return false;
  return storedWaiting() !== null;
}

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

interface RegisterProps {
  client: RegistrationClient;
  onCancel: () => void;
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
   * code" on it (the token rides on `/register/begin`). Omitted/blank ⇒ no
   * widget, no gate (key-optional — matches osn-api skipping siteverify).
   */
  turnstileSiteKey?: string;
  /** Product name shown in this dialog's copy — e.g. "Musubi". */
  productName: string;
}

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
  const [busy, setBusy] = createSignal(false);
  // The request this tab waits on, and what the waiting view says about it.
  const [waiting, setWaiting] = createSignal<Waiting | null>(resumed);
  // The number the waiting view shows: from the begin, or, after a reload,
  // from the first poll. Memory only — never stored, logged or put in a URL.
  const [pairingCode, setPairingCode] = createSignal<string | undefined>(undefined);
  const [linkStatus, setLinkStatus] = createSignal<CheckEmailStatus>("waiting");
  const [linkError, setLinkError] = createSignal<string | undefined>(undefined);
  const [detailsError, setDetailsError] = createSignal<string | null>(null);
  const [profileId, setProfileId] = createSignal<string | null>(null);
  const [accessToken, setAccessToken] = createSignal<string | null>(null);
  // Held, not published, between the account being made and passkey
  // enrollment. See `finish` for why the hand-off to `adoptSession` waits.
  const [session, setSession] = createSignal<Session | null>(null);
  const [passkeyError, setPasskeyError] = createSignal<string | null>(null);
  // Turnstile token — REQUIRED only when a sitekey is provided.
  const [turnstileToken, setTurnstileToken] = createSignal<string | null>(null);
  const turnstileOn = () => turnstileEnabled(props.turnstileSiteKey);
  // Bound to the widget once it mounts; forces a fresh token after the current
  // one is redeemed by `/register/begin` (tokens are single-use — Cloudflare
  // only auto-refreshes on the ~300s expiry, not on consumption).
  let resetTurnstile: (() => void) | undefined;

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
    if (disposed) return;
    // The account exists and this browser holds its session cookie whatever
    // the person did meanwhile, so a completing answer is never dropped.
    if (answer?.status === "complete") {
      finish(answer);
      return;
    }
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
      // is spent; the details step offers the handle check again.
      writeStored(PENDING_KEY, null);
      setWaiting(null);
      setDetailsError(CONFLICT_LINE);
      setStep("details");
      onHandleInput(handle());
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
    if (!detailsValid() || busy()) return;
    setBusy(true);
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
      const begun = await client.beginRegistration(input);
      writeStored(PREVIOUS_KEY, null);
      // Token redeemed by `/begin`; retire it + request a fresh one so a
      // retry after a transient error, or a new sign-up from these details,
      // never replays a single-use token and gets rejected
      // `timeout-or-duplicate`.
      if (turnstileOn()) resetTurnstile?.();
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
      toast.error(err instanceof Error ? err.message : "Could not send the link");
    } finally {
      setBusy(false);
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
    try {
      answer = await client.resendRegistrationLink({
        requestId: request.requestId,
        claimSecret: request.claimSecret,
      });
    } catch (err) {
      setLinkError(RESEND_FAILED_LINE);
      setLinkStatus("error");
      throw err;
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
   * Enrolls the account's first credential, then signs the user in. The
   * order matters: `adoptSession` is what tells the rest of the app a user
   * is present, and until the credential exists there is no account worth
   * announcing — a failed or abandoned ceremony leaves the user signed out,
   * still on this step, able to try again.
   */
  async function enrollPasskey() {
    const id = profileId();
    const token = accessToken();
    if (!id || !token || busy()) return;
    setBusy(true);
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
      const msg = err instanceof Error ? err.message : "Passkey setup failed";
      setPasskeyError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="mx-auto max-w-sm px-4 py-8">
      <div class="mb-6 flex items-center justify-between">
        <h2 class="text-foreground text-2xl font-bold">Create your {props.productName} account</h2>
        <Button variant="ghost" size="sm" onClick={cancel}>
          Cancel
        </Button>
      </div>

      {/* Gate the flow behind WebAuthn support: registration demands an
          enrolled passkey or security key, so there is no path forward from
          a browser without WebAuthn. */}
      <Show
        when={webauthnSupported}
        fallback={
          <div class="flex flex-col gap-4">
            <p class="text-muted-foreground text-sm">
              Creating an account on {props.productName} needs a passkey or security key — something
              this browser doesn&apos;t support. Try a device with WebAuthn (iOS 16+, Android 9+, a
              recent desktop browser), or plug in a FIDO2 security key.
            </p>
          </div>
        }
      >
        <Show when={step() === "details"}>
          <form onSubmit={submitDetails} class="flex flex-col gap-4">
            <div class="flex flex-col gap-1">
              <div class="flex items-center">
                <Label for="reg-email">Email</Label>
                <InfoPopover
                  label="What this address is used for"
                  glyph="i"
                  placement="top"
                  body={emailUses()}
                />
              </div>
              <Input
                id="reg-email"
                type="email"
                required
                autocomplete="email"
                value={email()}
                onInput={(e) => setEmail(e.currentTarget.value)}
              />
              <Show when={email() && !EMAIL_RE.test(email())}>
                <span class="text-destructive text-xs">Please enter a valid email address</span>
              </Show>
            </div>

            <div class="flex flex-col gap-1">
              <Label for="reg-handle">Handle</Label>
              <UsernameInput
                id="reg-handle"
                required
                value={handle()}
                onInput={onHandleInput}
                status={handleStatus()}
                placeholder="lowercase, numbers, _"
                invalidMessage="1–30 chars: lowercase letters, numbers, underscores"
              />
            </div>

            <div class="flex flex-col gap-1">
              <Label for="reg-birthdate">Date of birth</Label>
              <Input
                id="reg-birthdate"
                type="date"
                required
                autocomplete="bday"
                value={birthdate()}
                onInput={(e) => setBirthdate(e.currentTarget.value)}
              />
              <Show when={BIRTHDATE_RE.test(birthdate()) && !birthdateOk()}>
                <span class="text-destructive text-xs">
                  {props.productName} is for users 13 and older
                </span>
              </Show>
              <Show when={!birthdate()}>
                <span class="text-muted-foreground text-xs">
                  You must be 13 or older to use {props.productName}
                </span>
              </Show>
            </div>

            <div class="flex flex-col gap-1">
              <Label for="reg-display-name">Display name (optional)</Label>
              <Input
                id="reg-display-name"
                type="text"
                value={displayName()}
                onInput={(e) => setDisplayName(e.currentTarget.value)}
              />
            </div>

            {/* Turnstile challenge — renders only when a sitekey is provided. */}
            <TurnstileWidget
              siteKey={props.turnstileSiteKey}
              onToken={setTurnstileToken}
              onReady={(c) => (resetTurnstile = c.reset)}
            />

            <Show when={detailsError()}>
              {(line) => <p class="text-destructive text-sm">{line()}</p>}
            </Show>

            <Button type="submit" disabled={!detailsValid() || busy()}>
              {busy() ? "Sending…" : "Send verification link"}
            </Button>
          </form>
        </Show>

        <Show when={step() === "verify" ? waiting() : null}>
          {(request) => (
            <CheckEmailView
              purpose="sign-up"
              email={request().email}
              pairingCode={pairingCode()}
              status={linkStatus()}
              errorMessage={linkError()}
              onResend={resendLink}
              onChangeEmail={backToDetails}
            />
          )}
        </Show>

        <Show when={step() === "passkey"}>
          <div class="flex flex-col gap-4">
            <p class="text-muted-foreground text-sm">
              Enroll a passkey or security key so you can sign back in. This is required to finish
              creating your account.
            </p>
            <Button onClick={enrollPasskey} disabled={busy()}>
              {busy() ? "Setting up…" : "Enroll credential"}
            </Button>
            <Show when={passkeyError()}>
              {(msg) => <p class="text-destructive text-sm">{msg()}</p>}
            </Show>
          </div>
        </Show>

        <Show when={step() === "done"}>
          <p class="text-muted-foreground text-sm">
            You&apos;re all set. Loading {props.productName}…
          </p>
        </Show>
      </Show>
    </div>
  );
}
