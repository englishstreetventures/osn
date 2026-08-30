import { describe, it, expect } from "vitest";

import { publicError } from "../../src/lib/public-error";

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
    // The reason the walk uses `Reflect.ownKeys` at all: `Effect.runPromise`
    // rejects with a `FiberFailure` holding its `Cause` under a symbol.
    const err = { [Symbol("Cause")]: { _tag: "DatabaseError" } };
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
