---
"@cire/api": patch
"@cire/db": patch
"@cire/host": patch
"@cire/invites": patch
"@cire/landing": patch
"@cire/ui": patch
"@cire/vendor": patch
"@tools/pr-metrics": patch
---

Name the GitHub organisation as `englishstventures` wherever a comment or
test cites a repository or issue, in place of the old `xchromo` owner. In
`@tools/pr-metrics` the default repository and the test fixtures' owner login
now use the new name, so the same-repository check matches what the GitHub API
returns.
