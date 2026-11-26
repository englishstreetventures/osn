---
"@cire/api": patch
---

An agreement test, `tests/laws/gift-payout.test.ts`, runs one wedding's payout events — connects with and without a generation, retires, detaches, `account.updated`, the money-gifts switch, seat changes, deletes and restores, and account erasures — through the Bend model in `laws/gift-payout` and through cire-api's services, and fails when they disagree. The helpers the agreement tests share move to `tests/laws/bend.ts`. No production code changes.
