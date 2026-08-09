# A5 notes — Pulse iOS app shell

Verified/not-verified/BLOCKED per DoD item. "It compiles" is not evidence of correctness — flagged where that's all I have.

## DoD 1 — `swift build` / `swift test` from `shared/swift/OSNShared`

**Verified.** `swift build`: clean, only pre-existing deprecation warnings in `Plugins/PulseAPIGeneratorPlugin/plugin.swift` (predates this session, not touched here — `git log` shows both its commits, `27f01ed8`/`b1d0edd2`, before this branch's work started). `swift test`, full and unfiltered: `Test run with 40 tests in 7 suites passed`, 0 failures. `PulseFeatureTests` alone: 8/8 passed.

## DoD 2 — `xcodegen generate && xcodebuild -scheme Pulse -destination 'generic/platform=iOS Simulator' ... build`

**FAILED. Not fixed. Reporting as a genuine, unresolved failure, not a pass.**

`xcodegen generate` succeeds. The mandated `xcodebuild` command fails:

```
.../SourcePackages/checkouts/swift-openapi-generator/Sources/_OpenAPIGeneratorCore/PlatformChecks.swift:21:5:
error: _OpenAPIGeneratorCore is only to be used by swift-openapi-generator itself—your target
should not link this library or the command line tool directly.
** BUILD FAILED **
```

Root cause, read from `PlatformChecks.swift` itself:

```swift
#if (os(iOS) && !targetEnvironment(macCatalyst)) || os(tvOS) || os(watchOS) || os(visionOS)
#error("_OpenAPIGeneratorCore is only to be used by swift-openapi-generator itself…")
#endif
```

A compile-time guard, not a link error despite the wording. It fires because Xcode's package-graph resolution is building `_OpenAPIGeneratorCore` — an internal library of the `swift-openapi-generator` package, pulled in only as the *host* build-tool the `PulseAPIGeneratorPlugin` runs at build time — for the iOS platform, not just macOS. `swift build`/`swift test` never hit this: SwiftPM's CLI plugin resolution builds tool dependencies host-only. Xcode's does not, for this package shape.

Checked and ruled out:
- **Not a stale-DerivedData artifact.** `rm -rf ~/Library/Developer/Xcode/DerivedData/Pulse-*`, reran — same failure, identical location.
- **Not specific to the `generic/platform=iOS Simulator` destination.** Reran with a concrete device destination (`platform=iOS Simulator,id=<iPhone 16 sim>`) — same failure. It's an iOS-platform-vs-macOS-host resolution issue in general, not a generic-destination quirk.
- **Not caused by a stray direct link to `_OpenAPIGeneratorCore`.** `Package.swift` and `pulse/ios/project.yml` were read line-by-line: `PulseAPI` depends only on `OpenAPIRuntime`/`OpenAPIURLSession`/`HTTPTypes` plus the `PulseAPIGeneratorPlugin` build-tool plugin; the plugin depends only on the `swift-openapi-generator` *product* (the CLI tool), never on `_OpenAPIGeneratorCore` directly. No target in this repo references `_OpenAPIGeneratorCore`.
- **Not a stale dependency pin.** `Package.resolved` pins `swift-openapi-generator` at `1.13.0` (current at time of writing), not an old version with a known-fixed bug.

Never previously exercised: `a3-notes.md` and `a4-notes.md` both have zero mentions of `xcodebuild`, `_OpenAPIGeneratorCore`, or `CODE_SIGNING` — no prior brief recorded running this exact command. And `git diff HEAD -- pulse/ios/project.yml` shows why it couldn't have been triggered before: prior to this brief, the `Pulse` app target's only `OSNShared` product dependency was `OSNKit`. `PulseAPI` (and therefore `PulseAPIGeneratorPlugin` and its `swift-openapi-generator` build-tool dependency) was never part of the app's build graph until deliverable 1 added it. So this is a real, pre-existing Xcode/SwiftPM incompatibility for this package shape, first exposed — not caused — by wiring `PulseFeature`/`PulseAPI` into the app target, which is exactly what this brief asked for.

No fix attempted beyond diagnosis: the plugin (`Plugins/PulseAPIGeneratorPlugin/plugin.swift`) predates this session and is out of this brief's scope, and restructuring how `swift-openapi-generator` is consumed (e.g. switching to a prebuilt binary target, or patching the upstream package) is an infrastructure decision, not something to invent unauthorized per the brief's rules. Flagging for whoever owns CI/pulse-ios tooling next.

### Resolved afterwards — the custom plugin was the cause

Reproduced independently, then fixed. Three things the diagnosis above was missing:

1. **`_OpenAPIGeneratorCore` is a public library product** of `swift-openapi-generator`, and upstream deliberately declares `.iOS(.v13)` etc. on the package "to allow the generator to emit a more descriptive compiler error". That is why Xcode is *able* to build it for the simulator at all.
2. **The dependency edge decided the platform.** `PulseAPIGeneratorPlugin` depended on the generator's **executable product** across a package boundary; Xcode materialised that product's graph for the destination platform. The unquiet log is explicit — `_OpenAPIGeneratorCore` compiled `-sdk .../iPhoneSimulator26.5.sdk -target arm64-apple-ios13.0-simulator` into `Debug-iphonesimulator`, while `ArgumentParser` in the same build compiled host-correctly for `arm64-apple-macos10.13`. Upstream's own `OpenAPIGenerator` plugin instead depends on the executable **target**, in-package, which Xcode resolves host-only.
3. **The destination form is not the trigger.** A concrete `platform=iOS Simulator,id=DB521367-…` (iPhone 17 Pro, OS 26.5) with `~/Library/Developer/Xcode/DerivedData/Pulse-*` deleted first fails identically — so this is not the `-sdk` artifact of apple/swift-openapi-generator#527.

The fix, applied here: drop the custom plugin entirely and use the official one. `Sources/PulseAPI/openapi.json` is a **relative symlink** to `../../../../openapi/pulse.json` — the spec being outside the package was the whole reason a custom plugin existed, and a symlink satisfies the official plugin's same-directory discovery without a second copy that can drift. `Sources/PulseAPI/openapi-generator-config.yaml` carries the flags the custom plugin passed on the command line (`types`, `client`, `public`, `idiomatic`), so the generated code is unchanged.

Two follow-on facts, both real, neither optional:

- CI now needs **`-skipPackagePluginValidation`**. A plugin from a *remote* package is a trust decision in Xcode; headless it hard-fails with `Validate plug-in "OpenAPIGenerator" in package "swift-openapi-generator"`. Version is pinned in `Package.resolved`, so consenting on the runner doesn't widen what can run. Commented at the call site in `.github/workflows/ci-swift.yml`.
- With the generator error out of the way the gate exposed a **real** Swift 6 error underneath it, which had never been reachable before: `App.swift:38:5: error: main actor-isolated synchronous static method 'keyWindowAnchor()' cannot be marked as '@Sendable'`. The provider can only ever be answered by a main-actor key-window lookup, and `PasskeyCeremony.perform` and every `OSNAuth` client entry point are already `@MainActor`, so `PresentationAnchorProvider` is now `@MainActor @Sendable () -> ASPresentationAnchor` and the app's static method is `@MainActor` instead of `@Sendable`.

Verified after the change: `swift build` clean, `swift test` `Test run with 40 tests in 7 suites passed`, and the exact CI command (plus `-skipPackagePluginValidation`) exits 0 with zero `error:` lines.

## DoD 3 — every Pulse call through `makePulseClient`

Satisfied by construction: `PulseSession.api` is the only source of an `APIProtocol` handed to `ExploreViewModel`/`EventDetailViewModel`/`SignInView`, and it's built once via `makePulseClient` in `PulseSession.init`. No view or view model constructs a client itself.

## DoD 4 — no feature view holds an access token

Satisfied by construction: `SignInView`, `ExploreView`, `EventDetailView`, `PulseRootView` hold a `PulseSession`/`APIProtocol`/domain models only. Token custody stays inside `OSNAuth`'s keychain store, behind `PulseSession`.

## DoD 5 — generated type names match `Types.swift` verbatim

Directly confirmed by reading the generated file, not inferred: `EventsPayloadPayload` (`DiscoverEvents`), `RsvpPayload` (`RsvpToEvent`), `CountsPayload` (`GetEventRsvpCounts`) — all field names, types, and enum cases in `PulseModels.swift` and the new tests match the `.build/plugins/outputs/.../GeneratedSources/Types.swift` declarations exactly, including each struct's explicit `public init(...)`, whose parameter order is alphabetical by field name (not grouping order) — caught two argument-order mismatches in test code against this before it ever reached the compiler, fixed both.

## DoD 6 — tests for testable logic

**Verified**, model layer only. `Tests/PulseFeatureTests/PulseModelsTests.swift`, 8 tests, all passing: `PulseEvent.init(_:)` field mapping and full status-enum coverage, `Array.keysetCursor` (empty + non-empty), `PulseRsvpTarget.generated` mapping, `PulseRsvp.init(optimistic:...)`, `PulseRsvp.init(_:)` decoding, `PulseRsvpCounts.init(_:)` rounding.

**Not tested — scope decision, not an oversight:** view-model async logic (`ExploreViewModel`'s pagination-cursor progression, `EventDetailViewModel`'s optimistic-update/rollback on RSVP). Both call through `APIProtocol`, which has no in-repo fake/mock implementation, and the brief prohibits inventing infrastructure (a fake conforming to the full generated `APIProtocol` is a non-trivial surface, not a small fixture). Left for whoever picks this up next to decide whether that's worth building; the pure mapping logic those view models rely on (this file) is tested.

## DoD 7 — public types carry a doc comment on the correct declaration

Applied: `PulseSession`, `SignInView`, `PulseRootView`, `ExploreView`/`ExploreViewModel`, `EventDetailView`/`EventDetailViewModel` each carry one, on the type itself (checked against the `GlassButton`/`GlassButtonKind` mistake found and fixed in A4's own review — comment placed on the struct, not a nested/adjacent type).

## DoD 8 — no mock/stub data, no invented identifiers

No `BLOCKED:` was needed this brief — no identifier had to be invented. Test fixtures (`"event-1"`, `"Rooftop Party"`, etc.) are literal values inside `PulseModelsTests.swift` only, not app source — standard unit-test fixtures, not the mock-data-in-source the rule targets.

## Known field-shape gaps vs. the brief's assumed shapes

- `EventDetailView` renders `status == .cancelled` as a plain "Cancelled" pill; the real generated `EventsPayloadPayload`/detail payload has no `cancellationReason` field, so none is shown — the brief's mention of a cancellation reason doesn't match what the API actually returns.
- `RsvpPayload.StatusPayload` has 4 cases (`going`, `maybe`, `notGoing` — wire key `not_going` — `invited`); `PulseRsvpTarget` (the user-actionable subset) has 3, matching the three RSVP buttons in `EventDetailView`. `invited` is a receive-only status, never a target.

## Stale SourceKit diagnostics (recurring, not real)

Same pattern as A3/A4: after writing new files, editor-style "No such module 'Testing'"/similar diagnostics appeared transiently and were contradicted by the next real `swift build`/`swift test` run every time. Not trusted as evidence on their own anywhere in this brief; only real command output is cited above.

## `.textInputAutocapitalization` / macOS build

`SignInView`'s `.textInputAutocapitalization(.never)` is iOS-only API, gated behind `#if os(iOS)` — required, since `swift build`/`swift test` compile this package against the macOS SDK too (per this package's own `Package.swift` header comment) and that modifier doesn't exist there.
