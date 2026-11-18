import { describe, expect, test } from "vitest";

import {
  assertRetained,
  assertStackRetained,
  removalFor,
  UnretainedResourceError,
} from "../src/removal";

describe("removalFor", () => {
  test("storage is always retained", () => {
    for (const stage of ["dev", "production", "pr-7"])
      expect(removalFor("storage", stage)).toBe("retain");
  });
});

describe("assertRetained", () => {
  test("names every resource that would be deleted", () => {
    let caught: unknown;
    try {
      assertRetained([
        { LogicalId: "CireDb", RemovalPolicy: "destroy" },
        { LogicalId: "CireSheets", RemovalPolicy: "retain" },
        { LogicalId: "CireApi", RemovalPolicy: "destroy" },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnretainedResourceError);
    expect((caught as UnretainedResourceError).logicalIds).toEqual(["CireDb", "CireApi"]);
    expect((caught as Error).message).toContain("CireDb, CireApi");
  });
});

describe("assertStackRetained", () => {
  test("B9: asserts storage on every stage, and Workers only where the stage keeps them", () => {
    const db = { LogicalId: "CireDb", RemovalPolicy: "retain" };
    const lostDb = { LogicalId: "CireDb", RemovalPolicy: "destroy" };
    const keptApi = { LogicalId: "CireApi", RemovalPolicy: "retain" };
    const goneApi = { LogicalId: "CireApi", RemovalPolicy: "destroy" };

    expect(() =>
      assertStackRetained({ stage: "dev", storage: [db], workers: [keptApi] }),
    ).not.toThrow();
    expect(() => assertStackRetained({ stage: "dev", storage: [db], workers: [goneApi] })).toThrow(
      /CireApi/,
    );
    expect(() =>
      assertStackRetained({ stage: "production", storage: [db], workers: [goneApi] }),
    ).toThrow(UnretainedResourceError);

    expect(() =>
      assertStackRetained({ stage: "pr-7", storage: [db], workers: [goneApi] }),
    ).not.toThrow();
    expect(() =>
      assertStackRetained({ stage: "pr-7", storage: [lostDb], workers: [goneApi] }),
    ).toThrow(/CireDb/);
  });
});
