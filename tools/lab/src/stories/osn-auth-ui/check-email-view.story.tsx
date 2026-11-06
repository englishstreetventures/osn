import {
  CheckEmailView,
  type CheckEmailPurpose,
  type CheckEmailStatus,
} from "@osn/auth-ui/CheckEmailView";
import { Card } from "@shared/ui/ui/card";
import { createSignal, For, type JSX, Show } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";
import { Eyebrow, Gallery, Mono } from "../design-system/chrome.tsx";

export const meta = { title: "osn/auth-ui/CheckEmailView", layout: "padded" as const };

/**
 * The screen every emailed-link flow shows while it waits: sign-up, recovery,
 * step-up and email change. One story per state, in a frame the width of
 * musubi's auth dialog (`max-w-sm`) and painted with the dialog's surface. The
 * colours are musubi's, which is the lab's own mapping, so the **light ·
 * dark** toggle (or `?theme=dark`) is the theme check.
 *
 * Resend here is a stub that settles after 600 ms and sends nothing, so
 * "Sending a new link…" can be watched turning into the "new link" sentence.
 */

const EMAIL = "ada@example.com";

const LONG_EMAIL = "alexandria.whitfield-oduya.newsletters@mail.subdomain.example.com";

function stubResend(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 600));
}

/**
 * musubi's auth dialog: a 24rem `Card`, or 20rem for a phone. `Card` paints
 * `ui-surface`, the fill the dialog's `DialogContent` paints, so each theme
 * shows the view on the ground it ships on.
 */
function DialogFrame(props: { children: JSX.Element; width?: "dialog" | "phone" }) {
  return (
    <Card
      padding="lg"
      class={props.width === "phone" ? "w-80 shrink-0" : "w-full max-w-sm shrink-0"}
    >
      {props.children}
    </Card>
  );
}

function state(title: string, intro: JSX.Element, view: () => JSX.Element): Story {
  return {
    name: title,
    render: () => (
      <Gallery title={`osn/auth-ui CheckEmailView — ${title}`} intro={intro}>
        <DialogFrame>{view()}</DialogFrame>
      </Gallery>
    ),
  };
}

export const WaitingBeforeResend = state(
  "waiting, before Resend",
  <>
    Just after the link went out. Resend stays locked for the default 30 seconds and shows the
    seconds left; the countdown sits in the button, outside the live region, so it is never read
    out. Focus is on the heading.
  </>,
  () => (
    <CheckEmailView
      email={EMAIL}
      purpose="sign-up"
      status="waiting"
      onResend={stubResend}
      onChangeEmail={() => {}}
    />
  ),
);

export const WaitingResendReady = state(
  "waiting, Resend ready",
  <>
    The wait is over (<Mono>resendWaitSeconds={"{0}"}</Mono> here). Press Resend: the sentence reads
    "Sending a new link…", then "We sent a new link", and focus moves to the heading. With no wait
    set, Resend is ready again at once.
  </>,
  () => (
    <CheckEmailView
      email={EMAIL}
      purpose="sign-up"
      status="waiting"
      resendWaitSeconds={0}
      onResend={stubResend}
      onChangeEmail={() => {}}
    />
  ),
);

export const Expired = state(
  "expired",
  <>
    The link no longer works. The heading says so, the line about opening it goes, and Resend
    becomes the filled pill, unlocked at once whatever the wait.
  </>,
  () => (
    <CheckEmailView
      email={EMAIL}
      purpose="sign-up"
      status="expired"
      onResend={stubResend}
      onChangeEmail={() => {}}
    />
  ),
);

export const ErrorShown = state(
  "error",
  <>
    The parent's last call failed. Its message joins the sentence inside the live region, as an
    inline danger <Mono>Notice</Mono>; the link already sent still stands.
  </>,
  () => (
    <CheckEmailView
      email={EMAIL}
      purpose="sign-up"
      status="error"
      errorMessage="We couldn't send another link just now. Try again in a few minutes."
      onResend={stubResend}
      onChangeEmail={() => {}}
    />
  ),
);

export const Phone: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui CheckEmailView — a 320px phone"
      intro={
        <>
          The narrowest supported width with a long address. The address breaks where it must and
          nothing scrolls sideways.
        </>
      }
    >
      <div class="flex flex-wrap items-start gap-6">
        <DialogFrame width="phone">
          <CheckEmailView
            email={LONG_EMAIL}
            purpose="sign-up"
            status="waiting"
            onResend={stubResend}
            onChangeEmail={() => {}}
          />
        </DialogFrame>
        <DialogFrame width="phone">
          <CheckEmailView
            email={LONG_EMAIL}
            purpose="recovery"
            status="error"
            errorMessage="We couldn't check for your link. Keep this page open."
            onResend={stubResend}
            onChangeEmail={() => {}}
          />
        </DialogFrame>
      </div>
    </Gallery>
  ),
};

export const WithPairingCode = state(
  "with a number",
  <>
    The host passed <Mono>pairingCode="47"</Mono>. The number sits under the line about the link, at
    musubi's display size in tabular figures, outside the live region, with a hidden "Your number:"
    before it. The page the link opens asks the person to pick it.
  </>,
  () => (
    <CheckEmailView
      email={EMAIL}
      purpose="sign-up"
      status="waiting"
      pairingCode="47"
      onResend={stubResend}
      onChangeEmail={() => {}}
    />
  ),
);

