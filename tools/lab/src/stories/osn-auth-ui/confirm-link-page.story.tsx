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
 * change. The person picks the number the waiting screen shows from the
 * host's list. One story per state, in the column the host route draws around
 * it, as `AuthorizePage`'s `<main>` does (`max-w-md px-6`: a 400px card).
 * The colours are musubi's, which is the lab's own mapping, so the
 * **light · dark** toggle (or `?theme=dark`) is the theme check.
 *
 * The page keeps its own state and moves only when a number or "I didn't ask
 * for this" is pressed, so each story past Ready presses one after mount
 * (`Pressed` and `Declining`, below). The
 * confirm calls are stubs that send nothing. The numbers are fixed examples;
 * a host reads its own with the link's secret.
 */

const EMAIL = "ada@example.com";

const LONG_EMAIL = "alexandria.whitfield-oduya.newsletters@mail.subdomain.example.com";

const THREE = ["4821", "0730", "1956"];

const FIVE_WIDEST = ["804117", "390265", "117943", "652080", "029318"];

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

/** Taps the page's first button, its first number, after mount, to show a state past Ready. */
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
    What the link opens: three numbers, one of them the number on the waiting screen. Nothing is
    confirmed until one is tapped. Tap one: "You picked … Confirming…" for 600 ms, then "Confirmed".
    Focus is on the heading.
  </>,
  () => (
    <ConfirmLinkPage
      purpose="sign-up"
      email={EMAIL}
      candidates={THREE}
      onConfirm={() => answerAfter("confirmed")}
    />
  ),
);

export const ReadyFiveNumbers = state(
  "ready, five six-digit numbers",
  <>
    The most the page offers, at the longest a number can be: five of six digits, one column, in
    tabular figures.
  </>,
  () => (
    <ConfirmLinkPage
      purpose="recovery"
      candidates={FIVE_WIDEST}
      onConfirm={() => answerAfter("confirmed")}
    />
  ),
);

export const Confirming = state(
  "confirming",
  <>
    A confirm that has not answered. Every number is disabled and the page says which was picked;
    after 10 seconds a line says it is still working. Nothing cuts the call short.
  </>,
  () => (
    <Pressed>
      <ConfirmLinkPage purpose="sign-up" email={EMAIL} candidates={THREE} onConfirm={never} />
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
        candidates={THREE}
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
        candidates={THREE}
        onConfirm={() => Promise.resolve<ConfirmOutcome>("confirmed")}
        onContinue={() => {}}
      />
    </Pressed>
  ),
);

export const Expired = state(
  "expired",
  <>
    Every refusal reads the same: a link unknown, used or out of date, a number that was not the one
    shown, or a list the page cannot offer. No button: the way on is where the person started.
  </>,
  () => (
    <Pressed>
      <ConfirmLinkPage
        purpose="sign-up"
        email={EMAIL}
        candidates={THREE}
        onConfirm={() => Promise.resolve<ConfirmOutcome>("expired")}
      />
    </Pressed>
  ),
);

export const ErrorRetry = state(
  "error, try again",
  <>
    The confirm call threw. The numbers stay, disabled, with the one picked; a fixed line in a
    danger <Mono>Notice</Mono>, never the error's own text; and Try again, which sends the same
    number. Press it: this time it confirms after 600 ms.
  </>,
  () => {
    const onConfirm = failOnceThenConfirm();
    return (
      <Pressed>
        <ConfirmLinkPage purpose="sign-up" email={EMAIL} candidates={THREE} onConfirm={onConfirm} />
      </Pressed>
    );
  },
);

/** Presses "I didn't ask for this" after mount, to show the decline's states. */
function Declining(props: { children: JSX.Element }) {
  let box: HTMLDivElement | undefined;
  onMount(() =>
    Array.from(box?.querySelectorAll("button") ?? [])
      .find((button) => button.textContent === "I didn't ask for this")
      ?.click(),
  );
  return <div ref={box}>{props.children}</div>;
}

