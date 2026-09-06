# Performance-review `feat/cire-vendor-enquiries-and-directory`

You are in a checkout of the repository, on the branch `feat/cire-vendor-enquiries-and-directory`. It adds the vendor enquiry routes and the directory service on the API side, and the claim and listing-editor screens of the vendor portal.

Review the branch for performance to whatever standard this repository holds a branch to before it merges. Correctness, security and test coverage are somebody else's pass; what this one has to find is work the code pays for and does not need to.

## Environment

- There is no network. `git push`, `git fetch` and every `gh` command will fail. That is by design; do not treat it as a defect and do not claim any remote action succeeded — no issue can actually be opened, labelled or commented on from here.
- Package tooling is not installed. Do not run `bun install`, the test suite, or any other interactive CLI — read the code instead.
- Do not modify source files and do not commit anything. Review; don't fix.

## Deliverable

Write your review to `PERFORMANCE-REVIEW.md` at the root of the repository. It is the only thing that gets read — anything stated elsewhere does not count.
