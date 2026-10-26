export interface DressSwatch {
  name: string;
  color: string;
}

/**
 * Normalised crop rectangle in source fractions (0..1). Mirrors `ImageCrop` in
 * cire/api. `natW`/`natH` are the source image's natural pixel dimensions
 * (optional — present on crops saved by the current editor, absent on legacy
 * crops); they give the display box the crop's true pixel aspect so the guest
 * render fills it with no distortion.
 */
export interface ImageCrop {
  x: number;
  y: number;
  w: number;
  h: number;
  natW?: number;
  natH?: number;
}

export interface EventSummary {
  id: string;
  name: string;
  description: string;
  startAt: string;
  endAt: string;
  timezone: string;
  /**
   * The venue's name, shown above the address. Optional: the guest site can
   * deploy before an API that sends it, and absent reads as no name.
   */
  venueName?: string | null;
  address: string | null;
  /**
   * The run of show, as it arrived: the organiser's items, each a 24-hour
   * `HH:MM` in the event's zone and a label. Unproven, like the FAQ: the claim
   * guard does not check it, and `runOfShowLines` keeps only well-formed
   * items, so a malformed list costs the guest the list, never the invite.
   * Absent from an API that predates it.
   */
  runOfShow?: unknown;
  /** Parking, transport and access notes. Optional on the wire, like `venueName`. */
  gettingThere?: string | null;
  /**
   * The guest policy's presets, as stored (`adults_only` / `children_welcome`,
   * `by_invitation` / `welcome`), and its note. A preset this build does not
   * know reads as not stated (`guestPolicyLines`). Optional on the wire.
   */
  childrenPolicy?: string | null;
  plusOnePolicy?: string | null;
  guestPolicyNote?: string | null;
  dressCodeDescription: string | null;
  dressCodePalette: DressSwatch[] | null;
  pinterestUrl: string | null;
  mapsUrl: string | null;
  sortOrder: number;
  /**
   * First-party path to this event's optional image (migration 0019), or null
   * when none. Carries a `?v=` cache-buster; the guest site prepends its API
   * origin before use. Null ⇒ the card renders text-only at every breakpoint.
   */
  imageUrl: string | null;
  /**
   * Normalised crop rectangle `{x,y,w,h}` (0..1 source fractions, migration 0021)
   * the organiser chose for this event's image, or null for the default centre
   * `object-cover`. Applied in CSS by the event card. Optional so a mid-deploy
   * payload (older API) or a test fixture without it falls back to no crop.
   */
  imageCrop?: ImageCrop | null;
}

export interface FamilyMember {
  guestId: string;
  firstName: string;
  lastName: string;
  /** Optional informal name for the single-guest greeting; null ⇒ use firstName. */
  nickname: string | null;
  eventIds: string[];
  /**
   * Whether this member may bring a plus-one — what the invite's plus-one
   * prompt asks about. Always false on a plus-one. Optional on the wire, since
   * the guest site can deploy before the API that sends it; absent reads as
   * not allowed, so no prompt appears.
   */
  plusOneAllowed?: boolean;
  /**
   * Set on a plus-one: the guest id of the member who brought them, who is
   * listed just before them. `null` (or absent, from an older API) on everyone
   * else.
   */
  plusOneOf?: string | null;
}

/**
 * A plus-one as `PUT /api/plus-one/:guestId` answers with it: the person named,
 * and the events they are invited to (their inviter's).
 */
export interface PlusOneRecord {
  guestId: string;
  firstName: string;
  lastName: string;
  plusOneOf: string;
  eventIds: string[];
}

/** The body of a 200 from `PUT /api/plus-one/:guestId`. */
export interface PlusOneSaved {
  plusOne: PlusOneRecord;
  /** False for a rename, including the one that happens when another device
   *  named a plus-one first. */
  created: boolean;
  /**
   * The rename cleared the plus-one's dietary answers and consent record,
   * which were about the person before. Absent from an API that predates it,
   * which clears nothing — so absent reads as false.
   */
  dietaryCleared?: boolean;
}

export interface RsvpSummary {
  guestId: string;
  eventId: string;
  status: "attending" | "declined" | "maybe";
  dietary: string;
  /**
   * The preset keys this guest picked. Strings rather than `DietaryPreset`,
   * because the claim guard admits a key the server knows and this build does
   * not; the picker keeps such a key through an edit. Optional on the wire so a
   * payload from an API that predates the column reads as no presets.
   */
  dietaryPresets?: readonly string[];
  /**
   * Whether this row's Art. 9(2)(a) consent was given against the copy shown now.
   *
   * The sheet asks for consent once per submission rather than once per guest,
   * so it has to know which members are already covered: one person's prior
   * consent can never stand in for another's, and a household where anyone is
   * new to consent — or whose record predates a consent-copy change — must be
   * asked afresh. The server computes it, because the server owns the version.
   * Optional on the wire; absent reads as not covered, so the box opens unticked.
   */
  dietaryConsentCurrent?: boolean;
  /**
   * The household member whose session sent this reply, for "Answered by".
   * Present only while the member step is on; null when no member sent it (an
   * organiser's reply, or one from before the step). Absent reads as unknown,
   * so no line is drawn.
   */
  submittedBy?: { guestId: string; firstName: string } | null;
}

