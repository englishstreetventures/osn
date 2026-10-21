import { describe, expect, it } from "vitest";

import { formatTopic, isFallbackOutcome, isSignal, parseTopic } from "../src/protocol";

describe("parseTopic", () => {
  it("splits a well-formed topic of a known product", () => {
    expect(parseTopic("cire:wedding:wed_0a1b")).toEqual({
      product: "cire",
      entity: "wedding",
      id: "wed_0a1b",
    });
  });

  it.each([
    ["an unknown product", "pulse:event:evt_1"],
    ["a product that has not adopted realtime", "osn:org:org_1"],
    ["an uppercase product", "CIRE:wedding:wed_1"],
    ["an uppercase entity", "cire:Wedding:wed_1"],
    ["a 33-character entity", `cire:${"e".repeat(33)}:wed_1`],
    ["an empty id", "cire:wedding:"],
    ["a fourth segment", "cire:wedding:wed_1:x"],
    ["a 65-character id", `cire:wedding:${"a".repeat(65)}`],
    ["a percent-encoded colon", "cire%3Awedding%3Awed_1"],
    ["a space in the id", "cire:wedding:wed 1"],
    ["an empty string", ""],
  ])("refuses %s", (_label, topic) => {
    expect(parseTopic(topic)).toBeNull();
  });

  it("accepts an id of exactly 64 characters and an entity of exactly 32", () => {
    expect(parseTopic(`cire:wedding:${"a".repeat(64)}`)?.id).toHaveLength(64);
    expect(parseTopic(`cire:${"e".repeat(32)}:wed_1`)?.entity).toHaveLength(32);
  });
});

describe("formatTopic", () => {
  it("builds a topic that parses back to its parts", () => {
    expect(formatTopic("cire", "wedding", "wed_1")).toBe("cire:wedding:wed_1");
  });

  it("returns null when the parts cannot form a topic", () => {
    expect(formatTopic("cire", "wedding", "")).toBeNull();
    expect(formatTopic("cire", "wedding", "has:colon")).toBeNull();
  });
});

describe("isSignal", () => {
  const good = { topic: "cire:wedding:wed_1", kind: "members-changed", at: 1_700_000_000_000 };

  it.each(["members-changed", "tasks-changed"])("accepts a well-formed %s signal", (kind) => {
    expect(isSignal({ ...good, kind })).toBe(true);
  });

  it.each([
    ["null", null],
    ["a string", "members-changed"],
    ["a malformed topic", { ...good, topic: "nope" }],
    ["a missing at", { topic: good.topic, kind: good.kind }],
    ["a non-finite at", { ...good, at: Number.NaN }],
    // A client older than a kind drops it rather than reading it as another.
    ["a kind this build does not know", { ...good, kind: "rows-changed" }],
  ])("refuses %s", (_label, value) => {
    expect(isSignal(value)).toBe(false);
  });
});

describe("isFallbackOutcome", () => {
  it.each(["refused", "exhausted"])("accepts %s", (value) => {
    expect(isFallbackOutcome(value)).toBe(true);
  });

  it.each([
    ["the client's stopped signal", "stopped"],
    ["a capitalised outcome", "Refused"],
    ["an outcome with surrounding whitespace", " refused"],
    ["an empty string", ""],
    ["null", null],
    ["a number", 1008],
    ["an object", { outcome: "refused" }],
  ])("refuses %s", (_label, value) => {
    expect(isFallbackOutcome(value)).toBe(false);
  });
});
