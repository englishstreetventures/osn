import { describe, expect, test } from "vitest";

import {
  accountIdFrom,
  diffNames,
  formatDiffs,
  githubDiff,
  githubExpectations,
  liveDiff,
  liveExpectations,
  parseTierArgument,
  parseWranglerSecretList,
  redactAccountIds,
} from "../../src/secrets/compare";

describe("parseWranglerSecretList", () => {
  test("reads the names from `wrangler secret list --format json`", () => {
    const stdout = `[
  { "name": "INTERNAL_SERVICE_SECRET", "type": "secret_text" },
  { "name": "GROWTHBOOK_CLIENT_KEY", "type": "secret_text" }
]`;
    expect(parseWranglerSecretList(stdout)).toEqual([
      "GROWTHBOOK_CLIENT_KEY",
      "INTERNAL_SERVICE_SECRET",
    ]);
    expect(parseWranglerSecretList("[]")).toEqual([]);
  });

  test("refuses output it cannot read rather than reporting no secrets", () => {
    expect(() => parseWranglerSecretList("⛅️ wrangler 4.149.0")).toThrow(SyntaxError);
    expect(() => parseWranglerSecretList(`{"name":"X"}`)).toThrow(/array/);
    expect(() => parseWranglerSecretList(`[{"type":"secret_text"}]`)).toThrow(/name/);
  });
});

describe("diffNames", () => {
  test("reports missing and unexpected names, sorted", () => {
    expect(diffNames("w", ["A", "C", "B"], ["B", "D"])).toEqual({
      where: "w",
      missing: ["A", "C"],
      unexpected: ["D"],
      forbidden: [],
    });
  });

  test("an allowed optional name is neither missing when absent nor unexpected when present", () => {
    expect(diffNames("w", ["A"], ["A", "P"], ["P"])).toEqual({
      where: "w",
      missing: [],
      unexpected: [],
      forbidden: [],
    });
    expect(diffNames("w", ["A"], ["A"], ["P"])).toEqual({
      where: "w",
      missing: [],
      unexpected: [],
      forbidden: [],
    });
  });

  test("a held forbidden name is reported as forbidden, not as unexpected", () => {
    expect(diffNames("w", ["A"], ["A", "F"], [], ["F", "G"])).toEqual({
      where: "w",
      missing: [],
      unexpected: [],
      forbidden: ["F"],
    });
  });
});

describe("formatDiffs", () => {
  test("prints ok only for a clean diff, and names every kind of difference", () => {
    expect(
      formatDiffs([
        { where: "a", missing: [], unexpected: [], forbidden: [] },
        { where: "b", missing: ["M1", "M2"], unexpected: ["U"], forbidden: ["F"] },
        { where: "c", missing: [], unexpected: ["U"], forbidden: [] },
        { where: "d", missing: [], unexpected: [], forbidden: ["F"] },
      ]),
    ).toBe(
      [
        "ok    a",
        "DIFF  b — missing: M1, M2 — not in the inventory: U — forbidden but set: F",
        "DIFF  c — not in the inventory: U",
        "DIFF  d — forbidden but set: F",
        "",
      ].join("\n"),
    );
  });
});

describe("liveExpectations", () => {
  test("covers each tier's deployed Workers", () => {
    expect(
      liveExpectations("dev")
        .map((expectation) => expectation.scriptName)
        .toSorted(),
    ).toEqual(["cire-api-dev", "cire-invites-dev", "osn-api-dev", "zap-api-dev"]);
    expect(
      liveExpectations("production")
        .map((expectation) => expectation.scriptName)
        .toSorted(),
    ).toEqual(["cire-api-production", "cire-invites", "osn-api-production", "zap-api-production"]);
  });

  test("zap-api production as it is live today fails on the GrowthBook key it must not hold", () => {
    const zap = liveExpectations("production").find(
      (expectation) => expectation.worker === "zap-api",
    );
    if (zap === undefined) throw new Error("zap-api has no production expectation");
    expect(liveDiff(zap, ["GROWTHBOOK_CLIENT_KEY", "INTERNAL_SERVICE_SECRET"])).toEqual({
      where: "zap-api production (zap-api-production)",
      missing: [],
      unexpected: [],
      forbidden: ["GROWTHBOOK_CLIENT_KEY"],
    });
  });
});

