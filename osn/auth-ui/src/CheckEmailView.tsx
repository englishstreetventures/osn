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
 *   address was typed here) "Use a different email". No code box, no other
 *   factor: the dialog around the view draws any way back.
 * - **The wait is read from the clock.** Resend unlocks a set number of
 *   seconds after the view appears and after each accepted press. The time
 *   left is worked out from a deadline on every tick, not counted down, so a
 *   tab the browser held in the background shows the true time on its next
 *   tick. One interval runs at a time.
 * - **What is announced.** The sentence and any error sit in one polite live
 *   region, so a resend, an expiry and an error are read out. The countdown
 *   sits in the Resend button, outside the region, and a disabled button
 *   cannot hold focus, so the seconds are never read out as they change.
 * - **Focus.** The heading takes focus when the view appears, because the form
 *   that sent the link has just gone, and again when a press disables the
 *   focused Resend button, so focus never falls to the page.
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
   */
  status: CheckEmailStatus;
  /** Shown when `status` is `error`. A generic line stands in when it is empty. */
  errorMessage?: string;
  /**
   * Sends a new link. Called once per accepted press. A rejection is the
   * parent's to report, through `status` and `errorMessage`.
   */
  onResend: () => void | Promise<void>;
  /** Back to edit the address. Absent, no button: step-up mails the account's own address. */
  onChangeEmail?: () => void;
  /**
   * Seconds before Resend unlocks, after the view appears and after each
   * press. Defaults to 30. Anything that is not a positive number means no wait.
   */
  resendWaitSeconds?: number;
}

const DEFAULT_WAIT_SECONDS = 30;

const ERROR_FALLBACK = "Something went wrong. Try again in a moment.";

const PURPOSE_LINE = {
  "sign-up": "Open it on any device to finish signing up.",
  recovery: "Open it on any device to get back into your account.",
  "step-up": "Open it on any device to confirm it's you.",
  "email-change": "Open it on any device to confirm your new address.",
} as const satisfies Record<CheckEmailPurpose, string>;

function waitSeconds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_WAIT_SECONDS;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value);
}

export function CheckEmailView(props: CheckEmailViewProps) {
  let heading: HTMLHeadingElement | undefined;

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
    heading?.focus();
    try {
      await props.onResend();
      setResent(true);
    } catch {
      // A failed send is the parent's to report, through `status`.
    } finally {
      setPending(false);
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

  const address = (): JSX.Element =>
    props.email ? (
      <strong class="text-ui-ink font-medium wrap-anywhere">{props.email}</strong>
    ) : (
      "your email address"
    );

  const linkWord = () => (resent() ? "a new link" : "a link");

  return (
    <div class="font-ui-body flex flex-col gap-4">
      <h3
        ref={heading}
        tabindex="-1"
        class="text-ui-base text-ui-ink leading-ui-snug font-medium focus:outline-none"
      >
        {expired() ? "Your link has expired" : "Check your email"}
      </h3>

      <div
        class="flex flex-col gap-2"
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- not `<output>`: it may hold phrasing content only, and this region holds a paragraph and a Notice, which is a `<div>`.
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
              {linkWord()} is on its way.
            </Match>
            <Match when={true}>
              We sent {linkWord()} to {address()}.
            </Match>
          </Switch>
        </p>
        <Show when={props.status === "error"}>
          <Notice tone="danger" size="inline">
            {props.errorMessage?.trim() || ERROR_FALLBACK}
          </Notice>
        </Show>
      </div>

      <Show when={!expired()}>
        <p class="text-ui-sm text-ui-ink-secondary leading-ui-snug">
          {PURPOSE_LINE[props.purpose]} This page will update when you do.
        </p>
      </Show>

      <div class="flex flex-col gap-1">
        <Button
          type="button"
          variant={expired() ? "default" : "ghost"}
          size="sm"
          class="max-md:h-10"
          disabled={!canResend()}
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
            onClick={() => props.onChangeEmail?.()}
          >
            Use a different email
          </Button>
        </Show>
      </div>
    </div>
  );
}
