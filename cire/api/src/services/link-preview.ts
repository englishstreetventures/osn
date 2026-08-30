/**
 * Link preview for a registry item — fetch a shop page an organiser pasted and
 * hand back a title, a site name and up to six candidate images for the picker.
 *
 * Why this is the most dangerous module in `cire/api`: every other outbound
 * fetch we make goes to a host WE chose (the OSN issuer, Resend, Stripe,
 * Pinterest). This one goes wherever an organiser's URL points. That is a
 * textbook server-side request forgery sink — the Worker is inside our network
 * position, so "fetch this URL for me" is a request to use our credentials of
 * location. `services/pinterest-resolve.ts` solves the same problem with a host
 * ALLOWLIST, which is the right answer when there is exactly one destination.
 * A registry link is any shop on the internet, so an allowlist is impossible and
 * the guard has to be the shape below instead.
 *
 * Five layers, all of which must pass, and the first three re-run on EVERY
 * redirect hop:
 *
 *   1. Scheme. `https:` only. `http:`, `data:`, `file:`, `javascript:`, `ftp:`,
 *      anything else — refused before a socket exists. Embedded credentials are
 *      refused too (same reasoning as `schemas/registry.ts`'s `parseHttpsUrl`).
 *   2. Destination address. A literal-IP host is range-checked directly, with no
 *      DNS round trip. A named host is resolved over DNS-over-HTTPS and every
 *      answer is range-checked; ANY non-public answer rejects the whole URL, and
 *      a name that resolves to nothing is rejected too (fail closed).
 *   3. Redirects, manually. `redirect: "manual"`, capped at 3 hops, and layers 1
 *      and 2 re-run against each hop's `Location` BEFORE we fetch it. Without
 *      this a benign first host can 302 the Worker to `http://169.254.169.254/`
 *      and the platform's own redirect follower would happily go.
 *   4. Caps. One total time budget across all hops (`AbortSignal.timeout`), a
 *      byte cap read off the stream rather than trusted from `Content-Length`,
 *      and a `Content-Type` that must start with `text/html`.
 *   5. The candidates we emit. Absolute-ised against the FINAL document URL,
 *      `https:` only, and each image host run through layer 2 as well. We do not
 *      fetch those URLs — the organiser's browser does — but a `javascript:` or
 *      `data:` src must never reach a picker that will put it in an `<img>`.
 *
 * **The DoH check is TOCTOU-imperfect and cannot be made otherwise here.** We
 * resolve the name, decide, and then hand the NAME to `fetch`, which resolves it
 * again; an attacker controlling the zone can answer differently the second time
 * (DNS rebinding). Closing that needs a connect-time hook — resolve once, then
 * connect to the address we vetted — and workerd exposes none: there is no
 * socket API under `fetch`, no `lookup` callback, no "pin this address" option.
 * So this is the strongest guard available on this runtime, not the strongest
 * guard that exists. It stops every static private-IP target, every redirect
 * into one, and every host that simply resolves inward; it does not stop a
 * rebinding attacker. Recorded as **S-M1** in `wiki/todo/security.md`.
 *
 * Parsing is a regex scan over the capped body string, deliberately: workerd has
 * `HTMLRewriter`, but these tests run under Bun where it does not exist, and a
 * parser that only runs in production is a parser nothing tests. The scan reads
 * `<meta>`, `<link>` and `<img>` tags only, never executes anything, and its
 * output is treated as untrusted text — so a hostile page can at worst make us
 * emit a URL, which layer 5 then re-checks. No new dependency.
 */

import { Data, Effect } from "effect";

// ---------------------------------------------------------------------------
// Errors — tagged, never thrown. The route maps each onto a status.
// ---------------------------------------------------------------------------

/** Why a URL was refused. Logged; NOT returned to the caller (see the route). */
export type BlockReason =
  | "unparseable"
  | "scheme"
  | "credentials"
  | "no_host"
  | "port"
  | "private_address"
  | "unresolvable";

/** 400-class: the URL (or a hop of it) is one we refuse to fetch. */
export class LinkPreviewBlocked extends Data.TaggedError("LinkPreviewBlocked")<{
  readonly reason: BlockReason;
}> {}

/** 502-class: the page could not be fetched — network, timeout, non-2xx, redirect cap. */
export class LinkPreviewFetchFailed extends Data.TaggedError("LinkPreviewFetchFailed")<{
  readonly reason: "network" | "timeout" | "status" | "too_many_redirects";
}> {}

