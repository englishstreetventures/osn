---
title: iOS apps
description: The Swift stack — one shared package, two app targets (Pulse, Musubi), one session
tags: [app, ios, swift, auth]
related:
  - "[[sessions]]"
  - "[[identity-model]]"
  - "[[passkey-primary]]"
  - "[[step-up]]"
  - "[[recovery-codes]]"
  - "[[pulse]]"
  - "[[osn-core]]"
packages:
  - OSNShared
last-reviewed: 2026-08-13
---

# iOS apps

Two native apps, one Swift package. **Pulse** (`pulse/ios`) is the events client; **Musubi** (`osn/ios`) is the identity client. Both are thin app targets — everything real lives in `shared/swift/OSNShared`, the way the TypeScript side keeps app code in workspace packages.

## Layout

```
shared/swift/OSNShared/        # the one local SPM package
  Sources/
    OSNKit/                    # Environment, SharedCookieJar, TokenRefresher, Keychain
    OSNAuth/                   # passkey ceremonies (register, login, step-up, manage)
    OSNTransport/              # bearer-token middleware, shared by both clients
    OSNAPI/                    # generated osn-api client (id.musubi.social)
    PulseAPI/                  # generated pulse-api client
    OSNUI/                     # Liquid Glass components + type/colour tokens
    PulseFeature/              # Pulse screens + view models
    MusubiFeature/             # Musubi screens + view models
    OSNTesting/                # test traits/helpers
pulse/ios/project.yml          # XcodeGen input — Pulse app target
osn/ios/project.yml            # XcodeGen input — Musubi app target
```

`*.xcodeproj` and `*.entitlements` are **generated and gitignored**. `xcodegen generate` in either app dir rebuilds both from the committed `project.yml`, so nobody merges a project-file conflict.

Generated API clients come from swift-openapi-generator's SPM build plugin, reading `shared/openapi/*.json`. Editing a spec changes the Swift client without touching a Swift file — which is why `shared/openapi/` is in the CI path filter.

## The shared session (the point of the whole thing)

Sign in on either app and you are signed in on both. There is one session, not one per app.

The refresh token is an HttpOnly cookie ([[sessions]]). Instead of each app holding its own cookie jar in its own sandbox, both build their `URLSession` from `SharedCookieJar.makeSession()`, whose `HTTPCookieStorage` lives in the **App Group container** `group.social.musubi.session` (`OSNKit/SharedCookieJar.swift`). One container, one cookie, both apps.

Three rules follow, and breaking any of them silently breaks sign-in:

- **The App Group string must be identical in both `project.yml` files.** A typo doesn't fail — it gives each app a private jar that looks fine until you compare the two.
- **`sharedCookieStorage(forGroupContainerIdentifier:)` doesn't fail on a missing container.** It returns storage that never shares. `makeConfiguration` checks `FileManager.containerURL` first and throws `OSNKitError.appGroupContainerUnavailable` rather than let that pass.
- **One `TokenRefresher` per jar.** Every `POST /token` grant rotates the session cookie; a second refresher over the same jar races the first and the loser replays a rotated-out cookie, which trips reuse detection and revokes the whole family — the bug PR #289 fixed on the web client. `TokenRefresher` serialises concurrent callers onto one in-flight `Task`; two *instances* defeat that. Pulse has two hosts (identity + pulse-api) and so needs care; Musubi's identity and API host are the same `Environment`, so it has exactly one.

Access tokens are the 5-minute ES256 JWTs from [[identity-model]], cached in the Keychain, never in the jar.

Refresh failure is **HTTP 400 with an `error` string, never 401**. A client that branches on 401 retries a dead session forever.

## Musubi's screens

Three tabs so far.

**Devices** — every live session on the account, with per-row revoke and "sign out everywhere else": `listSessions` / `revokeSession` / `revokeAllOtherSessions` ([[sessions]]). Built first because it needs no new API work and it is the screen that *shows* the shared jar: sign in on Pulse, and the session appears in Musubi's list.

Two contract details worth keeping:

- Session timestamps are **Unix seconds** (`osn/api/src/routes/auth/response-schemas.ts`), so the generated types are `Double`; conversion to `Date` happens once, in `MusubiDevice`.
- Whether a revoke killed *this* session is read from the server's `revokedSelf`, never inferred from the row's `isCurrent`.

**Passkeys** — list, rename, delete, add. The consumer `OSNAuth`'s `PasskeyManagementClient`, `StepUpPasskeyClient` and `PasskeyEnrollmentClient` were written for and had until now gone without. Contract details:

- Every mutation mints its **own** step-up token first ([[step-up]]) — they are single-use and short-lived, so there is nothing to cache, and one ceremony per action is what makes the action safe. Face ID *is* the confirmation; the screen adds no "are you sure?" sheet in front of it.
- **Rename mints `passkey_delete`.** The server shares one verifier for rename and delete (`osn/api/src/services/auth/step-up.ts:398-400`). A `passkey_rename` purpose does not exist and would be rejected.
- `PATCH /passkeys/:id` answers a bare `{ "success": true }`, not the updated summary, so a rename can only get its new label back by re-listing. Enrolment likewise returns just an id.
- `PasskeySummary` timestamps are Unix seconds as **`Int`** — the management routes hand back integers where the session routes hand back `Double`.
- Absent `backupEligible`/`backupState` read as **false**. Calling a passkey synced when no authenticator said so is the one wrong answer: eligible-but-unbacked means it dies with the device.
- The account invariant is ≥1 passkey ([[passkey-primary]]) and the server enforces it, so the last row offers no Remove rather than spending a biometric prompt on a refusal.
- Enrolment needs a `profileId`, and a *restored* session is `signedIn(nil)` — `PasskeyProfile` only ever arrives from a live `/login/passkey/complete`. So it comes off the wire, via `listAccountProfiles`.

