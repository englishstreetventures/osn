/**
 * The record of an erasure request, kept outside the database it erases from.
 *
 * A D1 Time Travel restore rewinds a database to an earlier minute, and with
 * it every erasure asked for since. Each route that accepts an erasure
 * request, or its withdrawal, writes one record here first, to its product's
 * own R2 bucket, so the requests made after a restore point can be applied
 * again. A record holds ids, times, flags and fixed tokens only: the encoder
 * refuses anything else, so no name, handle, address or free text reaches the
 * bucket. The bucket's lifecycle rule deletes each record 31 days after it is
 * written: Time Travel's 30-day window and a day to apply them.
 *
 * Workers-safe: no `node:*` import. Tests and local runs use the memory store.
 */
import { Cause, Data, Effect, Exit, Option, Schema } from "effect";

// ── what a record holds ─────────────────────────────────────────────────────

/** An id as the products mint them: a prefix and hex, a UUID, a seed name. */
const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/));
/**
 * An open action's id: `<app>:<kind>` and, for one item, its id. The app
 * contract holds every app's answers to it, so no answer a person can give
 * is one a record refuses.
 */
export const DELETION_ACTION_ID_PATTERN = /^[a-z]+:[a-z_]+(?::[A-Za-z0-9_-]{1,64})?$/;
/** A choice an open action offers: `transfer`, `successor`, `delete`, `cancel`. */
export const DELETION_CHOICE_PATTERN = /^[a-z_]{1,32}$/;
const ActionId = Schema.String.check(Schema.isPattern(DELETION_ACTION_ID_PATTERN));
const ChoiceToken = Schema.String.check(Schema.isPattern(DELETION_CHOICE_PATTERN));
const Millis = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 9_999_999_999_999 }),
);
const Seconds = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 9_999_999_999 }),
);
/** At most the fan-out bodies' own bound on an account's profiles. */
export const DELETION_RECORD_MAX_PROFILES = 100;
const ProfileIds = Schema.Array(Id).check(Schema.isMaxLength(DELETION_RECORD_MAX_PROFILES));

/**
 * The most seats one erasure outcome lists. The erasure bounds what one call
 * removes to fit (cire's `MAX_OWNED_WEDDINGS_PER_CALL` and
 * `MAX_LOWER_SEATS_PER_CALL`, pinned against this by a test), so an outcome is
 * never refused for its length after the erasure has committed.
 */
export const DELETION_RECORD_MAX_SEATS = 500;

const head = { v: Schema.Literal(1), at: Millis };

/** osn-api: `DELETE /account` scheduled the account's deletion. */
const AccountDeletionRequested = Schema.Struct({
  ...head,
  kind: Schema.Literal("account_deletion_requested"),
  accountId: Id,
  jobId: Id,
  /** When the job's window ends, in unix seconds, as the job stores it. */
  hardDeleteAt: Seconds,
  deleteEverything: Schema.Boolean,
  /** The answers the job stores. `successorProfileId` is the member named, another person. */
  choices: Schema.Array(
    Schema.Struct({
      action: ActionId,
      choice: ChoiceToken,
      successorProfileId: Schema.optionalKey(Id),
    }),
  ).check(Schema.isMaxLength(200)),
});

/** osn-api: `POST /account/restore` cancelled the account's deletion. */
const AccountDeletionWithdrawn = Schema.Struct({
  ...head,
  kind: Schema.Literal("account_deletion_withdrawn"),
  accountId: Id,
  /** The job cancelled; null for a job written before jobs had an id. */
  jobId: Schema.NullOr(Id),
});

/** osn-api: `POST /profiles/delete` deleted one profile of an account. */
const ProfileDeleted = Schema.Struct({
  ...head,
  kind: Schema.Literal("profile_deleted"),
  accountId: Id,
  profileId: Id,
});

