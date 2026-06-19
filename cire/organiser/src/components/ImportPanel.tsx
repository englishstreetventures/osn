import { useAuth } from "@osn/client/solid";
import { createSignal, Show, For } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import {
  EVENT_REQUIRED_HEADERS,
  EVENT_OPTIONAL_HEADERS,
  GUEST_TEMPLATE_FIXED_HEADERS,
  GUEST_TEMPLATE_EXAMPLE_EVENTS,
  buildEventsTemplateCsv,
  buildGuestsTemplateCsv,
} from "../lib/import-templates";

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
 * Trigger a client-side download of `content` as `filename`. The CSV is built
 * from code-authored static templates (see `../lib/import-templates`), so there
 * is no server round-trip and no formula-injection surface. The object URL is
 * revoked after the click so it can't leak.
 */
function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
        <p class="font-body text-text-muted text-[0.82rem]">
          Import your two sheets as CSV — events first, then guests. Start from a template below, or
          read the format guide if you're building your own.
        </p>
      </header>

      <div class="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => downloadCsv("cire-events-template.csv", buildEventsTemplateCsv())}
          class="border-gold/40 font-body text-gold hover:border-gold hover:bg-gold/10 rounded-sm border px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition"
        >
          Download events template
        </button>
        <button
          type="button"
          onClick={() => downloadCsv("cire-guests-template.csv", buildGuestsTemplateCsv())}
          class="border-gold/40 font-body text-gold hover:border-gold hover:bg-gold/10 rounded-sm border px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition"
        >
          Download guests template
        </button>
      </div>

      <CsvFormatHelp />

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

/**
 * A column-name chip. `required` columns read in gold; optional ones stay muted,
 * so the two kinds are visually distinct in the step cards (legend up top).
 */
function Col(props: { children: string; required?: boolean }) {
  return (
    <code
      class="bg-bg/60 rounded-[2px] px-1 py-0.5 font-mono text-[0.74rem]"
      classList={{
        "text-gold-dim": props.required === true,
        "text-text-muted": props.required !== true,
      }}
    >
      {props.children}
    </code>
  );
}

/** The numbered circle that leads each step card. */
function StepBadge(props: { n: number }) {
  return (
    <span class="border-gold/50 text-gold flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-[0.78rem]">
      {props.n}
    </span>
  );
}

/**
 * A 2-row illustration of the per-event invite columns — the part organisers
 * trip on. Two guests in one family with `yes` cells under named event columns
 * and a blank ("—") for a guest not invited to that event.
 */
