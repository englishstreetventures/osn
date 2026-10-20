---
"@cire/invites": patch
---

The guest site serves `/robots.txt`, which allows every crawler every path, and a `/favicon.ico` drawn from the cire mark, both as static files. `bun run --cwd cire/invites favicon` writes the icon from `public/favicon.svg`.