/**
 * What one call of cire's erasure of an account did, written over its record
 * once the call returns or stops: the weddings it deleted; each seat of the
 * account it removed, by wedding and profile, in its weddings' batches and
 * in its clean-up alike; a wedding whose batch failed or did not answer;
 * whether the account's clean-up ran (`unsettled`: its batch failed or did not
 * answer); and whether the erasure finished. It lists only what a statement's
 * `RETURNING` confirmed in a batch that answered: anything in doubt is
 * unsettled, for a person to decide. A replay applies this and no
 * more, however the restored rows stand (`wiki/compliance/backup-dr.md`
 * §Deletion records outside the databases). A record with no outcome is one
 * whose Worker stopped mid-call or whose outcome could not be written: a
 * replay deletes no wedding for it.
 */
const ErasureOutcome = Schema.Struct({
  deletedWeddings: Schema.Array(Id).check(Schema.isMaxLength(100)),
  removedSeats: Schema.Array(Schema.Struct({ weddingId: Id, profileId: Id })).check(
    Schema.isMaxLength(DELETION_RECORD_MAX_SEATS),
  ),
  unsettledWeddings: Schema.Array(Id).check(Schema.isMaxLength(100)),
  cleanUp: Schema.Literals(["done", "unsettled", "not_run"]),
  finished: Schema.Boolean,
});
export type ErasureOutcome = typeof ErasureOutcome.Type;

/** cire-api: "Remove my Cire data" erased the account's host data. */
const OrganiserDataRemoved = Schema.Struct({
  ...head,
  kind: Schema.Literal("organiser_data_removed"),
  accountId: Id,
  profileIds: ProfileIds,
  deleteEverything: Schema.Boolean,
  /** The weddings the person alone owned and answered `delete` for, as action ids. */
  deleteActions: Schema.Array(ActionId).check(Schema.isMaxLength(101)),
  outcome: Schema.optionalKey(ErasureOutcome),
});

/** cire-api: an owner deleted a wedding. */
const WeddingDeleted = Schema.Struct({
  ...head,
  kind: Schema.Literal("wedding_deleted"),
  weddingId: Id,
  profileId: Id,
});

/** cire-api: an owner restored a deleted wedding. */
const WeddingRestored = Schema.Struct({
  ...head,
  kind: Schema.Literal("wedding_restored"),
  weddingId: Id,
  profileId: Id,
});

/** cire-api: a guest removed their own email address. */
const GuestEmailRemoved = Schema.Struct({
  ...head,
  kind: Schema.Literal("guest_email_removed"),
  weddingId: Id,
  guestId: Id,
});

/**
 * cire-api or zap-api: osn-api's fan-out erased an account's data there. cire
 * writes the call's outcome over it; zap writes none, since everything Zap
 * erases is bounded by the profile ids or is a chat holding only their data.
 */
const AccountErased = Schema.Struct({
  ...head,
  kind: Schema.Literal("account_erased"),
  accountId: Id,
  profileIds: ProfileIds,
  outcome: Schema.optionalKey(ErasureOutcome),
});

export const DeletionRecord = Schema.Union([
  AccountDeletionRequested,
  AccountDeletionWithdrawn,
  ProfileDeleted,
  OrganiserDataRemoved,
  WeddingDeleted,
  WeddingRestored,
  GuestEmailRemoved,
  AccountErased,
]);
export type DeletionRecord = typeof DeletionRecord.Type;
export type DeletionRecordKind = DeletionRecord["kind"];

// ── errors ──────────────────────────────────────────────────────────────────

/** The store did not take the record: R2 failed or did not answer in time, or no bucket is bound. */
export class DeletionRecordWriteError extends Data.TaggedError("DeletionRecordWriteError")<{
  readonly kind: DeletionRecordKind;
  readonly reason: "failed" | "timeout" | "no_bucket";
  /** The record's key, which names no one: an operator removes a stray record by it. */
  readonly key?: string;
}> {}

