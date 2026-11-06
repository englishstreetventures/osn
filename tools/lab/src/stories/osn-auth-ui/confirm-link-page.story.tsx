import {
  ConfirmLinkPage,
  type ConfirmLinkPurpose,
  type ConfirmOutcome,
} from "@osn/auth-ui/ConfirmLinkPage";
import { For, type JSX, onMount, Show } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";
import { Eyebrow, Gallery, Mono } from "../design-system/chrome.tsx";

export const meta = { title: "osn/auth-ui/ConfirmLinkPage", layout: "padded" as const };

/**
 * The page an emailed link opens, for sign-up, recovery, step-up and email
 * change. One story per state, in the column the host route draws around it,
 * as `AuthorizePage`'s `<main>` does (`max-w-md px-6`: a 400px card).
 * The colours are musubi's, which is the lab's own mapping, so the
 * **light · dark** toggle (or `?theme=dark`) is the theme check.
 *
 * The page keeps its own state and moves only when Confirm is pressed, so each
 * story past Ready presses it once after mount (`Pressed`, below). The confirm
 * calls are stubs that send nothing.
 */

const EMAIL = "ada@example.com";

const LONG_EMAIL = "alexandria.whitfield-oduya.newsletters@mail.subdomain.example.com";

const PURPOSES = [
  "sign-up",
  "recovery",
  "step-up",
  "email-change",
] as const satisfies readonly ConfirmLinkPurpose[];

/** A confirm call that answers after 600 ms, so "Confirming…" can be watched. */
function answerAfter(outcome: ConfirmOutcome): Promise<ConfirmOutcome> {
  return new Promise((resolve) => setTimeout(() => resolve(outcome), 600));
}

function failAfter(): Promise<ConfirmOutcome> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("story stub")), 600));
}

/** A confirm call that never answers. */
function never(): Promise<ConfirmOutcome> {
  return new Promise(() => {});
}

/** The first call fails at once, as a dropped connection would; the next confirms. */
function failOnceThenConfirm(): () => Promise<ConfirmOutcome> {
  let calls = 0;
  return () => {
    calls += 1;
    return calls === 1 ? Promise.reject(new Error("story stub")) : answerAfter("confirmed");
  };
}

/** Presses the page's one button after mount, to show a state past Ready. */
function Pressed(props: { children: JSX.Element }) {
  let box: HTMLDivElement | undefined;
  onMount(() => box?.querySelector("button")?.click());
  return <div ref={box}>{props.children}</div>;
}

/** The host route's column, padded as `AuthorizePage`'s `<main>` is. */
function Column(props: { children: JSX.Element }) {
  return <div class="w-full max-w-md px-6">{props.children}</div>;
}

function state(title: string, intro: JSX.Element, page: () => JSX.Element): Story {
  return {
    name: title,
    render: () => (
      <Gallery title={`osn/auth-ui ConfirmLinkPage — ${title}`} intro={intro}>
        <Column>{page()}</Column>
      </Gallery>
    ),
  };
}

export const Ready = state(
  "ready",
  <>
    What the link opens. Nothing is confirmed until Confirm is pressed. Press it: "Confirming…" for
    600 ms, then "Confirmed". Focus is on the heading.
  </>,
  () => (
    <ConfirmLinkPage purpose="sign-up" email={EMAIL} onConfirm={() => answerAfter("confirmed")} />
  ),
);

export const Confirming = state(
  "confirming",
  <>
    A confirm that has not answered. The button is disabled and says so; after 10 seconds a line
    says the page is still working. Nothing cuts the call short.
  </>,
  () => (
    <Pressed>
      <ConfirmLinkPage purpose="sign-up" email={EMAIL} onConfirm={never} />
    </Pressed>
  ),
);

export const Confirmed = state(
  "confirmed",
  <>
    Confirmed on a device that did not begin the flow: the page sends the person back to where they
    started, and draws no button.
  </>,
  () => (
    <Pressed>
      <ConfirmLinkPage
        purpose="sign-up"
        email={EMAIL}
        onConfirm={() => Promise.resolve<ConfirmOutcome>("confirmed")}
      />
    </Pressed>
  ),
);

export const ConfirmedWithContinue = state(
  "confirmed, can continue here",
  <>
    Confirmed where the host knows the person can carry on in this tab (it passes{" "}
    <Mono>onContinue</Mono>): one Continue button.
  </>,
  () => (
    <Pressed>
      <ConfirmLinkPage
        purpose="sign-up"
        email={EMAIL}
        onConfirm={() => Promise.resolve<ConfirmOutcome>("confirmed")}
        onContinue={() => {}}
      />
    </Pressed>
  ),
);

