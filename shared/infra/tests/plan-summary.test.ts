import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { summarisePlan } from "../src/plan-summary";

/*
 * Fixtures are the lines Alchemy 2.0.0-beta.83 prints in a non-interactive
 * terminal, with colour on. `formatPlanLines` (alchemy src/Cli/LoggingCli.ts:84-135)
 * builds `${bold("Plan:")} ${summary}`: bold and dim are `ESC[1m`/`ESC[2m`
 * closed by `ESC[0m`, the counts are truecolor (`ESC[38;2;r;g;bm`) from the
 * theme (alchemy src/Util/Theme.ts, src/Cli/components/view/statusStyle.ts),
 * and parts are joined by a dim ", ". Each line goes out through
 * `Effect.logInfo` (LoggingCli.ts:240-250) to Effect's pretty console logger,
 * which prefixes `[HH:MM:SS.mmm] INFO (#fiber):` with the timestamp in white
 * and the level in green, wraps the message in bold cyan (effect 4.0.3
 * src/internal/effect.ts:6762-6782), and Alchemy's sink puts `ESC[0m` before
 * the message (alchemy src/Util/ConsoleSink.ts:5-17, src/Cli/GlobalLog.ts:64-76).
 */
const ESC = "\u001b";
const reset = `${ESC}[0m`;
const bold = (text: string): string => `${ESC}[1m${text}${reset}`;
const dim = (text: string): string => `${ESC}[2m${text}${reset}`;
const rgb = (r: number, g: number, b: number) => (text: string) =>
  `${ESC}[38;2;${r};${g};${b}m${text}${reset}`;
const success = rgb(154, 203, 105);
const warning = rgb(239, 184, 90);
const info = rgb(182, 199, 122);

/** One record as the pretty console logger prints it. */
const logged = (message: string): string =>
  `${ESC}[37m[03:40:12.345]${reset} ${ESC}[32mINFO${reset} (#12): ${ESC}[1m${ESC}[36m${reset}${message}${reset}`;

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
/** Lines a deploy log carries besides the plan, which the summary must never repeat. */
const NOISE = [
  logged(`ALCHEMY_CLOUDFLARE_ACCOUNT_ID: ${ACCOUNT_ID}`),
  logged(`[osn-api/OSN_JWT_PRIVATE_KEY] secret_text`),
];

const NO_CHANGES = logged(`${bold("Plan:")} ${dim("no changes")}`);
const CHANGES = logged(
  `${bold("Plan:")} ${[success("2 to create"), warning("1 to update"), info("3 binding changes")].join(dim(", "))}`,
);
const NO_RESOURCES = logged(`${bold("Plan:")} ${dim("no resources")}`);

const SCRIPT = fileURLToPath(new URL("../scripts/plan-summary.ts", import.meta.url));

interface Run {
  readonly exitCode: number;
  readonly stdout: string;
  readonly summary: string;
}

/** Runs the CLI over a log holding `lines`, with a fresh step summary file. */
function run(lines: readonly string[], flags: readonly string[]): Run {
  const dir = mkdtempSync(join(tmpdir(), "plan-summary-"));
  const log = join(dir, "alchemy.log");
  const summary = join(dir, "summary.md");
  writeFileSync(log, `${lines.join("\n")}\n`);
  writeFileSync(summary, "");
  const result = Bun.spawnSync(["bun", SCRIPT, "--stack", "musubi", ...flags, log], {
    env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    summary: readFileSync(summary, "utf8"),
  };
}

describe("plan-summary", () => {
  test("C2: --expect-no-change passes on 'Plan: no changes'", () => {
    const result = run([...NOISE, NO_CHANGES], ["--expect-no-change"]);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("### musubi: no changes\n");
  });

  test("C3: --expect-no-change fails on any count, printing the counts", () => {
    const result = run([...NOISE, CHANGES], ["--expect-no-change"]);
    expect(result.exitCode).toBe(1);
    expect(result.summary).toBe("### musubi: 2 to create, 1 to update, 3 binding changes\n");
    expect(result.stdout).toContain("2 to create, 1 to update, 3 binding changes");
    expect(run([...NOISE, CHANGES], []).exitCode).toBe(0);
  });

  test("C4: colour and the logger's prefix are stripped before matching", () => {
    expect(summarisePlan([...NOISE, NO_CHANGES].join("\n"))).toEqual({ kind: "no-changes" });
    expect(summarisePlan(NO_RESOURCES)).toEqual({ kind: "no-resources" });
    expect(summarisePlan(CHANGES)).toEqual({
      kind: "changes",
      counts: { create: 2, update: 1, "binding changes": 3 },
    });
    // The last plan line wins: `deploy` prints the plan again when it applies.
    expect(summarisePlan([CHANGES, NO_CHANGES].join("\n"))).toEqual({ kind: "no-changes" });
  });

  test("C5: a log with no plan line warns and passes, unless no change was expected", () => {
    const plain = run(NOISE, []);
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout).toMatch(/^::warning::/m);
    expect(run(NOISE, ["--expect-no-change"]).exitCode).toBe(1);
  });

  test("C6: 'Plan: no resources' fails --expect-no-change", () => {
    expect(run([...NOISE, NO_RESOURCES], ["--expect-no-change"]).exitCode).toBe(1);
  });

  test("C7: the summary carries counts only, never the account id or a secret line", () => {
    for (const plan of [NO_CHANGES, CHANGES, NO_RESOURCES]) {
      for (const flags of [[], ["--expect-no-change"]]) {
        const result = run([...NOISE, plan], flags);
        for (const text of [result.summary, result.stdout]) {
          expect(text).not.toContain(ACCOUNT_ID);
          expect(text).not.toContain("secret_text");
          expect(text).not.toContain(ESC);
        }
      }
    }
  });
});
