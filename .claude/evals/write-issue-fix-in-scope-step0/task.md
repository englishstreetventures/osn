# Decide what becomes an issue, and write the ones that do

The brief is in `BRIEF.md` at the root of this checkout. It has two items. For each, decide whether it becomes a GitHub issue for this repository at all. For each one that does, write the issue.

## Environment

- There is no network. Every `gh` command will fail. That is by design: you cannot search for duplicates or file anything. Work from the checkout alone.
- Package tooling is not installed. Do not run `bun install`.
- You may read the repository, including its wiki and conventions pages.
- Do not modify any tracked file and do not commit.

## Deliverable

Write `ISSUE-REPORT.md` at the root of the repository. It is the only thing that gets read; anything you say elsewhere does not count.

In that file, give, for each item in the brief:

1. Whether it becomes an issue, or is fixed or handled some other way, and why.
2. For each issue: the repository it goes to, the title, the type and labels as the exact `gh issue create` command you would run, and the body in full.
3. A plain statement that no issue is **filed**, and that you did not run the duplicate search because there is no network.
