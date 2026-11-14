import type { RunPasskeyCeremony } from "@osn/auth-ui";
import { StepUpDialog, type StepUpDialogProps } from "@osn/auth-ui/StepUpDialog";
import {
  OsnApiError,
  type StepUpClient,
  type StepUpEmailRequest,
  type StepUpPurpose,
  type StepUpToken,
  type TotpClient,
} from "@osn/client";
import { Button } from "@shared/ui/ui/button";
import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";

import type { Story } from "../../lab/types.ts";
import { Gallery, Mono } from "../design-system/chrome.tsx";

/**
 * The step-up sheet musubi opens from Settings → Security and the account
 * banner. Each story opens the real sheet, `@shared/ui`'s `Dialog`, which
 * portals to `<body>` and covers the lab: press Escape or Cancel to close it,
 * and the story's button to open it again. Below 768px it is a bottom sheet;
 * narrow the window to see that face, or open `Phone`, which frames it at
 * 320px. The colours are musubi's, the lab's own mapping, so the
 * **light · dark** toggle is the theme check.
 *
 * Nothing reaches an issuer: the clients are fixed objects in this file. A call
 * a story waits on never answers; one it shows the answer to answers with a
 * placeholder. A story past the first step presses the sheet's buttons once
 * after it opens, as a person would.
 */
export const meta = { title: "osn/auth-ui/StepUpDialog", layout: "padded" as const };

/** A request that never settles. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

const TOKEN: StepUpToken = { token: "fixture-step-up-token", expiresIn: 300 };

const LINK: StepUpEmailRequest = {
  requestId: "fixture-request",
  claimSecret: "fixture-claim-secret",
  pairingCode: "47",
  expiresAt: 1_900_000_000,
};

/** The request a new link starts, with a number of its own. */
const NEW_LINK: StepUpEmailRequest = {
  requestId: "fixture-request-2",
  claimSecret: "fixture-secret-two",
  pairingCode: "83",
  expiresAt: 1_900_000_000,
};

/** The first link sent, which the first poll finds expired; every later one is new and waits. */
function expiringClient(answers: Partial<StepUpClient> = {}): StepUpClient {
  let sent = 0;
  return client({
    emailBegin: () => Promise.resolve(sent++ === 0 ? LINK : NEW_LINK),
    emailStatus: ({ requestId }) =>
      requestId === LINK.requestId ? Promise.resolve({ status: "expired" }) : never(),
    ...answers,
  });
}

/** Every call waits forever unless the story says otherwise. */
function client(answers: Partial<StepUpClient> = {}): StepUpClient {
  return {
    passkeyBegin: () => Promise.resolve({ options: { challenge: "Zml4dHVyZQ" } }),
    passkeyComplete: () => Promise.resolve(TOKEN),
    emailBegin: () => Promise.resolve(LINK),
    emailStatus: () => never(),
    emailResend: () => never(),
    totpComplete: () => never(),
    ...answers,
  };
}

/** An account with an authenticator app set up. */
const authenticator: TotpClient = {
  status: () =>
    Promise.resolve({ enrolled: true, label: "Phone", lastUsedAt: null, createdAt: 1_700_000_000 }),
  enrollBegin: () => never(),
  enrollComplete: () => never(),
  disable: () => never(),
};

/** The passkey prompt answered: a signed assertion, every field a placeholder. */
const passingCeremony: RunPasskeyCeremony = () =>
  Promise.resolve({
    id: "fixture-credential",
    rawId: "fixture-credential",
    response: {
      clientDataJSON: "Zml4dHVyZQ",
      authenticatorData: "Zml4dHVyZQ",
      signature: "Zml4dHVyZQ",
    },
    clientExtensionResults: {},
    type: "public-key",
  });

/** The passkey prompt open, never answered. */
const heldCeremony: RunPasskeyCeremony = () => never();

/** The passkey prompt closed by the person, as the browser reports it. */
const refusedCeremony: RunPasskeyCeremony = () =>
  Promise.reject(Object.assign(new Error("fixture"), { name: "NotAllowedError" }));

