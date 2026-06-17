// Env-driven resolution of the bootstrap wedding's owner OSN profile id.
//
// Workerd-safe: this module imports NOTHING that drags `bun:sqlite` into the
// Worker bundle (the entry point `src/index.ts` imports from here for the prod
// owner-fixup). The sqlite-bound seed (`setup.ts`) re-exports these and applies
// the resolved value to a bun:sqlite db for local dev + tests.

// Legacy placeholder that older revisions baked into both migration 0006 and
// the seed. No longer written anywhere — kept only as a value the resolver
// explicitly rejects, so a deploy that still carries it (e.g. copied into
// BOOTSTRAP_OWNER_PROFILE_ID by mistake) fails loud instead of owning the
// bootstrap wedding with a nonexistent profile.
export const REPLACE_OWNER_PLACEHOLDER = "usr_REPLACE_BEFORE_PROD";

// Inert owner the migration backfills the bootstrap wedding with. It satisfies
// the NOT NULL owner column + FK backfill while being deliberately unguessable
// and matching no real OSN profile, so the organiser ownership gate fails
// CLOSED until runtime seeding (local/test) or the prod owner-fixup overwrites
// it with the real id. Also rejected by the resolver — it must never be the
// configured owner.
export const BOOTSTRAP_OWNER_SENTINEL = "usr_unclaimed_bootstrap";

// Ergonomic owner for local dev + the test suite, where no real organiser
// profile exists. Only ever returned when OSN_ENV is local/unset.
const DEV_BOOTSTRAP_OWNER = "usr_dev_bootstrap_owner";

const DEPLOYED_ENVS = new Set(["dev", "development", "staging", "stage", "production", "prod"]);

export type EnvSource = Record<string, string | undefined>;

/**
 * True when OSN_ENV (or NODE_ENV) names a deployed tier (dev/staging/prod) — as
 * opposed to local/unset. Used to decide when BOOTSTRAP_OWNER_PROFILE_ID is
 * mandatory and when the bootstrap owner-fixup should write to D1.
 */
export function isDeployedEnv(env: EnvSource = process.env): boolean {
  return DEPLOYED_ENVS.has((env.OSN_ENV ?? env.NODE_ENV ?? "").trim());
}

/**
 * Resolve the bootstrap wedding's owner OSN profile id.
 *
 * - OSN_ENV local/unset → ergonomic dev default (overridable via
 *   BOOTSTRAP_OWNER_PROFILE_ID for repointing at your own profile).
 * - OSN_ENV dev/staging/production → BOOTSTRAP_OWNER_PROFILE_ID is REQUIRED,
 *   must be a real `usr_*` id, and must not be the legacy REPLACE placeholder
 *   or the inert migration sentinel. Anything else THROWS so a misconfigured
 *   deploy can't silently own the wedding with a nonexistent/inert profile.
 */
export function resolveBootstrapOwnerProfileId(env: EnvSource = process.env): string {
  const configured = env.BOOTSTRAP_OWNER_PROFILE_ID?.trim();

  if (!isDeployedEnv(env)) {
    return configured && configured.length > 0 ? configured : DEV_BOOTSTRAP_OWNER;
  }

  if (!configured) {
    throw new Error(
      "BOOTSTRAP_OWNER_PROFILE_ID is required when OSN_ENV is not local — set it to the " +
        "organiser's real OSN profile id (usr_*) so the bootstrap wedding has a real owner.",
    );
  }
  if (configured === REPLACE_OWNER_PLACEHOLDER || configured === BOOTSTRAP_OWNER_SENTINEL) {
    throw new Error(
      `BOOTSTRAP_OWNER_PROFILE_ID is still the inert placeholder ("${configured}"). ` +
        "Set it to the organiser's real OSN profile id (usr_*) before deploying.",
    );
  }
  if (!configured.startsWith("usr_")) {
    throw new Error(
      `BOOTSTRAP_OWNER_PROFILE_ID ("${configured}") must be an OSN profile id of the form usr_*.`,
    );
  }
  return configured;
}
