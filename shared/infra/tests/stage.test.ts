import { describe, expect, test } from "vitest";

import { InvalidStageError, parseStage, physicalName, tierOf } from "../src/stage";

// Live names (Cloudflare D1 list, 2026-10-15): the two naming shapes in use today.
const OSN_DB = { base: "osn-db", dev: "osn-db-dev", production: "osn-db-prod" };
const CIRE_DB = { base: "cire-db", dev: "cire-db-dev", production: "cire-db" };

describe("parseStage", () => {
  test.each(["dev", "production", "pr-1512", "alice", "a1-b2"])("accepts %j", (stage) => {
    expect(parseStage(stage)).toBe(stage);
  });

  test.each([
    "",
    "Prod",
    "pr_1",
    "-pr",
    "pr-",
    "pr--1",
    "1pr",
    "a".repeat(21),
    "prod",
    "staging",
    "local",
  ])("refuses %j", (stage) => {
    expect(() => parseStage(stage)).toThrow(InvalidStageError);
  });
});

describe("tierOf", () => {
  test("only the stage named production is production", () => {
    expect(tierOf("production")).toBe("production");
    expect(tierOf("dev")).toBe("dev");
    expect(tierOf("pr-7")).toBe("dev");
  });

  test("refuses a stage that only resembles production", () => {
    expect(() => tierOf("Production")).toThrow(InvalidStageError);
    expect(() => tierOf("prod")).toThrow(InvalidStageError);
  });
});

describe("physicalName", () => {
  test("dev and production keep today's names", () => {
    expect(physicalName(OSN_DB, "dev")).toBe("osn-db-dev");
    expect(physicalName(OSN_DB, "production")).toBe("osn-db-prod");
    expect(physicalName(CIRE_DB, "production")).toBe("cire-db");
  });

  test("an investigation stage extends the base", () => {
    expect(physicalName(CIRE_DB, "pr-7")).toBe("cire-db-pr-7");
  });

  test("refuses a derived name equal to a dev or production one", () => {
    expect(() => physicalName({ base: "site", dev: "site-qa", production: "site" }, "qa")).toThrow(
      /dev or production name/,
    );
  });

  test("refuses a derived name over 63 characters", () => {
    expect(() =>
      physicalName({ base: "b".repeat(50), dev: "x", production: "y" }, "investigation-12345"),
    ).toThrow(/63/);
  });
});
