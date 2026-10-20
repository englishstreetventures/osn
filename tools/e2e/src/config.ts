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

/** The suite's clock starts here. */
export const CLOCK_T0_ISO = "2026-10-01T00:00:00.000Z";
export const CLOCK_T0 = Date.parse(CLOCK_T0_ISO);

/**
 * The sample wedding's RSVP deadline on the E2E stack (`CIRE_E2E_RSVP_DEADLINE`,
 * read by `cire/api/src/local.ts`). The in-memory seed sets none, and the
 * deadline the D1 seed carries never reaches this stack. Far past the suite
 * clock, so cire-api takes replies on every run; a flow that needs the invite
 * closed moves only the browser's clock, to `CIRE_RSVP_CLOSED_ISO`.
 */
export const CIRE_RSVP_DEADLINE = "2099-01-01";
/** A browser instant past `CIRE_RSVP_DEADLINE` (the end of that day in UTC). */
export const CIRE_RSVP_CLOSED_ISO = "2099-01-02T00:00:00.000Z";

/**
 * The gift-list wedding cire-api adds when the stack sets `CIRE_E2E_REGISTRY=1`
 * (`seedE2eGiftList` in `cire/api/src/db/setup.ts`, which these values copy):
 * on Gold, with a published list, one household of one, and the wedding's host
 * preview household. The locked flow checks that none of `gifts`, `headline`
 * or `message` reaches a visitor without a claim; the claimed flow checks that
 * each of them reaches the household, so a value that drifts from the seed
 * fails that flow. `previewCode` is the host household's code, which "Preview
 * invite" opens the invitation with.
 */
export const CIRE_GIFT_LIST = {
  slug: "gift-wedding",
  code: "TESTGFT-FIG-EE55",
  previewCode: "HOST-E2E00000000000000000000000000001",
  guestName: "Gil",
  gifts: ["Copper saucepan", "Stoneware mixing bowls", "A walk on the beach together"],
  /** The first gift's id, for a write a flow sends by hand. */
  firstGiftId: "reg_e2e_gift_0001",
  headline: "Our gift list",
  message: "Your being there is the gift. This list is here if you would like it.",
} as const;

/**
 * The client address a flow's organiser claims from (TEST-NET-1, never routed).
 * The organiser previews from their own network, not the guests', so their
 * claim spends its own per-address window of cire-api's claim limit. The
 * stack's cire-api keeps a `cf-connecting-ip` the request sends
 * (`CIRE_E2E_CLIENT_ADDRESS`, `localClientAddress` in cire/api); any other
 * local cire-api replaces it with the socket peer.
 */
export const ORGANISER_ADDRESS = "192.0.2.10";

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
  cireHost: 4322,
  cireLanding: 4323,
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

/**
 * cire registered with osn-api as a first-party OIDC client, so an organiser
 * with an OSN session signs in to the portal with no consent screen. cire-api
 * reads the id and secret as `CIRE_OIDC_CLIENT_ID` / `CIRE_OIDC_CLIENT_SECRET`.
 */
export const CIRE_OIDC = {
  rowId: "oc_cire_e2e",
  clientId: "cid_cire_e2e",
  secret: "e2e-cire-client-secret-not-a-real-secret",
  redirectUri: `${ORIGINS.cireApi}/api/auth/oidc/callback`,
} as const;

/**
 * osn-api's dev sign-in (`GET /dev/login`, local and dev tiers only, mounted
 * when this is set). It signs in as the fixed dev principal, whose profile id
 * owns cire's sample wedding (`DEV_OWNER_PROFILE_ID`). Local only.
 */
export const DEV_LOGIN_SECRET = "e2e-dev-login-secret-not-a-real-secret";

/**
 * The organiser's edit in `cire-event-details`: the sample wedding's Kitchen
 * Tea (`cire/db/seed/data/events.ts`) gains a venue name and a description.
 * No other flow reads Kitchen Tea, so the edit reaches none of them.
 */
export const CIRE_EVENT_EDIT = {
  weddingId: "wed_bootstrap",
  slug: "cire-wedding",
  event: "Kitchen Tea",
  address: "124 Sample Avenue, Exampleville NSW 2001",
  venueName: "The Glasshouse",
  description: "High tea on the lawn, then games; bring a hat.\nCars can park on Sample Lane.",
  /** What the second save changes, so the venue name and description it
   *  carries are the ones the editor read back. */
  dressCode: "Garden party. Flat shoes for the lawn.",
} as const;

/** Seeded cire guest: the first canonical family in `cire/db/seed/data/guests.ts`. */
export const CIRE_GUEST = {
  slug: "cire-wedding",
  code: "TESTONE-IVY-AA11",
  guestName: "Ada",
} as const;

/**
 * A second seeded cire household, for the after-the-deadline flow: Nori, a
 * household of one, invited to the Catholic and Hindu ceremonies. Not Ada's,
 * so `cire-rsvp` still finds Ada with no reply on file, whichever flow runs
 * first.
 */
export const CIRE_LATE_GUEST = {
  code: "TESTTRE-DEW-CC33",
  guestName: "Nori",
} as const;

/**
 * The household for the part-answered flow: Sampleton, three members all
 * invited to the Hindu ceremony. Only Bo answers, so "someone replied" and
 * "everyone replied" disagree — the case no single-member household can show.
 */
export const CIRE_PART_GUEST = {
  code: "TESTTWO-OAK-BB22",
  answering: "Bo",
  silent: ["Cleo", "Dot"],
} as const;

/**
 * Seeded cire household of several: the second canonical family in
 * `cire/db/seed/data/guests.ts` (Bo, Cleo, Dot; Bo and Cleo are invited to the
 * Reception). `member` is who says they are answering.
 */
export const CIRE_HOUSEHOLD = {
  slug: "cire-wedding",
  code: "TESTTWO-OAK-BB22",
  members: ["Bo", "Cleo", "Dot"],
  member: "Cleo",
  /** Who a second tab says is answering, after "Not you?". */
  otherMember: "Bo",
} as const;

/** Identities the flows create. Fixed, so every run registers the same people. */
export const PEOPLE = {
  musubi: { email: "ada@e2e.test", handle: "e2e_ada", name: "Ada E2E" },
  pulseHost: { email: "host@e2e.test", handle: "e2e_host", name: "Host E2E" },
  pulseGuest: { email: "guest@e2e.test", handle: "e2e_guest", name: "Guest E2E" },
} as const;

export const BIRTHDATE = "1990-01-01";
