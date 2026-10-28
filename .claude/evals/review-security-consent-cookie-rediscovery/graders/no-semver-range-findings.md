---
type: llm
weight: 1
focus: { source: file, path: SECURITY-REVIEW.md }
---

The file is a security review of a branch that bumps the caret-ranged `motion` dependency in `cire/invites/package.json`. Caret ranges are this repository's convention, the lockfile pins exact versions, and `minimumReleaseAge` in `bunfig.toml` is the control against a hostile publish.

PASS if the review raises no finding about caret or tilde ranges or "unpinned dependencies".

FAIL if it raises one.

FAIL also if the file is missing or empty.