/** The record holds a value that is not an id, a time, a flag or a token: a bug in its caller. */
export class DeletionRecordRefused extends Data.TaggedError("DeletionRecordRefused")<{
  readonly kind: string;
}> {}

// ── keys and encoding ───────────────────────────────────────────────────────

/**
 * Where a record is kept: `records/<at, 13 digits>-<kind>-<32 hex>.json`.
 * Lexicographic order is time order. No id is in the key. A record's `at` is
 * taken before its put and its database write, which can take up to
 * {@link DELETION_RECORD_TIMEOUT_MS} and a batch longer, so whoever lists from
 * a restore point starts a minute before it.
 */
export const recordKey = (record: DeletionRecord): string =>
  `records/${String(record.at).padStart(13, "0")}-${record.kind}-${crypto.randomUUID().replaceAll("-", "")}.json`;

/** The record as stored, once every field has passed its pattern. Refuses a field the kind does not carry. */
const encode = (record: DeletionRecord): Effect.Effect<string, DeletionRecordRefused> =>
  Schema.decodeUnknownEffect(DeletionRecord, { onExcessProperty: "error" })(record).pipe(
    Effect.map((valid) => JSON.stringify(valid)),
    Effect.mapError(() => new DeletionRecordRefused({ kind: String(record.kind) })),
  );

// ── stores ──────────────────────────────────────────────────────────────────

/** A record the store holds, by key. */
export interface Written {
  readonly key: string;
  readonly kind: DeletionRecordKind;
}

export interface DeletionRecordStore {
  readonly write: (
    record: DeletionRecord,
  ) => Effect.Effect<Written, DeletionRecordWriteError | DeletionRecordRefused>;
  /** Deletes a record whose request was not accepted after all. */
  readonly discard: (written: Written) => Effect.Effect<void, DeletionRecordWriteError>;
  /** Writes `record` over a record already written, under its key: the request's outcome. */
  readonly rewrite: (
    written: Written,
    record: DeletionRecord,
  ) => Effect.Effect<void, DeletionRecordWriteError | DeletionRecordRefused>;
}

/** What the R2 store needs of a bucket binding. */
export interface R2BucketLike {
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<object | null>;
  delete(key: string): Promise<void>;
}

/** How long one R2 call may take before the request is refused. */
export const DELETION_RECORD_TIMEOUT_MS = 5_000;

/**
 * The product's R2 bucket. A put that fails or does not answer in time is a
 * write error. A put that has not answered in time may still land, after its
 * request was refused, so its key is deleted once it settles.
 */
export function r2DeletionRecordStore(
  bucket: R2BucketLike,
  options: { readonly timeoutMs?: number } = {},
): DeletionRecordStore {
  const timeoutMs = options.timeoutMs ?? DELETION_RECORD_TIMEOUT_MS;
  const call = <A>(
    kind: DeletionRecordKind,
    key: string,
    run: () => Promise<A>,
    late?: () => void,
  ) =>
    Effect.suspend(() => {
      const pending = run();
      return Effect.tryPromise({
        try: () => pending,
        catch: () => new DeletionRecordWriteError({ kind, reason: "failed", key }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.sync(() => {
              if (late) void pending.then(late, () => undefined);
            }).pipe(
              Effect.andThen(
                Effect.fail(new DeletionRecordWriteError({ kind, reason: "timeout", key })),
              ),
            ),
        }),
      );
    });
  return {
    write: (record) =>
      Effect.gen(function* () {
        const body = yield* encode(record);
        const key = recordKey(record);
        yield* call(
          record.kind,
          key,
          () => bucket.put(key, body, { httpMetadata: { contentType: "application/json" } }),
          () => void bucket.delete(key).catch(() => undefined),
        );
        return { key, kind: record.kind };
      }),
    discard: (written) =>
      call(written.kind, written.key, () => bucket.delete(written.key)).pipe(Effect.asVoid),
    rewrite: (written, record) =>
      Effect.gen(function* () {
        const body = yield* encode(record);
        yield* call(record.kind, written.key, () =>
          bucket.put(written.key, body, { httpMetadata: { contentType: "application/json" } }),
        );
      }),
  };
}

