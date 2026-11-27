import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  DELETION_RECORD_MAX_SEATS,
  type DeletionRecord,
  DeletionRecordRefused,
  type DeletionRecordStore,
  DeletionRecordWriteError,
  instrumentDeletionRecords,
  memoryDeletionRecordStore,
  neverBlocking,
  missingDeletionRecordStore,
  r2DeletionRecordStore,
  recordKey,
  settleDeletionRecord,
  withDeletionRecord,
  type R2BucketLike,
} from "../src/deletion-records";

// The record of an erasure request, kept outside the database a restore can
// rewind. Each case is one way the record or its store can fail: a value that
// is not an id reaching storage, keys that stop sorting by time, a store
// failure read as a defect, and a record left behind by a request that was
// never accepted.

const erased = (over: Partial<Record<string, unknown>> = {}): DeletionRecord =>
  ({
    v: 1,
    kind: "account_erased",
    at: 1_764_000_000_000,
    accountId: "acc_0123456789ab",
    profileIds: ["usr_0123456789ab"],
    ...over,
  }) as DeletionRecord;

/** A bucket that keeps what it is given, as R2 would. */
function bucket(): R2BucketLike & { readonly objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    put: async (key, value) => {
      objects.set(key, value);
      return null;
    },
    delete: async (key) => {
      objects.delete(key);
    },
  };
}

type Write = (input: void) => Effect.Effect<void, DeletionRecordWriteError | DeletionRecordRefused>;

/** Everything Effect's logger writes while `run` runs; it writes through the console. */
async function captureConsole(run: () => unknown): Promise<string> {
  const lines: string[] = [];
  const sink = (...args: unknown[]): void => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  const c = (globalThis as typeof globalThis & { console: Console }).console;
  const original = { log: c.log, info: c.info, warn: c.warn, error: c.error, debug: c.debug };
  Object.assign(c, { log: sink, info: sink, warn: sink, error: sink, debug: sink });
  try {
    await run();
  } finally {
    Object.assign(c, original);
  }
  return lines.join("\n");
}

const failureOf = async <A, E>(effect: Effect.Effect<A, E>): Promise<E | undefined> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return undefined;
  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  return failure?._tag === "Fail" ? failure.error : undefined;
};

describe("deletion records: only ids reach storage", () => {
  it.each([
    ["an id with a space", { accountId: "Ann Lee" }],
    ["an id with an @", { accountId: "ann@example.com" }],
    ["an id of 65 characters", { accountId: "a".repeat(65) }],
    ["a profile id that is a name", { profileIds: ["usr_0123456789ab", "Ann Lee"] }],
    ["a field the kind does not carry", { email: "ann@example.com" }],
  ])("refuses %s, and puts nothing", async (_name, over) => {
    const target = bucket();
    const store = r2DeletionRecordStore(target);
    const error = await failureOf(store.write(erased(over)));
    expect(error).toBeInstanceOf(DeletionRecordRefused);
    expect(target.objects.size).toBe(0);
  });

  it.each([
    ["an action id with free text", { action: "osn:organisation:Ann's club", choice: "delete" }],
    ["a choice that is a sentence", { action: "osn:organisation:org_1", choice: "Please delete" }],
  ])("refuses %s in an account deletion's answers", async (_name, answer) => {
    const store = memoryDeletionRecordStore();
    const error = await failureOf(
      store.write({
        v: 1,
        kind: "account_deletion_requested",
        at: 1_764_000_000_000,
        accountId: "acc_0123456789ab",
        jobId: "djob_0123456789abcdef0123456789abcdef",
        hardDeleteAt: 1_764_604_800,
        deleteEverything: false,
        choices: [answer],
      }),
    );
    expect(error).toBeInstanceOf(DeletionRecordRefused);
    expect(store.records()).toEqual([]);
  });
});

describe("deletion records: keys", () => {
  it("sort by time across a change in the number of digits", () => {
    const earlier = recordKey(erased({ at: 999_999_999_999 }));
    const later = recordKey(erased({ at: 1_000_000_000_000 }));
    expect([later, earlier].toSorted()).toEqual([earlier, later]);
  });
});

