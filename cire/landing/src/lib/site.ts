// Single source of truth for the marketing site's external targets and imagery.
// Centralised so the apex cutover (organiser → host.cireweddings.com, invites →
// invite.cireweddings.com) and any asset swap are one-line edits, not a hunt
// through markup. See [[wiki/cire/cire-landing]].

/**
 * Organiser portal — target of every primary "Create your invitation" CTA.
 * Build-time override via PUBLIC_ORGANISER_URL; the default is the local
 * organiser dev server so `bun run dev` works without env wiring. End-state prod
 * value is https://host.cireweddings.com (set in production-release.yml).
 */
export const ORGANISER_URL = import.meta.env.PUBLIC_ORGANISER_URL ?? "http://localhost:4322";

/**
 * "See a live invite" CTA. When PUBLIC_DEMO_INVITE_URL points at a real seeded
 * invitation we link out to it; otherwise the CTA is an in-page anchor to the
 * interactive (no-op) demo below the fold — see {@link DEMO_ANCHOR}.
 */
export const DEMO_INVITE_URL = import.meta.env.PUBLIC_DEMO_INVITE_URL ?? null;

/** Fragment id of the in-page interactive demo invite section. */
export const DEMO_ANCHOR = "#see-it-live";

export const SITE_NAME = "Cire";
export const SITE_TAGLINE = "Invitations worthy of the moment";
export const SITE_DESCRIPTION =
  "Cire is a bespoke digital wedding invitation: tactile, animated and personal as handcrafted paper, with every RSVP tracked for you. Share one link, and watch the replies roll in.";

/**
 * Hotlinked Unsplash imagery: one photograph, in the craft section. It loads in
 * the visitor's browser straight from Unsplash's CDN (the build never downloads
 * it), which is how Unsplash intends hosted images to be used. It is a
 * PLACEHOLDER — swap `id` for the brand's own art when it exists; it paints over
 * a gold gradient so a slow or failed load never leaves an empty hole, and
 * `credit` is shown where the Unsplash licence asks for it. The rest of the page
 * shows the product as drawings in the site's own tokens (`components/mock/`).
 */
export interface SiteImage {
  /** Unsplash photo id (the `photo-...` slug); the URL is composed in `unsplash()`. */
  readonly id: string;
  readonly alt: string;
  readonly credit: string;
}

/** Compose a responsive Unsplash delivery URL for a photo id. */
export function unsplash(id: string, width = 1600): string {
  return `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${width}&q=80`;
}

export const IMAGES = {
  // The craft section: a quiet, considered detail shot.
  craft: {
    id: "photo-1511285560929-80b456fea0bc",
    alt: "A beautifully laid place setting with a handwritten name card",
    credit: "Photo: Jonathan Borba / Unsplash",
  },
} as const satisfies Record<string, SiteImage>;
