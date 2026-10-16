import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  DEPLOY_ENVIRONMENT,
  NoWorkerOnTierError,
  SECRET_INVENTORY,
  SHARED_SECRET_VALUES,
  tierSecrets,
  type WorkerKey,
} from "../../src/secrets/inventory";
import type { Tier } from "../../src/stage";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const TIERS: readonly Tier[] = ["dev", "production"];

const sources = new Map<string, string>();
/** Every source file under `dir`, concatenated. */
function sourceText(dir: string): string {
  const cached = sources.get(dir);
  if (cached !== undefined) return cached;
  const text = readdirSync(join(REPO_ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((path) => /\.(ts|tsx|astro)$/.test(path))
    .map((path) => readFileSync(join(REPO_ROOT, dir, path), "utf8"))
    .join("\n");
  sources.set(dir, text);
  return text;
}

const reads = (dir: string, name: string): boolean =>
  new RegExp(`\\b${name}\\b`).test(sourceText(dir));

/** osn-api refuses to serve outside local without these (osn/api/wrangler.toml secrets block; wiki/shared/production-deploy.md §3.1). */
const OSN_API_FAIL_CLOSED = [
  "OSN_JWT_PRIVATE_KEY",
  "OSN_JWT_PUBLIC_KEY",
  "OSN_PAIRWISE_SALT",
  "OSN_SESSION_IP_PEPPER",
  "OSN_TOTP_ENCRYPTION_KEY",
  "RESEND_API_KEY",
  "UPSTASH_REDIS_REST_TOKEN",
  "UPSTASH_REDIS_REST_URL",
];

const rows = SECRET_INVENTORY.flatMap((entry) =>
  TIERS.map((tier) => ({
    worker: entry.worker,
    sourceDir: entry.sourceDir,
    tier,
    ...entry.tiers[tier],
  })),
);

describe("secret inventory", () => {
  test("a name is required, optional or forbidden, never two of them", () => {
    for (const row of rows) {
      const all = [...row.secrets, ...row.optional, ...row.forbidden];
      expect(new Set(all).size, `${row.worker} ${row.tier}`).toBe(all.length);
    }
  });

  test("osn-api keeps the outgoing TOTP key while a rotation drains, on both tiers", () => {
    for (const tier of TIERS) {
      expect(tierSecrets("osn-api", tier).optional).toEqual(["OSN_TOTP_ENCRYPTION_KEY_PREVIOUS"]);
    }
  });

  test("a tier with no Worker declares nothing, and asking for it is refused", () => {
    for (const row of rows.filter((candidate) => candidate.scriptName === null)) {
      expect([...row.secrets, ...row.optional]).toEqual([]);
      expect(() => tierSecrets(row.worker, row.tier)).toThrow(NoWorkerOnTierError);
    }
  });

  test("every declared secret is read by its Worker's code", () => {
    for (const row of rows) {
      for (const name of [...row.secrets, ...row.optional]) {
        expect(reads(row.sourceDir, name), `${row.worker} ${row.tier} ${name}`).toBe(true);
      }
    }
  });

  test("osn-api declares every secret it fails closed without, on both tiers", () => {
    for (const tier of TIERS) {
      expect(tierSecrets("osn-api", tier).secrets).toEqual(
        expect.arrayContaining(OSN_API_FAIL_CLOSED),
      );
    }
  });

  test("cire-api declares its OIDC client secret on both tiers", () => {
    for (const tier of TIERS)
      expect(tierSecrets("cire-api", tier).secrets).toContain("CIRE_OIDC_CLIENT_SECRET");
  });

  test("the forbidden lists hold what the deploy preflights refuse", () => {
    expect(tierSecrets("osn-api", "production").forbidden).toContain("DEV_LOGIN_SECRET");
    for (const worker of ["osn-api", "cire-api"] as const) {
      for (const tier of TIERS)
        expect(tierSecrets(worker, tier).forbidden).toContain("RESEND_API_URL");
    }
  });

  test("zap-api production forbids the GrowthBook key no zap code reads, while cire-api production keeps its own", () => {
    expect(reads("zap/api/src", "GROWTHBOOK_CLIENT_KEY")).toBe(false);
    expect(tierSecrets("zap-api", "production").forbidden).toContain("GROWTHBOOK_CLIENT_KEY");
    expect(tierSecrets("cire-api", "production").secrets).toContain("GROWTHBOOK_CLIENT_KEY");
  });

  test("no name collides with what Alchemy or the deploy job sets", () => {
    for (const row of rows) {
      const collisions = [...row.secrets, ...row.optional].filter(
        (name) =>
          name.startsWith("ALCHEMY_") ||
          name.startsWith("CLOUDFLARE_") ||
          name.startsWith("GITHUB_") ||
          DEPLOY_ENVIRONMENT.includes(name),
      );
      expect({ worker: row.worker, tier: row.tier, collisions }).toEqual({
        worker: row.worker,
        tier: row.tier,
        collisions: [],
      });
    }
  });

  test("a name feeds two Workers in one tier only when listed as a shared value", () => {
    const users = new Map<string, WorkerKey[]>();
    for (const row of rows) {
      for (const name of [...row.secrets, ...row.optional]) {
        const key = `${row.tier}:${name}`;
        users.set(key, [...(users.get(key) ?? []), row.worker]);
      }
    }
    const shared = [...users.entries()]
      .filter(([, workers]) => workers.length > 1)
      .map(([key, workers]) => `${key}=${workers.toSorted().join("+")}`)
      .toSorted();
    expect(shared).toEqual(
      SHARED_SECRET_VALUES.map(
        (entry) => `${entry.tier}:${entry.name}=${entry.workers.toSorted().join("+")}`,
      ).toSorted(),
    );
  });
});
