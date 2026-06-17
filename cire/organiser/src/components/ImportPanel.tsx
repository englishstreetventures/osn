import { useAuth } from "@osn/client/solid";
import { createSignal, Show, For } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";

interface ImportPlan {
  eventCreates: unknown[];
  eventUpdates: unknown[];
  eventRemoves: { id: string; name: string }[];
  familyCreates: { id: string; publicId: string; familyName: string }[];
  familyRemoves: { id: string; familyName: string }[];
  guestCreates: { id: string; firstName: string; lastName: string }[];
  guestUpdates: { id: string; lastName: string }[];
  guestRemoves: { id: string; firstName: string }[];
  eventLinkCreates: unknown[];
  eventLinkRemoves: unknown[];
  warnings: string[];
}

interface PreviewResponse {
  importId: string;
  plan: ImportPlan;
  warnings: string[];
}

interface ApplyResponse {
  summary: {
    importId: string;
    eventsCreated: number;
    eventsUpdated: number;
    eventsRemoved: number;
    familiesCreated: number;
    familiesRemoved: number;
    guestsCreated: number;
    guestsUpdated: number;
    guestsRemoved: number;
    warnings: string[];
  };
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("read failed")));
    reader.readAsText(file);
  });
}

/**
 * Imports are authorised by the caller's OSN access JWT (attached by authFetch)
 * plus ownership of the wedding named in the path — the organiser picks the
 * target wedding upstream and every import call is scoped to it.
 */
export default function ImportPanel(props: { weddingId: string }) {
  const { authFetch } = useAuth();
  const importUrl = (op: string) =>
    apiUrl(`/api/organiser/weddings/${props.weddingId}/import/${op}`);
  const [eventsFile, setEventsFile] = createSignal<File | null>(null);
  const [guestsFile, setGuestsFile] = createSignal<File | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [preview, setPreview] = createSignal<PreviewResponse | null>(null);
  const [applied, setApplied] = createSignal<ApplyResponse["summary"] | null>(null);

  async function handlePreview(e: Event) {
    e.preventDefault();
    setError(null);
    setApplied(null);
    setPreview(null);

    const events = eventsFile();
    const guests = guestsFile();
    if (!events) return setError("Choose an events.csv file.");
    if (!guests) return setError("Choose a guests.csv file.");

    setBusy(true);
    try {
      const [eventsCsv, guestsCsv] = await Promise.all([readFile(events), readFile(guests)]);
      const res = await authFetch(importUrl("preview"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventsCsv, guestsCsv }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Preview failed (${res.status})`);
      }
      setPreview((await res.json()) as PreviewResponse);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError(err instanceof Error ? err.message : "Preview failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleApply() {
    const p = preview();
    if (!p) return;
    setError(null);
    setBusy(true);
    try {
      const res = await authFetch(importUrl("apply"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ importId: p.importId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Apply failed (${res.status})`);
      }
      const data = (await res.json()) as ApplyResponse;
      setApplied(data.summary);
      setPreview(null);
      setEventsFile(null);
      setGuestsFile(null);
      // Refresh guest table.
      window.location.reload();
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError(err instanceof Error ? err.message : "Apply failed.");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setPreview(null);
    setApplied(null);
    setError(null);
  }

  return (
    <section class="border-border bg-surface/30 flex flex-col gap-6 rounded-sm border p-6">
      <header class="flex flex-col gap-1">
        <p class="font-body text-gold text-[0.72rem] tracking-[0.2em] uppercase">
          Spreadsheet Import
        </p>
        <h2 class="font-display text-text text-[1.4rem] font-light italic">
          Upload events &amp; guests CSV
        </h2>
      </header>

      <form class="flex flex-col gap-4" onSubmit={handlePreview}>
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label class="flex flex-col gap-1.5">
            <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
              events.csv
            </span>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setEventsFile(e.currentTarget.files?.[0] ?? null)}
              class="font-body text-text file:border-border file:bg-bg file:font-body file:text-text hover:file:border-gold text-[0.82rem] file:mr-3 file:rounded-sm file:border file:px-3 file:py-1.5 file:text-[0.82rem]"
            />
            <Show when={eventsFile()}>
              <span class="text-text-muted font-mono text-[0.72rem]">{eventsFile()?.name}</span>
            </Show>
          </label>

          <label class="flex flex-col gap-1.5">
            <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
              guests.csv
            </span>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setGuestsFile(e.currentTarget.files?.[0] ?? null)}
              class="font-body text-text file:border-border file:bg-bg file:font-body file:text-text hover:file:border-gold text-[0.82rem] file:mr-3 file:rounded-sm file:border file:px-3 file:py-1.5 file:text-[0.82rem]"
            />
            <Show when={guestsFile()}>
              <span class="text-text-muted font-mono text-[0.72rem]">{guestsFile()?.name}</span>
            </Show>
          </label>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={busy()}
            class="border-gold bg-gold/10 font-body text-gold hover:bg-gold/20 rounded-sm border px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
          >
            {busy() ? "Working…" : "Preview"}
          </button>
          <Show when={preview() || applied() || error()}>
            <button
              type="button"
              onClick={reset}
              disabled={busy()}
              class="font-body text-text-muted text-[0.82rem] underline-offset-4 hover:underline disabled:opacity-40"
            >
              Reset
            </button>
          </Show>
        </div>
      </form>

      <Show when={error()}>
        <p class="border-error/20 bg-error/5 text-error rounded-sm border p-4 text-[0.88rem]">
          {error()}
        </p>
      </Show>

      <Show when={preview()}>
        {(p) => (
          <div class="border-border bg-bg/40 flex flex-col gap-4 rounded-sm border p-4">
            <h3 class="font-display text-gold-dim text-[1.1rem] italic">Diff preview</h3>
            <PlanCounts plan={p().plan} />
            <Show when={p().plan.warnings.length > 0}>
              <ul class="text-text-muted flex flex-col gap-1 text-[0.82rem]">
                <For each={p().plan.warnings}>
                  {(w) => <li class="before:mr-2 before:content-['•']">{w}</li>}
                </For>
              </ul>
            </Show>
            <button
              type="button"
              onClick={handleApply}
              disabled={busy()}
              class="border-gold bg-gold font-body text-bg hover:bg-gold-dim self-start rounded-sm border px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
            >
              {busy() ? "Applying…" : "Apply import"}
            </button>
          </div>
        )}
      </Show>

      <Show when={applied()}>
        {(s) => (
          <div class="border-gold/30 bg-gold/5 text-text flex flex-col gap-2 rounded-sm border p-4 text-[0.88rem]">
            <p class="font-display text-gold-dim text-[1.1rem] italic">Applied</p>
            <p class="text-text-muted font-mono text-[0.72rem]">{s().importId}</p>
            <p>
              events: +{s().eventsCreated} / ~{s().eventsUpdated} / -{s().eventsRemoved} · families:
              +{s().familiesCreated} / -{s().familiesRemoved} · guests: +{s().guestsCreated} / ~
              {s().guestsUpdated} / -{s().guestsRemoved}
            </p>
          </div>
        )}
      </Show>
    </section>
  );
}

