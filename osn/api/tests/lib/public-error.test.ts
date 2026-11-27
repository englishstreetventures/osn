import { DeletionRecordRefused, DeletionRecordWriteError } from "@shared/db-utils/deletion-records";
import { Data, Effect, Layer } from "effect";
import { describe, it, expect } from "vitest";

import { publicError } from "../../src/lib/public-error";
import { makeAppRunner } from "../../src/lib/route-runtime";
import { CoordinationError } from "../../src/services/auth/errors";

/**
 * The tag walk reads each own key with one property read. These tests pin
 * what that read must keep doing.
 *
 * Three tags collapse to the same 400 (`ValidationError`, `AuthError`, and the
 * `default`), so a test asserting 400 cannot tell a found tag from a missed
 * one. Every case that means to prove the walk found something therefore uses
 * a discriminating tag: `DatabaseError` (500) or `AgeRestrictionError` (422).
 */
describe("publicError", () => {
  it("answers a coordination-store failure with a 503 naming nothing", () => {
    const err = new CoordinationError({ store: "email_link", op: "set" });
    expect(publicError(err)).toEqual({
      status: 503,
      body: { error: "temporarily_unavailable" },
    });
  });

  it("answers a deletion record the store could not write with 503, and one it refused with 500", () => {
    // The route refused the erasure request before writing anything; a
    // record holding a value that is not an id is a bug, not the caller's 400.
    expect(
      publicError(new DeletionRecordWriteError({ kind: "profile_deleted", reason: "failed" })),
    ).toEqual({ status: 503, body: { error: "temporarily_unavailable" } });
    expect(publicError(new DeletionRecordRefused({ kind: "profile_deleted" }))).toEqual({
      status: 500,
      body: { error: "internal_error" },
    });
  });

  it("maps a tagged error to its dedicated status", () => {
    const err = { _tag: "AgeRestrictionError" };
    expect(publicError(err)).toEqual({
      status: 422,
      body: { error: "age_restricted", message: "You must be 13 or older to create an account" },
    });
  });

  // 400 is also what a found `ValidationError` returns, so this one pins the
  // fall-through and nothing more. The cases below carry the walk.
  it("falls through to the generic default for an untagged error", () => {
    const err = new Error("boom");
    expect(publicError(err)).toEqual({ status: 400, body: { error: "invalid_request" } });
  });

  it("skips a throwing getter instead of propagating the throw", () => {
    // The root's own `_tag` has to be a Cause tag. A domain tag on the root
    // returns before the key loop ever runs, so the getter would never be
    // read and this test would pass without touching the changed code.
    const err = {
      _tag: "Fail",
      get poison(): never {
        throw new Error("do not read me");
      },
      error: { _tag: "DatabaseError" },
    };
    expect(() => publicError(err)).not.toThrow();
    expect(publicError(err)).toEqual({ status: 500, body: { error: "internal_error" } });
  });

  it("invokes an own accessor with `this` bound to the node it sits on", () => {
    // `_inner` lives on the prototype, so `Reflect.ownKeys` never yields it.
    // The only route to the tag is `cause`, invoked with `this` === err — a
    // read that skipped accessors, or bound them wrongly, would find nothing.
    const proto = { _inner: { _tag: "DatabaseError" } };
    const err = Object.create(proto) as object;
    Object.defineProperty(err, "cause", {
      enumerable: true,
      get(this: { _inner: unknown }) {
        return this._inner;
      },
    });
    expect(publicError(err)).toEqual({ status: 500, body: { error: "internal_error" } });
  });

  it("finds a tag stored under a symbol key", () => {
    // An arbitrary thrown value may carry its tag under a symbol key.
    const err = { [Symbol("Cause")]: { _tag: "DatabaseError" } };
    expect(publicError(err)).toEqual({ status: 500, body: { error: "internal_error" } });
  });

  it("finds a tag behind a NON-enumerable own key", () => {
    // `new Error(msg, { cause })`, the form OpaqueDefect uses, defines `cause`
    // non-enumerable; an `Object.values` walk would miss every defect.
    const err = new Error("opaque", { cause: { _tag: "DatabaseError" } });
    expect(publicError(err)).toEqual({ status: 500, body: { error: "internal_error" } });
  });

  it("steps over an Effect Cause tag and keeps descending", () => {
    const err = { [Symbol("Cause")]: { _tag: "Fail", error: { _tag: "DatabaseError" } } };
    expect(publicError(err)).toEqual({ status: 500, body: { error: "internal_error" } });
  });

  it("walks a null-prototype object without throwing", () => {
    const err = Object.assign(Object.create(null), { _tag: "DatabaseError" }) as {
      _tag: string;
    };
    expect(publicError(err)).toEqual({ status: 500, body: { error: "internal_error" } });
  });

  it("visits each node once, so self-references do not use up the walk", () => {
    const err: Record<string, unknown> = { note: "no tag here" };
    err.self = err;
    expect(publicError(err)).toEqual({ status: 400, body: { error: "invalid_request" } });

    // Five nodes, each pointing at itself ten times and at the next through
    // `cause`; the last cause is tagged. Visited once each, they cost about
    // sixty steps of the budget. Walked again at every reference, the queue
    // grows elevenfold a level and the budget ends before the tag.
    let node: Record<string, unknown> = { _tag: "DatabaseError" };
    for (let level = 0; level < 5; level++) {
      const wrapper: Record<string, unknown> = { cause: node };
      for (let k = 0; k < 10; k++) wrapper[`self${k}`] = wrapper;
      node = wrapper;
    }
    expect(publicError(node)).toEqual({ status: 500, body: { error: "internal_error" } });
  });

  it("truncates past the 512-node budget instead of walking a large graph", () => {
    // Deliberate: a real tag sits within a few hops, so a tag this deep is a
    // graph the walk is meant to give up on, not a lookup it should complete.
    let node: Record<string, unknown> = { _tag: "DatabaseError" };
    for (let i = 0; i < 600; i++) node = { next: node };
    expect(publicError(node)).toEqual({ status: 400, body: { error: "invalid_request" } });
  });

  // A wide, shallow chain (sixty string fields per hop) must not spend the
  // 512-node budget on primitives: only objects are queued.
  it("reaches a tagged error past a wide chain of primitive fields", () => {
    let node: Record<string, unknown> = { _tag: "DatabaseError" };
    for (let hop = 0; hop < 10; hop++) {
      const wide: Record<string, unknown> = { cause: node };
      for (let f = 0; f < 60; f++) wide[`field${f}`] = `value${f}`;
      node = wide;
    }
    expect(publicError(node)).toEqual({ status: 500, body: { error: "internal_error" } });
  });

  // A primitive `e` never reaches `Reflect.ownKeys`, which throws on a primitive.
  it.each([["a string error"], [null]])(
    "falls through for a primitive %p without throwing",
    (e) => {
      expect(() => publicError(e)).not.toThrow();
      expect(publicError(e)).toEqual({ status: 400, body: { error: "invalid_request" } });
    },
  );
});

