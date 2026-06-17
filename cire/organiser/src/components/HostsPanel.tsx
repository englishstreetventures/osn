import { useAuth } from "@osn/client/solid";
import { createSignal, For, onMount, Show } from "solid-js";
import { toast } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";

interface HostRow {
  osnProfileId: string;
  /** Present only on a freshly-added host (the add response echoes the handle);
   *  the list endpoint returns ids only, so existing rows show the id. */
  handle?: string;
  role: "host";
  createdAt: number;
}

interface HostsPanelProps {
  weddingId: string;
  /** True when the signed-in organiser owns this wedding. Owners can add/remove
   *  co-hosts; co-hosts see the list read-only. */
  canManage: boolean;
}

/**
 * Hosts section of a wedding's dashboard. Lists the wedding's co-hosts and — for
 * the owner — lets them add another organiser by OSN handle or remove one. A
 * co-host gets access to this wedding's dashboard; only the owner manages the
 * list.
 */
export default function HostsPanel(props: HostsPanelProps) {
  const { authFetch } = useAuth();
  const [hosts, setHosts] = createSignal<HostRow[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [handle, setHandle] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const [addError, setAddError] = createSignal<string | null>(null);

  const endpoint = () => apiUrl(`/api/organiser/weddings/${props.weddingId}/hosts`);

  onMount(async () => {
    try {
      const res = await authFetch(endpoint());
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error("Failed to load");
      const body = (await res.json()) as { hosts: HostRow[] };
      setHosts(body.hosts);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Could not load hosts. Is the API running?");
    } finally {
      setLoading(false);
    }
  });

  async function add(e: Event) {
    e.preventDefault();
    const value = handle().trim();
    if (!value) {
      setAddError("Enter an OSN handle, like @alice.");
      return;
    }
    setAddError(null);
    setAdding(true);
    try {
      const res = await authFetch(endpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: value }),
      });
      if (res.status === 401) return redirectToLogin();
      if (res.status === 404) {
        setAddError(`No OSN account found for ${value.startsWith("@") ? value : `@${value}`}.`);
        return;
      }
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setAddError(
          body.error === "owner_is_host"
            ? "You already host this wedding as its owner."
            : "That person is already a host.",
        );
        return;
      }
      if (res.status === 503) {
        setAddError("Adding hosts isn't available on this deployment yet.");
        return;
      }
      if (!res.ok) {
        setAddError("Could not add that host. Please try again.");
        return;
      }
      const body = (await res.json()) as { host: HostRow };
      setHosts((prev) => [...prev, body.host]);
      setHandle("");
      toast.success(`Added ${body.host.handle ? `@${body.host.handle}` : "host"} as a host.`);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setAddError("Could not add that host. Is the API running?");
    } finally {
      setAdding(false);
    }
  }

  async function remove(host: HostRow) {
    const label = host.handle ? `@${host.handle}` : host.osnProfileId;
    try {
      const res = await authFetch(`${endpoint()}/${encodeURIComponent(host.osnProfileId)}`, {
        method: "DELETE",
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error("Could not remove that host. Please try again.");
        return;
      }
      setHosts((prev) => prev.filter((h) => h.osnProfileId !== host.osnProfileId));
      toast.success(`Removed ${label}.`);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      toast.error("Could not remove that host. Is the API running?");
    }
  }

  return (
    <div class="flex flex-col gap-8">
      <div class="flex flex-col gap-1">
        <p class="font-body text-gold text-[0.72rem] tracking-[0.2em] uppercase">Co-hosts</p>
        <h2 class="font-display text-text text-[1.4rem] font-light italic">
          Share this wedding's dashboard
        </h2>
        <p class="font-body text-text-muted text-[0.82rem]">
          {props.canManage
            ? "Add another organiser by their OSN handle. Co-hosts can view and edit this wedding, but only you can manage who hosts it."
            : "These organisers can view and edit this wedding."}
        </p>
      </div>

      <Show when={props.canManage}>
        <form class="flex flex-col gap-3" onSubmit={add}>
          <div class="flex flex-col gap-1.5">
            <label
              for="host-handle"
              class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase"
            >
              OSN handle
            </label>
            <div class="flex flex-wrap items-center gap-3">
              <input
                id="host-handle"
                name="osnHandle"
                type="text"
                value={handle()}
                maxLength={64}
                placeholder="@alice"
                autocomplete="off"
                autocapitalize="none"
                spellcheck={false}
                aria-invalid={addError() ? "true" : undefined}
                aria-describedby={addError() ? "host-handle-error" : undefined}
                onInput={(e) => setHandle(e.currentTarget.value)}
                disabled={adding()}
                class="border-border bg-bg font-body text-text focus:border-gold min-w-[12rem] flex-1 rounded-sm border px-3 py-2 text-[0.95rem] transition-colors outline-none placeholder:opacity-40 disabled:opacity-40"
              />
              <button
                type="submit"
                disabled={adding()}
                class="border-gold bg-gold font-body text-bg hover:bg-gold-dim rounded-sm border px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
              >
                {adding() ? "Adding…" : "Add host"}
              </button>
            </div>
          </div>
          <Show when={addError()}>
            <p
              id="host-handle-error"
              role="alert"
              class="border-error/20 bg-error/5 text-error rounded-sm border p-4 text-[0.88rem]"
            >
              {addError()}
            </p>
          </Show>
        </form>
      </Show>

      <Show when={loading()}>
        <div class="flex flex-col gap-3">
          <For each={[1, 2]}>
            {() => <div class="bg-surface h-[52px] animate-pulse rounded-sm" />}
          </For>
        </div>
      </Show>

      <Show when={error()}>
        <p
          role="alert"
          class="border-error/20 bg-error/5 text-error rounded-sm border p-4 text-[0.88rem]"
        >
          {error()}
        </p>
      </Show>

      <Show when={!loading() && !error()}>
        <Show
          when={hosts().length > 0}
          fallback={
            <p class="border-border bg-surface/30 text-text-muted rounded-sm border p-6 text-[0.88rem]">
              No co-hosts yet.{" "}
              {props.canManage
                ? "Add one above to share this wedding."
                : "Only the owner manages this wedding for now."}
            </p>
          }
        >
          <ul class="flex flex-col gap-2">
            <For each={hosts()}>
              {(host) => (
                <li class="border-border bg-surface/30 flex items-center justify-between gap-4 rounded-sm border px-4 py-3">
                  <span class="font-body text-text text-[0.92rem]">
                    {host.handle ? (
                      <span class="text-gold-dim">@{host.handle}</span>
                    ) : (
                      <span
                        class="text-text-muted font-mono text-[0.82rem] tracking-[0.04em]"
                        title="OSN profile id"
                      >
                        {host.osnProfileId}
                      </span>
                    )}
                  </span>
                  <Show when={props.canManage}>
                    <button
                      type="button"
                      onClick={() => void remove(host)}
                      class="font-body text-text-muted hover:text-error text-[0.72rem] tracking-[0.1em] uppercase underline-offset-4 transition hover:underline"
                      aria-label={`Remove ${host.handle ? `@${host.handle}` : "host"}`}
                    >
                      Remove
                    </button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  );
}
