import { describe, it, expect } from "bun:test";

import { buildGrants } from "./grant-entitlement";

describe("buildGrants", () => {
  it("maps requested keys to comp grants for the wedding", () => {
    const grants = buildGrants("wed_vr", ["vendors", "capacity_1000"], "usr_owner");
    expect(grants).toEqual([
      { key: "vendors", opts: { source: "comp", grantedBy: "usr_owner" } },
      { key: "capacity_1000", opts: { source: "comp", grantedBy: "usr_owner" } },
    ]);
  });
  it("rejects an unknown key", () => {
    expect(() => buildGrants("wed_vr", ["bogus" as never], "x")).toThrow();
  });

  // S-M1: validate operator-supplied CLI args before SQL interpolation
  it("rejects a malicious weddingId containing SQL injection payload", () => {
    expect(() => buildGrants("wed_'; DROP TABLE x;--", ["vendors"], "operator")).toThrow(
      "invalid weddingId",
    );
  });
  it("rejects a weddingId that does not start with wed_", () => {
    expect(() => buildGrants("evil_abc", ["vendors"], "operator")).toThrow("invalid weddingId");
  });
  it("rejects a malicious grantedBy containing SQL injection payload", () => {
    expect(() => buildGrants("wed_abc", ["vendors"], "usr'; DROP TABLE x;--")).toThrow(
      "invalid grantedBy",
    );
  });
  it("rejects a grantedBy with spaces or special characters", () => {
    expect(() => buildGrants("wed_abc", ["vendors"], "usr owner@example.com")).toThrow(
      "invalid grantedBy",
    );
  });
  it("accepts valid weddingId and grantedBy with alphanumeric and underscores", () => {
    expect(() => buildGrants("wed_abc123", ["vendors"], "usr_owner_1")).not.toThrow();
  });
});