export const Expired = state(
  "expired",
  <>
    The link was unknown, used or out of date; the answer does not say which. No button: the way on
    is where the person started.
  </>,
  () => (
    <Pressed>
      <ConfirmLinkPage
        purpose="sign-up"
        email={EMAIL}
        onConfirm={() => Promise.resolve<ConfirmOutcome>("expired")}
      />
    </Pressed>
  ),
);

export const ErrorRetry = state(
  "error, try again",
  <>
    The confirm call threw. A fixed line in a danger <Mono>Notice</Mono>, never the error's own
    text, and Try again. Press it: this time it confirms after 600 ms.
  </>,
  () => {
    const onConfirm = failOnceThenConfirm();
    return (
      <Pressed>
        <ConfirmLinkPage purpose="sign-up" email={EMAIL} onConfirm={onConfirm} />
      </Pressed>
    );
  },
);

const FLOWS: { purpose: ConfirmLinkPurpose; email?: string; note: string }[] = [
  { purpose: "sign-up", email: EMAIL, note: "sign-up" },
  { purpose: "recovery", note: "recovery: the asking device gets in; every other is signed out" },
  { purpose: "step-up", note: "step-up: an unasked one means someone may hold a session" },
  { purpose: "email-change", email: EMAIL, note: "email change: the link went to the new address" },
];

export const EveryPurpose: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui ConfirmLinkPage — every flow"
      intro={<>Each flow before the press, and after it confirms on another device.</>}
    >
      <div class="flex flex-col gap-8">
        <For each={FLOWS}>
          {(flow) => (
            <div class="flex flex-col gap-2">
              <Eyebrow>{flow.note}</Eyebrow>
              <div class="flex flex-wrap items-start gap-6">
                <Column>
                  <ConfirmLinkPage purpose={flow.purpose} email={flow.email} onConfirm={never} />
                </Column>
                <Column>
                  <Pressed>
                    <ConfirmLinkPage
                      purpose={flow.purpose}
                      email={flow.email}
                      onConfirm={() => Promise.resolve<ConfirmOutcome>("confirmed")}
                    />
                  </Pressed>
                </Column>
              </div>
            </div>
          )}
        </For>
      </div>
    </Gallery>
  ),
};

/**
 * A 320px phone, padded as the host route pads its column (`px-6`), so each
 * card is 272px. Full-screen, so at a 320px viewport the frame is the screen.
 */
export const Phone: Story = {
  layout: "fullscreen",
  render: () => (
    <div class="flex w-80 flex-col gap-6 px-6 py-10">
      <ConfirmLinkPage purpose="sign-up" email={LONG_EMAIL} onConfirm={never} />
      <ConfirmLinkPage purpose="step-up" onConfirm={never} />
      <Pressed>
        <ConfirmLinkPage
          purpose="email-change"
          email={LONG_EMAIL}
          onConfirm={() => Promise.reject(new Error("story stub"))}
        />
      </Pressed>
    </div>
  ),
};

const ANSWERS = ["confirmed", "expired", "throws", "never"] as const;

interface PlaygroundArgs extends StoryArgs {
  purpose: ConfirmLinkPurpose;
  email: string;
  answer: (typeof ANSWERS)[number];
  continueHere: boolean;
}

/**
 * A change to the answer or to "continue here" starts a fresh page, ready to
 * press; a change to the flow or the address does not, so typing an address
 * keeps its focus. Clear the address to see the wording with none.
 */
export const Playground: Story<PlaygroundArgs> = {
  args: { purpose: "sign-up", email: EMAIL, answer: "confirmed", continueHere: false },
  controls: {
    purpose: { kind: "select", options: PURPOSES },
    answer: { kind: "select", options: ANSWERS },
  },
  render: (args) => (
    <Column>
      <Show when={{ answer: args.answer, continueHere: args.continueHere }} keyed>
        {(key) => (
          <ConfirmLinkPage
            purpose={args.purpose}
            email={args.email || undefined}
            onConfirm={() => {
              if (key.answer === "throws") return failAfter();
              if (key.answer === "never") return never();
              return answerAfter(key.answer);
            }}
            onContinue={key.continueHere ? () => {} : undefined}
          />
        )}
      </Show>
    </Column>
  ),
};
