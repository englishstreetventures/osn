---
"@pulse/api": minor
"@pulse/db": minor
"@osn/api": minor
"@osn/db": minor
---

Migrate Pulse and the OSN core DB layer onto the four-environment database story
(local bun:sqlite / dev·staging·prod D1). D1 has no interactive transaction, so
every `db.transaction(async tx => …)` is rewritten to the shared `commitBatch`
helper — an atomic `db.batch([...])` on D1, sequential awaited writes on
bun:sqlite — preserving all-or-nothing semantics on the deployed driver.

`@pulse/api`: 5 account-erasure transactions → `commitBatch`; `createApp`
factory (`aot: false`) + `local.ts` (Bun.serve) + Workers `index.ts` (D1) +
`wrangler.toml` (dev/staging/production) + a Miniflare integration test.

`@osn/api`: all 17 transactions across auth / profile / graph / organisation /
account-erasure → `commitBatch`, preserving the S-H1/S-M2 atomicity invariants
(UNIQUE-constraint guards for handle/email races; a count-guarded conditional
DELETE for the last-passkey invariant). Adds a Miniflare integration test and a
`wrangler.toml` for D1 migration tooling. NOTE: full Workers *hosting* of
osn-api remains gated on replacing ioredis with a Workers-compatible Redis —
its DB layer is D1-ready but it still runs only as the Bun.serve `local` host.

`@pulse/db` / `@osn/db`: broadened service `Db` type + `makeDbD1Live`,
schema-reflection `./testing` export, and wrangler-based `db:migrate:*` scripts.
