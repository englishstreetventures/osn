/**
 * Every fixed value the suite runs on, in one place: where the artifact lands,
 * the clock, the ports, the seeded identities and the shared secrets.
 *
 * Imported by the launcher (Bun) and by the flows (Playwright, under Node), so
 * it holds plain data and `node:` imports only.
 */

import { resolve } from "node:path";

/** Repository root, from `tools/e2e/src/`. */
export const REPO_ROOT = resolve(import.meta.dirname, "../../..");

/** Everything a run writes. Wiped at the start of every run. */
export const ARTIFACT_DIR = resolve(REPO_ROOT, "e2e-artifacts");
export const RESULTS_FILE = resolve(ARTIFACT_DIR, "results.json");
export const SCREENSHOT_DIR = resolve(ARTIFACT_DIR, "screenshots");
export const TRACE_DIR = resolve(ARTIFACT_DIR, "traces");
export const LOG_DIR = resolve(ARTIFACT_DIR, "logs");
export const STATE_DIR = resolve(ARTIFACT_DIR, "state");

/**
 * The suite's clock starts here. Before the seeded cire wedding's RSVP deadline
 * (`cire/db/seed/data/wedding.ts`), so the guest flow is open on every run.
 */
export const CLOCK_T0_ISO = "2026-10-01T00:00:00.000Z";
export const CLOCK_T0 = Date.parse(CLOCK_T0_ISO);

/**
 * The fixed ports `PORTLESS=0` uses. Written out rather than imported because
 * Playwright loads this file under Node, which cannot run a workspace package's
 * TypeScript; `tests/config.test.ts` holds them equal to `DEV_APPS` in
 * `@shared/dev-urls`.
 */
export const PORTS = {
  osnApi: 4000,
  pulseApi: 3001,
  cireApi: 8787,
  musubi: 1422,
  pulseWeb: 1420,
  cireInvites: 4321,
  /** The Resend stand-in osn-api sends OTP mail to. Not a dev app. */
  mail: 4590,
} as const;

export type AppName = keyof typeof PORTS;

export const ORIGINS: Record<AppName, string> = Object.fromEntries(
  Object.entries(PORTS).map(([name, port]) => [name, `http://localhost:${port}`]),
) as Record<AppName, string>;

/** Names the request log uses for each API origin. Only these are recorded. */
export const API_LABELS = {
  [ORIGINS.osnApi]: "osn-api",
  [ORIGINS.pulseApi]: "pulse-api",
  [ORIGINS.cireApi]: "cire-api",
} satisfies Record<string, string>;

export const DB_FILES = {
  osn: resolve(STATE_DIR, "osn.db"),
  pulse: resolve(STATE_DIR, "pulse.db"),
  cire: resolve(STATE_DIR, "cire.db"),
} as const;

/** Shared by osn-api and pulse-api so pulse can register its ARC key. Local only. */
export const INTERNAL_SERVICE_SECRET = "e2e-internal-service-secret-not-a-real-secret";

/** The Pulse relying party the seed registers with osn-api. */
export const PULSE_OIDC = {
  rowId: "oc_pulse_e2e",
  clientId: "cid_pulse_e2e",
  secret: "e2e-pulse-client-secret-not-a-real-secret",
  redirectUri: `${ORIGINS.pulseApi}/api/auth/oidc/callback`,
} as const;

/** Seeded cire guest: the first canonical family in `cire/db/seed/data/guests.ts`. */
export const CIRE_GUEST = {
  slug: "cire-wedding",
  code: "TESTONE-IVY-AA11",
  guestName: "Ada",
} as const;

/** Identities the flows create. Fixed, so every run registers the same people. */
export const PEOPLE = {
  musubi: { email: "ada@e2e.test", handle: "e2e_ada", name: "Ada E2E" },
  pulseHost: { email: "host@e2e.test", handle: "e2e_host", name: "Host E2E" },
  pulseGuest: { email: "guest@e2e.test", handle: "e2e_guest", name: "Guest E2E" },
} as const;

export const BIRTHDATE = "1990-01-01";
