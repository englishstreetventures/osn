// The pure half of scripts/check-free-tier-ceilings.ts: threshold arithmetic,
// the issue body, response narrowing and the create/edit/reopen choice. The
// network half is two `fetch` calls and a `gh` spawn, which is why the parsing
// is a separate exported function from the fetching.
//
// No `bun install`: this imports `bun:test` and the script under test, matching
// every other file under scripts/.

import { expect, test } from "bun:test";

import {
  CEILINGS,
  type D1Group,
  findBreaches,
  fraction,
  ISSUE_TITLE,
  matchIssue,
  parseUsage,
  planIssueAction,
  renderIssueBody,
  type StorageGroup,
  type Usage,
  utcDay,
  WARN_FRACTION,
  windowFor,
  type WorkerGroup,
} from "../check-free-tier-ceilings";

const NAMES = new Map([
  ["bf0510eb", "cire-db-dev"],
  ["6e835474", "cire-db"],
  ["1c1425e1", "osn-db-dev"],
]);

function d1(databaseId: string, date: string, rowsWritten: number, rowsRead = 0): D1Group {
  return {
    dimensions: { databaseId, date },
    sum: { rowsWritten, rowsRead, writeQueries: 1, readQueries: 1 },
  };
}

function worker(scriptName: string, date: string, requests: number): WorkerGroup {
  return { dimensions: { scriptName, date }, sum: { requests } };
}

function storage(databaseId: string, date: string, databaseSizeBytes: number): StorageGroup {
  return { dimensions: { databaseId, date }, max: { databaseSizeBytes } };
}

const EMPTY: Usage = { d1: [], workers: [], storage: [] };

test("the day the ceiling was crossed fires, with the database named", () => {
  // The real 2026-08-30 figures, the first of the two overruns nobody saw.
  const usage: Usage = {
    ...EMPTY,
    d1: [d1("bf0510eb", "2026-08-30", 104_091), d1("6e835474", "2026-08-30", 657)],
  };

  const breaches = findBreaches(usage, NAMES);

  expect(breaches).toHaveLength(1);
  expect(breaches[0]!.counter).toBe("D1 rows written");
  expect(breaches[0]!.day).toBe("2026-08-30");
  expect(breaches[0]!.used).toBe(104_748);
  expect(breaches[0]!.contributors[0]).toMatchObject({ name: "cire-db-dev", amount: 104_091 });
});

test("a day at 64% of the ceiling reads as normal", () => {
  const usage: Usage = { ...EMPTY, d1: [d1("bf0510eb", "2026-09-08", 64_056)] };
  expect(findBreaches(usage, NAMES)).toHaveLength(0);
});

test("the warning line is inclusive, and one row below it is not", () => {
  const line = CEILINGS.d1RowsWritten * WARN_FRACTION;
  expect(findBreaches({ ...EMPTY, d1: [d1("bf0510eb", "2026-09-08", line)] }, NAMES)).toHaveLength(
    1,
  );
  expect(
    findBreaches({ ...EMPTY, d1: [d1("bf0510eb", "2026-09-08", line - 1)] }, NAMES),
  ).toHaveLength(0);
});

test("the total is account-wide, so databases under the line together cross it", () => {
  const usage: Usage = {
    ...EMPTY,
    d1: [
      d1("bf0510eb", "2026-09-09", 45_000),
      d1("6e835474", "2026-09-09", 45_000),
      d1("1c1425e1", "2026-09-09", 10_000),
    ],
  };

  const breaches = findBreaches(usage, NAMES);

  expect(breaches).toHaveLength(1);
  expect(breaches[0]!.used).toBe(100_000);
  expect(breaches[0]!.contributors.map((c) => c.name)).toEqual([
    "cire-db-dev",
    "cire-db",
    "osn-db-dev",
  ]);
});

test("each day is judged on its own", () => {
  const usage: Usage = {
    ...EMPTY,
    d1: [d1("bf0510eb", "2026-08-30", 104_091), d1("bf0510eb", "2026-09-09", 104_091)],
  };
  expect(findBreaches(usage, NAMES).map((b) => b.day)).toEqual(["2026-09-09", "2026-08-30"]);
});

test("rows read has its own, much higher ceiling", () => {
  const under: Usage = { ...EMPTY, d1: [d1("bf0510eb", "2026-09-09", 0, 294_202)] };
  expect(findBreaches(under, NAMES)).toHaveLength(0);

  const over: Usage = { ...EMPTY, d1: [d1("bf0510eb", "2026-09-09", 0, 4_500_000)] };
  expect(findBreaches(over, NAMES)[0]!.counter).toBe("D1 rows read");
});

