---
description: 'The same consent framework with both defects fixed: the cookie is written under a `__Host-` prefix and a granted-to-revoked transition reloads to tear down third-party code. The bare cookie name is still exported as a read fallback. Tests whether a review reports what the code does rather than pattern-matching the two defects this shape of module is usually reported for.'
max_turns: 200
timeout_seconds: 3600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Write, Edit]
---

# Review `feat/cire-consent-framework`

You are in a checkout of the repository, on the branch `feat/cire-consent-framework`. It adds the site-wide cookie and third-party consent framework to the guest site: the consent record and its cookie transport, the vendor registry, the store, and the banner, gate and preferences components.

Review the branch for security and compliance to whatever standard this repository holds a branch to before it merges. Performance and test coverage are somebody else's pass; what this one has to find is what an attacker or a regulator would.

## Environment

- There is no network. `git push`, `git fetch` and every `gh` command will fail. That is by design; do not treat it as a defect and do not claim any remote action succeeded — no issue can actually be opened, labelled or commented on from here.
- Package tooling is not installed. Do not run `bun install`, the test suite, or any other interactive CLI — read the code instead.
- Do not modify source files and do not commit anything. Review; don't fix.

## Deliverable

Write your review to `SECURITY-REVIEW.md` at the root of the repository. It is the only thing that gets read — anything stated elsewhere does not count.
