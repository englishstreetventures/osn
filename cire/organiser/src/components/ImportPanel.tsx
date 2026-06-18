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

/** A small label for a column name inside the help copy. */
function Col(props: { children: string }) {
  return (
    <code class="bg-bg/60 text-gold-dim rounded-[2px] px-1 py-0.5 font-mono text-[0.78rem]">
      {props.children}
    </code>
  );
}

/**
 * Collapsible "CSV format" guide. Mirrors the cire-api parser
 * (`cire/api/src/services/spreadsheet.ts`) — required vs optional columns, the
 * ISO-8601 + IANA date/timezone format, the one-column-per-event guest
 * convention with truthy cells, family grouping by Family ID, and the
 * events-before-guests ordering. Built on a native <details>/<summary> so it's
 * keyboard- and screen-reader-accessible with no JS.
 */
function CsvFormatHelp() {
  return (
    <details class="border-border bg-bg/30 group rounded-sm border">
      <summary class="font-body text-text hover:text-gold flex cursor-pointer items-center gap-2 px-4 py-3 text-[0.88rem] transition select-none">
        <span class="text-gold inline-block transition-transform group-open:rotate-90" aria-hidden>
          ›
        </span>
        CSV format — how to structure your two sheets
      </summary>

      <div class="border-border/60 flex flex-col gap-6 border-t px-4 py-5 text-[0.85rem]">
        <p class="border-gold/20 bg-gold/5 text-text rounded-sm border px-3 py-2">
          Import <strong class="text-gold-dim">events first</strong>, then guests. Each guest's
          event columns are matched against events that already exist, so the events sheet has to go
          in before the guests sheet.
        </p>

        <section class="flex flex-col gap-2">
          <h3 class="font-body text-gold text-[0.72rem] tracking-[0.2em] uppercase">
            Events sheet
          </h3>
          <p class="text-text-muted">
            One row per event. These columns are <strong class="text-text">required</strong>:
          </p>
          <ul class="text-text-muted flex flex-wrap gap-x-2 gap-y-1.5">
            <For each={EVENT_REQUIRED_HEADERS}>
              {(h) => (
                <li>
                  <Col>{h}</Col>
                </li>
              )}
            </For>
          </ul>
          <p class="text-text-muted">
            <Col>Start</Col> and <Col>End</Col> are ISO-8601 timestamps with a UTC offset (e.g.{" "}
            <span class="text-text font-mono text-[0.78rem]">2026-11-14T15:00:00+11:00</span>), and{" "}
            <Col>Timezone</Col> is an IANA zone (e.g.{" "}
            <span class="text-text font-mono text-[0.78rem]">Australia/Sydney</span>).
          </p>
          <p class="text-text-muted">
            Optional columns you can add:{" "}
            <For each={EVENT_OPTIONAL_HEADERS}>
              {(h, i) => (
                <>
                  <Col>{h}</Col>
                  {i() < EVENT_OPTIONAL_HEADERS.length - 1 ? " " : "."}
                </>
              )}
            </For>{" "}
            <Col>Pinterest URL</Col> and <Col>Maps URL</Col> must be full http(s) links.{" "}
            <Col>Dress Code Palette</Col> is a list like{" "}
            <span class="text-text font-mono text-[0.78rem]">Blush:#f4c2c2|Sage:#b2ac88</span>.
          </p>
        </section>

        <section class="flex flex-col gap-2">
          <h3 class="font-body text-gold text-[0.72rem] tracking-[0.2em] uppercase">
            Guests sheet
          </h3>
          <p class="text-text-muted">
            One row per guest. Start with these <strong class="text-text">required</strong> columns:
          </p>
          <ul class="text-text-muted flex flex-wrap gap-x-2 gap-y-1.5">
            <For each={GUEST_TEMPLATE_FIXED_HEADERS}>
              {(h) => (
                <li>
                  <Col>{h}</Col>
                </li>
              )}
            </For>
          </ul>
          <p class="text-text-muted">
            Then add <strong class="text-text">one extra column per event</strong>, and name each
            column <em>exactly</em> after an event from your events sheet (e.g. <Col>Ceremony</Col>,{" "}
            <Col>Reception</Col>). In each event column, mark the guests you're inviting with a
            truthy value — <span class="text-text">true</span>, <span class="text-text">yes</span>,{" "}
            <span class="text-text">1</span>, or <span class="text-text">x</span>. Leave the cell
            blank for guests who aren't invited to that event.
          </p>
          <p class="text-text-muted">
            Guests that share the same <Col>Family ID</Col> are grouped into one household — give
            everyone in a family the same id so they claim and RSVP together.
          </p>
        </section>

        <p class="text-text-muted text-[0.8rem]">
          Not sure where to start? Use <span class="text-gold-dim">Download events template</span>{" "}
          and <span class="text-gold-dim">Download guests template</span> above — each comes with
          the correct headers and a couple of example rows. In the guests template, rename the{" "}
          <Col>{GUEST_TEMPLATE_EXAMPLE_EVENTS[0]}</Col> /{" "}
          <Col>{GUEST_TEMPLATE_EXAMPLE_EVENTS[1]}</Col> columns to your real event names.
        </p>
      </div>
    </details>
  );
}
