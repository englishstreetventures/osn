import { expect, test } from "claude-code/testing";

import {
  GATES,
  HEAD,
  MERGE_BASE,
  PANE,
  ROOT,
  START,
  commands,
  count,
  gitTable,
  texts,
  world,
} from "./world";
import type { Answer, Spawn } from "./world";

const SHORT = HEAD.slice(0, 7);

// Which of the three checks a spawn is, by the script it runs.
const checkOf = (spawn: Spawn) => {
  const line = spawn.argv.join(" ");
  if (line.endsWith("verify-vendored-anti-slop.sh && bun run lint")) return "lint";
  if (line === "bun run fmt:check") return "fmt";
  if (line.startsWith("bash scripts/guard-lint-warnings.sh")) return "ceiling";
  return null;
};

const ROWS = /^[✓✗○] (lint|fmt:check|lint-warning ceiling)\b/;

const rowsOf = async (shown: Promise<string[]>) => (await shown).filter((line) => ROWS.test(line));

test("a Bash call runs no lint, format or warning check", async ($, on) => {
  const fake = world(on);
  await $.session.start(START);
  await fake.clock.settle();
  await $.tool.call({ tool: "Bash", command: "bun run build" });
  await fake.clock.advance(5_000);

  expect(fake.spawned.filter((spawn) => checkOf(spawn) !== null)).toEqual([]);
  expect(commands(fake).some((line) => /lint|fmt/.test(line))).toBe(false);
});

test("/gates with all three passing shows three ✓, HEAD and the time", async ($, on) => {
  const fake = world(on);
  await $.session.start(START);
  await fake.clock.settle();
  const ran = await $.command.run(GATES);

  expect(ran.text).toBe(
    `Ran this checkout's own lint, fmt:check and lint-warning ceiling scripts at ${SHORT}: lint ✓, fmt:check ✓, lint-warning ceiling ✓.`,
  );
  const checks = fake.spawned.filter((spawn) => checkOf(spawn) !== null);
  expect(checks.map(checkOf)).toEqual(["lint", "fmt", "ceiling"]);
  expect(checks.map((spawn) => spawn.cwd)).toEqual([ROOT, ROOT, ROOT]);
  expect(checks[2]?.argv).toEqual(["bash", "scripts/guard-lint-warnings.sh", "--base", MERGE_BASE]);
  expect(checks.map((spawn) => spawn.timeoutMs)).toEqual([120_000, 120_000, 300_000]);

  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  const shown = await texts(ui);
  expect(shown).toContain(`ran at ${SHORT} · 12:00:00`);
  expect(await rowsOf(texts(ui))).toEqual(["✓ lint", "✓ fmt:check", "✓ lint-warning ceiling"]);
  await ui.unmount();
});

test("/gates shows a failing lint with its first output line", async ($, on) => {
  const fake = world(on, {
    answer: (spawn): Answer =>
      checkOf(spawn) === "lint"
        ? { exitCode: 1, stdout: "\n  x eslint(no-unused-vars): `a` is never used\n  more\n" }
        : undefined,
  });
  await $.session.start(START);
  await fake.clock.settle();
  await $.command.run(GATES);

  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await rowsOf(texts(ui))).toEqual([
    "✗ lint — x eslint(no-unused-vars): `a` is never used",
    "✓ fmt:check",
    "✓ lint-warning ceiling",
  ]);
  await ui.unmount();
});

test("/gates shows a failing warning ceiling on its own row", async ($, on) => {
  const fake = world(on, {
    answer: (spawn): Answer =>
      checkOf(spawn) === "ceiling"
        ? { exitCode: 1, stderr: "lint warnings: 1201, above the ceiling of 1200\n" }
        : undefined,
  });
  await $.session.start(START);
  await fake.clock.settle();
  await $.command.run(GATES);

  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  expect(await rowsOf(texts(ui))).toEqual([
    "✓ lint",
    "✓ fmt:check",
    "✗ lint-warning ceiling — lint warnings: 1201, above the ceiling of 1200",
  ]);
  await ui.unmount();
});

test("/gates without node_modules runs nothing and says so on each row", async ($, on) => {
  const fake = world(on, { hasModules: false });
  await $.session.start(START);
  await fake.clock.settle();
  await $.command.run(GATES);

  expect(fake.spawned.filter((spawn) => checkOf(spawn) !== null)).toEqual([]);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await rowsOf(texts(ui))).toEqual([
    "○ lint — not run: no node_modules",
    "○ fmt:check — not run: no node_modules",
    "○ lint-warning ceiling — not run: no node_modules",
  ]);
  await ui.unmount();
});

