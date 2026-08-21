#!/usr/bin/env bun
/**
 * CI guard: fail the build/deploy if a wrangler config carries a PLACEHOLDER
 * (or empty, or malformed) D1 `database_id` — or no D1 binding at all.
 *
 * The bug class this guards against: shipping the Worker with the literal
 * `database_id = "placeholder-replace-after-d1-create"` (the value scaffolded
 * before the real D1 database is created) would deploy cire-api pointed at no
 * database, silently breaking every D1 read and write. It is wired correctly
 * today; this prevents a regression from a bad merge or a copy-pasted scaffold.
 *
 * This replaces a three-grep bash script. The greps could only match the shapes
 * someone thought to write a pattern for, and a fourth shape — a named
 * environment with NO `[[d1_databases]]` block — was invisible to all three.
 * That shape matters here specifically: `cire/api/wrangler.toml` records, in its
 * own comment, that wrangler's named environments do NOT inherit top-level
 * `[[d1_databases]]`. So deleting the block from `[env.production]` leaves a
 * file where every `database_id` present is valid and production still has no
 * database. `Bun.TOML.parse()` sees the absence; a grep for a line that is not
 * there cannot.
 *
 * The bash version advertised "grep only; no bun, no network" so it ran
 * identically everywhere. That property is traded away here for the real parse.
 * It is affordable because both callers in `.github/workflows/deploy.yml` run
 * `bun install` before this step, and the repo pins bun in `.bun-version`.
 *
 * `WRANGLER_TOML` overrides the target (used by the tests); defaults to the
 * committed cire/api config.
 */

const PLACEHOLDER = /placeholder/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Finding = {
  /** Human-readable location, e.g. `[env.production]`. */
  readonly where: string;
  readonly problem: string;
};

/**
 * Only the shape this guard reads. The fields stay `unknown` because they come
 * from a file anyone can edit — the checks below are what narrow them, and a
 * `string` annotation here would assert the very thing being tested.
 */
type D1Binding = { readonly database_name?: unknown; readonly database_id?: unknown };
type Env = { readonly d1_databases?: readonly D1Binding[] };
type WranglerConfig = Env & { readonly env?: Readonly<Record<string, Env>> };

/** The top-level table plus every `[env.<name>]`, each labelled for a message. */
function scopes(parsed: WranglerConfig): readonly (readonly [string, Env])[] {
  return [
    ["top level", parsed],
    ...Object.entries(parsed.env ?? {}).map(([name, env]) => [`[env.${name}]`, env] as const),
  ];
}

export function checkD1(toml: string): readonly Finding[] {
  const parsed = Bun.TOML.parse(toml) as WranglerConfig;
  const findings: Finding[] = [];

  for (const [where, env] of scopes(parsed)) {
    const bindings = env.d1_databases;

    // The shape the greps could not see. A named environment inherits nothing,
    // so an absent block is an environment with no database, not one that falls
    // back to the top-level binding.
    if (!Array.isArray(bindings) || bindings.length === 0) {
      findings.push({ where, problem: "no [[d1_databases]] binding" });
      continue;
    }

    for (const binding of bindings as readonly D1Binding[]) {
      const name = typeof binding.database_name === "string" ? binding.database_name : "<unnamed>";
      const id = binding.database_id;

      if (typeof id !== "string" || id.trim() === "") {
        findings.push({ where, problem: `${name}: database_id is empty or missing` });
      } else if (PLACEHOLDER.test(id)) {
        findings.push({ where, problem: `${name}: database_id is a placeholder ("${id}")` });
      } else if (!UUID.test(id)) {
        findings.push({ where, problem: `${name}: database_id is not a UUID ("${id}")` });
      }
    }
  }

  return findings;
}

if (import.meta.main) {
  const path = Bun.env.WRANGLER_TOML ?? "cire/api/wrangler.toml";
  const file = Bun.file(new URL(`../${path}`, import.meta.url));

  if (!(await file.exists())) {
    console.error(`❌ check-d1-database-id: ${path} not found`);
    process.exit(1);
  }

  const findings = checkD1(await file.text());

  if (findings.length > 0) {
    console.error(`❌ check-d1-database-id: ${path} has an unusable D1 configuration.`);
    for (const { where, problem } of findings) console.error(`   ${where} — ${problem}`);
    console.error("");
    console.error("   Create the D1 database and paste its real UUID into every");
    console.error(`   'database_id = "..."' line in ${path}:`);
    console.error("     cd cire/api && bunx wrangler d1 create cire-db");
    console.error("   Named environments do NOT inherit the top-level [[d1_databases]]");
    console.error("   block — each [env.*] needs its own.");
    process.exit(1);
  }

  console.log(`✅ check-d1-database-id: ${path} D1 bindings all carry a real database_id.`);
}
