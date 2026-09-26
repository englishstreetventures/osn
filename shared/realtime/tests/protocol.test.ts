import { describe, expect, it } from "vitest";

import {
  CLOSE_CODES,
  formatTopic,
  isSignal,
  parseTopic,
  PING,
  PONG,
  REALTIME_PRODUCTS,
  SIGNAL_KINDS,
} from "../src/protocol";

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

  it("accepts a well-formed signal", () => {
    expect(isSignal(good)).toBe(true);
  });

  it.each([
    ["null", null],
    ["a string", "members-changed"],
    ["an unknown kind", { ...good, kind: "rows-changed" }],
    ["a malformed topic", { ...good, topic: "nope" }],
    ["a missing at", { topic: good.topic, kind: good.kind }],
    ["a non-finite at", { ...good, at: Number.NaN }],
  ])("refuses %s", (_label, value) => {
    expect(isSignal(value)).toBe(false);
  });
});

describe("wire constants", () => {
  it("pins the frames and close codes both ends agree on", () => {
    expect([PING, PONG]).toEqual(["ping", "pong"]);
    expect(CLOSE_CODES).toEqual({ policy: 1008, evicted: 4001, stale: 4002 });
    expect(REALTIME_PRODUCTS).toEqual(["cire"]);
    expect(SIGNAL_KINDS).toEqual(["members-changed"]);
  });
});