/** 415-class: it answered, but with something that is not an HTML document. */
export class LinkPreviewUnusableContent extends Data.TaggedError("LinkPreviewUnusableContent")<{
  readonly contentType: string;
}> {}

/** 422-class: a real HTML page with no image we are willing to offer. */
export class LinkPreviewNoImages extends Data.TaggedError("LinkPreviewNoImages") {}

export type LinkPreviewError =
  | LinkPreviewBlocked
  | LinkPreviewFetchFailed
  | LinkPreviewUnusableContent
  | LinkPreviewNoImages;

// ---------------------------------------------------------------------------
// IP range checks — pure, exported for the tests.
// ---------------------------------------------------------------------------

/**
 * Parse a dotted-quad IPv4 literal into four octets, or `null`.
 *
 * Strict on purpose: no leading zeros (`0177.0.0.1` is octal to some resolvers
 * and decimal to others — a classic parser-differential bypass), no shorthand
 * forms (`127.1`), no whitespace. Anything this refuses is treated as a NAME and
 * goes through DNS, where it resolves to nothing and is rejected anyway.
 */
export function parseIpv4(value: string): readonly number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    // `String(n) !== part` catches the leading zero: "010" → 10 → "10".
    if (n > 255 || String(n) !== part) return null;
    octets.push(n);
  }
  return octets;
}

/**
 * Parse an IPv6 literal into 16 bytes, or `null`. Handles `::` compression and
 * the dotted IPv4 tail (`::ffff:127.0.0.1`, `64:ff9b::10.0.0.1`).
 */
export function parseIpv6(value: string): readonly number[] | null {
  let text = value;
  // A zone id (`fe80::1%eth0`) names an interface — always link-local territory,
  // and never something we want to reason about. Drop it; the prefix decides.
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (text.length === 0 || !/^[0-9A-Fa-f:.]+$/.test(text)) return null;

  // A dotted tail contributes the last four bytes.
  let tail: readonly number[] | null = null;
  const lastColon = text.lastIndexOf(":");
  if (text.includes(".")) {
    if (lastColon === -1) return null;
    tail = parseIpv4(text.slice(lastColon + 1));
    if (!tail) return null;
    text = text.slice(0, lastColon + 1) + "0:0";
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const readGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9A-Fa-f]{1,4}$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const head = readGroups(halves[0] ?? "");
  const rest = halves.length === 2 ? readGroups(halves[1] ?? "") : [];
  if (!head || !rest) return null;

  const total = head.length + rest.length;
  if (halves.length === 2 ? total > 8 : total !== 8) return null;
  const groups = [...head, ...Array<number>(8 - total).fill(0), ...rest];

  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  if (tail) {
    bytes.splice(12, 4, ...tail);
  }
  return bytes;
}

/** Is this IPv4 address one we refuse to send a request to? */
function isBlockedIpv4(o: readonly number[]): boolean {
  const [a = 0, b = 0] = o;
  if (a === 0) return true; // 0.0.0.0/8 — "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + broadcast
  return false;
}

/**
 * Is this address non-public — i.e. somewhere the Worker must not be pointed?
 *
 * Takes the textual form a DNS answer or a URL host gives us. An address we
 * cannot parse counts as blocked: an unparseable answer is not a licence to
 * connect to it.
 */