/** Records kept in this process: tests, and local runs, which have no bucket. */
export function memoryDeletionRecordStore(): DeletionRecordStore & {
  /** Every record held, in the order written. */
  readonly records: () => DeletionRecord[];
} {
  const objects = new Map<string, string>();
  return {
    write: (record) =>
      Effect.gen(function* () {
        const body = yield* encode(record);
        const key = recordKey(record);
        objects.set(key, body);
        return { key, kind: record.kind };
      }),
    discard: (written) => Effect.sync(() => void objects.delete(written.key)),
    rewrite: (written, record) =>
      encode(record).pipe(Effect.map((body) => void objects.set(written.key, body))),
    records: () => [...objects.values()].map((body) => JSON.parse(body) as DeletionRecord),
  };
}

/** A deployed Worker with no bucket bound: every write fails, so no erasure is accepted unrecorded. */
export function missingDeletionRecordStore(): DeletionRecordStore {
  return {
    write: (record) =>
      Effect.fail(new DeletionRecordWriteError({ kind: record.kind, reason: "no_bucket" })),
    discard: (written) =>
      Effect.fail(
        new DeletionRecordWriteError({ kind: written.kind, reason: "no_bucket", key: written.key }),
      ),
    rewrite: (written) =>
      Effect.fail(
        new DeletionRecordWriteError({ kind: written.kind, reason: "no_bucket", key: written.key }),
      ),
  };
}

// ── telemetry ───────────────────────────────────────────────────────────────

/** How a record's write ended: written, the store failed, or the encoder refused a value. */
export type DeletionRecordWriteResult = "ok" | "failed" | "refused";

/** Where a product's store reports each write: its span name and its counter. */
export interface DeletionRecordTelemetry {
  /** `<namespace>.deletion_record.write`. */
  readonly spanName: string;
  readonly count: (kind: DeletionRecordKind, result: DeletionRecordWriteResult) => void;
}

/** What a failed write's log line carries: no id, ever. */
type FailureAnnotations = {
  readonly kind: DeletionRecordKind;
  readonly tag: string;
  /** The record's key, when the store failed: it names no one. */
  readonly key?: string;
};

/** A failed write's log annotations: the kind, the error's tag and, for a store failure, the key. */
function failureAnnotations(
  kind: DeletionRecordKind,
  error: DeletionRecordWriteError | DeletionRecordRefused,
): FailureAnnotations {
  return error._tag === "DeletionRecordWriteError" && error.key !== undefined
    ? { kind, tag: error._tag, key: error.key }
    : { kind, tag: error._tag };
}

/**
 * `store` with each write traced and counted, and a failed one logged as
 * `deletion record write failed` with its kind, the error's tag and, when the
 * store failed, the record's key: never an id, so neither the log line nor the
 * counter names a person.
 */
export const instrumentDeletionRecords = (
  store: DeletionRecordStore,
  telemetry: DeletionRecordTelemetry,
): DeletionRecordStore => ({
  write: (record) =>
    store.write(record).pipe(
      Effect.tap(() => Effect.sync(() => telemetry.count(record.kind, "ok"))),
      Effect.tapError((error) =>
        Effect.logError("deletion record write failed").pipe(
          Effect.annotateLogs(failureAnnotations(record.kind, error)),
          Effect.andThen(
            Effect.sync(() =>
              telemetry.count(
                record.kind,
                error._tag === "DeletionRecordRefused" ? "refused" : "failed",
              ),
            ),
          ),
        ),
      ),
      Effect.withSpan(telemetry.spanName, { attributes: { kind: record.kind } }),
    ),
  discard: store.discard,
  rewrite: store.rewrite,
});

