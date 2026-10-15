/**
 * The resources the Alchemy probe may adopt or create, and the check that
 * holds them to the dev tier.
 *
 * `PROBE` pins every name and id the stack touches. `checkProbeBoundary`
 * compares it with the committed Worker configs and refuses unless each D1
 * database, R2 bucket and rate-limit namespace is the one `[env.dev]` binds
 * in its product's `wrangler.toml` and no other scope in any config uses it,
 * and unless each probe Worker name differs from every Worker those configs
 * deploy. `alchemy.run.ts` runs it before declaring anything; the tests in
 * `tests/boundary.test.ts` run it against the committed files.
 *
 * The D1 ids are pinned as well as the names because a name is only a label
 * to Cloudflare. Recreating a dev database means editing the id here as well
 * as in `wrangler.toml`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

type RateLimit = {
  readonly binding: string;
  readonly namespaceId: string;
  readonly simple: { readonly limit: number; readonly period: 10 | 60 };
};

type ProductProbe = {
  readonly config: string;
  readonly worker: string;
  readonly database: { readonly binding: string; readonly name: string; readonly id: string };
  readonly buckets: readonly { readonly binding: string; readonly name: string }[];
  readonly rateLimit: RateLimit;
};

export type ProbeTable = { cire: ProductProbe; osn: ProductProbe };

/** Every probe Worker name ends with this, which no routed Worker does. */
export const PROBE_WORKER_SUFFIX = "-alchemy-probe-dev";

export const PROBE = {
  cire: {
    config: "cire/api/wrangler.toml",
    worker: "cire-api-alchemy-probe-dev",
    database: { binding: "DB", name: "cire-db-dev", id: "bf0510eb-6998-4ee3-b5a0-833c646ef855" },
    buckets: [
      { binding: "SHEETS", name: "cire-sheets-dev" },
      { binding: "ASSETS", name: "cire-assets-dev" },
    ],
    rateLimit: {
      binding: "CLAIM_RATE_LIMITER",
      namespaceId: "1101",
      simple: { limit: 5, period: 60 },
    },
  },
  osn: {
    config: "osn/api/wrangler.toml",
    worker: "osn-api-alchemy-probe-dev",
    database: { binding: "DB", name: "osn-db-dev", id: "1c1425e1-bb9f-4760-b090-763ccf61eb83" },
    buckets: [],
    rateLimit: {
      binding: "RL_AUTH_IP_5_60",
      namespaceId: "2101",
      simple: { limit: 5, period: 60 },
    },
  },
} as const satisfies ProbeTable;

/** Every committed config that deploys a Worker into the same Cloudflare account. */
export const WORKER_CONFIGS = [
  "cire/api/wrangler.toml",
  "osn/api/wrangler.toml",
  "pulse/api/wrangler.toml",
  "zap/api/wrangler.toml",
  "cire/invites/wrangler.jsonc",
] as const;

export type WorkerConfigPath = (typeof WORKER_CONFIGS)[number];

// Only the shape this check reads. The fields stay `unknown` because they come
// from files anyone can edit; the checks below are what narrow them.
type D1Entry = {
  readonly binding?: unknown;
  readonly database_name?: unknown;
  readonly database_id?: unknown;
};
type R2Entry = { readonly binding?: unknown; readonly bucket_name?: unknown };
type RateLimitEntry = {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly namespace_id?: unknown;
  readonly simple?: { readonly limit?: unknown; readonly period?: unknown };
};
type ScopeConfig = {
  readonly name?: unknown;
  readonly d1_databases?: unknown;
  readonly r2_buckets?: unknown;
  readonly ratelimits?: unknown;
  readonly unsafe?: { readonly bindings?: unknown };
};
export type WorkerConfig = ScopeConfig & { readonly env?: unknown };

/**
 * Parsed configs by repo-relative path; a path that could not be read is
 * absent. One key per `WORKER_CONFIGS` entry, which the compiler holds to.
 */
export type WorkerConfigs = {
  "cire/api/wrangler.toml"?: WorkerConfig;
  "osn/api/wrangler.toml"?: WorkerConfig;
  "pulse/api/wrangler.toml"?: WorkerConfig;
  "zap/api/wrangler.toml"?: WorkerConfig;
  "cire/invites/wrangler.jsonc"?: WorkerConfig;
};

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

/** The object entries of a TOML or JSON array; anything else reads as empty. */
function entries<T extends object>(value: unknown): readonly T[] {
  return Array.isArray(value) ? value.filter(isObject).map((entry) => entry as T) : [];
}

export function readWorkerConfigs(repoRoot: string): WorkerConfigs {
  const configs: WorkerConfigs = {};
  for (const path of WORKER_CONFIGS) {
    try {
      const text = readFileSync(join(repoRoot, path), "utf8");
      const parsed: unknown = path.endsWith(".jsonc")
        ? Bun.JSONC.parse(text)
        : Bun.TOML.parse(text);
      if (isObject(parsed)) configs[path] = parsed as WorkerConfig;
    } catch {
      // Left absent: checkProbeBoundary reports every missing config.
    }
  }
  return configs;
}

