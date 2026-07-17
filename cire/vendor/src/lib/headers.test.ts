import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("_headers", () => {
  const path = fileURLToPath(new URL("../../public/_headers", import.meta.url));
  const contents = readFileSync(path, "utf8");

  it("/* block sets the platform security baseline headers", () => {
    // Split on rule blocks so we can test the wildcard rule independently.
    const wildcardBlock = contents.split(/\n\/claim\*/)[0]!;
    expect(wildcardBlock).toMatch(/Referrer-Policy:\s*strict-origin-when-cross-origin/);
    expect(wildcardBlock).toMatch(/X-Content-Type-Options:\s*nosniff/);
    expect(wildcardBlock).toMatch(/Content-Security-Policy:\s*frame-ancestors 'none'/);
    expect(wildcardBlock).toMatch(/Permissions-Policy:\s*camera=\(\)/);
  });

  it("/claim* rule overrides Referrer-Policy to no-referrer", () => {
    // Find the /claim* section.
    const claimMatch = contents.match(/\/claim\*[\s\S]+?(?:\n\n|$)/);
    expect(claimMatch).not.toBeNull();
    expect(claimMatch![0]).toMatch(/Referrer-Policy:\s*no-referrer/);
  });
});
