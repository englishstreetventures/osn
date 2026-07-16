import { describe, expect, it } from "bun:test";

import { Effect, Schema } from "effect";

import { isServiceCategory, SERVICE_CATEGORY_KEYS } from "../lib/service-categories";
import {
  CreateBudgetItemBody,
  CreatePaymentBody,
  ReorderBudgetItemsBody,
  SetBudgetTotalBody,
  UpdateBudgetItemBody,
  UpdatePaymentBody,
} from "./budget";

const decode = <A, I>(s: Schema.Schema<A, I>, v: unknown) =>
  Effect.runSync(Effect.either(Schema.decodeUnknown(s)(v)));

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
    expect(r._tag).toBe("Right");
    if (r._tag === "Right") {
      expect(r.right.estimateMinor).toBeNull();
      expect(r.right.quotedMinor).toBeNull();
      expect(r.right.actualMinor).toBeNull();
      expect(r.right.notes).toBeNull();
    }
  });

  it("rejects an unknown category", () => {
    expect(decode(CreateBudgetItemBody, { category: "spaceship", name: "x" })._tag).toBe("Left");
  });

  it("rejects an empty name", () => {
    expect(decode(CreateBudgetItemBody, { category: "venue", name: "" })._tag).toBe("Left");
  });

  it("rejects a negative amount", () => {
    expect(
      decode(CreateBudgetItemBody, { category: "venue", name: "x", estimateMinor: -1 })._tag,
    ).toBe("Left");
  });

  it("rejects a fractional amount (minor units are integers)", () => {
    expect(
      decode(CreateBudgetItemBody, { category: "venue", name: "x", estimateMinor: 10.5 })._tag,
    ).toBe("Left");
  });
});

describe("UpdateBudgetItemBody", () => {
  it("accepts a partial money patch with an explicit null clear", () => {
    expect(decode(UpdateBudgetItemBody, { actualMinor: null })._tag).toBe("Right");
  });
});

describe("ReorderBudgetItemsBody", () => {
  it("accepts a category + ordered ids", () => {
    expect(
      decode(ReorderBudgetItemsBody, { category: "catering", orderedIds: ["a", "b"] })._tag,
    ).toBe("Right");
  });
});

describe("CreatePaymentBody", () => {
  it("accepts a label + amount, defaults dueAt to null", () => {
    const r = decode(CreatePaymentBody, { label: "Deposit", amountMinor: 250000 });
    expect(r._tag).toBe("Right");
    if (r._tag === "Right") expect(r.right.dueAt).toBeNull();
  });

  it("rejects a missing amount", () => {
    expect(decode(CreatePaymentBody, { label: "Deposit" })._tag).toBe("Left");
  });
});

describe("UpdatePaymentBody", () => {
  it("accepts a paid toggle", () => {
    expect(decode(UpdatePaymentBody, { paid: true })._tag).toBe("Right");
  });
});

describe("SetBudgetTotalBody", () => {
  it("accepts a number or null", () => {
    expect(decode(SetBudgetTotalBody, { budgetTotalMinor: 4_500_000 })._tag).toBe("Right");
    expect(decode(SetBudgetTotalBody, { budgetTotalMinor: null })._tag).toBe("Right");
  });

  it("rejects a negative total", () => {
    expect(decode(SetBudgetTotalBody, { budgetTotalMinor: -1 })._tag).toBe("Left");
  });
});
