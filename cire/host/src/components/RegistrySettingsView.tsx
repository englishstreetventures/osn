import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { batch, createMemo, createSignal, onMount, Show } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { haptic } from "../lib/haptics";
import {
  claimStripeCheck,
  ensureRegistryLoaded,
  invalidateRegistry,
  registryAccessor,
  setCachedRegistry,
  type RegistrySettings,
  type RegistrySnapshot,
} from "../lib/registry-store";
import SectionIntro from "./SectionIntro";
import Button from "./ui/Button";
import Field, { Input, Textarea } from "./ui/Field";
import Notice from "./ui/Notice";

/**
 * THE REGISTRY'S SETTINGS — the four decisions the guest surface has been
 * reading all along with nowhere for a couple to make them: whether the list is
 * published, what it is called, where parcels go, and whether guests may give
 * money instead.
 *
 * ONE SNAPSHOT, SHARED WITH THE LIST. This reads the same cached
 * `RegistrySnapshot` the gift list does, so moving between the sub-tabs costs
 * no fetch, and a save patches the cache rather than invalidating it.
 *
 * TWO ROLES, TWO LINES. Everything here is `weddingEditor` — a co-host helping
 * with the list may write it — EXCEPT connecting the Stripe account, which is
 * `weddingOwner` at the API. Naming the bank account gifts are paid into is not
 * ordinary help. An editor still SEES that panel, disabled, with the reason:
 * a co-host who wonders why money gifts are off deserves an answer rather than
 * a missing section.
 *
 * INTENT AND CAPABILITY ARE DIFFERENT THINGS. "Let guests give money" is the
 * couple's intent (`cash_gifts_enabled`); whether Stripe can take a charge
 * today is `stripe_charges_enabled`, which only Stripe decides. The API refuses
 * to store the first without the second (`stripe_not_ready`), so the switch is
 * disabled until onboarding is genuinely finished — and the panel says which of
 * the two is missing rather than making the couple guess.
 */

interface RegistrySettingsViewProps {
  weddingId: string;
  /** Owner or editor. A read-only viewer never reaches this sub-tab. */
  canEdit?: boolean;
  /** Owner only — the one control that names where money lands. */
  canManage?: boolean;
}

/** What the money panel says about the connected account, in one word. */
type StripeState = "none" | "incomplete" | "ready";

/**
 * Stripe's own hosted onboarding, and nowhere else.
 *
 * The twin of `isStripeCheckoutUrl` on the guest site. The API hands back a URL
 * and this button navigates to it, so the response body decides where a signed-in
 * owner's browser goes next. One parse closes the whole class — a compromised
 * API, a proxy in the middle, a refactor that lets some other value reach the
 * field — where that becomes `javascript:` or a page dressed up as Stripe.
 */
function isStripeConnectUrl(raw: string): boolean {
  try {
    return new URL(raw).origin === "https://connect.stripe.com";
  } catch {
    return false;
  }
}

