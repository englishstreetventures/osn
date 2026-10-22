// Which issue a card names, and what it divides spend by. The two answers are
// separate on purpose: `issue.number` is the issue the branch was cut for,
// `complexity.declared` is the sum of the ratings of every issue in this
// repository the pull request closes. A pull request that closes several issues
// must never be divided by one of them, and the one it names must never depend
// on the order GitHub happens to list them in.

import { describe, expect, test } from "bun:test";

import {
  bodyIssueLinks,
  decideComplexity,
  type IssueReference,
  newFeatIssue,
  sameRepository,
  selectIssues,
} from "../index.ts";

const REPO = "englishstreetventures/osn";

function ref(number: number, repo = REPO): IssueReference {
  const [login = "", name = ""] = repo.split("/");

  return { number, repository: { name, owner: { login } } };
}

describe("sameRepository", () => {
  test("matches whatever case GitHub or the caller used", () => {
    expect(sameRepository(ref(1, "EnglishStreetVentures/OSN"), REPO)).toBe(true);
  });

  test("never matches the private tracker", () => {
    expect(sameRepository(ref(1, "englishstreetventures/osn-tracker"), REPO)).toBe(false);
  });
});

describe("bodyIssueLinks reads prose only", () => {
  test("a closing keyword in a code span, a fence, a comment or a table row is not a link", () => {
    const body = [
      "Mentions `Closes #11` in passing.",
      "```",
      "Closes #12",
      "```",
      "<!-- Closes #13 -->",
      "| Closes #14 | table |",
      "Closes #15",
    ].join("\n");

    expect(bodyIssueLinks(body, REPO).closes).toEqual([15]);
  });

  test("this repository's qualified form counts; another repository's is foreign", () => {
    const links = bodyIssueLinks(
      `Closes ${REPO}#21\nCloses englishstreetventures/osn-tracker#598`,
      REPO,
    );

    expect(links.closes).toEqual([21]);
    expect(links.foreignCloses).toBe(1);
  });

  test("unclosed comments and lone backticks are read in linear time", () => {
    const started = performance.now();
    bodyIssueLinks(`${"<!-- ".repeat(20_000)}\n${"` ".repeat(20_000)}Closes #1`, REPO);

    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("selectIssues — the branch's own issue", () => {
  test("takes the first Closes line in the body, not the lowest number GitHub lists first", () => {
    const selection = selectIssues({
      body: "Closes #1550\nCloses #1031\nCloses #1033",
      refs: [ref(1031), ref(1033), ref(1550)],
      repo: REPO,
      closedFromBody: true,
    });

    expect(selection.issue).toBe(1550);
    expect(selection.closed).toEqual([1550, 1031, 1033]);
  });

  test("a pull request that only advances an issue names it from its Part of line", () => {
    const selection = selectIssues({
      body: "This branch started from no issue.\n\nPart of #1673",
      refs: [],
      repo: REPO,
      closedFromBody: true,
    });

    expect(selection.issue).toBe(1673);
    expect(selection.closed).toEqual([]);
    expect(selection.partOf).toEqual([1673]);
  });

  test("several references and no body line name no issue, but every one is still closed", () => {
    const selection = selectIssues({
      body: "",
      refs: [ref(1512), ref(1533)],
      repo: REPO,
      closedFromBody: true,
    });

    expect(selection.issue).toBeNull();
    expect(selection.candidates).toEqual([1512, 1533]);
    expect(selection.closed).toEqual([1512, 1533]);
  });

  test("one reference and no body line is that issue", () => {
    const selection = selectIssues({ body: "", refs: [ref(5)], repo: REPO, closedFromBody: true });

    expect(selection.issue).toBe(5);
  });

  test("NEW-FEAT.md chooses among the pull request's own links", () => {
    const selection = selectIssues({
      body: "Closes #1512\nCloses #1533",
      refs: [ref(1512), ref(1533)],
      repo: REPO,
      preferred: 1533,
      closedFromBody: true,
    });

    expect(selection.issue).toBe(1533);
  });

  test("NEW-FEAT.md never introduces an issue the pull request does not link", () => {
    const selection = selectIssues({
      body: "Closes englishstreetventures/osn-tracker#754",
      refs: [ref(754, "englishstreetventures/osn-tracker")],
      repo: REPO,
      preferred: 754,
      closedFromBody: true,
    });

    expect(selection.issue).toBeNull();
    expect(selection.closed).toEqual([]);
    expect(selection.foreign).toBe(true);
  });

  test("an issue both listed by GitHub and named in the body is closed once", () => {
    const selection = selectIssues({
      body: "Closes #7",
      refs: [ref(7)],
      repo: REPO,
      closedFromBody: true,
    });

    expect(selection.closed).toEqual([7]);
  });

  test("a merged pull request's closed set is what GitHub registered", () => {
    const selection = selectIssues({
      body: "Closes #8\nCloses #9",
      refs: [ref(9)],
      repo: REPO,
      closedFromBody: false,
    });

    expect(selection.issue).toBe(8);
    expect(selection.closed).toEqual([9]);
  });
});

describe("decideComplexity — the denominator", () => {
  const labels = (entries: [number, string[] | null][]) => new Map(entries);

  test("a pull request closing three complexity:2 issues declares 6 over 3 issues", () => {
    const decision = decideComplexity(
      { issue: 1, closed: [1, 2, 3], partOf: [], foreign: false, candidates: [] },
      labels([
        [1, ["complexity:2"]],
        [2, ["complexity:2"]],
        [3, ["complexity:2"]],
      ]),
    );

    expect(decision).toEqual({ declared: 6, method: "confirmed", issues: 3, unrated: [] });
  });

  test("one unconfirmed part makes the whole sum unconfirmed", () => {
    const decision = decideComplexity(
      { issue: 1, closed: [1, 2], partOf: [], foreign: false, candidates: [] },
      labels([
        [1, ["complexity:3"]],
        [2, ["complexity:2", "complexity:unconfirmed"]],
      ]),
    );

    expect(decision.declared).toBe(5);
    expect(decision.method).toBe("unconfirmed");
  });

  test("one unrated issue makes the sum unknown rather than partial, and names it", () => {
    const decision = decideComplexity(
      { issue: 1, closed: [1, 2], partOf: [], foreign: false, candidates: [] },
      labels([
        [1, ["complexity:3"]],
        [2, ["product:cire"]],
      ]),
    );

    expect(decision).toEqual({ declared: null, method: "none", issues: 0, unrated: [2] });
  });

  test("a label lookup that did not land is lookup-failed", () => {
    const decision = decideComplexity(
      { issue: 1, closed: [1, 2], partOf: [], foreign: false, candidates: [] },
      labels([
        [1, ["complexity:3"]],
        [2, null],
      ]),
    );

    expect(decision.declared).toBeNull();
    expect(decision.method).toBe("lookup-failed");
  });

  test("a Part of issue's rating is never this branch's", () => {
    const decision = decideComplexity(
      { issue: 1673, closed: [], partOf: [1673], foreign: false, candidates: [] },
      labels([[1673, ["complexity:8"]]]),
    );

    expect(decision).toEqual({ declared: null, method: "part-of", issues: 0, unrated: [] });
  });

  test("a pull request closing only a tracker issue is not-fetched", () => {
    const decision = decideComplexity(
      { issue: null, closed: [], partOf: [], foreign: true, candidates: [] },
      labels([]),
    );

    expect(decision.method).toBe("not-fetched");
  });

  test("a tracker issue beside public ones adds nothing to the sum", () => {
    const decision = decideComplexity(
      { issue: 4, closed: [4], partOf: [], foreign: true, candidates: [] },
      labels([[4, ["complexity:3"]]]),
    );

    expect(decision.declared).toBe(3);
    expect(decision.issues).toBe(1);
  });
});

describe("newFeatIssue", () => {
  const BRANCH = "fix/pr-metrics";
  const read = (lines: string[]) => newFeatIssue(lines.join("\n"), BRANCH, REPO);

  test.each([
    [
      "a list item",
      [
        "# NEW-FEAT — fix/pr-metrics",
        "- Issue: englishstreetventures/osn#1553 (sub-issue of #1490)",
      ],
      1553,
    ],
    [
      "a bold label and a link",
      [
        "# NEW-FEAT — fix/pr-metrics",
        "**Issue:** [#1365](https://github.com/englishstreetventures/osn/issues/1365)",
      ],
      1365,
    ],
    [
      "a table cell",
      ["Branch `fix/pr-metrics`", '| Issue | englishstreetventures/osn#1391 "title" |'],
      1391,
    ],
    ["a plural line", ["# NEW-FEAT — fix/pr-metrics", "Issues: #1568, #1570"], 1568],
    [
      "an issues URL",
      [
        "# NEW-FEAT — fix/pr-metrics",
        "Issue: https://github.com/englishstreetventures/osn/issues/42",
      ],
      42,
    ],
  ])("reads %s", (_, lines, expected) => {
    expect(read(lines)).toBe(expected);
  });

  test.each([
    [
      "a tracker reference",
      ["# NEW-FEAT — fix/pr-metrics", "Issue: englishstreetventures/osn-tracker#712"],
    ],
    [
      "a tracker URL",
      [
        "# NEW-FEAT — fix/pr-metrics",
        "Issue: https://github.com/englishstreetventures/osn-tracker/issues/712",
      ],
    ],
    ["a file for another branch", ["# NEW-FEAT — fix/other", "Issue: #9"]],
    ["a file for a longer branch name", ["# NEW-FEAT — fix/pr-metrics-cards", "Issue: #9"]],
    [
      "an Issue line past the first 30 lines",
      ["# NEW-FEAT — fix/pr-metrics", ...Array<string>(30).fill("text"), "Issue: #9"],
    ],
    ["no Issue line", ["# NEW-FEAT — fix/pr-metrics", "Closes #9"]],
  ])("names nothing for %s", (_, lines) => {
    expect(read(lines)).toBeNull();
  });
});
