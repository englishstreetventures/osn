import { Data } from "effect";
import { describe, expect, it } from "vitest";
import { classifyError, OSN_METRICS } from "../src/metrics";

/**
 * `classifyError` is the cardinality firewall between OSN's rich tagged-
 * error taxonomy and the bounded `Result` string-literal union used as a
 * metric attribute. It's pure, so tests are fast and table-driven.
 *
 * These tests lock the classification contract: if an error message
 * keyword moves and causes everything to collapse to `"error"`, dashboards
 * silently go blank. This file is the tripwire.
 */

class RateLimited extends Data.TaggedError("RateLimited")<{ message?: string }> {}
class NotFoundError extends Data.TaggedError("NotFoundError")<{ message?: string }> {}
class ValidationError extends Data.TaggedError("ValidationError")<{ cause?: unknown }> {}
class EventNotFound extends Data.TaggedError("EventNotFound")<{ id: string }> {}
class RandomTag extends Data.TaggedError("SomeUnknownTag")<{ message: string }> {}

describe("classifyError", () => {
  describe("effect tagged errors", () => {
    it.each([
      [new RateLimited({ message: "slow down" }), "rate_limited"],
      [new NotFoundError({ message: "missing" }), "not_found"],
      [new EventNotFound({ id: "evt_1" }), "not_found"],
      [new ValidationError({ cause: "bad shape" }), "validation_error"],
    ])("maps %o → %s", (err, expected) => {
      expect(classifyError(err)).toBe(expected);
    });
  });

  describe("plain Error messages", () => {
    it.each([
      [new Error("rate limit exceeded"), "rate_limited"],
      [new Error("user not found"), "not_found"],
      [new Error("no such row"), "not_found"],
      [new Error("forbidden"), "forbidden"],
      [new Error("not authorised"), "forbidden"],
      [new Error("unauthorised access"), "unauthorized"],
      [new Error("invalid input"), "validation_error"],
      [new Error("validation failed"), "validation_error"],
      [new Error("email must be lowercase"), "validation_error"],
      [new Error("already exists"), "conflict"],
      [new Error("conflict detected"), "conflict"],
      [new Error("handle taken"), "conflict"],
    ])("maps %o → %s", (err, expected) => {
      expect(classifyError(err)).toBe(expected);
    });
  });

  describe("fallback", () => {
    it("returns 'error' for an unknown tag", () => {
      expect(classifyError(new RandomTag({ message: "eh" }))).toBe("error");
    });

    it("returns 'error' for an Error with no matching keyword", () => {
      expect(classifyError(new Error("something vaguely weird happened"))).toBe("error");
    });

    it("returns 'error' for non-object values", () => {
      expect(classifyError("a string")).toBe("error");
      expect(classifyError(42)).toBe("error");
      expect(classifyError(null)).toBe("error");
      expect(classifyError(undefined)).toBe("error");
    });

    it("returns 'error' for an empty object", () => {
      expect(classifyError({})).toBe("error");
    });
  });
});

describe("OSN_METRICS naming", () => {
  it("all names follow the osn.* lowercase dotted convention", () => {
    const nameRe = /^osn\.[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
    for (const name of Object.values(OSN_METRICS)) {
      expect(name, `${name} does not match ${nameRe}`).toMatch(nameRe);
    }
  });

  it("every key in OSN_METRICS is unique", () => {
    const values = Object.values(OSN_METRICS);
    expect(new Set(values).size).toBe(values.length);
  });
});
