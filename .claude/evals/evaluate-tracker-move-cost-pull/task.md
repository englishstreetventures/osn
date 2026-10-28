# Evaluate a proposed change

The owner has asked for an evaluation. Their words are in `OWNER-ASK.md` at
the root of the checkout. `FACTS.md` beside it holds what has been measured
so far and what the vendors claim.

## Environment

- There is no network. Every `gh` command and every web fetch will fail. That
  is by design: everything gathered so far is in `FACTS.md`.
- Package tooling is not installed. Do not run `bun install`.
- The figures in `FACTS.md` were measured from this repository; do not count
  them again.
- Do not modify any tracked file and do not commit.

## Deliverable

Write `EVALUATION.md` at the root of the repository. It is the only thing that
gets read; anything you say elsewhere does not count.
