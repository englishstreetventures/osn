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
        .library(name: "PulseAPI", targets: ["PulseAPI"]),
        .library(name: "PulseFeature", targets: ["PulseFeature"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.0.0"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.0.0"),
        .package(url: "https://github.com/apple/swift-http-types", from: "1.0.0"),
        .package(url: "https://github.com/apple/swift-openapi-generator", from: "1.0.0"),
    ],
    targets: [
        .target(name: "OSNKit"),
        .target(name: "OSNAuth", dependencies: ["OSNKit"]),
        .target(name: "OSNUI"),
        .target(name: "OSNTesting", dependencies: ["OSNKit"]),
        .testTarget(name: "OSNKitTests", dependencies: ["OSNKit", "OSNTesting"]),
        .testTarget(name: "OSNAuthTests", dependencies: ["OSNAuth", "OSNTesting"]),
        .target(
            name: "PulseAPI",
            dependencies: [
                "OSNKit",
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
                .product(name: "HTTPTypes", package: "swift-http-types"),
            ],
            plugins: [.plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")]
        ),
        .testTarget(name: "PulseAPITests", dependencies: ["PulseAPI", "OSNKit", "OSNTesting"]),
        .target(name: "PulseFeature", dependencies: ["OSNKit", "OSNAuth", "OSNUI", "PulseAPI"]),
        .testTarget(name: "PulseFeatureTests", dependencies: ["PulseFeature", "OSNTesting"]),
    ]
)
