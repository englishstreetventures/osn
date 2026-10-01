import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { createEffect, createSignal, Match, Show, Switch } from "solid-js";
import { Portal } from "solid-js/web";

import { navigateTo, redirectToLogin } from "../lib/api";
import type { Module } from "../lib/dashboard-route";
import { haptic } from "../lib/haptics";
import { formatMinor } from "../lib/money";
import { type PaidTier, TIER_LABEL, tierAtLeast } from "../lib/tiers";
import {
  type CatalogueEntry,
  fetchCatalogue,
  startUpgrade,
  UpgradeApiError,
} from "../lib/upgrade-api";
import { catalogueAccessor, setCatalogue } from "../lib/upgrade-store";

/**
 * Buying the tier that opens a locked module.
 *
 * NOTHING HERE UNLOCKS ANYTHING. Pressing the button asks the API for a Stripe
 * page and sends the organiser to it; only a signature-verified webhook raises
 * the wedding's tier. The portal finds out when it comes back and polls.
 *
 * An empty catalogue is not an error. A deployment with no Stripe configured
 * has no upgrade routes at all, and the honest thing to show there is "not
 * available" rather than a button that 404s. The same goes for a tier the
 * catalogue does not offer this wedding — Crimson to a wedding on Gold, where
 * the deployment has no upgrade-from-Gold price.
 */
export interface UpgradeDialogProps {
  open: boolean;
  weddingId: string;
  /** The tier this dialog sells: the lowest one that includes the module the
   *  organiser asked for. */
  tier: PaidTier;
  /** The module the organiser asked for. Stripe sends them back to it. */
  module: Module;
  /** Fallback copy, from the nav row, shown until the catalogue lands. */
  title: string;
  blurb: string;
  onClose: () => void;
}