describe("deletion records: a store that fails", () => {
  it("a put that rejects is a write error, not a defect", async () => {
    const store = r2DeletionRecordStore({
      put: () => Promise.reject(new Error("R2 unavailable")),
      delete: async () => {},
    });
    expect(await failureOf(store.write(erased()))).toBeInstanceOf(DeletionRecordWriteError);
  });

  it("a put answered too late is deleted once it lands", async () => {
    const target = bucket();
    let land: () => void = () => {};
    const store = r2DeletionRecordStore(
      {
        put: (key, value) =>
          new Promise((resolve) => {
            land = () => {
              target.objects.set(key, value);
              resolve(null);
            };
          }),
        delete: target.delete,
      },
      { timeoutMs: 20 },
    );
    expect(await failureOf(store.write(erased()))).toBeInstanceOf(DeletionRecordWriteError);
    land();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(target.objects.size).toBe(0);
  });

  it("a put that never settles ends as a write error", async () => {
    const store = r2DeletionRecordStore(
      { put: () => new Promise(() => {}), delete: async () => {} },
      { timeoutMs: 20 },
    );
    expect(await failureOf(store.write(erased()))).toBeInstanceOf(DeletionRecordWriteError);
  });

  it("the store of a Worker with no bucket bound refuses every write", async () => {
    expect(await failureOf(missingDeletionRecordStore().write(erased()))).toBeInstanceOf(
      DeletionRecordWriteError,
    );
  });
});

describe("deletion records: a request the database refused keeps no record", () => {
  const run = <A, E>(
    perform: (write: Write) => Effect.Effect<A, E>,
    accepted: (result: A) => boolean,
    refused: (error: E) => boolean = () => false,
  ) => {
    const store = memoryDeletionRecordStore();
    const effect = withDeletionRecord(store, {
      perform,
      accepted,
      refused,
      build: () => erased(),
    });
    return { store, effect };
  };

  it("keeps the record of an accepted request", async () => {
    const { store, effect } = run(
      (write) => write().pipe(Effect.as("done")),
      () => true,
    );
    await Effect.runPromise(effect);
    expect(store.records()).toHaveLength(1);
  });

  it("discards it when the request is refused after the write", async () => {
    const { store, effect } = run(
      (write) => write().pipe(Effect.as({ cancelled: false })),
      (result) => result.cancelled,
    );
    await Effect.runPromise(effect);
    expect(store.records()).toEqual([]);
  });

  it("discards it when the write after it fails with a refusal, and answers that refusal", async () => {
    const { store, effect } = run(
      (write) => write().pipe(Effect.andThen(Effect.fail("last profile" as const))),
      () => true,
      (error) => error === "last profile",
    );
    expect(await failureOf(effect)).toBe("last profile");
    expect(store.records()).toEqual([]);
  });

  it("keeps it when the write after it fails with an error that may have landed", async () => {
    // A database error says nothing of whether the write committed, and a
    // deletion the database took must stay on record.
    const { store, effect } = run(
      (write) => write().pipe(Effect.andThen(Effect.fail("database down" as const))),
      () => true,
      () => false,
    );
    expect(await failureOf(effect)).toBe("database down");
    expect(store.records()).toHaveLength(1);
  });

  it("deletes the discarded record from the R2 bucket by its key", async () => {
    const target = bucket();
    const effect = withDeletionRecord(r2DeletionRecordStore(target), {
      build: () => erased(),
      perform: (write: Write) => write().pipe(Effect.as({ cancelled: false })),
      accepted: (result) => result.cancelled,
      refused: () => false,
    });
    await Effect.runPromise(effect);
    expect(target.objects.size).toBe(0);
  });

  it("answers the request's own failure when the discard fails too, and logs the discard", async () => {
    const memory = memoryDeletionRecordStore();
    const store: DeletionRecordStore = {
      write: memory.write,
      discard: (written) => missingDeletionRecordStore().discard(written),
      rewrite: memory.rewrite,
    };
    const effect = withDeletionRecord(store, {
      build: () => erased(),
      perform: (write: Write) => write().pipe(Effect.andThen(Effect.fail("refused" as const))),
      accepted: () => true,
      refused: () => true,
    });
    const logs = await captureConsole(async () => {
      expect(await failureOf(effect)).toBe("refused");
    });
    expect(logs).toContain("deletion record discard failed");
    expect(memory.records()).toHaveLength(1);
  });
});

