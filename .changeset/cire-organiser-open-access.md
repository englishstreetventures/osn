---
---

cire: any authenticated OSN user is a first-class organiser — removed the vestigial bootstrap-owner boot gate.

Deleted `ensureBootstrapOwner` + `BOOTSTRAP_OWNER_PROFILE_ID`/`OSN_ENV` boot gate (and the `cire/api/src/db/bootstrap-owner.ts` module) from cire-api, so it boots and serves for any signed-in OSN user with no special config: they sign in, see their own weddings (empty list for a new account — not a 503), and create new ones via `POST /api/organiser/weddings`. Per-wedding authz (`weddingOwner`/`weddingMember`) is unchanged and still fully scopes every wedding-scoped route — no cross-tenant access. Added forward-only migration `0015_drop_bootstrap_wedding.sql` deleting the orphaned `wed_bootstrap` demo row (children cascade) so prod starts clean; the local/test seed now owns its sample wedding via a fixed dev id. cire-api no longer needs the `BOOTSTRAP_OWNER_PROFILE_ID` secret.

Only `@cire/*` (version-less / changeset-ignored) packages are affected, so this changeset is intentionally empty.
