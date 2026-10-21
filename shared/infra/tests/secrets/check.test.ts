import { describe, expect, test } from "vitest";

import { checkGithub, checkLive, type ToolRun } from "../../src/secrets/check";
import { githubExpectations, liveExpectations } from "../../src/secrets/compare";
import type { Tier } from "../../src/stage";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

const printed = (names: readonly string[]): ToolRun => ({
  status: 0,
  stdout: JSON.stringify(names.map((name) => ({ name, type: "secret_text" }))),
  stderr: "",
});

const failed: ToolRun = {
  status: 1,
  stdout: "",
  stderr: `A request to /accounts/${ACCOUNT_ID}/workers/scripts failed (10000)\n`,
};

/** Each live Worker of `tier` holding exactly the names it must hold, with `override` replacing some. */
const live =
  (tier: Tier, override: Readonly<Record<string, ToolRun>> = {}) =>
  (scriptName: string): Promise<ToolRun> => {
    const expected = liveExpectations(tier).find((entry) => entry.scriptName === scriptName);
    if (expected === undefined) throw new Error(`no Worker ${scriptName} on ${tier}`);
    return Promise.resolve(override[scriptName] ?? printed(expected.required));
  };

const scriptNames = (tier: Tier) => liveExpectations(tier).map((entry) => entry.scriptName);

describe("checkLive", () => {
  test("exits 0 when every Worker holds the names it must", async () => {
    const outcome = await checkLive("dev", live("dev"));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toBe("");
  });

  test("exits 1 when a Worker holds a name it must not", async () => {
    const zap = liveExpectations("production").find((entry) => entry.worker === "zap-api");
    if (zap === undefined) throw new Error("zap-api has no production expectation");
    const outcome = await checkLive(
      "production",
      live("production", {
        [zap.scriptName]: printed([...zap.required, "GROWTHBOOK_CLIENT_KEY"]),
      }),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain("forbidden but set: GROWTHBOOK_CLIENT_KEY");
  });

  test.each([
    ["missing", (required: readonly string[]) => required.slice(1)],
    ["unexpected", (required: readonly string[]) => [...required, "NOT_IN_THE_INVENTORY"]],
  ])("exits 1 on a %s name", async (_kind, change) => {
    const [first] = liveExpectations("dev");
    if (first === undefined) throw new Error("dev has no live Worker");
    const outcome = await checkLive(
      "dev",
      live("dev", { [first.scriptName]: printed(change(first.required)) }),
    );
    expect(outcome.exitCode).toBe(1);
  });

  test("exits 2 naming the first failing Worker in inventory order, account id redacted", async () => {
    const [, second, third] = scriptNames("production");
    if (second === undefined || third === undefined) throw new Error("too few Workers");
    const outcome = await checkLive(
      "production",
      live("production", { [second]: failed, [third]: failed }),
    );
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toContain(`wrangler secret list --name ${second} exited 1`);
    expect(outcome.stderr).not.toContain(third);
    expect(outcome.stderr).toContain("/accounts/<account-id>/");
    expect(outcome.stderr).not.toContain(ACCOUNT_ID);
  });

  test.each([
    ["prints output it cannot read", { status: 0, stdout: "⛅️ wrangler 4.149.0", stderr: "" }],
    ["does not start", { status: null, stdout: "", stderr: "", startError: "spawn ENOENT" }],
  ] as const)("exits 2 when wrangler %s", async (_why, run) => {
    const [, second] = scriptNames("dev");
    if (second === undefined) throw new Error("too few Workers");
    const outcome = await checkLive("dev", live("dev", { [second]: run }));
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toContain(second);
  });

  test("starts nothing more when the first call fails", async () => {
    const [first] = scriptNames("production");
    if (first === undefined) throw new Error("no Workers");
    const called: string[] = [];
    const outcome = await checkLive("production", (scriptName) => {
      called.push(scriptName);
      return live("production", { [first]: failed })(scriptName);
    });
    expect(outcome.exitCode).toBe(2);
    expect(called).toEqual([first]);
  });

  test("runs the first call alone, then the rest together, and prints in inventory order", async () => {
    const names = scriptNames("production");
    let inFlight = 0;
    const seen: number[] = [];
    const outcome = await checkLive("production", async (scriptName) => {
      inFlight += 1;
      seen.push(inFlight);
      // Later Workers answer first, so a result printed in arrival order shows.
      await new Promise((resolve) =>
        setTimeout(resolve, 5 * (names.length - names.indexOf(scriptName))),
      );
      inFlight -= 1;
      return live("production")(scriptName);
    });
    expect(seen).toEqual([1, ...names.slice(1).map((_, index) => index + 1)]);
    expect(
      outcome.stdout
        .trimEnd()
        .split("\n")
        .map((line) => /\(([^)]+)\)$/.exec(line)?.[1]),
    ).toEqual(names);
  });
});

describe("checkGithub", () => {
  const listed =
    (names: readonly string[]): (() => Promise<ToolRun>) =>
    () =>
      Promise.resolve({ status: 0, stdout: names.map((name) => `${name}\n`).join(""), stderr: "" });

  test("exits 0 with a name the inventory does not know, and prints it", async () => {
    const outcome = await checkGithub(
      "dev",
      listed([...githubExpectations("dev"), "SOMETHING_ELSE"]),
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("not in the inventory: SOMETHING_ELSE");
  });

  test("exits 1 when a required name is missing", async () => {
    const outcome = await checkGithub(
      "production",
      listed(githubExpectations("production").slice(1)),
    );
    expect(outcome.exitCode).toBe(1);
  });

  test("exits 1 when the Environment holds the other tier's credential", async () => {
    const outcome = await checkGithub(
      "dev",
      listed([...githubExpectations("dev"), "CLOUDFLARE_API_TOKEN"]),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain("forbidden but set: CLOUDFLARE_API_TOKEN");
  });

  test.each([
    ["fails", failed],
    ["does not start", { status: null, stdout: "", stderr: "", startError: "spawn gh ENOENT" }],
  ] as const)("exits 2 when gh %s, account id redacted", async (_why, run) => {
    const outcome = await checkGithub("production", () => Promise.resolve(run));
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toContain("gh api");
    expect(outcome.stderr).not.toContain(ACCOUNT_ID);
  });
});
