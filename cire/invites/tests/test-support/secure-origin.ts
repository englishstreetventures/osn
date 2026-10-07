/**
 * Run `body` as though the page were served over https, with a cookie jar the
 * test controls.
 *
 * The consent cookie module reads `location.protocol` to choose between the
 * `__Host-` name (https) and the bare name (http), and jsdom serves every
 * suite over http — so the https half of the module is unreachable without
 * this. jsdom on http also refuses a `Secure` cookie outright, hence the jar:
 * it keeps whatever is assigned, and deletes on `Max-Age=0` as a browser does.
 *
 * Read by `tests/lib/consent/cookie.test.ts`, `tests/lib/consent/store.test.ts`
 * and `tests/components/consent/ConsentBanner.test.tsx`.
 */
export function onSecureOriginWithJar(initial: string, body: (jar: () => string) => void): void {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalCookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
  const jar = new Map<string, string>();
  for (const part of initial.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    jar.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    get: () => ({ protocol: "https:" }),
  });
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; "),
    set: (assignment: string) => {
      const [pair, ...attributes] = assignment.split(";");
      const separator = pair!.indexOf("=");
      const name = pair!.slice(0, separator).trim();
      const value = pair!.slice(separator + 1).trim();
      if (attributes.some((a) => a.trim().toLowerCase() === "max-age=0")) jar.delete(name);
      else jar.set(name, value);
    },
  });
  try {
    body(() => document.cookie);
  } finally {
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
    if (originalCookie) Object.defineProperty(document, "cookie", originalCookie);
  }
}