/**
 * The shapes `publicError` actually receives in production, produced by the
 * thing that produces them: `makeAppRunner`'s `run`. A typed failure arrives as
 * the tagged error itself; a defect arrives as a tagless `OpaqueDefect` that
 * retains its `Cause`, and the walk has to reach through
 * `.cause` -> `Cause` -> `.reasons[0]` (a `Die`) -> `.defect` to find the tag.
 */
describe("publicError on what makeAppRunner's run rejects with", () => {
  class DatabaseError extends Data.TaggedError("DatabaseError")<{ readonly cause: unknown }> {}
  class GraphError extends Data.TaggedError("GraphError")<{ readonly message: string }> {}

  const SECRET = "SECRET internal invariant: shard 7 lock table corrupt";

  async function rejectionOf(effect: Effect.Effect<never, unknown>): Promise<unknown> {
    const { runtime, run } = makeAppRunner(undefined, Layer.empty);
    try {
      await run(effect);
    } catch (e) {
      return e;
    } finally {
      await runtime.dispose();
    }
    throw new Error("expected the effect to reject");
  }

  it("maps a typed DatabaseError failure to 500 internal_error", async () => {
    const e = await rejectionOf(Effect.fail(new DatabaseError({ cause: SECRET })));
    expect(publicError(e)).toEqual({ status: 500, body: { error: "internal_error" } });
  });

  it("maps a DIED DatabaseError to 500 internal_error too", async () => {
    // The walk still reaches the tag through the retained `Cause`, so a crash
    // in the DB layer is still reported as a server error rather than being
    // mislabelled a bad request.
    const e = await rejectionOf(Effect.die(new DatabaseError({ cause: SECRET })));
    expect(publicError(e)).toEqual({ status: 500, body: { error: "internal_error" } });
  });

  it("never puts a defect's message on the wire", async () => {
    // `publicError` returns fixed codes and fixed public strings only; nothing
    // the defect carried may appear in the body, whatever tag it wears.
    for (const eff of [
      Effect.die(new GraphError({ message: SECRET })),
      Effect.orDie(Effect.fail(new GraphError({ message: SECRET }))),
      Effect.die(new DatabaseError({ cause: SECRET })),
      Effect.fail(new GraphError({ message: SECRET })),
    ] as Effect.Effect<never, unknown>[]) {
      const body = JSON.stringify(publicError(await rejectionOf(eff)));
      expect(body).not.toContain("SECRET");
    }
  });

  it("falls through to the 400 default for an untagged defect", async () => {
    // An untagged crash maps to the generic invalid_request.
    const e = await rejectionOf(Effect.die(new Error("boom")));
    expect(publicError(e)).toEqual({ status: 400, body: { error: "invalid_request" } });
  });
});
