import { expect, test } from "bun:test";

import { alreadyOnBoard, parseBoard, parseIssues, pending, rateLimited } from "./backfill-project";

test("reads the issue URLs in a repo listing", () => {
  const json = JSON.stringify([
    { url: "https://github.com/xchromo/osn/issues/466" },
    { url: "https://github.com/xchromo/osn/issues/467" },
  ]);
  expect(parseIssues(json)).toEqual([
    "https://github.com/xchromo/osn/issues/466",
    "https://github.com/xchromo/osn/issues/467",
  ]);
});

test("reads the URLs already on the board", () => {
  const json = JSON.stringify({
    items: [{ content: { url: "https://github.com/xchromo/osn/issues/466" } }, { content: {} }],
  });
  expect(parseBoard(json)).toEqual(new Set(["https://github.com/xchromo/osn/issues/466"]));
});

test("adds only what is missing, so a re-run is free", () => {
  const all = ["a", "b", "c"];
  expect(pending(all, new Set(["b"]))).toEqual(["a", "c"]);
  expect(pending(all, new Set(all))).toEqual([]);
});

test("an add that says the item is already there is not a failure", () => {
  const duplicate = new Error(
    "gh project failed (1): GraphQL: Content already exists in this project (addProjectV2ItemById)",
  );
  expect(alreadyOnBoard(duplicate)).toBe(true);
  expect(
    alreadyOnBoard(new Error("gh project failed (1): GraphQL: Could not resolve to a node")),
  ).toBe(false);
  expect(alreadyOnBoard("Content already exists in this project")).toBe(false);
});

test("the hourly allowance running out is told apart from a real failure", () => {
  const spent = new Error(
    "gh project failed (1): GraphQL: API rate limit already exceeded for user ID 12794440.",
  );
  expect(rateLimited(spent)).toBe(true);
  expect(alreadyOnBoard(spent)).toBe(false);
  expect(
    rateLimited(new Error("gh project failed (1): GraphQL: Could not resolve to a node")),
  ).toBe(false);
});
