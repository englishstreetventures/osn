---
"@osn/client": patch
"@osn/social": patch
---

Fix registration leaving the browser with no session, which sent a
`prompt=create` sign-in back to the create-account screen.

`@osn/client`'s registration calls ran on `fetch`'s default `same-origin`
credentials mode. The issuer is a different origin from every app that calls it
(`musubi.social` → `id.musubi.social`), and a cross-origin fetch in that mode
does not process the response's `Set-Cookie` at all — so the browser silently
discarded the refresh cookie that `POST /register/complete` sets. That cookie is
the only place the refresh token exists (the body carries the access token and
nothing else), so a brand-new account finished registration holding an in-memory
access token and no session: a reload signed it straight back out, and a relying
party's `prompt=create` journey landed back on the consent screen's sign-up
panel, because `/authorize/context` still reported a signed-out browser. Adds
`credentials: "include"`, which every other cookie-setting route in the package
(`login`, `recovery`, `/token`) already sent, and pins it with a test.

`AuthorizePage` also stops leading with sign-up on re-entry. `reason=create`
stays in the URL after the account exists, so anything that returns the user to
the sign-in screen — a `login_required` replay, a refused decision — reopened
"Create your OSN account" at someone who had just made one. `initialMode` is now
gated on whether a ceremony has already happened on the page.
