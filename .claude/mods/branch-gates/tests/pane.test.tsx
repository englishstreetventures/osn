import { expect, test } from "claude-code/testing";

import {
  DIFF,
  MAIN_SCRIPT,
  PANE,
  START,
  T0,
  clockText,
  commands,
  count,
  gitTable,
  texts,
  world,
} from "./world";

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
    expect(shown).toContain(`updated ${clockText(T0)}`);
    await ui.unmount();
  }

  // No argument names main by a short ref: each is `refs/remotes/origin/…`.
  for (const arg of fake.spawned.flatMap((spawn) => spawn.argv)) {
    if (arg.includes("origin/main")) expect(arg).toContain("refs/remotes/origin/main");
  }
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

test("the changeset check runs main's copy of the script, never the checkout's", async ($, on) => {
  const fake = world(on);
  await $.session.start(START);
  await fake.clock.settle();

  const bash = fake.spawned.filter((spawn) => spawn.argv[0] === "bash");
  expect(bash).toHaveLength(1);
  expect(bash[0]?.argv).toEqual(["bash", "-c", MAIN_SCRIPT]);
  expect(bash[0]?.stdin).toBe(`${DIFF}\n`);
  for (const arg of fake.spawned.flatMap((spawn) => spawn.argv)) {
    expect(/(^|\/)scripts\/changeset-required\.sh$/.test(arg)).toBe(false);
  }

  // The fake answers `required` only for that stdin, so the verdict proves
  // the file list reached the script.
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  expect(await texts(ui)).toContain("changeset ✗ required, missing");
  await ui.unmount();
});

test("gates come from the ## Gates section alone", async ($, on) => {
  const fake = world(on);
  await $.session.start(START);
  await fake.clock.settle();

  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  const rows = (await texts(ui)).filter((line) => /^[✓✗○·] /.test(line));
  expect(rows).toEqual([
    "✓ stress-plan round 1 — RAN: 18 findings, all fixed",
    "○ claude plugin test — NOT RUN",
    "✗ bun run check — FAILED on osn/api",
  ]);
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

test("without NEW-FEAT.md the pane points at /new-feat", async ($, on) => {
  const fake = world(on, { plan: null });
  await $.session.start(START);
  await fake.clock.settle();

  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  expect(await texts(ui)).toContain("No NEW-FEAT.md. Run /new-feat.");
  await ui.unmount();
});

test("the band asks for a missing changeset", async ($, on) => {
  on("ui.render", (host, e) => {
    const { Text } = host.ui.resolve(e);
    return <Text>engine</Text>;
  });
  const fake = world(on);
  await $.session.start(START);
  await fake.clock.settle();

  const ui = await $.ui.mount({
    plugin: "branch-gates",
    component: "AbovePrompt",
    props: { hasSurvey: false },
    surface: "terminal",
  } as never);
  expect((await ui.find({ type: "Text", text: /Changeset/ }))?.text).toBe(
    "Changeset required for this diff, none on the branch: bun run changeset",
  );
  await ui.unmount();
});

test("Bash calls refresh on a trailing 2 s debounce", async ($, on) => {
  const fake = world(on);
  const measures = () => count(fake, /^git rev-parse --show-toplevel HEAD$/);

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
