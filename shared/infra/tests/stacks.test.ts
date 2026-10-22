import { describe, expect, test } from "vitest";

import { SECRET_INVENTORY } from "../src/secrets/inventory";
import { STACK_KEYS, STACK_STEP_SECRETS, STACK_WORKERS } from "../src/stacks";

describe("the stack map", () => {
  test("every inventory Worker is deployed by exactly one stack", () => {
    const deployed = STACK_KEYS.flatMap((stack) => STACK_WORKERS[stack]).toSorted();
    expect(deployed).toEqual(SECRET_INVENTORY.map((entry) => entry.worker).toSorted());
  });

  test("every secret a stack job reads for itself is a dev inventory secret", () => {
    const dev = new Set(
      SECRET_INVENTORY.flatMap((entry) => entry.tiers.dev.secrets.concat(entry.tiers.dev.optional)),
    );
    const read = STACK_KEYS.flatMap((stack) =>
      STACK_STEP_SECRETS[stack].map((entry) => entry.name),
    );
    expect(read.filter((name) => !dev.has(name))).toEqual([]);
  });
});
