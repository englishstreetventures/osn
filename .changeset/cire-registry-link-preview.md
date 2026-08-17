---
"@cire/api": patch
"@cire/host": patch
---

Registry item pictures — link preview, an R2 copy at pick time, and the organiser field that drives both (PR 3 of 5).

An organiser building a gift list pastes a shop URL and wants the item's title
and picture without saving both by hand. `POST
/api/organiser/weddings/:weddingId/registry/link-preview` takes `{ url }` and
answers `{ title, siteName, images }` — up to six candidate image URLs, ranked
`og:image`/`twitter:image` first, then `<link rel="image_src">`, then `<img>` in
document order with anything declaring itself under 100px dropped.

**This is the first route in the API that fetches a URL a caller typed**, and
that makes it a server-side request forgery sink. Every other outbound call we
make goes to a host we chose, so the existing precedent — `pinterest-resolve.ts`
— defends itself with a host allowlist, which is exactly the tool that does not
exist when the destination is any shop on the internet. `services/link-preview.ts`
takes a different shape: `https:` only; a DNS-over-HTTPS pre-resolution whose
every A and AAAA answer is range-checked against loopback, RFC 1918, CGNAT,
link-local (the cloud metadata address in particular), `0.0.0.0/8` and multicast,
with IPv4-mapped and NAT64 addresses **unwrapped and re-checked** so the v4 rules
cannot be sidestepped by spelling them in v6; `redirect: "manual"` with the whole
scheme-and-address check re-run on every hop's `Location`, because a benign first
host that 302s to `http://169.254.169.254/` is the interesting attack and the
platform's own redirect follower would go there happily; and one `AbortSignal`
budget across all hops, a 512 KB cap read off the stream rather than trusted from
`Content-Length`, and a `text/html` content-type requirement.

The one gap is stated rather than hidden: **DoH pre-resolution is
time-of-check/time-of-use imperfect.** We vet the name's answers and then hand
the name to `fetch`, which resolves it again, so an attacker who controls the
zone can answer differently the second time. Closing that needs a connect-time
hook and workerd exposes none. It is recorded as S-M1 in the security backlog and
in the module's own doc comment, with what would change the answer.

Blocked URLs come back as a 400 with a stable `blocked_url` code and **no
reason** — telling a caller which rule fired turns the endpoint into a network
scanner with a clean oracle. The reason goes to the log instead. Ports are an
allowlist of one, default or `443`: every shop link an organiser pastes is on
443, and without the rule the address checks pass any *public* host on any port,
which hands back the port scanner the opaque error code was meant to deny. The
route sits behind the same gates as the registry writes (`osnAuth` →
`weddingEditor` → the `registry` entitlement) with its own limiter appended at 10
requests a minute, since one authenticated call costs a full page fetch to a host
the caller named. That limiter and the image one run on **native Workers
rate-limit bindings** (`REGISTRY_PREVIEW_RATE_LIMITER`,
`REGISTRY_IMAGE_RATE_LIMITER`, separate namespaces so previewing several pages
per picture kept doesn't 429 the honest path) rather than the in-memory default,
which counts per isolate and so is not a bound a busy caller can't widen.

The HTML scan is the other half of the untrusted input, and it is regex over
bytes a stranger wrote. Every tag-scanning pattern excludes `<` **and** `>`
rather than the usual `[^>]*`: with `>` alone, an unterminated `<meta` lets the
engine backtrack across the whole document per candidate start, and a page built
to do that spent 21–25 seconds of CPU against a 10 ms budget — one request, one
dead isolate. Excluding both makes each match linear and self-terminating.
Candidate collection stops at 32 raw matches before ranking, entity decoding
happens once per emitted candidate instead of per match, and the hosts behind the
candidates are DoH-resolved in parallel (deduped, capped at 8) rather than one
after another.

**The picked URL is never stored.** Preview hands back candidates; the moment an
organiser chooses one, `POST /registry/image/from-url` downloads it and writes
our own copy to R2, and the item holds an R2 key. Hotlinking would have meant a
picture that rots when the retailer re-slugs its CDN, a guest's IP and our
referrer disclosed to a shop on every page load, and — worst — bytes the shop can
swap after the organiser approved them. The URL in that request body is treated
as fully untrusted even though we emitted it, because the body is
client-controlled: the same guard runs again on it, hop by hop. The bytes must
then pass a `Content-Length` pre-check, the real read length, and a magic-byte
sniff (`detectImageType`) — a `Content-Type: image/png` over an HTML page is the
ordinary case here, so the header decides nothing. `POST /registry/image` takes a
direct upload through the same checks and the same `assets/<weddingId>/…` key
space as invite hero images, and `GET /registry/image/:name` serves our copy
through the Images transform binding with the key rebuilt server-side and the
response marked `private`.

Registry names must start `registry-`, and that prefix is now a matter of
correctness rather than tidiness: the key space is shared with invite hero
images, so without it an item could be pointed at the hero image's key and
deleting the item would take the hero image with it. The pattern lives once, in
`services/invite-assets.ts`, and both the request schema and the ownership check
read it from there. Deleting an item reaps its object through `waitUntil` — but
only after a wedding-scoped count proves no other item still holds that key,
since two items may legitimately share one picture. The R2 reconciler counts
registry keys as live references, so an abandoned add form leaves nothing behind
past the grace window. This closes S-L2 in the security backlog, which asked for
exactly this.

On the portal, `RegistryImageField` gives an item its picture either way: upload
a file, or paste a shop link and **choose** among what that page offers. The
candidates are a real radio group — roving tabindex, arrows, Home/End, and an
accessible name built from the page's own title rather than "image 1" — because
silently taking the first candidate picks the wrong picture on most shop pages.
Candidates are re-filtered to `https:` in the browser before any of them becomes
an `<img src>`; a page with no usable picture is a note offering the upload path,
not an error. The thumbnail is fetched with the organiser's token into an object
URL, since unlike the invite image route this one is gated.

Both limiters are declared on the **dev** environment too (namespace ids 1103 /
1104, the 11xx dev range). Named environments inherit no bindings, so leaving
them out would have silently dropped dev back to the per-isolate in-memory
counter on the one tier where these routes actually run — the registry is comped
to the dev sample wedding and locked everywhere else.
