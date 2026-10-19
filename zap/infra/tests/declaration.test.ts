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
  test("K11: no Worker serves version preview URLs, each a public workers.dev host outside Access", () => {
    for (const stage of ["dev", "pr-7"]) {
      const workers = Object.values(
        zapDeclaration({
          stage,
          hosts: stageHosts("example.test", stage),
          generatedDir: ".generated",
        }),
      ).filter(
        (value): value is { readonly name: string; readonly previewUrls: boolean } =>
          typeof value === "object" && value !== null && "workersDev" in value,
      );
      expect(workers.length).toBeGreaterThan(0);
      for (const worker of workers)
        expect({ [worker.name]: worker.previewUrls }).toEqual({ [worker.name]: false });
    }
  });
});