export function isBlockedAddress(value: string): boolean {
  const host = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;

  const v4 = parseIpv4(host);
  if (v4) return isBlockedIpv4(v4);

  const v6 = parseIpv6(host);
  if (!v6) return true;

  // IPv4-mapped (`::ffff:a.b.c.d`) and IPv4-compatible (`::a.b.c.d`) both carry a
  // v4 address in the low 32 bits — unwrap and apply the v4 rules, or every
  // private range above is bypassable by spelling it in IPv6.
  const firstTenZero = v6.slice(0, 10).every((byte) => byte === 0);
  if (firstTenZero && v6[10] === 0xff && v6[11] === 0xff) return isBlockedIpv4(v6.slice(12));
  if (firstTenZero && v6[10] === 0 && v6[11] === 0) {
    const low = v6.slice(12);
    // `::` (unspecified) and `::1` (loopback) are blocked outright; anything else
    // in `::/96` is a mapped v4 address.
    if (low[0] === 0 && low[1] === 0 && low[2] === 0 && (low[3] === 0 || low[3] === 1)) return true;
    return isBlockedIpv4(low);
  }

  // NAT64 (`64:ff9b::/96` and the local prefix `64:ff9b:1::/48`): the low 32 bits
  // are the v4 destination the translator will dial. Same unwrap.
  if (v6[0] === 0x00 && v6[1] === 0x64 && v6[2] === 0xff && v6[3] === 0x9b) {
    return isBlockedIpv4(v6.slice(12));
  }

  const first = v6[0] ?? 0;
  const second = v6[1] ?? 0;
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (first === 0xfe && (second & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (first === 0xff) return true; // ff00::/8 multicast
  return false;
}

/** Is this host string a bare IP literal (v4, or v6 in brackets)? */
export function isIpLiteral(host: string): boolean {
  const inner = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return parseIpv4(inner) !== null || (inner.includes(":") && parseIpv6(inner) !== null);
}

// ---------------------------------------------------------------------------
// DNS-over-HTTPS
// ---------------------------------------------------------------------------

/**
 * Resolve a hostname to its A + AAAA answers. Injected in tests; no network there.
 *
 * `signal` is the OPERATION's budget, not the lookup's — see
 * {@link createDohResolver}. It is optional so a test stub can stay one-argument.
 */
export type HostResolver = (hostname: string, signal?: AbortSignal) => Promise<readonly string[]>;

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
/** DNS is not the budget — a slow resolver must not eat the page's time. */
const DOH_TIMEOUT_MS = 2000;

interface DohAnswer {
  readonly type?: number;
  readonly data?: string;
}

/**
 * Default resolver: Cloudflare's DoH JSON API, one query per record type.
 *
 * `type` 1 is A and 28 is AAAA; CNAME rows (type 5) are ignored — the chain is
 * followed by the resolver, so the address rows are the whole answer. A failed
 * or malformed query contributes no addresses, which the caller reads as
 * "unresolvable" and refuses. It never widens what we are willing to dial.
 *
 * The lookup answers to two clocks (P-W3): its own {@link DOH_TIMEOUT_MS}, and
 * the caller's whole-operation budget. Without the second, DNS sat OUTSIDE the
 * budget the fetches share — a preview that had already spent its 5 seconds on
 * hops could still go on to add 2 more per candidate host. `AbortSignal.any`
 * makes whichever fires first end the query.
 */
export function createDohResolver(fetchImpl: typeof fetch = fetch): HostResolver {
  return async (hostname: string, signal?: AbortSignal) => {
    const query = async (type: "A" | "AAAA"): Promise<readonly string[]> => {
      try {
        const budget = AbortSignal.timeout(DOH_TIMEOUT_MS);
        const res = await fetchImpl(
          `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`,
          {
            method: "GET",
            headers: { accept: "application/dns-json" },
            signal: signal ? AbortSignal.any([signal, budget]) : budget,
          },
        );
        if (!res.ok) return [];
        const body = (await res.json()) as { Answer?: readonly DohAnswer[] };
        return (body.Answer ?? [])
          .filter((a) => a.type === 1 || a.type === 28)
          .map((a) => a.data ?? "")
          .filter((d) => d.length > 0);
      } catch {
        return [];
      }
    };
    const [a, aaaa] = await Promise.all([query("A"), query("AAAA")]);
    return [...a, ...aaaa];
  };
}

// ---------------------------------------------------------------------------
// Options + result
// ---------------------------------------------------------------------------

/** Exported so the image copy in `services/registry-image.ts` uses ONE number. */
export const DEFAULT_MAX_REDIRECTS = 3;
export const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 512 * 1024;
const MAX_IMAGES = 6;
/** Never emit a title longer than the column that will eventually hold it. */
const MAX_TITLE_CHARS = 200;
/** An `<img>` declaring itself smaller than this is an icon, sprite or tracker. */
const MIN_IMG_DIMENSION = 100;

export interface LinkPreviewOptions {
  /** Max redirect hops to follow. Each is re-validated. Default 3. */
  readonly maxRedirects?: number;
  /** TOTAL time budget across every hop and the body read, in ms. Default 5000. */
  readonly timeoutMs?: number;
  /** Body cap in bytes; the stream is abandoned past it. Default 512 KB. */
  readonly maxBytes?: number;
  /** Injectable fetch (tests). Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable DNS resolver (tests). Defaults to Cloudflare DoH over `fetch`. */
  readonly resolveHost?: HostResolver;
}

export interface LinkPreview {
  readonly title: string | null;
  readonly siteName: string | null;
  /** Ranked, deduped, absolute `https:` URLs. At most {@link MAX_IMAGES}. */
  readonly imageUrls: readonly string[];
}

// ---------------------------------------------------------------------------
// HTML scanning (regex, not a parser — see the module comment)
// ---------------------------------------------------------------------------

/**
 * Tag matchers, written so no input can make them backtrack (P-C1).
 *
 * The earlier shapes let the character class match `<`, so an unclosed tag left
 * the engine free to restart the same class at every following position — and
 * this input is a remote page we did not choose. 512 KB of `"<img "` (the byte
 * cap, all of it a start with no `>`) took ~25 seconds of CPU; a Worker on the
 * free plan gets 10 milliseconds. Excluding `<` from the class pins each match
 * to the run of bytes between one `<` and the next, so the scan is linear in the
 * document however hostile it is.
 *
 * The cost is real but tiny: a `<` INSIDE an attribute value (`alt="a < b"`) is
 * legal HTML and now stops the match, so that one tag is skipped. A skipped tag
 * costs a dropped candidate, never a wrong one — and this was never a parser.
 */
const TITLE_RE = /<title[^<>]*>([^<]*)</i;
const META_RE = /<meta\s[^<>]*>/gi;
const LINK_RE = /<link\s[^<>]*>/gi;
const IMG_RE = /<img\s[^<>]*>/gi;

/**
 * How many `<img>` candidates are worth collecting (P-W1).
 *
 * Only {@link MAX_IMAGES} URLs are ever emitted, and every `<img>` shares the
 * bottom rank band, so the sort keeps the FIRST six of them in document order —
 * a decision the 33rd `<img>` cannot change. Higher-ranked candidates
 * (`og:image`, `image_src`) keep being collected without a cap, so nothing that
 * could win is dropped. The headroom over six is for the emit loop, which walks
 * past candidates a redirect or a DNS check refuses.
 */
const MAX_IMG_CANDIDATES = 32;

/** Pull one attribute out of a raw tag string. Quoted or bare, any case. */
function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const m = re.exec(tag);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? null;
}

/**
 * Decode the handful of entities that actually show up in `<title>` and in
 * `content=` attributes. Deliberately small: the output is never re-parsed as
 * HTML, it is JSON on the way to a text node, so an unrecognised entity staying
 * literal is a cosmetic miss, not a hole.
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function clean(value: string | null): string | null {
  if (value === null) return null;
  const text = decodeEntities(value).replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  return text.length > MAX_TITLE_CHARS ? text.slice(0, MAX_TITLE_CHARS) : text;
}

/** A candidate image plus the rank band it came from (lower wins). */
interface Candidate {
  readonly url: string;
  readonly rank: number;
}

const SOCIAL_IMAGE_KEYS = new Set([
  "og:image",
  "og:image:url",
  "og:image:secure_url",
  "twitter:image",
  "twitter:image:src",
]);

interface ScannedHtml {
  readonly title: string | null;
  readonly siteName: string | null;
  readonly candidates: readonly Candidate[];
}

/**
 * Scan a (capped) HTML string for a title, a site name and image candidates.
 *
 * Ranking, best first: the social-card images a shop curates for exactly this
 * purpose (`og:image`, `twitter:image`), then the legacy `<link rel="image_src">`,
 * then `<img>` tags in document order with the ones that declare themselves tiny
 * dropped. Order inside a band is document order, which for a product page puts
 * the hero shot first.
 *
 * URLs come back exactly as the document wrote them — entity decoding happens
 * where a candidate is EMITTED (P-W1), so a page with a thousand images pays for
 * the handful that survive the ranking rather than for all thousand.
 */
export function scanHtml(html: string): ScannedHtml {
  let ogTitle: string | null = null;
  let twitterTitle: string | null = null;
  let siteName: string | null = null;
  const candidates: Candidate[] = [];

  for (const [tag] of html.matchAll(META_RE)) {
    const key = (attr(tag, "property") ?? attr(tag, "name"))?.toLowerCase();
    if (!key) continue;
    const content = attr(tag, "content");
    if (content === null) continue;
    if (SOCIAL_IMAGE_KEYS.has(key)) candidates.push({ url: content, rank: 0 });
    else if (key === "og:title") ogTitle = content;
    else if (key === "twitter:title") twitterTitle = content;
    else if (key === "og:site_name") siteName = content;
  }

  for (const [tag] of html.matchAll(LINK_RE)) {
    const rel = attr(tag, "rel")?.toLowerCase();
    if (rel !== "image_src") continue;
    const href = attr(tag, "href");
    if (href) candidates.push({ url: href, rank: 1 });
  }

  let imgCount = 0;
  for (const [tag] of html.matchAll(IMG_RE)) {
    if (imgCount >= MAX_IMG_CANDIDATES) break;
    const src = attr(tag, "src");
    if (!src) continue;
    // A declared dimension is the only size signal available without fetching
    // the bytes. Absent dimensions are kept — most product images declare none.
    const width = Number(attr(tag, "width") ?? Number.NaN);
    const height = Number(attr(tag, "height") ?? Number.NaN);
    if (Number.isFinite(width) && width < MIN_IMG_DIMENSION) continue;
    if (Number.isFinite(height) && height < MIN_IMG_DIMENSION) continue;
    candidates.push({ url: src, rank: 2 });
    imgCount += 1;
  }

  const rawTitle = TITLE_RE.exec(html)?.[1] ?? null;
  return {
    title: clean(ogTitle) ?? clean(twitterTitle) ?? clean(rawTitle),
    siteName: clean(siteName),
    candidates,
  };
}

// ---------------------------------------------------------------------------
// The network half
// ---------------------------------------------------------------------------

/** Read at most `maxBytes` off the body, then abandon the stream. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // Reading a stream is sequential by definition.
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = (await reader.read()) as {
      done: boolean;
      value?: Uint8Array;
    };
    if (done) break;
    if (!value) continue;
    const remaining = maxBytes - total;
    if (value.byteLength >= remaining) {
      chunks.push(value.subarray(0, remaining));
      // Past the cap — hang up rather than keep pulling. `Content-Length` is a
      // claim by the same server that would lie about it, so the cap is enforced
      // on what actually arrives. Reading a stream is sequential by definition —
      // there is no set of promises to run in parallel here.
      // oxlint-disable-next-line no-await-in-loop
      await reader.cancel().catch(() => undefined);
      total = maxBytes;
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // `fatal: false` is the point: a truncated page ends mid-multi-byte character
  // by construction, and a throw there would turn "the page was too big" into an
  // unhandled defect. `ignoreBOM` is spelled out only because workers-types
  // declares both fields required.
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(buffer);
}

/**
 * Read at most `maxBytes` off the body as bytes, REJECTING past the cap.
 *
 * The sibling {@link readCapped} truncates instead, which is right for HTML (a
 * half-read page still scans) and wrong for anything binary: a truncated image
 * is a corrupt image, and storing one would put a broken object in R2 that looks
 * fine until it is rendered. So this one fails.
 *
 * `Content-Length` is consulted first purely to avoid pulling bytes we already
 * know we will refuse — it is a claim by the same server that would lie about
 * it, so the real enforcement is still on what actually arrives.
 */
export type CappedBytes =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: "too_large" };

