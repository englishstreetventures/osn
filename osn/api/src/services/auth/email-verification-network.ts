/**
 * The outbound half of the browser Email Verification API verifier: DNS TXT
 * lookups over DNS-over-HTTPS, and GETs of an issuer's metadata and keys.
 * Workers have no raw DNS, so every lookup is a DoH query to one fixed
 * resolver over HTTPS.
 *
 * Everything leaves through one injected `fetch` ({@link IssuerFetch}), so
 * tests and the E2E stack put a fake issuer behind it. What a GET may reach:
 *
 *  - `https:` on the default port only, with no user name or password;
 *  - a host name, never an IP literal, with at least one dot and not under
 *    `localhost`;
 *  - a host whose every A and AAAA answer is a public address: loopback,
 *    private, link-local, shared, multicast and reserved ranges are refused,
 *    and so is a host with no answer at all;
 *  - no redirect is followed, to any host: a 3xx is refused;
 *  - 200 only, a JSON media type, at most {@link ISSUER_RESPONSE_MAX_BYTES},
 *    within {@link ISSUER_REQUEST_TIMEOUT_MS}.
 *
 * On workerd `fetch` resolves the host again by itself, so the address check
 * cannot pin the address it checked; Cloudflare's network does not carry a
 * Worker's subrequest to a private address, which closes that gap there.
 *
 * What leaves: the email address's domain (in `_email-verification.<domain>`)
 * and the issuer's and its key server's host names go to the resolver; the
 * issuer's hosts receive plain GETs of their public metadata and keys. Never
 * the address's local part, and never the token.
 */

/** The resolver every lookup goes to: Cloudflare's, over HTTPS, JSON API. */
export const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
/** One request's time limit. */
export const ISSUER_REQUEST_TIMEOUT_MS = 3_000;
/** The largest response body read, from the resolver or an issuer. */
export const ISSUER_RESPONSE_MAX_BYTES = 64 * 1024;

/** The one outbound seam. Defaults to the runtime's `fetch`. */
export type IssuerFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Why a lookup gave up: the issuer could not be found or fetched safely
 * (`issuer`), or the network did not answer in time (`unavailable`).
 */
export class IssuerLookupError extends Error {
  constructor(
    readonly outcome: "issuer" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "IssuerLookupError";
  }
}

/** A JSON value, as `JSON.parse` gives it. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

/** A JSON object. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `text` parsed as JSON; throws as `JSON.parse` does. */
export function parseJson(text: string): JsonValue {
  const parsed: JsonValue = JSON.parse(text);
  return parsed;
}

export interface IssuerNetwork {
  /** The TXT strings at `name`, each record's strings joined; [] when none. */
  txt(name: string, signal: AbortSignal): Promise<string[]>;
  /** GETs `url` under the rules above; its body must be a JSON object. */
  json(url: string, signal: AbortSignal): Promise<JsonObject>;
}

const TYPE_A = 1;
const TYPE_TXT = 16;
const TYPE_AAAA = 28;

const HOST_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Whether `host` is a DNS host name this module may look up: lowercase ASCII, dotted, not local. */
export function isLookupHost(host: string): boolean {
  if (!HOST_RE.test(host)) return false;
  if (IPV4_RE.test(host)) return false;
  return host !== "localhost" && !host.endsWith(".localhost");
}

const v4Octets = (ip: string): number[] | null => {
  const m = IPV4_RE.exec(ip);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
};

const publicV4 = ([a, b, c]: number[]): boolean => {
  if (a === undefined || b === undefined || c === undefined) return false;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // shared address space
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  return a < 224; // multicast and reserved, broadcast included
};

/** The eight 16-bit groups of an IPv6 address, or null when it does not parse. */
const v6Groups = (ip: string): number[] | null => {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (lastColon < 0) return null;
  const lastPart = text.slice(lastColon + 1);
  if (lastPart.includes(".")) {
    // A trailing dotted IPv4 address fills the last two groups.
    const octets = v4Octets(lastPart);
    if (!octets) return null;
    tail.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
    text = text.slice(0, lastColon + 1);
    if (!text.endsWith("::")) text = text.slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
    return groups.some(Number.isNaN) ? null : groups;
  };
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !rest) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 1) {
    return known === 8 ? [...head, ...tail] : null;
  }
  if (known > 7) return null;
  return [...head, ...Array<number>(8 - known).fill(0), ...rest, ...tail];
};

const v4From = (high: number, low: number): number[] => [
  high >> 8,
  high & 0xff,
  low >> 8,
  low & 0xff,
];

const publicV6 = (g: number[]): boolean => {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  // ::/96 — unspecified, loopback and the old IPv4-compatible form.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return false;
  // ::ffff:0:0/96 — an IPv4 address in IPv6 form: judged as that address.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return publicV4(v4From(g6, g7));
  }
  // 64:ff9b::/96 — NAT64: judged as the IPv4 address it carries.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return publicV4(v4From(g6, g7));
  }
  // 2002::/16 — 6to4: judged as the IPv4 address it carries.
  if (g0 === 0x2002) return publicV4(v4From(g1, g2));
  // 2001::/32 — Teredo, whose IPv4 address is hidden.
  if (g0 === 0x2001 && g1 === 0) return false;
  // 100::/64 — discard-only.
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return false;
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique local
  if ((g0 & 0xffc0) === 0xfe80) return false; // link-local
  if ((g0 & 0xff00) === 0xff00) return false; // multicast
  return true;
};