**Security** — the unacknowledged security-event feed ([[recovery-codes]], [[step-up]]) with the recovery-code counts above it. Contract details:

- `GET /account/security-events` returns **unacknowledged events only**, newest first. So this is a to-read list, not a history: acknowledging removes a row and the app has no way back to it.
- Both ack routes are **step-up gated** with `security_event_ack`. That is the point of them: an XSS-captured access token must not be able to silently dismiss the banner that exists to notice that compromise. "Clear all" runs **one** ceremony for the lot — a prompt per row would train the user to tap through Face ID without reading.
- Ack-one answers `{ acknowledged: Boolean }`, ack-all answers `{ acknowledged: Number }` — same key, different type, so the two routes cannot share a schema. A `false` means the id matched nothing unacknowledged (another device got there first); it is idempotent, not an error, and the honest response is to re-list.
- `kind` is a bare string on the wire. `SecurityEventKind` keeps an `other(String)` case and renders the raw name tidied up: a kind added on the server after a build shipped must still appear, since seeing everything is the entire job of the screen.
- Event timestamps are Unix seconds as **`Double`**, like the session routes and unlike the passkey routes' `Int`.
- `POST /recovery/generate` is step-up gated (`recovery_generate`), replaces any existing set whole, and hands back 10 plaintext codes **once** — the server keeps only hashes. They live in `SecurityViewModel.freshCodes` until the sheet closes and are never written to disk. Copying uses `ShareLink`, not `UIPasteboard`, which is UIKit (see the purity rule below).
- Generating writes a `recovery_code_generate` event of its own, so the screen reloads afterwards for two reasons, not one: the counts moved *and* the feed is a row short.
- `GET /recovery/status` deliberately has **no** step-up. It carries counts, never a code, and it is what tells a user whether starting a ceremony is worth it. A failed status call therefore does not fail the screen — the feed is the point, the counts are a header.

View models take a narrow protocol (`DevicesAPI`, three methods; `PasskeysAPI`, four; `SecurityAPI`, five), not the generated `APIProtocol` (73). A test double for the latter would be 70 stubs of nothing. `OSNDevicesAPI`, `OSNPasskeysAPI` and `OSNSecurityAPI` are the only places generated shapes and ceremonies are unwrapped — which is also why the mutating methods on `PasskeysAPI` and `SecurityAPI` are `@MainActor`: `ASAuthorizationController` is.

## macOS purity rule

`platforms:` is package-level — SPM has no per-target platform — and `swift test` builds **every** target on the host. So a bare `import UIKit` anywhere in `OSNShared` fails CI with `no such module 'UIKit'` even when no test touches it.

SwiftUI and Liquid Glass exist on macOS 26, so shared UI is fine. Genuinely UIKit-only code goes behind `#if canImport(UIKit)` or into the app target — which is where the key-window `ASPresentationAnchor` lookup lives in both apps.

## CI

`.github/workflows/ci-swift.yml`. macOS runner minutes bill at a multiple of Linux, so a `changes` job diffs the paths first and the macOS job runs only when `shared/swift/`, `shared/openapi/`, `pulse/ios/`, `osn/ios/` or the workflow itself moved. A diff that can't be computed means *run*, not skip.

The macOS job is `swift test`, then XcodeGen + `xcodebuild` for **each** app. Both apps get their own build: they share every library target, so a break confined to one app target (an entitlement, a product only it depends on) would otherwise reach main under a green tick.

No `branches:` filter on `pull_request` — these phases ship as stacked PRs, so a PR's base is usually the branch below it.

## Changesets

A PR touching only `shared/swift/`, `pulse/ios/`, `osn/ios/`, `.github/`, `scripts/`, `wiki/` or `docs/` needs **no changeset** — no versioned package ships. Enforced as an allowlist in `scripts/changeset-required.sh`.

## Blocked on the Apple developer portal

Neither app codesigns until these exist under team `FV59Y8RSUH`:

| Capability | Value | Needed for |
|---|---|---|
| App Group | `group.social.musubi.session` | the shared cookie jar — both apps |
| Associated domain | `webcredentials:musubi.social` | passkey ceremonies (RP ID is `musubi.social`) |
| Bundle ids | `com.osn.pulse`, `social.musubi.app` | — |

CI builds with `CODE_SIGNING_ALLOWED=NO`, so it stays green meanwhile; a device build does not.

## Related

- [[sessions]] — session model, rotation, reuse detection, revocation endpoints
- [[passkey-primary]] — the only primary login factor
- [[identity-model]] — access tokens, the 5-minute TTL, JWKS
- [[pulse]] — the events stack the Pulse app talks to
- [[osn-core]] — the identity stack Musubi talks to