function MiniMatrix() {
  return (
    <div class="border-border/70 overflow-hidden rounded-[3px] border">
      <table class="w-full border-collapse font-mono text-[0.7rem]">
        <thead>
          <tr class="bg-bg/50 text-gold-dim">
            <th class="px-2 py-1 text-left font-normal">Name</th>
            <th class="px-2 py-1 text-center font-normal">Ceremony</th>
            <th class="px-2 py-1 text-center font-normal">Reception</th>
          </tr>
        </thead>
        <tbody class="text-text-muted">
          <tr class="border-border/50 border-t">
            <td class="text-text px-2 py-1">Linh</td>
            <td class="text-gold px-2 py-1 text-center">yes</td>
            <td class="text-gold px-2 py-1 text-center">yes</td>
          </tr>
          <tr class="border-border/50 border-t">
            <td class="text-text px-2 py-1">Minh</td>
            <td class="text-gold px-2 py-1 text-center">yes</td>
            <td class="px-2 py-1 text-center">—</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * "How to structure your two sheets" — a three-step visual guide that mirrors the
 * cire-api parser (`cire/api/src/services/spreadsheet.ts`): required vs optional
 * columns, the ISO-8601 + IANA date/timezone format, the one-column-per-event
 * guest convention with truthy cells, family grouping by Family ID, and the
 * events-before-guests ordering. A native <details>/<summary> (open by default)
 * keeps it keyboard- and screen-reader-accessible with no JS.
 */
function CsvFormatHelp() {
  return (
    <details open class="border-border bg-bg/30 group rounded-sm border">
      <summary class="font-body text-text hover:text-gold flex cursor-pointer items-center gap-2 px-4 py-3 text-[0.88rem] transition select-none">
        <span class="text-gold inline-block transition-transform group-open:rotate-90" aria-hidden>
          ›
        </span>
        How to structure your two sheets — CSV format
      </summary>

      <div class="border-border/60 flex flex-col gap-5 border-t px-4 py-5">
        <div class="text-text-muted flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[0.78rem]">
          <span class="flex items-center gap-1.5">
            <Col required>required</Col> always needed
          </span>
          <span class="flex items-center gap-1.5">
            <Col>optional</Col> nice to have
          </span>
        </div>

        <ol class="grid grid-cols-1 gap-4 md:grid-cols-3">
          <li class="border-border bg-surface/30 flex flex-col gap-3 rounded-sm border p-4">
            <div class="flex items-center gap-2.5">
              <StepBadge n={1} />
              <h3 class="font-display text-text text-[1.05rem] italic">Events sheet</h3>
            </div>
            <p class="text-text-muted text-[0.8rem]">One row per event.</p>
            <ul class="flex flex-wrap gap-1.5">
              <For each={EVENT_REQUIRED_HEADERS}>
                {(h) => (
                  <li>
                    <Col required>{h}</Col>
                  </li>
                )}
              </For>
              <For each={EVENT_OPTIONAL_HEADERS}>
                {(h) => (
                  <li>
                    <Col>{h}</Col>
                  </li>
                )}
              </For>
            </ul>
            <p class="text-text-muted text-[0.76rem]">
              <Col required>Start</Col> / <Col required>End</Col> are full timestamps (
              <span class="text-text font-mono">2026-11-14T15:00:00+11:00</span>);{" "}
              <Col required>Timezone</Col> an IANA zone (
              <span class="text-text font-mono">Australia/Sydney</span>).
            </p>
          </li>

          <li class="border-border bg-surface/30 flex flex-col gap-3 rounded-sm border p-4">
            <div class="flex items-center gap-2.5">
              <StepBadge n={2} />
              <h3 class="font-display text-text text-[1.05rem] italic">Guests sheet</h3>
            </div>
            <p class="text-text-muted text-[0.8rem]">One row per guest.</p>
            <ul class="flex flex-wrap gap-1.5">
              <For each={GUEST_TEMPLATE_FIXED_HEADERS}>
                {(h) => (
                  <li>
                    <Col required>{h}</Col>
                  </li>
                )}
              </For>
            </ul>
            <p class="text-text-muted text-[0.76rem]">
              Then <strong class="text-text">one column per event</strong>, named exactly after an
              event. Mark invited guests with <span class="text-text">yes</span> /{" "}
              <span class="text-text">true</span> / <span class="text-text">1</span> /{" "}
              <span class="text-text">x</span> — blank means not invited.
            </p>
            <MiniMatrix />
          </li>

          <li class="border-border bg-surface/30 flex flex-col gap-3 rounded-sm border p-4">
            <div class="flex items-center gap-2.5">
              <StepBadge n={3} />
              <h3 class="font-display text-text text-[1.05rem] italic">Upload &amp; preview</h3>
            </div>
            <p class="text-text-muted text-[0.8rem]">
              Upload <strong class="text-text">events first</strong>, then guests — each guest's
              event columns are matched to events that already exist, so the events sheet has to go
              in before the guests sheet.
            </p>
            <p class="text-text-muted text-[0.76rem]">
              <span class="text-text">Preview</span> shows a diff of what will change; nothing is
              saved until you <span class="text-text">Apply</span>.
            </p>
            <p class="text-text-muted text-[0.76rem]">
              New here? Grab the <span class="text-gold-dim">templates</span> above — correct
              headers and example rows. Rename the <Col>{GUEST_TEMPLATE_EXAMPLE_EVENTS[0]}</Col> /{" "}
              <Col>{GUEST_TEMPLATE_EXAMPLE_EVENTS[1]}</Col> columns to your real event names.
            </p>
          </li>
        </ol>

        <p class="text-text-muted text-[0.76rem]">
          <span class="text-text">Good to know:</span> guests sharing a <Col>Family ID</Col> become
          one household (they claim &amp; RSVP together). <Col>Pinterest URL</Col> /{" "}
          <Col>Maps URL</Col> need full http(s) links. <Col>Dress Code Palette</Col> looks like{" "}
          <span class="text-text font-mono">Blush:#f4c2c2|Sage:#b2ac88</span>.
        </p>
      </div>
    </details>
  );
}
