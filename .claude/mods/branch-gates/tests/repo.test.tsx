import { expect, test } from "claude-code/testing";

import { GATES, PANE, START, commands, count, gitTable, texts, world } from "./world";

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
  expect(commands(fake)).toEqual(["git config --get remote.origin.url"]);
});

const REMOTES = [
  ["https://github.com/englishstreetventures/osn", true],
  ["git@github.com:englishstreetventures/osn.git", true],
  ["https://github.com/englishstreetventures/osn-tracker.git", false],
  ["https://github.com/someone/osn.git", false],
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

test("a reload keeps the verdict it stored and asks git for it no more", async ($, on) => {
  // The value a load before this one stored: on. Git now names another
  // repository, so a mod that asked again would turn itself off.
  on("state.get", { key: "repo" }, () => ({
    value: { value: { shape: "repo-1", value: "on" }, version: 1 },
  }));
  const fake = world(on, { git: withRemote("https://github.com/someone/else.git") });

  await $.tool.call({ tool: "Bash", command: "ls" });
  await fake.clock.settle();

  expect(count(fake, /^git config/)).toBe(0);
  expect(count(fake, /^git status --porcelain$/)).toBe(1);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await texts(ui)).toContain("feat/example");
  await ui.unmount();

  // `/gates` stays available after the reload too.
  const ran = await $.command.run(GATES);
  expect(ran.text).toMatch(/^Ran this checkout's/);
});
