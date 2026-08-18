---
"@osn/client": patch
"@osn/social": patch
"@osn/ui": patch
---

Type the WebAuthn challenge options through the step-up chain, and close the
anti-slop ratchet at 12 of 15 rules.

`StepUpClient.passkeyBegin` resolved with `{ options: unknown }` and the
`@osn/ui` ceremony props took `unknown`, so every host had to assert its way
back to a usable type. Three `@osn/social` call sites carried a byte-identical
`options as Parameters<typeof startAuthentication>[0]["optionsJSON"]`, and the
`RunPasskeyCeremony` doc comment told callers to write it.

`passkeyBegin` now returns the standard lib.dom
`PublicKeyCredentialRequestOptionsJSON` — the same shape
`PasskeysClient.registerBegin` already returns for the enrolment half of the
same flow — and `RunPasskeyCeremony` / `RunPasskeyRegistration` take the
matching request/creation types.

One assertion per ceremony kind has to survive: `@simplewebauthn/browser`
re-declares both dictionaries with narrower members (`userVerification` as
`UserVerificationRequirement` rather than lib.dom's `string`, `hints` as
`PublicKeyCredentialHint[]` rather than `string[]`), so lib.dom is not
assignable to it. Both now live in one documented `@osn/social` adapter,
`src/lib/webauthn.ts`, imported by the two lazy Settings chunks — so
`@simplewebauthn/browser` still stays out of the main bundle (P-I1).

The three remaining anti-slop rules are marked non-adopted rather than
deferred, with measured src/test counts and a rationale each:
`require-safety-comment-for-type-assertion` (636/2158) would mandate 636
hand-written comments; `no-runtime-typeof` (378/137) fires on ordinary inline
narrowing and SSR capability probes, and its `allowInTypeGuards` option spares
only 40; `no-unknown-parameters` (149/134) fires on type-guard predicates,
whose parameter must be `unknown` to guard anything, and exposes no options to
say so.
