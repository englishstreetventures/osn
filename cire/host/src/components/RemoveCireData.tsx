import Button, { proseLinkClass } from "@cire/ui/button";
import { cardClass } from "@cire/ui/card";
import Eyebrow from "@cire/ui/eyebrow";
import Loading from "@cire/ui/loading";
import { useAuth } from "@shared/rp-auth/solid";
import { Checkbox } from "@shared/ui/ui/checkbox";
import { EmptyState } from "@shared/ui/ui/empty-state";
import { Notice, type NoticeTone } from "@shared/ui/ui/notice";
import {
  batch,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";

import {
  beginRemovalConfirmation,
  forgetRemoval,
  keepAnswers,
  keptAnswers,
  keptCode,
  loadRemovalPlan,
  type KeptAnswers,
  type RemovalAction,
  RemovalError,
  type RemovalFailure,
  type RemovalPlan,
  type RemovalRole,
  type RemovalWedding,
  removeCireData,
} from "../lib/account-removal";
import { isAuthExpired, navigateTo, redirectToLogin } from "../lib/api";
import { serializeRoute } from "../lib/dashboard-route";
import { followInApp, type InAppLink } from "../lib/link-click";
import { haptic } from "../lib/touch-feedback";

/** What the screen is doing. */
type Phase =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly reason: RemovalFailure }
  | { readonly kind: "ready" }
  /** The confirmation is being asked for; the tab then goes to Musubi. */
  | { readonly kind: "leaving" }
  /** The removal runs: `rounds` calls answered "not finished" so far. */
  | { readonly kind: "removing"; readonly rounds: number; readonly waiting: boolean };

/** The line about the whole screen, beside its buttons. */
interface Line {
  /** `held`: a wedding's payout account is the person's to hand over first. */
  readonly kind: "missing" | "changed" | "expired" | "failure" | "held";
  readonly tone: NoticeTone;
  readonly text: string;
}

/** Where a wedding's link from this screen goes: its download, its co-hosts, or Money gifts. */
export type RemovalPlace = "export" | "hosts" | "money";

/** How long the removal waits after the limiter refuses one of its rounds. */
const LIMIT_WAIT_MS = 60_000;

/** A removal that keeps answering "not finished" this many times has gone wrong. */
const MAX_ROUNDS = 400;

const ROLE_WORD = {
  owner: "an owner",
  editor: "an editor",
  viewer: "a viewer",
  helper: "a helper",
} as const satisfies Record<RemovalRole, string>;

/** Why the plan did not load, in words. */
const LOAD_FAILURE = {
  confirmation_required: "Cire couldn't load your weddings. Try again.",
  account_unavailable: "Cire couldn't load your weddings. Try again.",
  unavailable:
    "Cire can't reach Musubi right now, so it can't check your weddings. Try again in a few minutes.",
  limit: "Too many tries for now. Wait a minute, then try again.",
  server: "Cire couldn't load your weddings. Try again.",
  network: "Couldn't reach Cire. Check your connection and try again.",
} as const satisfies Record<RemovalFailure, string>;

/** Why a press did not go through, in words. */
const ACTION_FAILURE = {
  confirmation_required:
    "Your confirmation from Musubi has run out, or this browser can't use it. Confirm on Musubi again.",
  account_unavailable: "Your Musubi account is set to be deleted, so it can't confirm this.",
  unavailable: "Cire can't reach Musubi right now. Try again in a few minutes.",
  limit: "Too many tries for now. Wait a minute, then try again.",
  server: "Cire couldn't finish this. Try again.",
  network: "Couldn't reach Cire. Check your connection and try again.",
} as const satisfies Record<RemovalFailure, string>;

const PARTLY_DONE = "Part of your data is removed already.";

const failureOf = (err: unknown): RemovalFailure =>
  err instanceof RemovalError ? err.reason : "server";

/**
 * The weddings a plan lists one by one with an answer of their own: live,
 * owned by the person alone, and named by an open action. Past 100 there are
 * none: one action stands for them all.
 */
function soleRowsOf(plan: RemovalPlan): RemovalWedding[] {
  if (plan.openActions.some((action) => action.weddingId === null)) return [];
  const named = new Set(plan.openActions.map((action) => action.weddingId));
  return plan.weddings.filter((w) => !w.deleted && w.soleOwner && named.has(w.weddingId));
}