export const Declined = state(
  "declined",
  <>
    The person pressed "I didn't ask for this" (the host is sent <Mono>null</Mono>, with no second
    step) and the request was ended: "Cancelled", and no button. Step-up's line also tells them to
    sign out their other sessions.
  </>,
  () => (
    <div class="flex flex-col gap-6">
      <Declining>
        <ConfirmLinkPage
          purpose="sign-up"
          email={EMAIL}
          candidates={THREE}
          onConfirm={() => Promise.resolve<ConfirmOutcome>("declined")}
        />
      </Declining>
      <Declining>
        <ConfirmLinkPage
          purpose="step-up"
          candidates={THREE}
          onConfirm={() => Promise.resolve<ConfirmOutcome>("declined")}
        />
      </Declining>
    </div>
  ),
);

export const OpensConfirmed = state(
  "opens on an answer",
  <>
    A link opened again after it was confirmed, and one whose numbers the host could not read: the
    host passes <Mono>initialOutcome</Mono> and no numbers, and the page opens on that answer
    without a call.
  </>,
  () => (
    <div class="flex flex-col gap-6">
      <ConfirmLinkPage purpose="sign-up" initialOutcome="confirmed" onConfirm={never} />
      <ConfirmLinkPage purpose="sign-up" initialOutcome="expired" onConfirm={never} />
    </div>
  ),
);

/** Types `value` into the page's field after mount and presses Confirm, as a person would. */
function TypedIn(props: { value: string; children: JSX.Element }) {
  let box: HTMLDivElement | undefined;
  onMount(() => {
    const input = box?.querySelector("input");
    if (!input) return;
    input.value = props.value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // After the mount's own update, which holds Confirm disabled until it ends.
    queueMicrotask(() =>
      Array.from(box?.querySelectorAll("button") ?? [])
        .find((button) => button.textContent === "Confirm")
        ?.click(),
    );
  });
  return <div ref={box}>{props.children}</div>;
}

export const TypedNumber = state(
  "type the number",
  <>
    Recovery asks for the number to be typed, not picked (the host passes <Mono>typeNumber</Mono>):
    one field for up to six digits, Confirm once it holds one, and "I didn't ask for this". A
    letter, a space or a seventh digit does nothing. Type a number and press Confirm or Enter: "You
    typed … Confirming…", then "Confirmed" after 600 ms.
  </>,
  () => (
    <ConfirmLinkPage
      purpose="recovery"
      email={EMAIL}
      typeNumber
      onConfirm={(pick) => answerAfter(pick === null ? "declined" : "confirmed")}
    />
  ),
);

export const TypedNumberConfirming = state(
  "type the number, confirming",
  <>
    A typed number sent, with no answer yet: the field keeps it, disabled, beside a disabled Confirm
    and decline; the slow line comes after 10 seconds.
  </>,
  () => (
    <TypedIn value="0730">
      <ConfirmLinkPage purpose="recovery" email={EMAIL} typeNumber onConfirm={never} />
    </TypedIn>
  ),
);

export const TypedNumberErrorRetry = state(
  "type the number, error, try again",
  <>
    The call threw. The field keeps "4821", disabled; "You typed 4821."; the danger notice; Try
    again, which sends "4821" again and this time confirms after 600 ms.
  </>,
  () => {
    const onConfirm = failOnceThenConfirm();
    return (
      <TypedIn value="4821">
        <ConfirmLinkPage purpose="recovery" email={EMAIL} typeNumber onConfirm={onConfirm} />
      </TypedIn>
    );
  },
);

export const TypedNumberExpired = state(
  "type the number, expired",
  <>
    The host answered expired, as it does for every refusal, a number that is not the one shown
    included: the same page as any other link that no longer works.
  </>,
  () => (
    <TypedIn value="1956">
      <ConfirmLinkPage
        purpose="recovery"
        email={EMAIL}
        typeNumber
        onConfirm={() => Promise.resolve<ConfirmOutcome>("expired")}
      />
    </TypedIn>
  ),
);

