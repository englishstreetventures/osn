import { StageNotDeclaredError, stageHosts } from "@shared/infra";
import { describe, expect, test } from "vitest";

import { cireDeclaration } from "../src/declaration";

describe("cireDeclaration", () => {
  test("K8: a production stage throws, naming the phase that declares it", () => {
    const declare = () =>
      cireDeclaration({
        stage: "production",
        hosts: stageHosts("example.test", "dev"),
        generatedDir: ".generated",
        ownerSeat: false,
      });
    expect(declare).toThrow(StageNotDeclaredError);
    expect(declare).toThrow(/P3/);
  });
});