/**
 * The wedding's "kindly respond by" date, resolved by the API into one instant.
 * Mirrors `RsvpDeadline` in cire/api's claim schema.
 *
 * `closed` is the verdict at claim time; `closesAt` is the instant it flips, so
 * the invite can lock itself mid-session without a re-claim. The server re-checks
 * on every write regardless — this drives presentation, not permission.
 */
export interface RsvpDeadline {
  /** Date-only ISO (`YYYY-MM-DD`), inclusive of its whole day. */
  date: string;
  /** IANA zone the date is measured in (`UTC` when the wedding stored none). */
  timezone: string;
  /** ISO instant the invite locks: the last millisecond of `date` in `timezone`. */
  closesAt: string;
  closed: boolean;
}

/**
 * The household's Pulse account-link state when linking is offered to it —
 * everything the account-link box needs for its first paint. `readAccountLink`
 * derives it from the claim payload's `accountLink` (cire/api's
 * `AccountLinkState`, its `enabled: true` half).
 */
export interface AccountLinkState {
  /** Whether this browser holds a live OSN sign-in on cire-api. */
  signedIn: boolean;
  /** The household's seats already linked to an OSN account. */
  linkedGuestIds: readonly string[];
  /**
   * This browser's musubi account, for the box to show before "Link". Sent
   * only when signed in, a member is chosen, and that member is unlinked or
   * linked to this same account.
   */
  account?: SignedInAccount;
}

/** The public profile fields of this browser's musubi sign-in. */
export interface SignedInAccount {
  displayName: string | null;
  handle: string | null;
  /** An `https:` URL, or null. */
  avatarUrl: string | null;
  /** True when the chosen member is linked to this account. */
  matchesMember: boolean;
}

/** One entry of the invite's FAQ section. Mirrors `GuestFaqEntry` in cire/api:
 *  the text alone, since the page keys nothing on an id. */
export interface FaqEntry {
  question: string;
  answer: string;
}

export interface ClaimResult {
  publicId: string;
  familyName: string;
  /**
   * True for the organiser host preview session. The RSVP stays interactive but
   * submit is a no-op (nothing is saved) — see RsvpPanel's `preview` prop.
   */
  preview?: boolean;
  members: FamilyMember[];
  events: EventSummary[];
  rsvps: RsvpSummary[];
  /**
   * The invite's CLOSING SECTION — the couple's sign-off to this household.
   * Delivered here rather than in the public `GET /api/invite/:slug` because it
   * is addressed to the invited household; the public payload redacts it.
   * Optional on the wire so a mid-deploy payload from an older API simply
   * renders no closing section.
   */
  closing?: {
    /**
     * The closing section's visibility switch (migration 0063). Switched off,
     * the API also leaves the content out. Optional so a payload from an API
     * older than the switch reads as on.
     */
    visible?: boolean;
    message: string | null;
    imageUrl: string | null;
    imageCrop?: ImageCrop | null;
  };
  /**
   * The invite's FAQ section, shown under the events. Delivered here rather
   * than in the public invite payload because it is written for the invited
   * household, like the events. Switched off, the API sends no entries.
   * Optional on the wire, and each field optional, so a payload from an API
   * older than the FAQ simply renders no FAQ section; the page keeps only
   * well-formed entries (`faqEntries`), so a malformed one is dropped rather
   * than failing the claim.
   */
  faq?: {
    visible?: boolean;
    entries?: FaqEntry[];
  };
  /**
   * The wedding's RSVP-by date, or null when the organiser hasn't set one.
   * Optional on the wire so a mid-deploy payload from an older API simply
   * behaves as it always did — no deadline, no lock.
   */
  rsvpDeadline?: RsvpDeadline | null;
  /**
   * The household's account-link state, exactly as it arrived. Unproven on
   * purpose: `isValidClaimResponse` does not check it, because a bad value must
   * cost the guest the optional account-link box, never the invite. Read it
   * only through `readAccountLink`, which answers `null` (no box) for anything
   * absent, off or malformed.
   */
  accountLink?: unknown;
  /**
   * Whether the household has sent a reply itself, as opposed to only having
   * replies an organiser recorded for it. A household that has is greeted as
   * returning. Unproven, like `accountLink`, so a bad value costs the greeting
   * and never the invite: only `true` counts, and an API that does not send it
   * reads as a first visit.
   */
  householdReplied?: unknown;
  /**
   * Which household member this session says it is, exactly as it arrived.
   * Present for every guest household; absent on a host preview, and for a
   * household of an excluded wedding while account linking is off for it
   * (cire-api's `memberStepOn`). `null` until chosen. Unproven, like `accountLink`: read it only through `readMember`,
   * which answers "no member step" for anything absent or malformed.
   */
  member?: unknown;
}

/**
 * The chosen member's own email address, as the claim payload carries it
 * (`member.email`): the stored form, and who gave it — the guest on this
 * invite, or the hosts. Read only through `readMemberEmail`.
 */
export interface MemberEmail {
  address: string;
  source: "guest" | "organiser_attested";
}