export default function UpgradeDialog(props: UpgradeDialogProps) {
  const { authFetch } = useAuth();
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  /**
   * Whether this dialog has already tried.
   *
   * NOT derived from `loading`/`failed`, and the difference is not cosmetic: a
   * failure resets both, so an effect gated on them alone sees "no catalogue,
   * not loading" and fetches again — forever, at whatever rate the API can
   * refuse. Plain state rather than a signal, because nothing renders from it
   * and a signal here would be another dependency for the effect to re-run on.
   */
  let attempted = false;
  const [submitting, setSubmitting] = createSignal(false);
  const catalogue = () => catalogueAccessor(props.weddingId)();

  /** This dialog's entry, once prices are in. */
  const entry = (): CatalogueEntry | null =>
    catalogue()?.upgrades.find((e) => e.tier === props.tier) ?? null;

  /**
   * Whether the wedding is already on this tier or above, by the catalogue's
   * own read of it. The nav row locks by the wedding list and this by the
   * catalogue; they can disagree for one render after a purchase settles, and
   * saying so beats offering a second sale.
   */
  const held = (): boolean => {
    const current = catalogue()?.tier;
    return current != null && tierAtLeast(current, props.tier);
  };

  /** "Upgrade from Gold" when the price is the move from a paid tier, so the
   *  smaller figure reads as what it is rather than as Crimson's full price. */
  const eyebrow = (): string => {
    const from = entry()?.fromTier;
    return from && from !== "ivory" ? `Upgrade from ${TIER_LABEL[from]}` : "Upgrade";
  };

  // Priced on open rather than on mount: every locked nav row renders one of
  // these, and pricing them all up front would spend a request per row on a
  // dialog nobody opened.
  createEffect(() => {
    if (!props.open || catalogue() !== null || attempted) return;
    attempted = true;
    setLoading(true);
    setFailed(false);
    void fetchCatalogue(authFetch, props.weddingId)
      .then((found) => setCatalogue(props.weddingId, found))
      .catch((err: unknown) => {
        if (err instanceof UpgradeApiError && err.status === 401) {
          redirectToLogin();
          return;
        }
        // One attempt per open. Reopening the dialog is the retry, which is
        // both what an organiser would do anyway and the only retry that
        // cannot become a loop.
        setFailed(true);
      })
      .finally(() => setLoading(false));
  });

  const dismiss = () => {
    haptic("dismiss");
    props.onClose();
  };

  const handleBuy = async () => {
    if (submitting()) return;
    setSubmitting(true);
    try {
      const { url } = await startUpgrade(authFetch, props.weddingId, props.tier, props.module);
      haptic("commit");
      // Leaving the app entirely, so no toast: it would render for one frame
      // and vanish with the page.
      navigateTo(url);
    } catch (err) {
      haptic("reject");
      if (err instanceof UpgradeApiError && err.status === 401) {
        redirectToLogin();
      } else if (err instanceof UpgradeApiError && err.code === "processing") {
        // An earlier attempt is paid but not settled yet. Telling them to pay
        // again is how somebody gets charged twice.
        toast.info("Your previous payment is still being confirmed. This can take a moment.");
        props.onClose();
      } else if (err instanceof UpgradeApiError && err.code === "already_held") {
        toast.success(`This wedding is already on ${TIER_LABEL[props.tier]}. Refresh to see it.`);
        props.onClose();
      } else {
        toast.error("Could not start checkout. Please try again.");
      }
      setSubmitting(false);
    }
  };

  return (
    <Show when={props.open}>
      {/* Portalled to document.body: the dashboard shell sets `container-type`
          on its layout boxes, which brings `contain: layout` with it and makes
          them the containing block for `position: fixed` descendants. */}
      <Portal>
        <div
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) dismiss();
          }}
        >
          <div
            /* A portalled div rather than `<dialog>`: this app's modals are
               portalled to `document.body` because the dashboard shell sets
               `container-type`, and they are opened declaratively by Solid
               rather than through `showModal()`. Same shape as EnquireDialog. */
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
            role="dialog"
            aria-modal="true"
            aria-label={`Upgrade: ${entry()?.title ?? props.title}`}
            class="border-border bg-bg flex w-full max-w-md flex-col gap-4 rounded-sm border p-6"
          >
            <header class="flex flex-col gap-1">
              <p class="font-body text-gold text-ui-xs tracking-ui-ultra uppercase">{eyebrow()}</p>
              <h3 class="font-display text-text text-ui-lg font-light">
                {entry()?.title ?? props.title}
              </h3>
              <p class="text-text-muted text-ui-sm leading-snug">{entry()?.blurb ?? props.blurb}</p>
            </header>

            <Switch>
              <Match when={loading()}>
                <p class="text-text-muted text-ui-sm">Checking the price…</p>
              </Match>
              <Match when={failed()}>
                <p class="text-text-muted text-ui-sm">
                  Could not load the price just now. Please try again.
                </p>
              </Match>
              <Match when={held()}>
                <p class="text-text-muted text-ui-sm">
                  This wedding is already on {TIER_LABEL[props.tier]}. Refresh to open it.
                </p>
              </Match>
              <Match when={entry()}>
                {(priced) => (
                  <p class="font-display text-text text-ui-xl font-light">
                    {formatMinor(priced().amountMinor, priced().currency)}
                    <span class="text-text-muted tracking-ui-widest text-ui-xs ml-2 uppercase">
                      one-off
                    </span>
                  </p>
                )}
              </Match>
              <Match when={catalogue() !== null}>
                {/* Catalogue loaded and this tier is not in it: no Stripe Price
                    configured in this deployment for the move from the
                    wedding's tier, or no Stripe at all. */}
                <p class="text-text-muted text-ui-sm">
                  Upgrades are not available on this site yet.
                </p>
              </Match>
            </Switch>

            <div class="flex items-center gap-3">
              <button
                type="button"
                disabled={submitting() || entry() === null || held()}
                onClick={() => void handleBuy()}
                class="bg-gold text-bg tracking-ui-wider text-ui-sm rounded-sm px-4 py-1.5 uppercase disabled:opacity-60"
              >
                {submitting() ? "Opening checkout…" : "Continue to payment"}
              </button>
              <button
                type="button"
                onClick={dismiss}
                class="text-text-muted hover:text-text text-ui-sm"
              >
                Cancel
              </button>
            </div>

            <p class="text-text-faint text-ui-xs leading-snug">
              Payment is handled by Stripe. You will come back here once it is done.
            </p>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