type Scope = {
  readonly label: string;
  readonly config: WorkerConfigPath;
  readonly env: string | undefined;
  readonly worker: string | undefined;
  readonly databases: readonly D1Entry[];
  readonly buckets: readonly R2Entry[];
  readonly rateLimits: readonly RateLimitEntry[];
};

/**
 * The top level and every `[env.<name>]` of one config. A named environment
 * without its own `name` deploys as `<top-level name>-<env>`, as `wrangler
 * deploy --env <env>` does. Rate limits are read from both layouts in use:
 * `[[ratelimits]]` and `[[unsafe.bindings]]` with `type = "ratelimit"`.
 */
function scopes(config: WorkerConfigPath, top: WorkerConfig): Scope[] {
  const topName = typeof top.name === "string" ? top.name : undefined;
  const named: [string, ScopeConfig][] = isObject(top.env)
    ? Object.entries(top.env).flatMap(([env, value]) =>
        isObject(value) ? [[env, value as ScopeConfig] as [string, ScopeConfig]] : [],
      )
    : [];
  const all: [string | undefined, ScopeConfig][] = [[undefined, top], ...named];
  return all.map(([env, scope]) => {
    const ownName = typeof scope.name === "string" ? scope.name : undefined;
    const worker = env === undefined ? topName : (ownName ?? (topName && `${topName}-${env}`));
    return {
      label: env === undefined ? `${config} top level` : `${config} [env.${env}]`,
      config,
      env,
      worker,
      databases: entries<D1Entry>(scope.d1_databases),
      buckets: entries<R2Entry>(scope.r2_buckets),
      rateLimits: [
        ...entries<RateLimitEntry>(scope.ratelimits),
        ...entries<RateLimitEntry>(scope.unsafe?.bindings).filter(
          (binding) => binding.type === "ratelimit",
        ),
      ],
    };
  });
}

const namespaceOf = (entry: RateLimitEntry): string => String(entry.namespace_id);

const sameSimple = (entry: RateLimitEntry, want: RateLimit["simple"]): boolean =>
  entry.simple?.limit === want.limit && entry.simple?.period === want.period;

/**
 * Every way the probe table and the committed configs disagree, as one
 * sentence each. Empty means the probe touches only dev-tier resources.
 */
export function checkProbeBoundary(configs: WorkerConfigs, probe: ProbeTable = PROBE): string[] {
  const findings: string[] = [];
  const all: Scope[] = [];
  for (const path of WORKER_CONFIGS) {
    const config = configs[path];
    if (config === undefined) findings.push(`${path} could not be read`);
    else all.push(...scopes(path, config));
  }

  const products = [probe.cire, probe.osn];
  if (probe.cire.worker === probe.osn.worker) {
    findings.push(`both probes are named ${probe.cire.worker}`);
  }

  for (const product of products) {
    const dev = all.find((scope) => scope.config === product.config && scope.env === "dev");
    if (!dev) {
      findings.push(`${product.config} [env.dev] is missing`);
      continue;
    }
    const others = all.filter((scope) => scope !== dev);

    const { database } = product;
    const devDatabase = dev.databases.find((d) => d.binding === database.binding);
    if (devDatabase?.database_name !== database.name || devDatabase.database_id !== database.id) {
      findings.push(
        `${dev.label} binds ${database.binding} to ${String(devDatabase?.database_name)} (${String(devDatabase?.database_id)}), not ${database.name} (${database.id})`,
      );
    }
    for (const scope of others) {
      for (const d of scope.databases) {
        if (d.database_name === database.name || d.database_id === database.id) {
          findings.push(`${scope.label} also uses D1 ${database.name} (${database.id})`);
        }
      }
    }

    for (const bucket of product.buckets) {
      const devBucket = dev.buckets.find((b) => b.binding === bucket.binding);
      if (devBucket?.bucket_name !== bucket.name) {
        findings.push(
          `${dev.label} binds ${bucket.binding} to ${String(devBucket?.bucket_name)}, not ${bucket.name}`,
        );
      }
      for (const scope of others) {
        if (scope.buckets.some((b) => b.bucket_name === bucket.name)) {
          findings.push(`${scope.label} also uses R2 bucket ${bucket.name}`);
        }
      }
    }

    const { rateLimit } = product;
    const devLimit = dev.rateLimits.find((r) => r.name === rateLimit.binding);
    if (
      devLimit === undefined ||
      namespaceOf(devLimit) !== rateLimit.namespaceId ||
      !sameSimple(devLimit, rateLimit.simple)
    ) {
      findings.push(
        `${dev.label} ${rateLimit.binding} is not namespace ${rateLimit.namespaceId} at ${rateLimit.simple.limit} per ${rateLimit.simple.period}s`,
      );
    }
    for (const scope of others) {
      if (scope.rateLimits.some((r) => namespaceOf(r) === rateLimit.namespaceId)) {
        findings.push(`${scope.label} also uses rate-limit namespace ${rateLimit.namespaceId}`);
      }
    }

    if (!product.worker.endsWith(PROBE_WORKER_SUFFIX)) {
      findings.push(`probe Worker ${product.worker} does not end with ${PROBE_WORKER_SUFFIX}`);
    }
    for (const scope of all) {
      if (scope.worker === product.worker) {
        findings.push(`${scope.label} deploys a Worker named ${product.worker}`);
      }
    }
  }
  return findings;
}
