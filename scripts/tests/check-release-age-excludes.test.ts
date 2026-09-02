import { expect, test } from "bun:test";

import { checkReleaseAgeExcludes, findStrayBunfigs } from "../check-release-age-excludes";

const NOW = new Date("2026-08-24T00:00:00Z");

function bunfig(
  excludesLine: string,
  markerComment: string,
  minimumReleaseAge: string = "259200",
): string {
  return `
[install]
minimumReleaseAge = ${minimumReleaseAge}
${markerComment}
minimumReleaseAgeExcludes = ${excludesLine}
`;
}

test("an empty excludes list passes with no markers needed", () => {
  expect(checkReleaseAgeExcludes(bunfig("[]", ""), NOW)).toEqual([]);
});

test("a marker whose date is still in the future passes", () => {
  const toml = bunfig(`["left-pad"]`, "# DROP AFTER left-pad 2026-08-25");
  expect(checkReleaseAgeExcludes(toml, NOW)).toEqual([]);
});

test("a marker dated exactly today still passes — valid through the named date", () => {
  const toml = bunfig(`["left-pad"]`, "# DROP AFTER left-pad 2026-08-24");
  expect(checkReleaseAgeExcludes(toml, NOW)).toEqual([]);
});

test("a marker whose date has passed fails", () => {
  const toml = bunfig(`["left-pad"]`, "# DROP AFTER left-pad 2026-08-23");
  expect(checkReleaseAgeExcludes(toml, NOW)).toEqual([
    {
      name: "left-pad",
      problem: 'drop-trigger "DROP AFTER left-pad 2026-08-23" has passed (today is 2026-08-24)',
    },
  ]);
});

test("an excluded entry with no marker at all fails", () => {
  const toml = bunfig(`["left-pad"]`, "# some unrelated comment");
  expect(checkReleaseAgeExcludes(toml, NOW)).toEqual([
    {
      name: "left-pad",
      problem: 'no "# DROP AFTER left-pad <YYYY-MM-DD>" marker comment found',
    },
  ]);
});

test("a marker for a different package name does not satisfy this entry", () => {
  const toml = bunfig(`["left-pad"]`, "# DROP AFTER right-pad 2026-08-25");
  expect(checkReleaseAgeExcludes(toml, NOW)).toEqual([
    {
      name: "left-pad",
      problem: 'no "# DROP AFTER left-pad <YYYY-MM-DD>" marker comment found',
    },
  ]);
});

test("multiple excludes are checked independently", () => {
  const toml = bunfig(
    `["left-pad", "right-pad"]`,
    "# DROP AFTER left-pad 2026-08-23\n# DROP AFTER right-pad 2026-08-25",
  );
  expect(checkReleaseAgeExcludes(toml, NOW)).toEqual([
    {
      name: "left-pad",
      problem: 'drop-trigger "DROP AFTER left-pad 2026-08-23" has passed (today is 2026-08-24)',
    },
  ]);
});

// S-M1 — the marker date is round-trip parsed and bounded, not just regex-shaped.

test("a marker that matches the date regex but is not a real calendar date fails", () => {
  const toml = bunfig(`["left-pad"]`, "# DROP AFTER left-pad 9999-99-99");
  expect(checkReleaseAgeExcludes(toml, NOW)).toEqual([
    {
      name: "left-pad",
      problem: '"DROP AFTER left-pad 9999-99-99" is not a real calendar date (want YYYY-MM-DD)',
    },
  ]);
});

test("a marker more than 30 days out fails even though it is a valid future date", () => {
  const toml = bunfig(`["left-pad"]`, "# DROP AFTER left-pad 2999-01-01");
  expect(checkReleaseAgeExcludes(toml, NOW)).toEqual([
    {
      name: "left-pad",
      problem: expect.stringContaining("more than the 30-day maximum"),
    },
  ]);
});

test("a marker exactly 30 days out still passes", () => {
  const toml = bunfig(`["left-pad"]`, "# DROP AFTER left-pad 2026-09-23");
  expect(checkReleaseAgeExcludes(toml, NOW)).toEqual([]);
});

test("a marker 31 days out fails", () => {
  const toml = bunfig(`["left-pad"]`, "# DROP AFTER left-pad 2026-09-24");
  expect(checkReleaseAgeExcludes(toml, NOW)).toEqual([
    {
      name: "left-pad",
      problem: expect.stringContaining("is 31 days out, more than the 30-day maximum"),
    },
  ]);
});

// S-M2 — the guard checks minimumReleaseAge itself, not only the exclude list.

test("minimumReleaseAge below the 3-day soak window fails even with a clean exclude list", () => {
  const toml = bunfig("[]", "", "0");
  expect(checkReleaseAgeExcludes(toml, NOW)).toEqual([
    {
      name: "minimumReleaseAge",
      problem: "install.minimumReleaseAge must be a number >= 259200 (3 days); found 0",
    },
  ]);
});

test("a missing minimumReleaseAge fails", () => {
  const toml = `
[install]
minimumReleaseAgeExcludes = []
`;
  expect(checkReleaseAgeExcludes(toml, NOW)).toEqual([
    {
      name: "minimumReleaseAge",
      problem: "install.minimumReleaseAge must be a number >= 259200 (3 days); found undefined",
    },
  ]);
});

test("minimumReleaseAge exactly at the 3-day floor passes", () => {
  const toml = bunfig("[]", "", "259200");
  expect(checkReleaseAgeExcludes(toml, NOW)).toEqual([]);
});

test("the root bunfig.toml is not itself a stray", () => {
  expect(findStrayBunfigs(["bunfig.toml", "package.json", "oxlintrc.json"])).toEqual([]);
});

test("a bunfig.toml anywhere below the root is a stray", () => {
  expect(
    findStrayBunfigs(["bunfig.toml", "cire/api/bunfig.toml", "tools/lab/bunfig.toml"]),
  ).toEqual(["cire/api/bunfig.toml", "tools/lab/bunfig.toml"]);
});

test("a file whose name merely ends in bunfig.toml is not a stray", () => {
  expect(findStrayBunfigs(["bunfig.toml", "docs/not-a-bunfig.toml"])).toEqual([]);
});
