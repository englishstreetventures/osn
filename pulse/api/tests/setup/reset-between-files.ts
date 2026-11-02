/**
 * Runs before every test file (`setupFiles` in `vitest.config.ts`). Files in the
 * `shared` project reuse one worker's globals, so whatever a file changes and
 * does not undo would reach the next file. After each file this puts back the
 * real clock, every spy and mock implementation, stubbed globals and
 * environment variables, and `process.env` as it was before the file ran.
 *
 * It cannot reset state a module keeps in its own variables; a test that
 * relies on such state starting empty must reset it itself.
 */
import { afterAll, vi } from "vitest";

const envBefore = { ...process.env };

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const key of Object.keys(process.env)) {
    if (!(key in envBefore)) delete process.env[key];
  }
  Object.assign(process.env, envBefore);
});
