import { useAuth } from "@shared/rp-auth/solid";
import { createResource, createSignal, For, Show } from "solid-js";

import { friendlyError } from "../lib/api";
import { OSN_ACCOUNT_URL } from "../lib/osn";
import { listMyOrgs, type OrgSummary } from "../lib/vendor-store";
import { buttonClass } from "./ui/Button";
import { cardClass } from "./ui/Card";
import EmptyState from "./ui/EmptyState";
import Loading from "./ui/Loading";
import Notice from "./ui/Notice";

interface OrgPickerProps {
  onPick: (org: OrgSummary) => void;
}

/**
 * Lists the OSN organisations the signed-in vendor belongs to and lets them
 * pick one. Organisation *creation* is deliberately NOT here — an organisation
 * is an OSN account-level entity, created and managed in the OSN app, not the
 * vendor portal. A vendor with no organisation sees the empty state below and
 * must create one in musubi first.
 *
 * The empty state is where the redesign changed behaviour rather than just
 * looks: it used to be two paragraphs telling the vendor to "create one in your
 * OSN account, then return here" with nothing to click — a dead end that named
 * its own exit and didn't open it. `OSN_ACCOUNT_URL` has been sitting in
 * `lib/osn.ts` the whole time, so the exit is now a link.
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
    <div class="flex flex-col gap-6">
      <Show when={loadError()}>
        {(message) => (
          <Notice tone="error" alert>
            {message()}
          </Notice>
        )}
      </Show>

      <Show when={orgs.loading}>
        <Loading label="Loading your organisations…" />
      </Show>

      <Show when={(orgs() ?? []).length > 0}>
        <div class="flex flex-col gap-3">
          <h2 class="font-body text-gold text-[0.7rem] tracking-[0.18em] uppercase">
            Your organisations
          </h2>
          {/* One column until there is room for two whole cards. An org row is
              a name and a handle — short enough that a single column on a
              widescreen is mostly empty space. */}
          <ul class="auto-grid list-none p-0 [--auto-grid-min:20rem]">
            <For each={orgs()}>
              {(org) => (
                <li class="contents">
                  <button
                    type="button"
                    onClick={() => props.onPick(org)}
                    class={`${cardClass({ interactive: true })} gap-1`}
                  >
                    <span class="font-body text-text font-medium">{org.name}</span>
                    <span class="font-body text-text-muted text-[0.82rem]">@{org.handle}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>

      <Show when={isEmpty()}>
        <EmptyState
          title="No organisations yet"
          description="Vendors publish through an OSN organisation, and your account isn't in one. Create one in musubi, then come back here to publish your listing."
          action={
            <a
              href={`${OSN_ACCOUNT_URL}/settings/organisations`}
              target="_blank"
              rel="noopener noreferrer"
              class={buttonClass({ variant: "outline" })}
            >
              Create one in musubi
              <span aria-hidden="true">↗</span>
              <span class="sr-only">(opens in a new tab)</span>
            </a>
          }
        />
      </Show>
    </div>
  );
}
