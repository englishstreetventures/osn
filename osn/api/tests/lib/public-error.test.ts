import { Data, Effect, Layer } from "effect";
import { describe, it, expect } from "vitest";

import { publicError } from "../../src/lib/public-error";
import { makeAppRunner } from "../../src/lib/route-runtime";

/**
 * The tag walk (P-I2 / tracker#446) reads each own key through a plain
 * property access now, not `Object.getOwnPropertyDescriptor`. These tests pin
 * the behaviour that read has to preserve.
 *
 * Three tags collapse to the same 400 (`ValidationError`, `AuthError`, and the
 * `default`), so a test asserting 400 cannot tell a found tag from a missed
 * one. Every case that means to prove the walk found something therefore uses
 * a discriminating tag: `DatabaseError` (500) or `AgeRestrictionError` (422).
 */
describe("publicError", () => {
  it("maps a tagged error to its dedicated status", () => {
    const err = { _tag: "AgeRestrictionError" };
    expect(publicError(err)).toEqual({
      status: 422,
      body: { error: "age_restricted", message: "OSN is for users 13 and older" },
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
    // Effect v4 brands its own `Cause`/`Reason` by STRING key, so this is no
    // longer the reason the walk uses `Reflect.ownKeys` (see the
    // non-enumerable case below for that). It stays because `e` is an
    // arbitrary thrown value and a symbol-keyed tag carrier costs nothing to
    // cover.
    const err = { [Symbol("Cause")]: { _tag: "DatabaseError" } };
    expect(publicError(err)).toEqual({ status: 500, body: { error: "internal_error" } });
  });

  it("finds a tag behind a NON-enumerable own key", () => {
    // This is what `Reflect.ownKeys` actually buys now. `new Error(msg,
    // { cause })` — the form `OpaqueDefect` uses to retain its `Cause` —
    // defines `cause` non-enumerable, so an `Object.values` walk would miss
    // every defect and fall through to the 400 default.
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

  it("returns rather than looping on a self-referencing error", () => {
    const err: Record<string, unknown> = { note: "no tag here" };
    err.self = err;
    expect(publicError(err)).toEqual({ status: 400, body: { error: "invalid_request" } });
  });

  it("truncates past the 512-node budget instead of walking a large graph", () => {
    // Deliberate: a real tag sits within a few hops, so a tag this deep is a
    // graph the walk is meant to give up on, not a lookup it should complete.
    let node: Record<string, unknown> = { _tag: "DatabaseError" };
    for (let i = 0; i < 600; i++) node = { next: node };
    expect(publicError(node)).toEqual({ status: 400, body: { error: "invalid_request" } });
  });

  // tracker#473: a wide-but-shallow cause chain (many string fields per hop)
  // must not spend the 512-node budget on primitives. Against the unfixed
  // walk — which dequeues (and so charges budget for) every pushed value,
  // primitives included — this chain exhausts the budget before reaching the
  // tagged node and falls through to 400; that is the bug this test pins.
  it("reaches a tagged error past a wide chain of primitive fields", () => {
    let node: Record<string, unknown> = { _tag: "DatabaseError" };
    for (let hop = 0; hop < 10; hop++) {
      const wide: Record<string, unknown> = { cause: node };
      for (let f = 0; f < 60; f++) wide[`field${f}`] = `value${f}`;
      node = wide;
    }
    expect(publicError(node)).toEqual({ status: 500, body: { error: "internal_error" } });
  });

  // The #473 seed narrowing's regression test: a primitive `e` must not reach
  // `Reflect.ownKeys`, which throws on a primitive in strict mode.
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
    // Pinned as-is, not endorsed: an untagged crash has always mapped to the
    // generic `invalid_request`, and this change does not move it.
    const e = await rejectionOf(Effect.die(new Error("boom")));
    expect(publicError(e)).toEqual({ status: 400, body: { error: "invalid_request" } });
  });
});