/** The plan's actions no row answers: the one past 100, or a wedding past the list's 200. */
function unlistedOf(plan: RemovalPlan): RemovalAction[] {
  const rows = new Set(soleRowsOf(plan).map((w) => w.weddingId));
  return plan.openActions.filter(
    (action) => action.weddingId === null || !rows.has(action.weddingId),
  );
}

/** Whether a plan draws "Delete every wedding only you own": an action no row answers, or two rows. */
function offersEverything(plan: RemovalPlan): boolean {
  return unlistedOf(plan).length > 0 || soleRowsOf(plan).length >= 2;
}

const textClass = "font-body text-text text-ui-sm leading-ui-normal";
const hintClass = "font-body text-text-muted text-ui-sm leading-ui-normal";
const nameClass =
  "font-display text-text text-ui-md leading-ui-tight font-light [overflow-wrap:anywhere]";
const LIVE_ROW = `${cardClass({ padding: "sm" })} gap-2`;
const GONE_ROW = `${cardClass({ padding: "sm", fill: "none" })} gap-2`;

export interface RemoveCireDataProps {
  /** The code Musubi sent the person back with, read from the address on load. */
  code?: string;
  /** Whether the signed-in profile can open this wedding's dashboard. */
  canOpen: (weddingId: string) => boolean;
  /**
   * Whether it can open this wedding's Money gifts: the registry comes with
   * Gold, and below it the dashboard opens the overview instead. `canOpen`
   * when not given.
   */
  canOpenMoney?: (weddingId: string) => boolean;
  /** Opens a wedding's download, co-hosts or Money gifts, through the dashboard's own navigation. */
  onOpen: (weddingId: string, place: RemovalPlace) => void;
  /** The person kept their data: back to the wedding list. */
  onCancel: () => void;
  /** Everything is removed; the person's Cire sessions are gone. */
  onDone: () => void;
}

/**
 * "Remove my Cire data": a host leaves Cire and keeps their Musubi account.
 *
 * The screen lists every wedding the person holds a seat on and what removal
 * does to each, takes an answer for each wedding they alone own, sends them to
 * Musubi to confirm it is them, and on their return, with the code Musubi
 * sent, lists every profile of their account and removes. The person's
 * answers and the code wait in `sessionStorage` while they are away
 * (`lib/account-removal.ts`), so the trip to Musubi, a reload, or a visit to a
 * wedding's settings to add an owner loses nothing.
 *
 * One state at a time (`Phase`), and one line about the whole screen under
 * the list, beside the buttons the person pressed: an answer missing, the list
 * changed under them, the confirmation run out, a failure. Every state arrives
 * at once (DESIGN.md §7, Remove my Cire data).
 *
 * A wedding whose Stripe account the person holds, beside another owner,
 * says to hand it over in Money gifts first: the API refuses the removal
 * until then (409 `holds_payout_account`). Once confirmed, the list covers
 * every profile of the account, as the removal's own check does, so a press
 * with such a wedding listed is refused here and the row marked. Before then
 * the list holds one profile, and another profile of the same account may be
 * that other owner, so step one only says so.
 */
