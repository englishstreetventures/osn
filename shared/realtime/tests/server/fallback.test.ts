import { Effect, Logger, type LogLevel } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { metricClientFallback } = vi.hoisted(() => ({ metricClientFallback: vi.fn() }));
vi.mock("../../src/server/metrics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/metrics")>()),
  metricClientFallback,
}));

import {
  MAX_FALLBACK_BEACON_BYTES,
  readFallbackOutcome,
  recordClientFallback,
} from "../../src/server";

beforeEach(() => metricClientFallback.mockReset());

/** Every log line the effect writes, with its level and its message parts. */
function captureLogs() {
  const lines: { level: LogLevel.LogLevel; message: unknown }[] = [];
  const layer = Logger.layer([
    Logger.make(({ logLevel, message }) => {
      lines.push({ level: logLevel, message });
    }),
  ]);
  return { lines, layer };
}

describe("MAX_FALLBACK_BEACON_BYTES", () => {
  it("pins the largest beacon body a product route reads", () => {
    expect(MAX_FALLBACK_BEACON_BYTES).toBe(64);
  });
});

describe("readFallbackOutcome", () => {
  it.each([
    ["refused", "refused"],
    ["exhausted", "exhausted"],
    ["refused\n", "refused"],
    ["  exhausted \r\n", "exhausted"],
  ])("reads %j as %s", (body, outcome) => {
    expect(readFallbackOutcome(body)).toBe(outcome);
  });

  it.each([
    ["an empty body", ""],
    ["whitespace alone", " \n"],
    ["a capitalised outcome", "Refused"],
    ["the client's stopped signal", "stopped"],
    ["JSON", '{"outcome":"refused"}'],
    ["a 65-character body that starts with an outcome", `refused${"x".repeat(58)}`],
    ["two outcomes", "refused exhausted"],
  ])("refuses %s", (_label, body) => {
    expect(readFallbackOutcome(body)).toBeNull();
  });
});

describe("recordClientFallback", () => {
  it.each(["refused", "exhausted"] as const)(
    "counts a %s fallback for the product and succeeds",
    async (outcome) => {
      await expect(
        Effect.runPromise(recordClientFallback("cire", outcome)),
      ).resolves.toBeUndefined();
      expect(metricClientFallback.mock.calls).toEqual([["cire", outcome]]);
    },
  );

  it("logs a warning naming only the product and the outcome", async () => {
    const { lines, layer } = captureLogs();
    await Effect.runPromise(recordClientFallback("cire", "refused").pipe(Effect.provide(layer)));
    expect(lines).toEqual([
      {
        level: "Warn",
        message: ["realtime client fell back", { product: "cire", outcome: "refused" }],
      },
    ]);
  });
});
