---
"@tools/lab": patch
---

Gate every component-lab story in CI. `tools/lab/tests/stories.test.tsx` imports
every file the registry globs match and renders each story that can run
headless, so a bench that has silently stopped mounting fails the build instead
of appearing as an error row in the sidebar that nobody opens. A story that
needs a real browser opts out with `headless: false` in its `meta`; both
three.js stories do.

Also scope the Turborepo `test`, `test:d1` and `test:browser` caches with a
subtractive `inputs` list, so a markdown-only edit no longer busts a package's
test cache.
