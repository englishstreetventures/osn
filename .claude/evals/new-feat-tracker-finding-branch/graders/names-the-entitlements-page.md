---
type: llm
weight: 1
focus: { source: file, path: NEW-FEAT.md }
---

The file is a plan to fold the entitlement presence check into the cire role gate's query. At this commit two wiki pages describe today's arrangement and go stale with the change: `wiki/systems/cire-entitlements.md` (its `weddingEntitlement(db, key)` middleware section and the middleware-chain diagram under it) and `wiki/systems/cire-auth.md` (line 152: `weddingMember()` "resolves authorisation in one round-trip via `hostsService.authorize()`"). Naming `wiki/systems/cire-registry.md` as well is fine.

PASS if the plan names `wiki/systems/cire-entitlements.md` by its repository path as a page the change makes stale.

FAIL if it does not, or names the page only by `[[wikilink]]`.

FAIL also if the file is missing or empty.
