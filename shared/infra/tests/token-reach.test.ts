import { describe, expect, test } from "vitest";

import { checkTokenReach, checkZoneReach, tokenCheckScope } from "../src/token-reach";

const OURS = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";

const listed = (ids: readonly string[], totalCount = ids.length) => ({
  status: 200,
  body: JSON.stringify({
    success: true,
    errors: [],
    result: ids.map((id) => ({ id, name: `Account ${id}` })),
    result_info: { page: 1, per_page: 50, count: ids.length, total_count: totalCount },
  }),
});

const printed = (outcome: { stdout: string; stderr: string }) => outcome.stdout + outcome.stderr;

describe("checkTokenReach", () => {
  test("exits 0 when the token reaches exactly the account the run names", () => {
    const outcome = checkTokenReach(OURS, listed([OURS]));
    expect(outcome.exitCode).toBe(0);
    expect(printed(outcome)).not.toContain(OURS);
  });

  test.each([
    ["a second account", listed([OURS, OTHER])],
    ["only another account", listed([OTHER])],
    ["no account", listed([])],
    ["more accounts than one page", listed([OURS], 2)],
  ])("exits 1 when it reaches %s, printing no account id", (_case, listing) => {
    const outcome = checkTokenReach(OURS, listing);
    expect(outcome.exitCode).toBe(1);
    expect(printed(outcome)).not.toContain(OURS);
    expect(printed(outcome)).not.toContain(OTHER);
  });

  test.each([
    [
      "an HTTP error",
      {
        status: 403,
        body: JSON.stringify({
          success: false,
          errors: [{ code: 9109, message: `Unauthorized to access /accounts/${OURS}` }],
          result: null,
        }),
      },
    ],
    ["unreadable output", { status: 200, body: "<html>" }],
    [
      "a result that is not a list",
      { status: 200, body: JSON.stringify({ success: true, result: {} }) },
    ],
  ])("exits 2 on %s, printing no account id", (_case, listing) => {
    const outcome = checkTokenReach(OURS, listing);
    expect(outcome.exitCode).toBe(2);
    expect(printed(outcome)).not.toContain(OURS);
  });
});

/** One page of `GET /zones`, each zone `[name, account id]`. */
const zonePage = (
  zones: readonly (readonly [string, string])[],
  page = 1,
  totalPages = 1,
  totalCount = zones.length,
) => ({
  status: 200,
  body: JSON.stringify({
    success: true,
    errors: [],
    result: zones.map(([name, account]) => ({ id: `z-${name}`, name, account: { id: account } })),
    result_info: {
      page,
      per_page: 50,
      total_pages: totalPages,
      count: zones.length,
      total_count: totalCount,
    },
  }),
});

const DEV_DOMAIN = "osn-dev.example";

describe("checkZoneReach", () => {
  test("Z6: a dev token whose only zone is the dev domain's, on the dev account, passes", () => {
    const outcome = checkZoneReach(OURS, DEV_DOMAIN, [zonePage([[DEV_DOMAIN, OURS]])]);
    expect(outcome.exitCode).toBe(0);
    expect(printed(outcome)).not.toContain(OURS);
  });

  test("Z1: a zone on another account exits 1, printing no account id", () => {
    const pages = [
      zonePage([
        [DEV_DOMAIN, OURS],
        ["other.example", OTHER],
      ]),
    ];
    const outcome = checkZoneReach(OURS, DEV_DOMAIN, pages);
    expect(outcome.exitCode).toBe(1);
    expect(printed(outcome)).not.toContain(OURS);
    expect(printed(outcome)).not.toContain(OTHER);
  });

  test.each([["musubi.social"], ["id.musubi.social"], ["cireweddings.com"]])(
    "Z2: on dev, the production zone %s exits 1 even on the dev account",
    (zone) => {
      const pages = [
        zonePage([
          [DEV_DOMAIN, OURS],
          [zone, OURS],
        ]),
      ];
      const outcome = checkZoneReach(OURS, DEV_DOMAIN, pages);
      expect(outcome.exitCode).toBe(1);
      expect(printed(outcome)).toContain(zone);
    },
  );

  test("Z3: on dev, a token that holds no zone named DEV_DOMAIN exits 1", () => {
    expect(checkZoneReach(OURS, DEV_DOMAIN, [zonePage([])]).exitCode).toBe(1);
    expect(checkZoneReach(OURS, DEV_DOMAIN, [zonePage([["else.example", OURS]])]).exitCode).toBe(1);
  });

  test("Z7: every page is read, and a listing missing a page exits 2", () => {
    const pages = [
      zonePage([[DEV_DOMAIN, OURS]], 1, 2, 2),
      zonePage([["musubi.social", OURS]], 2, 2, 2),
    ];
    expect(checkZoneReach(OURS, DEV_DOMAIN, pages).exitCode).toBe(1);
    expect(checkZoneReach(OURS, DEV_DOMAIN, pages.slice(0, 1)).exitCode).toBe(2);
  });

  test.each([
    [
      "an HTTP error",
      { status: 403, body: JSON.stringify({ success: false, errors: [], result: null }) },
    ],
    ["unreadable output", { status: 200, body: "<html>" }],
    ["no pages at all", undefined],
  ])("Z5: exits 2 on %s", (_case, page) => {
    expect(checkZoneReach(OURS, DEV_DOMAIN, page === undefined ? [] : [page]).exitCode).toBe(2);
  });
});

describe("tokenCheckScope", () => {
  test("--tier dev reads the dev domain; --tier production reads none", () => {
    expect(tokenCheckScope(["--tier", "dev"], { DEV_DOMAIN })).toEqual({
      tier: "dev",
      devDomain: DEV_DOMAIN,
    });
    expect(tokenCheckScope(["--tier", "production"], { DEV_DOMAIN })).toEqual({
      tier: "production",
      devDomain: null,
    });
  });

  test.each([
    ["no tier", [], { DEV_DOMAIN }, /--tier/],
    ["an unknown tier", ["--tier", "staging"], { DEV_DOMAIN }, /--tier/],
    ["dev with DEV_DOMAIN unset", ["--tier", "dev"], {}, /DEV_DOMAIN is unset/],
    [
      "dev with a production DEV_DOMAIN",
      ["--tier", "dev"],
      { DEV_DOMAIN: "musubi.social" },
      /production/,
    ],
    [
      "dev with a trailing dot",
      ["--tier", "dev"],
      { DEV_DOMAIN: `${DEV_DOMAIN}.` },
      /bare lower-case domain/,
    ],
  ])("Z4: refuses %s", (_case, argv, env, message) => {
    expect(() => tokenCheckScope(argv, env)).toThrow(message);
  });
});
