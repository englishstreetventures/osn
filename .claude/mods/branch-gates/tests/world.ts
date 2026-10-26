import type { FsStat, On, ToolCallResult } from "claude-code";
import { mock } from "claude-code/testing";
import type { MockClock } from "claude-code/testing";

// The engine beneath branch-gates in a test: git, gh, the scripts, the file
// system and the display, each answered from memory and recorded.

export const ROOT = "/repo";
export const OSN_REMOTE = "https://github.com/englishstreetventures/osn.git";
export const SCRIPT_TEXT = "# the mods' own copy of changeset-required.sh";
export const DIFF = "osn/api/src/a.ts\nosn/api/src/b.ts";
export const HEAD = "abc1234def567890abc1234def567890abc12345";
export const MERGE_BASE = "f00df00df00df00df00df00df00df00df00df00d";

// A test module's own URL, which the test runner sets.
declare global {
  interface ImportMeta {
    readonly url: string;
  }
}

// Where the mod's own worktree keeps the script: four folders up from this
// file (tests, branch-gates, mods, .claude), worked out from the test's own
// location rather than from anything the mod computes.
export const PLUGIN_SCRIPT = new URL("../../../../scripts/changeset-required.sh", import.meta.url)
  .pathname;

// Noon on 26 October 2026 on the machine's own clock, which the pane draws
// as 12:00:00 in every time zone.
export const T0 = new Date(2026, 9, 26, 12, 0, 0).getTime();

// This repository's own Gates table, in the shape NEW-FEAT.md writes it.
export const PLAN = `# NEW-FEAT — feat/example

Issue: #412

## Failure list

1. A lint failure in the changeset check: this names lint, test and prep-pr.
- bun run check: a bullet outside the gates section

## Gates

| Gate | Status |
|---|---|
| stress-plan round 1 | RAN: 18 findings (1 high, 9 medium, 8 low), all fixed (\`PLAN-REVIEW.md\`) |
| claude plugin test (both mods) | RAN on 4102b95: branch-gates 41 pass / 0 fail (5 files); model-colour 6 pass / 0 fail |
| oxlint -c oxlintrc.json .claude/mods | RAN on 4102b95: 0 errors, 0 warnings |
| bun run fmt:check / bun run lint | RAN on 4102b95: exit 0 / exit 0 (743 warnings, none in .claude/mods) |
| bun run test:scripts | NOT RUN: nothing under scripts/ changed |
| bun run check | FAILED on osn/api |
| prep-pr | NOT RUN |

## Files

- prep-pr: NOT RUN
`;

export const PANE = {
  plugin: "branch-gates",
  component: "Pane",
  requestId: "branch-gates",
  props: {
    title: "Branch gates",
    isFocused: false,
    bodyColumns: 60,
    placement: "dock",
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const;

export const BAND = {
  plugin: "branch-gates",
  component: "AbovePrompt",
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const;

export const START = { cwd: ROOT, surface: "desktop", isInteractive: true } as const;

export const GATES = {
  command: "gates",
  args: "",
  origin: { kind: "composer" },
  presentation: { isFullscreen: false, columns: 80 },
} as const;

// What git prints in the root for each argument list, joined by spaces.
// Every ref is spelled in full: an argument list not listed here exits 1.
export const gitTable = () =>
  new Map([
    ["rev-parse --show-toplevel", ROOT],
    ["config --get remote.origin.url", OSN_REMOTE],
    ["rev-parse HEAD --abbrev-ref HEAD", `${HEAD}\nfeat/example`],
    ["rev-list --count refs/remotes/origin/main..HEAD", "4"],
    ["diff --name-only refs/remotes/origin/main...HEAD", DIFF],
    ["--no-optional-locks status --porcelain", " M NEW-FEAT.md"],
    ["merge-base refs/remotes/origin/main HEAD", MERGE_BASE],
  ]);

export type Reply = { exitCode: number; stdout?: string; stderr?: string };

export type Spawn = {
  argv: readonly string[];
  stdin: string | undefined;
  cwd: string | undefined;
  timeoutMs: number | undefined;
};

// A test's own answer for a spawn: a reply, `'refuse'` for a spawn that
// rejects, or undefined to fall through to the default answers below.
export type Answer = Reply | "refuse" | undefined;

export type CheckRun = { kind: "run"; status: string; conclusion: string };
export type StatusContext = { kind: "context"; state: string };

export type PullFixture = {
  number: number;
  state: string;
  reviewDecision: string;
  url?: string;
  rollup: readonly (CheckRun | StatusContext)[];
  threads: readonly boolean[];
};

export const OPEN_PASSING: PullFixture = {
  number: 42,
  state: "OPEN",
  reviewDecision: "",
  rollup: [{ kind: "run", status: "COMPLETED", conclusion: "SUCCESS" }],
  threads: [],
};

export const prJson = (pull: PullFixture) =>
  JSON.stringify({
    number: pull.number,
    state: pull.state,
    reviewDecision: pull.reviewDecision,
    url: pull.url ?? `https://github.com/englishstreetventures/osn/pull/${pull.number}`,
    statusCheckRollup: pull.rollup.map((item) =>
      item.kind === "run"
        ? {
            __typename: "CheckRun",
            name: "Lint & Format",
            status: item.status,
            conclusion: item.conclusion,
          }
        : { __typename: "StatusContext", context: "deploy", state: item.state },
    ),
  });

export const threadsJson = (threads: readonly boolean[]) =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { nodes: threads.map((isResolved) => ({ isResolved })) },
        },
      },
    },
  });

