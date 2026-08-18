import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { excludePaths, normalizeOpenApiDocument } from "./normalize";
import type { Doc } from "./normalize";

export interface GenerateOptions {
  /**
   * The app's own `fetch` handler (Elysia's `app.handle`). The document is read
   * back out of the live route tree rather than re-derived by hand, so the
   * committed spec cannot drift from what the app serves.
   */
  handle: (request: Request) => Response | Promise<Response>;
  /** Absolute path of the JSON document to write. */
  outputPath: string;
  /** Where the plugin mounts its JSON document. */
  documentPath?: string;
  /**
   * Paths to drop from the finished document — exact strings or patterns
   * matched against each path. The plugin's own `exclude.paths` handles the
   * exact strings but silently ignores every RegExp (see {@link excludePaths}),
   * so whole prefixes have to be excluded here.
   */
  excludePaths?: readonly (string | RegExp)[];
  /** Warning sink. Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

/**
 * The one place the document crosses in from outside the type system. Every fix
 * downstream reads the parsed body as an object of JSON nodes, so that belief is
 * checked here rather than asserted: a body that isn't a JSON object (an error
 * page served with a 200, a plugin that starts emitting an array) fails with the
 * route named instead of surfacing as a confusing failure inside a fix.
 */
const isDocument = (payload: unknown): payload is Doc =>
  payload !== null && typeof payload === "object" && !Array.isArray(payload);

/**
 * Fetches the app's own OpenAPI document, normalises it for
 * swift-openapi-generator, and writes it to `outputPath`. Returns the bytes it
 * wrote so a caller can diff instead of write.
 */
export async function generateOpenApiDocument(options: GenerateOptions): Promise<string> {
  const {
    handle,
    outputPath,
    documentPath = "/openapi/json",
    excludePaths: pathsToExclude = [],
    // eslint-disable-next-line no-console -- CLI script output
    warn = (message: string) => console.warn(message),
  } = options;

  const response = await handle(new Request(`http://localhost${documentPath}`));
  if (!response.ok) {
    throw new Error(`GET ${documentPath} returned ${response.status}`);
  }
  const doc = await response.json();
  if (!isDocument(doc)) {
    throw new Error(`GET ${documentPath} did not return a JSON object`);
  }

  excludePaths(doc, pathsToExclude);
  const { output, unhandledNullUnions } = normalizeOpenApiDocument(doc);
  for (const path of unhandledNullUnions) {
    warn(`warning: null union left as-is (unhandled shape) at ${path}`);
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output, "utf-8");
  return output;
}
