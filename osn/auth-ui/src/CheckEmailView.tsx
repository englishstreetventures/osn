import { Button } from "@shared/ui/ui/button";
import { Notice } from "@shared/ui/ui/notice";
import {
  createMemo,
  createSignal,
  type JSX,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";

import { isPairingCode } from "./pairing-code";

/**
 * The screen a flow shows after it has emailed a link: "Check your email".
 *
 * One view serves sign-up, recovery, step-up and email change. It is
 * presentational: the parent sends the link, polls for the confirmation, and
 * says through `status` whether the link is still live. The view decides only
 * what the person sees and hears while they wait, and when Resend may be
 * pressed.
 *
 * - **One message, two quiet controls.** A heading, one sentence about the
 *   link, one line saying what opening it does, then Resend and (where the
 *   address was typed here) "Start again", there from the first moment, so a
 *   person whose link page says it no longer works always has a way forward.
 *   No code box, no other factor: the dialog around the view draws any way
 *   back.
 * - **The number.** Where the host passes `pairingCode`, the view draws it
 *   large under the line about the link, with a caption: the page the link
 *   opens asks the person to type it on recovery and step-up, and to pick it
 *   on sign-up and email change. It is display only, never boxed, and is
 *   checked by `isPairingCode`; anything else draws nothing. An expired link
 *   hides it, since its number died with it.
 * - **The wait is read from the clock.** Resend unlocks a set number of
 *   seconds after the view appears and after each accepted press. The time
 *   left is worked out from a deadline on every tick, not counted down, so a
 *   tab the browser held in the background shows the true time on its next
 *   tick. One interval runs at a time.
 * - **What is announced.** The sentence sits in a polite live region, so a
 *   resend and an expiry are read out. An error is an alert of its own under
 *   it, cleared while Resend sends, so a second failure is read out again. The
 *   countdown sits in the Resend button, outside the region, and a disabled
 *   button cannot hold focus, so the seconds are never read out as they
 *   change. The number sits outside the region too, read once in the page's
 *   order with a hidden "Your number:" before it; after a resend the region's
 *   sentence says to check the number again, without naming it.
 * - **The wait for a send.** Resend is busy while the host sends: it keeps
 *   focus and refuses a press, and "Start again" is disabled, so
 *   nothing leaves the view mid-call.
 * - **Focus.** The heading takes focus when the view appears, because the form
 *   that sent the link has just gone, and again when a send ends with Resend
 *   holding focus and the wait disabling it, so focus never falls to the page.
 * - **Recovery promises nothing.** Recovery answers every address the same way,
 *   so its sentences say a link is on its way only if the address has an
 *   account.
 */

export type CheckEmailPurpose = "sign-up" | "recovery" | "step-up" | "email-change";

export type CheckEmailStatus = "waiting" | "expired" | "error";

export interface CheckEmailViewProps {
  /** The address the link went to. Absent, the view says "your email address". */
  email?: string;
  /** Which flow sent the link; picks what opening it is said to do. */
  purpose: CheckEmailPurpose;
  /**
   * `waiting` while the link is live; `expired` once it no longer works, which
   * unlocks a new link at once; `error` beside `errorMessage` when the parent's
   * last call failed.
   *
   * For sign-up and recovery, a host passes the same `status` and
   * `errorMessage` whether or not the address has an account: a request for an
   * address with no account stays `waiting` and expires on the same timer as
   * any other. An error that depends on the caller, such as a rate limit or a
   * failed Turnstile check, may set `error`.
   */
  status: CheckEmailStatus;
  /** Shown when `status` is `error`. A generic line stands in when it is empty. */
  errorMessage?: string;
  /**
   * Sends a new link. Called once per accepted press. A rejection is the
   * parent's to report, through `status` and `errorMessage`.
   */
  onResend: () => void | Promise<void>;
  /**
   * "Start again": back to the address, kept, to send a new request. Absent,
   * no button: step-up mails the account's own address.
   */
  onChangeEmail?: () => void;
  /**
   * Seconds before Resend unlocks, after the view appears and after each
   * press. Defaults to 30. Anything that is not a positive number means no wait.
   */
  resendWaitSeconds?: number;
  /**
   * The number the page the link opens asks the person to type (recovery,
   * step-up) or pick (sign-up, email change), from the request the host
   * began; the view never makes one. Shown only when it is one to six digits,
   * 0-9 (`isPairingCode`); anything else shows nothing. A Resend on a live
   * request keeps its number; an `onResend` that begins a new request passes
   * the new number before it resolves.
   */
  pairingCode?: string;
}

const DEFAULT_WAIT_SECONDS = 30;

const ERROR_FALLBACK = "Something went wrong. Try again in a moment.";

const PURPOSE_LINE = {
  "sign-up": "Open it on any device to finish signing up.",
  recovery: "Open it on any device to get back into your account.",
  "step-up": "Open it on any device to confirm it's you.",
  "email-change": "Open it on any device to confirm your new address.",
} as const satisfies Record<CheckEmailPurpose, string>;

// How the page the link opens asks for the number: recovery's and step-up's
// have the person type it, sign-up's and email change's have them pick it from
// a few. The caption's verb follows.
const PAIRING_MODE = {
  "sign-up": "pick",
  recovery: "type",
  "step-up": "type",
  "email-change": "pick",
} as const satisfies Record<CheckEmailPurpose, "pick" | "type">;

const NUMBER_CAPTION = {
  pick: "Pick this number on the page the link opens.",
  type: "Type this number on the page the link opens.",
} as const satisfies Record<(typeof PAIRING_MODE)[CheckEmailPurpose], string>;

function waitSeconds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_WAIT_SECONDS;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value);
}

