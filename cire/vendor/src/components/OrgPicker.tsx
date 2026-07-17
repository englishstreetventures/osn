import { useAuth } from "@osn/client/solid";
import { createResource, createSignal, For, Show } from "solid-js";

import { friendlyError } from "../lib/api";
import { listMyOrgs, type OrgSummary } from "../lib/vendor-store";

interface OrgPickerProps {
  onPick: (org: OrgSummary) => void;
}

/**
 * Lists the OSN organisations the signed-in vendor belongs to and lets them
 * pick one. Organisation *creation* is deliberately NOT here — an organisation
 * is an OSN account-level entity, created and managed in the OSN app, not the
 * vendor portal. A vendor with no organisation sees the empty-state below and
 * must create one in OSN first.
 *
 * Follow-up: once the OSN org-management surface is deployed to a reachable
 * URL, turn the empty-state copy into a link to it (tracked in cire/wiki/todo).
 */
export default function OrgPicker(props: OrgPickerProps) {
  const { authFetch } = useAuth();

  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [orgs] = createResource(async () => {
    try {
      return await listMyOrgs(authFetch);
    } catch (err) {
      setLoadError(friendlyError(err));
      return [];
    }
  });

  // Loaded, no error, and the caller belongs to no organisations.
  const isEmpty = () => !orgs.loading && !loadError() && (orgs() ?? []).length === 0;

  return (
    <div class="font-body flex flex-col gap-6">
      {/* Org load error */}
      <Show when={loadError()}>
        <p
          role="alert"
          class="border-error/40 text-error rounded-sm border px-3 py-2 text-[0.82rem]"
        >
          {loadError()}
        </p>
      </Show>

      {/* Org loading */}
      <Show when={orgs.loading}>
        <p
          role="status"
          class="font-body text-text-muted animate-pulse text-[0.88rem] tracking-[0.1em] uppercase"
        >
          Loading your organisations…
        </p>
      </Show>

      {/* Org list */}
      <Show when={(orgs() ?? []).length > 0}>
        <div class="flex flex-col gap-2">
          <h2 class="text-gold-dim font-body text-[0.68rem] tracking-[0.16em] uppercase">
            Your organisations
          </h2>
          <ul class="flex flex-col gap-1">
            <For each={orgs()}>
              {(org) => (
                <li>
                  <button
                    type="button"
                    onClick={() => props.onPick(org)}
                    class="border-border bg-surface/10 hover:bg-surface/30 flex w-full items-center gap-3 rounded-sm border px-4 py-3 text-left"
                  >
                    <span class="text-text font-medium">{org.name}</span>
                    <span class="text-text-muted text-[0.82rem]">@{org.handle}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>

      {/* Empty-state: no organisations. Creation lives in OSN, not the portal. */}
      <Show when={isEmpty()}>
        <div class="border-border bg-surface/20 flex flex-col gap-2 rounded-sm border p-4">
          <h2 class="text-gold font-body text-[0.68rem] tracking-[0.16em] uppercase">
            No organisations yet
          </h2>
          <p class="text-text text-[0.9rem] leading-relaxed">
            No organisations are associated with your account. Vendors publish through an OSN
            organisation.
          </p>
          <p class="text-text-muted text-[0.82rem] leading-relaxed">
            Create one in your OSN account, then return here to publish your listing.
          </p>
        </div>
      </Show>
    </div>
  );
}
