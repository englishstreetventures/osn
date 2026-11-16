import {
  AccountDeletionRefusedError,
  describeAuthError,
  type AccountDeletionPreview,
} from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { clsx } from "@shared/ui/lib/utils";
import { Button, buttonVariants } from "@shared/ui/ui/button";
import { Card } from "@shared/ui/ui/card";
import { Field } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { Notice } from "@shared/ui/ui/notice";
import { Skeleton } from "@shared/ui/ui/skeleton";
import { Switch as Toggle } from "@shared/ui/ui/switch";
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
 * on step 3, anything else as a line under step 3's buttons.
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
   * window screen in place of the shell before anything else can send a
   * request. One more try if the renewal fails; after that the next request
   * the page sends renews it.
   */
  function enterWindow() {
    void renewSession({ pending: true }).catch(() =>
      renewSession({ pending: true }).catch(() => undefined),
    );
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
                      We delete your account 7 days after you ask, with its profiles and handles,
                      your passkeys and your connections.
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
                  <DeleteEverything on={everything()} onChange={setDeleteEverything} />
                  <div ref={list} class="flex flex-col gap-6">
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
                <Card padding="md" class="flex flex-col gap-4">
                  <p class="text-foreground text-body">
                    We sign you out on your other devices now, and delete your account in 7 days.
                    Until then, you can sign in and keep it.
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
                      <div class="flex items-center gap-2">
                        <span aria-hidden="true" class="text-muted-foreground text-title">
                          @
                        </span>
                        <Input
                          {...field}
                          ref={(el: HTMLInputElement) => (handleField = el)}
                          class="flex-1"
                          value={typed()}
                          onInput={(event) => {
                            setTyped(event.currentTarget.value);
                            if (handleError()) setHandleError(null);
                          }}
                          autocomplete="off"
                          autocapitalize="none"
                          spellcheck={false}
                          enterkeyhint="go"
                        />
                      </div>
                    )}
                  </Field>
                </Card>
              </div>

              <Show when={problem()} keyed>
                {(current) => (
                  <Notice tone="danger" size="inline" alert>
                    {current.kind === "session" ? (
                      <>
                        For your security, sign in again to finish this.{" "}
                        <InlineButton onClick={() => void signInAgain()}>
                          Sign in again
                        </InlineButton>
                      </>
                    ) : (
                      current.text
                    )}
                  </Notice>
                )}
              </Show>

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

/** "Delete everything": on, no answer is sent, and every app deletes what it can. */
function DeleteEverything(props: { on: boolean; onChange: (on: boolean) => void }) {
  const descriptionId = createUniqueId();
  return (
    <Card padding="md" class="flex flex-col gap-2">
      <Toggle
        label="Delete everything"
        checked={props.on}
        onChange={props.onChange}
        describedBy={descriptionId}
        class="self-start max-md:min-h-11"
      />
      <p id={descriptionId} class="text-muted-foreground text-body">
        Each app deletes what you have there as soon as it can. An organisation still passes to
        another member where there is one.
        <Show when={props.on}> The answers below are not used while this is on.</Show>
      </p>
    </Card>
  );
}

/** The ends of an error line: underlined, in the line's ink (DESIGN.md §Links). */
function InlineButton(props: { onClick: () => void; children: JSX.Element }) {
  return (
    <button
      type="button"
      class="focus-visible:ring-ui-focus cursor-pointer font-medium underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-hidden"
      onClick={() => props.onClick()}
    >
      {props.children}
    </button>
  );
}

function TryAgain(props: { onClick: () => void }) {
  return <InlineButton onClick={props.onClick}>Try again</InlineButton>;
}

/** Step 2 while the apps are asked: the switch's card and two actions' cards. */
function PreviewLoading() {
  return (
    <div aria-busy="true" class="flex flex-col gap-4">
      <Skeleton standsFor="card" height={22} />
      <Skeleton standsFor="line" width={16} height={5} />
      <Skeleton standsFor="card" height={40} />
      <Skeleton standsFor="card" height={40} />
    </div>
  );
}
