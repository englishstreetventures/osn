/**
 * The write a verified WebAuthn assertion makes to its passkey: the
 * signature counter, and `last_used_at` when it is due.
 */

import { type NewPasskey, type Passkey, passkeys } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { rowsChanged } from "@shared/db-utils";
import { and, eq, lt } from "drizzle-orm";
import { Effect } from "effect";

import { PASSKEY_LAST_USED_COALESCE_MS } from "./constants";
import { DatabaseError } from "./errors";

/**
 * Writes `newCounter` to the passkey `pk` names, only while the stored
 * counter still lets it through: below `newCounter`, or 0 when `newCounter` is
 * 0 (an authenticator with no counter, as synced passkeys are). That is the
 * rule `@simplewebauthn/server` applied against the counter it was given, held
 * again at the write, so of two assertions verified against one stored
 * counter the second to write is refused, as it is when they arrive one after
 * the other. Answers `false` when nothing was written — that, or the passkey
 * deleted since it was read — and the caller refuses the assertion.
 *
 * `last_used_at` is coalesced, as sessions' is: written only once
 * `PASSKEY_LAST_USED_COALESCE_MS` has passed since the value `pk` carries.
 */
export const recordAssertion = (
  pk: Pick<Passkey, "id" | "lastUsedAt">,
  newCounter: number,
): Effect.Effect<boolean, DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const updates: Partial<Pick<NewPasskey, "counter" | "lastUsedAt" | "updatedAt">> = {
      counter: newCounter,
    };
    if (!pk.lastUsedAt || nowMs - pk.lastUsedAt * 1000 >= PASSKEY_LAST_USED_COALESCE_MS) {
      updates["lastUsedAt"] = nowSec;
      updates["updatedAt"] = nowSec;
    }
    const counterAdvances =
      newCounter === 0 ? eq(passkeys.counter, 0) : lt(passkeys.counter, newCounter);
    const written = yield* Effect.tryPromise({
      try: () =>
        db
          .update(passkeys)
          .set(updates)
          .where(and(eq(passkeys.id, pk.id), counterAdvances)),
      catch: (cause) => new DatabaseError({ cause }),
    });
    return rowsChanged(written) === 1;
  });
