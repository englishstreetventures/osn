import type { ImageCrop } from "../components/image-crop";
import type { InviteTheme } from "../components/invite-theme";

/**
 * Hero display sliders the organiser picked, as they arrive from the public
 * invite endpoint (migration 0018 replaced the coarse `blurred|regular` /
 * `none|solid` enums). Always concrete (the API coalesces a missing row to the
 * today's-look default). Mirrors `HeroDisplay` in `cire/api/src/services/invite.ts`.
 *
 *  - `blur` (0–40): the hero backdrop's Gaussian blur — applied SERVER-SIDE on
 *    the `hero-bg` variant (the value lives on the row; the guest just requests
 *    `hero-bg` and gets back the right radius). 28 = today's soft look; 0 = sharp.
 *  - `titleBackdrop.opacity` (0–100): opacity (÷100) of the legibility panel
 *    behind the hero title block. 0 (default) ⇒ no panel (just the radial scrim).
 *  - `titleBackdrop.blur` (0–20): frosted-glass `backdrop-filter` blur in px
 *    behind the title. 0 (default) ⇒ no frost.
 */
export interface HeroDisplay {
  blur: number;
  titleBackdrop: { opacity: number; blur: number };
}

export interface InviteCustomisation {
  hero: {
    title: string | null;
    subtitle: string | null;
    imageUrl: string | null;
    // Optional so a mid-deploy payload (older API) without it falls back to no crop.
    imageCrop?: ImageCrop | null;
    // Phone-specific hero crop (migration 0046), applied below the packs' `md:`
    // breakpoint. Optional for the same mid-deploy reason; absent/null ⇒ narrow
    // viewports fall back to `imageCrop` (the pre-0046 render).
    imageCropMobile?: ImageCrop | null;
  };
  story: {
    eyebrow: string | null;
    heading: string | null;
    body: string | null;
    imageUrl: string | null;
    imageCrop?: ImageCrop | null;
  };
  // Events-section header copy + post-claim greeting (rendered by InvitePage /
  // LoginSection, not this island). Optional so a mid-deploy payload from an
  // older API simply keeps the built-in copy.
  details?: { eyebrow: string | null; heading: string | null };
  welcome?: { message: string | null };
  // Gift-registry section header copy (eyebrow + heading + intro body). Same
  // nullable-means-built-in-default contract as `details`, and optional for the
  // same mid-deploy reason. Note this copy is PUBLIC and independent of the
  // registry itself: a wedding that never opened a registry may still carry a
  // heading here, and whether the section renders at all is decided by the
  // registry endpoint's own entitlement + `published` check, never by this.
  registry?: { eyebrow: string | null; heading: string | null; body: string | null };
  // NOTE: the closing section (`footer_*`) is deliberately ABSENT here. It is
  // addressed to the invited household, so the API redacts it from the public
  // `GET /api/invite/:slug` this type describes and delivers it in the claim
  // response instead (see `ClaimResult.closing`). S-H1.
  heroDisplay: HeroDisplay;
  theme: InviteTheme;
  /** Which design pack renders this invite (0045). Optional so payloads from
   *  an older API deploy still parse; resolve through `resolveDesignId`. */
  designId?: string;
}

/**
 * The data contract every design pack's `Document.astro` receives — the same
 * data regardless of design. Claim flow and `ClaimResult` stay design-agnostic.
 */
export interface InviteDesignProps {
  /** cire-api origin the islands fetch from at runtime. */
  apiUrl: string;
  /** The wedding slug resolved from the request path; threaded to the islands. */
  slug: string;
  /** Invite customisation fetched server-side for this slug (per request). */
  initialInvite: InviteCustomisation | null;
  /** Canonical guest-site origin for share metadata (PUBLIC_SITE_URL). */
  siteUrl?: string;
}
