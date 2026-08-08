import { onMount, type Accessor } from "solid-js";

import type { ClaimResult } from "./types";
import { isValidClaimResponse } from "./utils";

/**
 * A NON-credential, site-scoped marker that this browser has claimed at some
 * point — the "gating hint" that keeps the restore off first-time visitors.
 *
 * It exists because the real credential is invisible here: `cire_session` is
 * HttpOnly and host-scoped to the API origin, so the guest site cannot tell a
 * returning household from a stranger and would otherwise fire a guaranteed-401
 * request on every single invite page load. Workers Free is 100k requests/day
 * ACCOUNT-WIDE across cire-api and osn-api, and that budget is the binding
 * constraint on this stack (see [[wiki/runbooks/free-tier-limits]]) — so the
 * wasted call is the one line item that scales with page views rather than with
 * guests.
 *
 * It carries no authority whatsoever. Forging it buys an attacker exactly the
 * 401 they would have received anyway; the server still decides everything.
 */
const CLAIMED_HINT = "cire_claimed";
/** Matches the session TTL in `cire/api/src/routes/claim.ts` (30 days). */
const CLAIMED_HINT_MAX_AGE = 30 * 24 * 60 * 60;

function hasClaimedHint(): boolean {
  return document.cookie.split(";").some((c) => c.trim().startsWith(`${CLAIMED_HINT}=`));
}

/**
 * Record that this browser now holds a household session, so the next visit
 * restores instead of asking for the code. Call from the claim success path.
 *
 * The hint and the session it stands for are both minted by the same successful
 * claim and both last 30 days, so they lapse together — and the one place it
 * would be tempting to clear early (a 401) is ambiguous between "session is
 * dead" and "right guest, wrong wedding", where clearing would make a guest who
 * once opened someone else's invite link retype their code on their own invite.
 * The ONLY thing that clears it early is an explicit sign-out ({@link signOut}),
 * which is the unambiguous case that rationale excludes.
 */
