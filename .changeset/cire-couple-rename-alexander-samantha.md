---
"@cire/api": patch
"@cire/db": patch
"@cire/host": patch
---

Update the stale references to the live wedding's couple ordering, which was
renamed from "Samantha & Alex" to "Alexander & Samantha" (slug `samantha-alex-a1b2c3`
→ `alexander-samantha-a1b2c3`) in the production database.

The rename itself is pure data — the codebase is multi-tenant and holds no
per-couple defaults — so this is comment and test-fixture upkeep only:

- `PreviewInviteButton` tests seeded the real live slug; retargeted to the new one.
- `ModuleShell` / `GettingStarted` fixtures use the `R & V` monogram, matching the
  hero title already stored for that wedding.
- The comp-entitlement notes in `grant-entitlement.ts` and the
  `wedding_entitlements` schema name the couple whose comp they describe.

Historical records (changelogs, prior changesets, and the comments explaining the
*removed* bespoke `V & R` hero default) are deliberately left untouched.
