import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import {
  checkProbeBoundary,
  PROBE,
  readWorkerConfigs,
  WORKER_CONFIGS,
  type ProbeTable,
  type WorkerConfigPath,
  type WorkerConfigs,
} from "../boundary.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

// Each test mutates its own copy of the committed configs, so a finding can
// only come from the one edit the test makes.
function committed(): WorkerConfigs {
  return structuredClone(readWorkerConfigs(repoRoot));
}

// Only the shape these tests edit; the guard itself treats every field as unknown.
type Scope = {
  name?: string;
  d1_databases?: { binding: string; database_name: string; database_id: string }[];
  r2_buckets?: { binding: string; bucket_name: string }[];
  ratelimits?: { name: string; namespace_id: string; simple: { limit: number; period: number } }[];
  unsafe?: {
    bindings?: {
      name: string;
      type: string;
      namespace_id: string;
      simple: { limit: number; period: number };
    }[];
  };
  env?: Record<string, Scope>;
};

function scope(configs: WorkerConfigs, path: WorkerConfigPath, env?: string): Scope {
  const config = configs[path] as Scope | undefined;
  if (!config) throw new Error(`fixture missing ${path}`);
  if (env === undefined) return config;
  const named = config.env?.[env];
  if (!named) throw new Error(`fixture missing ${path} [env.${env}]`);
  return named;
}

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

function table(edit: (probe: Mutable<ProbeTable>) => void): ProbeTable {
  const copy = structuredClone(PROBE as ProbeTable) as Mutable<ProbeTable>;
  edit(copy);
  return copy;
}

