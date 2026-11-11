import { Button } from "@shared/ui/ui/button";
import { Card } from "@shared/ui/ui/card";
import { Field } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { Notice } from "@shared/ui/ui/notice";
import {
  batch,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";

import type { CheckEmailPurpose } from "./CheckEmailView";
import { isPairingCode } from "./pairing-code";

/** The flows that email a link: the same four the waiting view serves. */
export type ConfirmLinkPurpose = CheckEmailPurpose;

/**
 * What the confirm call answered: `confirmed` or `expired` for a number,
 * `declined` or `expired` for "I didn't ask for this". A thrown error is the
 * other answer, and can be tried again.
 */
export type ConfirmOutcome = "confirmed" | "expired" | "declined";

/** An answer the host already has when the page opens. */
export type ConfirmLinkOpening = "confirmed" | "expired";

interface ConfirmLinkPageCommonProps {
  /** Which flow sent the link; picks what confirming is said to do. */
  purpose: ConfirmLinkPurpose;
  /**
   * The address the link went to. Absent, the page says "this address". Pass
   * one only from the answer to a call that presented the link's secret: never
   * from the link's URL, which scanners, history and request logs keep, and
   * never from a read keyed by the request id alone, which is in the path and
   * is not secret.
   */
  email?: string;
  /**
   * Makes the confirm call with the number tapped, exactly as given, or with
   * `null` for "I didn't ask for this". Called once per tap or Try again, never
   * otherwise. Resolve `"confirmed"` for an accepted number and `"declined"`
   * for an accepted `null`, and nothing else for either. Resolve `"expired"`
   * for every answer that refuses the link — unknown, wrong secret, a number
   * that is not the one shown, used or expired; over HTTP, every 4xx but 429.
   * Throw only when no answer about the link came back (a network failure, a
   * rate limit, a server error): a throw offers Try again, which sends the same
   * number, or `null`, again.
   *
   * The secret goes in the request body, never in a path or query. The host
   * holds it in memory only — never in `sessionStorage`, `localStorage` or a
   * cookie — and keeps it out of anything it throws or logs.
   */
  onConfirm: (pick: string | null) => Promise<ConfirmOutcome>;
  /**
   * Shown as Continue once confirmed, only where the host knows the person can
   * carry on in this tab. Absent, the page sends them back to where they began.
   */
  onContinue?: () => void;
}

/**
 * The numbers the person picks from, one of them the number the waiting
 * screen shows: three to five, all different, each one to six digits, 0-9
 * (`isPairingCode`). The host passes the list exactly as osn-api sends it,
 * sorted ascending; the waiting screen's number is drawn uniformly from it, so
 * its place in the list says nothing about which is right. The page draws them
 * in this order, exactly as written, and does not know which one is right. Any
 * other list draws the expired page, with nothing to pick. Read them with the
 * link's secret; never log or store them.
 */
type Candidates = readonly string[];

export type ConfirmLinkPageProps = ConfirmLinkPageCommonProps &
  (
    | { candidates: Candidates; initialOutcome?: undefined; typeNumber?: false }
    | {
        /**
         * Opens the page on an answer the host already has — a link opened
         * again after it was confirmed, or a read of the numbers that was
         * refused — with nothing to pick and no call. `candidates` may then be
         * left out.
         */
        initialOutcome: ConfirmLinkOpening;
        candidates?: Candidates;
        typeNumber?: false;
      }
    | {
        /**
         * Asks the person to type the number the waiting screen shows, in one
         * field, instead of picking it: one to six digits, sent exactly as
         * typed. The page draws no numbers in this mode.
         */
        typeNumber: true;
        candidates?: never;
        initialOutcome?: ConfirmLinkOpening;
      }
  );

type Status = "ready" | "confirming" | "confirmed" | "expired" | "declined" | "error";

/** The control that started the call under way, which shows the wait as `Button`'s `busy`. */
type Pressed = "pick" | "confirm" | "decline" | "retry";

const SLOW_AFTER_MS = 10_000;

const FEWEST_CANDIDATES = 3;

const MOST_CANDIDATES = 5;

const PICK_LINE = "Pick the number shown on the screen where you started.";

const TYPE_LINE = "Type the number shown on the screen where you started.";

/** What the field may hold while it is typed into: nothing, or up to six digits. */
const DIGITS_SO_FAR = /^\d{0,6}$/;

const ERROR_LINE = "We couldn't confirm this email just now.";

const DECLINE_ERROR_LINE = "We couldn't cancel this just now.";

const DECLINE_LABEL = "I didn't ask for this";

const DECLINED_HEADING = "Cancelled";

const SLOW_LINE = "This is taking longer than usual. Keep this page open.";

const EXPIRED_HEADING = "This link no longer works";

/**
 * What the refusal says to do next. A sign-up's, recovery's or email
 * change's waiting screen keeps reading "Check your email" after its link is
 * refused here, as it does for an address nobody was mailed, so the way
 * forward is its "Start again", which it shows from the first moment. Step-up's
 * waiting screen learns of the refusal itself and offers a new link.
 */
const EXPIRED_BODY = {
  "sign-up":
    "It has expired or was already used. If you confirmed it already, go back to where you started and carry on. If not, go back to where you started and choose Start again.",
  recovery:
    "It has expired or was already used. If you confirmed it already, go back to where you started and carry on. If not, go back to where you started and choose Start again.",
  "step-up":
    "It has expired or was already used. If you confirmed it already, go back to where you started and carry on. If not, go back and ask for a new link.",
  "email-change":
    "It has expired or was already used. If you confirmed it already, go back to where you started and carry on. If not, go back to where you started and choose Start again.",
} as const satisfies Record<ConfirmLinkPurpose, string>;

const IF_NOT_ASKED = {
  "sign-up": "If you didn't, choose “I didn't ask for this” below.",
  recovery: "If you didn't, choose “I didn't ask for this” below.",
  "step-up":
    "If you didn't, someone else may be signed in to your account. Choose “I didn't ask for this” below, then sign out your other sessions.",
  "email-change": "If you didn't, choose “I didn't ask for this” below.",
} as const satisfies Record<ConfirmLinkPurpose, string>;

/**
 * What the expired page adds for a flow whose unasked link is itself a warning:
 * an unasked step-up means someone else may be signed in, whatever became of
 * the link.
 */
const EXPIRED_WARNING = {
  "sign-up": undefined,
  recovery: undefined,
  "step-up":
    "If you didn't ask for this link, someone else may be signed in to your account, so sign out your other sessions.",
  "email-change": undefined,
} as const satisfies Record<ConfirmLinkPurpose, string | undefined>;

const DECLINED_BODY = {
  "sign-up":
    "Nothing was confirmed. You can close this page. If you did ask for it, go back to where you started and choose Start again.",
  recovery:
    "Nothing was confirmed. You can close this page. If you did ask for it, go back to where you started and choose Start again.",
  "step-up":
    "Nothing was confirmed. Someone else may be signed in to your account, so sign out your other sessions.",
  "email-change":
    "Nothing was confirmed. You can close this page. If you did ask for it, go back to where you started and choose Start again.",
} as const satisfies Record<ConfirmLinkPurpose, string>;

/** What the device that began can do once this one confirms. */
const FINISH = {
  "sign-up": "finish signing up",
  recovery: "get back into your account",
  "step-up": "finish what you were doing",
  "email-change": "finish changing your email",
} as const satisfies Record<ConfirmLinkPurpose, string>;

/** The answers that fit what was sent: a number is confirmed, a decline declined; either can be refused. */
function fits(attempt: string | null, outcome: ConfirmOutcome): boolean {
  if (outcome === "expired") return true;
  return attempt === null ? outcome === "declined" : outcome === "confirmed";
}

/** A list the page can offer: three to five numbers, each well formed, none twice. */
function offerable(candidates: Candidates | undefined): boolean {
  if (candidates === undefined) return false;
  if (candidates.length < FEWEST_CANDIDATES || candidates.length > MOST_CANDIDATES) return false;
  if (!candidates.every((candidate) => isPairingCode(candidate))) return false;
  return new Set(candidates).size === candidates.length;
}

/**
 * The page an emailed link opens: "Confirm this email", the numbers to pick
 * from, and "I didn't ask for this".
 *
 * One page serves sign-up, recovery, step-up and email change. It is
 * presentational: the host route reads the link, clears its secret from the
 * address bar before anything else on the route can read the URL, reads the
 * numbers with that secret, and passes `onConfirm`, which makes the confirm
 * `POST`. The page decides when that call may run and what the person sees
 * and hears around it.
 *
 * - **Only a tap confirms.** Mail scanners open links before people do, so
 *   nothing on mount, on a prop change or on a timer calls `onConfirm`.
 *   Tapping a number is the confirm: it sends that number, the number turns
 *   busy and every other choice disables itself at once, so one tap is one
 *   call.
 * - **The person picks the number the waiting screen shows.** The numbers are
 *   drawn in the order given, as written, in tabular figures and kept from
 *   page translation. The page does not know which is right, and a list it
 *   cannot offer draws the expired page rather than a broken pick.
 * - **Or says they did not ask.** "I didn't ask for this" sends `null`, with no
 *   second step, and a `declined` answer shows "Cancelled". It stays on offer
 *   after an error, as a new attempt of its own.
 * - **It says who gets what.** Each flow's sentence says what confirming lets
 *   the device that asked do, and what to do if you did not ask. Step-up's
 *   expired page keeps its warning to sign out the other sessions.
 * - **The answers.** A number can be `confirmed`, a decline `declined`, and
 *   either `expired`; anything thrown, or any answer that does not fit what
 *   was sent, is an error. Try again sends the same number, or the same
 *   decline, again. The error line is fixed: a thrown error's own text is
 *   never shown. Every refusal shows the same expired page. `initialOutcome`
 *   opens the page on an answer the host already has.
 * - **The wait.** The control that started the call — the number tapped,
 *   Confirm, "I didn't ask for this" or Try again — is `Button`'s `busy` while
 *   it runs: it keeps focus and refuses a press, and the rest are disabled.
 *   Confirm, the decline and Try again read "Confirming…" or "Cancelling…";
 *   a number keeps its digits, and the line under the choices names the wait.
 * - **What is said aloud.** One polite `<output>`, mounted from the start and
 *   empty until something changes, says what is running, a slow call and each
 *   answer, heading word included. The error line is an alert of its own, so
 *   the `<output>` does not say it again. The heading takes focus when the
 *   page appears and on every change after it, except that a busy control
 *   keeps the focus it has, so focus never falls to the page when a choice
 *   disables or goes.
 * - **No deadline.** Confirming is a write; abandoning it could offer "Try
 *   again" over an approval that went through. After ten seconds the page only
 *   says it is still working.
 */
export function ConfirmLinkPage(props: ConfirmLinkPageProps) {
  let heading: HTMLHeadingElement | undefined;
  let slowTimer: ReturnType<typeof setTimeout> | undefined;

  const [status, setStatus] = createSignal<Status>("ready");
  const [slow, setSlow] = createSignal(false);
  // Boxed, because `null` (the decline) is an attempt and `undefined` is none.
  const [attempt, setAttempt] = createSignal<{ pick: string | null }>();
  const [pressed, setPressed] = createSignal<Pressed>();

  const [entry, setEntry] = createSignal("");

  const usable = createMemo(() => offerable(props.candidates));

  const typing = () => props.typeNumber === true;

  const opening = (): ConfirmLinkOpening | undefined =>
    props.initialOutcome === "confirmed" || props.initialOutcome === "expired"
      ? props.initialOutcome
      : undefined;

  /**
   * What the page draws. Until something is sent: the host's opening answer,
   * or, for a list it cannot offer, a link that no longer works.
   */
  const view = (): Status => {
    if (status() !== "ready") return status();
    const open = opening();
    if (open !== undefined) return open;
    if (typing()) return "ready";
    return usable() ? "ready" : "expired";
  };

  const declining = () => attempt()?.pick === null;

  /** Whether `control` started the call under way. */
  const busy = (control: Pressed) => view() === "confirming" && pressed() === control;

  const retrying = () => busy("retry");

  /** The label of a busy Confirm, decline or Try again: the wait it started. */
  const waitLabel = () => (declining() ? "Cancelling…" : "Confirming…");

  function stopSlowTimer() {
    if (slowTimer === undefined) return;
    clearTimeout(slowTimer);
    slowTimer = undefined;
  }

  function show(next: Status) {
    setStatus(next);
    heading?.focus();
  }

  onMount(() => heading?.focus());
  onCleanup(stopSlowTimer);

  async function send(pick: string | null, from: Pressed) {
    batch(() => {
      setAttempt({ pick });
      setPressed(from);
      setSlow(false);
      setStatus("confirming");
    });
    // The control that started the call is busy and keeps focus. Focus left
    // anywhere else, on a choice that has just disabled, goes to the heading.
    if (document.activeElement?.getAttribute("aria-busy") !== "true") heading?.focus();
    slowTimer = setTimeout(() => {
      slowTimer = undefined;
      setSlow(true);
    }, SLOW_AFTER_MS);
    let next: Status = "error";
    try {
      const outcome = await props.onConfirm(pick);
      if (fits(pick, outcome)) next = outcome;
    } catch {
      // Shown as the fixed error line; the thrown text never reaches the page.
    }
    stopSlowTimer();
    setSlow(false);
    show(next);
  }

  function confirmTyped() {
    if (isPairingCode(entry())) void send(entry(), "confirm");
  }

  /**
   * Refuses an insertion that would leave anything but up to six digits in the
   * field, so a stray keystroke or paste does nothing. What is already there is
   * never changed, so the page sends exactly what was typed.
   */
  function refuseNonDigits(event: InputEvent & { currentTarget: HTMLInputElement }) {
    if (!event.inputType.startsWith("insert")) return;
    const input = event.currentTarget;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const inserted = event.data ?? event.dataTransfer?.getData("text/plain") ?? "";
    const next = input.value.slice(0, start) + inserted + input.value.slice(end);
    if (!DIGITS_SO_FAR.test(next)) event.preventDefault();
  }

  /** Enter confirms a valid entry, and never submits a form around the page. */
  function enterConfirms(event: KeyboardEvent) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    confirmTyped();
  }

  function retry() {
    const last = attempt();
    if (last !== undefined) void send(last.pick, "retry");
  }

  const address = (): JSX.Element =>
    props.email ? (
      <strong class="text-ui-ink font-medium wrap-anywhere" translate="no">
        {props.email}
      </strong>
    ) : (
      "this address"
    );

  const readySentence = (): JSX.Element => {
    switch (props.purpose) {
      case "sign-up":
        return <>Confirming lets the device that asked finish signing up with {address()}.</>;
      case "recovery":
        return "Confirming lets the device that asked back into your account. It also signs out every other device.";
      case "step-up":
        return "Confirming lets the device that asked go ahead with something sensitive, such as adding a passkey or deleting the account.";
      case "email-change":
        return <>Confirming sets {address()} as the email of the account that asked.</>;
    }
  };

  const confirmedSentence = () =>
    props.onContinue
      ? `Continue to ${FINISH[props.purpose]}.`
      : `Go back to where you started to ${FINISH[props.purpose]}. You can close this page.`;

  const errorLine = () => (declining() ? DECLINE_ERROR_LINE : ERROR_LINE);

  const headingText = () => {
    if (view() === "confirmed") return "Confirmed";
    if (view() === "declined") return DECLINED_HEADING;
    if (view() === "expired") return EXPIRED_HEADING;
    return "Confirm this email";
  };

  // From the page's own state, not `view()`: an opening answer, or a list it
  // cannot offer, is drawn from the start, and nothing has changed to be said.
  const spoken = () => {
    switch (status()) {
      case "ready":
        return "";
      case "confirming":
        if (slow()) return SLOW_LINE;
        return declining() ? "Cancelling…" : "Confirming…";
      case "error":
        // The error line is an alert of its own.
        return "";
      case "confirmed":
        return `Confirmed. ${confirmedSentence()}`;
      case "declined":
        return `${DECLINED_HEADING}. ${DECLINED_BODY[props.purpose]}`;
      case "expired": {
        const warning = EXPIRED_WARNING[props.purpose];
        const said = `${EXPIRED_HEADING}. ${EXPIRED_BODY[props.purpose]}`;
        return warning ? `${said} ${warning}` : said;
      }
    }
  };

  const asking = () => view() === "ready" || view() === "confirming" || view() === "error";

  // Open after an error too: a person who did not ask must still be able to
  // say so when the last call failed. It sends `null` as a new attempt; Try
  // again repeats the last one.
  const declineButton = () => (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      class="w-full max-md:h-11"
      busy={busy("decline")}
      disabled={!busy("decline") && view() !== "ready" && view() !== "error"}
      onClick={() => void send(null, "decline")}
    >
      {busy("decline") ? waitLabel() : DECLINE_LABEL}
    </Button>
  );

  return (
    <Card padding="lg">
      <div class="font-ui-body flex flex-col gap-6">
        <div class="flex flex-col gap-2">
          <h1
            ref={heading}
            tabindex="-1"
            class="text-ui-base text-ui-ink leading-ui-snug font-medium focus:outline-none"
          >
            {headingText()}
          </h1>
          <Switch>
            <Match when={asking()}>
              <p class="text-ui-sm text-ui-ink-secondary leading-ui-snug">{readySentence()}</p>
              <p class="text-ui-sm text-ui-ink-secondary leading-ui-snug">
                Only confirm if you asked for this. {IF_NOT_ASKED[props.purpose]}
              </p>
            </Match>
            <Match when={view() === "confirmed"}>
              <p class="text-ui-sm text-ui-ink-secondary leading-ui-snug">{confirmedSentence()}</p>
            </Match>
            <Match when={view() === "declined"}>
              <p class="text-ui-sm text-ui-ink-secondary leading-ui-snug">
                {DECLINED_BODY[props.purpose]}
              </p>
            </Match>
            <Match when={view() === "expired"}>
              <p class="text-ui-sm text-ui-ink-secondary leading-ui-snug">
                {EXPIRED_BODY[props.purpose]}
              </p>
              <Show when={EXPIRED_WARNING[props.purpose]}>
                {(warning) => (
                  <p class="text-ui-sm text-ui-ink-secondary leading-ui-snug">{warning()}</p>
                )}
              </Show>
            </Match>
          </Switch>
        </div>

        <Show when={asking()}>
          <Show
            when={typing()}
            fallback={
              <div class="flex flex-col gap-2">
                {/* One column at every width: a number runs to six digits, and
                    five of them do not fit a row of the card. */}
                <fieldset class="flex min-w-0 flex-col gap-2">
                  <legend class="text-ui-sm text-ui-ink-secondary leading-ui-snug mb-2">
                    {PICK_LINE}
                  </legend>
                  <For each={props.candidates}>
                    {(candidate) => {
                      // A number keeps its digits while busy: the line under
                      // the choices says "You picked {n}. Confirming…".
                      const tapped = () => busy("pick") && attempt()?.pick === candidate;
                      return (
                        <Button
                          type="button"
                          variant="outline"
                          class="h-12 w-full"
                          busy={tapped()}
                          disabled={!tapped() && view() !== "ready"}
                          onClick={() => void send(candidate, "pick")}
                        >
                          <span
                            class="text-ui-xl text-ui-ink leading-ui-tight font-medium tabular-nums"
                            translate="no"
                          >
                            {candidate}
                          </span>
                        </Button>
                      );
                    }}
                  </For>
                </fieldset>
                {declineButton()}
              </div>
            }
          >
            <div class="flex flex-col gap-4">
              {/* A plain label, as every auth form field has. Not `OtpInput`:
                  its six boxes are a fixed length, and the number runs from
                  one digit to six, which the page does not know. */}
              <Field labelTreatment="plain" label={TYPE_LINE}>
                {(field) => (
                  <Input
                    {...field}
                    size="touch"
                    face="code"
                    fill="ink"
                    inputmode="numeric"
                    autocomplete="off"
                    spellcheck={false}
                    maxlength="6"
                    translate="no"
                    value={entry()}
                    disabled={view() !== "ready"}
                    onBeforeInput={refuseNonDigits}
                    onInput={(event) => setEntry(event.currentTarget.value)}
                    onKeyDown={enterConfirms}
                  />
                )}
              </Field>
              <div class="flex flex-col gap-2">
                <Show when={view() !== "error" && !retrying()}>
                  <Button
                    type="button"
                    size="lg"
                    class="w-full max-md:h-11"
                    busy={busy("confirm")}
                    disabled={!busy("confirm") && (view() !== "ready" || !isPairingCode(entry()))}
                    onClick={confirmTyped}
                  >
                    {busy("confirm") ? waitLabel() : "Confirm"}
                  </Button>
                </Show>
                {declineButton()}
              </div>
            </div>
          </Show>
        </Show>

        <Show when={view() === "confirming" || view() === "error" ? attempt() : undefined}>
          {(last) => (
            <div class="flex flex-col gap-2">
              {/* A decline's wait is named by the busy control's own label. */}
              <Show when={last().pick}>
                {(pick) => (
                  <p class="text-ui-sm text-ui-ink-secondary leading-ui-snug">
                    {typing() ? "You typed" : "You picked"}{" "}
                    <span class="text-ui-ink font-medium tabular-nums" translate="no">
                      {pick()}
                    </span>
                    .{view() === "confirming" ? " Confirming…" : ""}
                  </p>
                )}
              </Show>
              <Show when={slow()}>
                <p class="text-ui-sm text-ui-ink-secondary leading-ui-snug">{SLOW_LINE}</p>
              </Show>
              <Show when={view() === "error"}>
                <Notice tone="danger" size="inline" alert>
                  {errorLine()}
                </Notice>
              </Show>
            </div>
          )}
        </Show>

        {/* Kept while its own retry runs, so the control that started the
            wait is the one that shows it and keeps focus. */}
        <Show when={view() === "error" || retrying()}>
          <Button
            type="button"
            size="lg"
            class="w-full max-md:h-11"
            busy={retrying()}
            onClick={retry}
          >
            {retrying() ? waitLabel() : "Try again"}
          </Button>
        </Show>
        <Show when={view() === "confirmed" && props.onContinue}>
          <Button
            type="button"
            size="lg"
            class="w-full max-md:h-11"
            onClick={() => props.onContinue?.()}
          >
            Continue
          </Button>
        </Show>

        <output class="sr-only" aria-live="polite" aria-atomic="true">
          {spoken()}
        </output>
      </div>
    </Card>
  );
}