export async function readCappedBytes(response: Response, maxBytes: number): Promise<CappedBytes> {
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "too_large" };
  }

  const body = response.body;
  if (!body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // Reading a stream is sequential by definition.
    // oxlint-disable-next-line no-await-in-loop
    const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      // oxlint-disable-next-line no-await-in-loop
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: "too_large" };
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: buffer };
}

/**
 * Everything one guarded operation needs, resolved from the options once.
 *
 * Exported because `services/registry-image.ts` runs the SAME guard when the
 * organiser picks one of the candidates we emitted. That URL arrives in a
 * request body, and a request body is client-controlled — nothing proves it is
 * one of ours — so it gets all five layers again rather than a lighter check.
 * One guard per operation: the host memo is a per-request cache, never a shared
 * one an attacker could prime.
 */
export interface UrlGuard {
  readonly resolveHost: HostResolver;
  /** Memo of host → allowed, so six images on one host cost one lookup. */
  readonly seen: Map<string, boolean>;
  /** The operation's time budget, handed to every DNS lookup the guard makes. */
  readonly signal?: AbortSignal;
}

/**
 * A fresh guard, with an empty host memo, for one operation.
 *
 * Pass the operation's `signal` so DNS runs inside the same budget as the
 * fetches (P-W3). Omitting it leaves each lookup on its own 2s timeout, which is
 * what the tests do.
 */
