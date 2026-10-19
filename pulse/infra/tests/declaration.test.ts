import { StageNotDeclaredError, stageHosts } from "@shared/infra";
import { describe, expect, test } from "vitest";

import { pulseDeclaration } from "../src/declaration";

describe("pulseDeclaration", () => {
  test("K8: a production stage throws, naming the phase that declares it", () => {
    const declare = () =>
      pulseDeclaration({ stage: "production", hosts: stageHosts("example.test", "dev") });
    expect(declare).toThrow(StageNotDeclaredError);
    expect(declare).toThrow(/P3/);
  });
});
