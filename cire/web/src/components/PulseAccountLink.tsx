import { createLoginClient, createRecoveryClient, createRegistrationClient } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { Register, SignIn } from "@osn/ui/auth";
import { createResource, createSignal, For, Show } from "solid-js";

import type { FamilyMember } from "./types";

/**
 * Guest-facing "Link my Pulse account" affordance, shown after a guest claims
 * their invite. Purely ADDITIVE: the core invite never depends on this — every
 * failure path (linking disabled, OSN unreachable, token expired) degrades to a
 * hidden/quiet control rather than breaking the claimed invite.
 *
 * Flow:
 *   1. Probe `GET /api/account/link` for the current linked state of the
 *      household. A 503 (deployment has no ARC key ⇒ linking disabled) hides the
 *      whole feature. The guest session cookie alone authorises this read.
 *   2. The guest signs in to OSN (passkey ceremony via `@osn/ui`'s SignIn /
 *      Register, which adopt the session through `useAuth()`), so we hold an OSN
 *      access token.
 *   3. The guest picks WHICH household member they are, then we
 *      `POST /api/account/link` with `{ guestId }` + `Authorization: Bearer` (via
 *      `authFetch`, which silent-refreshes on 401) + the `cire_session` cookie.
 *   4. Per-member linked/unlinked indicators reflect the GET; an unlink control
 *      issues `DELETE /api/account/link/:guestId`.
 *
 * Must render inside an `<AuthProvider>` (mounted by the parent island) so
 * `useAuth()` resolves.
 */

interface PulseAccountLinkProps {
  /** cire-api origin (same value the rest of the invite islands fetch from). */
  apiUrl: string;
  /** The household members from the claim response — the seats to pick from. */
  members: FamilyMember[];
  /** OSN issuer origin, threaded for the sign-in clients. */
  issuerUrl: string;
  /** Public Turnstile sitekey (build-time); gates the OSN sign-in / register. */
  turnstileSiteKey?: string;
}

/** Shape of the `GET /api/account/link` response (per-member linked state). */
interface LinkStatusResponse {
  links: { guestId: string; linkedAt: number }[];
}

/**
 * Probe result: `disabled` when the API answers 503 (linking unavailable on this
 * deployment), `ready` with the set of already-linked guest ids otherwise, and
 * `error` only for an unexpected failure (the feature stays hidden either way,
 * but the two are distinguished for the indicator state).
 */
type ProbeState = { kind: "disabled" } | { kind: "ready"; linked: Set<string> } | { kind: "error" };

