---
"@cire/host": patch
---

Three cire/host findings, plus a bug found while closing them.

**A third hand-inlined `isAuthExpired`, and a narrower one.** `EnquiriesView`
open-coded the predicate on its initial-load failure path while every other
view imported the shared helper. The inline copy read `_tag` first and returned
false for *any* other tag, never falling through to the printout check that
catches an Effect-wrapped failure — so a session expiry during the enquiries
load left the organiser staring at an empty inbox instead of being sent to
sign-in. Now uses `isAuthExpired`.

**ENQ-P-W3** — the enquiry inbox and thread each built a fresh
`Intl.NumberFormat` per call inside a `<For>` row. Both now use a memoised
`lib/money.ts`, keyed on (currency, precision) since the two call sites want
different precision. The failure path is memoised too, and that is the half
that mattered: `Intl.NumberFormat` throws on an unknown currency code, so the
old `try`/`catch` cost a construction *and* a throw per row.

**ENQ-P-I1** — replying refetched the entire inbox to learn one row's new
timestamp. The server's reply path sets only `lastMessageAt` + `updatedAt` on
that row (status moves on quote, not on message), so the post-reply row is
derived locally and upserted through the live signal. No error fallback: the
selected row comes from the same cached list, so a miss means the thread was
never on screen and the handler could not have run.

**T-M2 (cire)** — `lib/invite-emptiness.ts` is a hand-maintained mirror of the
guest site's copy with nothing checking they agree. A drift there doesn't break
anything visibly, it just makes the builder's "Shown / Hidden — empty" badges
lie about what a guest will see. The packages share no code, so the test
asserts the contract both copies claim rather than importing across them.

The `EnquiriesView` reply test previously asserted a status flip using a
refetch mock the API cannot produce; it now asserts the row's timestamp
updating through the live signal, with a second test pinning that no
list-sized read is issued.
