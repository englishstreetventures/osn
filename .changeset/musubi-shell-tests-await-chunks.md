---
"@musubi/social": patch
---

The browser tests that wait for a shell to arrive now await the shell's chunks first, through `tests/test-support/shell-chunks.ts`, and give `waitFor` only the render after them. A slow dev-server transform on a busy CI runner costs time, not a failed run, and each case passes when run on its own. The signed-in file's 10-second shell budget goes with it.