export function noteClaimed(): void {
  if (typeof document === "undefined") return;
  // `Secure` only over HTTPS — setting it on `http://localhost:4321` would make
  // the browser drop the cookie, silently disabling the restore in local dev.
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${CLAIMED_HINT}=1; Path=/; Max-Age=${CLAIMED_HINT_MAX_AGE}; SameSite=Lax${secure}`;
}

/**
 * End the household session: revoke it server-side and drop the local hint so
 * the next visit shows the code form instead of restoring.
 *
 * This is the counterpart the module header's "deliberately no clear()" note
 * carves out. That rationale is about the AMBIGUOUS 401 — where clearing would
 * punish a guest who merely opened someone else's link — and an explicit,
 * user-initiated sign-out is the unambiguous case it excludes.
 *
 * Resolves `true` when the server confirmed the revoke, `false` otherwise. The
 * local hint is cleared either way and the caller must reset its UI either way:
 * a guest on a borrowed phone who taps "Sign out" and hits a flaky network must
 * not be left looking at the household's invite. The real cookie is HttpOnly
 * and host-scoped to the API origin, so only the server can clear it — which is
 * exactly why the boolean is worth surfacing rather than swallowing.
 */
export async function signOut(apiUrl: string): Promise<boolean> {
  clearClaimedHint();
  try {
    const res = await fetch(`${apiUrl}/api/claim/signout`, {
      method: "POST",
      // The whole point: send the household cookie cross-origin so the server
      // can revoke THIS session. Same-site, so `SameSite=Lax` permits it.
      credentials: "include",
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Drop the local "this browser has claimed" marker. Only ever called from an
 * explicit sign-out — see {@link signOut} and the module header for why a 401
 * deliberately does not.
 */
function clearClaimedHint(): void {
  if (typeof document === "undefined") return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${CLAIMED_HINT}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

export interface SessionRestoreOptions {
  apiUrl: string;
  /**
   * The wedding this page is rendering. REQUIRED for a restore to happen: the
   * guest site serves every wedding from one origin, while `cire_session` names
   * one family and therefore one wedding, so an unscoped restore could paint
   * another wedding's events into this one's shell. Absent ⇒ no restore.
   */
  slug?: string;
  /** Current claim result — non-null means the invite is already open. */
  result: Accessor<ClaimResult | null>;
  /** Called with the restored payload. Not called if the restore finds nothing. */
  onRestored: (result: ClaimResult) => void;
}

/**
 * Headless "am I already claimed?" primitive — the `GET /api/claim/session`
 * read, factored out like `createClaimCode` so every design pack reuses the
 * identical behaviour.
 *
 * A `cire_session` lasts 30 days, but before this the guest site had no way to
 * ask about one: `POST /api/claim` was the only door in, so a household that
 * had already opened its invite had to retype its code on every visit, and the
 * events list arrived only after they did. This turns the second visit into a
 * single GET that resolves while the hero is still painting.
 *
 * It cannot widen the S-H1 gate: the server keys the read on the family id it
 * derived from the cookie, so this asks "what is MY invite", never "whose
 * invite is this". A guest with no session gets a 401 and the code form, which
 * is exactly today's behaviour.
 *
 * NOTE this can only ever be a client-side fetch, not an SSR one: `cire_session`
 * is host-scoped to `api.cireweddings.com` (deliberately — see the audit note in
 * `cire/api/src/lib/cookie.ts`), so the guest-site Worker never receives it and
 * cannot forward it while rendering.
 */
export function createSessionRestore(options: SessionRestoreOptions): void {
  onMount(() => {
    // The organiser's `?code=` preview deep-link auto-claims in `createClaimCode`
    // on this same mount. Restoring first would paint a stale guest session for
    // a beat before the host claim replaced it, so the explicit code wins and
    // this stays out of the way entirely.
    if (typeof window !== "undefined" && new URL(window.location.href).searchParams.has("code")) {
      return;
    }
    if (options.result()) return;
    // No hint ⇒ this browser has never claimed here, so a restore could only
    // ever 401. Skip the request entirely rather than spend an account-wide
    // Workers invocation to be told what we already know.
    if (!hasClaimedHint()) return;
    // No slug ⇒ nothing to scope the restore to (unit-test callers, and any
    // future page that renders the island without a wedding). The server
    // requires it too and 400s without it; skipping here saves the round trip.
    const slug = options.slug;
    if (!slug) return;

    void (async () => {
      try {
        const url = `${options.apiUrl}/api/claim/session?slug=${encodeURIComponent(slug)}`;
        const res = await fetch(url, {
          // The whole point: send the household cookie cross-origin. Same-site
          // (both under `cireweddings.com`), so `SameSite=Lax` permits it.
          credentials: "include",
          // Never a cached invite — RSVPs and organiser edits both move it.
          cache: "no-store",
        });
        // 401 covers two cases the client cannot tell apart, deliberately: the
        // session is dead (expired / invite withdrawn — the server clears the
        // real cookie), or it is alive but belongs to a DIFFERENT wedding than
        // this page. So the hint is NOT cleared here: dropping it on the second
        // case would make a guest who once opened someone else's invite link
        // retype their code on their own invite forever. A dead session costs
        // one wasted request per visit until the 30-day hint lapses, which is
        // much the cheaper of the two errors. Any other non-OK (500, or a 429
        // from this route's limiter) degrades to the code form the same way.
        if (!res.ok) return;

        const data: unknown = await res.json();
        if (!isValidClaimResponse(data)) return;
        // The guest may have typed their code while this was in flight — their
        // claim is fresher and already animated in, so never clobber it.
        if (options.result()) return;

        options.onRestored(data);
      } catch {
        // Offline, or the API is unreachable. The code form stays exactly as it
        // is today; a failed restore must never block entry by hand.
      }
    })();
  });
}
