import type { JSX } from "solid-js";

/**
 * A small pill that names a state: a listing that is live or a draft, an enquiry
 * that is open, quoted or closed.
 *
 * Two call sites, and before this they were two different chips — the listing
 * badge at `px-3 py-1 text-[0.72rem]` and the enquiry status at
 * `px-2 py-0.5 text-[0.68rem]`, which put the same idea at two sizes on two
 * screens a vendor moves between. The host portal writes its role badge longhand
 * in `TopBar`; this is the shape it would take if it adopted one.
 *
 * ## The tones are not the palette
 *
 * The status colours here are the ramp's — `success`, `gold`, `brand-ink` — and
 * not the raw Tailwind palette the two call sites reached for
 * (`bg-green-500/15 text-green-400`, `bg-blue-500/10 text-blue-400`). Those are
 * fixed sRGB values: they do not move when the theme flips, so a blue "quoted"
 * chip that reads on the dark ground is a bright blue smear on the light one.
 *
 * ## Colour is never the only carrier
 *
 * The chip's text *is* the state — "live", "quoted" — so the hue is decoration
 * on top of a word that already says it. That is the whole reason this takes a
 * `children` and not just a `tone`: a chip with a tone and no text would be a
 * colour nobody can name.
 */

export type ChipTone = "neutral" | "live" | "active" | "quoted";

const BASE =
  "font-body inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 " +
  "text-[0.68rem] tracking-[0.12em] whitespace-nowrap uppercase";

const TONE = {
  /** Nothing has happened yet: a draft listing, a closed enquiry. */
  neutral: "bg-surface/60 text-text-muted",
  /** Published and visible to couples. */
  live: "bg-success/12 text-success",
  /** Waiting on the vendor. */
  active: "bg-gold/12 text-gold-ink",
  /** The vendor has answered with a number. */
  quoted: "bg-brand-wash text-brand-ink",
} satisfies Readonly<Record<ChipTone, string>>;

export default function Chip(props: { tone?: ChipTone; children: JSX.Element }) {
  return <span class={`${BASE} ${TONE[props.tone ?? "neutral"]}`}>{props.children}</span>;
}
