import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { defaultModuleRules, type ModuleRule } from "alchemy/Cloudflare/Workers/Sources/Prebuilt";
import { Data } from "effect";

export class PrebuiltWorkerError extends Data.TaggedError("PrebuiltWorkerError")<{
  readonly source: string;
  readonly message: string;
}> {}

export class PrebuiltSourceMapError extends Data.TaggedError("PrebuiltSourceMapError")<{
  /** The module's path under the source directory. */
  readonly module: string;
  readonly message: string;
}> {}

/**
 * The module rules every prebuilt Worker uploads with: Alchemy's defaults
 * (scripts, WebAssembly, text and data modules) and the source maps
 * `writePrebuiltStage()` writes beside them, which Alchemy sends as
 * `application/source-map` parts.
 */
export const PREBUILT_MODULE_RULES: readonly ModuleRule[] = [
  ...defaultModuleRules,
  { globs: ["**/*.map"] },
];

/** What `writePrebuiltStage()` writes: the modules to copy and each map, already rewritten. */
export interface PrebuiltStage {
  /** The prebuilt directory, resolved. */
  readonly source: string;
  /** Module paths under `source`, POSIX, sorted. */
  readonly modules: readonly string[];
  /** `<module>.map` path to the map's text. */
  readonly maps: Readonly<Record<string, string>>;
}

/** The file extension each default rule selects; every default glob is `**\/*.<ext>`. */
function moduleExtensions(source: string): readonly string[] {
  return defaultModuleRules.flatMap((rule) =>
    rule.globs.map((glob) => {
      const extension = /^\*\*\/\*\.([A-Za-z0-9]+)$/.exec(glob)?.[1];
      if (extension === undefined) {
        throw new PrebuiltWorkerError({
          source,
          message: `Alchemy's default module rule '${glob}' is not of the form **/*.<ext>; staging cannot tell which files Alchemy uploads.`,
        });
      }
      return `.${extension}`;
    }),
  );
}

/** True when `child` is `parent` or anywhere under it. */
function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/**
 * The URL in a module's trailing `//# sourceMappingURL=` comment, read as
 * Wrangler reads it (`getSourceMappingUrl` in wrangler's
 * `deployment-bundle/source-maps.ts`): from the last line up, past blank lines
 * and other `//#` or `//@` lines, stopping at the first line of code.
 */
function sourceMappingUrl(module: string, content: string): string | undefined {
  const prefix = "//# sourceMappingURL=";
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    if (line.startsWith(prefix)) {
      const url = line.slice(prefix.length).trim();
      if (url.startsWith("data:")) {
        throw new PrebuiltSourceMapError({
          module,
          message: `${module} inlines its source map as a data: URL; Wrangler refuses one, and so does this stage.`,
        });
      }
      return url;
    }
    if (!line.startsWith("//#") && !line.startsWith("//@")) return undefined;
  }
  return undefined;
}

function stripPrefix(prefix: string, input: string): string {
  let stripped = input;
  while (stripped.startsWith(prefix)) stripped = stripped.slice(prefix.length);
  return stripped;
}

/** Wrangler's `cleanPathPrefix`, in its nesting order. */
const cleanPathPrefix = (path: string): string =>
  stripPrefix("..\\", stripPrefix("../", stripPrefix(".\\", stripPrefix("./", path))));

/**
 * Reads a prebuilt Worker's output and works out what to upload, writing
 * nothing, so a run it refuses leaves no file behind.
 *
 * The modules are every file Alchemy's default module rules select, except
 * under the top-level `.wrangler/`, which `wrangler dev` writes beside its
 * config and Wrangler's own module walk skips. Each module whose trailing
 * comment names a source map gets that map as Wrangler's
 * `upload_source_maps` sends it (`sourceMapForModule`): named after the
 * module, its `file` set to the module's path, its `sourceRoot` and
 * `sources` stripped of leading `./` and `../`. A map no module names is left
 * out. A comment naming a missing file, or a map inlined as a `data:` URL,
 * is refused, as Wrangler refuses both.
 */
export function planPrebuiltStage(input: {
  readonly source: string;
  readonly main: string;
}): PrebuiltStage {
  const source = resolve(input.source);
  if (!existsSync(source)) {
    throw new PrebuiltWorkerError({
      source: input.source,
      message: `The prebuilt Worker directory '${input.source}' does not exist; build it first.`,
    });
  }
  const extensions = moduleExtensions(input.source);
  const modules = readdirSync(source, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(source, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .filter((path) => !path.startsWith(".wrangler/"))
    .filter((path) => extensions.some((extension) => path.endsWith(extension)))
    .toSorted();
  if (!modules.includes(input.main)) {
    throw new PrebuiltWorkerError({
      source: input.source,
      message: `The prebuilt Worker's entry '${input.main}' is not a module under '${input.source}'; build it first.`,
    });
  }
  const maps: Record<string, string> = {};
  for (const module of modules) {
    const content = readFileSync(join(source, module), "utf8");
    const url = sourceMappingUrl(module, content);
    if (url === undefined) continue;
    const mapPath = join(dirname(join(source, module)), url);
    if (!existsSync(mapPath)) {
      throw new PrebuiltSourceMapError({
        module,
        message: `${module} names the source map '${url}', which does not exist beside it.`,
      });
    }
    const map = JSON.parse(readFileSync(mapPath, "utf8")) as {
      file?: string;
      sourceRoot?: string;
      sources: string[];
    };
    map.file = module;
    if (map.sourceRoot) map.sourceRoot = cleanPathPrefix(map.sourceRoot);
    map.sources = map.sources.map(cleanPathPrefix);
    maps[`${module}.map`] = JSON.stringify(map);
  }
  return { source, modules, maps };
}

/**
 * Writes a planned stage into `target`, emptied first so nothing an earlier
 * run staged reaches the upload: each module byte for byte, and each map as
 * planned. Returns `target`. A target that overlaps the source is refused,
 * because emptying it would delete the build.
 */
export function writePrebuiltStage(stage: PrebuiltStage, target: string): string {
  const resolved = resolve(target);
  if (within(stage.source, resolved) || within(resolved, stage.source)) {
    throw new PrebuiltWorkerError({
      source: stage.source,
      message: `The staging directory '${target}' overlaps the prebuilt Worker '${stage.source}'; put it outside.`,
    });
  }
  rmSync(resolved, { recursive: true, force: true });
  for (const module of stage.modules) {
    mkdirSync(dirname(join(resolved, module)), { recursive: true });
    copyFileSync(join(stage.source, module), join(resolved, module));
  }
  for (const [path, text] of Object.entries(stage.maps)) {
    writeFileSync(join(resolved, path), text);
  }
  return target;
}