export function createUrlGuard(resolveHost: HostResolver, signal?: AbortSignal): UrlGuard {
  return { resolveHost, seen: new Map<string, boolean>(), signal };
}

/**
 * Layers 1 + 2 for one URL: scheme, credentials, then the address behind the
 * host. Returns the parsed URL or a `BlockReason`; never throws.
 */
export async function checkUrl(
  raw: string,
  base: string | null,
  guard: UrlGuard,
): Promise<URL | BlockReason> {
  let url: URL;
  try {
    url = base === null ? new URL(raw) : new URL(raw, base);
  } catch {
    return "unparseable";
  }
  if (url.protocol !== "https:") return "scheme";
  if (url.username !== "" || url.password !== "") return "credentials";
  const host = url.hostname.toLowerCase();
  if (host.length === 0) return "no_host";
  // Default port only. Every shop link an organiser pastes is on 443, so an
  // allowlist of one costs nothing legitimate — and it removes the port-scanning
  // primitive outright: without it the address checks pass any *public* host on
  // any port, and the route's own success/502/415 outcomes are the oracle.
  if (url.port !== "" && url.port !== "443") return "port";

  const cached = guard.seen.get(host);
  if (cached !== undefined) return cached ? url : "private_address";

  // A literal IP needs no DNS — and must not get one, or a lookup failure for a
  // name that is already an address would read as "unresolvable" instead of the
  // range check it deserves.
  if (isIpLiteral(host)) {
    const ok = !isBlockedAddress(host);
    guard.seen.set(host, ok);
    return ok ? url : "private_address";
  }

  // A resolver that throws must read as "no answer", not as a crash: failing
  // open here would hand every DNS outage a free SSRF.
  let addresses: readonly string[];
  try {
    addresses = await guard.resolveHost(host, guard.signal);
  } catch {
    addresses = [];
  }
  if (addresses.length === 0) {
    guard.seen.set(host, false);
    return "unresolvable";
  }
  // ANY non-public answer rejects the name. A round-robin record that mixes a
  // public address with 127.0.0.1 is not a host we fetch two times out of three.
  const ok = addresses.every((address) => !isBlockedAddress(address));
  guard.seen.set(host, ok);
  return ok ? url : "private_address";
}

