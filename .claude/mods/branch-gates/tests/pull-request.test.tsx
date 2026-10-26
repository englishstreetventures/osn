import { expect, test } from "claude-code/testing";

import { OPEN_PASSING, PANE, START, count, texts, world } from "./world";
import type { Answer, PullFixture } from "./world";

test("an open pull request with failing checks and two unresolved threads", async ($, on) => {
  const fake = world(on, {
    pull: {
      ...OPEN_PASSING,
      reviewDecision: "CHANGES_REQUESTED",
      rollup: [
        { kind: "run", status: "COMPLETED", conclusion: "SUCCESS" },
        { kind: "run", status: "COMPLETED", conclusion: "FAILURE" },
      ],
      threads: [false, true, false],
    },
  });
  await $.session.start(START);
  await fake.clock.settle();

  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    const shown = await texts(ui);
    expect(shown).toContain("#42 open · CI failing · 2 unresolved");
    expect(shown).toContain("review: changes requested");
    await ui.unmount();
  }
});

test("an empty rollup reads CI pending", async ($, on) => {
  const fake = world(on, { pull: { ...OPEN_PASSING, rollup: [] } });
  await $.session.start(START);
  await fake.clock.settle();

  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  expect(await texts(ui)).toContain("#42 open · CI pending · 0 unresolved");
  await ui.unmount();
});

test("a gh failure shows its first stderr line", async ($, on) => {
  const fake = world(on, {
    answer: (spawn): Answer =>
      spawn.argv[0] === "gh" && spawn.argv[1] === "pr"
        ? {
            exitCode: 1,
            stderr: 'no pull requests found for branch "feat/example"\nsecond line\n',
          }
        : undefined,
  });
  await $.session.start(START);
  await fake.clock.settle();

  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await texts(ui)).toContain('gh: no pull requests found for branch "feat/example"');
  await ui.unmount();
});

test("a gh that cannot start reads gh not installed", async ($, on) => {
  const fake = world(on, {
    answer: (spawn): Answer => (spawn.argv[0] === "gh" ? "refuse" : undefined),
  });
  await $.session.start(START);
  await fake.clock.settle();

  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  const shown = await texts(ui);
  expect(shown).toContain("gh not installed");
  expect(shown).toContain("Issue #412");
  await ui.unmount();
});

test("a gh that outlives its timeout reads gh timed out", async ($, on) => {
  const fake = world(on, {
    answer: async (spawn, clock): Promise<Answer> => {
      if (spawn.argv[0] !== "gh" || spawn.argv[1] !== "pr") return undefined;
      await clock.sleep(spawn.timeoutMs ?? 0);
      return "refuse";
    },
  });
  await $.session.start(START);
  await fake.clock.settle();
  await fake.clock.advance(30_000);

  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await texts(ui)).toContain("gh timed out");
  await ui.unmount();
});

for (const [state, word] of [
  ["MERGED", "merged"],
  ["CLOSED", "closed"],
] as const) {
  test(`a ${word} pull request reads as ${word}`, async ($, on) => {
    const fake = world(on, { pull: { ...OPEN_PASSING, state } });
    await $.session.start(START);
    await fake.clock.settle();

    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
    const shown = await texts(ui);
    expect(shown).toContain(`#42 ${word}`);
    expect(shown.some((line) => /open/.test(line))).toBe(false);
    await ui.unmount();
    expect(count(fake, /^gh api graphql/)).toBe(0);
  });
}

test("pushes refresh the pull request at most once a minute, with one trailing refresh", async ($, on) => {
  const fake = world(on);
  const views = () => count(fake, /^gh pr view/);

  await $.tool.call({ tool: "Bash", command: "git push -u origin feat/example" });
  await fake.clock.settle();
  expect(views()).toBe(1);
  expect(count(fake, /^gh api graphql/)).toBe(1);

  await fake.clock.advance(10_000);
  await $.tool.call({ tool: "Bash", command: "git push" });
  await fake.clock.settle();
  expect(views()).toBe(1);

  await fake.clock.advance(50_000);
  expect(views()).toBe(2);

  await fake.clock.advance(120_000);
  expect(views()).toBe(2);
});

const ROLLUPS: readonly (readonly [string, PullFixture["rollup"], string])[] = [
  [
    "SKIPPED and NEUTRAL pass",
    [
      { kind: "run", status: "COMPLETED", conclusion: "SKIPPED" },
      { kind: "run", status: "COMPLETED", conclusion: "NEUTRAL" },
      { kind: "context", state: "SUCCESS" },
    ],
    "CI passing",
  ],
  [
    "IN_PROGRESS is pending",
    [
      { kind: "run", status: "COMPLETED", conclusion: "SUCCESS" },
      { kind: "run", status: "IN_PROGRESS", conclusion: "" },
    ],
    "CI pending",
  ],
  ["a PENDING status is pending", [{ kind: "context", state: "PENDING" }], "CI pending"],
  [
    "FAILURE fails",
    [
      { kind: "run", status: "IN_PROGRESS", conclusion: "" },
      { kind: "run", status: "COMPLETED", conclusion: "FAILURE" },
    ],
    "CI failing",
  ],
  ["an ERROR status fails", [{ kind: "context", state: "ERROR" }], "CI failing"],
];

for (const [name, rollup, verdict] of ROLLUPS) {
  test(`rollup: ${name}`, async ($, on) => {
    const fake = world(on, { pull: { ...OPEN_PASSING, rollup } });
    await $.session.start(START);
    await fake.clock.settle();

    const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
    expect(await texts(ui)).toContain(`#42 open · ${verdict} · 0 unresolved`);
    await ui.unmount();
  });
}

test("a full page of 100 unresolved threads reads 100+", async ($, on) => {
  const fake = world(on, {
    pull: { ...OPEN_PASSING, threads: Array.from({ length: 100 }, () => false) },
  });
  await $.session.start(START);
  await fake.clock.settle();

  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  expect(await texts(ui)).toContain("#42 open · CI passing · 100+ unresolved");
  await ui.unmount();
});
