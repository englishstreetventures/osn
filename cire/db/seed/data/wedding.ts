// Canonical sample-wedding identity for the dev/test seed. Single source of
// truth for the bootstrap wedding row that every seeded family/event is scoped
// to. Consumed by cire/api/src/db/setup.ts (seeds the row + re-exports
// DEV_OWNER_PROFILE_ID) and cire/db/seed/generate.ts (emits the SQL row).
//
// Stable owner for the local-dev / test / DEV-TIER sample wedding. No real OSN
// profile exists in local dev or the test suite, so the seeded wedding is owned
// by this fixed dev id; sign in as it (or repoint via CIRE_DEV_OWNER_PROFILE_ID
// in the db:seed script) to see the sample wedding in the portal. Production is
// never seeded — no flag targets it — so a real signed-in OSN user there creates
// their own weddings via POST /api/organiser/weddings.
export const DEV_OWNER_PROFILE_ID = "usr_dev_bootstrap_owner";

// The `wedding_hosts` id of that owner's seat, the first row of `./hosts.ts`.
// Fixed, because the code that repoints the seat at a real account finds it by
// this id: `scripts/cire-db-seed.sh` on the local and dev D1, and
// `cire/api/src/local.ts` on the in-memory database `seedBootstrapWedding`
// (`cire/api/src/db/setup.ts`) builds.
export const DEV_OWNER_SEAT_ID = "whost_d1f0c4a2-0000-4000-8000-000000000000";

// The bootstrap wedding's row values. `id` mirrors @cire/db's
// BOOTSTRAP_WEDDING_ID ("wed_bootstrap"); kept literal here so this seed module
// stays free of a schema import in the generated-SQL path.
//
// Only the first three fields reach the in-memory test seed
// (cire/api/src/db/setup.ts#seedBootstrapWedding maps its columns explicitly);
// the profile fields below exist for the SQL seed, so the dev tier's wedding
// carries the same planning + RSVP-deadline facts a real one does. The owner is
// not a field here: it is a seat, the first row of `./hosts.ts`.
export const bootstrapWedding = {
  id: "wed_bootstrap",
  slug: "cire-wedding",
  displayName: "Cire Wedding",
  codeStyle: "secure",
  // Date-only ISO (YYYY-MM-DD) — the ceremony day, matching the `hindu` event.
  weddingDate: "2026-11-25",
  guestCountEstimate: 560,
  currency: "AUD",
  // Minor units: A$100,000.00.
  budgetTotalMinor: 10_000_000,
  // GUEST-FACING AND ENFORCING: past this date the invite refuses RSVP writes
  // (403 `rsvp_closed`) and renders read-only. Fixed, like the event dates
  // above, so it goes stale the same way — when the seeded events stop being in
  // the future, move both.
  rsvpDeadline: "2026-10-25",
  rsvpDeadlineTimezone: "Australia/Sydney",
  // The top tier, comped: a dev tier has no payment provider wired up, and on
  // Ivory every paid module (budget, checklist, registry, vendors) sits locked,
  // so nobody would exercise them before a release reaches prod.
  tier: "crimson",
  tierSource: "comp",
  tierGrantedBy: "dev-seed",
} as const;
