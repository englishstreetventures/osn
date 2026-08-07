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
  address: string | null;
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
}

export interface RsvpSummary {
  guestId: string;
  eventId: string;
  status: "attending" | "declined" | "maybe";
  dietary: string;
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

export interface ClaimResult {
  publicId: string;
  familyName: string;
  /**
   * True for the organiser host preview session. The RSVP stays interactive but
   * submit is a no-op (nothing is saved) — see RsvpModal's `preview` prop.
   */
  preview?: boolean;
  members: FamilyMember[];
  events: EventSummary[];
  rsvps: RsvpSummary[];
  /**
   * The invite's CLOSING SECTION — the couple's sign-off to this household.
   * Delivered here rather than in the public `GET /api/invite/:slug` because it
   * is addressed to the invited household (S-H1); the public payload redacts it.
   * Optional on the wire so a mid-deploy payload from an older API simply
   * renders no closing section.
   */
  closing?: {
    message: string | null;
    imageUrl: string | null;
    imageCrop?: ImageCrop | null;
  };
  /**
   * The wedding's RSVP-by date, or null when the organiser hasn't set one.
   * Optional on the wire so a mid-deploy payload from an older API simply
   * behaves as it always did — no deadline, no lock.
   */
  rsvpDeadline?: RsvpDeadline | null;
}
