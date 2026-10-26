import type { EngineInterface, JsonValue } from "claude-code";

import type { CiVerdict, PrState, PrView, ReviewVerdict } from "../types";
import { firstLine, spawn } from "./spawn";

const GH_TIMEOUT_MS = 20_000;
const THREAD_PAGE = 100;

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { reviewThreads(first: ${THREAD_PAGE}) { nodes { isResolved } } }
  }
}`;

const STATES = new Map<string, PrState>([
  ["OPEN", "open"],
  ["MERGED", "merged"],
  ["CLOSED", "closed"],
]);

const REVIEWS = new Map<string, ReviewVerdict>([
  ["APPROVED", "approved"],
  ["CHANGES_REQUESTED", "changes-requested"],
  ["REVIEW_REQUIRED", "review-required"],
]);

// A CheckRun's conclusion or a StatusContext's state. Anything else, an empty
// conclusion (QUEUED, IN_PROGRESS) and PENDING included, is pending.
const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILING = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

type Fields = ReadonlyMap<string, JsonValue>;

const parseJson = (text: string): JsonValue | undefined => {
  try {
    const parsed: JsonValue = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
};

const fieldsOf = (value: JsonValue | undefined): Fields =>
  value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
    ? new Map(Object.entries(value))
    : new Map();

const textOf = (value: JsonValue | undefined) => (typeof value === "string" ? value : "");

const itemsOf = (value: JsonValue | undefined): readonly JsonValue[] =>
  Array.isArray(value) ? value : [];

const fieldPath = (value: JsonValue | undefined, ...names: string[]) =>
  names.reduce<JsonValue | undefined>((at, name) => fieldsOf(at).get(name), value);

const checkVerdict = (item: Fields): CiVerdict => {
  const word =
    textOf(item.get("__typename")) === "StatusContext"
      ? textOf(item.get("state"))
      : textOf(item.get("conclusion"));
  if (PASSING.has(word)) return "passing";
  if (FAILING.has(word)) return "failing";
  return "pending";
};

const rollupVerdict = (items: readonly JsonValue[]): CiVerdict => {
  const verdicts = items.map((item) => checkVerdict(fieldsOf(item)));
  if (verdicts.includes("failing")) return "failing";
  if (verdicts.length === 0 || verdicts.includes("pending")) return "pending";
  return "passing";
};

// A github.com pull-request URL, and nothing else.
const PULL_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+$/;

// Unresolved review threads among the first page, `n+` when the page is full.
// Owner and name go as raw strings (`-f`), the number alone typed (`-F`).
async function readThreads($: EngineInterface, root: string, url: string, number: number) {
  const repo = PULL_URL.exec(url);
  if (!repo) return null;
  const ran = await spawn(
    $,
    [
      "gh",
      "api",
      "graphql",
      "-f",
      `query=${THREADS_QUERY}`,
      "-f",
      `owner=${repo[1] ?? ""}`,
      "-f",
      `name=${repo[2] ?? ""}`,
      "-F",
      `number=${number}`,
    ],
    { cwd: root, timeoutMs: GH_TIMEOUT_MS },
  );
  if (ran.kind !== "exited" || ran.exitCode !== 0) return null;
  const path = ["data", "repository", "pullRequest", "reviewThreads", "nodes"];
  const nodes = itemsOf(fieldPath(parseJson(ran.stdout), ...path));
  const unresolved = nodes.filter((node) => fieldsOf(node).get("isResolved") === false).length;
  return nodes.length >= THREAD_PAGE ? `${unresolved}+` : String(unresolved);
}

// The branch's pull request as `gh pr view` sees it from the pinned root, or
// why gh could not say.
export async function readPr($: EngineInterface, root: string): Promise<PrView> {
  const view = await spawn(
    $,
    ["gh", "pr", "view", "--json", "number,state,reviewDecision,statusCheckRollup,url"],
    { cwd: root, timeoutMs: GH_TIMEOUT_MS },
  );
  if (view.kind === "timed-out") return { kind: "gh-timed-out" };
  if (view.kind === "could-not-start") return { kind: "gh-missing" };
  if (view.exitCode !== 0) {
    return { kind: "gh-error", line: firstLine(view.stderr) || `exit ${view.exitCode}` };
  }

  const fields = fieldsOf(parseJson(view.stdout));
  const state = STATES.get(textOf(fields.get("state")));
  const number = fields.get("number");
  if (state === undefined || typeof number !== "number") {
    return { kind: "gh-error", line: "unreadable output from gh pr view" };
  }
  const url = textOf(fields.get("url"));

  return {
    kind: "found",
    number,
    state,
    ci: rollupVerdict(itemsOf(fields.get("statusCheckRollup"))),
    review: REVIEWS.get(textOf(fields.get("reviewDecision"))) ?? null,
    threads: state === "open" ? await readThreads($, root, url, number) : null,
    url,
  };
}
