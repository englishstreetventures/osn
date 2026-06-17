---
"@cire/api": minor
"@cire/db": minor
---

Make the bootstrap wedding owner env-driven and fail-loud, so production
migrations no longer bake a nonexistent placeholder profile as the owner.

- Migration `0006_multi_tenant.sql` no longer bakes `usr_REPLACE_BEFORE_PROD`
  into the `wed_bootstrap` row. It now seeds an **inert sentinel owner**
  (`usr_unclaimed_bootstrap`) that satisfies the NOT NULL owner column + the
  families/events FK backfill while matching no real OSN profile, so the
  organiser ownership gate fails CLOSED rather than open.
- New `cire/api/src/db/bootstrap-owner.ts` (workerd-safe — no `bun:sqlite`)
  exposes `resolveBootstrapOwnerProfileId(env)`: it returns an ergonomic dev
  default (`usr_dev_bootstrap_owner`) when `OSN_ENV` is local/unset, and in any
  deployed tier (dev/staging/prod) REQUIRES `BOOTSTRAP_OWNER_PROFILE_ID` to be a
  real `usr_*` id — a missing, placeholder, sentinel, or non-`usr_*` value
  THROWS.
- The local/test seed (`seedBootstrapWedding` in `cire/api/src/db/setup.ts`) now
  takes its owner from that resolver.
- `ensureBootstrapOwner` (`cire/api/src/index.ts`) runs once per isolate and, in
  a deployed environment, repoints the bootstrap wedding off the sentinel onto
  the real `BOOTSTRAP_OWNER_PROFILE_ID`. It throws on a misconfigured deploy,
  which surfaces as a 503 at the edge (fail loud) instead of serving a wedding
  owned by a nonexistent profile. `seedDb` never runs against D1, so this is the
  production owner path.

Before the first deployed-D1 boot, set the `BOOTSTRAP_OWNER_PROFILE_ID` wrangler
secret to the organiser's real OSN profile id (and `OSN_ENV` to the tier).
