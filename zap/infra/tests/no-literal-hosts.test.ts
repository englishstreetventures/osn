import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { stackLiteralHosts } from "../../../shared/infra/tests/support/literal-hosts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

describe("zap stack source", () => {
  test("K7: holds no literal host; every host derives from DEV_DOMAIN", () => {
    expect(stackLiteralHosts(packageDir)).toEqual([]);
  });
});
