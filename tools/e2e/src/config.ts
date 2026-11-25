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
 * Where the suite's clock starts: a fixed instant, so seeded deadlines and
 * "must be in the future" checks resolve the same way on every run. The run
 * against Stripe's test mode (`src/stripe-test-mode-launcher.ts`) sets
 * `E2E_STRIPE_CLOCK_T0` to its real start before it loads this file: Stripe
 * refuses a Checkout session that closes before real now plus 30 minutes, and
 * cire-api refuses an event Stripe signed more than five minutes from its own
 * now. Read once, here; anything set later is not seen.
 */
function clockStart(value: string | undefined): number {
  if (value === undefined) return Date.parse("2026-10-01T00:00:00.000Z");
  if (!/^[0-9]+$/.test(value)) {
    throw new Error("E2E_STRIPE_CLOCK_T0 must be a whole number of epoch milliseconds");
  }
  return Number(value);
}
export const CLOCK_T0 = clockStart(process.env["E2E_STRIPE_CLOCK_T0"]);
export const CLOCK_T0_ISO = new Date(CLOCK_T0).toISOString();

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
 * `fund` is a cash fund on the same list, and the couple's settings take
 * money. The locked flow checks the fund absent without a claim. The claimed
 * and preview flows run against the stack's second cire-api, which holds a
 * Stripe key and no Connect webhook secret, so it could never record a gift
 * and offers no guest the fund or the money form; the claimed flow checks it
 * absent with a claim, and reads the fund's row from that server's database,
 * so a drifted value fails there.
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
 * The client address `musubi-account-deletion` reaches osn-api from
 * (TEST-NET-1, never routed). Every osn-api limiter that keys on the client
 * address — `/profiles/list` takes ten a minute — is shared by the whole run
 * from the suite's own address, and the Musubi flows run inside one minute:
 * this flow's sign-ins, step-ups and profile lists spend their own windows.
 * The stack's osn-api keeps a `cf-connecting-ip` the request sends
 * (`OSN_E2E_CLIENT_ADDRESS`, `keepSentClientAddress` in osn/api).
 */
export const ACCOUNT_DELETION_ADDRESS = "192.0.2.11";

/**
 * The client address `cire-remove-my-data` reaches osn-api from (TEST-NET-1,
 * never routed), for the same reason as {@link ACCOUNT_DELETION_ADDRESS}: its
 * token grants, profile lists and step-ups spend their own windows.
 */
export const CIRE_REMOVAL_ADDRESS = "192.0.2.12";

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
  /** The Stripe stand-in every cire-api Stripe call goes to. Not a dev app. */
  stripe: 4591,
  /**
   * The mail provider stand-in for the browser Email Verification API: its
   * DNS-over-HTTPS answers, metadata and keys (`src/issuer.ts`). Not a dev app.
   */
  issuer: 4592,
  /**
   * A second osn-api with the Email Verification API flag on, its own
   * database and its own limiter windows. Musubi reaches it only in the flows
   * that call `throughEmailVerificationApi`. Not a dev app.
   */
  osnApiEvt: 4593,
  /**
   * A second cire-api with a Stripe key and no Connect webhook secret, its own
   * database and its own limiter windows: a deployment that must offer guests
   * no money gift. The browser reaches it only in the flows that call
   * `throughKeyOnlyCireApi`. Not a dev app.
   */
  cireApiKeyOnly: 4594,
} as const;

export type AppName = keyof typeof PORTS;

export const ORIGINS: Record<AppName, string> = Object.fromEntries(
  Object.entries(PORTS).map(([name, port]) => [name, `http://localhost:${port}`]),
) as Record<AppName, string>;

/**
 * Cloudflare's Turnstile test sitekey that always passes and shows a visible
 * widget. The stack's Musubi build carries it, so its forms render Turnstile;
 * the fixtures answer for Turnstile's script and frame, and osn-api, holding no
 * secret, checks no token.
 */
export const TURNSTILE_TEST_SITEKEY = "1x00000000000000000000AA";

/** Turnstile's script and frame host, where the fixtures' stand-in answers. */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** The Resend key the stack's osn-api and cire-api send to the mail stand-in with; never real. */
export const E2E_RESEND_KEY = "re_e2e_local";

/**
 * The secret cire-api checks a platform Stripe event's signature with, and the
 * Stripe stand-in signs the events the flows deliver with. Local only.
 */
