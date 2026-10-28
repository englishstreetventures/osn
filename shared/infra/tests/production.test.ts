import { describe, expect, test } from "vitest";

import {
  assertProductionScope,
  ProductionNotAdoptedError,
  ProductionScopeError,
  refuseUnadopted,
} from "../src/production";

describe("refuseUnadopted", () => {
  test("refuses a production resource no step has adopted, and passes an adopted one or any other stage", () => {
    expect(() => refuseUnadopted("cire-db", "production")).toThrow(ProductionNotAdoptedError);
    expect(() => refuseUnadopted("cire-db", "production")).toThrow(/PRODUCTION_ADOPTIONS/);
    expect(() => refuseUnadopted("cire-db", "production", ["cire-db"])).not.toThrow();
    expect(() => refuseUnadopted("cire-db", "production", ["cire-db-dev"])).toThrow(
      ProductionNotAdoptedError,
    );
    for (const stage of ["dev", "pr-7"])
      expect(() => refuseUnadopted("cire-db", stage)).not.toThrow();
  });
});

describe("assertProductionScope", () => {
  const resources = [{ LogicalId: "CireHost" }, { LogicalId: "CireApi" }, { LogicalId: "CireDb" }];

  test("SC1: refuses a production resource outside the allowed ids, naming each", () => {
    const run = () =>
      assertProductionScope({ stage: "production", resources, allowed: ["CireHost"] });
    expect(run).toThrow(ProductionScopeError);
    expect(run).toThrow(expect.objectContaining({ logicalIds: ["CireApi", "CireDb"] }));
    expect(() =>
      assertProductionScope({
        stage: "production",
        resources,
        allowed: ["CireHost", "CireApi", "CireDb"],
      }),
    ).not.toThrow();
  });

  test("SC1: a dev or investigation stage declares what it likes", () => {
    for (const stage of ["dev", "pr-7"]) {
      expect(() => assertProductionScope({ stage, resources, allowed: [] })).not.toThrow();
    }
  });
});
