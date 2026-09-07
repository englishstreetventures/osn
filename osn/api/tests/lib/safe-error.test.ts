import { Data, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { makeAppRunner } from "../../src/lib/route-runtime";
import { makeSafeError } from "../../src/lib/safe-error";

class GraphError extends Data.TaggedError("GraphError")<{ readonly message: string }> {}
class DatabaseError extends Data.TaggedError("DatabaseError")<{ readonly cause: unknown }> {}

const safeError = makeSafeError(["GraphError", "NotFoundError"]);

/**
 * Reject the way route handlers see failures: through `makeAppRunner`'s `run`.
 *
 * This has to be `run` and not a raw `runtime.runPromise`. The S-M17 invariant
 * belongs to the runner/helper PAIR — `run` is what turns a defect into a
 * tagless `OpaqueDefect`, and `makeSafeError` is what applies the allowlist to
 * what survives. A harness that called `runPromise` directly would be testing a
 * code path no route uses, and would go green on the leak below.
 */
async function rejectionOf(effect: Effect.Effect<never, unknown>): Promise<unknown> {
  const { runtime, run } = makeAppRunner(undefined, Layer.empty);
  try {
    await run(effect);
  } catch (e) {
    return e;
  } finally {
    await runtime.dispose();
  }
  // Outside the try: a thrown "did not reject" must not be mistaken for the
  // rejection under test, which would let a generic-message assertion pass
  // vacuously.
  throw new Error("expected the effect to reject");
}

describe("makeSafeError", () => {
  it("surfaces an allow-listed tagged error thrown directly", () => {
    expect(safeError(new GraphError({ message: "Cannot connect to yourself" }))).toBe(
      "Cannot connect to yourself",
    );
  });

  it("surfaces an allow-listed tagged error raised as a typed failure", async () => {
    const e = await rejectionOf(
      Effect.fail(new GraphError({ message: "Connection already exists" })),
    );
    expect(safeError(e)).toBe("Connection already exists");
  });

  it("collapses non-allow-listed tagged errors to the generic message", async () => {
    const e = await rejectionOf(
      Effect.fail(new DatabaseError({ cause: new Error("SQLITE_CONSTRAINT: unique index") })),
    );
    expect(safeError(e)).toBe("Request failed");
  });

  it("collapses defects (thrown non-failures) to the generic message", async () => {
    const e = await rejectionOf(Effect.die(new Error("boom: internal detail")));
    expect(safeError(e)).toBe("Request failed");
  });

  it("collapses arbitrary values to the generic message", () => {
    expect(safeError(undefined)).toBe("Request failed");
    expect(safeError("string error")).toBe("Request failed");
    expect(safeError(new Error("plain error"))).toBe("Request failed");
  });

  /**
   * S-M17, the structural half. `Data.TaggedError` IS an `Error` carrying a
   * `_tag`, so an allow-listed tag is NOT on its own evidence that a service
   * chose to expose the message: every route below turns the very same class
   * into a defect, and Effect v4's `Cause.squash` (what a plain `runPromise`
   * rejects with) hands that defect back verbatim. Only the runner's `Fail`/
   * defect split keeps these out of the allowlist check.
   *
   * The message is written the way a real internal invariant would be — the
   * thing an operator wants in a log and a client must never see.
   */
  describe("a DEFECT carrying an allow-listed tag never reaches the allowlist", () => {
    const secret = "SECRET internal invariant: shard 7 lock table corrupt";

    it("Effect.die", async () => {
      const e = await rejectionOf(Effect.die(new GraphError({ message: secret })));
      expect(safeError(e)).toBe("Request failed");
      expect(safeError(e)).not.toContain("SECRET");
    });

    it("Effect.orDie over a typed failure (the pattern in routes/graph.ts)", async () => {
      const e = await rejectionOf(Effect.orDie(Effect.fail(new GraphError({ message: secret }))));
      expect(safeError(e)).toBe("Request failed");
      expect(safeError(e)).not.toContain("SECRET");
    });

    it("a bare throw inside Effect.sync", async () => {
      const e = await rejectionOf(
        Effect.sync((): never => {
          throw new GraphError({ message: secret });
        }),
      );
      expect(safeError(e)).toBe("Request failed");
      expect(safeError(e)).not.toContain("SECRET");
    });

    it("but the SAME class raised as a typed failure still surfaces its message", async () => {
      // The control. Without it, the three cases above are satisfied by a
      // helper that returns the generic message for everything.
      const e = await rejectionOf(Effect.fail(new GraphError({ message: "Already connected" })));
      expect(safeError(e)).toBe("Already connected");
    });
  });
});
