import { StageNotDeclaredError, stageHosts } from "@shared/infra";
import { describe, expect, test } from "vitest";

import { zapDeclaration } from "../src/declaration";

describe("zapDeclaration", () => {
  test("K8: a production stage throws, naming the phase that declares it", () => {
    const declare = () =>
      zapDeclaration({
        stage: "production",
        hosts: stageHosts("example.test", "dev"),
        generatedDir: ".generated",
      });
    expect(declare).toThrow(StageNotDeclaredError);
    expect(declare).toThrow(/P3/);
  });
});