const WARNING = "You'll need another credential to sign in. Confirm it's you to remove it.";

/** A step a story takes once the sheet is open: press the button `name`, or type a code. */
type Step = { press: string } | { type: string } | { focusTab: true };

/**
 * The opener, and the sheet open over it. `steps` run once after it opens,
 * each waiting for its button to appear (the authenticator factor shows once
 * its status read lands). Closing the sheet keeps the opener, which opens a
 * fresh one with no steps.
 */
function Bench(props: {
  label: string;
  steps?: readonly Step[];
  sheet: (close: () => void) => JSX.Element;
}) {
  const [open, setOpen] = createSignal(true);
  const [driven, setDriven] = createSignal(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {props.label}
      </Button>
      <Show when={open()}>
        {props.sheet(() => {
          setOpen(false);
          setDriven(true);
        })}
        <Show when={!driven() && props.steps}>{(steps) => <Drive steps={steps()} />}</Show>
      </Show>
    </>
  );
}

/** Takes `step` in the open sheet; false while what it needs has not appeared. */
function take(step: Step): boolean {
  const sheet = document.querySelector('[role="dialog"]');
  if (!sheet) return false;
  if ("press" in step) {
    const button = Array.from(sheet.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === step.press,
    );
    button?.click();
    return button !== undefined;
  }
  if ("type" in step) {
    const box = sheet.querySelector("input");
    if (!box) return false;
    box.value = step.type;
    box.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  // Coming back to the tab polls the emailed link at once.
  window.dispatchEvent(new Event("focus"));
  return true;
}

/** What a step looks for, as the line below names it when it is not found. */
function wanted(step: Step): string {
  if ("press" in step) return `the button "${step.press}"`;
  if ("type" in step) return "the code boxes";
  return "the open sheet";
}

/**
 * Runs `steps` in order, each retried every 50ms for up to two seconds. A step
 * whose button never appears — a label renamed, say — stops the run and says
 * so in a line under the opener, so nobody judges the earlier state the sheet
 * was left in as the one the story names.
 */
function Drive(props: { steps: readonly Step[] }) {
  const [missed, setMissed] = createSignal<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  function run(index: number, tries: number) {
    const step = props.steps[index];
    if (!step) return;
    if (take(step)) timer = setTimeout(() => run(index + 1, 0), 50);
    else if (tries < 40) timer = setTimeout(() => run(index, tries + 1), 50);
    else setMissed(wanted(step));
  }
  // After the sheet's own focus move, which lands a tick after it opens.
  onMount(() => {
    timer = setTimeout(() => run(0, 0), 100);
  });
  return (
    <Show when={missed()}>
      {(what) => (
        <p class="text-ui-danger text-ui-base mt-2" data-drive-missed>
          This story could not find {what()} in the sheet, so the sheet shows an earlier state than
          the story's title.
        </p>
      )}
    </Show>
  );
}

type SheetProps = Omit<StepUpDialogProps, "onToken" | "onCancel">;

/** `props` as a function builds them afresh for each sheet the story opens. */
function state(
  title: string,
  intro: JSX.Element,
  props: SheetProps | (() => SheetProps),
  steps?: readonly Step[],
): Story {
  const fresh = () => (typeof props === "function" ? props() : props);
  return {
    render: () => (
      <Gallery title={`osn/auth-ui StepUpDialog — ${title}`} intro={intro}>
        <Bench
          label="Open the step-up"
          steps={steps}
          sheet={(close) => <StepUpDialog {...fresh()} onToken={close} onCancel={close} />}
        />
      </Gallery>
    ),
  };
}

export const Factors = state(
  "the factors",
  <>
    What opens on "Add passkey": every factor the account has, the passkey first. Press{" "}
    <Mono>Use passkey</Mono> and it closes with a token; the other two go to their steps.
  </>,
  {
    client: client(),
    runPasskeyCeremony: passingCeremony,
    totpClient: authenticator,
    purpose: "passkey_register",
  },
);

export const WithReason = state(
  "with a reason",
  <>
    The host's <Mono>reason</Mono> under the title, as Recovery codes passes it. It is the sheet's
    description, read as it opens.
  </>,
  {
    client: client(),
    runPasskeyCeremony: heldCeremony,
    totpClient: authenticator,
    purpose: "recovery_generate",
    reason: "to generate recovery codes",
  },
);

export const DestructiveWarning = state(
  "a destructive action's warning",
  <>
    Where removing a passkey leads here: the title names the action, the warning says what it costs,
    and the passkey, the only factor <Mono>passkey_delete</Mono> admits, commits it. No red button.
  </>,
  {
    client: client(),
    runPasskeyCeremony: heldCeremony,
    purpose: "passkey_delete",
    title: "Remove Device passkey?",
    warning: WARNING,
  },
);

export const LongPasskeyName = state(
  "a title with a 64-character name",
  <>
    The same, for a passkey whose name is one 64-character word, the longest the rename field takes:
    the title breaks inside the word rather than widen the sheet.
  </>,
  {
    client: client(),
    runPasskeyCeremony: heldCeremony,
    purpose: "passkey_delete",
    title: `Remove ${"x".repeat(64)} passkey?`,
    warning: WARNING,
  },
);

export const PasskeyWaiting = state(
  "waiting for the passkey",
  <>
    "Use passkey" pressed, the prompt open: the button busy with the orb, the other factors and
    Cancel disabled, Escape refused.
  </>,
  {
    client: client(),
    runPasskeyCeremony: heldCeremony,
    totpClient: authenticator,
    purpose: "passkey_register",
  },
  [{ press: "Use passkey" }],
);

export const PasskeyFailed = state(
  "the passkey prompt closed",
  <>The person closed the prompt: the line above the factors, which stay.</>,
  {
    client: client(),
    runPasskeyCeremony: refusedCeremony,
    totpClient: authenticator,
    purpose: "passkey_register",
  },
  [{ press: "Use passkey" }],
);

export const NoCeremony = state(
  "no passkey here",
  <>A host with no ceremony runner: "A passkey can't be used here.", with no retry.</>,
  { client: client(), totpClient: authenticator, purpose: "passkey_register" },
  [{ press: "Use passkey" }],
);

export const PasskeyOnlyWaiting = state(
  "passkey only, waiting",
  <>
    <Mono>passkeyOnly</Mono> (the host cannot send mail): the prompt starts as the sheet opens, and
    the wait is the busy passkey button.
  </>,
  {
    client: client(),
    runPasskeyCeremony: heldCeremony,
    purpose: "recovery_generate",
    passkeyOnly: true,
  },
);

export const PasskeyOnlyRetry = state(
  "passkey only, after a failure",
  <>The prompt was closed: the line, then "Try again".</>,
  {
    client: client(),
    runPasskeyCeremony: refusedCeremony,
    purpose: "recovery_generate",
    passkeyOnly: true,
  },
);

export const PasskeyOnlyWithAuthenticator = state(
  "passkey only, with an authenticator",
  <>An authenticator code needs no mail, so it stays on offer beside "Try again".</>,
  {
    client: client(),
    runPasskeyCeremony: refusedCeremony,
    totpClient: authenticator,
    purpose: "recovery_generate",
    passkeyOnly: true,
  },
);

export const EmailSending = state(
  "sending the link",
  <>"Use email instead" pressed, the send never answering: "Sending…", busy, the rest disabled.</>,
  {
    client: client({ emailBegin: () => never() }),
    runPasskeyCeremony: heldCeremony,
    purpose: "passkey_register",
  },
  [{ press: "Use email instead" }],
);

export const EmailSendFailed = state(
  "the link not sent",
  <>The send refused with a 429: the wait sentence above the factors.</>,
  {
    client: client({
      emailBegin: () => Promise.reject(new OsnApiError("fixture", 429, "rate_limited")),
    }),
    runPasskeyCeremony: heldCeremony,
    purpose: "passkey_register",
  },
  [{ press: "Use email instead" }],
);

export const EmailWaiting = state(
  "waiting on the emailed link",
  <>
    The link sent: the number to type on its page, Resend after 120 seconds, "Use another method"
    back to the factors, and Cancel. Its poll never answers.
  </>,
  {
    client: client(),
    runPasskeyCeremony: heldCeremony,
    totpClient: authenticator,
    purpose: "passkey_register",
  },
  [{ press: "Use email instead" }],
);

export const EmailExpired = state(
  "the emailed link expired",
  <>
    The first poll says the link expired: "Send a new link" at once, which asks for a new request
    (and waits on it, here, for ever).
  </>,
  {
    client: client({ emailStatus: () => Promise.resolve({ status: "expired" }) }),
    runPasskeyCeremony: heldCeremony,
    purpose: "passkey_register",
  },
  [{ press: "Use email instead" }, { focusTab: true }],
);

export const EmailResent = state(
  "a new link sent",
  <>
    The expired link replaced: "Send a new link" pressed, and the new request waits with a number of
    its own, 83, and the words "a new link".
  </>,
  () => ({
    client: expiringClient(),
    runPasskeyCeremony: heldCeremony,
    purpose: "passkey_register",
  }),
  [{ press: "Use email instead" }, { focusTab: true }, { press: "Send a new link" }],
);

export const EmailResendFailed = state(
  "a new link not sent",
  <>
    "Send a new link" pressed and the send failing: "We couldn't send a new link just now. Try again
    in a moment.", and Resend counting down its 120 seconds again.
  </>,
  () => ({
    client: expiringClient({
      emailBegin: (() => {
        let sent = 0;
        return () => (sent++ === 0 ? Promise.resolve(LINK) : Promise.reject(new Error("fixture")));
      })(),
    }),
    runPasskeyCeremony: heldCeremony,
    purpose: "passkey_register",
  }),
  [{ press: "Use email instead" }, { focusTab: true }, { press: "Send a new link" }],
);

export const EmailLimit = state(
  "the server's limit on new links",
  <>
    The live wait, whose Resend the server refuses at its limit. Resend unlocks after 120 seconds, a
    wait this story keeps: leave it open two minutes, press "Resend link", and the line reads "We've
    sent all the links we can for this request. Use the newest one, or cancel and start again."
  </>,
  {
    client: client({ emailResend: () => Promise.resolve({ status: "limit" }) }),
    runPasskeyCeremony: heldCeremony,
    purpose: "passkey_register",
  },
  [{ press: "Use email instead" }],
);

export const Code = state(
  "the authenticator code",
  <>
    "Use your authenticator app" pressed: six boxes, focus in the first, Confirm, "Use another
    method" and Cancel.
  </>,
  {
    client: client(),
    runPasskeyCeremony: heldCeremony,
    totpClient: authenticator,
    purpose: "passkey_register",
  },
  [{ press: "Use your authenticator app" }],
);

export const CodeChecking = state(
  "checking the code",
  <>A code typed and Confirm pressed, never answered: "Checking…", the rest disabled.</>,
  {
    client: client(),
    runPasskeyCeremony: heldCeremony,
    totpClient: authenticator,
    purpose: "passkey_register",
  },
  [{ press: "Use your authenticator app" }, { type: "123456" }, { press: "Confirm" }],
);

export const CodeRefused = state(
  "the code refused",
  <>A 400 for the code: the line under the boxes, tied to them, and the boxes marked invalid.</>,
  {
    client: client({
      totpComplete: () => Promise.reject(new OsnApiError("fixture", 400, "invalid_request")),
    }),
    runPasskeyCeremony: heldCeremony,
    totpClient: authenticator,
    purpose: "passkey_register",
  },
  [{ press: "Use your authenticator app" }, { type: "123456" }, { press: "Confirm" }],
);

export const CodeRateLimited = state(
  "too many codes",
  <>A 429: the wait sentence under the boxes, which are not marked invalid.</>,
  {
    client: client({
      totpComplete: () => Promise.reject(new OsnApiError("fixture", 429, "rate_limited")),
    }),
    runPasskeyCeremony: heldCeremony,
    totpClient: authenticator,
    purpose: "passkey_register",
  },
  [{ press: "Use your authenticator app" }, { type: "123456" }, { press: "Confirm" }],
);

const PHONE_STORIES = ["Factors", "EmailWaiting", "Code", "LongPasskeyName"] as const;

/**
 * The sheet face shows only on a screen narrower than 768px, so each frame
 * here is the lab itself, bare, in a 320px window. Frames load when asked:
 * each is a second copy of the lab.
 */
export const Phone: Story = {
  render: () => {
    const [shown, setShown] = createSignal(false);
    return (
      <Gallery
        title="osn/auth-ui StepUpDialog — a 320px phone"
        intro={
          <>
            The bottom sheet on the narrowest supported phone: the factors, the emailed link's wait,
            the code step and a title with a 64-character passkey name, each the story of that name
            in a 320 × 640 frame. The keyboard is not drawn: open the code step on a phone to see
            what it covers.
          </>
        }
      >
        <Show
          when={shown()}
          fallback={
            <Button variant="outline" onClick={() => setShown(true)}>
              Load the four frames
            </Button>
          }
        >
          <div class="flex flex-wrap gap-4">
            <For each={PHONE_STORIES}>
              {(name) => (
                <iframe
                  title={`StepUpDialog ${name} at 320px`}
                  src={`?bare#/osn/auth-ui/StepUpDialog/${name}`}
                  width="320"
                  height="640"
                  class="border-ui-hairline rounded-ui-md border"
                />
              )}
            </For>
          </div>
        </Show>
      </Gallery>
    );
  },
};

type PlaygroundArgs = {
  purpose: StepUpPurpose;
  passkeyOnly: boolean;
  authenticator: boolean;
  passkey: "succeeds" | "held" | "refused" | "none";
  title: string;
  reason: string;
  warning: string;
};

const PURPOSES = [
  "passkey_register",
  "passkey_delete",
  "totp_enroll",
  "totp_disable",
  "recovery_generate",
  "security_event_ack",
  "email_change",
  "account_delete",
] as const satisfies readonly StepUpPurpose[];

const CEREMONIES = {
  succeeds: passingCeremony,
  held: heldCeremony,
  refused: refusedCeremony,
  none: undefined,
} satisfies Record<PlaygroundArgs["passkey"], RunPasskeyCeremony | undefined>;

export const Playground: Story<PlaygroundArgs> = {
  args: {
    purpose: "passkey_register",
    passkeyOnly: false,
    authenticator: true,
    passkey: "held",
    title: "",
    reason: "",
    warning: "",
  },
  controls: {
    purpose: { kind: "select", options: PURPOSES },
    passkey: { kind: "select", options: Object.keys(CEREMONIES) },
  },
  render: (args) => (
    <Gallery
      title="osn/auth-ui StepUpDialog — playground"
      intro={
        <>
          The ceremony, <Mono>passkeyOnly</Mono>, an authenticator on the account, what the passkey
          prompt does, and the title, reason and warning. A change opens a fresh sheet.
        </>
      }
    >
      <Show
        when={{
          purpose: args.purpose,
          passkeyOnly: args.passkeyOnly,
          authenticator: args.authenticator,
          passkey: args.passkey,
          title: args.title,
          reason: args.reason,
          warning: args.warning,
        }}
        keyed
      >
        {(key) => (
          <Bench
            label="Open the step-up"
            sheet={(close) => (
              <StepUpDialog
                client={client()}
                runPasskeyCeremony={CEREMONIES[key.passkey]}
                totpClient={key.authenticator ? authenticator : undefined}
                purpose={key.purpose}
                passkeyOnly={key.passkeyOnly}
                title={key.title || undefined}
                reason={key.reason || undefined}
                warning={key.warning || undefined}
                onToken={close}
                onCancel={close}
              />
            )}
          />
        )}
      </Show>
    </Gallery>
  ),
};