export const STRIPE_PLATFORM_WEBHOOK_SECRET = "whsec_e2e_platform_not_a_real_secret";

/**
 * The Connect webhook's secret: cire-api checks a gift event's signature with
 * it, and the Stripe stand-in signs a connected account's events with it. Not
 * the platform's value, as no deployed tier may share one. Local only.
 */
export const STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_e2e_connect_not_a_real_secret";

/** Names the request log uses for each API origin. Only these are recorded. */
export const API_LABELS = {
  [ORIGINS.osnApi]: "osn-api",
  [ORIGINS.osnApiEvt]: "osn-api-evt",
  [ORIGINS.pulseApi]: "pulse-api",
  [ORIGINS.cireApi]: "cire-api",
  [ORIGINS.cireApiKeyOnly]: "cire-api-key-only",
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
  osnEvt: resolve(STATE_DIR, "osn-evt.db"),
  pulse: resolve(STATE_DIR, "pulse.db"),
  cire: resolve(STATE_DIR, "cire.db"),
  cireKeyOnly: resolve(STATE_DIR, "cire-key-only.db"),
} as const;

/** Shared by osn-api and pulse-api so pulse can register its ARC key. Local only. */
export const INTERNAL_SERVICE_SECRET = "e2e-internal-service-secret-not-a-real-secret";

/**
 * Shared by osn-api, pulse-api and cire-api: the MAC on osn-api's ARC key ids
 * held for that alone, so the deletion and export flows run with every app
 * checking it. Local only.
 */
export const OSN_ARC_KID_SECRET = "e2e-osn-arc-kid-secret-not-a-real-secret";

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
  /**
   * Where Musubi's Connected apps links to remove one's cire data: the
   * organiser portal's removal screen, as the musubi stack's dev seed builds
   * it (`cireManageDataUrl`, musubi/infra/src/seeds.ts). osn-api answers it
   * because the stack gives its osn-api `CIRE_ORGANISER_ORIGIN`, the portal.
   */
  manageDataUrl: `${ORIGINS.cireHost}/#/remove-data`,
} as const;

/**
 * A third-party relying party the seed registers and no flow signs in to.
 * `musubi-passkey` opens its consent screen to read the "Third-party app" mark,
 * then leaves without deciding, so its redirect URI, on a host reserved for
 * examples, is never loaded. A public client: PKCE alone, no secret.
 */
export const THIRD_PARTY_OIDC = {
  rowId: "oc_third_party_e2e",
  clientId: "cid_third_party_e2e",
  name: "Elsewhere",
  redirectUri: "https://third-party.example/callback",
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
 * which these values copy). Each is on Gold but `enquiries`, on Crimson, and
 * the two `upgrade` weddings, on Ivory, and `envelope`'s three have no seat;
 * `profileId`, the profile osn-api's `/dev/login` signs in as, owns every other
 * one and is a helper on `runSheetHelper`. The co-hosts are bare
 * profile ids: the local cire-api resolves no names, so the portal shows the
 * ids, and a flow finds each person by theirs.
 */
