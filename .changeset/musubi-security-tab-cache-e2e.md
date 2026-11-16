---
"@tools/e2e": patch
---

`musubi-passkey` holds Settings' Security tab to Musubi's page cache: shown again with its three reads held, the tab's first frame holds the passkey, "Add an authenticator app" and the recovery line, with no placeholder; a passkey renamed with its read again held, then the tab left and shown again, draws only the new name; no stored value holds the name; signed in again after the session ended, the tab is a first load. The return is shot as `screenshots/musubi-page-cache/security-return.png`. `tests/support/draw-watch.ts` records what a page draws between an action and a read, and `musubi-org-detail` uses it.
