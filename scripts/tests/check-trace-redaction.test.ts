// Tests for scripts/check-trace-redaction.ts: the pure checks against fixture
// configs, the parser on both file kinds, and the CLI's two modes run as a
// subprocess. The `script-tests` job in .github/workflows/ci.yml runs these and
// then runs the script against the committed configs; both halves are needed.

import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkApiWorker,
  checkCommittedConfigs,
  checkGuestWorker,
  parseWorkerConfig,
} from "../check-trace-redaction";

const SCRIPT = new URL("../check-trace-redaction.ts", import.meta.url).pathname;

const apiToml = `
name = "osn-api"

[observability]
enabled = true
redact_query_string = false

[observability.traces]
enabled = true

[env.dev.observability]
redact_query_string = false

[env.dev.observability.traces]
enabled = true

[env.staging.observability]
redact_query_string = true

[env.staging.observability.traces]
enabled = false

[env.production.observability]
redact_query_string = true

[env.production.observability.traces]
enabled = false
`;

const api = (toml: string) => checkApiWorker("api", parseWorkerConfig("wrangler.toml", toml));

test("an API config that redacts staging and production, traces off there, passes", () => {
  // The fixture's top level and dev both trace with redaction off, as local
  // and dev do by decision; only staging and production are judged.
  expect(api(apiToml)).toEqual([]);
});

test("catches production with query redaction off", () => {
  const toml = apiToml.replace(
    "[env.production.observability]\nredact_query_string = true",
    "[env.production.observability]\nredact_query_string = false",
  );
  expect(api(toml)).toEqual([
    { where: "api [env.production]", problem: "observability.redact_query_string must be true" },
  ]);
});

test("catches production native traces turned on", () => {
  const toml = apiToml.replace(
    "[env.production.observability.traces]\nenabled = false",
    "[env.production.observability.traces]\nenabled = true",
  );
  expect(api(toml)).toEqual([
    {
      where: "api [env.production]",
      problem: "observability.traces.enabled must not be true: request paths carry ids and slugs",
    },
  ]);
});

test("a tier with no observability block is judged by the top-level block it inherits", () => {
  const toml = `
[observability]
redact_query_string = false

[observability.traces]
enabled = true

[env.staging]
name = "staging"
`;
  expect(api(toml)).toEqual([
    { where: "api [env.staging]", problem: "observability.redact_query_string must be true" },
    {
      where: "api [env.staging]",
      problem: "observability.traces.enabled must not be true: request paths carry ids and slugs",
    },
  ]);
});

test("a missing redaction key is a finding, not a pass", () => {
  const toml = `
[env.production.observability]
enabled = true
`;
  expect(api(toml)).toEqual([
    { where: "api [env.production]", problem: "observability.redact_query_string must be true" },
  ]);
});

const guestJsonc = `{
  // The guest Worker: top level is production.
  "name": "cire-invites",
  "observability": {
    "enabled": true,
    "redact_query_string": true,
    "logs": { "invocation_logs": false },
    "traces": { "enabled": true, "head_sampling_rate": 1 },
  },
}`;

const guest = (text: string) =>
  checkGuestWorker("guest", parseWorkerConfig("wrangler.jsonc", text));

test("a guest config with redaction on and invocation records off passes, traces and all", () => {
  expect(guest(guestJsonc)).toEqual([]);
});

test("catches a guest config without query redaction", () => {
  expect(
    guest(guestJsonc.replace('"redact_query_string": true', '"redact_query_string": false')),
  ).toEqual([{ where: "guest", problem: "observability.redact_query_string must be true" }]);
});

test("catches a guest config with invocation records on, or unset", () => {
  expect(guest(guestJsonc.replace('"logs": { "invocation_logs": false },', ""))).toEqual([
    { where: "guest", problem: "observability.logs.invocation_logs must be false" },
  ]);
});

test("the committed configs pass", async () => {
  expect(await checkCommittedConfigs()).toEqual([]);
});

async function run(...args: string[]) {
  const proc = Bun.spawn(["bun", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

test("CLI: the committed configs exit 0", async () => {
  const { code, stdout } = await run();
  expect(code).toBe(0);
  expect(stdout).toContain("check-trace-redaction");
});

test("CLI: a generated guest config without redaction exits 1 and names the key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-redaction-"));
  try {
    const path = join(dir, "wrangler.json");
    await writeFile(
      path,
      JSON.stringify({ name: "cire-invites", observability: { logs: { invocation_logs: false } } }),
    );
    const { code, stderr } = await run("--generated", path);
    expect(code).toBe(1);
    expect(stderr).toContain("observability.redact_query_string must be true");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI: a generated guest config that redacts exits 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-redaction-"));
  try {
    const path = join(dir, "wrangler.json");
    await writeFile(
      path,
      JSON.stringify({
        name: "cire-invites",
        observability: { redact_query_string: true, logs: { invocation_logs: false } },
      }),
    );
    expect((await run("--generated", path)).code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI: an unknown argument exits 1", async () => {
  const { code, stderr } = await run("--everything");
  expect(code).toBe(1);
  expect(stderr).toContain("unknown argument");
});