function PlanCounts(props: { plan: ImportPlan }) {
  const rows: { label: string; create: number; update: number; remove: number }[] = [
    {
      label: "events",
      create: props.plan.eventCreates.length,
      update: props.plan.eventUpdates.length,
      remove: props.plan.eventRemoves.length,
    },
    {
      label: "families",
      create: props.plan.familyCreates.length,
      update: 0,
      remove: props.plan.familyRemoves.length,
    },
    {
      label: "guests",
      create: props.plan.guestCreates.length,
      update: props.plan.guestUpdates.length,
      remove: props.plan.guestRemoves.length,
    },
    {
      label: "invitations",
      create: props.plan.eventLinkCreates.length,
      update: 0,
      remove: props.plan.eventLinkRemoves.length,
    },
  ];

  return (
    <table class="font-body w-full border-collapse text-[0.88rem]">
      <thead>
        <tr>
          <th class="border-border text-gold border-b px-3 py-2 text-left text-[0.72rem] font-normal tracking-[0.1em] uppercase" />
          <th class="border-border text-gold border-b px-3 py-2 text-right text-[0.72rem] font-normal tracking-[0.1em] uppercase">
            Create
          </th>
          <th class="border-border text-gold border-b px-3 py-2 text-right text-[0.72rem] font-normal tracking-[0.1em] uppercase">
            Update
          </th>
          <th class="border-border text-gold border-b px-3 py-2 text-right text-[0.72rem] font-normal tracking-[0.1em] uppercase">
            Remove
          </th>
        </tr>
      </thead>
      <tbody>
        <For each={rows}>
          {(r) => (
            <tr>
              <td class="border-border text-text border-b px-3 py-2">{r.label}</td>
              <td class="border-border text-text-muted border-b px-3 py-2 text-right font-mono">
                {r.create}
              </td>
              <td class="border-border text-text-muted border-b px-3 py-2 text-right font-mono">
                {r.update}
              </td>
              <td class="border-border text-text-muted border-b px-3 py-2 text-right font-mono">
                {r.remove}
              </td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );
}