export const CIRE_ORGANISER = {
  profileId: "usr_dev_bootstrap_owner",
  /** The address osn-api's `/dev/login` gives `profileId`'s account, where
   *  cire-api's owner notices to it land (`DEV_PRINCIPAL` in
   *  osn/api/src/routes/auth/dev-login.ts). */
  email: "dev@seed.osn.dev",
  /**
   * Two Ivory weddings the dev profile owns alone, for buying Gold through the
   * Stripe stand-in: `bought` keeps its purchase and is granted Gold; `refunded`
   * is deleted while its checkout is open, so its payment is refunded.
   */
  upgrade: {
    bought: { weddingId: "wed_e2e_upgrade", name: "Upgrade Wedding" },
    refunded: { weddingId: "wed_e2e_upgrade_refund", name: "Refund Wedding" },
  },
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
  /** One open task nobody holds, an editor and a viewer, and a comped
   *  `premium_templates` row, so its invite builder offers the Wax seal. */
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
   * two group gifts and nothing to reserve, unpublished. Its other owner,
   * Kit, connected the account, so the dev profile may read its status and
   * not open its onboarding links.
   */
  money: {
    weddingId: "wed_e2e_money",
    fundTitle: "Honeymoon fund",
    /** Past its $1,200 target: $1,400 from two households, one refund aside. */
    groupGift: { id: "reg_e2e_money_group", title: "Espresso machine" },
    accountId: "acct_e2e_money",
    connector: { hostId: "whost_e2e_kit", profileId: "usr_e2e_kit" },
  },
  /**
   * Two weddings the dev profile owns alone. On `from` it connected a Stripe
   * account that can charge, in AUD; `to` has no account, so its Money gifts
   * panel offers the dev profile that one — and not Money Wedding's, which Kit
   * connected.
   */
  shared: {
    from: { weddingId: "wed_e2e_shared_from", name: "Ceremony Wedding" },
    to: { weddingId: "wed_e2e_shared_to", name: "Party Wedding" },
    accountId: "acct_e2e_shared",
  },
  /**
   * A Gold wedding the dev profile owns alone, whose registry is open (a
   * settings row) and has no Stripe account: for connecting a Stripe account
   * the owner already has, through the Stripe stand-in.
   */
  oauth: { weddingId: "wed_e2e_oauth", name: "Garden Wedding" },
  /**
   * A Gold wedding with a published gift list and nothing on it, money gifts
   * on and an Express account that can charge and pays out in AUD, which Kit,
   * its second owner, connected: so the dev profile's other weddings are not
   * offered it. One household, Parkes, of one guest, Pia. The owner adds a cash
   * fund through the portal's form and Pia gives to it through the Stripe
   * stand-in (`tests/support/cire-fund-gift.ts`).
   */
  fund: {
    weddingId: "wed_e2e_fund",
    slug: "fund-wedding",
    accountId: "acct_e2e_fund",
    connector: { hostId: "whost_e2e_fund_kit", profileId: "usr_e2e_kit" },
    household: { familyId: "fam_e2e_fund", code: "PARKES-E2E-FD01", guestName: "Pia" },
  },
  /** A reception with one seating plan, in use: Ada and Bo Alpha at Table 1,
   *  Cy Charlie at Table 2, all three having said yes. And an after party,
   *  inviting Ada, with no plan yet. */
  /**
   * A Gold wedding dated 2099-06-20, for counting what the portal reads as the
   * owner moves between views (`seedE2eCache` in cire/api/src/db/setup.ts): the
   * Ceremony and the Reception; household Alpha, Ada and Bo invited to both;
   * Ada attending the Ceremony, a change the owner has not seen; no tasks.
   */
  cache: {
    weddingId: "wed_e2e_cache",
    household: "Alpha",
    /** Alpha's claim code, which the guest list prints. */
    code: "TESTCACHE-ALP-0001",
    ada: "Ada",
    bo: "Bo",
    ceremony: "Ceremony",
    reception: "Reception",
    /** What the flow renames the Reception to in the events editor. */
    renamed: "Evening reception",
  },
  seating: {
    weddingId: "wed_e2e_seating",
    slug: "seating-wedding",
    eventId: "evt_e2e_seating_rec",
    planId: "spl_e2e_seating_1",
    planName: "Plan 1",
    tables: { one: "Table 1", two: "Table 2" },
    party: { id: "evt_e2e_seating_party", name: "After party", table: "Front row" },
    ada: { guestId: "gst_e2e_seating_ada", name: "Ada Alpha" },
    bo: { guestId: "gst_e2e_seating_bo", name: "Bo Alpha" },
    cy: { guestId: "gst_e2e_seating_cy", name: "Cy Charlie" },
  },
  /**
   * One household: Gus with no address, and Hana with one she gave herself
   * on the invite. The organiser adds Gus's (`added`) in the guest editor.
   */
  emails: {
    weddingId: "wed_e2e_emails",
    household: "Tanaka",
    noAddress: "Gus",
    guestsOwn: { firstName: "Hana", address: "hana.own@e2e.test" },
    added: "gus.tanaka@e2e.test",
    /** Gus's address in the two sheets the flow previews; the second applies. */
    sheetAddresses: { first: "gus.first@e2e.test", second: "gus.second@e2e.test" },
    /** The household a later sheet adds and Change history's Revert takes away. */
    reverted: { household: "Ito", firstName: "Kai" },
  },
  /**
   * Two households, Nguyen (whose code has been sent) and Patel, and two live
   * unlock codes of one use each: `gold`, which the wedding already holds, and
   * `crimson`, which raises it. `wrong` names no code. For redeeming a code,
   * re-minting the family codes and deleting and restoring the wedding.
   */
  settings: {
    weddingId: "wed_e2e_settings",
    slug: "settings-wedding",
    name: "Settings Wedding",
    families: [
      { id: "fam_e2e_settings_nguyen", code: "NGUYEN-E2E-ST01" },
      { id: "fam_e2e_settings_patel", code: "PATEL-E2E-ST02" },
    ],
    codes: {
      gold: { id: "ulc_e2e_settings_gold", code: "e2e0-901d-0000-0001" },
      crimson: { id: "ulc_e2e_settings_crimson", code: "e2e0-c41f-0000-0002" },
      wrong: "0000-0000-0000-0000",
    },
  },
  /**
   * On Crimson, with two live directory listings: `open`, not in the wedding,
   * owned by the organisation that made it in the vendor portal with no vendor
   * profile on it, so an enquiry to it waits on the listing and mints no claim
   * link; and `quoted`, claimed, whose enquiry from this wedding the vendor has
   * answered with a $4,800 quote.
   */
  enquiries: {
    weddingId: "wed_e2e_enquiries",
    open: { listingId: "dir_e2e_enq_florals", name: "Willow & Fern Florals", category: "florals" },
    quoted: {
      listingId: "dir_e2e_enq_strings",
      enquiryId: "enq_e2e_strings",
      name: "Harbour Strings",
      category: "music_entertainment",
      quotedMinor: 480_000,
    },
  },
  /**
   * On Crimson with the Wax seal envelope over a hero with a title, a subtitle
   * and a cropped image, for `cire-invite-envelope`. No seat and no household:
   * the flow only opens it as a guest.
   */
  envelope: {
    weddingId: "wed_e2e_envelope",
    slug: "envelope-wedding",
    envelopeId: "wax-seal",
    heroTitle: "Envelope Wedding",
    /** The same envelope over a hero with a title and no image. */
    plainSlug: "plain-envelope-wedding",
    /** A shown hero and no envelope. */
    noneSlug: "no-envelope-wedding",
  },
} as const;

