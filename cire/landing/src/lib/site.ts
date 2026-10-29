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
 * The site's one photograph, in the craft section, served from this site's
 * own `public/images/` so a visit sends nothing to another host (the CSP in
 * `public/_headers` allows images from this origin only). It is an Unsplash
 * photo, used under the Unsplash License, which allows downloading and serving
 * a copy; `credit` names the photographer all the same. It is a placeholder:
 * swap the files for the brand's own art when it exists. It paints over a gold
 * gradient so a slow or failed load never leaves an empty hole. The rest of the
 * page shows the product as drawings in the site's own tokens
 * (`components/mock/`).
 */
export interface SiteImageFile {
  /** Pixel width of the file, for `srcset`. */
  readonly width: number;
  /** Path under `public/`. */
  readonly src: string;
}

export interface SiteImage {
  /** Each width the image is served at, narrowest first; the first is the `src`. */
  readonly files: readonly [SiteImageFile, ...SiteImageFile[]];
  readonly alt: string;
  readonly credit: string;
}

export const IMAGES = {
  // The craft section: a quiet, considered detail shot.
  craft: {
    files: [
      { width: 800, src: "/images/craft-place-setting-800.webp" },
      { width: 1600, src: "/images/craft-place-setting-1600.webp" },
    ],
    alt: "A beautifully laid place setting with a handwritten name card",
    credit: "Photo: Jonathan Borba / Unsplash",
  },
} as const satisfies Record<string, SiteImage>;
