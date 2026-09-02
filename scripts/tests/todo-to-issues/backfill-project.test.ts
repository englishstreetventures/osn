import { expect, test } from "bun:test";

import {
  alreadyOnBoard,
  ghError,
  parseBoard,
  parseIssues,
  pending,
  rateLimited,
} from "../../todo-to-issues/backfill-project";

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

// `gh` used to hand-roll a spawn and build this message itself. It now runs
// through `$`, and `$` is why this test exists: a ShellError's message is
// exactly "Failed with exit code 1" — stderr sits on `.stderr` and never
// reaches the message. So `gh` uses `.nothrow()` and rebuilds the message.
// Let `$` throw its own error instead and the two classifiers below both go
// quiet: an "already exists" stops being a no-op and aborts the run, and a
// rate limit stops being a resumable pause. That failure is silent, which is
// why the message shape is pinned here rather than left to the refactor.
test("gh's error message carries stderr, so the classifiers can read it", () => {
  const error = ghError(
    ["project", "item-add"],
    1,
    "GraphQL: Content already exists in this project (addProjectV2ItemById)\n",
  );

  expect(error.message).toBe(
    "gh project failed (1): GraphQL: Content already exists in this project (addProjectV2ItemById)",
  );
  expect(alreadyOnBoard(error)).toBe(true);
  expect(rateLimited(error)).toBe(false);
});

test("a rate-limited stderr is classified as resumable, not fatal", () => {
  const error = ghError(["project", "item-add"], 1, "GraphQL: API rate limit already exceeded\n");

  expect(rateLimited(error)).toBe(true);
  expect(alreadyOnBoard(error)).toBe(false);
});