/** Why a guarded fetch stopped. Structural, not tagged: each caller owns its errors. */
export type GuardedFetchFailure =
  | { readonly kind: "blocked"; readonly reason: BlockReason }
  | {
      readonly kind: "fetch";
      readonly reason: "network" | "timeout" | "status" | "too_many_redirects";
    };

export type GuardedFetchResult =
  /** The body is UNREAD — the caller reads it under its own cap. */
  | { readonly ok: true; readonly response: Response; readonly finalUrl: URL }
  | { readonly ok: false; readonly failure: GuardedFetchFailure };

export interface GuardedFetchArgs {
  readonly url: string;
  readonly guard: UrlGuard;
  readonly fetchImpl: typeof fetch;
  readonly maxRedirects: number;
  /** ONE budget for the whole operation — every hop and the body read share it. */
  readonly signal: AbortSignal;
  /** `Accept` sent on every hop. Advisory only; the response is still checked. */
  readonly accept: string;
  readonly userAgent: string;
}

/**
 * Layers 1–3 of the module guard, as one primitive: GET a caller-supplied URL
 * with manual, individually re-validated redirects, under one time budget.
 *
 * This is the ONLY place in `cire/api` that opens a socket to a host a user
 * named, and both callers — the HTML preview here and the image copy in
 * `services/registry-image.ts` — go through it. That is deliberate: two
 * hand-rolled hop loops would be two chances to forget `redirect: "manual"`,
 * and forgetting it once hands the platform's own redirect follower a straight
 * line into `http://169.254.169.254/`.
 *
 * Plain async because the loop is the clearest expression of it. It never
 * throws; every exit is a `GuardedFetchFailure` the caller maps to its own
 * tagged error, and the success case hands back the response with its body
 * still unread, so each caller enforces the cap its content type deserves.
 */
export async function guardedFetch(args: GuardedFetchArgs): Promise<GuardedFetchResult> {
  const { url, guard, fetchImpl, maxRedirects, signal, accept, userAgent } = args;
  let current = url;
  let base: string | null = null;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    // Sequential by nature: this hop's URL is the previous hop's Location
    // header, so there is no set of checks to run together — and the check has
    // to clear before the fetch that follows it, or the SSRF guard would be
    // racing the request it exists to prevent.
    // eslint-disable-next-line no-await-in-loop
    const checked = await checkUrl(current, base, guard);
    if (typeof checked === "string") {
      return { ok: false, failure: { kind: "blocked", reason: checked } };
    }

    let response: Response;
    try {
      // Hops are sequential — each follows the previous hop's Location.
      // eslint-disable-next-line no-await-in-loop
      response = await fetchImpl(checked.href, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { accept, "user-agent": userAgent },
      });
    } catch (cause) {
      const timedOut = signal.aborted || (cause as { name?: string })?.name === "TimeoutError";
      return { ok: false, failure: { kind: "fetch", reason: timedOut ? "timeout" : "network" } };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return { ok: false, failure: { kind: "fetch", reason: "status" } };
      }
      // The next iteration re-runs the FULL scheme + address check on this
      // location before any socket opens. That is the whole point of `manual`.
      base = checked.href;
      current = location;
      continue;
    }

    if (!response.ok) {
      return { ok: false, failure: { kind: "fetch", reason: "status" } };
    }

    return { ok: true, response, finalUrl: checked };
  }

  // Fell out of the loop still redirecting: a chain this long is either a loop
  // or a host playing games. Either way we stop.
  return { ok: false, failure: { kind: "fetch", reason: "too_many_redirects" } };
}

