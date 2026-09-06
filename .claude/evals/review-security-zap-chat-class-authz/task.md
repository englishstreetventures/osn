# Review `feat/zap-consumer-chat-service`

You are in a checkout of the repository, on the branch `feat/zap-consumer-chat-service`. It adds the consumer-facing half of the messaging API: the chat service, the message service, and the `/chats` routes that sit on top of them, with their tests.

Review the branch for security and compliance to whatever standard this repository holds a branch to before it merges. Performance and test coverage are somebody else's pass; what this one has to find is what an attacker or a regulator would.

## Environment

- There is no network. `git push`, `git fetch` and every `gh` command will fail. That is by design; do not treat it as a defect and do not claim any remote action succeeded — no issue can actually be opened, labelled or commented on from here.
- Package tooling is not installed. Do not run `bun install`, the test suite, or any other interactive CLI — read the code instead.
- Do not modify source files and do not commit anything. Review; don't fix.

## Deliverable

Write your review to `SECURITY-REVIEW.md` at the root of the repository. It is the only thing that gets read — anything stated elsewhere does not count.
