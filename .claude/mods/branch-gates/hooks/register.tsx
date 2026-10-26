import { atom, read, update } from "claude-code";
import type { EngineInterface, Register, Timer, ToolCallResult } from "claude-code";

import type {
  ChangesetVerdict,
  CheckRow,
  CheckVerdict,
  Checks,
  CiVerdict,
  GateStatus,
  PrView,
  RepoGate,
  ReviewVerdict,
  Snapshot,
} from "../types";
import { CHECKS, runCheck } from "./checks";
import { issueRefOf, lookupComplexity, measure } from "./measure";
import type { ChangesetMemo, IssueRef } from "./measure";
import { readPr } from "./pr";
import { git, printable } from "./spawn";

// What the pane draws from, held by the host for the session so a hot reload
// keeps it. A tag changes whenever its value's fields change: a value stored
// under another tag reads as absent.
// oxlint-disable anti-slop/no-shape-in-symbol-names -- `shape` is the engine's own name for an atom's tag
const repo = atom({ plugin: "branch-gates", key: "repo" } as const, null, {
  shape: "repo-2",
});
const snapshot = atom({ plugin: "branch-gates", key: "snapshot" } as const, null, {
  shape: "snapshot-3",
});
const checks = atom({ plugin: "branch-gates", key: "checks" } as const, null, {
  shape: "checks-1",
});
const pr = atom({ plugin: "branch-gates", key: "pr" } as const, null, {
  shape: "pr-1",
});
// oxlint-enable anti-slop/no-shape-in-symbol-names

// The last refresh's error, null once a refresh succeeds.
const fault = atom({ plugin: "branch-gates", key: "fault" } as const, null);

const PANE = "branch-gates";
const TITLE = "Branch gates";
const DESCRIPTION =
  "Run this checkout's own lint, format and lint-warning scripts (about 30 s) and refresh the branch-gates pane";

// The one repository the mod works in, on github.com: https or ssh, with or
// without `.git`.
const OSN_REMOTE =
  /^(https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)englishstreetventures\/osn(\.git)?\/?$/i;

