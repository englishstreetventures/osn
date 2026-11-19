import type {
  AccountDeletionChoice,
  AccountDeletionOpenAction,
  AccountDeletionPreview,
} from "@osn/client";

import { PRODUCT_NAME } from "./auth";

/** The HTTP status a failed call carried; undefined when it has none. */
export function statusOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const { status } = err as { status?: unknown };
  return typeof status === "number" ? status : undefined;
}

/** The `error` code a failed call carried; undefined when it has none. */
export function codeOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const { code } = err as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

/** Hosts plain HTTP reaches only on this machine, where the local and E2E stacks run. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * An app's link as the flow follows it: `https:`, or `http:` to this machine,
 * which osn-api forwards only from a local run; null for anything else.
 */
export function followableLink(link: string | null): string | null {
  if (link === null || !URL.canParse(link)) return null;
  const { protocol, hostname } = new URL(link);
  if (protocol === "https:") return link;
  return protocol === "http:" && LOOPBACK_HOSTS.has(hostname) ? link : null;
}

/** The apps in the order the flow lists them: this one first. */
const APP_ORDER = ["osn", "cire", "pulse", "zap"];

const APP_NAME = {
  osn: PRODUCT_NAME,
  cire: "Cire",
  pulse: "Pulse",
  zap: "Zap",
} as const;

/** The name a person knows an app by. `osn` is this app. */
export function appName(app: string): string {
  return Object.hasOwn(APP_NAME, app)
    ? APP_NAME[app as keyof typeof APP_NAME]
    : app.charAt(0).toUpperCase() + app.slice(1);
}

/** "Cire", "Cire and Pulse", "Cire, Pulse and Zap". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export interface AppGroup {
  app: string;
  name: string;
  actions: AccountDeletionOpenAction[];
}

/** The open actions by app, in {@link APP_ORDER}, then any other app as it first appears. */
export function groupByApp(actions: readonly AccountDeletionOpenAction[]): AppGroup[] {
  const groups = new Map<string, AppGroup>();
  for (const action of actions) {
    const group = groups.get(action.app);
    if (group) group.actions.push(action);
    else groups.set(action.app, { app: action.app, name: appName(action.app), actions: [action] });
  }
  const rank = (app: string) => {
    const at = APP_ORDER.indexOf(app);
    return at === -1 ? APP_ORDER.length : at;
  };
  return [...groups.values()].toSorted((a, b) => rank(a.app) - rank(b.app));
}

/** One answer the person gave. */
export interface Answer {
  readonly choice: string;
  /** The member named to take over an organisation, with `successor`. */
  readonly successorProfileId?: string;
}

/** The person's answers, by open action id. */
export interface Answers {
  readonly [actionId: string]: Answer;
}

/** Whether an action must be answered before the deletion can be asked for. */
export function needsAnswer(action: AccountDeletionOpenAction): boolean {
  return action.choices.length > 0 && action.default_choice === null;
}

/** The choice an action shows as chosen: the person's answer, else its default, else none. */
export function shownChoice(action: AccountDeletionOpenAction, answers: Answers): string {
  return answers[action.id]?.choice ?? action.default_choice ?? "";
}

/** Why an action cannot go as it stands. */
export type Missing = "unanswered" | "no_successor";

/**
 * The actions that cannot go as they stand, by id: one that needs an answer
 * and has none, and one answered `successor` that names no member it offers.
 */
export function missingAnswers(
  actions: readonly AccountDeletionOpenAction[],
  answers: Answers,
): Map<string, Missing> {
  const missing = new Map<string, Missing>();
  for (const action of actions) {
    const choice = shownChoice(action, answers);
    if (choice === "" && needsAnswer(action)) missing.set(action.id, "unanswered");
    else if (
      choice === "successor" &&
      !action.candidates?.some(
        (candidate) => candidate.profile_id === answers[action.id]?.successorProfileId,
      )
    ) {
      missing.set(action.id, "no_successor");
    }
  }
  return missing;
}

/**
 * The answers `DELETE /account` takes: one for each action in the preview the
 * person answered, with the member named when the answer is `successor`. An
 * action left at its default sends nothing, so an app action that has gone
 * since cannot refuse the deletion as a stale answer.
 */
export function choicesToSend(
  actions: readonly AccountDeletionOpenAction[],
  answers: Answers,
): AccountDeletionChoice[] {
  const sent: AccountDeletionChoice[] = [];
  for (const action of actions) {
    const answer = answers[action.id];
    if (!answer || !action.choices.some((c) => c.choice === answer.choice)) continue;
    sent.push(
      answer.choice === "successor" && answer.successorProfileId
        ? {
            action: action.id,
            choice: answer.choice,
            successorProfileId: answer.successorProfileId,
          }
        : { action: action.id, choice: answer.choice },
    );
  }
  return sent;
}

/**
 * The answers that still mean something against a fresh preview: those whose
 * action is still listed and still offers the choice. A named member who is
 * no longer a candidate is dropped from the answer, which then asks for one.
 */
export function keepAnswers(
  actions: readonly AccountDeletionOpenAction[],
  answers: Answers,
): Answers {
  const kept = new Map<string, Answer>();
  for (const action of actions) {
    const answer = answers[action.id];
    if (!answer || !action.choices.some((c) => c.choice === answer.choice)) continue;
    const named = answer.successorProfileId;
    kept.set(
      action.id,
      named && !action.candidates?.some((candidate) => candidate.profile_id === named)
        ? { choice: answer.choice }
        : answer,
    );
  }
  return Object.fromEntries(kept);
}

/**
 * `preview` with `fresh` laid over it: an action in both takes the fresh
 * one's fields, and one only in `fresh` is added at the end.
 */
export function withActions(
  preview: AccountDeletionPreview,
  fresh: readonly AccountDeletionOpenAction[],
): AccountDeletionPreview {
  const byId = new Map(fresh.map((action) => [action.id, action]));
  const merged = preview.open_actions.map((action) => byId.get(action.id) ?? action);
  const known = new Set(merged.map((action) => action.id));
  return {
    open_actions: [...merged, ...fresh.filter((action) => !known.has(action.id))],
    could_not_check: preview.could_not_check,
  };
}

/** A unix time as a day in the reader's locale and zone: "7 December 2026". */
export function formatDay(unixSeconds: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(unixSeconds * 1_000);
}

/** A day in the reader's zone, with no clock time. */
export interface LocalDay {
  /** In the reader's locale: "Monday, 7 December 2026". */
  readonly words: string;
  /** For `<time datetime>`: "2026-12-07". */
  readonly date: string;
}

/**
 * The day a unix time falls on in the reader's zone. The day is the instant's
 * own, so it never starts after the instant, and the day before it ends
 * before the instant.
 */
export function localDay(unixSeconds: number): LocalDay {
  const at = new Date(unixSeconds * 1_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    words: new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(at),
    date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
  };
}
