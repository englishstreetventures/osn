/**
 * The wire contract shared by a product API, its hub and the browser: which
 * topics exist, what a signal says, and the frames and close codes both ends
 * agree on. It imports nothing, so server, hub and client can all depend on it.
 */

/**
 * Products that own topics. A topic's first segment must be one of these. A
 * product joins the list when it adopts realtime push.
 */
export const REALTIME_PRODUCTS = ["cire"] as const;
export type RealtimeProduct = (typeof REALTIME_PRODUCTS)[number];

/** What a signal can say. Closed: a new kind is a new member here. */
export const SIGNAL_KINDS = ["members-changed"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** "Something about `topic` changed" — never the data itself. */
export interface Signal {
  readonly topic: string;
  readonly kind: SignalKind;
  /** Server time the signal was published, in ms since the epoch. */
  readonly at: number;
}

/**
 * `<product>:<entity>:<id>`. Product and entity are lowercase letters, the
 * entity at most 32; the id is 1–64 characters of `[A-Za-z0-9_-]`, wide enough
 * for every id the products mint. A product narrows the id further before it
 * trusts it.
 */
export const TOPIC_PATTERN = /^([a-z]+):([a-z]{1,32}):([A-Za-z0-9_-]{1,64})$/;

export interface ParsedTopic {
  readonly product: RealtimeProduct;
  readonly entity: string;
  readonly id: string;
}

const isProduct = (value: string): value is RealtimeProduct =>
  (REALTIME_PRODUCTS as readonly string[]).includes(value);

const isKind = (value: unknown): value is SignalKind =>
  typeof value === "string" && (SIGNAL_KINDS as readonly string[]).includes(value);

/** The topic's parts, or null when it is not a topic of a known product. */
export function parseTopic(topic: string): ParsedTopic | null {
  const match = TOPIC_PATTERN.exec(topic);
  if (!match) return null;
  const [, product, entity, id] = match;
  if (product === undefined || entity === undefined || id === undefined) return null;
  if (!isProduct(product)) return null;
  return { product, entity, id };
}

/** A topic built from its parts, or null when they would not parse back. */
export function formatTopic(product: RealtimeProduct, entity: string, id: string): string | null {
  const topic = `${product}:${entity}:${id}`;
  return parseTopic(topic) ? topic : null;
}

/** True when a decoded frame is a well-formed signal. */
export function isSignal(value: unknown): value is Signal {
  if (typeof value !== "object" || value === null) return false;
  if (!("topic" in value) || !("kind" in value) || !("at" in value)) return false;
  const { topic, kind, at } = value;
  return (
    typeof topic === "string" &&
    parseTopic(topic) !== null &&
    isKind(kind) &&
    typeof at === "number" &&
    Number.isFinite(at)
  );
}

/** The text frame a client sends to keep its socket alive, and the hub's reply. */
export const PING = "ping";
export const PONG = "pong";

/**
 * Close codes the hub sends. The client treats `policy` as final and every
 * other close as a loss to recover from.
 */
export const CLOSE_CODES = {
  /** The topic is full, or the client sent a frame the protocol does not allow. */
  policy: 1008,
  /** The subject's membership changed: reconnect so it is checked again. */
  evicted: 4001,
  /** The hub needed room and this socket had not pinged lately: reconnect if still wanted. */
  stale: 4002,
} as const;