describe("deletion records: the most a route sends", () => {
  // osn-api's DELETE /account takes at most 200 answers; cire's and zap's
  // account-deleted bodies at most 100 profile ids. A record that refused the
  // most a route accepts would refuse that erasure on every retry.
  it("accepts 100 profile ids and 200 answers", async () => {
    const store = memoryDeletionRecordStore();
    await Effect.runPromise(
      store.write(
        erased({
          profileIds: Array.from({ length: 100 }, (_, i) => `usr_${String(i).padStart(12, "0")}`),
        }),
      ),
    );
    await Effect.runPromise(
      store.write({
        v: 1,
        kind: "account_deletion_requested",
        at: 1_764_000_000_000,
        accountId: "acc_0123456789ab",
        jobId: "djob_0123456789abcdef0123456789abcdef",
        hardDeleteAt: 1_764_604_800,
        deleteEverything: false,
        choices: Array.from({ length: 200 }, (_, i) => ({
          action: `osn:organisation:org_${i}`,
          choice: "successor",
          successorProfileId: `usr_${String(i).padStart(12, "0")}`,
        })),
      }),
    );
    expect(store.records()).toHaveLength(2);
  });
});

describe("deletion records: what a product's telemetry sees", () => {
  const recordedBy = (store: DeletionRecordStore) => {
    const counted: string[] = [];
    const instrumented = instrumentDeletionRecords(store, {
      spanName: "test.deletion_record.write",
      count: (kind, result) => counted.push(`${kind}:${result}`),
    });
    return { counted, instrumented };
  };

  it("counts a written record as ok", async () => {
    const { counted, instrumented } = recordedBy(memoryDeletionRecordStore());
    await Effect.runPromise(instrumented.write(erased()));
    expect(counted).toEqual(["account_erased:ok"]);
  });

  it("logs and counts a failed write and a refused value with the kind and the tag, never an id", async () => {
    const { counted, instrumented } = recordedBy(missingDeletionRecordStore());
    const failed = await captureConsole(() => Effect.runPromiseExit(instrumented.write(erased())));
    const refused = await captureConsole(() =>
      Effect.runPromiseExit(
        recordedBy(memoryDeletionRecordStore()).instrumented.write(
          erased({ accountId: "Ann Lee" }),
        ),
      ),
    );
    expect(counted).toEqual(["account_erased:failed"]);
    expect(failed).toContain("deletion record write failed");
    expect(failed).toContain("DeletionRecordWriteError");
    expect(failed).toContain("account_erased");
    expect(refused).toContain("DeletionRecordRefused");
    for (const logs of [failed, refused]) {
      expect(logs).not.toContain("acc_0123456789ab");
      expect(logs).not.toContain("usr_0123456789ab");
      expect(logs).not.toContain("Ann Lee");
    }
  });

  it("counts a refused value as refused", async () => {
    const { counted, instrumented } = recordedBy(memoryDeletionRecordStore());
    await captureConsole(() =>
      Effect.runPromiseExit(instrumented.write(erased({ accountId: "Ann Lee" }))),
    );
    expect(counted).toEqual(["account_erased:refused"]);
  });
});