test("a new HEAD or a changed git status makes the rows stale", async ($, on) => {
  const fake = world(on);
  await $.session.start(START);
  await fake.clock.settle();
  await $.command.run(GATES);

  // A commit made outside the session, seen by the next measure.
  fake.git.set(
    "rev-parse HEAD --abbrev-ref HEAD",
    "ffff000011112222333344445555666677778888\nfeat/example",
  );
  await $.session.start(START);
  await fake.clock.settle();
  let ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  expect(await rowsOf(texts(ui))).toEqual([
    "○ lint — stale",
    "○ fmt:check — stale",
    "○ lint-warning ceiling — stale",
  ]);
  await ui.unmount();

  // The same for the working tree: run again, then change only git status.
  await $.command.run(GATES);
  fake.git.set("--no-optional-locks status --porcelain", " M NEW-FEAT.md\n?? new.ts");
  await $.session.start(START);
  await fake.clock.settle();
  ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  expect(await rowsOf(texts(ui))).toEqual([
    "○ lint — stale",
    "○ fmt:check — stale",
    "○ lint-warning ceiling — stale",
  ]);
  await ui.unmount();
});

test("an Edit after /gates makes its rows stale", async ($, on) => {
  const fake = world(on);
  await $.session.start(START);
  await fake.clock.settle();
  await $.command.run(GATES);

  await $.tool.call({ tool: "Edit", file_path: "/repo/a.ts", old_string: "a", new_string: "b" });
  await fake.clock.advance(5_000);

  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await rowsOf(texts(ui))).toEqual([
    "○ lint — stale",
    "○ fmt:check — stale",
    "○ lint-warning ceiling — stale",
  ]);
  await ui.unmount();
});

test("/gates started by a plugin runs no process and says why", async ($, on) => {
  const fake = world(on);
  await $.session.start(START);
  await fake.clock.settle();
  const before = fake.spawned.length;

  const ran = await $.command.run({ ...GATES, origin: { kind: "plugin", name: "other" } });

  expect(ran.text).toBe(
    "/gates runs this checkout's own scripts, so it runs only when typed at the prompt. This run came from plugin other.",
  );
  expect(fake.spawned.length).toBe(before);
});

test("a check that outlives its timeout reads timed out; one that cannot start says so", async ($, on) => {
  const fake = world(on, {
    answer: async (spawn, clock): Promise<Answer> => {
      const check = checkOf(spawn);
      if (check === "lint") {
        await clock.sleep(120_000);
        return "refuse";
      }
      return check === "fmt" ? "refuse" : undefined;
    },
  });
  await $.session.start(START);
  await fake.clock.settle();

  const ran = $.command.run(GATES);
  await fake.clock.settle();
  await fake.clock.advance(120_000);
  await ran;

  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  expect(await rowsOf(texts(ui))).toEqual([
    "✗ lint — timed out",
    "✗ fmt:check — could not start",
    "✓ lint-warning ceiling",
  ]);
  await ui.unmount();
  expect(count(fake, /guard-lint-warnings/)).toBe(1);
});

test("with no merge base the warning ceiling is not run, and says why", async ($, on) => {
  const git = gitTable();
  git.delete("merge-base refs/remotes/origin/main HEAD");
  const fake = world(on, { git });
  await $.session.start(START);
  await fake.clock.settle();
  await $.command.run(GATES);

  expect(count(fake, /guard-lint-warnings/)).toBe(0);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await rowsOf(texts(ui))).toEqual([
    "✓ lint",
    "✓ fmt:check",
    "○ lint-warning ceiling — not run: no merge base with refs/remotes/origin/main",
  ]);
  await ui.unmount();
});

test("an Edit that lands while /gates runs leaves the finished rows stale", async ($, on) => {
  const fake = world(on, {
    answer: async (spawn, clock): Promise<Answer> => {
      if (checkOf(spawn) !== "fmt") return undefined;
      await clock.sleep(1_000);
      return undefined;
    },
  });
  await $.session.start(START);
  await fake.clock.settle();

  const ran = $.command.run(GATES);
  await fake.clock.settle();
  await $.tool.call({ tool: "Edit", file_path: "/repo/a.ts", old_string: "a", new_string: "b" });
  await fake.clock.settle();
  await fake.clock.advance(1_000);
  await ran;
  await fake.clock.advance(5_000);

  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  expect(await rowsOf(texts(ui))).toEqual([
    "○ lint — stale",
    "○ fmt:check — stale",
    "○ lint-warning ceiling — stale",
  ]);
  await ui.unmount();
});
