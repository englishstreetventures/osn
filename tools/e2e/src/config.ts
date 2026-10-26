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
 *
 * `fund` is a cash fund on the same list. The couple's settings take money,
 * but the stack's cire-api has a Stripe key and no Connect webhook secret, so
 * it could never record a gift and no guest may be offered the fund or the
 * money form. The locked flow checks the fund absent without a
 * claim, and the claimed flow checks it absent with one; the claimed flow
 * reads the fund's row from the database, so a drifted value fails there.
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
  fund: {
    id: "reg_e2e_gift_fund",
    title: "Honeymoon in Kyoto",
    description: "Trains, temples and a very good dinner.",
  },
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

/** The Resend key the stack's osn-api sends to the mail stand-in with; never real. */
export const E2E_RESEND_KEY = "re_e2e_local";

/** Names the request log uses for each API origin. Only these are recorded. */
export const API_LABELS = {
  [ORIGINS.osnApi]: "osn-api",
  [ORIGINS.pulseApi]: "pulse-api",
  [ORIGINS.cireApi]: "cire-api",
} satisfies Record<string, string>;

/**
 * The keepalive a realtime socket sends and the hub answers, and how often the
 * socket sends it (`PING`, `PONG` and `PING_INTERVAL_MS` in `@shared/realtime`),
 * which the `flow` fixture's hub stand-in speaks. Written out for Node, as
 * `PORTS` is. `cire-checklist-starter` fails if the ping word differs from the
 * protocol's or the protocol's interval grows past this one: the stand-in then
 * sees no ping in the interval that flow runs its page clock through.
 * The pong word mirrors `TopicHub`; the client takes any frame as an answer.
 */
export const REALTIME_KEEPALIVE = { ping: "ping", pong: "pong", intervalMs: 25_000 } as const;

export const DB_FILES = {
  osn: resolve(STATE_DIR, "osn.db"),
  pulse: resolve(STATE_DIR, "pulse.db"),
  cire: resolve(STATE_DIR, "cire.db"),
} as const;

/** Shared by osn-api and pulse-api so pulse can register its ARC key. Local only. */
export const INTERNAL_SERVICE_SECRET = "e2e-internal-service-secret-not-a-real-secret";

/**
 * Shared by osn-api and cire-api: what osn-api presents to end an account's
 * cire organiser sessions (`cire-registry-money`). Local only.
 */
export const CIRE_INTERNAL_REVOKE_SECRET = "e2e-cire-internal-revoke-secret-not-a-real-secret";

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
 * osn-api's dev sign-in (`GET /dev/login`, the form, local and dev tiers only, mounted
 * when this is set). It signs in as the fixed dev principal, whose profile id
 * owns cire's sample wedding (`DEV_OWNER_PROFILE_ID`) and the `CIRE_ORGANISER`
 * weddings below. Local only.
 */
export const DEV_LOGIN_SECRET = "e2e-dev-login-secret-not-a-real-secret";

/**
 * The organiser weddings cire-api adds when the stack sets
 * `CIRE_E2E_ORGANISER=1` (`seedE2eOrganiser` in `cire/api/src/db/setup.ts`,
 * which these values copy). All seven are on Gold; `profileId`, the profile
 * osn-api's `/dev/login` signs in as, owns six and is a helper on
 * `runSheetHelper`. The co-hosts are bare
 * profile ids: the local cire-api resolves no names, so the portal shows the
 * ids, and a flow finds each person by theirs.
 */