/**
 * The wedding whose event was saved before the editor checked an event's name,
 * times and zone (`seedE2eLegacyEvent` in cire/api/src/db/setup.ts), and the
 * edits `cire-event-details.flow.ts` makes to it.
 */
export const CIRE_LEGACY_EVENT = {
  weddingId: "wed_e2e_legacy_event",
  legacyId: "evt_e2e_legacy",
  /** The values the seed stores on the legacy event. */
  stored: {
    name: "",
    start_at: "2026-11-14T15:00",
    end_at: "2026-11-14T17:00",
    timezone: "AEST",
  },
  otherId: "evt_e2e_legacy_reception",
  otherName: "Reception",
  /** The edit to the other event that saves around the legacy one. */
  address: "1 Garden Lane, Exampleville NSW 2001",
  /** The fix: a name, a zone that resolves, and the Start re-entered. */
  fixedName: "Welcome drinks",
  fixedZone: "Australia/Sydney",
  fixedStartTime: "16:00",
  /** The legacy event as the fix stores it: both times stamped from the zone. */
  fixed: {
    name: "Welcome drinks",
    start_at: "2026-11-14T16:00:00+11:00",
    end_at: "2026-11-14T17:00:00+11:00",
    timezone: "Australia/Sydney",
  },
} as const;

/**
 * The two weddings close to the guest-data sweep's three years from creation
 * (`seedE2eCreationBound` in cire/api/src/db/setup.ts), and what
 * `cire-event-details.flow.ts` reads and writes on them.
 */
export const CIRE_BOUND = {
  /** Created 2023-11-30 at noon UTC; its Ceremony's Start is a date alone. */
  weddingId: "wed_e2e_bound",
  displayName: "Undated Wedding",
  ceremonyId: "evt_e2e_bound_ceremony",
  ceremony: "Ceremony",
  /** The day its three years run out, as the portal prints it. */
  from: "30 November 2026",
  /** A creation time three years and a quarter before the suite's clock,
   *  epoch seconds (2023-07-01T12:00:00Z): past its bound. */
  pastCreatedAt: 1_688_212_800,
  /** The Start time the flow types into the Ceremony, and the Start it saves. */
  startTime: "15:00",
  fixedStartAt: "2027-02-06T15:00:00+11:00",
  /** No events, created 2023-12-10 at noon UTC. */
  emptyWeddingId: "wed_e2e_bound_empty",
  emptyDisplayName: "Eventless Wedding",
  emptyFrom: "10 December 2026",
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
  /** The sample wedding the family is invited to, which the dev profile owns. */
  weddingId: "wed_bootstrap",
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
  /** The address `member` gives on the invite, then corrects. */
  email: "cleo.sampleton@e2e.test",
  /** What `member` corrects it to, then removes. */
  correctedEmail: "cleo.s@e2e.test",
  /** The address the hosts added for `otherMember` (`seedE2eOrganiser`). */
  otherMemberEmail: "bo.sampleton@e2e.test",
} as const;

