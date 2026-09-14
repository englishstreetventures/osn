---
"@musubi/social": minor
"@osn/ui": minor
"@osn/client": patch
---

Show account-health banners on every route, and offer recovery codes to accounts
that have none.

The security-events banner used to render from one place, the Settings page, so
a user who never opened Settings never learned that a recovery code had been
generated or used on their account — which is most of what that banner is for,
since it is the channel that still works when the notice email is filtered or
the mailbox is the attacker's. It now mounts in the application shell.

Alongside it, a new prompt offers recovery-code setup to an account that has
never generated a set, linking to Settings → Security. An account finishes
signup with one passkey and nothing else, and a recovery code is the only way
back in that needs neither the mailbox nor a second device.

Only one of the two shows at a time and security events win: an unacknowledged
event costs a step-up ceremony to clear, so it persists, and most event kinds
sit happily on an account with no recovery codes. The prompt's dismissal is kept
per profile, so a shared device does not hide it from the next person, and
nothing caches "this account has codes" — scheduling an account deletion erases
them and cancelling restores the account without re-minting.

`SecurityEventsBanner` gains an optional `onVisibleCountChange`, which is how a
host stacking its own banners underneath knows whether this one is showing, and
now renders nothing instead of throwing when its list cannot be read: a Solid
resource rethrows on read, and in an application shell that would blank every
route rather than one page.

The Settings page's tabs now follow the router's location rather than a
`hashchange` listener. Neither `pushState` nor `replaceState` fires that event,
so a link to `/settings#security` from a page that was already `/settings`
changed the address bar and left the tab where it was.

`@simplewebauthn/browser` stays out of the entry chunk: the banners sit behind a
session check and a dynamic import, in that order, and the gate's static imports
are pinned to an allowlist by `musubi/social/tests/webauthn-chunks.test.ts`.
