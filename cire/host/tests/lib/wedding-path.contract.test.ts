import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The wedding id stays inside its own path segment only if every organiser API
 * path is built by `weddingPath`, which percent-encodes it. Component tests use
 * ids such as `wed_1`, where an encoded and a raw path are the same string, so
 * a view that interpolated the id by hand would pass all of them. This scans
 * the source for the hand-built form instead.
 */
describe("organiser API paths", () => {
  it("interpolate a wedding id only inside weddingPath", () => {
    const src = fileURLToPath(new URL("../../src", import.meta.url));
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) =>
      /\.(ts|tsx)$/.test(f),
    );
    const offenders = files
      .filter((f) => f !== join("lib", "api.ts"))
      .filter((f) => readFileSync(join(src, f), "utf8").includes("/api/organiser/weddings/${"));
    expect(offenders).toEqual([]);
  });
});