// The raw string fields and the typed number the thread count must carry.
const THREAD_FIELDS = [
  ["-f", "owner=englishstreetventures"],
  ["-f", "name=osn"],
  ["-F", "number=42"],
] as const;

const hasFields = (args: readonly string[]) =>
  THREAD_FIELDS.every(([flag, value]) =>
    args.some((arg, at) => arg === flag && args[at + 1] === value),
  );

export const planStat = (text: string): FsStat => ({
  kind: "file",
  size: text.length,
  mtimeMs: 0,
  isLink: false,
});

export type Setup = {
  git?: Map<string, string>;
  plan?: string | null;
  stat?: FsStat;
  labels?: string;
  pull?: PullFixture;
  hasModules?: boolean;
  tool?: ToolCallResult;
  answer?: (spawn: Spawn, clock: MockClock) => Answer | Promise<Answer>;
};

export type Fake = {
  clock: MockClock;
  git: Map<string, string>;
  spawned: Spawn[];
  reads: string[];
  toasts: string[];
  statuses: string[];
  registered: string[];
  opened: string[];
  cwd: string;
};

const reply = ({ exitCode, stdout = "", stderr = "" }: Reply) => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
});

const isInRoot = (cwd: string | undefined) =>
  cwd !== undefined && (cwd === ROOT || cwd.startsWith(`${ROOT}/`));

const defaultAnswer = (spawn: Spawn, fake: Fake, setup: Setup): Reply => {
  const [cmd = "", ...args] = spawn.argv;
  const joined = args.join(" ");

  if (cmd === "git") {
    const out = isInRoot(spawn.cwd) ? fake.git.get(joined) : undefined;
    return out === undefined
      ? { exitCode: 128, stderr: "fatal: not here" }
      : { exitCode: 0, stdout: `${out}\n` };
  }
  if (cmd === "bash" && args[0] === "-c" && args[1] === SCRIPT_TEXT) {
    return { exitCode: 0, stdout: spawn.stdin === `${DIFF}\n` ? "required\n" : "skip\n" };
  }
  if (cmd === "gh" && args[0] === "issue") {
    return { exitCode: 0, stdout: setup.labels ?? "product:osn\ncomplexity:3\n" };
  }
  if (cmd === "gh" && args[0] === "pr") {
    return { exitCode: 0, stdout: prJson(setup.pull ?? OPEN_PASSING) };
  }
  if (cmd === "gh" && args[0] === "api") {
    return hasFields(args)
      ? { exitCode: 0, stdout: threadsJson((setup.pull ?? OPEN_PASSING).threads) }
      : { exitCode: 1, stderr: "gh: wrong fields" };
  }
  return { exitCode: 0, stdout: "ok\n" };
};

export const world = (on: On, setup: Setup = {}): Fake => {
  const fake: Fake = {
    clock: mock.clock(on, { now: T0 }),
    git: setup.git ?? gitTable(),
    spawned: [],
    reads: [],
    toasts: [],
    statuses: [],
    registered: [],
    opened: [],
    cwd: ROOT,
  };
  const plan = setup.plan === undefined ? PLAN : setup.plan;

  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.cwd", () => ({ value: fake.cwd }));
  on("session.root", () => ({ value: ROOT }));
  on("command.register", (_, e) => {
    fake.registered.push(e.name);
    return { value: { command: e.name } };
  });
  on("ui.open", (_, e) => {
    fake.opened.push(e.id);
    return { value: { isPlaced: true } };
  });
  on("ui.status", (_, e) => {
    fake.statuses.push(e.text ?? "");
    return { value: undefined };
  });
  on("ui.toast", (_, e) => {
    fake.toasts.push(e.text);
    return { value: undefined };
  });
  on("fs.stat", (_, e) => {
    if (e.path !== `${ROOT}/NEW-FEAT.md` || plan === null) return { deny: "ENOENT" };
    return { value: setup.stat ?? planStat(plan) };
  });
  on("fs.read", (_, e) => {
    fake.reads.push(e.path);
    if (e.path === PLUGIN_SCRIPT) return { value: SCRIPT_TEXT };
    if (plan === null || e.path !== `${ROOT}/NEW-FEAT.md`) return { deny: "ENOENT" };
    return { value: plan };
  });
  on("fs.exists", (_, e) => ({
    value: e.path === `${ROOT}/node_modules` && (setup.hasModules ?? true),
  }));
  on("tool.call", () => setup.tool ?? { result: {} });
  on("process.run", async (_, e) => {
    const spawn: Spawn = {
      argv: e.argv,
      stdin: e.init?.stdin,
      cwd: e.init?.cwd,
      timeoutMs: e.init?.timeoutMs,
    };
    fake.spawned.push(spawn);
    const own = setup.answer ? await setup.answer(spawn, fake.clock) : undefined;
    if (own === "refuse") return { deny: "spawn failed" };
    return reply(own ?? defaultAnswer(spawn, fake, setup));
  });

  return fake;
};

// Every argument list the plugin spawned, each joined by spaces.
export const commands = (fake: Fake) => fake.spawned.map((spawn) => spawn.argv.join(" "));

export const count = (fake: Fake, pattern: RegExp) =>
  commands(fake).filter((command) => pattern.test(command)).length;

// The texts a mounted drawing shows, in document order.
export const texts = async (ui: {
  findAll: (query: { type: string }) => Promise<readonly { text: string }[]>;
}) => (await ui.findAll({ type: "Text" })).map((element) => element.text);