test("Workers requests are counted account-wide and broken down by script", () => {
  const usage: Usage = {
    ...EMPTY,
    workers: [worker("cire-api", "2026-09-09", 70_000), worker("osn-api", "2026-09-09", 15_000)],
  };

  const breaches = findBreaches(usage, NAMES);

  expect(breaches).toHaveLength(1);
  expect(breaches[0]!.counter).toBe("Workers requests");
  expect(breaches[0]!.contributors[0]!.name).toBe("cire-api");
});

test("storage reads the newest day only, so yesterday's size is not added to today's", () => {
  const usage: Usage = {
    ...EMPTY,
    storage: [
      storage("bf0510eb", "2026-09-09", 3_000_000_000),
      storage("bf0510eb", "2026-09-10", 3_000_000_000),
      storage("6e835474", "2026-09-10", 1_100_000_000),
    ],
  };

  const account = findBreaches(usage, NAMES).find((b) => b.counter === "D1 storage");

  expect(account).toBeDefined();
  expect(account!.day).toBe("2026-09-10");
  // 3 GB + 1.1 GB from the newest day, not 6 GB + 1.1 GB across both days.
  expect(account!.used).toBe(4_100_000_000);
});

test("one database over its own 500 MB line fires while the account total is quiet", () => {
  const usage: Usage = { ...EMPTY, storage: [storage("6e835474", "2026-09-10", 480_000_000)] };

  const breaches = findBreaches(usage, NAMES);

  // 480 MB is 9.6% of the account's 5 GB and 96% of one database's 500 MB.
  expect(breaches).toHaveLength(1);
  expect(breaches[0]!.counter).toBe("D1 database size: cire-db");
  expect(breaches[0]!.day).toBe("2026-09-10");
  expect(breaches[0]!.used).toBe(480_000_000);
});

test("a database at 79% of its own line is not reported", () => {
  const usage: Usage = { ...EMPTY, storage: [storage("6e835474", "2026-09-10", 399_000_000)] };
  expect(findBreaches(usage, NAMES)).toHaveLength(0);
});

test("each database is weighed on its own, so only the full one is named", () => {
  const usage: Usage = {
    ...EMPTY,
    storage: [
      storage("bf0510eb", "2026-09-10", 450_000_000),
      storage("6e835474", "2026-09-10", 1_000_000),
      storage("1c1425e1", "2026-09-10", 1_000_000),
    ],
  };

  const breaches = findBreaches(usage, NAMES);

  expect(breaches.map((b) => b.counter)).toEqual(["D1 database size: cire-db-dev"]);
});

test("the body names the database in the heading of a per-database breach", () => {
  const usage: Usage = { ...EMPTY, storage: [storage("bf0510eb", "2026-09-10", 480_000_000)] };
  const body = renderIssueBody(
    findBreaches(usage, NAMES),
    { start: "2026-09-10", end: "2026-09-10" },
    "2026-09-10T08:00:00Z",
  );
  expect(body).toContain("## D1 database size: cire-db-dev — 2026-09-10");
  expect(body).toContain("480.0 MB of 500.0 MB (96%)");
});

test("worst counter first", () => {
  const usage: Usage = {
    ...EMPTY,
    d1: [d1("bf0510eb", "2026-09-09", 85_000)],
    workers: [worker("cire-api", "2026-09-09", 99_000)],
  };
  expect(findBreaches(usage, NAMES).map((b) => b.counter)).toEqual([
    "Workers requests",
    "D1 rows written",
  ]);
  expect(fraction(findBreaches(usage, NAMES)[0]!)).toBeCloseTo(0.99);
});

test("a database the name lookup does not know is shown by its id", () => {
  const usage: Usage = { ...EMPTY, d1: [d1("00000000", "2026-09-09", 90_000)] };
  expect(findBreaches(usage, NAMES)[0]!.contributors[0]!.name).toBe("00000000");
});