export function PulseAccountLink(props: PulseAccountLinkProps) {
  const { session, authFetch } = useAuth();

  const loginClient = createLoginClient({ issuerUrl: props.issuerUrl });
  const recoveryClient = createRecoveryClient({ issuerUrl: props.issuerUrl });
  const registrationClient = createRegistrationClient({ issuerUrl: props.issuerUrl });

  // Whether the OSN sign-in ceremony is expanded. The affordance opens it.
  const [signingIn, setSigningIn] = createSignal(false);
  const [mode, setMode] = createSignal<"signin" | "register">("signin");

  // The member the guest selected to link (their seat). Null until chosen.
  const [selected, setSelected] = createSignal<string | null>(null);
  const [linking, setLinking] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Linked guest ids, seeded from the probe and mutated optimistically on
  // link/unlink so the indicators update without a refetch.
  const [linked, setLinked] = createSignal<Set<string>>(new Set());

  // Probe the household's current link state. The guest session cookie alone
  // authorises this — no OSN token needed — so we can decide up front whether to
  // show the feature at all. A 503 ⇒ linking disabled ⇒ hide everything.
  const [probe] = createResource<ProbeState>(async () => {
    try {
      const res = await fetch(`${props.apiUrl}/api/account/link`, {
        credentials: "include",
        cache: "no-store",
      });
      if (res.status === 503) return { kind: "disabled" };
      if (!res.ok) return { kind: "error" };
      const body = (await res.json()) as LinkStatusResponse;
      const ids = new Set((body.links ?? []).map((l) => l.guestId));
      setLinked(ids);
      return { kind: "ready", linked: ids };
    } catch {
      return { kind: "error" };
    }
  });

  const isLinked = (guestId: string) => linked().has(guestId);

  /** Add/remove a guest id from the linked set immutably (so signals react). */
  function setLinkedFor(guestId: string, value: boolean) {
    setLinked((prev) => {
      const next = new Set(prev);
      if (value) next.add(guestId);
      else next.delete(guestId);
      return next;
    });
  }

  async function linkMember(guestId: string) {
    setError(null);
    setLinking(true);
    try {
      // authFetch attaches the OSN bearer + silent-refreshes on 401; the
      // cire_session cookie rides via credentials:"include".
      const res = await authFetch(`${props.apiUrl}/api/account/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ guestId }),
      });
      if (res.status === 201 || res.status === 409) {
        // 409 already-linked is success-shaped here: the seat IS linked, so
        // reflect it rather than surfacing an error.
        setLinkedFor(guestId, true);
        setSelected(null);
        return;
      }
      if (res.status === 503) {
        setError("Account linking isn't available right now.");
        return;
      }
      if (res.status === 403) {
        setError("That isn't one of your household's guests.");
        return;
      }
      setError("Couldn't link your account. Please try again.");
    } catch {
      // authFetch throws AuthExpiredError when silent refresh fails — the OSN
      // session lapsed. Drop back to the sign-in step so the guest re-auths.
      setSigningIn(true);
      setError("Your sign-in expired. Please sign in again.");
    } finally {
      setLinking(false);
    }
  }

  async function unlinkMember(guestId: string) {
    setError(null);
    // Optimistic: flip the indicator immediately; the DELETE is idempotent.
    setLinkedFor(guestId, false);
    try {
      const res = await fetch(`${props.apiUrl}/api/account/link/${encodeURIComponent(guestId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok && res.status !== 404) {
        // Revert on a real failure (404 is fine — already gone).
        setLinkedFor(guestId, true);
        setError("Couldn't unlink. Please try again.");
      }
    } catch {
      setLinkedFor(guestId, true);
      setError("Couldn't unlink. Please try again.");
    }
  }

  return (
    // 503 / probe error ⇒ render nothing: the feature is invisible and the core
    // invite is untouched.
    <Show when={probe()?.kind === "ready"}>
      <section
        class="border-gold/30 bg-gold/5 mx-auto mt-10 max-w-[420px] rounded-sm border px-5 py-6 text-left"
        aria-labelledby="pulse-link-heading"
      >
        <h3
          id="pulse-link-heading"
          class="font-display text-gold mb-1 text-[1.3rem] leading-tight font-light italic"
        >
          Link your Pulse account
        </h3>
        <p class="text-text-muted mb-4 text-[0.84rem] leading-[1.55] font-light">
          Connect your OSN account so this invitation appears in Pulse. Optional — your invite works
          either way.
        </p>

        <Show
          when={session()}
          fallback={
            <Show
              when={signingIn()}
              fallback={
                <button
                  type="button"
                  onClick={() => setSigningIn(true)}
                  class="border-gold font-body text-gold hover:bg-gold hover:text-bg rounded-sm border bg-transparent px-5 py-2.5 text-[0.82rem] tracking-[0.1em] uppercase transition-colors duration-200"
                >
                  Sign in with OSN
                </button>
              }
            >
              {/* OSN passkey ceremony — adopts the session via useAuth(); on
                  success `session()` becomes truthy and the picker below shows. */}
              <Show
                when={mode() === "register"}
                fallback={
                  <div class="flex flex-col gap-3">
                    <SignIn
                      client={loginClient}
                      recoveryClient={recoveryClient}
                      turnstileSiteKey={props.turnstileSiteKey}
                    />
                    <p class="text-text-muted text-center text-[0.8rem]">
                      New to OSN?{" "}
                      <button
                        type="button"
                        class="text-gold font-medium hover:underline"
                        onClick={() => setMode("register")}
                      >
                        Create an account
                      </button>
                    </p>
                  </div>
                }
              >
                <Register
                  client={registrationClient}
                  onCancel={() => setMode("signin")}
                  turnstileSiteKey={props.turnstileSiteKey}
                />
              </Show>
            </Show>
          }
        >
          {/* Signed in to OSN — pick which household member you are, then link. */}
          <p class="text-text mb-3 text-[0.82rem] font-light">Which guest are you?</p>
          <ul class="flex flex-col gap-2" aria-label="Household members">
            <For each={props.members}>
              {(member) => (
                <li class="border-border/60 flex items-center justify-between gap-3 rounded-sm border px-3 py-2">
                  <span class="flex items-center gap-2">
                    <input
                      type="radio"
                      name="pulse-link-member"
                      class="accent-gold"
                      checked={selected() === member.guestId}
                      disabled={isLinked(member.guestId) || linking()}
                      onChange={() => setSelected(member.guestId)}
                      id={`pulse-link-${member.guestId}`}
                    />
                    <label
                      for={`pulse-link-${member.guestId}`}
                      class="text-text text-[0.86rem] font-light"
                    >
                      {member.firstName} {member.lastName}
                    </label>
                  </span>
                  <Show
                    when={isLinked(member.guestId)}
                    fallback={
                      <span class="text-text-muted font-body text-[0.66rem] tracking-[0.12em] uppercase">
                        Not linked
                      </span>
                    }
                  >
                    <span class="flex items-center gap-2">
                      <output class="text-gold font-body text-[0.66rem] tracking-[0.12em] uppercase">
                        ✓ Linked
                      </output>
                      <button
                        type="button"
                        onClick={() => void unlinkMember(member.guestId)}
                        class="text-text-muted hover:text-error text-[0.72rem] underline-offset-2 hover:underline"
                      >
                        Unlink
                      </button>
                    </span>
                  </Show>
                </li>
              )}
            </For>
          </ul>

          <Show when={error()}>
            <p class="text-error mt-3 text-[0.8rem]" role="alert">
              {error()}
            </p>
          </Show>

          <button
            type="button"
            onClick={() => {
              const id = selected();
              if (id) void linkMember(id);
            }}
            disabled={!selected() || linking()}
            class="border-gold font-body text-gold hover:bg-gold hover:text-bg mt-4 rounded-sm border bg-transparent px-5 py-2.5 text-[0.82rem] tracking-[0.1em] uppercase transition-colors duration-200 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {linking() ? "Linking…" : "Link my account"}
          </button>
        </Show>
      </section>
    </Show>
  );
}
