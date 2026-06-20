// Canonical sample-wedding identity for the dev/test seed. Single source of
// truth for the bootstrap wedding row that every seeded family/event is scoped
// to. Consumed by cire/api/src/db/setup.ts (seeds the row + re-exports
// DEV_OWNER_PROFILE_ID) and cire/db/seed/generate.ts (emits the SQL row).
//
// Stable owner for the local-dev / test sample wedding. No real OSN profile
// exists in local dev or the test suite, so the seeded wedding is owned by this
// fixed dev id; sign in as it (or repoint via CIRE_DEV_OWNER_PROFILE_ID in the
// db:seed script) to see the sample wedding in the portal. Deployed tiers never
// run this seed — a real signed-in OSN user creates their own weddings via
// POST /api/organiser/weddings, so there is no env-driven owner resolution here.
export const DEV_OWNER_PROFILE_ID = "usr_dev_bootstrap_owner";

// The bootstrap wedding's row values. `id` mirrors @cire/db's
// BOOTSTRAP_WEDDING_ID ("wed_bootstrap"); kept literal here so this seed module
// stays free of a schema import in the generated-SQL path.
export const bootstrapWedding = {
  id: "wed_bootstrap",
  slug: "cire-wedding",
  displayName: "Cire Wedding",
  ownerOsnProfileId: DEV_OWNER_PROFILE_ID,
  codeStyle: "secure",
} as const;
