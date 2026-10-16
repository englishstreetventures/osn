/**
 * Which Chromium the suite drives. Never installs one.
 *
 * 1. `E2E_CHROMIUM_PATH`, when set — an explicit choice always wins.
 * 2. The build this Playwright version was made for, when it is installed —
 *    CI installs it, so local and CI match whenever they can.
 * 3. `/opt/pw-browsers/chromium`, the build the remote environment ships.
 *
 * `undefined` hands the choice back to Playwright, which then reports the
 * missing executable itself.
 */

import { existsSync } from "node:fs";

export const REMOTE_ENV_CHROMIUM = "/opt/pw-browsers/chromium";

export function resolveChromium(
  env: Readonly<Record<string, string | undefined>>,
  bundledPath: string | undefined,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const explicit = env["E2E_CHROMIUM_PATH"];
  if (explicit) return explicit;
  if (bundledPath && exists(bundledPath)) return bundledPath;
  if (exists(REMOTE_ENV_CHROMIUM)) return REMOTE_ENV_CHROMIUM;
  return undefined;
}
