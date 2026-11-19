import { InlineAction } from "@osn/auth-ui/InlineAction";
import {
  AccountDeletionRefusedError,
  describeAuthError,
  type AccountDeletionPreview,
} from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { clsx } from "@shared/ui/lib/utils";
import { Button, buttonVariants } from "@shared/ui/ui/button";
import { Card } from "@shared/ui/ui/card";
import { Checkbox } from "@shared/ui/ui/checkbox";
import { Field } from "@shared/ui/ui/field";
import { Notice } from "@shared/ui/ui/notice";
import { Skeleton } from "@shared/ui/ui/skeleton";
import { UsernameInput } from "@shared/ui/ui/username-input";
import { A } from "@solidjs/router";
import {
  batch,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Match,
  Show,
  Switch,
  type JSX,
} from "solid-js";

import { AccountDataActions } from "../components/AccountDataActions";
import { EmptyNote } from "../components/EmptyNote";
import { OpenActionCard, type ActionMark } from "../components/OpenActionCard";
import { ResponsiveSkeleton } from "../components/ResponsiveSkeleton";
import { useShellDialogs } from "../components/ShellDialogs";
import { SignedOutNote } from "../components/SignedOutNote";
import {
  appName,
  choicesToSend,
  codeOf,
  groupByApp,
  joinNames,
  keepAnswers,
  missingAnswers,
  statusOf,
  withActions,
  type Answer,
  type Answers,
} from "../lib/account-deletion";
import { PRODUCT_NAME } from "../lib/auth";
import { accountClient } from "../lib/authClients";
import { usePageTitle } from "../lib/page-title";
import { createStepUp } from "../lib/step-up";
import { getTokenClaims } from "../lib/utils";

type Step = 1 | 2 | 3;

/** What step 2 says above the list after the server sent the person back to it. */
type StepNotice = "stale" | "open_actions" | "refused" | "conflict";

const STEP_NOTICE = {
  open_actions: "Answer the items marked below before you go on.",
  refused: "One of your answers can't be used now. Choose again below.",
  conflict: "Your answers couldn't be used. Check them and try again.",
} as const satisfies Record<Exclude<StepNotice, "stale">, string>;

/** Why the last press of "Delete my account" did not go through. */
type Problem = { kind: "line"; text: string } | { kind: "session" };

const HANDLE_MISMATCH = "The handle you typed doesn't match. Check it and try again.";

/**
 * The "Delete everything" card's height in spacing steps, unticked: 104.5px
 * from `md`, and 124px on a 360–430px phone, where its words take a line
 * more (143.5px at 320px, a line more again). Step 2's placeholder stands in
 * it; `tests/components/LoadingShapes.browser.test.tsx` holds both.
 */
const DELETE_EVERYTHING_HEIGHT = { desktop: 26.125, phone: 31 } as const;

/**
 * Settings → Account → "Delete account…": the account's deletion, in three
 * steps on a page of its own, then a step-up.
 *
 * 1. What happens, and a copy of the data first.
 * 2. What each app holds that needs an answer (`getAccountDeletionPreview`),
 *    by app, with the app's own words; or "Delete everything".
 * 3. The handle typed, then `account_delete`'s step-up and `deleteAccount`.
 *
 * A deletion asked for, now or before, turns the session pending at once
 * (`renewSession({ pending: true })`): the shell gives way to the window
 * screen, which is this flow's last state. A refusal lands on the step the
 * person can act on: an answer missing, gone or refused on step 2, the handle
 * on step 3, anything else as a line under step 3's heading.
 */
