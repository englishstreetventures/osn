---
"@osn/client": minor
"@osn/social": patch
"@osn/ui": patch
"@osn/api": patch
"@pulse/api": patch
---

Backlog sweep — seven tracked findings closed, no behaviour changes beyond
each item's own scope.

**AZ-P-I2 — the authorize client had no deadline.** `createAuthorizeClient`'s
two `fetch` calls carried neither timeout nor `AbortSignal`, so a stalled
issuer left the consent screen on its spinner until the browser gave up; the
retry screen only helps once the promise settles. Both calls now take an
optional `signal` and run under a default 10s ceiling
(`DEFAULT_AUTHORIZE_TIMEOUT_MS`, overridable via `timeoutMs`). A timeout or
transport failure surfaces as a retryable `AuthorizeError` — previously a
transport failure escaped as a raw `TypeError`, contradicting the documented
error contract — while a caller's own abort is re-thrown untouched.
`AuthorizePage` aborts its in-flight context read on unmount.

**AZ-P-I1 — no `preconnect` to the issuer.** `/authorize` is a cold
cross-origin landing, so `GET /authorize/context` paid DNS + TCP + TLS before
it could start. A Vite plugin emits `<link rel="preconnect" crossorigin>` from
the resolved `VITE_OSN_ISSUER_URL`; a missing or malformed value emits no tag
rather than a dead one.

**A-L1 — the consent screen announced nothing.** `<Switch>` swapped the whole
screen without moving focus, so a screen reader was told nothing when the page
flipped to "Taking you back…" or to a terminal state. An always-mounted polite
live region announces each transition; the error screen is left to its
existing `role="alert"` rather than announced twice.

**`isAuthExpiredError()` exported from `@osn/client`.** Effect's `FiberFailure`
wrapping defeats `instanceof AuthExpiredError`, so consumers were
string-matching the printout by hand. The predicate now ships next to the error
class and can no longer drift from it.

**S-L4 — recipient email in the dev OTP log.** `logDevOtp` interpolated the
address into a free-text message, which the key-based redaction deny-list in
`@shared/observability` cannot see — the `OSN_ENV` gate was the only thing
between an OTP recipient and the log sink. The address is dropped; the
`purpose` + code stay.

**S-L30 — `createInternalGraphRoutes` had no `loggerLayer`.** Every sibling
route factory merges the observability layer into its fallback runtime; this
one did not, so anything it logged off the shared runtime went to Effect's
default logger, unredacted.

**S-L2 (series) — RRULE expansion bounds.** An `UNTIL` before `dtstart` parsed
as valid grammar and silently produced a series with zero instances; it is now
rejected when the caller knows `dtstart`. `expandRRule` returns immediately on
an empty window — a routine input, since `extend_window` passes a
now-plus-90-days horizon — and its safety valve drops from 10,000 iterations
(~70k `Date` allocations) to `MAX_SERIES_INSTANCES`, which provably cannot
truncate a legitimate expansion.

**Recovery-codes loading skeleton.** The generate button was disabled until the
first `GET /recovery/status` read settled, under a blank gap — indistinguishable
from a broken button on a slow link. A skeleton holds the status line's height
and the button reads "Checking…" while it waits.

---

**Corrections from the prep-pr reviews, applied in-branch.**

**S-M1 (security)** — the deadline and the page's unmount abort originally
covered `submitDecision` as well. That call is state-changing: it consumes the
parked request, records the consent row and mints the code. Aborting a fetch
does not un-send it, so a timeout firing mid-commit surfaced a *retryable*
error over a grant that had actually happened — Allow/Cancel became clickable
again, the next click hit a consumed request and rendered "this sign-in request
has expired", and a live consent sat in Connected apps the user believed they
had cancelled. The write now carries no default deadline and no unmount signal;
only the idempotent read does.

**P-W1 / S-L3 / T-S1 (performance + security)** — the timer was cleared when
`fetch` resolved, i.e. at response *headers*. A server that flushed headers and
then stalled mid-body escaped the deadline entirely, which is the exact
indefinite spinner the feature exists to bound. The body read moved inside the
guarded window.

**P-W2 / S-L1 (performance + security)** — the preconnect shipped
`crossorigin=""`, which is *anonymous* mode. The connection-pool key includes
the credentials flag, so an anonymous preconnect is not reused by the
`credentials: "include"` context read: it opened a second idle TLS connection
and the handshake was paid anyway — strictly worse than emitting no tag. Now
`use-credentials`.

**S-L2 (security)** — both `isAuthExpiredError` and cire's `isAuthExpired`
matched the tag anywhere in the error printout, so an error whose message
echoed a server-supplied code could decide to sign a user out. Both matches are
now anchored to the tag heading the string, which is the shape Effect actually
renders.

**P-I1 (performance)** — the new recovery-codes skeleton keyed on raw
`status.loading`, so the refetch after `acknowledge()` withdrew an
already-known count from the screen. Gated on the cold read only.

**P-I3 (performance)** — removed an unreachable branch in the money formatter's
cache lookup.

Test coverage added for each of the above, plus the gaps the test review named:
the preconnect plugin, the `aria-live` region, the unmount abort, `logDevOtp`'s
redaction, the `loggerLayer` fallback path, `timeoutMs: 0`, and the tightest
legal RRULE walk.
