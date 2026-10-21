import { describe, expect, test } from "vitest";

describe("@shared/infra entry", () => {
  test("loads with the pinned Alchemy and exposes the building blocks", async () => {
    const infra = await import("../src/index");
    for (const name of [
      "apiWorker",
      "siteWorker",
      "retainedD1",
      "retainedBucket",
      "requireSecrets",
      "stackOptions",
      "accountSecrets",
      "assertRetained",
      "physicalName",
      "tierOf",
    ] as const) {
      expect(typeof infra[name], `${name}`).toBe("function");
    }
  });
});
