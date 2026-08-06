// swift-tools-version: 6.2
import PackageDescription

// Every target here must compile against the macOS SDK, not only iOS.
// `platforms:` is package-level — SPM has no per-target platform — and
// `swift test` builds all targets on the host, so a bare `import UIKit`
// anywhere in this package fails CI with `no such module 'UIKit'` even when no
// test depends on it. SwiftUI and the Liquid Glass APIs exist on macOS 26, so
// shared UI is fine; anything genuinely UIKit-only goes behind
// `#if canImport(UIKit)` and lives in the app target or a feature package.

let package = Package(
    name: "OSNShared",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "OSNKit", targets: ["OSNKit"]),
        .library(name: "OSNAuth", targets: ["OSNAuth"]),
        .library(name: "OSNUI", targets: ["OSNUI"]),
        .library(name: "OSNTesting", targets: ["OSNTesting"]),
    ],
    targets: [
        .target(name: "OSNKit"),
        .target(name: "OSNAuth", dependencies: ["OSNKit"]),
        .target(name: "OSNUI"),
        .target(name: "OSNTesting", dependencies: ["OSNKit"]),
        .testTarget(name: "OSNKitTests", dependencies: ["OSNKit"]),
    ]
)
