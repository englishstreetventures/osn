import { Button } from "@shared/ui/ui/button";
import { Card } from "@shared/ui/ui/card";
import { Notice } from "@shared/ui/ui/notice";
import { createSignal, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js";

import type { CheckEmailPurpose } from "./CheckEmailView";

/** The flows that email a link: the same four the waiting view serves. */
export type ConfirmLinkPurpose = CheckEmailPurpose;

/** What the confirm call answered. A thrown error is the third answer, and can be tried again. */
export type ConfirmOutcome = "confirmed" | "expired";

export interface ConfirmLinkPageProps {
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
   * Makes the confirm call. Called once per press, never otherwise. Resolve
   * `"expired"` for every answer that refuses the link — unknown, wrong
   * secret, used or expired; over HTTP, every 4xx but 429. Throw only when no
   * answer about the link came back (a network failure, a rate limit, a
   * server error): a throw offers Try again, and a refused secret pressed
   * again would spend the attempts the server allows before it wipes the
   * request.
   *
   * The secret goes in the request body, never in a path or query. The host
   * holds it in memory only — never in `sessionStorage`, `localStorage` or a
   * cookie — and keeps it out of anything it throws or logs.
   */
  onConfirm: () => Promise<ConfirmOutcome>;
  /**
   * Shown as Continue once confirmed, only where the host knows the person can
   * carry on in this tab. Absent, the page sends them back to where they began.
   */
  onContinue?: () => void;
}

type Status = "ready" | "confirming" | "confirmed" | "expired" | "error";

const SLOW_AFTER_MS = 10_000;

const ERROR_LINE = "We couldn't confirm this email just now.";

const SLOW_LINE = "This is taking longer than usual. Keep this page open.";

const EXPIRED_HEADING = "This link no longer works";

const EXPIRED_BODY =
  "It has expired or was already used. If you confirmed it already, go back to where you started and carry on. If not, go back and ask for a new link.";

const IF_NOT_ASKED = {
  "sign-up": "If you didn't, close this page and nothing will change.",
  recovery: "If you didn't, close this page and nothing will change.",
  "step-up":
    "If you didn't, someone else may be signed in to your account. Close this page and sign out your other sessions.",
  "email-change": "If you didn't, close this page and nothing will change.",
} as const satisfies Record<ConfirmLinkPurpose, string>;

/** What the device that began can do once this one confirms. */
const FINISH = {
  "sign-up": "finish signing up",
  recovery: "get back into your account",
  "step-up": "finish what you were doing",
  "email-change": "finish changing your email",
} as const satisfies Record<ConfirmLinkPurpose, string>;

/**
 * The page an emailed link opens: "Confirm this email", and one button.
 *
 * One page serves sign-up, recovery, step-up and email change. It is
 * presentational: the host route reads the link, clears its secret from the
 * address bar before anything else on the route can read the URL, and passes
 * `onConfirm`, which makes the confirm `POST`. The page decides when that call
 * may run and what the person sees and hears around it.
 *
 * - **Only a press confirms.** Mail scanners open links before people do, so
 *   nothing on mount, on a prop change or on a timer calls `onConfirm`. The
 *   button disables itself the moment it is pressed, so one press is one call.
 * - **It says who gets what.** The link is often opened on a different device
 *   from the one that asked, and a stranger can ask for someone else's address
 *   and then talk them into pressing Confirm. So each flow's sentence says what
 *   confirming lets the device that asked do, and what to do if you did not ask.
 * - **Three answers.** `confirmed` and `expired` come back from `onConfirm`;
 *   anything thrown, or any other value, is an error that can be tried again.
 *   The error line is fixed: a thrown error's own text is never shown.
 * - **What is said aloud.** One polite `<output>`, mounted from the start and
 *   empty until something changes, says "Confirming…", a slow confirm, the
 *   error and each answer, heading word included. The heading takes focus when
 *   the page appears and on every change, so focus never falls to the page when
 *   the pressed button disables or goes.
 * - **No deadline.** Confirming is a write; abandoning it could offer "Try
 *   again" over an approval that went through. After ten seconds the page only
 *   says it is still working.
 */
export function ConfirmLinkPage(props: ConfirmLinkPageProps) {
  let heading: HTMLHeadingElement | undefined;
  let slowTimer: ReturnType<typeof setTimeout> | undefined;

  const [status, setStatus] = createSignal<Status>("ready");
  const [slow, setSlow] = createSignal(false);

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

  async function confirm() {
    setSlow(false);
    show("confirming");
    slowTimer = setTimeout(() => {
      slowTimer = undefined;
      setSlow(true);
    }, SLOW_AFTER_MS);
    let next: Status = "error";
    try {
      const outcome = await props.onConfirm();
      if (outcome === "confirmed" || outcome === "expired") next = outcome;
    } catch {
      // Shown as the fixed error line; the thrown text never reaches the page.
    }
    stopSlowTimer();
    setSlow(false);
    show(next);
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

  const headingText = () => {
    if (status() === "confirmed") return "Confirmed";
    if (status() === "expired") return EXPIRED_HEADING;
    return "Confirm this email";
  };

  const spoken = () => {
    switch (status()) {
      case "ready":
        return "";
      case "confirming":
        return slow() ? SLOW_LINE : "Confirming…";
      case "error":
        return ERROR_LINE;
      case "confirmed":
        return `Confirmed. ${confirmedSentence()}`;
      case "expired":
        return `${EXPIRED_HEADING}. ${EXPIRED_BODY}`;
    }
  };

  const asking = () => status() === "ready" || status() === "confirming" || status() === "error";

  const buttonLabel = () => {
    if (status() === "confirming") return "Confirming…";
    if (status() === "error") return "Try again";
    return "Confirm";
  };

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
              <Show when={status() === "error"}>
                <Notice tone="danger" size="inline">
                  {ERROR_LINE}
                </Notice>
              </Show>
              <p class="text-ui-sm text-ui-ink-secondary leading-ui-snug">{readySentence()}</p>
              <p class="text-ui-sm text-ui-ink-secondary leading-ui-snug">
                Only confirm if you asked for this. {IF_NOT_ASKED[props.purpose]}
              </p>
              <Show when={slow()}>
                <p class="text-ui-sm text-ui-ink-secondary leading-ui-snug">{SLOW_LINE}</p>
              </Show>
            </Match>
            <Match when={status() === "confirmed"}>
              <p class="text-ui-sm text-ui-ink-secondary leading-ui-snug">{confirmedSentence()}</p>
            </Match>
            <Match when={status() === "expired"}>
              <p class="text-ui-sm text-ui-ink-secondary leading-ui-snug">{EXPIRED_BODY}</p>
            </Match>
          </Switch>
        </div>

        <Show when={asking()}>
          <Button
            type="button"
            size="lg"
            class="w-full max-md:h-11"
            disabled={status() === "confirming"}
            onClick={() => void confirm()}
          >
            {buttonLabel()}
          </Button>
        </Show>
        <Show when={status() === "confirmed" && props.onContinue}>
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