export default function RemoveCireData(props: RemoveCireDataProps) {
  const { authFetch } = useAuth();
  const ids = { what: createUniqueId(), weddings: createUniqueId() };

  // Read once, on the way in: the code the address carried, else the one kept
  // before the address lost it (a reload, a visit to a wedding and back).
  const [code, setCode] = createSignal<string | null>(props.code ?? keptCode());
  const [plan, setPlan] = createSignal<RemovalPlan | null>(null);
  const [phase, setPhase] = createSignal<Phase>({ kind: "loading" });
  const [answered, setAnswered] = createSignal<ReadonlySet<string>>(new Set());
  const [everything, setEverything] = createSignal(false);
  const [marks, setMarks] = createSignal<ReadonlySet<string>>(new Set());
  /** The weddings marked for a payout account to hand over, by id. */
  const [heldMarks, setHeldMarks] = createSignal<ReadonlySet<string>>(new Set());
  const [line, setLine] = createSignal<Line | null>(null);

  let root: HTMLDivElement | undefined;
  let disposed = false;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    disposed = true;
    if (waitTimer !== undefined) clearTimeout(waitTimer);
  });

  const confirmed = () => plan()?.confirmed === true && code() !== null;
  const actions = () => plan()?.openActions ?? [];
  const weddings = () => plan()?.weddings ?? [];
  const busy = () => phase().kind === "leaving" || phase().kind === "removing";
  const loadFailure = (): RemovalFailure | null => {
    const current = phase();
    return current.kind === "failed" ? current.reason : null;
  };

  /** Past 100 weddings the person alone owns, one action stands for them all. */
  const many = () => actions().some((action) => action.weddingId === null);
  const actionFor = (weddingId: string): RemovalAction | undefined =>
    actions().find((action) => action.weddingId === weddingId);

  const soleRows = createMemo(() => {
    const p = plan();
    return p ? soleRowsOf(p) : [];
  });
  const ownRows = createMemo(() =>
    many() ? weddings().filter((w) => !w.deleted && w.role === "owner") : [],
  );
  const leaveRows = createMemo(() =>
    weddings().filter((w) => !w.deleted && !soleRows().includes(w) && !ownRows().includes(w)),
  );
  const deletedRows = createMemo(() => weddings().filter((w) => w.deleted));
  /** Live weddings whose payout account the person holds beside another owner. */
  const heldRows = () => weddings().filter((w) => !w.deleted && w.payoutHolder === true);

  /** Actions no row on screen answers: the one past 100, or a wedding past the list's 200. */
  const unlisted = createMemo(() => {
    const p = plan();
    return p ? unlistedOf(p) : [];
  });
  const showEverything = () => {
    const p = plan();
    return p !== null && offersEverything(p);
  };

  /** The actions still without an answer. */
  const missing = (): string[] =>
    everything()
      ? []
      : actions()
          .filter((a) => !answered().has(a.id))
          .map((a) => a.id);
  const everythingMarked = () => unlisted().some((action) => marks().has(action.id));

  /** Keep the answers where the trip to Musubi, or a reload, will find them. */
  function keep() {
    keepAnswers({ answered: [...answered()], deleteEverything: everything() });
  }

  function answer(actionId: string, yes: boolean) {
    batch(() => {
      setAnswered((current) => {
        const next = new Set(current);
        if (yes) next.add(actionId);
        else next.delete(actionId);
        return next;
      });
      clearMark(actionId);
    });
    keep();
  }

  function answerEverything(yes: boolean) {
    batch(() => {
      setEverything(yes);
      if (yes) setMarks(new Set<string>());
      if (yes && line()?.kind === "missing") setLine(null);
    });
    keep();
  }

  function clearMark(actionId: string) {
    if (!marks().has(actionId)) return;
    const next = new Set(marks());
    next.delete(actionId);
    setMarks(next);
    if (next.size === 0 && line()?.kind === "missing") setLine(null);
  }

  /** Marks every action still unanswered and moves focus to the first; false when none is. */
  function markMissing(kind: "missing" | "changed"): boolean {
    const open = missing();
    if (open.length === 0) return false;
    batch(() => {
      setMarks(new Set(open));
      setLine(
        kind === "missing"
          ? { kind, tone: "danger", text: "Answer for each wedding marked above." }
          : {
              kind,
              tone: "warn",
              text: "Your weddings changed since you looked. Answer for each wedding marked above.",
            },
      );
    });
    queueMicrotask(() =>
      root?.querySelector<HTMLInputElement>("[data-removal-marked] input:not([disabled])")?.focus(),
    );
    return true;
  }

  /**
   * Puts a plan on screen with the answers that still apply to it. "Delete
   * every wedding only you own" applies only to a plan that offers it: on one
   * that hides it (the rounds already taken left one such wedding, say), the
   * answer would tick that wedding's box where it cannot be unticked, so it
   * is dropped, here and where it is kept.
   */
  function show(next: RemovalPlan, restore: KeptAnswers | null) {
    const open = new Set(next.openActions.map((action) => action.id));
    const offered = offersEverything(next);
    const answers = restore ? new Set(restore.answered.filter((id) => open.has(id))) : answered();
    const before = everything();
    const all = offered && (restore ? restore.deleteEverything : before);
    batch(() => {
      setPlan(next);
      setAnswered(answers);
      setEverything(all);
      setMarks((current) => new Set([...current].filter((id) => open.has(id))));
    });
    if (restore || all !== before) {
      keepAnswers({ answered: [...answers], deleteEverything: all });
    }
  }

  /** The code no longer confirms anything: forget it, and keep the answers. */
  function dropCode() {
    forgetRemoval();
    keep();
    setCode(null);
  }

  async function load(restore: KeptAnswers | null) {
    setPhase({ kind: "loading" });
    const asked = code();
    try {
      const next = await loadRemovalPlan(authFetch, asked ?? undefined);
      if (disposed) return;
      batch(() => {
        if (asked !== null && !next.confirmed) {
          dropCode();
          if (line() === null) {
            setLine({ kind: "expired", tone: "warn", text: ACTION_FAILURE.confirmation_required });
          }
        }
        show(next, restore);
        setPhase({ kind: "ready" });
      });
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      if (!disposed) setPhase({ kind: "failed", reason: failureOf(err) });
    }
  }

  onMount(() => void load(keptAnswers()));

  /** Step one: keep the answers, ask for a confirmation, go to Musubi. */
  async function toMusubi() {
    if (phase().kind !== "ready") return;
    if (markMissing("missing")) return haptic("reject");
    setLine(null);
    keep();
    setPhase({ kind: "leaving" });
    try {
      const url = await beginRemovalConfirmation(authFetch);
      if (disposed) return;
      if (!/^https?:\/\//i.test(url)) throw new RemovalError("server");
      // The tab leaves for Musubi; the button stays busy until it has.
      navigateTo(url);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      if (disposed) return;
      haptic("reject");
      batch(() => {
        setPhase({ kind: "ready" });
        setLine({ kind: "failure", tone: "danger", text: ACTION_FAILURE[failureOf(err)] });
      });
    }
  }

  /** Waits out the limiter between two rounds; false if the screen went meanwhile. */
  function wait(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      waitTimer = setTimeout(() => {
        waitTimer = undefined;
        resolve(!disposed);
      }, ms);
    });
  }

  /**
   * Marks each listed wedding whose payout account the person holds and moves
   * focus to the first one's way to Money gifts. Run once the removal's own
   * refusal has read the list again, so the marks are the API's, not a read
   * from before the press.
   */
  function markHeld(): void {
    const held = heldRows();
    setHeldMarks(new Set(held.map((w) => w.weddingId)));
    if (held.length === 0) return;
    // Its link to Money gifts, or the note itself where there is none.
    queueMicrotask(() => {
      const note = root?.querySelector<HTMLElement>("[data-removal-held] [data-held-note]");
      (note?.querySelector<HTMLElement>("a") ?? note)?.focus();
    });
  }

  /** Step two: remove, calling again for as long as the answer is "not finished". */
  async function remove() {
    const current = code();
    if (phase().kind !== "ready" || current === null) return;
    if (markMissing("missing")) return haptic("reject");
    // A wedding the list marks as holding a payout account is still sent: the
    // mark can be stale, and the API's `holds_payout_account` refusal decides.
    setLine(null);
    setHeldMarks(new Set<string>());
    let rounds = 0;
    setPhase({ kind: "removing", rounds, waiting: false });
    /* Sequential by design: each round removes up to three weddings the
       person owns, and the next must not start until it has answered. */
    // oxlint-disable no-await-in-loop
    while (rounds <= MAX_ROUNDS) {
      let outcome: Awaited<ReturnType<typeof removeCireData>>;
      try {
        outcome = await removeCireData(authFetch, {
          code: current,
          answered: [...answered()],
          deleteEverything: everything(),
        });
      } catch (err) {
        if (isAuthExpired(err)) return redirectToLogin();
        if (disposed) return;
        const reason = failureOf(err);
        // Past the first round the person has already pressed Remove: a
        // refused round waits out the limiter and carries on, for as long as
        // the confirmation lasts.
        if (reason === "limit" && rounds > 0) {
          setPhase({ kind: "removing", rounds, waiting: true });
          if (!(await wait(LIMIT_WAIT_MS))) return;
          setPhase({ kind: "removing", rounds, waiting: false });
          continue;
        }
        haptic("reject");
        return stopped(reason, rounds);
      }
      if (disposed) return;
      if (outcome.status === "done") {
        forgetRemoval();
        haptic("commit");
        return props.onDone();
      }
      if (outcome.status === "not_finished") {
        rounds += 1;
        setPhase({ kind: "removing", rounds, waiting: false });
        continue;
      }
      if (outcome.status === "holds_payout_account") {
        // The API's own words, as given, and the list read again, so each
        // wedding whose account the person holds says where to hand it over,
        // and is marked.
        haptic("reject");
        const partly = rounds > 0 ? `${PARTLY_DONE} ` : "";
        setLine({ kind: "held", tone: "danger", text: `${partly}${outcome.message}` });
        await load(null);
        if (!disposed) markHeld();
        return;
      }
      // Answers missing on the rows as they stand now: the fresh list.
      const fresh = outcome;
      haptic("reject");
      batch(() => {
        show(
          {
            weddings: fresh.weddings,
            more: fresh.more,
            openActions: fresh.openActions,
            confirmed: true,
          },
          null,
        );
        setPhase({ kind: "ready" });
        markMissing("changed");
      });
      return;
    }
    // oxlint-enable no-await-in-loop
    return stopped("server", rounds);
  }

  /** The removal stopped short: say why, and show what is left. */
  function stopped(reason: RemovalFailure, rounds: number) {
    const partly = rounds > 0 ? `${PARTLY_DONE} ` : "";
    setLine({
      kind: reason === "confirmation_required" ? "expired" : "failure",
      tone: reason === "confirmation_required" ? "warn" : "danger",
      text: `${partly}${ACTION_FAILURE[reason]}`,
    });
    if (reason === "confirmation_required") {
      dropCode();
      return void load(null);
    }
    // What is left is not what was on screen once a round has gone through.
    if (rounds > 0) return void load(null);
    setPhase({ kind: "ready" });
  }

  function cancel() {
    if (busy()) return;
    forgetRemoval();
    props.onCancel();
  }

  /** A wedding's download, co-hosts or Money gifts, as a link the dashboard follows. */
  const linkTo = (weddingId: string, place: RemovalPlace): InAppLink => ({
    href: serializeRoute(
      place === "money"
        ? { view: "weddings", weddingId, module: "registry", sub: "settings" }
        : { view: "weddings", weddingId, module: "settings", sub: place },
    ),
    onOpen: () => props.onOpen(weddingId, place),
  });
  /** Money gifts, where this wedding's payout account is handed over, when it can be opened. */
  const moneyLinkFor = (weddingId: string): InAppLink | null =>
    props.canOpen(weddingId) && (props.canOpenMoney ?? props.canOpen)(weddingId)
      ? linkTo(weddingId, "money")
      : null;

  const hasRows = () => weddings().length > 0 || (plan()?.more ?? 0) > 0;

  return (
    <div ref={root} class="flex w-full max-w-3xl flex-col gap-6" data-remove-cire-data>
      <header class="flex flex-col gap-1.5">
        {/* The step is what the heading does not say (DESIGN.md §3). */}
        <Eyebrow>{confirmed() ? "Step 2 of 2" : "Step 1 of 2"}</Eyebrow>
        <h2 class="font-display text-text text-ui-lg leading-ui-tight font-light">
          Remove your Cire data
        </h2>
        <p class="font-body text-text-muted text-ui-base leading-ui-normal max-w-prose">
          {confirmed()
            ? "Leave Cire as a host and keep your Musubi account. Check the list once more, now that it covers every profile of your account, then remove your data."
            : "Leave Cire as a host and keep your Musubi account. Check what happens to each wedding, answer for any that only you own, then confirm on Musubi."}
        </p>
      </header>

      <section aria-labelledby={ids.what} class={`${cardClass({ padding: "lg" })} gap-3`}>
        <h3 id={ids.what} class="font-display text-text text-ui-md leading-ui-tight font-light">
          What happens
        </h3>
        <ul class={`${textClass} flex max-w-prose list-disc flex-col gap-1.5 pl-5`}>
          <li>
            You leave every wedding you hold a seat on, from every profile of your Musubi account.
          </li>
          <li>
            A wedding left with no owner is deleted at once. Cire's daily clean-up then erases it,
            later while a payment or gift for it is still settling.
          </li>
          <li>The other owners of a wedding you leave get an email saying you left.</li>
          <li>
            You're signed out of Cire. You can sign in again later and start fresh, with no
            weddings.
          </li>
          <li>
            Your Musubi account stays. So do the guest invitations linked to it and any vendor
            listing you claimed.
          </li>
          <li>You can't undo this.</li>
        </ul>
      </section>

      <Switch>
        <Match when={phase().kind === "loading" && plan() === null}>
          <Loading label="Checking your weddings…" />
        </Match>

        <Match when={loadFailure()}>
          {(reason) => (
            <div class="flex flex-col items-start gap-3">
              <Notice tone="danger" size="sm" alert class="max-w-prose">
                {LOAD_FAILURE[reason()]}
              </Notice>
              <Button variant="outline" size="sm" onClick={() => void load(keptAnswers())}>
                Try again
              </Button>
            </div>
          )}
        </Match>

        <Match when={plan()}>
          {/* While it leaves for Musubi or removes, nothing in the list can be
              changed or followed: an answer changed now would not be the one sent. */}
          <section aria-labelledby={ids.weddings} inert={busy()} class="flex flex-col gap-4">
            <div class="flex flex-col gap-1">
              <h3
                id={ids.weddings}
                class="font-display text-text text-ui-md leading-ui-tight font-light"
              >
                Your weddings
              </h3>
              <p class={`${hintClass} max-w-prose`}>
                {confirmed()
                  ? "Every wedding a profile of your Musubi account holds a seat on."
                  : "The weddings of the profile you're signed in with. Once you confirm on Musubi, this lists every profile of your account."}
              </p>
            </div>

            <Show
              when={hasRows()}
              fallback={
                <EmptyState
                  title="No weddings"
                  description={
                    confirmed()
                      ? "No profile of your Musubi account holds a seat on a wedding."
                      : "The profile you're signed in with holds no seat on a wedding. Removing your data still signs you out of Cire."
                  }
                />
              }
            >
              <Show when={showEverything() || soleRows().length > 0}>
                <Group label="Deleted with your data" count={many() ? null : soleRows().length}>
                  <Show when={showEverything()}>
                    <li
                      class={`${cardClass({ padding: "sm", tone: "accent" })} gap-2`}
                      data-removal-marked={everythingMarked() || undefined}
                    >
                      <Checkbox
                        box="native"
                        size="sm"
                        checked={everything()}
                        disabled={busy()}
                        aria-invalid={everythingMarked() || undefined}
                        onChange={answerEverything}
                        label="Delete every wedding only you own"
                        description={
                          many()
                            ? "You alone own more than 100 weddings, too many to answer one by one. To keep one, add another owner to it first."
                            : unlisted().length > 0
                              ? "Answers for each wedding below, and for the ones this list leaves out."
                              : "Answers for each wedding below at once."
                        }
                        note={
                          <Show when={everythingMarked()}>
                            <Notice tone="danger" size="inline">
                              Tick this to go on, or add another owner first.
                            </Notice>
                          </Show>
                        }
                      />
                    </li>
                  </Show>
                  <For each={soleRows()}>
                    {(wedding) => {
                      const action = () => actionFor(wedding.weddingId);
                      const marked = () => {
                        const id = action()?.id;
                        return id !== undefined && marks().has(id);
                      };
                      return (
                        <li class={LIVE_ROW} data-removal-marked={marked() || undefined}>
                          <WeddingName wedding={wedding} />
                          <p class={textClass}>
                            Only you own it, so it's deleted when you remove your data.
                          </p>
                          <KeepLinks
                            wedding={wedding}
                            canOpen={props.canOpen(wedding.weddingId)}
                            linkTo={linkTo}
                          />
                          <Checkbox
                            box="native"
                            size="sm"
                            checked={everything() || answered().has(action()?.id ?? "")}
                            disabled={busy() || everything()}
                            aria-invalid={marked() || undefined}
                            aria-label={`Delete this wedding: ${wedding.name}`}
                            onChange={(yes) => {
                              const id = action()?.id;
                              if (id) answer(id, yes);
                            }}
                            label="Delete this wedding"
                            note={
                              <Show when={marked()}>
                                <Notice tone="danger" size="inline">
                                  Tick this to go on, or add another owner first.
                                </Notice>
                              </Show>
                            }
                          />
                        </li>
                      );
                    }}
                  </For>
                </Group>
              </Show>

              <Show when={ownRows().length > 0}>
                <Group label="You own these" count={ownRows().length}>
                  <For each={ownRows()}>
                    {(wedding) => (
                      <li
                        class={LIVE_ROW}
                        data-removal-held={heldMarks().has(wedding.weddingId) || undefined}
                      >
                        <WeddingName wedding={wedding} />
                        <p class={textClass}>You own it. If no one else does, it's deleted.</p>
                        <KeepLinks
                          wedding={wedding}
                          canOpen={props.canOpen(wedding.weddingId)}
                          linkTo={linkTo}
                        />
                        <Show when={wedding.payoutHolder}>
                          <HeldAccount
                            canOpen={props.canOpen(wedding.weddingId)}
                            money={moneyLinkFor(wedding.weddingId)}
                            marked={heldMarks().has(wedding.weddingId)}
                          />
                        </Show>
                      </li>
                    )}
                  </For>
                </Group>
              </Show>

              <Show when={leaveRows().length > 0}>
                <Group label="You leave these" count={leaveRows().length}>
                  <For each={leaveRows()}>
                    {(wedding) => (
                      <li
                        class={LIVE_ROW}
                        data-removal-held={heldMarks().has(wedding.weddingId) || undefined}
                      >
                        <WeddingName wedding={wedding} />
                        <p class={hintClass}>
                          {wedding.role === "owner"
                            ? "You own it with others. You leave it, and they keep it."
                            : `You're ${ROLE_WORD[wedding.role]}. You leave it, and it stays.`}
                        </p>
                        <Show when={wedding.payoutHolder}>
                          <HeldAccount
                            canOpen={props.canOpen(wedding.weddingId)}
                            money={moneyLinkFor(wedding.weddingId)}
                            marked={heldMarks().has(wedding.weddingId)}
                          />
                        </Show>
                      </li>
                    )}
                  </For>
                </Group>
              </Show>

              <Show when={deletedRows().length > 0}>
                <Group label="Already deleted" count={deletedRows().length}>
                  <For each={deletedRows()}>
                    {(wedding) => (
                      <li class={GONE_ROW}>
                        <WeddingName wedding={wedding} />
                        <p class={hintClass}>Removing your data ends your chance to restore it.</p>
                      </li>
                    )}
                  </For>
                </Group>
              </Show>

              <Show when={(plan()?.more ?? 0) > 0}>
                {/* The figure alone is tabular: the face's tabular set widens a full stop too. */}
                <p class={hintClass}>
                  And <span data-numeric>{plan()!.more}</span> more{" "}
                  {plan()!.more === 1
                    ? "wedding not listed here. You leave it too."
                    : "weddings not listed here. You leave them too."}
                </p>
              </Show>
            </Show>
          </section>

          <section
            aria-label={confirmed() ? "Remove" : "Confirm"}
            class="border-border flex flex-col items-start gap-3 border-t pt-5"
          >
            <Show when={line()} keyed>
              {(current) => (
                <Notice tone={current.tone} size="sm" alert class="max-w-prose">
                  {current.text}
                </Notice>
              )}
            </Show>

            <Show
              when={confirmed()}
              fallback={
                <p class={`${hintClass} max-w-prose`}>
                  Musubi asks you to confirm it's you, then sends you back here to finish. Nothing
                  is removed until you do.
                </p>
              }
            >
              <Show when={line() === null && phase().kind !== "removing"}>
                <Notice tone="success" size="sm" class="max-w-prose">
                  Confirmed on Musubi. Remove your data within 5 minutes of confirming, or confirm
                  again.
                </Notice>
              </Show>
            </Show>

            <div class="flex flex-wrap items-center gap-3">
              <Show
                when={confirmed()}
                fallback={
                  <Button
                    variant="primary"
                    aria-disabled={busy() || phase().kind === "loading" ? "true" : undefined}
                    onClick={() => void toMusubi()}
                  >
                    {phase().kind === "leaving" ? "Going to Musubi…" : "Confirm on Musubi"}
                  </Button>
                }
              >
                <Button
                  variant="danger"
                  aria-disabled={busy() || phase().kind === "loading" ? "true" : undefined}
                  onClick={() => void remove()}
                >
                  {phase().kind === "removing" ? "Removing…" : "Remove my Cire data"}
                </Button>
              </Show>
              <Button variant="quiet" disabled={busy()} onClick={cancel}>
                Cancel
              </Button>
            </div>

            <RemovingStatus phase={phase()} />
          </section>
        </Match>
      </Switch>
    </div>
  );
}

