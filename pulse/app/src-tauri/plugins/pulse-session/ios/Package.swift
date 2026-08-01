// swift-tools-version:5.3
import PackageDescription

let package = Package(
  name: "tauri-plugin-pulse-session",
  platforms: [
    .macOS(.v10_13),
    .iOS(.v13),
  ],
  products: [
    .library(
      name: "tauri-plugin-pulse-session",
      type: .static,
      targets: ["tauri-plugin-pulse-session"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-pulse-session",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