describe("deletion records: settling a record once its request returned", () => {
  const outcome = {
    deletedWeddings: ["wed_a"],
    removedSeats: [{ weddingId: "wed_b", profileId: "usr_0123456789ab" }],
    unsettledWeddings: ["wed_c"],
    cleanUp: "unsettled" as const,
    finished: false,
  };

  it("writes the outcome over the record, under the same key", async () => {
    const target = bucket();
    const store = r2DeletionRecordStore(target);
    const written = await Effect.runPromise(store.write(erased()));
    await Effect.runPromise(settleDeletionRecord(store, written, erased({ outcome })));
    expect([...target.objects.keys()]).toEqual([written.key]);
    expect(JSON.parse(target.objects.get(written.key) ?? "null")).toMatchObject({ outcome });
  });

  it("tries an outcome the store failed to take once more", async () => {
    const memory = memoryDeletionRecordStore();
    let refusals = 1;
    const flaky: DeletionRecordStore = {
      ...memory,
      rewrite: (written, record) =>
        refusals-- > 0
          ? Effect.fail(
              new DeletionRecordWriteError({
                kind: written.kind,
                reason: "failed",
                key: written.key,
              }),
            )
          : memory.rewrite(written, record),
    };
    const written = await Effect.runPromise(memory.write(erased()));
    const logs = await captureConsole(() =>
      Effect.runPromise(settleDeletionRecord(flaky, written, erased({ outcome }))),
    );
    expect(memory.records()).toEqual([expect.objectContaining({ outcome })]);
    expect(logs).not.toContain("deletion record settle failed");
  });

  it("takes an outcome listing the most seats a record holds, and refuses one more", async () => {
    const store = memoryDeletionRecordStore();
    const written = await Effect.runPromise(store.write(erased()));
    const seats = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        weddingId: `wed_${i}`,
        profileId: "usr_0123456789ab",
      }));
    const at = (n: number) =>
      store.rewrite(written, erased({ outcome: { ...outcome, removedSeats: seats(n) } }));
    await Effect.runPromise(at(DELETION_RECORD_MAX_SEATS));
    expect(await failureOf(at(DELETION_RECORD_MAX_SEATS + 1))).toBeInstanceOf(
      DeletionRecordRefused,
    );
  });

  it("deletes the record when the call did nothing", async () => {
    const store = memoryDeletionRecordStore();
    const written = await Effect.runPromise(store.write(erased()));
    await Effect.runPromise(settleDeletionRecord(store, written, null));
    expect(store.records()).toEqual([]);
  });

  it("logs a settle that fails with the kind, the reason and the key, never an id", async () => {
    const memory = memoryDeletionRecordStore();
    const written = await Effect.runPromise(memory.write(erased()));
    const broken: DeletionRecordStore = {
      write: memory.write,
      discard: (held) => missingDeletionRecordStore().discard(held),
      rewrite: (held, record) => missingDeletionRecordStore().rewrite(held, record),
    };
    for (const settled of [null, erased({ outcome })]) {
      const logs = await captureConsole(() =>
        Effect.runPromise(settleDeletionRecord(broken, written, settled)),
      );
      expect(logs).toContain("deletion record settle failed");
      expect(logs).toContain("no_bucket");
      expect(logs).toContain(written.key);
      expect(logs).not.toContain("acc_0123456789ab");
      expect(logs).not.toContain("usr_0123456789ab");
    }
  });

  it("refuses an outcome naming a wedding by anything but its id", async () => {
    const store = memoryDeletionRecordStore();
    const written = await Effect.runPromise(store.write(erased()));
    const settling = store.rewrite(
      written,
      erased({
        outcome: {
          deletedWeddings: ["Ama & Jonah"],
          removedSeats: [],
          unsettledWeddings: [],
          cleanUp: "done",
          finished: true,
        },
      }),
    );
    expect(await failureOf(settling)).toBeInstanceOf(DeletionRecordRefused);
  });
});

describe("deletion records: a write that timed out", () => {
  it("is logged with the record's key, which names no one", async () => {
    const instrumented = instrumentDeletionRecords(
      r2DeletionRecordStore(
        { put: () => new Promise(() => {}), delete: async () => {} },
        { timeoutMs: 20 },
      ),
      { spanName: "test.deletion_record.write", count: () => {} },
    );
    const logs = await captureConsole(() => Effect.runPromiseExit(instrumented.write(erased())));
    expect(logs).toMatch(/records\/1764000000000-account_erased-[0-9a-f]{32}\.json/);
    expect(logs).not.toContain("acc_0123456789ab");
  });
});

describe("deletion records: a withdrawal is never blocked", () => {
  it("tries its record once more when the store fails, and keeps it", async () => {
    const memory = memoryDeletionRecordStore();
    let tries = 0;
    const flaky: DeletionRecordStore = {
      write: (record) =>
        Effect.suspend(() => {
          tries += 1;
          return tries === 1 ? missingDeletionRecordStore().write(record) : memory.write(record);
        }),
      discard: memory.discard,
      rewrite: memory.rewrite,
    };
    const effect = withDeletionRecord(flaky, {
      build: () => erased(),
      perform: (write: Write) => neverBlocking(write)().pipe(Effect.as("withdrawn")),
      accepted: () => true,
      refused: () => false,
    });
    expect(await Effect.runPromise(effect)).toBe("withdrawn");
    expect(memory.records()).toHaveLength(1);
  });

  it("goes ahead when its record cannot be written", async () => {
    const effect = withDeletionRecord(missingDeletionRecordStore(), {
      build: () => erased(),
      perform: (
        write: (
          input: void,
        ) => Effect.Effect<void, DeletionRecordWriteError | DeletionRecordRefused>,
      ) => neverBlocking(write)().pipe(Effect.as("withdrawn")),
      accepted: () => true,
      refused: () => false,
    });
    expect(await Effect.runPromise(effect)).toBe("withdrawn");
  });
});