describe("GitHub Environments", () => {
  test("expects each shared name once, and the tier's own account credentials", () => {
    expect(
      githubExpectations("production").filter((name) => name === "INTERNAL_SERVICE_SECRET"),
    ).toHaveLength(1);
    expect(githubExpectations("dev")).toEqual(
      expect.arrayContaining(["CLOUDFLARE_DEV_ACCOUNT_API_TOKEN", "CLOUDFLARE_DEV_ACCOUNT_ID"]),
    );
    expect(githubExpectations("production")).toEqual(
      expect.arrayContaining(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]),
    );
  });

  test("an Environment with a few Worker secrets misses the rest, and dev misses its account", () => {
    const dev = githubDiff("dev", ["DEV_LOGIN_SECRET"]);
    expect(dev.missing).toEqual(
      expect.arrayContaining(["CLOUDFLARE_DEV_ACCOUNT_API_TOKEN", "CLOUDFLARE_DEV_ACCOUNT_ID"]),
    );
    expect(dev.unexpected).toEqual([]);
    expect(dev.forbidden).toEqual([]);
    const production = githubDiff("production", [
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "OSN_TOTP_ENCRYPTION_KEY",
    ]);
    expect(production.unexpected).toEqual([]);
    expect(production.forbidden).toEqual([]);
  });

  test("an Environment holding the other tier's credential fails", () => {
    expect(githubDiff("dev", ["CLOUDFLARE_API_TOKEN"]).forbidden).toEqual(["CLOUDFLARE_API_TOKEN"]);
    expect(
      githubDiff("production", ["CLOUDFLARE_DEV_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN_DEV"]).forbidden,
    ).toEqual(["CLOUDFLARE_API_TOKEN_DEV", "CLOUDFLARE_DEV_ACCOUNT_ID"]);
  });

  test("reports a name that is neither a Worker secret nor one of the tier's credentials", () => {
    expect(githubDiff("dev", ["SOMETHING_ELSE"]).unexpected).toEqual(["SOMETHING_ELSE"]);
    expect(githubDiff("production", ["CLOUDFLARE_API_TOKEN_READONLY"]).unexpected).toEqual([
      "CLOUDFLARE_API_TOKEN_READONLY",
    ]);
  });

  test("accepts an optional secret held during a rotation", () => {
    expect(githubDiff("production", ["OSN_TOTP_ENCRYPTION_KEY_PREVIOUS"]).unexpected).toEqual([]);
  });
});

describe("parseTierArgument", () => {
  test("reads --tier dev or --tier production", () => {
    expect(parseTierArgument(["--tier", "dev"])).toBe("dev");
    expect(parseTierArgument(["--tier", "production"])).toBe("production");
  });

  test.each([[[]], [["--tier"]], [["--tier", "prod"]], [["dev"]]])("refuses %j", (argv) => {
    expect(() => parseTierArgument(argv)).toThrow(/--tier/);
  });
});

describe("accountIdFrom", () => {
  test("returns the account the run names", () => {
    expect(accountIdFrom({ CLOUDFLARE_ACCOUNT_ID: "an-account-id" })).toBe("an-account-id");
  });

  test.each([[{}], [{ CLOUDFLARE_ACCOUNT_ID: "" }], [{ CLOUDFLARE_ACCOUNT_ID: "  " }]])(
    "refuses %j",
    (env) => {
      expect(() => accountIdFrom(env)).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    },
  );
});

describe("redactAccountIds", () => {
  test("replaces an account id in a wrangler error line and leaves the rest", () => {
    const id = "0123456789abcdef0123456789abcdef";
    expect(
      redactAccountIds(
        `A request to /accounts/${id}/workers/scripts/osn-api-dev/secrets failed (10000)`,
      ),
    ).toBe(
      "A request to /accounts/<account-id>/workers/scripts/osn-api-dev/secrets failed (10000)",
    );
    expect(redactAccountIds(`account ${id} not found`)).toBe("account <account-id> not found");
  });
});
