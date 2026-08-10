import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateOpenApiDocument } from "@shared/openapi-tools";

import { createApp } from "../src/app";

/**
 * Regenerates `shared/openapi/pulse.json` from the live route definitions.
 * Boots the real app (in-memory DB + rate limiters, matching test defaults)
 * and fetches its own `/openapi/json` rather than re-deriving the document
 * by hand, so the committed spec can never drift from what the app serves.
 *
 * Every fix applied to the plugin's raw output lives in `@shared/openapi-tools`,
 * shared with `osn/api`.
 */

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const OUTPUT_PATH = resolve(join(SCRIPT_DIR, "../../../shared/openapi/pulse.json"));

const app = createApp();
await generateOpenApiDocument({
  handle: (request) => app.handle(request),
  outputPath: OUTPUT_PATH,
});

// eslint-disable-next-line no-console -- CLI script output
console.log(`Wrote ${OUTPUT_PATH}`);
