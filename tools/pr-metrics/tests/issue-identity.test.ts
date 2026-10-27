// Which issue a card names, and what it divides spend by. The two answers are
// separate on purpose: `issue.number` is the issue the branch was cut for,
// `complexity.declared` is the sum of the ratings of every issue in this
// repository the pull request closes, or, for a pull request that links none,
// of the tracker issues it closes. A pull request that closes several issues
// must never be divided by one of them, and the one it names must never depend
// on the order GitHub happens to list them in.

import { describe, expect, test } from "bun:test";

import {
  bodyIssueLinks,
  decideComplexity,
  type ForeignIssue,
  type IssueReference,
  type IssueSelection,
  issueKey,
  issuesToRate,
  newFeatIssue,
  ratingLabels,
  sameRepository,
  selectIssues,
  TRACKER_REPO,
  trackerLabelsFromAnswer,
} from "../index.ts";

const REPO = "englishstreetventures/osn";
const TRACKER = "englishstreetventures/osn-tracker";

const tracker = (number: number, repo = TRACKER): ForeignIssue => ({ repo, number });

function ref(number: number, repo = REPO): IssueReference {
  const [login = "", name = ""] = repo.split("/");

  return { number, repository: { name, owner: { login } } };
}

describe("sameRepository", () => {
  test("matches whatever case GitHub or the caller used", () => {
    expect(sameRepository(ref(1, "EnglishStreetVentures/OSN"), REPO)).toBe(true);
  });

  test("never matches the private tracker", () => {
    expect(sameRepository(ref(900001, "englishstreetventures/osn-tracker"), REPO)).toBe(false);
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
      `Closes ${REPO}#21\nCloses englishstreetventures/osn-tracker#900598`,
      REPO,
    );

    expect(links.closes).toEqual([21]);
    expect(links.foreignCloses).toEqual([tracker(900598)]);
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

  // An orchestrated child pull request closes its own issue and advances the
  // epic above it. The issue it closes is the branch's, whichever line comes
  // first; the epic is never its identity.
  test.each([
    ["Closes first", "Closes #1041\n\nPart of #1000"],
    ["Part of first", "Part of #1000\n\nCloses #1041"],
  ])(
    "a child that closes one issue and is Part of an epic names the one it closes (%s)",
    (_, body) => {
      const selection = selectIssues({ body, refs: [ref(1041)], repo: REPO, closedFromBody: true });

      expect(selection.issue).toBe(1041);
      expect(selection.closed).toEqual([1041]);
      expect(selection.partOf).toEqual([1000]);
    },
  );

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
      body: "Closes englishstreetventures/osn-tracker#900754",
      refs: [ref(900754, "englishstreetventures/osn-tracker")],
      repo: REPO,
      preferred: 900754,
      closedFromBody: true,
    });

    expect(selection.issue).toBeNull();
    expect(selection.closed).toEqual([]);
    expect(selection.foreign).toBe(true);
    expect(selection.closedElsewhere).toEqual([tracker(900754)]);
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

describe("selectIssues — another repository's issues", () => {
  test("an open pull request closes a tracker issue once, from its body or GitHub's list", () => {
    const selection = selectIssues({
      body: `Closes ${TRACKER}#900005\nCloses #9`,
      refs: [ref(900005, "EnglishStreetVentures/OSN-Tracker"), ref(900006, TRACKER), ref(9)],
      repo: REPO,
      closedFromBody: true,
    });

    expect(selection.closed).toEqual([9]);
    expect(selection.closedElsewhere.map(issueKey)).toEqual([
      `${TRACKER}#900005`,
      `${TRACKER}#900006`,
    ]);
  });

  // GitHub may leave out a reference to a repository the token cannot read, so
  // a merged pull request's body-only tracker line still says a rating exists
  // somewhere nobody looked.
  test("a merged pull request is credited with the tracker issues GitHub registered alone", () => {
    const selection = selectIssues({
      body: `Closes ${TRACKER}#900005`,
      refs: [],
      repo: REPO,
      closedFromBody: false,
    });

    expect(selection.closedElsewhere).toEqual([]);
    expect(selection.foreign).toBe(true);
    expect(decideComplexity(selection, new Map(), new Map()).method).toBe("not-fetched");
  });

  test("a Part of line naming a tracker issue is kept apart from what it closes", () => {
    const selection = selectIssues({
      body: `Part of ${TRACKER}#900007\nCloses ${TRACKER}#900008`,
      refs: [],
      repo: REPO,
      closedFromBody: true,
    });

    expect(selection.partOfElsewhere).toEqual([tracker(900007)]);
    expect(selection.closedElsewhere).toEqual([tracker(900008)]);
    expect(selection.issue).toBeNull();
  });
});

describe("ratingLabels — all a card takes from another repository's issue", () => {
  test("keeps the complexity pair and drops every other label", () => {
    expect(
      ratingLabels([
        "severity:high",
        "area:security",
        "product:osn",
        "needs:decision",
        "complexity:huge",
        "complexity:3",
        " complexity:unconfirmed ",
        "xcomplexity:5",
      ]),
    ).toEqual(["complexity:3", "complexity:unconfirmed"]);
  });
});

describe("trackerLabelsFromAnswer — reading the one tracker call", () => {
  const answer = (repository: unknown) => JSON.stringify({ data: { repository } });

  test("keeps the complexity pair of each issue and nothing else", () => {
    const read = trackerLabelsFromAnswer(
      answer({
        i900619: {
          labels: {
            nodes: [
              { name: "severity:high" },
              { name: "area:security" },
              { name: "complexity:3" },
              { name: "complexity:unconfirmed" },
            ],
          },
        },
        i900620: null,
      }),
      [tracker(900619), tracker(900620)],
    );

    expect([...read.entries()]).toEqual([
      [`${TRACKER}#900619`, ["complexity:3", "complexity:unconfirmed"]],
    ]);
  });

  test.each([
    ["a repository the token cannot see", answer(null)],
    ["output that is not JSON", "gh: Could not resolve to a Repository"],
    ["no output", null],
  ])("reads nothing from %s", (_, raw) => {
    expect(trackerLabelsFromAnswer(raw, [tracker(900619)]).size).toBe(0);
  });
});

describe("issuesToRate — which issues the denominator sums", () => {
  const selection = (fields: Partial<IssueSelection>): IssueSelection => ({
    issue: null,
    closed: [],
    partOf: [],
    foreign: (fields.closedElsewhere ?? []).length > 0,
    closedElsewhere: [],
    partOfElsewhere: [],
    candidates: [],
    ...fields,
  });

  test("beside an issue here, the tracker issues it closes are not rated", () => {
    expect(issuesToRate(selection({ closed: [4], closedElsewhere: [tracker(900619)] }))).toEqual({
      here: [4],
      elsewhere: [],
    });
  });

  test("with nothing here, the tracker issues it closes are", () => {
    expect(issuesToRate(selection({ closedElsewhere: [tracker(900619)] }))).toEqual({
      here: [],
      elsewhere: [tracker(900619)],
    });
  });

  test("a Part of line here leaves nothing to rate", () => {
    expect(issuesToRate(selection({ partOf: [1000], closedElsewhere: [tracker(900619)] }))).toEqual(
      {
        here: [],
        elsewhere: [],
      },
    );
  });

  test("only the tracker's issues are ever asked about", () => {
    expect(TRACKER_REPO).toBe(TRACKER);
  });
});

describe("decideComplexity — the denominator", () => {
  const labels = (entries: [number, string[] | null][]) => new Map(entries);
  const elsewhere = (entries: [ForeignIssue, string[] | null][]) =>
    new Map(entries.map(([issue, names]) => [issueKey(issue), names]));
  const none = elsewhere([]);
  const pick = (fields: Partial<IssueSelection>): IssueSelection => ({
    issue: null,
    closed: [],
    partOf: [],
    foreign: (fields.closedElsewhere ?? []).length > 0,
    closedElsewhere: [],
    partOfElsewhere: [],
    candidates: [],
    ...fields,
  });

  test("a pull request closing three complexity:2 issues declares 6 over 3 issues", () => {
    const decision = decideComplexity(
      pick({ issue: 1, closed: [1, 2, 3] }),
      labels([
        [1, ["complexity:2"]],
        [2, ["complexity:2"]],
        [3, ["complexity:2"]],
      ]),
      none,
    );

    expect(decision).toEqual({ declared: 6, method: "confirmed", issues: 3, unrated: [] });
  });

  test("one unconfirmed part makes the whole sum unconfirmed", () => {
    const decision = decideComplexity(
      pick({ issue: 1, closed: [1, 2] }),
      labels([
        [1, ["complexity:3"]],
        [2, ["complexity:2", "complexity:unconfirmed"]],
      ]),
      none,
    );

    expect(decision.declared).toBe(5);
    expect(decision.method).toBe("unconfirmed");
  });

  test("one unrated issue makes the sum unknown rather than partial, and names it", () => {
    const decision = decideComplexity(
      pick({ issue: 1, closed: [1, 2] }),
      labels([
        [1, ["complexity:3"]],
        [2, ["product:cire"]],
      ]),
      none,
    );

    expect(decision).toEqual({ declared: null, method: "none", issues: 0, unrated: ["#2"] });
  });

  test("a label lookup that did not land is lookup-failed", () => {
    const decision = decideComplexity(
      pick({ issue: 1, closed: [1, 2] }),
      labels([
        [1, ["complexity:3"]],
        [2, null],
      ]),
      none,
    );

    expect(decision.declared).toBeNull();
    expect(decision.method).toBe("lookup-failed");
  });

  test("a Part of issue's rating is never this branch's", () => {
    const decision = decideComplexity(
      pick({ issue: 1673, partOf: [1673] }),
      labels([[1673, ["complexity:8"]]]),
      none,
    );

    expect(decision).toEqual({ declared: null, method: "part-of", issues: 0, unrated: [] });
  });

  test("a child that closes one issue and is Part of an epic divides by the one it closes", () => {
    const decision = decideComplexity(
      pick({ issue: 1041, closed: [1041], partOf: [1000] }),
      labels([
        [1041, ["complexity:2"]],
        [1000, ["epic", "complexity:8"]],
      ]),
      none,
    );

    expect(decision).toEqual({ declared: 2, method: "confirmed", issues: 1, unrated: [] });
  });

  test("a pull request closing only tracker issues sums their ratings", () => {
    const decision = decideComplexity(
      pick({ closedElsewhere: [tracker(900619), tracker(900620)] }),
      labels([]),
      elsewhere([
        [tracker(900619), ["complexity:3"]],
        [tracker(900620), ["complexity:2", "complexity:unconfirmed"]],
      ]),
    );

    expect(decision).toEqual({ declared: 5, method: "unconfirmed", issues: 2, unrated: [] });
  });

  test("a tracker issue this run could not read is not-fetched", () => {
    const decision = decideComplexity(
      pick({ closedElsewhere: [tracker(900619), tracker(900620)] }),
      labels([]),
      elsewhere([
        [tracker(900619), ["complexity:3"]],
        [tracker(900620), null],
      ]),
    );

    expect(decision).toEqual({ declared: null, method: "not-fetched", issues: 0, unrated: [] });
  });

  test("a tracker issue nobody asked about is not-fetched", () => {
    const decision = decideComplexity(
      pick({ closedElsewhere: [tracker(5, "someone/else")] }),
      labels([]),
      none,
    );

    expect(decision.method).toBe("not-fetched");
  });

  test("an unrated tracker issue makes the sum unknown and is named by repository", () => {
    const decision = decideComplexity(
      pick({ closedElsewhere: [tracker(900619), tracker(900620)] }),
      labels([]),
      elsewhere([
        [tracker(900619), ["complexity:3"]],
        [tracker(900620), []],
      ]),
    );

    expect(decision).toEqual({
      declared: null,
      method: "none",
      issues: 0,
      unrated: [`${TRACKER}#900620`],
    });
  });

  test("a tracker issue beside public ones adds nothing to the sum, read or not", () => {
    const selection = pick({ issue: 4, closed: [4], closedElsewhere: [tracker(900619)] });
    const read = decideComplexity(
      selection,
      labels([[4, ["complexity:3"]]]),
      elsewhere([[tracker(900619), ["complexity:2"]]]),
    );
    const unread = decideComplexity(selection, labels([[4, ["complexity:3"]]]), none);

    expect(read).toEqual({ declared: 3, method: "confirmed", issues: 1, unrated: [] });
    expect(unread).toEqual(read);
  });

  test("a pull request only Part of a tracker issue is part-of", () => {
    const decision = decideComplexity(
      pick({ partOfElsewhere: [tracker(900700)] }),
      labels([]),
      elsewhere([[tracker(900700), ["complexity:8"]]]),
    );

    expect(decision).toEqual({ declared: null, method: "part-of", issues: 0, unrated: [] });
  });

  test("Part of an issue here wins over tracker issues it closes", () => {
    const decision = decideComplexity(
      pick({ issue: 1000, partOf: [1000], closedElsewhere: [tracker(900619)] }),
      labels([]),
      elsewhere([[tracker(900619), ["complexity:2"]]]),
    );

    expect(decision.method).toBe("part-of");
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
      ["# NEW-FEAT — fix/pr-metrics", "Issue: englishstreetventures/osn-tracker#900712"],
    ],
    [
      "a tracker URL",
      [
        "# NEW-FEAT — fix/pr-metrics",
        "Issue: https://github.com/englishstreetventures/osn-tracker/issues/900712",
      ],
    ],
    [
      "a link whose text is a bare number and whose target is the tracker",
      [
        "# NEW-FEAT — fix/pr-metrics",
        "**Issue:** [#900712](https://github.com/englishstreetventures/osn-tracker/issues/900712)",
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
