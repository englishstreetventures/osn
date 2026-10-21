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

const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8");

/** The `<name>="A B"` lists a workflow step's shell sets, by name. */
const shellLists = (run: string): Map<string, string[]> =>
  new Map(
    [...run.matchAll(/^\s*(\w+)="([^"]*)"\s*$/gm)].map((match) => [
      match[1]!,
      match[2]!.split(/\s+/).filter((name) => name !== ""),
    ]),
  );

interface PreflightStep {
  readonly run?: string;
  readonly "working-directory"?: string;
}

/** Each production deploy preflight, as the Worker it checks and the `required` and `forbidden` names it holds the Worker to. */
const PREFLIGHTS = Object.values(
  (
    Bun.YAML.parse(read(".github/workflows/production-release.yml")) as {
      jobs: Record<string, { steps?: PreflightStep[] }>;
    }
  ).jobs,
)
  .flatMap((job) => job.steps ?? [])
  .flatMap((step) => {
    const lists = shellLists(step.run ?? "");
    const directory = step["working-directory"];
    const entry = SECRET_INVENTORY.find(
      (candidate) => directory !== undefined && candidate.sourceDir.startsWith(`${directory}/`),
    );
    if (entry === undefined || !(lists.has("forbidden") || lists.has("required"))) return [];
    return [
      {
        worker: entry.worker,
        required: lists.get("required") ?? [],
        forbidden: lists.get("forbidden") ?? [],
      },
    ];
  });

/** The secrets osn/api/wrangler.toml marks `REQUIRED non-local`: osn-api refuses to serve outside local without them. */
const OSN_API_REQUIRED_NON_LOCAL = [
  ...read("osn/api/wrangler.toml").matchAll(/^#\s+([A-Z][A-Z0-9_]+)\s.*REQUIRED non-local/gm),
].map((match) => match[1]!);

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
    const failClosed = [
      ...OSN_API_REQUIRED_NON_LOCAL,
      ...PREFLIGHTS.filter((step) => step.worker === "osn-api").flatMap((step) => step.required),
    ];
    expect(OSN_API_REQUIRED_NON_LOCAL.length).toBeGreaterThan(0);
    for (const tier of TIERS) {
      expect(tierSecrets("osn-api", tier).secrets).toEqual(expect.arrayContaining(failClosed));
    }
  });

  test("production forbids every name a deploy preflight refuses", () => {
    expect(
      PREFLIGHTS.filter((step) => step.forbidden.length > 0)
        .map((step) => step.worker)
        .toSorted(),
    ).toEqual(["cire-api", "osn-api"]);
    for (const step of PREFLIGHTS) {
      const forbidden = tierSecrets(step.worker, "production").forbidden;
      expect({
        worker: step.worker,
        notForbidden: step.forbidden.filter((name) => !forbidden.includes(name)),
      }).toEqual({ worker: step.worker, notForbidden: [] });
    }
  });

  test("dev forbids the local mail emulator's address, which a deployed Worker refuses", () => {
    for (const worker of ["osn-api", "cire-api"] as const) {
      expect(tierSecrets(worker, "dev").forbidden).toContain("RESEND_API_URL");
    }
  });

  test("cire-api keeps its member-step exclusion list on both tiers once set, and needs it on neither", () => {
    for (const tier of TIERS) {
      const row = tierSecrets("cire-api", tier);
      const name = "CIRE_MEMBER_STEP_EXCLUDED_WEDDING_IDS";
      expect({
        tier,
        optional: row.optional.includes(name),
        required: row.secrets.includes(name),
      }).toEqual({ tier, optional: true, required: false });
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
