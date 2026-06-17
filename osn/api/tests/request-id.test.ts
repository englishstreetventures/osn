import { describe, it, expect } from "vitest";

import { REQUEST_ID_RE, resolveRequestId } from "../src/index";

/**
 * T-S2 — `resolveRequestId` / `REQUEST_ID_RE` (S-H3).
 *
 * The Workers entry re-applies the x-request-id sanitization the omitted
 * observability plugin used to do: echo a client-supplied id ONLY when it
 * matches the strict format, otherwise mint a fresh one. A client-controlled
 * value must never be echoed back untouched (log / header / terminal
 * injection). These tests exercise the three branches directly.
 */

const withId = (id: string): Request =>
  new Request("https://api.osn.test/", { headers: { "x-request-id": id } });

const MINTED_RE = /^req_[0-9a-f]{32}$/;

describe("REQUEST_ID_RE", () => {
  it("matches well-formed ids (alnum, underscore, dot, dash, 1..64 chars)", () => {
    expect(REQUEST_ID_RE.test("abc")).toBe(true);
    expect(REQUEST_ID_RE.test("A1_b.2-c")).toBe(true);
    expect(REQUEST_ID_RE.test("x")).toBe(true);
    expect(REQUEST_ID_RE.test("a".repeat(64))).toBe(true);
  });

  it("rejects empty, over-long, and ids with disallowed characters", () => {
    expect(REQUEST_ID_RE.test("")).toBe(false);
    expect(REQUEST_ID_RE.test("a".repeat(65))).toBe(false);
    expect(REQUEST_ID_RE.test("has space")).toBe(false);
    expect(REQUEST_ID_RE.test("has\nnewline")).toBe(false);
    expect(REQUEST_ID_RE.test("has\ttab")).toBe(false);
    expect(REQUEST_ID_RE.test("has\x00null")).toBe(false);
    expect(REQUEST_ID_RE.test("colon:not/allowed")).toBe(false);
  });
});

describe("resolveRequestId (S-H3)", () => {
  it("echoes a valid client-supplied id verbatim", () => {
    const id = "req_clientSupplied-123.OK";
    expect(REQUEST_ID_RE.test(id)).toBe(true);
    expect(resolveRequestId(withId(id))).toBe(id);
  });

  it("echoes a max-length (64-char) valid id verbatim", () => {
    const id = "a".repeat(64);
    expect(resolveRequestId(withId(id))).toBe(id);
  });

  it("mints a fresh id when the header is absent", () => {
    const out = resolveRequestId(new Request("https://api.osn.test/"));
    expect(out).toMatch(MINTED_RE);
  });

  it("mints a fresh id when the supplied id contains spaces", () => {
    const out = resolveRequestId(withId("evil value"));
    expect(out).toMatch(MINTED_RE);
    expect(out).not.toContain(" ");
  });

  it("mints a fresh id when the supplied id is over 64 chars", () => {
    const out = resolveRequestId(withId("a".repeat(65)));
    expect(out).toMatch(MINTED_RE);
  });

  it("mints a fresh id when the supplied id contains disallowed punctuation", () => {
    // Control chars / newlines are rejected by the Headers constructor itself,
    // so the header-bearing path can't carry them — the regex-level rejection of
    // those is asserted in the REQUEST_ID_RE block above. Here we use a value
    // the Headers API accepts but the strict format rejects.
    const out = resolveRequestId(withId("path/with:colon"));
    expect(out).toMatch(MINTED_RE);
  });

  it("mints a fresh id when the supplied id is empty", () => {
    const out = resolveRequestId(withId(""));
    expect(out).toMatch(MINTED_RE);
  });

  it("mints unique ids across calls", () => {
    const a = resolveRequestId(new Request("https://api.osn.test/"));
    const b = resolveRequestId(new Request("https://api.osn.test/"));
    expect(a).not.toBe(b);
  });
});
