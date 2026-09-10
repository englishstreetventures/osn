---
"@osn/api": patch
"@osn/client": minor
"@osn/ui": patch
---

The post-recovery passkey-enrolment screen now gets the whole fifteen minutes the
restricted session grants, instead of dying after five.

Two deadlines were in play and only the shorter reached the browser. The session
row lives `RECOVERY_SESSION_TTL_SEC` (900 s); the access token in the same
response was signed with `accessTokenTtl` (300 s). `<RecoveryLoginForm>` holds
that session without adopting it — it must, because `@musubi/social` unmounts the
flow the moment a session is published, and a `aud: "osn-recovery"` token is one
every ordinary route rejects. Holding it also puts the flow outside `authFetch`,
where silent refresh lives. So a user who read the screen for six minutes and
pressed "Add a passkey" sent a dead bearer and got a 401, with ten minutes of
their window unspent.

`@osn/client` gains `refreshHeldSession`: a `/token` grant that returns a fresh
token set **without adopting it**. It reuses the existing single-flight grant, so
a held-session refresh and a cold-start bootstrap still produce one request —
two would replay a rotated cookie, which is what revokes a session family.
`<RecoveryLoginForm>` refreshes 30 s before each token expires.

`refreshHeldSession` resolves to a new exported `HeldSession` — `{ held: true;
session: Session }` — rather than a bare `Session`. `adoptSession` and
`setSession` still take a plain `Session`, so a caller cannot write
`adoptSession(await refreshHeldSession())`: that is precisely the mistake
holding rather than adopting exists to rule out, and it is now a compile error
instead of a token minted for the recovery audience getting published as an
ordinary session. Every caller unwraps `.session` once it has decided to keep
holding it.

`@osn/api` caps a restricted session's access token at the life its own row has
left, at both issuance sites. Rotation carries the absolute deadline forward
rather than extending it, so without the cap a grant late in the window minted a
full-length token outliving the row behind it. Nothing was granted by such a
token — the enrolment bypass tests the row, not the token — but the browser was
told a deadline the server would not honour, and the screen showed a live button
that every request refused. Capped, the last token of the window expires exactly
when the row does, so the timed-out screen and the session's death coincide and
the client needs no copy of the fifteen minutes. An ordinary session is
untouched: the cap only ever applies where `restricted_until` is set.

The refresh loop is bounded by the server rather than by a client-side constant:
once a token arrives with less than the refresh lead on it, that token is the
deadline and the screen waits it out. A refused grant is retried on a halving
gap first, because `@osn/client` reports a transient 5xx exactly like a dead
cookie and giving up on the first refusal would cost the user the window this
change exists to return.