/** Identities the flows create. Fixed, so every run registers the same people. */
export const PEOPLE = {
  musubi: { email: "ada@e2e.test", handle: "e2e_ada", name: "Ada E2E" },
  /** Signs up through a first send the mail stand-in refuses. */
  musubiRetry: { email: "grace@e2e.test", handle: "e2e_grace", name: "Grace E2E" },
  pulseHost: { email: "host@e2e.test", handle: "e2e_host", name: "Host E2E" },
  pulseGuest: { email: "guest@e2e.test", handle: "e2e_guest", name: "Guest E2E" },
  /** Signs up with a browser Email Verification API token: no link. */
  musubiVerified: {
    email: "hedy@mailbox.e2e.test",
    handle: "e2e_hedy",
    name: "Hedy E2E",
  },
  /** Signs up on the same osn-api with no token: the link goes. */
  musubiVerifiedControl: {
    email: "joan@mailbox.e2e.test",
    handle: "e2e_joan",
    name: "Joan E2E",
  },
} as const;

/**
 * The issuer stand-in (`src/issuer.ts`): the mail domain whose
 * `_email-verification` record names it, and its host. Its answers reach only
 * the osn-api told `OSN_EMAIL_VERIFICATION_EMULATOR_URL`. The host's address
 * is TEST-NET-3, which the verifier's address check allows and nothing routes;
 * every request to it goes to the stand-in instead.
 */
export const EVT_ISSUER = {
  domain: "mailbox.e2e.test",
  host: "issuer.e2e.test",
  address: "203.0.113.10",
} as const;

export const BIRTHDATE = "1990-01-01";

/**
 * The account `musubi-recovery` gets back into through an emailed link. A row
 * `seedOsn` writes, with one passkey on it that no authenticator in the run
 * holds — the lost phone — so the new passkey is enrolled past an existing
 * one, as a real recovery is. Its credential id is base64url, as an
 * authenticator's is: enrolment lists it for the browser to exclude, and the
 * browser decodes it, failing the ceremony on anything else.
 */
export const RECOVERY_PERSON = {
  accountId: "acc_e2e_recover",
  profileId: "usr_e2e_recover",
  email: "recover@e2e.test",
  passkeyUserId: "pku_e2e_recover",
  handle: "e2e_recover",
  name: "Recover E2E",
  // base64url of "e2e lost phone credential".
  lostPasskey: { id: "pk_e2e_lost", credentialId: "ZTJlIGxvc3QgcGhvbmUgY3JlZGVudGlhbA" },
} as const;

/**
 * The host `cire-remove-my-data` removes from cire while keeping the Musubi
 * account, and the other person whose weddings must come through untouched.
 * Rows `seedOsn` writes: each account and profile, and the remover's live
 * Musubi session, whose raw token the flow puts in its browser, as a sign-in
 * would. The flow writes the cire organiser sessions itself, each row holding
 * its token's SHA-256, as cire's own sign-in leaves it: two for the remover
 * (one for a second browser that holds a confirmation's code but not the
 * cookie that binds it) and one for the keeper. cire's weddings
 * (`seedE2eOrganiser` in `cire/api/src/db/setup.ts`): `alone`, the remover's
 * alone; `shared`, theirs and the keeper's; `theirs`, the keeper's alone.
 * Seeded, not signed up or signed in, so the flow spends none of the run's
 * sign-up and sign-in windows. Readable tokens on purpose: fixtures of a
 * local stack, like `DEV_LOGIN_SECRET`.
 */
