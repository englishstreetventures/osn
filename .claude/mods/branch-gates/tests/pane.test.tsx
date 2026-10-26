import { expect, test } from "claude-code/testing";

import {
  BAND,
  DIFF,
  PANE,
  PLAN,
  PLUGIN_SCRIPT,
  ROOT,
  SCRIPT_TEXT,
  START,
  commands,
  count,
  gitTable,
  planStat,
  texts,
  world,
} from "./world";
import type { Answer } from "./world";

const GATE_ROW = /^[✓✗○·] /;

// Whether a text holds a C0 or C1 control character.
const hasControl = (text: string) =>
  [...text].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });

test("the pane shows branch, issue, diff and changeset from full refs, on every surface", async ($, on) => {
  const fake = world(on);
  await $.session.start(START);
  await fake.clock.settle();

  for (const surface of ["terminal", "desktop", "vscode", "mobile"] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    const shown = await texts(ui);
    expect(shown).toContain("feat/example");
    expect(shown).toContain("Issue #412 · complexity 3");
    expect(shown).toContain("4 commits ahead · 2 files vs main");
    expect(shown).toContain("1 uncommitted");
    expect(shown).toContain("changeset ✗ required, missing");
    expect(shown).toContain("updated 12:00:00");
    await ui.unmount();
  }
  // No status row: the one call clears any row an earlier load pinned.
  expect(fake.statuses).toEqual([""]);

  // No argument names main by a short ref: each is `refs/remotes/origin/…`.
  for (const arg of fake.spawned.flatMap((spawn) => spawn.argv)) {
    if (arg.includes("origin/main")) expect(arg).toContain("refs/remotes/origin/main");
  }
  expect(commands(fake)).toContain("git --no-optional-locks status --porcelain");
});

test("a failing git diff reads as base unknown and changeset unknown", async ($, on) => {
  const git = gitTable();
  git.delete("diff --name-only refs/remotes/origin/main...HEAD");
  const fake = world(on, { git });
  await $.session.start(START);
  await fake.clock.settle();

  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  const shown = await texts(ui);
  expect(shown).toContain("base unknown");
  expect(shown).toContain("changeset ? unknown");
  expect(shown.some((line) => /not needed/.test(line))).toBe(false);
  await ui.unmount();
});

test("a failing git status reads as uncommitted files unknown", async ($, on) => {
  const git = gitTable();
  git.delete("--no-optional-locks status --porcelain");
  const fake = world(on, { git });
  await $.session.start(START);
  await fake.clock.settle();

  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  const shown = await texts(ui);
  expect(shown).toContain("uncommitted files unknown");
  expect(shown.some((line) => /^\d+ uncommitted/.test(line))).toBe(false);
  await ui.unmount();
});

test("the changeset script comes from the mods' own worktree, run with the file list on stdin", async ($, on) => {
  const fake = world(on);
  await $.session.start(START);
  await fake.clock.settle();

  expect(fake.reads).toContain(PLUGIN_SCRIPT);
  const bash = fake.spawned.filter((spawn) => spawn.argv[0] === "bash");
  expect(bash).toHaveLength(1);
  expect(bash[0]?.argv).toEqual(["bash", "-c", SCRIPT_TEXT]);
  expect(bash[0]?.stdin).toBe(`${DIFF}\n`);
  expect(bash[0]?.cwd).toBe(ROOT);
  expect(count(fake, /^git cat-file/)).toBe(0);
  for (const arg of fake.spawned.flatMap((spawn) => spawn.argv)) {
    expect(/(^|\/)scripts\/changeset-required\.sh$/.test(arg)).toBe(false);
  }

  // The fake answers `required` only for that stdin, so the verdict proves
  // the file list reached the script.
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  expect(await texts(ui)).toContain("changeset ✗ required, missing");
  await ui.unmount();
});