test("the body names the counter, the day, the figure and the database", () => {
  const usage: Usage = {
    ...EMPTY,
    d1: [d1("bf0510eb", "2026-09-09", 104_091), d1("6e835474", "2026-09-09", 0)],
  };

  const body = renderIssueBody(
    findBreaches(usage, NAMES),
    { start: "2026-09-09", end: "2026-09-10" },
    "2026-09-10T08:00:00Z",
  );

  expect(body).toContain("D1 rows written — 2026-09-09");
  expect(body).toContain("104,091 of 100,000 (104%)");
  expect(body).toContain("`cire-db-dev`");
  expect(body).toContain("wiki/runbooks/free-tier-limits.md");
  // A database that spent nothing that day is not worth a row.
  expect(body).not.toContain("`cire-db`");
});

test("the body prints storage in megabytes, not raw bytes", () => {
  const usage: Usage = { ...EMPTY, storage: [storage("bf0510eb", "2026-09-10", 4_100_000_000)] };
  const body = renderIssueBody(
    findBreaches(usage, NAMES),
    { start: "2026-09-10", end: "2026-09-10" },
    "2026-09-10T08:00:00Z",
  );
  expect(body).toContain("4100.0 MB of 5000.0 MB (82%)");
});

test("parseUsage narrows a well-formed response", () => {
  const payload = {
    errors: null,
    data: {
      viewer: { accounts: [{ d1: [d1("bf0510eb", "2026-09-09", 5)], workers: [], storage: [] }] },
    },
  };
  expect(parseUsage(payload).d1).toHaveLength(1);
});

test("parseUsage throws on a GraphQL error rather than reporting a quiet day", () => {
  const payload = { errors: [{ message: "authentication error" }], data: null };
  expect(() => parseUsage(payload)).toThrow(/authentication error/);
});

test("parseUsage throws when the account is missing", () => {
  expect(() => parseUsage({ errors: null, data: { viewer: { accounts: [] } } })).toThrow(
    /no account/,
  );
});

test("parseUsage throws when a dataset is not an array", () => {
  const payload = { data: { viewer: { accounts: [{ d1: [], workers: [], storage: null }] } } };
  expect(() => parseUsage(payload)).toThrow(/no 'storage' array/);
});

test("parseUsage throws when a total is not a number", () => {
  const payload = {
    data: {
      viewer: {
        accounts: [
          {
            d1: [
              {
                dimensions: { databaseId: "bf0510eb", date: "2026-09-09" },
                sum: { rowsWritten: null, rowsRead: 0, writeQueries: 0, readQueries: 0 },
              },
            ],
            workers: [],
            storage: [],
          },
        ],
      },
    },
  };
  expect(() => parseUsage(payload)).toThrow(/non-numeric/);
});

test("parseUsage throws on a body that is not an object", () => {
  expect(() => parseUsage("gateway timeout")).toThrow(/non-object/);
});

test("the window is whole UTC days ending with the day given", () => {
  expect(windowFor("2026-09-10", 2)).toEqual({ start: "2026-09-09", end: "2026-09-10" });
  expect(windowFor("2026-09-10", 1)).toEqual({ start: "2026-09-10", end: "2026-09-10" });
  // Across a month boundary, which is where hand-rolled date arithmetic fails.
  expect(windowFor("2026-09-01", 3)).toEqual({ start: "2026-08-30", end: "2026-09-01" });
});

test("utcDay steps back in UTC, not in the runner's zone", () => {
  expect(utcDay(new Date("2026-03-01T00:30:00Z"), 1)).toBe("2026-02-28");
});

test("windowFor rejects a date it cannot read", () => {
  expect(() => windowFor("yesterday", 2)).toThrow(/Not a date/);
});

test("no match opens a new issue; an open one is edited; a closed one is reopened", () => {
  const listed = JSON.stringify([
    { number: 12, title: "Something else", state: "OPEN" },
    { number: 34, title: ISSUE_TITLE, state: "CLOSED" },
  ]);

  expect(planIssueAction(matchIssue("[]", ISSUE_TITLE))).toEqual({ kind: "create" });
  expect(planIssueAction(matchIssue(listed, ISSUE_TITLE))).toEqual({ kind: "reopen", number: 34 });
  expect(
    planIssueAction(
      matchIssue(JSON.stringify([{ number: 7, title: ISSUE_TITLE, state: "OPEN" }]), ISSUE_TITLE),
    ),
  ).toEqual({ kind: "edit", number: 7 });
});

test("a title that only contains the search text is not the issue", () => {
  const listed = JSON.stringify([{ number: 9, title: `${ISSUE_TITLE} (again)`, state: "OPEN" }]);
  expect(matchIssue(listed, ISSUE_TITLE)).toBeUndefined();
});
