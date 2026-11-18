import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stopAll, type Started } from "../src/processes";
import { startListen } from "../src/stripe-test-mode-launcher";

// The test-mode entry, run as the nightly job runs it. `--preflight` is the
// job's first step: it decides whether the run happens, refuses a key that is
// not a test-mode one before anything installs, and refuses an Environment any
// branch but main could read the key from. None of it may print the key.

const ENTRY = join(import.meta.dirname, "..", "src", "stripe-test-mode-launcher.ts");
const key = (kind: string, mode: string, tail = "4eC39HqLyjWDarjtT1zdp7dc"): string =>
  [kind, mode, tail].join("_");
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

// `stripe listen` stood in for by a shell script, so what reaches the uploaded
// log, and each way the CLI can fail to come up, is checked with no Stripe.
describe("startListen", () => {
  const secret = ["whsec", "listenTestSecret0"].join("_");
  const testKey = key("sk", "test");
  const ours = JSON.stringify({
    id: "evt_1",
    type: "checkout.session.completed",
    account: ACCOUNT,
  });
  const theirs = JSON.stringify({
    id: "evt_2",
    type: "checkout.session.completed",
    account: "acct_someoneElse",
    data: { object: { customer_details: { email: "someone@example.com" } } },
  });

  const fakeCli = (body: string): { cli: string; logPath: string } => {
    const dir = mkdtempSync(join(tmpdir(), "stripe-listen-"));
    const cli = join(dir, "stripe");
    writeFileSync(cli, `#!/bin/sh\n${body}\n`);
    chmodSync(cli, 0o755);
    const logPath = join(dir, "stripe-listen.log");
    writeFileSync(logPath, "");
    return { cli, logPath };
  };

  const start = (cli: string, logPath: string, procs: Started[], readyMs?: number) =>
    startListen({
      cli,
      secretKey: testKey,
      account: ACCOUNT,
      forwardTo: "http://127.0.0.1:8787/api/stripe/webhook",
      logPath,
      procs,
      readyMs,
    });

  /** The log once it holds `text`, or as it stands after two seconds. */
  const logWith = async (logPath: string, text: string): Promise<string> => {
    for (let i = 0; i < 40 && !readFileSync(logPath, "utf8").includes(text); i += 1) {
      await Bun.sleep(50);
    }
    return readFileSync(logPath, "utf8");
  };

  test("resolves with the signing secret, and logs it redacted, without other accounts' events", async () => {
    process.env["GITHUB_TOKEN"] = "launcher-only-value";
    const { cli, logPath } = fakeCli(
      [
        `echo '${ours}'`,
        `echo '${theirs}'`,
        'echo "token=${GITHUB_TOKEN:-unset} key=${STRIPE_API_KEY:+set} home=${HOME}"',
        `echo "Ready! Your webhook signing secret is ${secret} (^C to quit)" >&2`,
        'echo "<--  [200] POST http://127.0.0.1:8787/api/stripe/webhook [evt_1]"',
        "exec sleep 30",
      ].join("\n"),
    );
    const procs: Started[] = [];
    try {
      expect(await start(cli, logPath, procs)).toBe(secret);
      const log = await logWith(logPath, "[evt_1]");
      expect(log).toContain("whsec_[redacted]");
      expect(log).not.toContain(secret);
      expect(log).toContain(ours);
      expect(log).not.toContain("someone@example.com");
      expect(log).toContain("token=unset key=set");
      expect(log).not.toContain(`home=${process.env["HOME"]}\n`);
      expect(log).toContain("<--  [200] POST");
    } finally {
      delete process.env["GITHUB_TOKEN"];
      await stopAll(procs, 1000);
    }
  });

  test("rejects, naming the log, when the CLI exits before it is ready", async () => {
    const masked = key("sk", "test", "*************************0000");
    const { cli, logPath } = fakeCli(
      `echo 'level=fatal msg="Invalid API Key provided: ${masked}"' >&2\nexit 1`,
    );
    const procs: Started[] = [];
    try {
      await expect(start(cli, logPath, procs)).rejects.toThrow(
        `stripe listen exited (code 1) before it was ready; see ${logPath}`,
      );
      const log = await logWith(logPath, "stripe listen exited");
      expect(log).toContain("stripe listen exited (code 1)");
      expect(log).not.toContain(masked);
    } finally {
      await stopAll(procs, 1000);
    }
  });

  test("rejects when the CLI cannot be started at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stripe-listen-"));
    const missing = join(dir, "no-such-stripe");
    expect(existsSync(missing)).toBe(false);
    const logPath = join(dir, "stripe-listen.log");
    writeFileSync(logPath, "");
    const procs: Started[] = [];
    try {
      await expect(start(missing, logPath, procs)).rejects.toThrow("stripe listen did not start");
    } finally {
      await stopAll(procs, 1000);
    }
  });

  test("rejects when no signing secret comes in time", async () => {
    const { cli, logPath } = fakeCli('echo "Getting ready..." >&2\nexec sleep 30');
    const procs: Started[] = [];
    try {
      await expect(start(cli, logPath, procs, 300)).rejects.toThrow(
        "stripe listen printed no signing secret in 0.3s",
      );
    } finally {
      await stopAll(procs, 1000);
    }
  });
});

describe("the preflight and the run, refusing what they cannot check", () => {
  test("the preflight refuses outside GitHub Actions, with no repository to read", async () => {
    policy = MAIN_ONLY;
    const ran = await run(["--preflight"], {
      STRIPE_TEST_SECRET_KEY: key("sk", "test"),
      STRIPE_TEST_CONNECTED_ACCOUNT: ACCOUNT,
      GITHUB_REPOSITORY: "",
    });
    expect(ran.code).toBe(1);
    expect(ran.stdout).toContain("GITHUB_REPOSITORY is not set");
  });

  test("the preflight refuses when GitHub will not answer for the Environment", async () => {
    policy = MAIN_ONLY;
    const ran = await run(["--preflight"], {
      STRIPE_TEST_SECRET_KEY: key("sk", "test"),
      STRIPE_TEST_CONNECTED_ACCOUNT: ACCOUNT,
      GITHUB_REPOSITORY: "acme/missing",
    });
    expect(ran.code).toBe(1);
    expect(ran.output).not.toContain("run=true");
    expect(ran.stdout).toContain("could not read");
  });

  test("the run with no key says there is nothing to run against, and fails", async () => {
    const ran = await run([], {});
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain(
      "STRIPE_TEST_SECRET_KEY and STRIPE_TEST_CONNECTED_ACCOUNT are not set",
    );
  });
});
