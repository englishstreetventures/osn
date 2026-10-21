import { describe, expect, test } from "vitest";

import { checkTokenReach } from "../src/token-reach";

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