interface FetchedDocument {
  /** The URL the document was actually served from (after redirects). */
  readonly finalUrl: URL;
  readonly html: string;
}

type FetchOutcome =
  | { readonly ok: true; readonly document: FetchedDocument }
  | { readonly ok: false; readonly error: LinkPreviewError };

/** Map a shared-primitive failure onto this module's tagged errors. */
function toPreviewError(failure: GuardedFetchFailure): LinkPreviewError {
  return failure.kind === "blocked"
    ? new LinkPreviewBlocked({ reason: failure.reason })
    : new LinkPreviewFetchFailed({ reason: failure.reason });
}

/**
 * The HTML half of layer 4: {@link guardedFetch}, then the `text/html` demand
 * and the capped body read. Every exit is a tagged error the Effect wrapper
 * re-raises with a log line.
 */
async function fetchDocument(
  input: string,
  guard: UrlGuard,
  fetchImpl: typeof fetch,
  maxRedirects: number,
  maxBytes: number,
  signal: AbortSignal,
): Promise<FetchOutcome> {
  const fetched = await guardedFetch({
    url: input,
    guard,
    fetchImpl,
    maxRedirects,
    signal,
    accept: "text/html,application/xhtml+xml",
    userAgent: "cire-link-preview/1.0",
  });
  if (!fetched.ok) return { ok: false, error: toPreviewError(fetched.failure) };

  const { response, finalUrl } = fetched;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.trim().toLowerCase().startsWith("text/html")) {
    return { ok: false, error: new LinkPreviewUnusableContent({ contentType }) };
  }

  let html: string;
  try {
    html = await readCapped(response, maxBytes);
  } catch (cause) {
    const timedOut = signal.aborted || (cause as { name?: string })?.name === "TimeoutError";
    return {
      ok: false,
      error: new LinkPreviewFetchFailed({ reason: timedOut ? "timeout" : "network" }),
    };
  }
  return { ok: true, document: { finalUrl, html } };
}

/**
 * How far down the ranked list the host warm-up looks, and how many distinct
 * hosts it will resolve. Bounds the fan-out so a page listing a hundred hosts
 * cannot turn one preview into a hundred DNS queries.
 */
const PREFETCH_CANDIDATES = 32;
const PREFETCH_HOSTS = 8;

