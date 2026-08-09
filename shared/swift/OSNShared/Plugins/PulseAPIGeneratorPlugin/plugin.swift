import Foundation
import PackagePlugin

/// Runs `swift-openapi-generator` (resolved from the package dependency)
/// against `shared/openapi/pulse.json` at build time. The spec lives outside
/// this package (`shared/openapi/`, a sibling of `shared/swift/`), so the
/// official generator's SPM build plugin — which only auto-discovers a spec
/// in the *generating target's own source directory* — cannot see it. This
/// plugin sidesteps that by passing the spec's path explicitly instead of
/// relying on auto-discovery.
///
/// Output goes to the plugin work directory, never the source tree — the
/// generated `Types.swift`/`Client.swift` are build products, not commits.
@main
struct PulseAPIGeneratorPlugin: BuildToolPlugin {
    func createBuildCommands(context: PluginContext, target: Target) async throws -> [Command] {
        let specPath = context.package.directory
            .removingLastComponent() // shared/swift
            .removingLastComponent() // shared
            .appending(["openapi", "pulse.json"])

        let generatorTool = try context.tool(named: "swift-openapi-generator")
        let outputDirectory = context.pluginWorkDirectory.appending("GeneratedSources")

        // `swift-openapi-generator` is a source-built tool here (resolved via
        // the package dependency), and SwiftPM refuses to let a
        // `.prebuildCommand` use one — those run during build *planning*,
        // before the tool is guaranteed built. `.buildCommand` runs after its
        // tool dependencies build, so it can use one, but trades away
        // `outputFilesDirectory:`'s directory scan for an explicit
        // `outputFiles:` list — these two names match the official plugin's
        // own `GeneratorMode.outputFileName` for `--mode types --mode client`.
        let outputFiles = ["Types.swift", "Client.swift"].map { outputDirectory.appending($0) }

        return [
            .buildCommand(
                displayName: "Generate Pulse OpenAPI client from \(specPath.string)",
                executable: generatorTool.path,
                arguments: [
                    "generate",
                    specPath.string,
                    "--mode", "types",
                    "--mode", "client",
                    "--access-modifier", "public",
                    "--naming-strategy", "idiomatic",
                    "--output-directory", outputDirectory.string,
                ],
                inputFiles: [specPath],
                outputFiles: outputFiles
            )
        ]
    }
}
