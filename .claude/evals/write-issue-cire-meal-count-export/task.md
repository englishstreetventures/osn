# File an issue from a brief

The product owner's brief is in `BRIEF.md` at the root of this checkout. Turn it
into a GitHub issue for this repository.

## Environment

- There is no network. Every `gh` command will fail. That is by design: you
  cannot search for duplicates or file anything. Work from the checkout alone.
- Package tooling is not installed. Do not run `bun install`.
- You may read the repository, including its wiki and conventions pages.
- Do not modify any tracked file and do not commit.

## Deliverable

Write `ISSUE-REPORT.md` at the root of the repository. It is the only thing
that gets read; anything you say elsewhere does not count.

In that file, give:

1. The repository the issue goes to, and why.
2. The title.
3. The type, and the labels, as the exact `gh issue create` command you would
   run. Use the body file you would pass to it.
4. The issue body, in full.
5. A plain statement that the issue is **not filed**, and that you did not run
   the duplicate search because there is no network.
