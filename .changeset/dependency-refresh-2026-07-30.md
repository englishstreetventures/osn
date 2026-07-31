---
"@osn/api": patch
"@osn/client": patch
"@osn/db": patch
"@osn/landing": patch
"@osn/social": patch
"@osn/ui": patch
"@pulse/api": patch
"@pulse/app": patch
"@pulse/db": patch
"@pulse/landing": patch
"@shared/crypto": patch
"@shared/db-utils": patch
"@shared/email": patch
"@shared/feature-flags": patch
"@shared/observability": patch
"@shared/osn-auth-client": patch
"@shared/rate-limit": patch
"@shared/redis": patch
"@shared/rp-auth": patch
"@shared/turnstile": patch
"@zap/api": patch
"@zap/db": patch
---

Refresh dependencies across the monorepo (routine maintenance audit).

Security-relevant: `@simplewebauthn/server` 13.3.0 → 13.3.2 closes
GHSA-6hxq-p678-4hr2 (CVSS v4 Low 2.0), where a maliciously-crafted attestation
`x5c` could present a self-signed "root certificate" rather than chaining to an
RP-specified trust anchor. Reached through `verifyRegistrationResponse()` on the
passkey registration path. Exposure was nil rather than merely limited: we
configure no trust anchors anywhere, so `validateCertificatePath` short-circuits
on `trustAnchorsPEM.length === 0` and no chain decision was ever made — in
13.3.0 as much as in 13.3.2. Tracked as S-L102, which also records why
`attestationType: "none"` is *not* the control here.

`jose` moves 6.2.3 → 6.2.4 only, which is a docs update plus an `exportJWK`
refactor that drops `undefined`-valued properties. That change is inert for us:
`exportKeyToJwk` immediately `JSON.stringify`s its result, and `thumbprintKid`
feeds RFC 7638 canonicalisation over `kty`/`crv`/`x`/`y`, so existing `kid`s and
stored JWKs are byte-identical. The JOSE input-validation hardening (Base64URL
alphabet, UTF-8 in headers and claims, truncated ASN.1 key data, duplicate
`crit`) is in **6.2.5**, which this branch does *not* take — it published
2026-07-29 and is inside the 3-day quarantine. That upgrade is tracked
separately and matters, since `jose` sits under both ARC S2S tokens and the
5-minute `osn-access` JWTs.

`effect` 3.21.2 → 3.22.0 (deprecates `Graph.neighborsDirected`, unused here),
with `@effect/vitest` 0.29 → 0.30 and `@effect/opentelemetry` 0.63 → 0.64
following its `^3.22.0` peer. `@effect/platform` is now an explicit
`@shared/observability` dependency at `^0.97.0`: it was previously auto-installed
at 0.94.5 purely to satisfy `@effect/opentelemetry`'s peer and did not actually
meet it.

`oxlint` 1.70 → 1.76 makes `vitest/expect-expect` effective inside `it.effect`
bodies for the first time — the rule was already configured with
`additionalTestBlockFunctions`, but earlier versions never walked those blocks.
Ten `@osn/api` tests (of 644) were relying on "the Effect didn't fail" as their
only assertion; each now asserts the behaviour its name claims, with no change
to what is under test.

The `@opentelemetry/*` SDK packages are held at `~2.9.0` rather than moved to
2.10.0. The exporters and `sdk-logs` cannot follow yet — 0.221.0 is inside the
14-day minor window — and the 0.220.0 exporters pin `core`/`resources`/
`sdk-metrics`/`sdk-trace` to exactly 2.9.0, so taking only the SDK half splits
the tree across two lines and links 2.10.0 packages against `core@2.9.0`. The
tilde is deliberate: `^2.9.0` still admits 2.10.0. The whole line moves together
once the exporters are eligible (2026-08-04).

The root `esbuild` override rises `^0.27.0` → `^0.28.1`, closing
GHSA-g7r4-m6w7-qqqr. The override had inverted from protective to harmful:
wrangler 4.114 pins `esbuild 0.28.1` — the fixed version — and the `^0.27.0`
floor was clamping the whole tree back down to the vulnerable 0.27.7. astro
already declares `^0.28.0`, so `^0.28.1` now agrees with both consumers instead
of fighting either. `bun audit` reports no vulnerabilities.

`oxfmt` 0.44 → 0.59 spans four breaking formatter changes, but produces no
output change here: the `fmt` script already excludes CSS, astro and markdown,
and the `sort_imports` reclassification of subpath imports matches nothing in
the tree. `bun run fmt` is a no-op on the current sources and `fmt:check` is
clean. 0.60/0.61 stay out until they clear the 14-day minor window.

Everything else is a patch/minor bugfix bump with no migration steps.
