#!/usr/bin/env bun
/**
 * CI and deploy guard: the Worker tiers real users reach keep query strings out
 * of Cloudflare logs and native traces, and no API Worker turns native traces
 * on there.
 *
 * Cloudflare records a request's URL, and every outbound fetch URL, before any
 * application code runs, so the app logger's `redact()` cannot reach them. What
 * keeps a guest's `?code=`, a fixed-path link's `?slug=` or an OIDC `?code=` out
 * of those records is one key, `observability.redact_query_string`, in each
 * deployed tier. The API Workers also carry ids and slugs in their paths, which
 * no setting redacts, so their staging and production native traces stay off.
 * Local and dev trace unredacted on purpose and are not checked.
 *
 * Two inputs:
 *  - no arguments: the committed configs — every `[env.staging]` and
 *    `[env.production]` in the API Workers' `wrangler.toml`, and the guest
 *    Worker's `wrangler.jsonc`, whose top level is production. Run by the
 *    `script-tests` job in `.github/workflows/ci.yml`.
 *  - `--generated <path>`: the guest Worker config `@astrojs/cloudflare` writes
 *    into `dist/server/wrangler.json`, which is the file that actually deploys.
 *    Run by `deploy-cire-invites` in `.github/workflows/deploy.yml` before
 *    `wrangler deploy`, so an adapter that drops the key fails the deploy.
 */

export type Finding = {
  /** Human-readable location, e.g. `osn/api/wrangler.toml [env.production]`. */
  readonly where: string;
  readonly problem: string;
};

/**
 * Only the shape this guard reads. The fields stay `unknown` because they come
 * from files anyone can edit; the checks below are what narrow them.
 */
type Observability = {
  readonly redact_query_string?: unknown;
  readonly traces?: { readonly enabled?: unknown };
  readonly logs?: { readonly invocation_logs?: unknown };
};
type Tier = { readonly observability?: Observability };
export type WorkerConfig = Tier & { readonly env?: Readonly<Record<string, Tier>> };

/** The API Workers, by committed config path from the repo root. */
export const API_WORKER_CONFIGS = [
  "osn/api/wrangler.toml",
  "pulse/api/wrangler.toml",
  "zap/api/wrangler.toml",
  "cire/api/wrangler.toml",
] as const;

/** The Cire guest Worker. It has no named environments: its top level is production. */
export const GUEST_WORKER_CONFIG = "cire/invites/wrangler.jsonc";

const REDACTED_TIERS = ["staging", "production"] as const;

/**
 * Every staging and production tier the config declares redacts query strings
 * and keeps native traces off. Wrangler treats `observability` as inheritable:
 * a tier with no block of its own takes the top-level block whole, so that is
 * the block checked for it.
 */
export function checkApiWorker(label: string, config: WorkerConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const tier of REDACTED_TIERS) {
    const env = config.env?.[tier];
    if (!env) continue;
    const where = `${label} [env.${tier}]`;
    const observability = env.observability ?? config.observability;
    if (observability?.redact_query_string !== true) {
      findings.push({ where, problem: "observability.redact_query_string must be true" });
    }
    if (observability?.traces?.enabled === true) {
      findings.push({
        where,
        problem: "observability.traces.enabled must not be true: request paths carry ids and slugs",
      });
    }
  }
  return findings;
}

/**
 * The guest Worker redacts query strings and keeps invocation records off (an
 * invocation record stores the request URL, and an existing `/<slug>` link
 * names the couple). Native traces may be on: the owner accepted the path slug.
 */
export function checkGuestWorker(label: string, config: WorkerConfig): readonly Finding[] {
  const findings: Finding[] = [];
  const observability = config.observability;
  if (observability?.redact_query_string !== true) {
    findings.push({ where: label, problem: "observability.redact_query_string must be true" });
  }
  if (observability?.logs?.invocation_logs !== false) {
    findings.push({ where: label, problem: "observability.logs.invocation_logs must be false" });
  }
  return findings;
}

/** Parse a Wrangler config by its extension: TOML, or JSON with comments. */
export function parseWorkerConfig(path: string, text: string): WorkerConfig {
  return (path.endsWith(".toml") ? Bun.TOML.parse(text) : Bun.JSONC.parse(text)) as WorkerConfig;
}

async function read(path: string): Promise<WorkerConfig> {
  const file = Bun.file(path.startsWith("/") ? path : new URL(`../${path}`, import.meta.url));
  if (!(await file.exists())) throw new Error(`${path} not found`);
  return parseWorkerConfig(path, await file.text());
}

/** Every committed config, checked as the deploys use it. */
export async function checkCommittedConfigs(): Promise<readonly Finding[]> {
  const [guest, ...apis] = await Promise.all(
    [GUEST_WORKER_CONFIG, ...API_WORKER_CONFIGS].map(read),
  );
  return [
    ...API_WORKER_CONFIGS.flatMap((path, i) => checkApiWorker(path, apis[i]!)),
    ...checkGuestWorker(GUEST_WORKER_CONFIG, guest!),
  ];
}

/** One line of output. A CLI's own output, not a log record, so no logger. */
function say(stream: NodeJS.WriteStream, line: string): void {
  stream.write(`${line}\n`);
}

if (import.meta.main) {
  const [flag, generated] = Bun.argv.slice(2);
  let findings: readonly Finding[];
  let subject: string;
  try {
    if (flag === "--generated") {
      if (!generated) throw new Error("--generated needs the path of a generated wrangler.json");
      subject = generated;
      const config = parseWorkerConfig(generated, await Bun.file(generated).text());
      findings = checkGuestWorker(generated, config);
    } else if (flag === undefined) {
      subject = "the committed Worker configs";
      findings = await checkCommittedConfigs();
    } else {
      throw new Error(`unknown argument ${flag}; use no arguments or --generated <path>`);
    }
  } catch (error) {
    say(
      process.stderr,
      `❌ check-trace-redaction: ${error instanceof Error ? error.message : error}`,
    );
    process.exit(1);
  }

  if (findings.length > 0) {
    say(process.stderr, `❌ check-trace-redaction: ${subject} would expose request URLs.`);
    for (const { where, problem } of findings) say(process.stderr, `   ${where} — ${problem}`);
    process.exit(1);
  }

  say(
    process.stdout,
    `✅ check-trace-redaction: ${subject}: query strings are redacted wherever real users reach the Worker.`,
  );
}
