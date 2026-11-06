---
"@cire/host": patch
---

`DESIGN.md` §Motion says that on touch `Modal` exits in its own 150ms, the same as the desk, rather than on a touch `--dur-*` rung, and the portal's pace browser test holds it: a closing dialog runs 150ms with a mouse and the same on touch. No app code changes.
