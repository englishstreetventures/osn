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
import { measure } from "./measure";
import { readPr } from "./pr";
import { git } from "./spawn";

// What the pane draws from, held by the host for the session so a hot reload
// keeps it. A tag changes whenever its value's fields change: a value stored
// under another tag reads as absent.
// oxlint-disable anti-slop/no-shape-in-symbol-names -- `shape` is the engine's own name for an atom's tag
const repo = atom({ plugin: "branch-gates", key: "repo" } as const, null, {
  shape: "repo-1",
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

// The one repository the mod works in: https or ssh, with or without `.git`.
const OSN_REMOTE = /(^|[/:])englishstreetventures\/osn(\.git)?\/?$/i;

// Tools whose run can change the branch, the plan or the working tree.
const MUTATING = new Set(["Bash", "Edit", "Write", "NotebookEdit"]);
// A Bash command that can change what `gh pr view` answers.
const PR_TRIGGER = /(^|[\s;&|(])(git\b[^;&|]*\spush|gh)(\s|$)/;

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
  if (ran.isError !== true || ran.text === undefined) return null;
  const prefix = `PreToolUse:${tool} hook error: agent-guard: `;
  if (!ran.text.startsWith(prefix)) return null;
  return ran.text.slice(prefix.length).split("\n")[0]?.trim() || null;
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
  deciding: Promise<boolean> | null;
  measuring: Promise<Snapshot | null>;
  measuredAt: number | null;
  measureTimer: Timer | null;
  prAt: number | null;
  prTimer: Timer | null;
  isTouchedDuringRun: boolean;
};

const live: Live = {
  complexities: new Map(),
  deciding: null,
  measuring: Promise.resolve(null),
  measuredAt: null,
  measureTimer: null,
  prAt: null,
  prTimer: null,
  isTouchedDuringRun: false,
};

// Whether origin is this repository: worked out once, then kept in state.
const decide = async ($: EngineInterface) => {
  const url = await git($, "config", "--get", "remote.origin.url");
  const verdict: RepoGate = url !== null && OSN_REMOTE.test(url) ? "on" : "off";
  await update($, repo, () => verdict);
  return verdict === "on";
};

const isOn = async ($: EngineInterface) => {
  const held = await read($, repo);
  if (held !== null) return held === "on";
  live.deciding ??= decide($);
  return live.deciding;
};

const measureOnce = async ($: EngineInterface) => {
  try {
    const snap = await measure($, live.complexities);
    await update($, snapshot, () => snap);
    if ((await read($, fault)) !== null) await update($, fault, () => null);
    $.ui.status(statusLine(snap));
    return snap;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await update($, fault, () => message);
    return null;
  }
};

// One measure at a time, each after the one before it.
const measureNow = ($: EngineInterface) => {
  live.measuring = live.measuring.then(() => measureOnce($));
  return live.measuring;
};

const forceMeasure = async ($: EngineInterface) => {
  live.measureTimer?.cancel();
  live.measureTimer = null;
  live.measuredAt = await $.clock.now();
  return measureNow($);
};

// At most one measure per window; a request inside it runs once at its end.
const requestMeasure = async ($: EngineInterface) => {
  const now = await $.clock.now();
  const { measuredAt } = live;
  if (measuredAt === null || now - measuredAt >= MEASURE_WINDOW_MS) {
    live.measuredAt = now;
    await measureNow($);
    return;
  }
  if (live.measureTimer !== null) return;
  live.measureTimer = $.clock.after(measuredAt + MEASURE_WINDOW_MS - now, () => {
    live.measureTimer = null;
    void requestMeasure($);
  });
};

// At most one pull-request read a minute, start and `/gates` excepted; a
// request inside the window runs once at its end.
const requestPr = async ($: EngineInterface, isForced: boolean) => {
  const now = await $.clock.now();
  const { prAt } = live;
  if (isForced || prAt === null || now - prAt >= PR_WINDOW_MS) {
    live.prTimer?.cancel();
    live.prTimer = null;
    live.prAt = now;
    const view = await readPr($);
    await update($, pr, () => view);
    return;
  }
  if (live.prTimer !== null) return;
  live.prTimer = $.clock.after(prAt + PR_WINDOW_MS - now, () => {
    live.prTimer = null;
    void requestPr($, false);
  });
};

const markStale = async ($: EngineInterface) => {
  const held = await read($, checks);
  if (held === null || held.isStale) return;
  if (held.isRunning) {
    live.isTouchedDuringRun = true;
    return;
  }
  await update($, checks, (prior) => (prior === null ? null : { ...prior, isStale: true }));
};

const runChecks = async ($: EngineInterface, snap: Snapshot | null) => {
  const root = snap?.root ?? ".";
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
    if (await isOn($)) {
      await $.command.register({ name: "gates", description: DESCRIPTION });
      void $.ui.open({ id: PANE, title: TITLE });
      void forceMeasure($);
      void requestPr($, true);
    }

    return next(e);
  });

  on("command.run", { command: "gates" }, async ($, e) => {
    if (e.origin.kind !== "composer") {
      const from = e.origin.kind === "plugin" ? `plugin ${e.origin.name}` : e.origin.kind;
      return {
        text: `/gates runs this checkout's own scripts, so it runs only when typed at the prompt. This run came from ${from}.`,
      };
    }
    if (!(await isOn($))) {
      return { text: "branch-gates is off here: origin is not englishstreetventures/osn." };
    }

    await $.ui.open({ id: PANE, title: TITLE });
    const reading = requestPr($, true);
    const summary = await runChecks($, await forceMeasure($));
    await reading;

    return { text: summary };
  });

  on("tool.call", async ($, e, next) => {
    const ran = await next(e);
    const reason = guardReason(e.tool, ran);
    if (!MUTATING.has(e.tool) && reason === null) return ran;
    if (!(await isOn($))) return ran;

    if (reason !== null) {
      $.ui.toast(`Guard: ${reason}`);
      return ran;
    }
    await markStale($);
    void requestMeasure($);
    if (e.tool === "Bash" && PR_TRIGGER.test(e.command)) void requestPr($, false);

    return ran;
    // oxlint-disable-next-line promise/no-callback-in-promise -- `on(...).catch` is the engine's handler for a failed hook, not a Promise's: `next(e)` replays the call's own result
  }).catch(($, e, next) => next(e));

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
    const snap = await read($, snapshot);
    const failure = await read($, fault);

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
      ...prLines(await read($, pr)),
      SPACER,
      { text: "Checks", tone: "heading" },
      ...checkLines(await read($, checks), snap),
      SPACER,
      { text: "Gates", tone: "heading" },
      ...gateLines(snap),
    ];

    return <Box flexDirection="column">{lines.map(draw)}</Box>;
  });
};