export default function RegistrySettingsView(props: RegistrySettingsViewProps) {
  const { authFetch } = useAuth();
  const snapshot = registryAccessor(props.weddingId);

  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [connecting, setConnecting] = createSignal(false);
  const [checking, setChecking] = createSignal(false);
  /** `null` until the first snapshot lands; the form seeds from it once. */
  const [seeded, setSeeded] = createSignal(false);

  const [published, setPublished] = createSignal(false);
  const [headline, setHeadline] = createSignal("");
  const [message, setMessage] = createSignal("");
  const [shippingAddress, setShippingAddress] = createSignal("");
  const [shippingVisibleFrom, setShippingVisibleFrom] = createSignal("");
  const [cashGifts, setCashGifts] = createSignal(false);

  const settingsUrl = () =>
    apiUrl(`/api/organiser/weddings/${encodeURIComponent(props.weddingId)}/registry/settings`);
  const stripeUrl = (leaf: "session" | "refresh") =>
    apiUrl(
      `/api/organiser/weddings/${encodeURIComponent(props.weddingId)}/registry/stripe/${leaf}`,
    );

  const settings = (): RegistrySettings | null => snapshot()?.settings ?? null;
  const itemCount = () => snapshot()?.items.length ?? 0;
  /** Publishing an empty list is blocked — see the notice this drives. */
  const canPublish = () => itemCount() > 0;

  const stripeState = createMemo<StripeState>(() => {
    const s = settings();
    if (!s?.stripeAccountId) return "none";
    return s.stripeChargesEnabled ? "ready" : "incomplete";
  });

  /**
   * Seven signals, one update. Both callers reach this past an `await`, which
   * is outside Solid's automatic batching, so without `batch` the seven setters
   * are seven separate renders of the whole form — once on load and again after
   * every save.
   */
  function seed(s: RegistrySettings): void {
    batch(() => {
      setPublished(s.published);
      setHeadline(s.headline ?? "");
      setMessage(s.message ?? "");
      setShippingAddress(s.shippingAddress ?? "");
      setShippingVisibleFrom(s.shippingVisibleFrom ?? "");
      setCashGifts(s.cashGiftsEnabled);
      setSeeded(true);
    });
  }

  /**
   * Write a fresh settings row into the shared snapshot, list untouched.
   *
   * Deliberately does NOT re-seed the form. The Stripe refresh runs while a
   * couple is typing — on mount, and from a button inside the same fieldset —
   * and seeding from it would silently wipe an address they were half way
   * through. `stripeState()` reads the snapshot, so the panel still updates.
   */
  function patchCache(next: RegistrySettings): void {
    const current = snapshot();
    if (!current) return;
    setCachedRegistry(props.weddingId, { ...current, settings: next } as RegistrySnapshot);
  }

  /** A save: the server row is now the truth, so the form takes it too. */
  function patchSettings(next: RegistrySettings): void {
    batch(() => {
      patchCache(next);
      seed(next);
    });
  }

  onMount(() => {
    void (async () => {
      try {
        await ensureRegistryLoaded(props.weddingId, async () => {
          const res = await authFetch(
            apiUrl(`/api/organiser/weddings/${encodeURIComponent(props.weddingId)}/registry`),
          );
          if (res.status === 401) {
            redirectToLogin();
            throw new Error("unauthorised");
          }
          if (!res.ok) throw new Error("load failed");
          return (await res.json()) as RegistrySnapshot;
        });
        const s = settings();
        if (s) seed(s);
        // ONE live Stripe read per page load, and only for a couple
        // mid-onboarding. This is the state where the answer genuinely may
        // have changed since the page was cached — they have just come back
        // from Stripe and the `account.updated` webhook can be seconds behind
        // them. A couple who are already `ready`, or who have no account at
        // all, cost nothing.
        //
        // `claimStripeCheck` is what keeps it to one. This panel is
        // behind a `<Show>`, so every list→settings switch remounts it, and
        // `incomplete` is not a seconds-long state: Stripe can hold an account
        // there for days pending documents. Without the guard, idle tab
        // flipping would spend a Stripe round-trip and a D1 write each time,
        // against the same per-organiser limiter that guards the Connect
        // button the couple actually needs. Coming back from Stripe is a fresh
        // page load, which is exactly when the guard is empty.
        //
        // `canManage` first: the route behind this is owner-only, so for a
        // co-host the call can only ever come back 403. `claimStripeCheck`
        // stays last because it SPENDS the one-shot token — checking it ahead
        // of a gate that refuses would burn the owner's single check of the
        // page load on a request that never happens.
        if (
          props.canManage &&
          s?.stripeAccountId &&
          !s.stripeChargesEnabled &&
          claimStripeCheck(props.weddingId)
        ) {
          void refreshStripe(true);
        }
      } catch (err) {
        if (isAuthExpired(err)) return redirectToLogin();
        setLoadError("Could not load the registry settings. Is the API running?");
      } finally {
        setLoading(false);
      }
    })();
  });

  async function save(event: Event): Promise<void> {
    event.preventDefault();
    if (saving() || !props.canEdit) return;
    setSaving(true);
    try {
      const res = await authFetch(settingsUrl(), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          published: published(),
          // Empty means "I wrote nothing", which is null on the wire, not "" —
          // the guest surface reads null as "use the built-in default", and an
          // empty string would beat it.
          headline: headline().trim() === "" ? null : headline().trim(),
          message: message().trim() === "" ? null : message().trim(),
          shippingAddress: shippingAddress().trim() === "" ? null : shippingAddress().trim(),
          shippingVisibleFrom: shippingVisibleFrom() === "" ? null : shippingVisibleFrom(),
          cashGiftsEnabled: cashGifts(),
        }),
      });
      if (res.status === 401) return redirectToLogin();
      if (res.status === 409) {
        // The API's own `stripe_not_ready`. The switch below is disabled until
        // Stripe can charge, so reaching this means the account's state changed
        // under the page — say the true thing rather than "check the fields".
        haptic("reject");
        setCashGifts(false);
        toast.error("Stripe can’t take a payment for this wedding yet, so money gifts stay off.");
        // Re-read the two Stripe columns that went stale — NOT
        // `invalidateRegistry`. Nothing on this tab re-fetches after a load, so
        // dropping the snapshot would leave the form rendering off `null`: no
        // items, so "add a gift before publishing" over a full list; no
        // settings, so "connect an account" to a connected couple; and
        // `patchCache` short-circuiting, so the next successful save would not
        // reach the cache either.
        void refreshStripe(true);
        return;
      }
      if (!res.ok) {
        haptic("reject");
        toast.error(
          res.status === 403
            ? "You don’t have permission to change these settings. Reload the page to see your current access."
            : "Could not save the settings. Please check the fields and try again.",
        );
        return;
      }
      const body = (await res.json()) as { settings: RegistrySettings };
      patchSettings(body.settings);
      haptic("commit");
      toast.success("Registry settings saved");
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      haptic("reject");
      toast.error("Could not save the settings. Is the API running?");
    } finally {
      setSaving(false);
    }
  }

  /** Start (or resume) Stripe onboarding, then hand the couple to Stripe. */
  async function connectStripe(): Promise<void> {
    if (connecting() || !props.canManage) return;
    setConnecting(true);
    try {
      const res = await authFetch(stripeUrl("session"), { method: "POST" });
      if (res.status === 401) return redirectToLogin();
      if (res.status === 404) {
        // The routes are not mounted, which means this deployment has no Stripe
        // configuration at all. Not the couple's problem, and not a fault they
        // can act on — say so plainly.
        haptic("reject");
        toast.error("Money gifts aren’t available on this site yet.");
        return;
      }
      if (!res.ok) {
        haptic("reject");
        toast.error(
          res.status === 403
            ? "Only the wedding’s owner can connect the account gifts are paid into."
            : "Couldn’t reach Stripe just now. Try again in a moment.",
        );
        return;
      }
      const body = (await res.json()) as { url?: string };
      if (!body.url || !isStripeConnectUrl(body.url)) {
        haptic("reject");
        toast.error("Couldn’t reach Stripe just now. Try again in a moment.");
        return;
      }
      // Leaving the portal. The snapshot is dropped first so coming back
      // re-reads rather than showing the state from before onboarding.
      invalidateRegistry(props.weddingId);
      window.location.assign(body.url);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      haptic("reject");
      toast.error("Couldn’t reach Stripe just now. Is the API running?");
    } finally {
      setConnecting(false);
    }
  }

  /**
   * Ask Stripe what the account can do now.
   *
   * `quiet` is the on-mount call for a couple mid-onboarding: it updates the
   * panel and says nothing, because nobody pressed anything. Pressed by hand,
   * it reports what it found — including "still not ready", which is the answer
   * a couple staring at a disabled switch actually needs.
   */
  async function refreshStripe(quiet = false): Promise<void> {
    if (checking() || !props.canManage) return;
    setChecking(true);
    try {
      const res = await authFetch(stripeUrl("refresh"), { method: "POST" });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        if (!quiet) {
          haptic("reject");
          toast.error("Couldn’t reach Stripe just now. Try again in a moment.");
        }
        return;
      }
      const status = (await res.json()) as { chargesEnabled: boolean; payoutsEnabled: boolean };
      const current = settings();
      if (current) {
        // `patchCache`, never `patchSettings`: this read changes two Stripe
        // columns the form does not own, and re-seeding would discard whatever
        // the couple has typed since the page loaded.
        patchCache({
          ...current,
          stripeChargesEnabled: status.chargesEnabled,
          stripePayoutsEnabled: status.payoutsEnabled,
        });
      }
      if (!quiet) {
        haptic(status.chargesEnabled ? "commit" : "reject");
        toast.success(
          status.chargesEnabled
            ? "Stripe is ready — you can let guests give money."
            : "Stripe still has something outstanding on your account.",
        );
      }
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      if (!quiet) {
        haptic("reject");
        toast.error("Couldn’t reach Stripe just now. Is the API running?");
      }
    } finally {
      setChecking(false);
    }
  }

  const hintClass = "font-body text-text-muted text-[0.8rem] leading-relaxed";

  return (
    <div class="border-border bg-surface/30 flex flex-col gap-6 rounded-sm border p-6">
      <SectionIntro
        eyebrow="Registry"
        title="Gift list settings"
        description="Whether your guests can see the list, what it says at the top, where parcels should go, and whether people can give money instead. Guests only ever see this list after entering their invite code."
      />

      <Show when={loadError()}>
        {(error) => (
          <Notice tone="error" alert>
            {error()}
          </Notice>
        )}
      </Show>

      <Show when={!loading() && !loadError() && seeded()}>
        <Show when={!props.canEdit}>
          <p class={hintClass}>You can read these settings, but not change them.</p>
        </Show>

        <form class="flex flex-col gap-8" noValidate onSubmit={(event) => void save(event)}>
          {/* ── Visibility ─────────────────────────────────────────────── */}
          {/* The description hangs off the FIELDSET, not off the blocked radio.
              A `disabled` radio is out of the tab order and skipped by a screen
              reader in forms mode, so a description on it would be unreachable
              by the one person who needs it; a group description is announced
              on entering the group, and the Draft radio beside it is always
              reachable. Making the radio `aria-disabled` instead would let a
              click flip the DOM's checked state while the signal stayed put. */}
          <fieldset
            class="flex flex-col gap-3 border-0 p-0"
            disabled={!props.canEdit}
            aria-describedby={canPublish() ? undefined : "registry-publish-blocked"}
          >
            <legend class="font-body text-gold-ink mb-1 text-[0.72rem] tracking-[0.2em] uppercase">
              Visibility
            </legend>

            <Show when={!canPublish()}>
              <Notice id="registry-publish-blocked" tone="warn">
                Add a gift before publishing. Guests reach the list — and the money-gift option with
                it — only once it is published, so an empty published list is a page with nothing on
                it.
              </Notice>
            </Show>

            <div class="flex flex-wrap gap-4">
              <label class="font-body text-text flex items-center gap-2 text-[0.9rem]">
                <input
                  type="radio"
                  name="registry-visibility"
                  checked={!published()}
                  onChange={() => setPublished(false)}
                />
                Draft — only you can see it
              </label>
              <label class="font-body text-text flex items-center gap-2 text-[0.9rem]">
                <input
                  type="radio"
                  name="registry-visibility"
                  data-testid="registry-publish"
                  checked={published()}
                  disabled={!canPublish() && !published()}
                  onChange={() => setPublished(true)}
                />
                Published — guests with a code can see it
              </label>
            </div>
          </fieldset>

          {/* ── The couple's own words ─────────────────────────────────── */}
          <fieldset class="flex flex-col gap-4 border-0 p-0" disabled={!props.canEdit}>
            <legend class="font-body text-gold-ink mb-1 text-[0.72rem] tracking-[0.2em] uppercase">
              What it says
            </legend>
            <Field
              label="Heading"
              hint="Leave it empty to use “Gift Registry”. The invite’s own heading, if you set one there, wins over this."
            >
              {(field) => (
                <Input
                  {...field}
                  value={headline()}
                  maxLength={120}
                  autocomplete="off"
                  onInput={(event) => setHeadline(event.currentTarget.value)}
                />
              )}
            </Field>
            <Field
              label="A note above the list"
              hint="“Your presence is the present”, or nothing at all."
            >
              {(field) => (
                <Textarea
                  {...field}
                  rows={3}
                  value={message()}
                  maxLength={1000}
                  onInput={(event) => setMessage(event.currentTarget.value)}
                />
              )}
            </Field>
          </fieldset>

          {/* ── Where parcels go ───────────────────────────────────────── */}
          <fieldset class="flex flex-col gap-4 border-0 p-0" disabled={!props.canEdit}>
            <legend class="font-body text-gold-ink mb-1 text-[0.72rem] tracking-[0.2em] uppercase">
              Where to send things
            </legend>
            <Field
              label="Address"
              hint="Shown only to a household that has reserved something — never to anyone browsing."
            >
              {(field) => (
                <Textarea
                  {...field}
                  rows={3}
                  value={shippingAddress()}
                  maxLength={500}
                  onInput={(event) => setShippingAddress(event.currentTarget.value)}
                />
              )}
            </Field>
            <Field
              label="Hide the address until"
              hint="For “don’t post anything before we’re back”. Leave it empty to show it as soon as someone reserves a gift."
            >
              {(field) => (
                <Input
                  {...field}
                  type="date"
                  value={shippingVisibleFrom()}
                  onInput={(event) => setShippingVisibleFrom(event.currentTarget.value)}
                />
              )}
            </Field>
          </fieldset>

          {/* ── Money ──────────────────────────────────────────────────── */}
          <fieldset class="flex flex-col gap-3 border-0 p-0">
            <legend class="font-body text-gold-ink mb-1 text-[0.72rem] tracking-[0.2em] uppercase">
              Money gifts
            </legend>

            <p class={hintClass} data-testid="stripe-status">
              {stripeState() === "ready"
                ? "Stripe is connected and can take payments. Gifts go straight to your account — we never hold the money."
                : stripeState() === "incomplete"
                  ? "Stripe has your account but still wants something before it can take payments."
                  : "To let guests give money, connect a Stripe account. Gifts go straight to it — we never hold the money."}
            </p>

            <div class="flex flex-wrap items-center gap-3">
              {/* Not `disabled` for an editor: the whole point of showing this
                  panel to a co-host is that they read WHY it is not theirs, and
                  a disabled button takes its description out of reach. It stays
                  focusable and `connectStripe` refuses on `canManage`, as does
                  the owner-only route behind it. `connecting()` is a passing
                  state with nothing to explain, so that one stays `disabled`. */}
              <Button
                type="button"
                variant="outline"
                disabled={connecting()}
                aria-disabled={props.canManage ? undefined : "true"}
                aria-describedby={props.canManage ? undefined : "stripe-owner-only"}
                onClick={() => void connectStripe()}
              >
                {connecting()
                  ? "Opening Stripe…"
                  : stripeState() === "none"
                    ? "Connect an account"
                    : "Continue on Stripe"}
              </Button>
              <Show when={stripeState() !== "none"}>
                {/* Same owner-only route as its neighbour, so the same gate and
                    the same reason. Ungated, a co-host pressing it met "Couldn't
                    reach Stripe just now" — a 403 dressed up as an outage,
                    which is an answer to a question they did not ask. */}
                <Button
                  type="button"
                  variant="quiet"
                  disabled={checking()}
                  aria-disabled={props.canManage ? undefined : "true"}
                  aria-describedby={props.canManage ? undefined : "stripe-owner-only"}
                  onClick={() => void refreshStripe()}
                >
                  {checking() ? "Checking…" : "Check again"}
                </Button>
              </Show>
            </div>

            <Show when={!props.canManage}>
              <p id="stripe-owner-only" class={hintClass} data-testid="stripe-owner-only">
                Only the wedding’s owner can connect the account gifts are paid into.
              </p>
            </Show>

            <label class="font-body text-text mt-1 flex items-start gap-2 text-[0.9rem]">
              <input
                type="checkbox"
                data-testid="cash-gifts"
                class="mt-1"
                checked={cashGifts()}
                disabled={!props.canEdit || stripeState() !== "ready"}
                onChange={(event) => setCashGifts(event.currentTarget.checked)}
              />
              <span>
                Let guests give money
                <Show when={stripeState() !== "ready"}>
                  <span class="text-text-muted block text-[0.8rem]">
                    Available once Stripe can take payments.
                  </span>
                </Show>
              </span>
            </label>
          </fieldset>

          <Show when={props.canEdit}>
            <div>
              <Button type="submit" variant="primary" disabled={saving()}>
                {saving() ? "Saving…" : "Save settings"}
              </Button>
            </div>
          </Show>
        </form>
      </Show>
    </div>
  );
}
