/**
 * What a flow's run leaves in `results.json`, and the rules that keep it the
 * same byte for byte from one run to the next.
 *
 * Nothing time-shaped goes in: no timestamps, no durations, no retry counts.
 * Server-generated ids are replaced by `:id`, query strings (OIDC `state`,
 * `nonce`, PKCE challenges) are dropped, and requests are kept as a sorted set,
 * because the order and the number of parallel fetches a page makes depend on
 * timing while the set of calls it makes does not.
 */

/** Anything `results.json` can hold. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type Assertion = {
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
  readonly pass: boolean;
};

export type FlowRecord = {
  readonly flow: string;
  readonly status: string;
  readonly steps: readonly string[];
  readonly requests: readonly string[];
  readonly assertions: readonly Assertion[];
};

/**
 * An API reached under a path prefix on a web origin, recorded as if it were
 * called directly: under its own label, at the path the API serves. Paths
 * that start with an entry of `keep` reach the API as they are; every other
 * path under the prefix loses the prefix. Nothing else on the web origin is
 * recorded.
 */
export type ApiMount = {
  readonly label: string;
  readonly prefix: string;
  readonly keep: readonly string[];
};

export type Results = {
  readonly suite: "e2e";
  readonly clock: string;
  readonly flows: readonly FlowRecord[];
};

const GENERATED_ID_PATTERNS = [
  // uuid
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  // prefixed id: evt_1a2b3c4d5e6f, rsvp_…, usr_…
  /^[a-z]{2,8}_[A-Za-z0-9-]{8,}$/,
  // bare hex or base64url token
  /^[A-Za-z0-9_-]{20,}$/,
];

const isGeneratedId = (segment: string): boolean =>
  GENERATED_ID_PATTERNS.some((pattern) => pattern.test(segment)) && /\d/.test(segment);

/** `/events/evt_1a2b3c4d5e6f/rsvps?x=1` → `/events/:id/rsvps`. */
export function normalisePath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => (isGeneratedId(segment) ? ":id" : segment))
    .join("/");
}

/** The API's own path for a path on the web origin, or null when it is not under the mount. */
function mountedPath(mount: ApiMount, pathname: string): string | null {
  if (!pathname.startsWith(`${mount.prefix}/`)) return null;
  if (mount.keep.some((kept) => pathname.startsWith(kept))) return pathname;
  const path = pathname.slice(mount.prefix.length);
  return path === "/" ? null : path;
}

/**
 * One request as the record keeps it, or null when it is not an API call the
 * suite watches (a page, a Vite module, a font). A call through an API
 * mounted on a web origin (`apiMounts`) records the same line as a direct
 * call to that API.
 */
export function requestLine(
  method: string,
  url: string,
  status: number,
  apiLabels: Readonly<Record<string, string>>,
  apiMounts: Readonly<Record<string, ApiMount>> = {},
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const mount = Object.hasOwn(apiMounts, parsed.origin) ? apiMounts[parsed.origin] : undefined;
  if (mount) {
    const path = mountedPath(mount, parsed.pathname);
    return path === null ? null : `${method} ${mount.label} ${normalisePath(path)} ${status}`;
  }
  const label = apiLabels[parsed.origin];
  if (!label) return null;
  return `${method} ${label} ${normalisePath(parsed.pathname)} ${status}`;
}

/** The set of request lines, sorted. */
export function requestSet(lines: Iterable<string>): string[] {
  return [...new Set(lines)].toSorted();
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => byCodeUnit(a, b))
        .map(([key, inner]) => [key, sortKeys(inner)]),
    );
  }
  return value;
}

/** JSON with object keys sorted at every depth, two-space indent, trailing newline. */
export function stableJson(value: JsonValue): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

export function buildResults(clock: string, flows: readonly FlowRecord[]): Results {
  const sorted = flows.toSorted((a, b) => byCodeUnit(a.flow, b.flow));
  return { suite: "e2e", clock, flows: sorted };
}