/** Typing the number on a 320px phone: ready, with a long address, and after a throw. */
export const TypedNumberPhone: Story = {
  layout: "fullscreen",
  render: () => (
    <div class="flex w-80 flex-col gap-6 px-6 py-10">
      <ConfirmLinkPage purpose="recovery" email={LONG_EMAIL} typeNumber onConfirm={never} />
      <TypedIn value="123456">
        <ConfirmLinkPage
          purpose="recovery"
          typeNumber
          onConfirm={() => Promise.reject(new Error("story stub"))}
        />
      </TypedIn>
    </div>
  ),
};

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
      intro={<>Each flow before the tap, and after it confirms on another device.</>}
    >
      <div class="flex flex-col gap-8">
        <For each={FLOWS}>
          {(flow) => (
            <div class="flex flex-col gap-2">
              <Eyebrow>{flow.note}</Eyebrow>
              <div class="flex flex-wrap items-start gap-6">
                <Column>
                  <ConfirmLinkPage
                    purpose={flow.purpose}
                    email={flow.email}
                    candidates={THREE}
                    onConfirm={never}
                  />
                </Column>
                <Column>
                  <Pressed>
                    <ConfirmLinkPage
                      purpose={flow.purpose}
                      email={flow.email}
                      candidates={THREE}
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
      <ConfirmLinkPage
        purpose="sign-up"
        email={LONG_EMAIL}
        candidates={FIVE_WIDEST}
        onConfirm={never}
      />
      <ConfirmLinkPage purpose="step-up" candidates={THREE} onConfirm={never} />
      <Pressed>
        <ConfirmLinkPage
          purpose="email-change"
          email={LONG_EMAIL}
          candidates={FIVE_WIDEST}
          onConfirm={() => Promise.reject(new Error("story stub"))}
        />
      </Pressed>
    </div>
  ),
};

const ANSWERS = ["accepts", "refuses", "throws", "never"] as const;

const LISTS = {
  "three of four digits": THREE,
  "four of two digits": ["47", "08", "93", "61"],
  "five of six digits": FIVE_WIDEST,
  "two numbers (cannot offer)": ["47", "08"],
  "a number twice (cannot offer)": ["47", "08", "47"],
} as const satisfies Record<string, readonly string[]>;

const LIST_NAMES = Object.keys(LISTS) as (keyof typeof LISTS)[];

interface PlaygroundArgs extends StoryArgs {
  purpose: ConfirmLinkPurpose;
  email: string;
  numbers: keyof typeof LISTS;
  typeIt: boolean;
  answer: (typeof ANSWERS)[number];
  continueHere: boolean;
}

/**
 * "accepts" confirms a number and declines "I didn't ask for this"; "refuses"
 * answers either as expired. "typeIt" asks for the number to be typed instead
 * of picked, and ignores the list. A change to the numbers, "typeIt", the
 * answer or "continue here" starts a fresh page; a change to the flow or the
 * address does not, so typing an address keeps its focus. Clear the address to
 * see the wording with none.
 */
export const Playground: Story<PlaygroundArgs> = {
  args: {
    purpose: "sign-up",
    email: EMAIL,
    numbers: "three of four digits",
    typeIt: false,
    answer: "accepts",
    continueHere: false,
  },
  controls: {
    purpose: { kind: "select", options: PURPOSES },
    numbers: { kind: "select", options: LIST_NAMES },
    answer: { kind: "select", options: ANSWERS },
  },
  render: (args) => (
    <Column>
      <Show
        when={{
          numbers: args.numbers,
          typeIt: args.typeIt,
          answer: args.answer,
          continueHere: args.continueHere,
        }}
        keyed
      >
        {(key) => {
          const onConfirm = (pick: string | null) => {
            if (key.answer === "throws") return failAfter();
            if (key.answer === "never") return never();
            if (key.answer === "refuses") return answerAfter("expired");
            return answerAfter(pick === null ? "declined" : "confirmed");
          };
          const onContinue = key.continueHere ? () => {} : undefined;
          return (
            <Show
              when={key.typeIt}
              fallback={
                <ConfirmLinkPage
                  purpose={args.purpose}
                  email={args.email || undefined}
                  candidates={LISTS[key.numbers]}
                  onConfirm={onConfirm}
                  onContinue={onContinue}
                />
              }
            >
              <ConfirmLinkPage
                purpose={args.purpose}
                email={args.email || undefined}
                typeNumber
                onConfirm={onConfirm}
                onContinue={onContinue}
              />
            </Show>
          );
        }}
      </Show>
    </Column>
  ),
};
