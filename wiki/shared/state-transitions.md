---
title: State transitions
aliases:
  - guarded writes
  - status writes
tags:
  - architecture
  - patterns
  - drizzle
  - d1
related:
  - "[[backend-patterns]]"
  - "[[database-environments]]"
  - "[[review-findings]]"
  - "[[testing-patterns]]"
  - "[[cire-development]]"
last-reviewed: 2026-11-04
---

# State transitions

A status column, a flag or a lifecycle timestamp is a state machine nobody drew. Every code path that writes it is one of its edges, and the edges are rarely in one file: an organiser's cancel in a route, an automatic transition on read, an erasure flow, a sweep, a webhook. Each writer decides from a row it read earlier, and any other writer can commit in between. This page holds the rules a write of state follows and the Drizzle idioms this repository already uses for them.

The `review-state` skill (`.claude/skills/review-state/SKILL.md`) checks a branch against these rules, listing every writer of each state across the repository. `prep-pr` runs it when `scripts/review-scope.ts` prints `full-state`, and its findings take `G-` IDs, which are public ([[review-findings#State findings are public]]).

## What counts as state

A column is a state when its value decides what a later request may do: some write refuses on it, some read branches on it, some sweep selects on it.

| Kind | Examples |
|---|---|
| A status, state, phase or stage | `events.status`, `imports.status`, `connections.status` |
| A nullable timestamp or actor meaning "it happened" | `completedAt`, `paidAt`, `revokedAt`, `hardDeleteAt`, `revokedBy` |
| A flag | `instanceOverride`, `selected` |
| A value set over any of these | a Drizzle `enum:`, a literal union, a `CHECK`, a trigger |

A state's **paired columns** are the ones whose meaning depends on it: an event's `cancelledAt`, `cancellationReason` and `hardDeleteAt` beside `status = 'cancelled'`; a subscription's `pastDueSince` beside `status = 'past_due'`. `createdAt` and `updatedAt` are not states.

## The rules

| Rule | The defect it stops |
|---|---|
| **1. The prior state is in the WHERE, and the write checks what it matched** | A read that checks the state in code, then `WHERE id = ?`: a cancel committed in between is overwritten |
| **2. Paired columns move in the same statement, and only a state's owner leaves it** | `status = 'cancelled'` with no cancel time; a user path undoing a state the erasure flow or a webhook set |
| **3. Terminal states stay terminal, and first-time values keep their first value** | An automatic transition writing over `cancelled`; a repeat "mark paid" moving the paid time |
| **4. A repeat write changes nothing** | A retried request or redelivered webhook writing, counting or notifying twice |
| **5. A transition of several statements is atomic, or converges on retry** | The first statement commits, the second fails, and the retry is refused or rewrites every row again |
| **6. An insert racing a unique index falls through to the update** | Two first requests both read "no row", both insert, and the second gets a 500 |
| **7. The database enforces the value set** | A migration, seed or raw-SQL writer storing a value the boundary schema would have refused |
| **8. Access refusals come before state refusals** | "This event is cancelled" answered to someone not on its guest list |
| **9. Each guard has a test that fails without it** | A guard that a later refactor deletes with every test still green |

Rules 1 and 6 are the D1 forms of shapes 2 and 3 in the "D1 has no interactive transactions" section of [[database-environments]]: D1 has no `db.transaction`, so the condition a read established travels into the write as part of its WHERE.

## The idioms

### Guard in the WHERE, then check the match

The write names the state it read, and zero changed rows means the row moved; refuse as a fresh read would.

```typescript
const accepted = yield* Effect.tryPromise({
  try: () =>
    db
      .update(connections)
      .set({ status: "accepted", updatedAt: now() })
      .where(and(eq(connections.id, row.id), eq(connections.status, row.status))),
  catch: (cause) => new DatabaseError({ cause }),
});
if (rowsChanged(accepted) === 0) {
  return yield* Effect.fail(new NotFoundError({ message: "Pending request not found" }));
}
```

`osn/api/src/services/graph.ts` builds that predicate once as `asRead(row)`, from the row's id, its two profiles and its status, and uses it to accept and to reject a request; `rowsChanged` is in `@shared/db-utils` and reads the change count on both drivers. Where the caller wants the row back, `.returning()` does the same job, and an empty array is the zero. The guard can be the exact state read (`eq(status, previous)`) or "not terminal" (`NOT IN ('cancelled', 'finished')`); the second suits an automatic writer that must never touch a closed row.

A guard whose result is ignored is half a guard: the caller is then told the transition happened, a metric counts it, and the copy it returns holds a status the database does not.

### Paired columns in the same `.set()`

A cancel stamps its time and reason in the statement that sets the status, and any other status clears them there too. When the pair depends on the row's current value, the expression goes in the `.set()` as SQL, so the database decides at write time:

```typescript
pastDueSince: sql`CASE WHEN excluded.status = 'past_due' THEN COALESCE(${s.pastDueSince}, excluded.past_due_since) ELSE NULL END`,
```

That line, in `shared/billing/src/storage/sqlite.ts`, keeps the first time a subscription was seen past due, and clears it once the status leaves `past_due`, in the upsert that writes the status. The same upsert's `setWhere` (`excluded.fetch_started_at >= …`) is rule 1 for a writer with no single prior state: an older fetch never overwrites a newer one.

### First-time values with `COALESCE`, bound in the column's unit

`COALESCE(col, now)` keeps a value once set; `CASE WHEN <state> THEN col ELSE now END` keeps it while a state holds. **Inside raw `sql` the value bypasses the column's Drizzle mapping**, so bind the number the column stores, not a `Date`:

- `integer(…, { mode: "timestamp" })` stores seconds: bind `Math.floor(Date.now() / 1_000)`.
- `integer(…, { mode: "timestamp_ms" })` stores milliseconds: bind `Date.now()` or `getTime()`, as `shared/billing/src/storage/sqlite.ts` does.
- A plain `integer` column stores whatever its comment says; read it.

`bun:sqlite` refuses a `Date` there (`Binding expected string, TypedArray, boolean, number, bigint or null`), and milliseconds bound into a seconds column read back as a date some 50,000 years away. A plain `.set({ completedAt: new Date() })` is mapped, and needs none of this.

### Several statements: one batch, or guarded steps

Statements that must land together go in one atomic `db.batch([...])`, through `commitBatch` (`@shared/db-utils`) where the code runs on both drivers. The cire import lifecycle does this: the status flip to `applied` or `reverted` rides in the final batch with the claim statement, guarded on the state it leaves (`eq(imports.status, "preview")` in `cire/api/src/routes/organiser-changes.ts`, `eq(imports.status, "applied")` in `cire/api/src/services/revert.ts`), so the data and the row reading `applied` commit together.

When the statements cannot share a batch, guard each one on the state it moves its rows out of. A retry after a failure between them then finishes the transition, and a second run matches nothing.

### Insert against a unique index: `onConflictDoNothing`, then fall through

```typescript
const inserted = yield* Effect.tryPromise({
  try: () =>
    db
      .insert(rows)
      .values({ id, pairA, pairB, status })
      .onConflictDoNothing({ target: [rows.pairA, rows.pairB] })
      .returning(),
  catch: (cause) => new DatabaseError({ cause }),
});
if (inserted[0]) return inserted[0];
// Another request inserted the pair first: carry on as an update of its row.
```

A bare `onConflictDoNothing()` with no read-back silently drops the loser's values; `pulse/api/src/services/onboarding.ts` re-reads after it so the response matches what was stored. A value the read decided — first-touch attribution, "new" — moves into the write as `CASE WHEN col IS NULL THEN … ELSE col END`, so the request that actually wrote first is the one that sets it.

### Enforce the value set: `check()` on a new table, triggers on an existing one

Drizzle's `enum:` is TypeScript only and adds no `CHECK`: `imports.status` is declared with `enum: ["preview", "applied", "reverted"]` and its DDL is plain `status text NOT NULL` (`cire/db/migrations/0001_initial.sql`). A new table states its values with `check()` in the schema, as `registry_claims_status_ck` does in `cire/db/src/schema.ts`.

An existing table cannot gain a `CHECK`: SQLite has no `ADD CONSTRAINT`, so it takes a copy-and-swap rebuild, and D1 enforces foreign keys, so dropping the old table cascades into every child ([[cire-development]] has the rule against copy-and-swap). Two triggers hold the value set instead, one per write path. For a table `orders` whose `status` is `open`, `paid` or `refunded`:

```sql
CREATE TRIGGER `orders_status_value` BEFORE INSERT ON `orders`
WHEN NEW.`status` NOT IN ('open', 'paid', 'refunded')
BEGIN
	SELECT RAISE(ABORT, 'order status is not a known value');
END;--> statement-breakpoint
CREATE TRIGGER `orders_status_value_update` BEFORE UPDATE OF `status` ON `orders`
WHEN NEW.`status` NOT IN ('open', 'paid', 'refunded')
BEGIN
	SELECT RAISE(ABORT, 'order status is not a known value');
END;
```

`cire/db/migrations/20261026040620_seating_plans.sql` has a `BEFORE INSERT` and `BEFORE UPDATE OF` pair of this shape guarding another invariant, a seating table's plan. In cire the test DDL in `cire/api/src/db/setup.ts` gets the same triggers ([[cire-development]], three DDL surfaces).

### Refusal order

Load the row, then refuse in this order: not found or not visible to this caller; not a member, not the owner, not on the guest list; and only then the row's state. Every verb that writes the row refuses on the same state.

## Testing a guard

A happy-path test and a refusal of a row that was already in the wrong state before the call both pass with the guard deleted. A guard's test arranges the race it exists for:

- **The row changes underneath.** Read the row, change it with a direct update, call the writer with the stale copy, assert the stored row. For a writer that does its own read, land the competing write between its read and its statement: `beforeStatement` in `cire/api/tests/test-helpers.ts` runs a write just before the next statement matching a pattern, and `cire/api/tests/routes/vendor-directory.test.ts` uses it for a unique-index race. Outside cire, `Effect.all([a, b], { concurrency: "unbounded" })` on `bun:sqlite` yields at every `await`, so both requests read before either writes.
- **A repeat.** Seed the first-time column with an old value, repeat the write, assert the old value stayed. Two writes in one test with no seeding usually land in the same second, and pass without the guard.
- **The value set.** Insert a value outside the set through the driver, past the service, and assert the database refuses it.

The full rules for what earns an isolated test are in [[testing-patterns#What to test, and when]].