export function DeleteAccountPage() {
  const { session, profiles, activeProfileId, renewSession, logout } = useAuth();
  const dialogs = useShellDialogs();
  usePageTitle(() => "Delete your account");

  const [step, setStep] = createSignal<Step>(1);
  const [preview, setPreview] = createSignal<AccountDeletionPreview | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [loadError, setLoadError] = createSignal<unknown>(undefined);
  const [answers, setAnswers] = createSignal<Answers>({});
  const [everything, setEverything] = createSignal(false);
  const [marks, setMarks] = createSignal<Readonly<Record<string, ActionMark>>>({});
  const [stepNotice, setStepNotice] = createSignal<StepNotice | null>(null);
  const [typed, setTyped] = createSignal("");
  const [handleError, setHandleError] = createSignal<string | null>(null);
  const [problem, setProblem] = createSignal<Problem | null>(null);
  const [deleting, setDeleting] = createSignal(false);
  const stepUp = createStepUp();

  /** The active profile's handle: what step 3 asks to be typed. */
  const handle = createMemo(
    () =>
      getTokenClaims(session()?.accessToken ?? null).handle ??
      profiles()?.find((profile) => profile.id === activeProfileId())?.handle ??
      null,
  );

  // The step on screen draws its heading into this; a new step takes focus
  // there, so a screen reader hears where it now is.
  let heading: HTMLHeadingElement | undefined;
  let list: HTMLDivElement | undefined;
  let handleField: HTMLInputElement | undefined;

  function goTo(next: Step, focus?: () => HTMLElement | null | undefined) {
    setStep(next);
    (focus?.() ?? heading)?.focus();
  }

  /** The first control of the first action marked, in the order shown. */
  const firstMarked = () =>
    list?.querySelector<HTMLElement>(
      "[data-marked] input:not([disabled]), [data-marked] select:not([disabled])",
    );

  async function loadPreview() {
    if (loading()) return;
    setLoading(true);
    try {
      const fresh = await accountClient.getAccountDeletionPreview();
      batch(() => {
        setPreview(fresh);
        setAnswers((current) => keepAnswers(fresh.open_actions, current));
        setMarks({});
        setLoadError(undefined);
      });
    } catch (err) {
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }

  function toAnswers() {
    goTo(2);
    if (preview() === null) void loadPreview();
  }

  function answer(id: string, next: Answer | null) {
    batch(() => {
      setAnswers((current) => {
        const updated = { ...current };
        if (next) updated[id] = next;
        else delete updated[id];
        return updated;
      });
      setMarks((current) => {
        if (!Object.hasOwn(current, id)) return current;
        const updated = { ...current };
        delete updated[id];
        return updated;
      });
    });
  }

  function setDeleteEverything(on: boolean) {
    batch(() => {
      setEverything(on);
      // The answers stay, for turning it off again; they are not sent while it is on.
      if (on) setMarks({});
    });
  }

  function toConfirm() {
    const current = preview();
    if (!current || current.could_not_check.length > 0) return;
    if (!everything()) {
      const missing = missingAnswers(current.open_actions, answers());
      if (missing.size > 0) {
        setMarks(Object.fromEntries(missing));
        firstMarked()?.focus();
        return;
      }
    }
    batch(() => {
      setMarks({});
      setStepNotice(null);
    });
    goTo(3, () => handleField);
  }

  /**
   * The deletion is asked for: turn the session pending now, which puts the
   * window screen in place of the shell — and of this page — before anything
   * else can send a request. A renewal that fails leaves the page pending
   * (`renewSession`): the window screen's own requests renew it.
   */
  function enterWindow() {
    void renewSession({ pending: true }).catch(() => undefined);
  }

  async function commit(again = false) {
    if (deleting() || stepUp.open()) return;
    const given = typed().trim().replace(/^@/, "");
    if (given === "" || given !== handle()) {
      setHandleError(given === "" ? "Type your handle to confirm." : HANDLE_MISMATCH);
      handleField?.focus();
      return;
    }
    batch(() => {
      setHandleError(null);
      setProblem(null);
    });
    const token = await stepUp.ask({
      purpose: "account_delete",
      title: "Delete your account?",
      warning: again
        ? "Confirm it's you once more to delete your account."
        : "Confirm it's you to delete your account. You have 7 days to change your mind.",
    });
    if (token === null) return;
    setDeleting(true);
    try {
      await accountClient.deleteAccount(
        everything()
          ? { confirmHandle: given, stepUpToken: token, deleteEverything: true }
          : {
              confirmHandle: given,
              stepUpToken: token,
              choices: choicesToSend(preview()?.open_actions ?? [], answers()),
            },
      );
      // Scheduled, by this press or an earlier one (`already_pending`).
      enterWindow();
    } catch (err) {
      setDeleting(false);
      land(err, again);
    }
  }

  /** Puts a refusal where the person can act on it. */
  function land(err: unknown, again: boolean) {
    if (err instanceof AccountDeletionRefusedError) {
      const current = preview() ?? { open_actions: [], could_not_check: [] };
      switch (err.code) {
        case "open_actions": {
          const open = err.openActions ?? [];
          batch(() => {
            setPreview(withActions(current, open));
            setMarks(Object.fromEntries(open.map((action) => [action.id, "unanswered" as const])));
            setStepNotice("open_actions");
          });
          goTo(2, firstMarked);
          return;
        }
        case "stale_choices":
        case "could_not_check": {
          const fresh = err.preview;
          batch(() => {
            if (fresh) {
              setPreview(fresh);
              setAnswers((kept) => keepAnswers(fresh.open_actions, kept));
            }
            setMarks({});
            setStepNotice(err.code === "stale_choices" ? "stale" : null);
          });
          goTo(2);
          if (!fresh) void loadPreview();
          return;
        }
        case "invalid_choice": {
          const id = err.action;
          batch(() => {
            if (id !== undefined) {
              setAnswers((kept) => {
                const updated = { ...kept };
                delete updated[id];
                return updated;
              });
              setMarks({ [id]: "refused" });
            }
            setStepNotice("refused");
          });
          goTo(2, firstMarked);
          return;
        }
      }
    }
    const code = codeOf(err);
    if (code === "choices_with_delete_everything") {
      setStepNotice("conflict");
      goTo(2);
    } else if (code === "handle_mismatch") {
      setHandleError(describeAuthError(err));
      handleField?.focus();
    } else if (code === "step_up_required" && !again) {
      // The token was not taken: ask for a fresh one, once.
      void commit(true);
    } else if (code === "session_stale") {
      setProblem({ kind: "session" });
    } else {
      setProblem({ kind: "line", text: describeAuthError(err) });
    }
  }

  async function signInAgain() {
    await logout();
    await dialogs.load().then(
      () => dialogs.open("sign-in"),
      () => undefined,
    );
  }

  const groups = createMemo(() => groupByApp(preview()?.open_actions ?? []));
  const unreached = () => preview()?.could_not_check ?? [];

  return (
    <main class="mx-auto w-full max-w-2xl px-4 py-6 md:px-8 md:py-8">
      <div class="mb-6">
        <h1 class="text-foreground text-display font-medium">Delete your account</h1>
        <Show when={session()}>
          <p class="text-muted-foreground text-body mt-1">Step {step()} of 3</p>
        </Show>
      </div>

      <Show
        when={session()}
        fallback={<SignedOutNote>Sign in to delete your account.</SignedOutNote>}
      >
        <Switch>
          <Match when={step() === 1}>
            <div class="flex flex-col gap-6">
              <section class="flex flex-col gap-3">
                <StepHeading ref={(el) => (heading = el)}>What happens</StepHeading>
                <Card padding="md">
                  <ul class="text-foreground text-body flex list-disc flex-col gap-2 pl-5">
                    <li>
                      We delete your account once 7 days have passed from when you ask, with its
                      profiles and handles, your passkeys and your connections.
                    </li>
                    <li>
                      Until then, you can sign in and choose Keep my account to stop it. Your
                      profiles and handles come back as they were.
                    </li>
                    <li>When you ask, we sign you out on your other devices.</li>
                    <li>Once your account is deleted, no one can take your handles for 30 days.</li>
                    <li>
                      An app can keep data that other people still rely on, until a date it sets. On
                      the next step, each app says what it keeps.
                    </li>
                  </ul>
                </Card>
              </section>
              <section aria-labelledby="delete-your-data" class="flex flex-col gap-3">
                <h2 id="delete-your-data" class="text-foreground text-title font-medium">
                  Your data
                </h2>
                <Card padding="md" class="flex flex-col gap-3">
                  <p class="text-muted-foreground text-body">
                    Take a copy before you go: download it now, or we email you a link to download
                    it later. The email carries the link, not your data.
                  </p>
                  <AccountDataActions />
                </Card>
              </section>
              <StepActions>
                {/* A way back to Settings, so a link: it opens in a new tab on request. */}
                <A
                  href="/settings#account"
                  class={clsx(buttonVariants({ variant: "secondary", size: "sm" }), "max-md:h-10")}
                >
                  Cancel
                </A>
                <Button size="sm" class="max-md:h-10" onClick={toAnswers}>
                  Continue
                </Button>
              </StepActions>
            </div>
          </Match>

          <Match when={step() === 2}>
            <div class="flex flex-col gap-4">
              {/* The heading and its subtitle, the step's lines, then its
                  cards, 12px apart, as on steps 1 and 3. */}
              <div class="flex flex-col gap-3">
                <div class="flex flex-col gap-1">
                  <StepHeading ref={(el) => (heading = el)}>What needs an answer</StepHeading>
                  <p class="text-muted-foreground text-body">
                    We asked {PRODUCT_NAME} and each app what you have there that needs a decision.
                  </p>
                </div>

                <Show when={stepNotice()}>
                  {(notice) => (
                    <Show
                      when={notice() !== "stale"}
                      fallback={
                        <Notice tone="info" size="sm" alert>
                          Something changed since you last looked. Check your answers below.
                        </Notice>
                      }
                    >
                      <Notice tone="danger" size="inline" alert>
                        {STEP_NOTICE[notice() as Exclude<StepNotice, "stale">]}
                      </Notice>
                    </Show>
                  )}
                </Show>

                <Show when={unreached().length > 0}>
                  <Notice tone="danger" size="inline" alert>
                    {joinNames(unreached().map(appName))} didn't answer, so we can't check what you
                    have there. Your account can't be deleted until{" "}
                    {unreached().length === 1 ? "it does" : "they do"}.{" "}
                    <Show when={!loading()}>
                      <TryAgain onClick={() => void loadPreview()} />
                    </Show>
                  </Notice>
                </Show>

                <Show when={preview() !== null && loadError() !== undefined && !loading()}>
                  <Notice tone="danger" size="inline" alert>
                    We couldn't ask the apps again.{loadDetail(loadError())}
                  </Notice>
                </Show>

                <Show
                  when={preview()}
                  fallback={
                    <Show
                      when={loadError() !== undefined && !loading()}
                      fallback={<PreviewLoading />}
                    >
                      <Notice tone="danger" size="inline" alert>
                        What you have in each app didn't load.
                        {loadDetail(loadError())} <TryAgain onClick={() => void loadPreview()} />
                      </Notice>
                    </Show>
                  }
                >
                  <Show
                    when={groups().length > 0}
                    fallback={
                      <Show when={unreached().length === 0}>
                        <EmptyNote size="section">Nothing else needs an answer.</EmptyNote>
                      </Show>
                    }
                  >
                    {/* "Delete everything", then each app's section, 24px
                        apart, as step 1's sections are. */}
                    <div ref={list} class="flex flex-col gap-6">
                      <DeleteEverything on={everything()} onChange={setDeleteEverything} />
                      <For each={groups()}>
                        {(group) => (
                          <AppSection name={group.name}>
                            <For each={group.actions}>
                              {(action) => (
                                <OpenActionCard
                                  action={action}
                                  answer={answers()[action.id]}
                                  disabled={everything()}
                                  mark={everything() ? undefined : marks()[action.id]}
                                  onAnswer={(next) => answer(action.id, next)}
                                />
                              )}
                            </For>
                          </AppSection>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
              </div>

              <StepActions>
                <Button variant="secondary" size="sm" class="max-md:h-10" onClick={() => goTo(1)}>
                  Back
                </Button>
                <Button
                  size="sm"
                  class="max-md:h-10"
                  disabled={preview() === null || unreached().length > 0}
                  onClick={toConfirm}
                >
                  Continue
                </Button>
              </StepActions>
            </div>
          </Match>

          <Match when={step() === 3}>
            <form
              class="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void commit();
              }}
            >
              <div class="flex flex-col gap-3">
                <StepHeading ref={(el) => (heading = el)}>Confirm</StepHeading>
                {/* Why the last press did not go through: a line about the
                    whole step, under its heading. */}
                <Show when={problem()} keyed>
                  {(current) => (
                    <Notice tone="danger" size="inline" alert>
                      {current.kind === "session" ? (
                        <>
                          For your security, sign in again to finish this.{" "}
                          <InlineAction onClick={() => void signInAgain()}>
                            Sign in again
                          </InlineAction>
                        </>
                      ) : (
                        current.text
                      )}
                    </Notice>
                  )}
                </Show>
                <Card padding="md" class="flex flex-col gap-4">
                  <p class="text-foreground text-body">
                    We sign you out on your other devices now, and delete your account once 7 days
                    have passed. Until then, you can sign in and keep it.
                  </p>
                  <Show when={everything()}>
                    <p class="text-muted-foreground text-body">
                      You chose to delete everything in each app.
                    </p>
                  </Show>
                  <Field
                    labelTreatment="plain"
                    label="Your handle"
                    hint={`Type ${handle() ?? "your handle"} to confirm.`}
                    errors={handleError() ? [handleError()!] : undefined}
                  >
                    {(field) => (
                      <UsernameInput
                        {...field}
                        ref={(el: HTMLInputElement) => (handleField = el)}
                        value={typed()}
                        onInput={(value) => {
                          setTyped(value);
                          if (handleError()) setHandleError(null);
                        }}
                        autocomplete="off"
                        autocapitalize="none"
                        spellcheck={false}
                        enterkeyhint="go"
                      />
                    )}
                  </Field>
                </Card>
              </div>

              <StepActions>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  class="max-md:h-10"
                  disabled={deleting()}
                  onClick={() => goTo(2)}
                >
                  Back
                </Button>
                <Button
                  type="submit"
                  variant="destructive"
                  size="sm"
                  class="max-md:h-10"
                  busy={deleting()}
                >
                  {deleting() ? "Deleting…" : "Delete my account"}
                </Button>
              </StepActions>
            </form>
          </Match>
        </Switch>
        <stepUp.Sheet />
      </Show>
    </main>
  );
}

/** The copy map's sentence after a failed lead, only when it adds something: a wait, or the connection. */
function loadDetail(err: unknown): string {
  const status = statusOf(err);
  return status === 429 || status === 0 ? ` ${describeAuthError(err)}` : "";
}

/** A step's heading. Focus moves to it as the step opens. */
function StepHeading(props: { ref: (el: HTMLHeadingElement) => void; children: JSX.Element }) {
  return (
    // Focus is put here, never reached by Tab, so it draws no focus mark.
    <h2
      ref={props.ref}
      tabIndex={-1}
      class="text-foreground text-title font-medium focus:outline-none"
    >
      {props.children}
    </h2>
  );
}

/** A step's buttons, at its end: Cancel or Back first, then the step's one action. */
function StepActions(props: { children: JSX.Element }) {
  return <div class="flex flex-wrap items-center justify-end gap-2">{props.children}</div>;
}

/** One app's open actions, under its name. */
function AppSection(props: { name: string; children: JSX.Element }) {
  const id = createUniqueId();
  return (
    <section aria-labelledby={id} class="flex flex-col gap-3">
      <h3 id={id} class="text-foreground text-title font-medium">
        {props.name}
      </h3>
      {props.children}
    </section>
  );
}

/**
 * "Delete everything": ticked, no answer is sent, and every app deletes what it
 * can. A box rather than a switch: like each answer below it, it is collected
 * here and sent only when the account is deleted on step 3.
 */
function DeleteEverything(props: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <Card padding="md">
      <Checkbox
        size="sm"
        touch
        checked={props.on}
        onChange={props.onChange}
        label="Delete everything"
        description={
          <>
            Each app deletes what you have there as soon as it can. An organisation still passes to
            another member where there is one.
            <Show when={props.on}> The answers below are not used while this is ticked.</Show>
          </>
        }
      />
    </Card>
  );
}

/** The end of a failed load's line (DESIGN.md §Links). */
function TryAgain(props: { onClick: () => void }) {
  return <InlineAction onClick={props.onClick}>Try again</InlineAction>;
}

/**
 * Step 2 while the apps are asked, in the loaded list's shape: the "Delete
 * everything" card, then 24px to an app's section, its name over two actions'
 * cards 12px apart. The first card's height is the loaded one's; an action's
 * depends on what the app says, so its two blocks are a guess.
 */
function PreviewLoading() {
  return (
    <div aria-busy="true" class="flex flex-col gap-6">
      <ResponsiveSkeleton
        standsFor="card"
        height={DELETE_EVERYTHING_HEIGHT.desktop}
        phoneHeight={DELETE_EVERYTHING_HEIGHT.phone}
      />
      <div class="flex flex-col gap-3">
        <Skeleton standsFor="line" width={16} height={5} />
        <Skeleton standsFor="card" height={40} />
        <Skeleton standsFor="card" height={40} />
      </div>
    </div>
  );
}