/** Whether `ip` (IPv4 or IPv6, as a resolver writes it) is a public address. */
export function isPublicAddress(ip: string): boolean {
  const v4 = v4Octets(ip);
  if (v4) return publicV4(v4);
  if (!ip.includes(":")) return false;
  const groups = v6Groups(ip);
  return groups !== null && publicV6(groups);
}

/** The time limit of one request: its own, or the caller's whole budget, whichever ends first. */
const deadline = (signal: AbortSignal): AbortSignal =>
  AbortSignal.any([signal, AbortSignal.timeout(ISSUER_REQUEST_TIMEOUT_MS)]);

const isJsonMediaType = (contentType: string | null, accepted: readonly string[]): boolean => {
  const media = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  return accepted.includes(media) || media.endsWith("+json");
};

/** The body of `res`, refused past the cap whatever `Content-Length` says. */
async function cappedText(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > ISSUER_RESPONSE_MAX_BYTES) {
    await res.body?.cancel();
    throw new IssuerLookupError("issuer", "response too large");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream is read in order
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > ISSUER_RESPONSE_MAX_BYTES) break;
    chunks.push(value);
  }
  if (size > ISSUER_RESPONSE_MAX_BYTES) {
    await reader.cancel();
    throw new IssuerLookupError("issuer", "response too large");
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** One TXT record's text: its quoted strings unquoted and joined, or the text as given. */
export function txtText(data: string): string {
  if (!data.startsWith('"')) return data;
  let out = "";
  const re = /"((?:[^"\\]|\\.)*)"/g;
  for (let m = re.exec(data); m; m = re.exec(data)) {
    out += m[1]!.replace(/\\(.)/g, "$1");
  }
  return out;
}

export function createIssuerNetwork(
  send: IssuerFetch = (url, init) => fetch(url, init),
): IssuerNetwork {
  /** One request through the seam; a network failure or timeout is `unavailable`. */
  const request = async (url: string, accept: string, signal: AbortSignal): Promise<Response> => {
    try {
      return await send(url, {
        method: "GET",
        headers: { accept },
        redirect: "manual",
        signal: deadline(signal),
      });
    } catch {
      throw new IssuerLookupError("unavailable", "request failed");
    }
  };

  /** The `data` of every answer of `type` at `name`; [] when there are none. */
  const doh = async (name: string, type: number, signal: AbortSignal): Promise<string[]> => {
    const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`;
    const res = await request(url, "application/dns-json", signal);
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new IssuerLookupError("unavailable", "resolver refused");
    }
    let body: JsonValue;
    try {
      body = parseJson(await cappedText(res));
    } catch (e) {
      if (e instanceof IssuerLookupError) throw e;
      throw new IssuerLookupError("unavailable", "resolver answer unreadable");
    }
    // NXDOMAIN and friends: nothing at that name.
    if (!isJsonObject(body) || body.Status !== 0 || !Array.isArray(body.Answer)) return [];
    const answers: readonly JsonValue[] = body.Answer;
    return answers
      .filter(isJsonObject)
      .filter((a) => a.type === type)
      .map((a) => a.data)
      .filter((data): data is string => typeof data === "string");
  };

  const assertPublicHost = async (host: string, signal: AbortSignal): Promise<void> => {
    const [v4, v6] = await Promise.all([doh(host, TYPE_A, signal), doh(host, TYPE_AAAA, signal)]);
    const addresses = [...v4, ...v6].map((a) => a.trim());
    if (addresses.length === 0) throw new IssuerLookupError("issuer", "host has no address");
    if (!addresses.every(isPublicAddress)) {
      throw new IssuerLookupError("issuer", "host resolves to a non-public address");
    }
  };

  return {
    async txt(name, signal) {
      const answers = await doh(name, TYPE_TXT, signal);
      return answers.map(txtText);
    },

    async json(raw, signal) {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new IssuerLookupError("issuer", "not a URL");
      }
      if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) {
        throw new IssuerLookupError("issuer", "not a plain https URL");
      }
      if (!isLookupHost(url.hostname)) throw new IssuerLookupError("issuer", "not a host name");
      await assertPublicHost(url.hostname, signal);
      const res = await request(url.href, "application/json", signal);
      if (res.status !== 200) {
        await res.body?.cancel();
        throw new IssuerLookupError("issuer", `answered ${res.status}`);
      }
      if (!isJsonMediaType(res.headers.get("content-type"), ["application/json"])) {
        await res.body?.cancel();
        throw new IssuerLookupError("issuer", "not JSON");
      }
      const text = await cappedText(res);
      let body: JsonValue;
      try {
        body = parseJson(text);
      } catch {
        throw new IssuerLookupError("issuer", "body is not JSON");
      }
      if (!isJsonObject(body)) throw new IssuerLookupError("issuer", "body is not a JSON object");
      return body;
    },
  };
}

/**
 * A seam for the local E2E stack: every request, the resolver's included,
 * goes to `<emulator>/<host><path><query>` on a loopback stand-in instead.
 * The rules above still run on the URL as the verifier wrote it.
 */
export function emulatedIssuerFetch(emulatorOrigin: string): IssuerFetch {
  const base = emulatorOrigin.replace(/\/$/, "");
  return (raw, init) => {
    const url = new URL(raw);
    return fetch(`${base}/${url.hostname}${url.pathname}${url.search}`, init);
  };
}
