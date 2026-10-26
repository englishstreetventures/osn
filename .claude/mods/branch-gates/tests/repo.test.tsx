import { expect, test } from "claude-code/testing";

import { GATES, PANE, ROOT, START, commands, count, gitTable, texts, world } from "./world";

const withRemote = (url: string) => {
  const git = gitTable();
  git.set("config --get remote.origin.url", url);
  return git;
};

test("outside this repository the mod opens nothing and registers nothing", async ($, on) => {
  const fake = world(on, { git: withRemote("https://github.com/someone/else.git") });
  await $.session.start(START);
  await fake.clock.settle();
  await $.tool.call({ tool: "Bash", command: "git push" });
  await fake.clock.advance(120_000);

  expect(fake.registered).toEqual([]);
  expect(fake.opened).toEqual([]);
  expect(commands(fake)).toEqual([
    "git rev-parse --show-toplevel",
    "git config --get remote.origin.url",
  ]);
});

const REMOTES = [
  ["https://github.com/englishstreetventures/osn", true],
  ["git@github.com:englishstreetventures/osn.git", true],
  ["ssh://git@github.com/englishstreetventures/osn.git", true],
  ["https://github.com/englishstreetventures/osn-tracker.git", false],
  ["https://github.com/someone/osn.git", false],
  ["https://gitlab.com/someone/englishstreetventures/osn.git", false],
  ["git@git.example.com:englishstreetventures/osn.git", false],
  ["/srv/git/englishstreetventures/osn", false],
] as const;

for (const [url, isOn] of REMOTES) {
  test(`origin ${url} turns the mod ${isOn ? "on" : "off"}`, async ($, on) => {
    const fake = world(on, { git: withRemote(url) });
    await $.session.start(START);
    await fake.clock.settle();

    expect(fake.registered).toEqual(isOn ? ["gates"] : []);
    expect(fake.opened).toEqual(isOn ? ["branch-gates"] : []);
  });
}

test("the root is pinned at start: after the session moves elsewhere every spawn still runs in it", async ($, on) => {
  const fake = world(on);
  await $.session.start(START);
  await fake.clock.settle();

  fake.cwd = "/tmp/other-repository";
  await fake.clock.advance(70_000);
  await $.tool.call({ tool: "Bash", command: "cd /tmp/other-repository && git push" });
  await fake.clock.advance(70_000);
  await $.command.run(GATES);

  expect(count(fake, /^git --no-optional-locks status/)).toBeGreaterThanOrEqual(3);
  expect(count(fake, /^gh pr view/)).toBe(3);
  expect(count(fake, /^bash /)).toBeGreaterThanOrEqual(2);
  for (const spawn of fake.spawned) expect(spawn.cwd).toBe(ROOT);
});

test("a reload keeps the root and verdict it stored and asks git for them no more", async ($, on) => {
  // What a load before this one stored. Git now names another repository,
  // so a mod that asked again would turn itself off.
  on("state.get", { key: "repo" }, () => ({
    value: { value: { shape: "repo-2", value: { verdict: "on", root: ROOT } }, version: 1 },
  }));
  const fake = world(on, { git: withRemote("https://github.com/someone/else.git") });

  await $.tool.call({ tool: "Bash", command: "ls" });
  await fake.clock.settle();

  expect(count(fake, /^git config/)).toBe(0);
  expect(count(fake, /^git rev-parse --show-toplevel/)).toBe(0);
  expect(count(fake, /^git --no-optional-locks status --porcelain$/)).toBe(1);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await texts(ui)).toContain("feat/example");
  await ui.unmount();

  // `/gates` stays available after the reload too.
  const ran = await $.command.run(GATES);
  expect(ran.text).toMatch(/^Ran this checkout's/);
});

test("with the mod off, /gates passes through to the project's own command", async ($, on) => {
  on("command.run", () => ({ text: "the project's own /gates" }));
  const fake = world(on, { git: withRemote("https://github.com/someone/else.git") });
  await $.session.start(START);
  await fake.clock.settle();

  const ran = await $.command.run(GATES);
  expect(ran.text).toBe("the project's own /gates");
  expect(commands(fake)).toEqual([
    "git rev-parse --show-toplevel",
    "git config --get remote.origin.url",
  ]);
});