/**
 * Settles a record once its request has returned: writes its outcome over it,
 * or, given none, deletes it, for a call that did nothing. A store that fails
 * is tried once more. Best effort: the request has already run, so a failure
 * is logged with the kind, the reason and the record's key, never an id, and
 * changes nothing else.
 */
export const settleDeletionRecord = (
  store: DeletionRecordStore,
  written: Written,
  settled: DeletionRecord | null,
): Effect.Effect<void> =>
  // Built anew on each try, so a retry calls the store again.
  Effect.suspend(() =>
    settled === null ? store.discard(written) : store.rewrite(written, settled),
  ).pipe(
    Effect.retry({ times: 1, while: (error) => error._tag === "DeletionRecordWriteError" }),
    Effect.catch((error) =>
      Effect.logError("deletion record settle failed").pipe(
        Effect.annotateLogs({
          kind: written.kind,
          reason: error._tag === "DeletionRecordWriteError" ? error.reason : "refused",
          key: written.key,
        }),
      ),
    ),
  );

// ── writing ahead of a request ──────────────────────────────────────────────

export type WriteDeletionRecord<I> = (
  input: I,
) => Effect.Effect<void, DeletionRecordWriteError | DeletionRecordRefused>;

/**
 * Runs `perform`, which calls `write` once its request has passed every check
 * that can refuse it and before the write that carries it out. When the
 * database refused the request — `accepted` says its result is no acceptance,
 * or `refused` says its failure is a refusal — the record it wrote is
 * discarded. Any other failure (a database error, a defect, an interruption)
 * leaves the record: the write may have landed, and a deletion the database
 * took must stay on record. A discard that fails is logged and changes nothing
 * else.
 */
export function withDeletionRecord<I, A, E, R>(
  store: DeletionRecordStore,
  options: {
    readonly build: (input: I) => DeletionRecord;
    readonly perform: (write: WriteDeletionRecord<I>) => Effect.Effect<A, E, R>;
    readonly accepted: (result: A) => boolean;
    readonly refused: (error: E) => boolean;
  },
): Effect.Effect<A, E, R> {
  return Effect.suspend(() => {
    let written: Written | undefined;
    const write: WriteDeletionRecord<I> = (input) =>
      store.write(options.build(input)).pipe(
        Effect.tap((done) =>
          Effect.sync(() => {
            written = done;
          }),
        ),
        Effect.asVoid,
      );
    const discard = Effect.suspend(() => {
      const held = written;
      if (held === undefined) return Effect.void;
      return store
        .discard(held)
        .pipe(
          Effect.catch((error) =>
            Effect.logError("deletion record discard failed").pipe(
              Effect.annotateLogs({ kind: error.kind, reason: error.reason, key: held.key }),
            ),
          ),
        );
    });
    const isRefusal = (exit: Exit.Exit<A, E>): boolean => {
      if (Exit.isSuccess(exit)) return !options.accepted(exit.value);
      const error = Cause.findErrorOption(exit.cause);
      return Option.isSome(error) && options.refused(error.value);
    };
    return options
      .perform(write)
      .pipe(Effect.onExit((exit) => (isRefusal(exit) ? discard : Effect.void)));
  });
}

/**
 * A withdrawal's record write that never blocks it: a failure is logged and
 * counted by the instrumented store, and the withdrawal goes ahead. A
 * withdrawal works only inside its window, so refusing it while the bucket is
 * down could cost the person what they are trying to keep.
 */
export const neverBlocking =
  <I>(write: WriteDeletionRecord<I>): ((input: I) => Effect.Effect<void>) =>
  (input) =>
    write(input).pipe(
      // One more try for a store that failed, not for a refused value.
      Effect.retry({ times: 1, while: (error) => error._tag === "DeletionRecordWriteError" }),
      Effect.catch(() => Effect.void),
    );