export const CIRE_ORGANISER = {
  profileId: "usr_dev_bootstrap_owner",
  /** A wedding date and an empty checklist, for the starter checklist. */
  checklist: {
    weddingId: "wed_e2e_checklist",
    weddingDate: "2099-06-20",
    /** The starter's first item, due a year before the wedding date. */
    firstItem: {
      key: "agree-budget",
      title: "Agree on an overall budget",
      timeframeBucket: "12m",
      dueAt: "2098-06-20",
    },
  },
  /** One open task nobody holds, an editor and a viewer. */
  holders: {
    weddingId: "wed_e2e_holders",
    taskId: "tsk_e2e_holders_venue",
    taskTitle: "Book the venue",
    editor: { hostId: "whost_e2e_bea", profileId: "usr_e2e_bea" },
    viewer: { hostId: "whost_e2e_cal", profileId: "usr_e2e_cal" },
  },
  /** A helper who sees their own tasks on the run sheet. */
  scope: {
    weddingId: "wed_e2e_scope",
    helper: { hostId: "whost_e2e_dee", profileId: "usr_e2e_dee" },
  },
  /**
   * The day of 2026-10-01 in Sydney (+10:00 that day, so the suite's clock
   * starts at 10:00 there). Greet the celebrant is linked 40 minutes before the
   * Ceremony, so at 10:05 it is coming up; the Reception's run of show is
   * stored out of clock order, one item after midnight.
   */
  runSheet: {
    weddingId: "wed_e2e_runsheet",
    events: {
      ceremony: { id: "evt_e2e_rs_ceremony", name: "Ceremony", movedStart: "11:30" },
      reception: { id: "evt_e2e_rs_reception", name: "Reception" },
      brunch: { id: "evt_e2e_rs_brunch", name: "Brunch" },
    },
    tasks: {
      greet: { id: "tsk_e2e_rs_greet", title: "Greet the celebrant" },
      cake: { id: "tsk_e2e_rs_cake", title: "Set up the cake table" },
      hamper: { id: "tsk_e2e_rs_hamper", title: "Pack the hamper" },
      rings: { id: "tsk_e2e_rs_rings", title: "Bring the rings" },
      cards: { id: "tsk_e2e_rs_cards", title: "Order thank-you cards" },
    },
    /** The Reception's run of show as the run sheet reads it. */
    receptionRunOfShow: [
      "6:30 pm Entrée",
      "12:15 am Last dance (after midnight)",
      "5:30 pm Doors close (after midnight)",
    ],
    /** The cake table's time once the Reception is removed and it is kept. */
    cakeFrozenAt: "2026-10-01T17:00:00+10:00",
  },
  /** The same day, where the dev profile is a helper seeing its own tasks. */
  runSheetHelper: {
    weddingId: "wed_e2e_rs_helper",
    seatId: "whost_e2e_rs_helper_me",
    owner: { hostId: "whost_e2e_gus", profileId: "usr_e2e_gus" },
    arrival: { id: "evt_e2e_rsh_arrival", name: "Guest arrival", runOfShow: "Welcome drinks" },
    speeches: { id: "evt_e2e_rsh_speeches", name: "Speeches", runOfShow: "Best man" },
    programmes: { id: "tsk_e2e_rsh_programmes", title: "Hand out programmes" },
    cue: { id: "tsk_e2e_rsh_cue", title: "Cue the speeches" },
  },
  /**
   * Money gifts on and a Stripe account that can charge, one cash fund and
   * nothing to reserve, unpublished — on a stack whose cire-api cannot take a
   * money gift (a Stripe key and no webhook secret).
   */
  money: {
    weddingId: "wed_e2e_money",
    fundTitle: "Honeymoon fund",
  },
  /** A reception with one seating plan, in use: Ada and Bo Alpha at Table 1,
   *  Cy Charlie at Table 2, all three having said yes. And an after party,
   *  inviting Ada, with no plan yet. */
  seating: {
    weddingId: "wed_e2e_seating",
    eventId: "evt_e2e_seating_rec",
    planId: "spl_e2e_seating_1",
    planName: "Plan 1",
    tables: { one: "Table 1", two: "Table 2" },
    party: { id: "evt_e2e_seating_party", name: "After party", table: "Front row" },
    ada: { guestId: "gst_e2e_seating_ada", name: "Ada Alpha" },
    bo: { guestId: "gst_e2e_seating_bo", name: "Bo Alpha" },
    cy: { guestId: "gst_e2e_seating_cy", name: "Cy Charlie" },
  },
} as const;

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
  /** The run of show as typed into the drawer, out of time order. The flow
   *  then moves the second item up with the keyboard, so the organiser's
   *  order is Tea, Speeches, Games and the guest's time order Tea, Games,
   *  Speeches. */
  runOfShow: [
    { time: "17:15", label: "Speeches" },
    { time: "16:00", label: "Tea is poured" },
    { time: "16:45", label: "Garden games" },
  ],
  gettingThere:
    "Park on Sample Lane; the gate is on the left.\nThe lawn is step-free from the car park.",
  /** What the second save puts in its place, before the flow reverts it. */
  gettingThereChanged: "Park on Sample Lane.",
  /** The guest policy, as the drawer's selects name the presets. */
  children: "Adults only",
  plusOnes: "Welcome",
  policyNote: "Babes in arms are welcome.",
  /**
   * A seeded household invited to the Kitchen Tea that no other flow claims:
   * Eli, of TESTFOR. The flow allows Eli a plus-one and opens the invitation
   * as Eli's household, the one kind that is told plus-ones are welcome.
   */
  allowedGuest: { code: "TESTFOR-JOY-DD44", firstName: "Eli" },
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
  /** Signs up through a first send the mail stand-in refuses. */
  musubiRetry: { email: "grace@e2e.test", handle: "e2e_grace", name: "Grace E2E" },
  pulseHost: { email: "host@e2e.test", handle: "e2e_host", name: "Host E2E" },
  pulseGuest: { email: "guest@e2e.test", handle: "e2e_guest", name: "Guest E2E" },
} as const;

export const BIRTHDATE = "1990-01-01";
