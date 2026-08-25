#!/usr/bin/env bun
/**
 * Shared guard for the two scripts that talk to a REMOTE cire D1 —
 * cire-db-reset.sh (drops every table) and cire-db-seed.sh --dev (inserts
 * the sample wedding).
 *
 * Both are destructive, both run unattended in CI on every merge, and both
 * are one typo in cire/api/wrangler.toml away from pointing at the
 * live-wedding database. So neither trusts the name it was given: this
 * asserts, against the real config, that [env.dev]'s D1 is `cire-db-dev`
 * AND that its database_id is shared with no other env block.
 *
 * This replaces an awk implementation of the same idea. That version's own
 * comment recorded the bug it shipped with: extraction stripped any quote,
 * but the shared-id check matched a hard-coded double-quoted id, so a
 * single-quoted production id sharing the dev database passed clean.
 * `Bun.TOML.parse()` removes the class of bug entirely — there is no
 * separate extraction step to disagree with the comparison.
 *
 * `assertCireDevDb` is pure: feed it TOML text, get back a result. The
 * `import.meta.main` block below is the only part that touches the
 * filesystem or process exit code.
 */

const CIRE_DEV_DB_NAME = "cire-db-dev";

// The dev database's real id, pinned. `database_name` in wrangler.toml is a
// label — wrangler resolves the target from `database_id` alone — so a block
// reading `database_name = "cire-db-dev"` above the live-wedding id would sail
// past the name check and drop every table. The name check stays (it catches the
// ordinary mistake with a clearer message), but this is the one that binds.
//
// Recreating cire-db-dev means editing this line as well as wrangler.toml. That
// is deliberate: two edits for a disposable database, none for the live one.
const CIRE_DEV_DB_ID = "bf0510eb-6998-4ee3-b5a0-833c646ef855";

// The live-wedding database, named so the refusal can say what it caught. Any
// id that is not CIRE_DEV_DB_ID is already refused; this only sharpens the
// message for the case that matters.
const CIRE_PROD_DB_ID = "6e835474-e0a7-4db9-8883-3247c3c891cd";

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

export type CireDevDbResult =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly message: string };

/**
 * Fails unless `toml`'s [env.dev] names cire-db-dev and that database_id
 * belongs to no other environment in the file.
 */
export function assertCireDevDb(toml: string): CireDevDbResult {
  const parsed = Bun.TOML.parse(toml) as WranglerConfig;

  const devBindings = parsed.env?.dev?.d1_databases;
  const dev = Array.isArray(devBindings) ? devBindings[0] : undefined;
  const name = typeof dev?.database_name === "string" ? dev.database_name : undefined;
  const id = typeof dev?.database_id === "string" ? dev.database_id : undefined;

  if (name !== CIRE_DEV_DB_NAME) {
    return {
      ok: false,
      message: `[env.dev] names D1 '${name ?? "<none>"}', refusing — only '${CIRE_DEV_DB_NAME}' is disposable.`,
    };
  }

  if (!id) {
    return { ok: false, message: "[env.dev] has no database_id" };
  }

  if (id === CIRE_PROD_DB_ID) {
    return {
      ok: false,
      message: `[env.dev] points at the PRODUCTION database (${id}) under the name '${name}'. Refusing.`,
    };
  }

  if (id !== CIRE_DEV_DB_ID) {
    return {
      ok: false,
      message: `[env.dev] database_id is ${id}, not the pinned dev database ${CIRE_DEV_DB_ID}. Refusing — a name alone does not make a database disposable.`,
    };
  }

  // Everything above reads [env.dev]'s FIRST d1 binding, because that is the
  // one wrangler resolves for `--env dev`. But the two callers pass the
  // database by NAME, so any other binding wearing that same name is a target
  // this function has not looked at — including a second entry under
  // [env.dev] itself. Refuse if one exists pointing somewhere else.
  for (const [scope, env] of scopes(parsed)) {
    for (const binding of env.d1_databases ?? []) {
      if (binding.database_name === CIRE_DEV_DB_NAME && binding.database_id !== id) {
        return {
          ok: false,
          message: `${scope} carries a second D1 named '${CIRE_DEV_DB_NAME}', id ${String(binding.database_id ?? "<none>")}. Refusing — the name the reset script passes to wrangler no longer picks out one database.`,
        };
      }
    }
  }

  // The dev id must appear exactly once in the whole file. More than once
  // means some other env block (production, or the top-level local one)
  // shares the database, and "reset on every deploy" would wipe it.
  let occurrences = 0;
  for (const [, env] of scopes(parsed)) {
    for (const binding of env.d1_databases ?? []) {
      if (binding.database_id === id) occurrences++;
    }
  }

  if (occurrences !== 1) {
    return {
      ok: false,
      message: `database_id ${id} appears ${occurrences} times — the dev tier is sharing a database with another environment. Refusing.`,
    };
  }

  return { ok: true, message: `target is ${name} (${id}) — dedicated to the dev tier.` };
}

if (import.meta.main) {
  const path = Bun.argv[2];

  if (!path) {
    console.error("cire dev-db guard: wrangler.toml path required");
    process.exit(1);
  }

  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.error(`cire dev-db guard: cannot read ${path}`);
    process.exit(1);
  }

  const result = assertCireDevDb(await file.text());

  if (!result.ok) {
    console.error(`cire dev-db guard: ${result.message}`);
    process.exit(1);
  }

  console.log(`cire dev-db guard: ${result.message}`);
}
