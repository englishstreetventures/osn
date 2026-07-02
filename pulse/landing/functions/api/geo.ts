// Cloudflare Pages Function — GET /api/geo
//
// Returns the visitor's COARSE, IP-derived location (city / region / country)
// from Cloudflare's edge geo (`request.cf`), so the hero can say "what's on near
// you" without us knowing anything about the user. No account data, no cookies,
// no personal info — just the same approximate location every CDN already sees.
//
// Served from the site's own origin, so the static site's tight CSP
// (`connect-src 'self'`) still holds. Bundled automatically by
// `wrangler pages deploy` from this `functions/` directory; if it is ever
// missing the hero falls back to a generic "near you" CTA (see PulseHero).

interface EdgeGeo {
  city?: string;
  region?: string;
  regionCode?: string;
  country?: string;
}

// Stable, deterministic placeholder count so the figure doesn't flicker between
// requests. PLACEHOLDER until the Pulse events API is wired — derived purely
// from the place name (FNV-1a hash), giving a plausible 20–179 per place.
function illustrativeCount(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 20 + (Math.abs(h) % 160);
}

export const onRequestGet = (context: { request: Request & { cf?: EdgeGeo } }): Response => {
  const cf = context.request.cf ?? {};
  const city = cf.city ?? null;
  const region = cf.region ?? null;
  const country = cf.country ?? null;

  // The place we headline the count with: prefer the state/region, then city.
  const place = region ?? city ?? country ?? null;

  const body = {
    city,
    region,
    regionCode: cf.regionCode ?? null,
    country,
    // Illustrative only (see note above); null when we can't resolve a place.
    count: place ? illustrativeCount(place) : null,
  };

  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Per-visitor (varies by caller IP), so browser-only — never a shared/proxy
      // cache, which could otherwise serve one visitor's coarse location to
      // another. `private` keeps the short client-side freshness we want.
      "cache-control": "private, max-age=300",
    },
  });
};
