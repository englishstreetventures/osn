/** One entry in the envelope catalog. */
export interface EnvelopeMeta {
  readonly id: string;
  /** Display name shown in the organiser's picker. */
  readonly name: string;
  /**
   * Every envelope is premium: it needs a wedding on Crimson, or one holding
   * the one-off `premium_templates` entitlement. cire-api gates every catalog
   * envelope that way on save and on the guest read, so a free envelope means
   * widening this type and both of those gates together.
   */
  readonly tier: "premium";
}

/**
 * The envelope catalog: the opening a couple can put in front of their invite.
 * A wedding has none until its organiser picks one. cire-api checks a save
 * against these ids and serves a guest only an id listed here.
 */
export const ENVELOPES = [
  { id: "wax-seal", name: "Wax seal", tier: "premium" },
] as const satisfies readonly EnvelopeMeta[];

/** Union of catalog envelope ids (`"wax-seal"`). */
export type EnvelopeId = (typeof ENVELOPES)[number]["id"];

/** Whether `value` is a catalog envelope id. */
export function isEnvelopeId(value: unknown): value is EnvelopeId {
  return ENVELOPES.some((e) => e.id === value);
}

/** The ways the seal can break when the guest opens the envelope. */
export const BREAK_STYLES = ["split", "peel", "crumble"] as const;

/** One of {@link BREAK_STYLES}. */
export type BreakStyle = (typeof BREAK_STYLES)[number];

/**
 * The query parameter that names the break instead of drawing one:
 * `?envelope-break=peel`. For tests and the organiser's preview.
 */
export const ENVELOPE_BREAK_PARAM = "envelope-break";

/**
 * The break to play: the style the query names, when it names one of
 * {@link BREAK_STYLES} exactly, otherwise one drawn at random.
 *
 * Both inputs are passed in so this module needs no DOM: a browser passes
 * `new URLSearchParams(location.search)` and
 * `(array) => crypto.getRandomValues(array)`. The draw takes one 32-bit value
 * modulo 3, which favours `split` by one value in 2^32.
 */
export function pickBreak(
  query: { get(name: string): string | null },
  fill: (array: Uint32Array) => Uint32Array,
): BreakStyle {
  const named = query.get(ENVELOPE_BREAK_PARAM);
  const style = BREAK_STYLES.find((s) => s === named);
  if (style) return style;
  const value = fill(new Uint32Array(1))[0];
  return BREAK_STYLES[value % BREAK_STYLES.length];
}