/** A fixed run of numbers, one per request, as a host would get from each begin. */
const NUMBERS = ["47", "83", "12", "65"];

/** Each resend settles with the next request's number already passed, as a host should. */
function NumberedResend() {
  const [turn, setTurn] = createSignal(0);
  async function resend() {
    await stubResend();
    setTurn((n) => n + 1);
  }
  return (
    <CheckEmailView
      email={EMAIL}
      purpose="sign-up"
      status="waiting"
      resendWaitSeconds={0}
      pairingCode={NUMBERS[turn() % NUMBERS.length]}
      onResend={resend}
      onChangeEmail={() => {}}
    />
  );
}

export const WithPairingCodeResendReady = state(
  "with a number, Resend ready",
  <>
    Press Resend: the old number stays while "Sending a new link…" shows, then the next request's
    number replaces it and the announced sentence ends "Check the number again."
  </>,
  () => <NumberedResend />,
);

export const PhoneWithPairingCode: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui CheckEmailView — a 320px phone, with a number"
      intro={
        <>
          The widest number allowed, six digits, beside a long address; and recovery in its error
          state, which keeps the number, since the link already sent still stands.
        </>
      }
    >
      <div class="flex flex-wrap items-start gap-6">
        <DialogFrame width="phone">
          <CheckEmailView
            email={LONG_EMAIL}
            purpose="sign-up"
            status="waiting"
            pairingCode="123456"
            onResend={stubResend}
            onChangeEmail={() => {}}
          />
        </DialogFrame>
        <DialogFrame width="phone">
          <CheckEmailView
            email={LONG_EMAIL}
            purpose="recovery"
            status="error"
            errorMessage="We couldn't check for your link. Keep this page open."
            pairingCode="47"
            onResend={stubResend}
            onChangeEmail={() => {}}
          />
        </DialogFrame>
      </div>
    </Gallery>
  ),
};

const FLOWS: { purpose: CheckEmailPurpose; email?: string; changeEmail: boolean; note: string }[] =
  [
    { purpose: "sign-up", email: EMAIL, changeEmail: true, note: "sign-up" },
    {
      purpose: "recovery",
      email: EMAIL,
      changeEmail: true,
      note: "recovery: promises nothing, since it answers every address alike",
    },
    {
      purpose: "step-up",
      changeEmail: false,
      note: "step-up: the account's own address, not held here, and nothing to change",
    },
    { purpose: "email-change", email: EMAIL, changeEmail: true, note: "email change" },
  ];

export const EveryFlow: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui CheckEmailView — every flow"
      intro={<>The same view under each flow that sends a link, waiting.</>}
    >
      <div class="flex flex-wrap items-start gap-6">
        <For each={FLOWS}>
          {(flow) => (
            <div class="flex w-full max-w-sm flex-col gap-2">
              <Eyebrow>{flow.note}</Eyebrow>
              <DialogFrame>
                <CheckEmailView
                  email={flow.email}
                  purpose={flow.purpose}
                  status="waiting"
                  onResend={stubResend}
                  onChangeEmail={flow.changeEmail ? () => {} : undefined}
                />
              </DialogFrame>
            </div>
          )}
        </For>
      </div>
    </Gallery>
  ),
};

const PURPOSES = [
  "sign-up",
  "recovery",
  "step-up",
  "email-change",
] as const satisfies readonly CheckEmailPurpose[];

const STATUSES = ["waiting", "expired", "error"] as const satisfies readonly CheckEmailStatus[];

interface PlaygroundArgs extends StoryArgs {
  purpose: CheckEmailPurpose;
  status: CheckEmailStatus;
  email: string;
  resendWaitSeconds: number;
  errorMessage: string;
  changeEmail: boolean;
  pairingCode: string;
}

/**
 * The wait is read when one starts, so a new value only shows on a fresh
 * view: the frame below is rebuilt whenever it changes. Clear the address to
 * see the wording with none. A number of one to six digits is drawn; anything
 * else, the empty default included, draws none.
 */
export const Playground: Story<PlaygroundArgs> = {
  args: {
    purpose: "sign-up",
    status: "waiting",
    email: EMAIL,
    resendWaitSeconds: 30,
    errorMessage: "",
    changeEmail: true,
    pairingCode: "",
  },
  controls: {
    purpose: { kind: "select", options: PURPOSES },
    status: { kind: "select", options: STATUSES },
    resendWaitSeconds: { kind: "number", min: 0, max: 120, step: 5 },
  },
  render: (args) => (
    <DialogFrame>
      <Show when={{ wait: args.resendWaitSeconds }} keyed>
        {(key) => (
          <CheckEmailView
            email={args.email || undefined}
            purpose={args.purpose}
            status={args.status}
            errorMessage={args.errorMessage || undefined}
            resendWaitSeconds={key.wait}
            pairingCode={args.pairingCode || undefined}
            onResend={stubResend}
            onChangeEmail={args.changeEmail ? () => {} : undefined}
          />
        )}
      </Show>
    </DialogFrame>
  ),
};
