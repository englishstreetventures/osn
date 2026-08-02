// swift-tools-version:5.3
import PackageDescription

let package = Package(
    name: "tauri-plugin-pulse-tabbar",
    platforms: [
        .macOS(.v10_13),
        .iOS(.v13),
    ],
    products: [
        .library(
            name: "tauri-plugin-pulse-tabbar",
            type: .static,
            targets: ["tauri-plugin-pulse-tabbar"])
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "tauri-plugin-pulse-tabbar",
            dependencies: [
                .byName(name: "Tauri")
            ],
            path: "Sources")
    ]
)
