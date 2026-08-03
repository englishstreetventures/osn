import { Data, Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { makeSafeError } from "../../src/lib/safe-error";

class GraphError extends Data.TaggedError("GraphError")<{ readonly message: string }> {}
class DatabaseError extends Data.TaggedError("DatabaseError")<{ readonly cause: unknown }> {}

const safeError = makeSafeError(["GraphError", "NotFoundError"]);

/** Reject the way route handlers see failures: through `ManagedRuntime.runPromise`. */
async function rejectionOf(effect: Effect.Effect<never, unknown>): Promise<unknown> {
  const runtime = ManagedRuntime.make(Layer.empty);
  try {
    await runtime.runPromise(effect);
    throw new Error("expected rejection");
  } catch (e) {
    return e;
  } finally {
    await runtime.dispose();
  }
}

describe("makeSafeError", () => {
  it("surfaces an allow-listed tagged error thrown directly", () => {
    expect(safeError(new GraphError({ message: "Cannot connect to yourself" }))).toBe(
      "Cannot connect to yourself",
    );
  });

  it("surfaces an allow-listed tagged error wrapped in a FiberFailure", async () => {
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
});