export const CIRE_REMOVAL_PERSON = {
  accountId: "acc_e2e_remover",
  profileId: "usr_e2e_remover",
  email: "remover@e2e.test",
  passkeyUserId: "pku_e2e_remover",
  handle: "e2e_remover",
  name: "Remover E2E",
  session: { token: "e2e-removal-person-session", familyId: "sfam_e2e_remover" },
  cireSessions: ["e2e-removal-cire-session", "e2e-removal-cire-second-session"],
  alone: { id: "wed_e2e_rm_alone", name: "Remover Alone Wedding" },
  shared: { id: "wed_e2e_rm_shared", name: "Remover Shared Wedding" },
  keeper: {
    accountId: "acc_e2e_keeper",
    profileId: "usr_e2e_keeper",
    email: "keeper@e2e.test",
    passkeyUserId: "pku_e2e_keeper",
    handle: "e2e_keeper",
    name: "Keeper E2E",
    cireSession: "e2e-removal-keeper-cire-session",
    theirs: { id: "wed_e2e_rm_theirs", name: "Keeper Wedding" },
  },
} as const;

/**
 * The account `musubi-account-deletion` deletes, keeps and deletes again. Rows
 * `seedOsn` writes: the account, its one profile, an open Pulse enrolment (as
 * Pulse's onboarding writes one) and one live session, whose raw token the
 * flow puts in its browser's cookie jar, as a sign-in would, so it spends none
 * of the run's sign-up or sign-in windows; and an organisation it owns, with an
 * heir who also holds a seeded session. Its token is readable on purpose:
 * it is a fixture of a local stack, like `DEV_LOGIN_SECRET`, and grants
 * nothing anywhere else. cire's `wed_e2e_leaver` (`seedE2eOrganiser` in
 * `cire/api/src/db/setup.ts`) has this profile as its only owner.
 */
export const DELETION_PERSON = {
  accountId: "acc_e2e_leaver",
  profileId: "usr_e2e_leaver",
  email: "leaver@e2e.test",
  passkeyUserId: "pku_e2e_leaver",
  handle: "e2e_leaver",
  name: "Leaver E2E",
  enrolmentId: "aenr_e2e_leaver_pulse",
  session: {
    token: "e2e-deletion-person-session",
    familyId: "sfam_e2e_leaver",
  },
  wedding: { id: "wed_e2e_leaver", name: "Leaver Wedding", seatId: "whost_e2e_leaver_owner" },
  /**
   * An organisation the person owns. `heir`, an admin from another account,
   * receives it at the hard delete and declines it from the email's link,
   * signed in through its own seeded session; it then passes to `member`.
   */
  organisation: { id: "org_e2e_leaver", handle: "e2e_leaver_org", name: "Leaver Org E2E" },
  heir: {
    accountId: "acc_e2e_heir",
    profileId: "usr_e2e_heir",
    email: "heir@e2e.test",
    passkeyUserId: "pku_e2e_heir",
    handle: "e2e_heir",
    name: "Heir E2E",
    session: { token: "e2e-deletion-heir-session", familyId: "sfam_e2e_heir" },
  },
  member: {
    accountId: "acc_e2e_next",
    profileId: "usr_e2e_next",
    email: "next@e2e.test",
    passkeyUserId: "pku_e2e_next",
    handle: "e2e_next",
    name: "Next E2E",
  },
} as const;

/**
 * Musubi's organisation pages (`musubi-org-detail`). The owner is osn-api's dev
 * principal (`DEV_PRINCIPAL` in osn/api/src/routes/auth/dev-login.ts), signed in
 * through `/dev/login/form`; `org` is the organisation the flow creates as them.
 * `member` and `otherOrg` are rows `seedOsn` writes: a profile with no passkey,
 * which the flow adds to `org` and removes again, and an organisation that
 * profile owns and the dev principal does not belong to.
 */
export const MUSUBI_ORG = {
  owner: { handle: "dev_bootstrap" },
  org: { handle: "e2e_org", name: "E2E Org", renamed: "E2E Org Renamed" },
  member: {
    accountId: "acc_e2e_member",
    profileId: "usr_e2e_member",
    email: "member@e2e.test",
    passkeyUserId: "pku_e2e_member",
    handle: "e2e_member",
    name: "Member E2E",
  },
  otherOrg: {
    id: "org_e2e_other",
    membershipId: "orgm_e2e_other",
    handle: "e2e_other_org",
    name: "Other Org E2E",
  },
} as const;