/** One group of rows, under a muted label that names what happens to them. */
function Group(props: { label: string; count: number | null; children: JSX.Element }) {
  const id = createUniqueId();
  return (
    <div class="flex flex-col gap-2">
      <Eyebrow id={id} tone="muted">
        {props.label}
        <Show when={props.count !== null}>
          <span data-numeric> · {props.count}</span>
        </Show>
      </Eyebrow>
      <ul aria-labelledby={id} class="flex flex-col gap-2">
        {props.children}
      </ul>
    </div>
  );
}

/** A wedding's name, in the display face, breaking anywhere: a host wrote it. */
function WeddingName(props: { wedding: RemovalWedding }) {
  return <p class={nameClass}>{props.wedding.name}</p>;
}

/** The two ways to keep something of a wedding the person alone owns. */
function KeepLinks(props: {
  wedding: RemovalWedding;
  canOpen: boolean;
  linkTo: (weddingId: string, place: RemovalPlace) => InAppLink;
}) {
  const download = () => props.linkTo(props.wedding.weddingId, "export");
  const owners = () => props.linkTo(props.wedding.weddingId, "hosts");
  return (
    <Show
      when={props.canOpen}
      fallback={
        <p class={hintClass}>
          Another profile of your Musubi account holds this seat. To download it or add another
          owner, sign in to Cire with that profile.
        </p>
      }
    >
      <p class={hintClass}>
        <a href={download().href} class={proseLinkClass()} onClick={followInApp(download())}>
          Download wedding
        </a>{" "}
        to keep a copy.{" "}
        <a href={owners().href} class={proseLinkClass()} onClick={followInApp(owners())}>
          Add another owner
        </a>{" "}
        to keep it on Cire.
      </p>
    </Show>
  );
}