// Tools whose run can change the branch, the plan or the working tree.
const MUTATING = new Set(["Bash", "Edit", "Write", "NotebookEdit"]);
// The tools main's guard hook judges, whose refusal text the engine writes.
const GUARDED = new Set(["Bash", "Write", "Edit", "Agent"]);
// A Bash command that can change what `gh pr view` answers: a push, `git -C`
// or `-c` options before it allowed, or any gh command.
const PR_TRIGGER = /(^|[\s;&|(])(git(\s+-[Cc]\s+\S+)*\s+push|gh)(\s|$)/;

const MEASURE_WINDOW_MS = 2_000;
const PR_WINDOW_MS = 60_000;

type Tone = "plain" | "dim" | "heading" | "success" | "error" | "warning" | "subtle";
type Line = { text: string; tone: Tone };

const SPACER: Line = { text: " ", tone: "plain" };

const GATE_MARK = {
  pass: { glyph: "✓", tone: "success" },
  fail: { glyph: "✗", tone: "error" },
  pending: { glyph: "○", tone: "warning" },
  info: { glyph: "·", tone: "subtle" },
} satisfies Record<GateStatus, { glyph: string; tone: Tone }>;

const CHANGESET = {
  present: { text: "changeset ✓ present", tone: "success" },
  missing: { text: "changeset ✗ required, missing", tone: "error" },
  "not-needed": { text: "changeset · not needed", tone: "subtle" },
  unknown: { text: "changeset ? unknown", tone: "subtle" },
} satisfies Record<ChangesetVerdict, Line>;

const CI_TONE = {
  passing: "success",
  failing: "error",
  pending: "warning",
} satisfies Record<CiVerdict, Tone>;

const REVIEW = {
  approved: { text: "review: approved", tone: "success" },
  "changes-requested": { text: "review: changes requested", tone: "warning" },
  "review-required": { text: "review: review required", tone: "dim" },
} satisfies Record<ReviewVerdict, Line>;

const CHECK_GLYPH = {
  pass: "✓",
  fail: "✗",
  "timed-out": "✗",
  "could-not-start": "✗",
  "not-run": "○",
} satisfies Record<CheckVerdict, string>;

// A time as hh:mm:ss on the machine's own clock.
const clockText = (ms: number) => {
  const at = new Date(ms);
  return [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
};

const shortHead = (head: string | null) => head?.slice(0, 7) ?? "unknown HEAD";

const statusLine = (snap: Snapshot) =>
  [snap.branch, snap.issue, snap.complexity && `complexity ${snap.complexity}`]
    .filter(Boolean)
    .join(" · ");

// The reason the guard hook gave, when this call's result is its refusal: the
// call's own tool named at the very start of an errored result's text.
const guardReason = (tool: string, ran: ToolCallResult) => {
  if (!GUARDED.has(tool) || ran.isError !== true || ran.text === undefined) return null;
  const prefix = `PreToolUse:${tool} hook error: agent-guard: `;
  if (!ran.text.startsWith(prefix)) return null;
  return printable(ran.text.slice(prefix.length).split("\n")[0] ?? "").trim() || null;
};

const branchLines = (snap: Snapshot, failure: string | null): Line[] => {
  const issue = snap.issue ? `Issue ${snap.issue}` : "No issue line";
  const lines: Line[] = [
    { text: snap.branch, tone: "heading" },
    { text: snap.complexity ? `${issue} · complexity ${snap.complexity}` : issue, tone: "dim" },
    {
      text:
        snap.ahead === null || snap.changedFiles === null
          ? "base unknown"
          : `${snap.ahead} commits ahead · ${snap.changedFiles} files vs main`,
      tone: "dim",
    },
  ];
  if (snap.dirtyFiles === null) lines.push({ text: "uncommitted files unknown", tone: "warning" });
  else if (snap.dirtyFiles > 0)
    lines.push({ text: `${snap.dirtyFiles} uncommitted`, tone: "warning" });
  lines.push(CHANGESET[snap.changeset], {
    text: `updated ${clockText(snap.refreshedAt)}`,
    tone: "dim",
  });
  if (failure !== null) lines.push({ text: `refresh failed: ${failure}`, tone: "error" });
  return lines;
};

const prLines = (view: PrView | null): Line[] => {
  if (view === null) return [{ text: "Reading the pull request…", tone: "dim" }];
  if (view.kind === "gh-missing") return [{ text: "gh not installed", tone: "subtle" }];
  if (view.kind === "gh-timed-out") return [{ text: "gh timed out", tone: "warning" }];
  if (view.kind === "gh-error") return [{ text: `gh: ${view.line}`, tone: "subtle" }];
  if (view.state !== "open") return [{ text: `#${view.number} ${view.state}`, tone: "subtle" }];

  const threads = view.threads === null ? "threads unknown" : `${view.threads} unresolved`;
  const lines: Line[] = [
    { text: `#${view.number} open · CI ${view.ci} · ${threads}`, tone: CI_TONE[view.ci] },
  ];
  if (view.review !== null) lines.push(REVIEW[view.review]);
  return lines;
};

const checkLine = (row: CheckRow, isStale: boolean): Line => {
  const glyph = CHECK_GLYPH[row.verdict];
  if (isStale) return { text: `○ ${row.name} — stale`, tone: "warning" };
  if (row.verdict === "pass") return { text: `${glyph} ${row.name}`, tone: "success" };
  if (row.verdict === "not-run") {
    return { text: `${glyph} ${row.name} — not run: ${row.detail ?? ""}`, tone: "warning" };
  }
  const why = row.verdict === "fail" ? (row.detail ?? "") : row.verdict.replaceAll("-", " ");
  return { text: `${glyph} ${row.name} — ${why}`, tone: "error" };
};

const checkLines = (run: Checks | null, snap: Snapshot): Line[] => {
  if (run === null) {
    return [
      {
        text: "Not run. Type /gates to run this checkout's lint, format and warning checks (about 30 s).",
        tone: "dim",
      },
    ];
  }
  const isStale =
    !run.isRunning && (run.isStale || run.head !== snap.head || run.statusMark !== snap.statusMark);
  const lines: Line[] = [
    { text: `ran at ${shortHead(run.head)} · ${clockText(run.at)}`, tone: "dim" },
    ...run.rows.map((row) => checkLine(row, isStale)),
  ];
  const nextCheck = CHECKS[run.rows.length];
  if (run.isRunning && nextCheck) lines.push({ text: `running ${nextCheck.name}…`, tone: "dim" });
  return lines;
};

const gateLines = (snap: Snapshot): Line[] => {
  if (!snap.hasPlan) return [{ text: "No NEW-FEAT.md. Run /new-feat.", tone: "dim" }];
  if (snap.gates.length === 0) {
    return [{ text: "NEW-FEAT.md lists no gates under ## Gates.", tone: "dim" }];
  }
  return snap.gates.map((gate) => ({
    text: `${GATE_MARK[gate.status].glyph} ${gate.label}`,
    tone: GATE_MARK[gate.status].tone,
  }));
};

const summaryOf = (run: Checks, root: string) => {
  if (run.rows.every((row) => row.verdict === "not-run")) {
    return `Ran no checks: ${root} has no node_modules. bun install --frozen-lockfile installs them.`;
  }
  const names = CHECKS.map((check) => check.name);
  const verdicts = run.rows.map((row) => `${row.name} ${CHECK_GLYPH[row.verdict]}`);
  return `Ran this checkout's own ${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""} scripts at ${shortHead(run.head)}: ${verdicts.join(", ")}.`;
};

// What one load of the module holds: a hot reload starts it over and keeps
// what is in `$.state`.
type Live = {
  complexities: Map<string, string | null>;
  asking: Set<string>;
  changeset: ChangesetMemo;
  deciding: Promise<RepoGate> | null;
  measuring: Promise<Snapshot | null>;
  measuredAt: number | null;
  measureTimer: Timer | null;
  prAt: number | null;
  prTimer: Timer | null;
  isTouchedDuringRun: boolean;
};

const live: Live = {
  complexities: new Map(),
  asking: new Set(),
  changeset: { key: null, verdict: "unknown" },
  deciding: null,
  measuring: Promise.resolve(null),
  measuredAt: null,
  measureTimer: null,
  prAt: null,
  prTimer: null,
  isTouchedDuringRun: false,
};

// The repository the session started in, and whether it is this one: its
// root from `git rev-parse --show-toplevel` in `cwd`, then that root's origin.
const decide = async ($: EngineInterface, cwd: string) => {
  const root = await git($, cwd, "rev-parse", "--show-toplevel");
  const url = root === null ? null : await git($, root, "config", "--get", "remote.origin.url");
  const gate: RepoGate =
    root !== null && url !== null && OSN_REMOTE.test(url)
      ? { verdict: "on", root }
      : { verdict: "off", root: null };
  await update($, repo, () => gate);
  return gate;
};

// The pinned root while the mod is on, null while it is off. Worked out once:
// from the session's directory at `session.start`, or from the session's
// project root when another call comes first, then kept in state.
const rootOf = async ($: EngineInterface, cwd?: string) => {
  const held = await read($, repo);
  if (held !== null) return held.verdict === "on" ? held.root : null;
  live.deciding ??= decide($, cwd ?? (await $.session.root()));
  const gate = await live.deciding;
  return gate.verdict === "on" ? gate.root : null;
};

// The issue's complexity label, asked of gh once per issue per load and
// drawn into the snapshot already on screen.
const fillComplexity = async (
  $: EngineInterface,
  root: string,
  snap: Snapshot,
  issue: IssueRef,
) => {
  live.asking.add(issue.ref);
  const complexity = await lookupComplexity($, root, issue);
  live.complexities.set(issue.ref, complexity);
  live.asking.delete(issue.ref);
  if (complexity === null) return;
  await update($, snapshot, (held) =>
    held !== null && held.issue === snap.issue && held.complexity === null
      ? { ...held, complexity }
      : held,
  );
  $.ui.status(statusLine({ ...snap, complexity }));
};

const measureOnce = async ($: EngineInterface, root: string) => {
  try {
    const snap = await measure($, root, live.complexities, live.changeset);
    await update($, snapshot, () => snap);
    if ((await read($, fault)) !== null) await update($, fault, () => null);
    $.ui.status(statusLine(snap));
    const issue = issueRefOf(snap.issue);
    if (issue !== null && !live.complexities.has(issue.ref) && !live.asking.has(issue.ref)) {
      void fillComplexity($, root, snap, issue);
    }
    return snap;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await update($, fault, () => printable(message));
    return null;
  }
};

// One measure at a time, each after the one before it.
const measureNow = ($: EngineInterface, root: string) => {
  live.measuring = live.measuring.then(() => measureOnce($, root));
  return live.measuring;
};

const forceMeasure = async ($: EngineInterface, root: string) => {
  live.measureTimer?.cancel();
  live.measureTimer = null;
  live.measuredAt = await $.clock.now();
  return measureNow($, root);
};

// At most one measure per window; a request inside it runs once at its end.
const requestMeasure = async ($: EngineInterface, root: string) => {
  const now = await $.clock.now();
  const { measuredAt } = live;
  if (measuredAt === null || now - measuredAt >= MEASURE_WINDOW_MS) {
    live.measuredAt = now;
    await measureNow($, root);
    return;
  }
  if (live.measureTimer !== null) return;
  live.measureTimer = $.clock.after(measuredAt + MEASURE_WINDOW_MS - now, () => {
    live.measureTimer = null;
    void requestMeasure($, root);
  });
};

// At most one pull-request read a minute, start and `/gates` excepted; a
// request inside the window runs once at its end.
const requestPr = async ($: EngineInterface, root: string, isForced: boolean) => {
  const now = await $.clock.now();
  const { prAt } = live;
  if (isForced || prAt === null || now - prAt >= PR_WINDOW_MS) {
    live.prTimer?.cancel();
    live.prTimer = null;
    live.prAt = now;
    const view = await readPr($, root);
    await update($, pr, () => view);
    return;
  }
  if (live.prTimer !== null) return;
  live.prTimer = $.clock.after(prAt + PR_WINDOW_MS - now, () => {
    live.prTimer = null;
    void requestPr($, root, false);
  });
};

const markStale = async ($: EngineInterface, held: Checks | null) => {
  if (held === null || held.isStale) return;
  if (held.isRunning) {
    live.isTouchedDuringRun = true;
    return;
  }
  await update($, checks, (prior) => (prior === null ? null : { ...prior, isStale: true }));
};

const runChecks = async ($: EngineInterface, root: string, snap: Snapshot | null) => {
  const base = {
    head: snap?.head ?? null,
    statusMark: snap?.statusMark ?? null,
    at: await $.clock.now(),
  };
  const rows: CheckRow[] = [];
  live.isTouchedDuringRun = false;
  await update($, checks, () => ({ ...base, isRunning: true, isStale: false, rows: [] }));

  const hasModules = await $.fs.exists(`${root}/node_modules`);
  for (const check of CHECKS) {
    const row: CheckRow = hasModules
      ? // oxlint-disable-next-line no-await-in-loop -- the checks run one after another, as CI's steps do
        await runCheck($, check, root)
      : { name: check.name, verdict: "not-run", detail: "no node_modules" };
    rows.push(row);
    const sofar = [...rows];
    // oxlint-disable-next-line no-await-in-loop -- each row shows as soon as it settles
    await update($, checks, () => ({ ...base, isRunning: true, isStale: false, rows: sofar }));
  }

  const done: Checks = { ...base, isRunning: false, isStale: live.isTouchedDuringRun, rows };
  await update($, checks, () => done);
  return summaryOf(done, root);
};

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const root = await rootOf($, e.cwd);
    if (root !== null) {
      await $.command.register({ name: "gates", description: DESCRIPTION });
      void $.ui.open({ id: PANE, title: TITLE });
      void forceMeasure($, root);
      void requestPr($, root, true);
    }

    return next(e);
  });

  // Outside this repository a project's own `/gates` answers instead.
  on("command.run", { command: "gates" }, async ($, e, next) => {
    const root = await rootOf($);
    if (root === null) return next(e);
    if (e.origin.kind !== "composer") {
      const from = e.origin.kind === "plugin" ? `plugin ${e.origin.name}` : e.origin.kind;
      return {
        text: `/gates runs this checkout's own scripts, so it runs only when typed at the prompt. This run came from ${from}.`,
      };
    }

    await $.ui.open({ id: PANE, title: TITLE });
    const reading = requestPr($, root, true);
    const summary = await runChecks($, root, await forceMeasure($, root));
    await reading;

    return { text: summary };
  });

  on(
    "tool.call",
    { tool: ["Bash", "Edit", "Write", "NotebookEdit", "Agent"] },
    async ($, e, next) => {
      const ran = await next(e);
      const [root, held] = await Promise.all([rootOf($), read($, checks)]);
      if (root === null) return ran;

      const reason = guardReason(e.tool, ran);
      if (reason !== null) {
        $.ui.toast(`Guard: ${reason}`);
        return ran;
      }
      if (!MUTATING.has(e.tool)) return ran;
      await markStale($, held);
      void requestMeasure($, root);
      if (e.tool === "Bash" && PR_TRIGGER.test(e.command)) void requestPr($, root, false);

      return ran;
    },
    // oxlint-disable-next-line promise/no-callback-in-promise -- `on(...).catch` is the engine's handler for a failed hook, not a Promise's: `next(e)` replays the call's own result
  ).catch(($, e, next) => next(e));

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const snap = await read($, snapshot);
    if (e.props.hasSurvey || snap?.changeset !== "missing") return next(e);

    const { Text } = $.ui.resolve(e);

    return (
      <Text color="warning">
        Changeset required for this diff, none on the branch: bun run changeset
      </Text>
    );
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    const [snap, failure, view, run] = await Promise.all([
      read($, snapshot),
      read($, fault),
      read($, pr),
      read($, checks),
    ]);

    const draw = (line: Line) => {
      if (line.tone === "plain") return <Text>{line.text}</Text>;
      if (line.tone === "dim") return <Text dimColor>{line.text}</Text>;
      if (line.tone === "heading") return <Text weight="semibold">{line.text}</Text>;
      return <Text color={line.tone}>{line.text}</Text>;
    };

    if (snap === null) {
      const waiting: Line[] = [{ text: "Reading the branch…", tone: "dim" }];
      if (failure !== null) waiting.push({ text: `refresh failed: ${failure}`, tone: "error" });
      return <Box flexDirection="column">{waiting.map(draw)}</Box>;
    }

    const lines: Line[] = [
      ...branchLines(snap, failure),
      SPACER,
      { text: "Pull request", tone: "heading" },
      ...prLines(view),
      SPACER,
      { text: "Checks", tone: "heading" },
      ...checkLines(run, snap),
      SPACER,
      { text: "Gates", tone: "heading" },
      ...gateLines(snap),
    ];

    return <Box flexDirection="column">{lines.map(draw)}</Box>;
  });
};