test("a refresh starts its four git reads together, and reruns the script only on a new file list", async ($, on) => {
  const fake = world(on, {
    answer: async (spawn, clock): Promise<Answer> => {
      if (spawn.argv.join(" ") !== "git rev-parse HEAD --abbrev-ref HEAD") return undefined;
      await clock.sleep(1_000);
      return undefined;
    },
  });
  const refresh = [
    "git rev-parse HEAD --abbrev-ref HEAD",
    "git rev-list --count refs/remotes/origin/main..HEAD",
    "git diff --name-only refs/remotes/origin/main...HEAD",
    "git --no-optional-locks status --porcelain",
  ];

  await $.session.start(START);
  await fake.clock.settle();
  // rev-parse has not answered, and the other three are already running.
  for (const command of refresh) expect(commands(fake)).toContain(command);
  await fake.clock.advance(1_000);

  const measured = commands(fake).filter((command) => command.startsWith("git"));
  expect(measured.filter((command) => !command.startsWith("git config")).toSorted()).toEqual(
    ["git rev-parse --show-toplevel", ...refresh].toSorted(),
  );
  expect(count(fake, /^bash -c/)).toBe(1);

  // The same file list and script: no second run of the script.
  await fake.clock.advance(5_000);
  await $.tool.call({ tool: "Bash", command: "ls" });
  await fake.clock.advance(5_000);
  expect(count(fake, /^git --no-optional-locks status/)).toBe(2);
  expect(count(fake, /^bash -c/)).toBe(1);

  // A new file list runs it again.
  fake.git.set("diff --name-only refs/remotes/origin/main...HEAD", `${DIFF}\nosn/api/src/c.ts`);
  await $.tool.call({ tool: "Bash", command: "ls" });
  await fake.clock.advance(5_000);
  expect(count(fake, /^bash -c/)).toBe(2);
});

test("gates come from the ## Gates section alone, read as this repository writes them", async ($, on) => {
  const fake = world(on);
  await $.session.start(START);
  await fake.clock.settle();

  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  const rows = (await texts(ui)).filter((line) => GATE_ROW.test(line));
  expect(rows).toEqual([
    "✓ stress-plan round 1 — RAN: 18 findings (1 high, 9 medium, 8 low), all fixed (PLAN-REVIEW.md)",
    "✓ claude plugin test (both mods) — RAN on 4102b95: branch-gates 41 pass / 0 fail (5 files); model-colour 6 pass / 0 fail",
    "✓ oxlint -c oxlintrc.json .claude/mods — RAN on 4102b95: 0 errors, 0 warnings",
    "✓ bun run fmt:check / bun run lint — RAN on 4102b95: exit 0 / exit 0 (743 warnings, none in .claude/mods)",
    "○ bun run test:scripts — NOT RUN: nothing under scripts/ changed",
    "✗ bun run check — FAILED on osn/api",
    "○ prep-pr — NOT RUN",
  ]);
  await ui.unmount();
});

test("a Gates table of 35 rows draws its first 30", async ($, on) => {
  const rows = Array.from({ length: 35 }, (_, at) => `| gate ${at + 1} | RAN: 1 fail |`);
  const plan = `Issue: #412\n\n## Gates\n\n| Gate | Status |\n|---|---|\n${rows.join("\n")}\n`;
  const fake = world(on, { plan });
  await $.session.start(START);
  await fake.clock.settle();

  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  const drawn = (await texts(ui)).filter((line) => GATE_ROW.test(line));
  expect(drawn).toHaveLength(30);
  expect(drawn[0]).toBe("✗ gate 1 — RAN: 1 fail");
  expect(drawn[29]).toBe("✗ gate 30 — RAN: 1 fail");
  await ui.unmount();
});

test("complexity carries (unconfirmed) when that label is on the issue", async ($, on) => {
  const fake = world(on, { labels: "product:osn\ncomplexity:3\ncomplexity:unconfirmed\n" });
  await $.session.start(START);
  await fake.clock.settle();

  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  expect(await texts(ui)).toContain("Issue #412 · complexity 3 (unconfirmed)");
  await ui.unmount();
  expect(commands(fake)).toContain(
    "gh issue view 412 --repo englishstreetventures/osn --json labels -q .labels[].name",
  );
});

test("the pane draws before gh answers for the complexity, and fills it in after", async ($, on) => {
  const fake = world(on, {
    answer: async (spawn, clock): Promise<Answer> => {
      if (spawn.argv[0] !== "gh" || spawn.argv[1] !== "issue") return undefined;
      await clock.sleep(5_000);
      return undefined;
    },
  });
  await $.session.start(START);
  await fake.clock.settle();

  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  let shown = await texts(ui);
  expect(shown).toContain("feat/example");
  expect(shown).toContain("Issue #412");
  await fake.clock.advance(5_000);
  shown = await texts(ui);
  expect(shown).toContain("Issue #412 · complexity 3");
  await ui.unmount();
  expect(fake.statuses).toEqual([""]);
});