/**
 * A wedding whose Stripe account the person holds beside another owner: where
 * to hand it over before the removal can go through, and, once a press found
 * it still held, a mark saying so. Promises no step beyond Money gifts: the
 * next is Musubi's own confirmation, which the screen already describes.
 */
function HeldAccount(props: { canOpen: boolean; money: InAppLink | null; marked: boolean }) {
  return (
    <>
      <p class={hintClass} data-held-note tabindex={props.money ? undefined : -1}>
        You connected the Stripe account money gifts are paid into.{" "}
        <Show
          when={props.canOpen}
          fallback="To hand it over, sign in to Cire with the profile that holds this seat."
        >
          Hand money gifts to another owner or disconnect it in{" "}
          <Show when={props.money} fallback="Money gifts">
            {(link) => (
              <a href={link().href} class={proseLinkClass()} onClick={followInApp(link())}>
                Money gifts
              </a>
            )}
          </Show>{" "}
          before you remove your data.
        </Show>
      </p>
      <Show when={props.marked}>
        <Notice tone="danger" size="inline">
          Hand this over before you remove your data.
        </Notice>
      </Show>
    </>
  );
}

/** While the removal runs: one pulsing line, and why it is taking a while. */
function RemovingStatus(props: { phase: Phase }) {
  const removing = () => (props.phase.kind === "removing" ? props.phase : null);
  return (
    <Show when={removing()}>
      {(state) => (
        <div class="flex flex-col gap-1">
          <Loading
            label={
              state().waiting ? "Waiting a minute before the next part…" : "Removing your data…"
            }
          />
          <Show when={state().rounds > 0}>
            <p class={hintClass}>Many weddings take a few rounds. Keep this page open.</p>
          </Show>
        </div>
      )}
    </Show>
  );
}
