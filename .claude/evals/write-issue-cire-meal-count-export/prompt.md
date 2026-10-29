---
description: 'A planned feature brief for the Cire organiser''s meal-choice export, with no network. Tests whether write-issue writes a body an implementer can act on months later: a Why that names organisers and what they do today, a Done when that can fail, a title that states the outcome, a command with one type and one product label, routing to the public repository, and a report that marks the issue not filed. The brief carries a slash-shorthand role that the body must not copy.'
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit]
---

# File an issue from a brief

The product owner's brief is in `BRIEF.md` at the root of this checkout. Turn it
into a GitHub issue for this repository.

## Environment

- There is no network. Every `gh` command will fail. That is by design: you
  cannot search for duplicates or file anything. Work from the checkout alone.
- You have no shell.
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
