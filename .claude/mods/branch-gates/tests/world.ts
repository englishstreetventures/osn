import type { On, ToolCallResult } from "claude-code";
import { mock } from "claude-code/testing";
import type { MockClock } from "claude-code/testing";

// The engine beneath branch-gates in a test: git, gh, the scripts, the file
// system and the display, each answered from memory and recorded.

export const OSN_REMOTE = "https://github.com/englishstreetventures/osn.git";
export const MAIN_SCRIPT = "# main copy of changeset-required.sh";
export const DIFF = "osn/api/src/a.ts\nosn/api/src/b.ts";
export const HEAD = "abc1234def567890abc1234def567890abc12345";

// 12:00:00 UTC, 26 October 2026.
export const T0 = Date.UTC(2026, 9, 26, 12, 0, 0);

// A time as the pane writes it: hh:mm:ss on the machine's own clock.
export const clockText = (ms: number) => {
  const at = new Date(ms);
  return [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
};

export const PLAN = `# NEW-FEAT — feat/example

Issue: #412

## Failure list

1. A lint failure in the changeset check: this names lint, test and prep-pr.
- bun run check: a bullet outside the gates section

## Gates

| Gate | Status |
|---|---|
| stress-plan round 1 | RAN: 18 findings, all fixed |
| claude plugin test | NOT RUN |
| bun run check | FAILED on osn/api |

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
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const;

export const START = { cwd: "/repo", surface: "desktop", isInteractive: true } as const;

export const GATES = {
  command: "gates",
  args: "",
  origin: { kind: "composer" },
  presentation: { isFullscreen: false, columns: 80 },
} as const;

// What git prints for each argument list, joined by spaces. Every ref is
// spelled in full: an argument list not listed here exits 1.
export const gitTable = () =>
  new Map([
    ["config --get remote.origin.url", OSN_REMOTE],
    ["rev-parse --show-toplevel HEAD", `/repo\n${HEAD}`],
    ["branch --show-current", "feat/example"],
    ["rev-parse --verify -q refs/remotes/origin/main", "f00df00d"],
    ["rev-list --count refs/remotes/origin/main..HEAD", "4"],
    ["diff --name-only refs/remotes/origin/main...HEAD", DIFF],
    ["status --porcelain", " M NEW-FEAT.md"],
    ["cat-file blob refs/remotes/origin/main:scripts/changeset-required.sh", MAIN_SCRIPT],
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
    url: `https://github.com/englishstreetventures/osn/pull/${pull.number}`,
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

export type Setup = {
  git?: Map<string, string>;
  plan?: string | null;
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
  toasts: string[];
  registered: string[];
  opened: string[];
};

const reply = ({ exitCode, stdout = "", stderr = "" }: Reply) => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
});

const defaultAnswer = (spawn: Spawn, fake: Fake, setup: Setup): Reply => {
  const [cmd = "", ...args] = spawn.argv;
  const joined = args.join(" ");

  if (cmd === "git") {
    const out = fake.git.get(joined);
    return out === undefined
      ? { exitCode: 1, stderr: "fatal: no" }
      : { exitCode: 0, stdout: `${out}\n` };
  }
  if (cmd === "bash" && args[0] === "-c" && args[1] === MAIN_SCRIPT) {
    return { exitCode: 0, stdout: spawn.stdin === `${DIFF}\n` ? "required\n" : "skip\n" };
  }
  if (cmd === "gh" && args[0] === "issue") {
    return { exitCode: 0, stdout: setup.labels ?? "product:osn\ncomplexity:3\n" };
  }
  if (cmd === "gh" && args[0] === "pr") {
    return { exitCode: 0, stdout: prJson(setup.pull ?? OPEN_PASSING) };
  }
  if (cmd === "gh" && args[0] === "api") {
    return { exitCode: 0, stdout: threadsJson((setup.pull ?? OPEN_PASSING).threads) };
  }
  return { exitCode: 0, stdout: "ok\n" };
};

export const world = (on: On, setup: Setup = {}): Fake => {
  const fake: Fake = {
    clock: mock.clock(on, { now: T0 }),
    git: setup.git ?? gitTable(),
    spawned: [],
    toasts: [],
    registered: [],
    opened: [],
  };
  const plan = setup.plan === undefined ? PLAN : setup.plan;

  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("command.register", (_, e) => {
    fake.registered.push(e.name);
    return { value: { command: e.name } };
  });
  on("ui.open", (_, e) => {
    fake.opened.push(e.id);
    return { value: { isPlaced: true } };
  });
  on("ui.status", () => ({ value: undefined }));
  on("ui.toast", (_, e) => {
    fake.toasts.push(e.text);
    return { value: undefined };
  });
  on("fs.read", (_, e) => {
    if (plan === null || e.path !== "/repo/NEW-FEAT.md") return { deny: "ENOENT" };
    return { value: plan };
  });
  on("fs.exists", (_, e) => ({
    value: e.path === "/repo/node_modules" && (setup.hasModules ?? true),
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