describe("probe boundary", () => {
  test("the committed configs and the probe table agree", () => {
    expect(checkProbeBoundary(readWorkerConfigs(repoRoot))).toEqual([]);
  });

  test("reads every Worker config that deploys into the account", () => {
    const configs = readWorkerConfigs(repoRoot);
    for (const path of WORKER_CONFIGS) expect(configs[path]).toBeDefined();
  });

  test("turbo re-runs these tests when any of those configs changes", async () => {
    const turbo = Bun.JSONC.parse(
      await Bun.file(new URL("../turbo.json", import.meta.url)).text(),
    ) as { tasks: { test: { inputs: string[] } } };
    for (const path of WORKER_CONFIGS) {
      expect(turbo.tasks.test.inputs).toContain(`$TURBO_ROOT$/${path}`);
    }
    expect(turbo.tasks.test.inputs).toContain("$TURBO_DEFAULT$");
  });

  test("a missing config or [env.dev] is refused", () => {
    const configs = committed();
    delete configs["pulse/api/wrangler.toml"];
    expect(checkProbeBoundary(configs).join("\n")).toContain("pulse/api/wrangler.toml");

    const noDev = committed();
    delete scope(noDev, "osn/api/wrangler.toml").env?.dev;
    expect(checkProbeBoundary(noDev).join("\n")).toContain("osn/api/wrangler.toml [env.dev]");
  });

  test("a probe table naming the production D1 is refused", () => {
    const probe = table((p) => {
      p.cire.database.name = "cire-db";
      p.cire.database.id = "6e835474-e0a7-4db9-8883-3247c3c891cd";
    });
    const findings = checkProbeBoundary(readWorkerConfigs(repoRoot), probe).join("\n");
    expect(findings).toContain("cire-db");
    expect(findings).toContain("[env.production]");
  });

  test("[env.dev] pointing at another database id is refused", () => {
    const configs = committed();
    const dev = scope(configs, "cire/api/wrangler.toml", "dev").d1_databases?.[0];
    if (!dev) throw new Error("fixture has no dev D1");
    dev.database_id = "6e835474-e0a7-4db9-8883-3247c3c891cd";
    expect(checkProbeBoundary(configs).join("\n")).toContain(
      "bf0510eb-6998-4ee3-b5a0-833c646ef855",
    );
  });

  test("the dev D1 id shared with staging is refused", () => {
    const configs = committed();
    const staging = scope(configs, "osn/api/wrangler.toml", "staging").d1_databases?.[0];
    if (!staging) throw new Error("fixture has no staging D1");
    staging.database_id = PROBE.osn.database.id;
    expect(checkProbeBoundary(configs).join("\n")).toContain("[env.staging]");
  });

  test("a dev bucket also bound by production is refused", () => {
    const configs = committed();
    const sheets = scope(configs, "cire/api/wrangler.toml", "production").r2_buckets?.[0];
    if (!sheets) throw new Error("fixture has no production bucket");
    sheets.bucket_name = "cire-sheets-dev";
    expect(checkProbeBoundary(configs).join("\n")).toContain("cire-sheets-dev");
  });

  test("a probe namespace used by production is refused, in either rate-limit layout", () => {
    const cire = committed();
    const claim = scope(cire, "cire/api/wrangler.toml", "production").unsafe?.bindings?.[0];
    if (!claim) throw new Error("fixture has no production unsafe binding");
    claim.namespace_id = "1101";
    expect(checkProbeBoundary(cire).join("\n")).toContain("1101");

    const osn = committed();
    const auth = scope(osn, "osn/api/wrangler.toml", "production").ratelimits?.[0];
    if (!auth) throw new Error("fixture has no production ratelimit");
    auth.namespace_id = "2101";
    expect(checkProbeBoundary(osn).join("\n")).toContain("2101");
  });

  test("a probe namespace used by another product's config is refused", () => {
    const configs = committed();
    const pulseDev = scope(configs, "pulse/api/wrangler.toml", "dev");
    pulseDev.ratelimits = [{ name: "RL", namespace_id: "1101", simple: { limit: 5, period: 60 } }];
    expect(checkProbeBoundary(configs).join("\n")).toContain("pulse/api/wrangler.toml");
  });

  test("a changed limit on the shared dev namespace is refused", () => {
    const configs = committed();
    const claim = scope(configs, "cire/api/wrangler.toml", "dev").unsafe?.bindings?.find(
      (binding) => binding.name === "CLAIM_RATE_LIMITER",
    );
    if (!claim) throw new Error("fixture has no dev claim limiter");
    claim.simple = { limit: 10, period: 60 };
    expect(checkProbeBoundary(configs).join("\n")).toContain("CLAIM_RATE_LIMITER");
  });

  test("a probe Worker named like a routed Worker is refused", () => {
    for (const routed of [
      "cire-api-dev",
      "osn-api-staging",
      "cire-api-production",
      "cire-invites",
    ]) {
      const probe = table((p) => {
        p.osn.worker = routed;
      });
      expect(checkProbeBoundary(readWorkerConfigs(repoRoot), probe).join("\n")).toContain(
        `deploys a Worker named ${routed}`,
      );
    }
  });

  test("a Worker name wrangler derives as <name>-<env> counts as deployed", () => {
    const configs = committed();
    scope(configs, "pulse/api/wrangler.toml").name = "cire-api-alchemy-probe";
    expect(checkProbeBoundary(configs).join("\n")).toContain(
      `pulse/api/wrangler.toml [env.dev] deploys a Worker named ${PROBE.cire.worker}`,
    );
  });

  test("a probe Worker without the probe suffix is refused", () => {
    const probe = table((p) => {
      p.cire.worker = "cire-api-probe";
    });
    expect(checkProbeBoundary(readWorkerConfigs(repoRoot), probe).join("\n")).toContain(
      "cire-api-probe",
    );
  });

  test("a config that names a Worker after the probe is refused", () => {
    const configs = committed();
    scope(configs, "zap/api/wrangler.toml").name = PROBE.cire.worker;
    expect(checkProbeBoundary(configs).join("\n")).toContain("zap/api/wrangler.toml");
  });

  test("[env.dev] binding a bucket under another name is refused", () => {
    const configs = committed();
    const sheets = scope(configs, "cire/api/wrangler.toml", "dev").r2_buckets?.find(
      (bucket) => bucket.binding === "SHEETS",
    );
    if (!sheets) throw new Error("fixture has no dev SHEETS bucket");
    sheets.bucket_name = "cire-sheets-dev-2";
    expect(checkProbeBoundary(configs).join("\n")).toContain("[env.dev] binds SHEETS to");
  });

  test("a probe bucket no config binds is refused", () => {
    const probe = table((p) => {
      const sheets = p.cire.buckets[0];
      if (!sheets) throw new Error("probe table has no bucket");
      sheets.name = "cire-sheet-dev";
    });
    expect(checkProbeBoundary(readWorkerConfigs(repoRoot), probe).join("\n")).toContain(
      "[env.dev] binds SHEETS to",
    );
  });

  test("two probes with one Worker name are refused", () => {
    const probe = table((p) => {
      p.osn.worker = p.cire.worker;
    });
    expect(checkProbeBoundary(readWorkerConfigs(repoRoot), probe).join("\n")).toContain(
      "both probes are named",
    );
  });

  test("[env.dev] naming another database while keeping the dev id is refused", () => {
    const configs = committed();
    const dev = scope(configs, "cire/api/wrangler.toml", "dev").d1_databases?.[0];
    if (!dev) throw new Error("fixture has no dev D1");
    dev.database_name = "cire-db-dev-2";
    expect(checkProbeBoundary(configs).join("\n")).toContain("binds DB to cire-db-dev-2");
  });

  test("another scope using the dev database's name with its own id is refused", () => {
    const configs = committed();
    const staging = scope(configs, "osn/api/wrangler.toml", "staging").d1_databases?.[0];
    if (!staging) throw new Error("fixture has no staging D1");
    staging.database_name = PROBE.osn.database.name;
    expect(checkProbeBoundary(configs).join("\n")).toContain(
      `[env.staging] also uses D1 ${PROBE.osn.database.name}`,
    );
  });

  test("a dev limiter on another namespace, period or missing is refused", () => {
    const edits: ((claim: {
      namespace_id: string;
      simple: { limit: number; period: number };
    }) => void)[] = [
      (claim) => {
        claim.namespace_id = "1199";
      },
      (claim) => {
        claim.simple = { limit: 5, period: 10 };
      },
    ];
    for (const edit of edits) {
      const configs = committed();
      const claim = scope(configs, "cire/api/wrangler.toml", "dev").unsafe?.bindings?.find(
        (binding) => binding.name === "CLAIM_RATE_LIMITER",
      );
      if (!claim) throw new Error("fixture has no dev claim limiter");
      edit(claim);
      expect(checkProbeBoundary(configs).join("\n")).toContain(
        "[env.dev] CLAIM_RATE_LIMITER is not namespace 1101",
      );
    }

    const removed = committed();
    const dev = scope(removed, "cire/api/wrangler.toml", "dev");
    if (!dev.unsafe?.bindings) throw new Error("fixture has no dev unsafe bindings");
    dev.unsafe.bindings = dev.unsafe.bindings.filter(
      (binding) => binding.name !== "CLAIM_RATE_LIMITER",
    );
    expect(checkProbeBoundary(removed).join("\n")).toContain(
      "[env.dev] CLAIM_RATE_LIMITER is not namespace 1101",
    );
  });

  test("WORKER_CONFIGS lists every Worker config in the repository", async () => {
    const found: string[] = [];
    for await (const path of new Bun.Glob("*/*/wrangler.{toml,json,jsonc}").scan({
      cwd: repoRoot,
    })) {
      found.push(path);
    }
    expect(found.toSorted()).toEqual([...WORKER_CONFIGS].toSorted());
  });
});
