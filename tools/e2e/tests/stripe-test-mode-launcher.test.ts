import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The test-mode entry, run as the nightly job runs it. `--preflight` is the
// job's first step: it decides whether the run happens, refuses a key that is
// not a test-mode one before anything installs, and refuses an Environment any
// branch but main could read the key from. None of it may print the key.

const ENTRY = join(import.meta.dirname, "..", "src", "stripe-test-mode-launcher.ts");
const key = (kind: string, mode: string): string =>
  [kind, mode, "4eC39HqLyjWDarjtT1zdp7dc"].join("_");
const ACCOUNT = "acct_1Abc2Def3Ghi";

/** GitHub's environments API, answering for one repository with whichever policy a test sets. */
let policy: { environment: unknown; branches: unknown } = { environment: null, branches: null };
const github = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/repos/acme/osn/environments/stripe-test-mode") {
      return Response.json(policy.environment);
    }
    if (pathname === "/repos/acme/osn/environments/stripe-test-mode/deployment-branch-policies") {
      return Response.json(policy.branches);
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  },
});
afterAll(() => github.stop(true));

const MAIN_ONLY = {
  environment: {
    name: "stripe-test-mode",
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  },
  branches: { total_count: 1, branch_policies: [{ id: 1, name: "main", type: "branch" }] },
};
const ANY_BRANCH = {
  environment: { name: "stripe-test-mode", deployment_branch_policy: null },
  branches: { total_count: 0, branch_policies: [] },
};

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
  readonly summary: string;
}

async function run(args: readonly string[], env: Record<string, string>): Promise<Ran> {
  const dir = mkdtempSync(join(tmpdir(), "stripe-preflight-"));
  const output = join(dir, "output");
  const summary = join(dir, "summary");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: dir,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_REPOSITORY: "acme/osn",
      GITHUB_API_URL: `http://127.0.0.1:${github.port}`,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    code,
    stdout,
    stderr,
    output: readFileSync(output, "utf8"),
    summary: readFileSync(summary, "utf8"),
  };
}

const everything = (ran: Ran): string =>
  [ran.stdout, ran.stderr, ran.output, ran.summary].join("\n");

describe("the preflight", () => {
  test("with no key, says the run is skipped, in a notice and in the job summary, and succeeds", async () => {
    policy = MAIN_ONLY;
    const ran = await run(["--preflight"], {});
    expect(ran.code).toBe(0);
    expect(ran.output).toBe("run=false\n");
    expect(ran.stdout).toContain("::notice title=Stripe test mode skipped::");
    expect(ran.summary).toContain("STRIPE_TEST_SECRET_KEY");
    expect(ran.summary).toContain("stripe-test-mode");
  });

  test("with a live key, refuses and fails, and prints no part of the key", async () => {
    policy = MAIN_ONLY;
    const live = key("sk", "live");
    const ran = await run(["--preflight"], {
      STRIPE_TEST_SECRET_KEY: live,
      STRIPE_TEST_CONNECTED_ACCOUNT: ACCOUNT,
    });
    expect(ran.code).toBe(1);
    expect(ran.output).not.toContain("run=true");
    expect(ran.stdout).toContain("::error");
    expect(everything(ran)).not.toContain(live);
    expect(everything(ran)).not.toContain(live.slice(8));
  });

  test("with a test key and an Environment open to main alone, says run, and prints no key", async () => {
    policy = MAIN_ONLY;
    const ready = key("sk", "test");
    const ran = await run(["--preflight"], {
      STRIPE_TEST_SECRET_KEY: ready,
      STRIPE_TEST_CONNECTED_ACCOUNT: ACCOUNT,
    });
    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
    expect(ran.output).toBe("run=true\n");
    expect(everything(ran)).not.toContain(ready);
    expect(everything(ran)).not.toContain(ready.slice(8));
  });

  test("with a test key in an Environment any branch can read, refuses and fails", async () => {
    policy = ANY_BRANCH;
    const ran = await run(["--preflight"], {
      STRIPE_TEST_SECRET_KEY: key("sk", "test"),
      STRIPE_TEST_CONNECTED_ACCOUNT: ACCOUNT,
    });
    expect(ran.code).toBe(1);
    expect(ran.output).not.toContain("run=true");
    expect(ran.stdout).toContain("deployment branches");
  });
});

describe("the run", () => {
  test("with a live key, refuses before it checks a port or starts anything", async () => {
    const live = key("rk", "live");
    const ran = await run([], {
      STRIPE_TEST_SECRET_KEY: live,
      STRIPE_TEST_CONNECTED_ACCOUNT: ACCOUNT,
    });
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain("STRIPE_TEST_SECRET_KEY is not a test-mode key");
    expect(ran.stderr.trim().split("\n")).toHaveLength(1);
    expect(everything(ran)).not.toContain(live);
  });
});