export function CheckEmailView(props: CheckEmailViewProps) {
  let heading: HTMLHeadingElement | undefined;
  let resendButton: HTMLButtonElement | undefined;

  const [remaining, setRemaining] = createSignal(0);
  const [pending, setPending] = createSignal(false);
  const [resent, setResent] = createSignal(false);

  let deadline = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  function stopWait() {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  }

  function tick() {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    setRemaining(left);
    if (left === 0) stopWait();
  }

  function startWait() {
    stopWait();
    deadline = Date.now() + waitSeconds(props.resendWaitSeconds) * 1000;
    tick();
    if (remaining() > 0) timer = setInterval(tick, 1000);
  }

  startWait();
  onCleanup(stopWait);
  onMount(() => heading?.focus());

  const expired = () => props.status === "expired";
  const canResend = () => !pending() && (expired() || remaining() === 0);

  async function resendLink() {
    if (!canResend()) return;
    setPending(true);
    setResent(false);
    startWait();
    try {
      await props.onResend();
      setResent(true);
    } catch {
      // A failed send is the parent's to report, through `status`.
    } finally {
      // Busy kept focus on Resend through the send. The wait that started with
      // the press now disables it, which would drop focus to the page.
      const held = document.activeElement === resendButton;
      setPending(false);
      if (held && !canResend()) heading?.focus();
    }
  }

  // Changes only when a wait starts or ends, so the label below is built once
  // per wait and each tick rewrites the seconds' text in place.
  const counting = createMemo(() => remaining() > 0);

  // One span, because `Button` is a flex row with a gap between its children;
  // the seconds take tabular figures so the centred label does not shift as
  // they tick down.
  const resendLabel = (): JSX.Element => {
    if (pending()) return "Sending…";
    if (expired()) return "Send a new link";
    if (counting()) {
      return (
        <span>
          Resend in <span class="tabular-nums">{remaining()}</span>s
        </span>
      );
    }
    return "Resend link";
  };

  // `translate="no"`: a browser's page translation must not rewrite the
  // address the person has to recognise.
  const address = (): JSX.Element =>
    props.email ? (
      <strong class="text-ui-ink font-medium wrap-anywhere" translate="no">
        {props.email}
      </strong>
    ) : (
      "your email address"
    );

  const linkWord = () => (resent() ? "a new link" : "a link");

  const code = createMemo(() => {
    const value = props.pairingCode;
    return isPairingCode(value) ? value : undefined;
  });

  // After a resend the number may have changed, and a screen reader does not
  // hear it change, so the announced sentence sends the person back to it. It
  // never says the number is new: two requests can draw the same one.
  const checkNumber = () => (resent() && code() ? " Check the number again." : "");

  return (
    <div class="font-ui-body flex flex-col gap-4">
      <h3
        ref={heading}
        tabindex="-1"
        class="text-ui-base text-ui-ink leading-ui-snug font-medium focus:outline-none"
      >
        {expired() ? "Your link has expired" : "Check your email"}
      </h3>

      <div class="flex flex-col gap-2">
        <div
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- not `<output>`: it may hold phrasing content only, and this region holds a paragraph.
          role="status"
        >
          <p class="text-ui-sm text-ui-ink-secondary leading-ui-snug">
            <Switch>
              <Match when={pending()}>Sending a new link…</Match>
              <Match when={expired()}>Ask for a new link to {address()}.</Match>
              <Match when={props.purpose === "recovery"}>
                <Show when={props.email} fallback="If that address has an account, ">
                  If {address()} has an account,{" "}
                </Show>
                {linkWord()} is on its way.{checkNumber()}
              </Match>
              <Match when={true}>
                We sent {linkWord()} to {address()}.{checkNumber()}
              </Match>
            </Switch>
          </p>
        </div>
        {/* An alert of its own, outside the status region, so it is read once
            as it appears. Cleared while Resend sends, so a second failure
            mounts it again and is read out again. */}
        <Show when={props.status === "error" && !pending()}>
          <Notice tone="danger" size="inline" alert>
            {props.errorMessage?.trim() || ERROR_FALLBACK}
          </Notice>
        </Show>
      </div>

      <Show when={!expired()}>
        <p class="text-ui-sm text-ui-ink-secondary leading-ui-snug">
          {PURPOSE_LINE[props.purpose]} This page will update when you do.
        </p>
      </Show>

      {/* Outside the live region, so it is read once in the page's order and
          never again when the region changes. The hidden label makes the line
          read "Your number: 47"; the digits alone are kept from page
          translation. */}
      <Show when={!expired() && code()}>
        {(shown) => (
          <div class="flex flex-col gap-1">
            <p class="text-ui-xl text-ui-ink leading-ui-tight font-medium tabular-nums">
              <span class="sr-only">Your number:</span> <span translate="no">{shown()}</span>
            </p>
            <p class="text-ui-sm text-ui-ink-secondary leading-ui-snug">
              {NUMBER_CAPTION[PAIRING_MODE[props.purpose]]}
            </p>
          </div>
        )}
      </Show>

      <div class="flex flex-col gap-1">
        <Button
          ref={resendButton}
          type="button"
          variant={expired() ? "default" : "ghost"}
          size="sm"
          class="max-md:h-10"
          busy={pending()}
          disabled={!pending() && !canResend()}
          onClick={() => void resendLink()}
        >
          {resendLabel()}
        </Button>
        <Show when={props.onChangeEmail}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            class="max-md:h-10"
            disabled={pending()}
            onClick={() => props.onChangeEmail?.()}
          >
            Start again
          </Button>
        </Show>
      </div>
    </div>
  );
}
