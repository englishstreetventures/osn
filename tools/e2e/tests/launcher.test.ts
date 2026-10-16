import { describe, expect, test } from "bun:test";

import { clockReaches } from "../src/launcher";
import { baseEnv } from "../src/stack";

// The clock reaching both runtimes is what keeps the seeded RSVP deadline open
// and "starts in the future" true on every run, whatever the real date.
describe("clockReaches", () => {
  test("both runtimes report the suite clock under the children's environment", () => {
    expect(clockReaches(baseEnv(process.env, Date.now()))).toEqual([]);
  });

  test("reports each runtime the clock did not reach", () => {
    const env = baseEnv(process.env, Date.now());
    delete env["E2E_CLOCK_T0"];
    const failures = clockReaches(env);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toStartWith("bun reported");
    expect(failures[1]).toStartWith("node reported");
  });
});