/** The host a candidate would be fetched from, or null if it is not an https URL. */
function candidateHost(raw: string, base: string): string | null {
  try {
    const url = new URL(raw, base);
    return url.protocol === "https:" ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Warm `guard.seen` by resolving the DISTINCT hosts of the top candidates at
 * once (P-W3).
 *
 * The emit loop below stays sequential and unchanged, so the order and the
 * membership of the result are exactly what they were — this only decides WHEN
 * the DNS answers arrive. In series, six images across six hosts cost six round
 * trips end to end; in parallel they cost one, and the memo means the loop then
 * finds every answer already there.
 *
 * One check per distinct host, not per candidate: `checkUrl` writes the memo, so
 * dispatching two URLs on one host would put two identical queries in flight
 * before either had written it. Hosts already in the memo (the document's own,
 * resolved during the fetch) are skipped.
 */
async function warmHosts(
  ranked: readonly Candidate[],
  finalUrl: URL,
  guard: UrlGuard,
): Promise<void> {
  const pending = new Map<string, string>();
  for (const candidate of ranked.slice(0, PREFETCH_CANDIDATES)) {
    if (pending.size >= PREFETCH_HOSTS) break;
    const host = candidateHost(decodeEntities(candidate.url), finalUrl.href);
    if (host === null || guard.seen.has(host) || pending.has(host)) continue;
    pending.set(host, candidate.url);
  }
  await Promise.all(
    Array.from(pending.values(), (url) =>
      checkUrl(decodeEntities(url), finalUrl.href, guard).catch(() => undefined),
    ),
  );
}

/** Layer 5: absolute-ise, keep `https:`, re-check the host, dedupe, cap. */
async function resolveCandidates(
  candidates: readonly Candidate[],
  finalUrl: URL,
  guard: UrlGuard,
): Promise<readonly string[]> {
  const ranked = [...candidates];
  // `toSorted` is ES2023 and this package's lib is ES2022. Copy, then sort.
  ranked.sort((a, b) => a.rank - b.rank);

  await warmHosts(ranked, finalUrl, guard);

  const out: string[] = [];
  const seenUrls = new Set<string>();
  for (const candidate of ranked) {
    if (out.length >= MAX_IMAGES) break;
    // Entities are decoded HERE rather than at scan time (P-W1): only the
    // candidates that reach this loop are worth the string work.
    //
    // Sequential on purpose, and NOT a `Promise.all` over `ranked`: the break
    // above stops at MAX_IMAGES, so checking the candidates together would
    // resolve hosts the picker never reaches and push DoH lookups past the cap
    // `warmHosts` was written to respect.
    // eslint-disable-next-line no-await-in-loop
    const checked = await checkUrl(decodeEntities(candidate.url), finalUrl.href, guard);
    // A `javascript:` / `data:` src, a private host, an unparseable value — all
    // land here as a reason string and are simply dropped. The picker only ever
    // sees URLs that would have passed the fetch guard.
    if (typeof checked === "string") continue;
    if (seenUrls.has(checked.href)) continue;
    seenUrls.add(checked.href);
    out.push(checked.href);
  }
  return out;
}

/**
 * Fetch `rawUrl` and extract a preview.
 *
 * Failure is always a tagged error, never a rejection, and every one of them
 * logs — with the HOST only. A registry link is a thing the couple is buying;
 * the full URL is theirs, and the resolved address is never logged next to it.
 */
function preview(
  rawUrl: string,
  options: LinkPreviewOptions = {},
): Effect.Effect<LinkPreview, LinkPreviewError> {
  const {
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    fetchImpl = fetch,
    resolveHost = createDohResolver(fetchImpl),
  } = options;

  return Effect.gen(function* () {
    // ONE budget for the whole operation — hops included. A chain of three hosts
    // each answering just inside a per-hop timeout must not add up to 15s of a
    // Worker's wall clock.
    const signal = AbortSignal.timeout(timeoutMs);
    // The guard holds the same signal, so the DNS lookups it makes are inside the
    // budget too rather than beside it (P-W3) — a stalled resolver used to be able
    // to outlive the fetch it was gating.
    const guard = createUrlGuard(resolveHost, signal);

    const outcome = yield* Effect.promise(() =>
      fetchDocument(rawUrl, guard, fetchImpl, maxRedirects, maxBytes, signal),
    );

    if (!outcome.ok) {
      const error = outcome.error;
      yield* logFailure(error);
      return yield* Effect.fail(error);
    }

    const { finalUrl, html } = outcome.document;
    const scanned = scanHtml(html);
    const imageUrls = yield* Effect.promise(() =>
      resolveCandidates(scanned.candidates, finalUrl, guard),
    );

    if (imageUrls.length === 0) {
      const error = new LinkPreviewNoImages();
      yield* logFailure(error);
      return yield* Effect.fail(error);
    }

    return {
      title: scanned.title,
      // Falling back to the host is the honest answer when a page names no site:
      // it is what the organiser is about to see under the picker anyway.
      siteName: scanned.siteName ?? finalUrl.hostname,
      imageUrls,
    } satisfies LinkPreview;
  }).pipe(Effect.withSpan("cire.link-preview.preview"));
}

/**
 * One log line per failure. Annotations are bounded strings only — no URL, no
 * address, nothing an organiser typed. A blocked private address is an ERROR
 * (someone pointed us inward); everything else is a warning about the internet
 * being the internet.
 */
function logFailure(error: LinkPreviewError): Effect.Effect<void> {
  switch (error._tag) {
    case "LinkPreviewBlocked":
      return error.reason === "private_address"
        ? Effect.logError("link preview refused a non-public destination").pipe(
            Effect.annotateLogs({ reason: error.reason }),
          )
        : Effect.logWarning("link preview refused a url").pipe(
            Effect.annotateLogs({ reason: error.reason }),
          );
    case "LinkPreviewFetchFailed":
      return Effect.logWarning("link preview fetch failed").pipe(
        Effect.annotateLogs({ reason: error.reason }),
      );
    case "LinkPreviewUnusableContent":
      // The content type is a server-chosen header; cap it so a hostile page
      // cannot write a novel into our logs.
      return Effect.logWarning("link preview got a non-html document").pipe(
        Effect.annotateLogs({ contentType: error.contentType.slice(0, 64) }),
      );
    case "LinkPreviewNoImages":
      return Effect.logWarning("link preview found no usable images");
  }
}

export const linkPreviewService = { preview };
