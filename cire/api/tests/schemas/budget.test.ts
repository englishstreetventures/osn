import { describe, expect, it } from "bun:test";

import { Effect, Schema } from "effect";

import { isServiceCategory, SERVICE_CATEGORY_KEYS } from "../../src/lib/service-categories";
import {
  CreateBudgetItemBody,
  CreatePaymentBody,
  ReorderBudgetItemsBody,
  SetBudgetTotalBody,
  UpdateBudgetItemBody,
  UpdatePaymentBody,
} from "../../src/schemas/budget";

const decode = <A, I>(s: Schema.Codec<A, I>, v: unknown) =>
  Effect.runSync(Effect.result(Schema.decodeUnknownEffect(s)(v)));

describe("service categories", () => {
  it("has the fourteen ordered keys ending in 'other'", () => {
    expect(SERVICE_CATEGORY_KEYS).toEqual([
      "venue",
      "catering",
      "photography",
      "videography",
      "decor_styling",
      "florals",
      "music_entertainment",
      "celebrant",
      "cake",
      "stationery",
      "hair_makeup",
      "transport",
      "attire",
      "other",
    ]);
  });

  it("recognises valid + rejects unknown categories", () => {
    expect(isServiceCategory("catering")).toBe(true);
    expect(isServiceCategory("catering_extra")).toBe(false);
  });
});

describe("CreateBudgetItemBody", () => {
  it("accepts a category + name, defaults money + notes to null", () => {
    const r = decode(CreateBudgetItemBody, { category: "venue", name: "Reception venue" });
    expect(r._tag).toBe("Success");
    if (r._tag === "Success") {
      expect(r.success.estimateMinor).toBeNull();
      expect(r.success.quotedMinor).toBeNull();
      expect(r.success.actualMinor).toBeNull();
      expect(r.success.notes).toBeNull();
    }
  });

  it("rejects an unknown category", () => {
    expect(decode(CreateBudgetItemBody, { category: "spaceship", name: "x" })._tag).toBe("Failure");
  });

  it("rejects an empty name", () => {
    expect(decode(CreateBudgetItemBody, { category: "venue", name: "" })._tag).toBe("Failure");
  });

  it("rejects a negative amount", () => {
    expect(
      decode(CreateBudgetItemBody, { category: "venue", name: "x", estimateMinor: -1 })._tag,
    ).toBe("Failure");
  });

  it("rejects a fractional amount (minor units are integers)", () => {
    expect(
      decode(CreateBudgetItemBody, { category: "venue", name: "x", estimateMinor: 10.5 })._tag,
    ).toBe("Failure");
  });
});

describe("UpdateBudgetItemBody", () => {
  it("accepts a partial money patch with an explicit null clear", () => {
    expect(decode(UpdateBudgetItemBody, { actualMinor: null })._tag).toBe("Success");
  });
});

describe("ReorderBudgetItemsBody", () => {
  it("accepts a category + ordered ids", () => {
    expect(
      decode(ReorderBudgetItemsBody, { category: "catering", orderedIds: ["a", "b"] })._tag,
    ).toBe("Success");
  });
});

describe("CreatePaymentBody", () => {
  it("accepts a label + amount, defaults dueAt to null", () => {
    const r = decode(CreatePaymentBody, { label: "Deposit", amountMinor: 250000 });
    expect(r._tag).toBe("Success");
    if (r._tag === "Success") expect(r.success.dueAt).toBeNull();
  });

  it("rejects a missing amount", () => {
    expect(decode(CreatePaymentBody, { label: "Deposit" })._tag).toBe("Failure");
  });
});

describe("UpdatePaymentBody", () => {
  it("accepts a paid toggle", () => {
    expect(decode(UpdatePaymentBody, { paid: true })._tag).toBe("Success");
  });
});

describe("SetBudgetTotalBody", () => {
  it("accepts a number or null", () => {
    expect(decode(SetBudgetTotalBody, { budgetTotalMinor: 4_500_000 })._tag).toBe("Success");
    expect(decode(SetBudgetTotalBody, { budgetTotalMinor: null })._tag).toBe("Success");
  });

  it("rejects a negative total", () => {
    expect(decode(SetBudgetTotalBody, { budgetTotalMinor: -1 })._tag).toBe("Failure");
  });
});

describe("per-head bodies", () => {
  const create = (perHead: unknown, extra: Record<string, unknown> = {}) =>
    decode(CreateBudgetItemBody, { category: "catering", name: "Dinner", perHead, ...extra });
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `evt_${i}`);

  it("defaults an absent perHead to null", () => {
    const r = decode(CreateBudgetItemBody, { category: "catering", name: "Dinner" });
    expect(r._tag).toBe("Success");
    if (r._tag === "Success") expect(r.success.perHead).toBeNull();
  });

  // The ownership check binds every id in one IN (...), and D1 allows 100 bound
  // parameters per query; bun:sqlite allows far more, so only this test holds the cap.
  it("takes 1 to 50 event ids, and null or absent for every event", () => {
    expect(create({ unitPriceMinor: 1, eventIds: ids(50) })._tag).toBe("Success");
    expect(create({ unitPriceMinor: 1, eventIds: ids(51) })._tag).toBe("Failure");
    expect(create({ unitPriceMinor: 1, eventIds: [] })._tag).toBe("Failure");
    expect(create({ unitPriceMinor: 1, eventIds: null })._tag).toBe("Success");
    expect(create({ unitPriceMinor: 1 })._tag).toBe("Success");
  });

  it("rejects an empty or oversized event id", () => {
    expect(create({ unitPriceMinor: 1, eventIds: [""] })._tag).toBe("Failure");
    expect(create({ unitPriceMinor: 1, eventIds: ["e".repeat(64)] })._tag).toBe("Success");
    expect(create({ unitPriceMinor: 1, eventIds: ["e".repeat(65)] })._tag).toBe("Failure");
  });

  // The ceiling keeps price x headcount far inside Number.MAX_SAFE_INTEGER.
  it("caps the price per head at the budget total's ceiling", () => {
    expect(create({ unitPriceMinor: 100_000_000_000 })._tag).toBe("Success");
    expect(create({ unitPriceMinor: 100_000_000_001 })._tag).toBe("Failure");
    expect(create({ unitPriceMinor: 0 })._tag).toBe("Success");
  });

  it("refuses a fixed estimate beside a per-head setting, and allows one when turning it off", () => {
    expect(create({ unitPriceMinor: 1 }, { estimateMinor: 500 })._tag).toBe("Failure");
    expect(create({ unitPriceMinor: 1 }, { estimateMinor: null })._tag).toBe("Success");
    expect(
      decode(UpdateBudgetItemBody, { perHead: { unitPriceMinor: 1 }, estimateMinor: 500 })._tag,
    ).toBe("Failure");
    expect(decode(UpdateBudgetItemBody, { perHead: null, estimateMinor: 500 })._tag).toBe(
      "Success",
    );
  });
});