test("without NEW-FEAT.md the pane points at /new-feat", async ($, on) => {
  const fake = world(on, { plan: null });
  await $.session.start(START);
  await fake.clock.settle();

  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  expect(await texts(ui)).toContain("No NEW-FEAT.md. Run /new-feat.");
  await ui.unmount();
});

const UNREAD = [
  ["a symbolic link", { ...planStat(PLAN), isLink: true }],
  ["a device or a pipe", { ...planStat(PLAN), kind: "other" }],
  ["a folder", { ...planStat(PLAN), kind: "dir" }],
  ["a file over 256 KB", { ...planStat(PLAN), size: 256 * 1024 + 1 }],
] as const;

for (const [name, stat] of UNREAD) {
  test(`a NEW-FEAT.md that is ${name} is never read`, async ($, on) => {
    const fake = world(on, { stat });
    await $.session.start(START);
    await fake.clock.settle();

    expect(fake.reads).not.toContain(`${ROOT}/NEW-FEAT.md`);
    const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
    expect(await texts(ui)).toContain("No NEW-FEAT.md. Run /new-feat.");
    await ui.unmount();
  });
}

test("control characters from the plan and git reach no surface", async ($, on) => {
  const plan = `Issue: #412 \u001b]52;c;eA==\u0007\n\n## Gates\n\n| Gate | Status |\n|---|---|\n| lint \u001b[2J\u009b | RAN |\n`;
  const git = gitTable();
  git.set("rev-parse HEAD --abbrev-ref HEAD", "abc1234\nfeat/\u009b31mexample");
  const fake = world(on, { plan, git });
  await $.session.start(START);
  await fake.clock.settle();

  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  const shown = await texts(ui);
  expect(shown).toContain("feat/31mexample");
  expect(shown).toContain("Issue #412 ]52;c;eA==");
  expect(shown).toContain("✓ lint [2J — RAN");
  await ui.unmount();
  for (const line of [...shown, ...fake.statuses]) expect(hasControl(line)).toBe(false);
});

test("the band asks for a missing changeset", async ($, on) => {
  on("ui.render", (host, e) => {
    const { Text } = host.ui.resolve(e);
    return <Text>engine</Text>;
  });
  const fake = world(on);
  await $.session.start(START);
  await fake.clock.settle();

  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect((await ui.find({ type: "Text", text: /Changeset/ }))?.text).toBe(
    "Changeset required for this diff, none on the branch: bun run changeset",
  );
  await ui.unmount();
});

const QUIET_BANDS = [
  ["a changeset on the branch", `${DIFF}\n.changeset/brave-owl.md`, false, "changeset ✓ present"],
  ["a diff that needs none", "wiki/conventions/agent-tooling.md", false, "changeset · not needed"],
  ["a survey above the prompt", DIFF, true, "changeset ✗ required, missing"],
] as const;

for (const [name, diff, hasSurvey, verdict] of QUIET_BANDS) {
  test(`the band stays hidden for ${name}`, async ($, on) => {
    on("ui.render", (host, e) => {
      const { Text } = host.ui.resolve(e);
      return <Text>engine</Text>;
    });
    const git = gitTable();
    git.set("diff --name-only refs/remotes/origin/main...HEAD", diff);
    const fake = world(on, { git });
    await $.session.start(START);
    await fake.clock.settle();

    const band = await $.ui.mount({
      ...BAND,
      props: { ...BAND.props, hasSurvey },
      surface: "terminal",
    });
    expect(await band.find({ type: "Text", text: /Changeset/ })).toBe(undefined);
    expect((await band.find({ type: "Text", text: /engine/ }))?.text).toBe("engine");
    await band.unmount();

    const pane = await $.ui.mount({ ...PANE, surface: "terminal" });
    expect(await texts(pane)).toContain(verdict);
    await pane.unmount();
  });
}

test("Bash calls refresh on a trailing 2 s debounce", async ($, on) => {
  const fake = world(on);
  const measures = () => count(fake, /^git --no-optional-locks status --porcelain$/);

  await $.tool.call({ tool: "Bash", command: "ls" });
  await fake.clock.settle();
  expect(measures()).toBe(1);

  await fake.clock.advance(1_000);
  await $.tool.call({ tool: "Bash", command: "ls" });
  await fake.clock.settle();
  expect(measures()).toBe(1);

  await fake.clock.advance(1_000);
  expect(measures()).toBe(2);

  await fake.clock.advance(10_000);
  expect(measures()).toBe(2);
});
