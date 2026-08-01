// swift-tools-version:5.3
import PackageDescription

let package = Package(
    name: "tauri-plugin-pulse-bridge",
    platforms: [
        .macOS(.v10_13),
        .iOS(.v13),
    ],
    products: [
        .library(
            name: "tauri-plugin-pulse-bridge",
            type: .static,
            targets: ["tauri-plugin-pulse-bridge"])
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "tauri-plugin-pulse-bridge",
            dependencies: [
                .byName(name: "Tauri")
            ],
            path: "Sources")
    ]
)
