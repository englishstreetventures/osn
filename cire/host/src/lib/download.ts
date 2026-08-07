/**
 * Trigger a client-side download of a Blob as `filename`.
 *
 * Extracted from `ImportPanel.tsx` so both the import-template buttons (which
 * pass a code-authored CSV string) and the RSVP export button (which passes the
 * server's `text/csv` response Blob) share one implementation. The object URL is
 * revoked after the click so it can't leak.
 *
 * SAFETY: when the content is a code-authored string (import templates) there is
 * no formula-injection surface. The RSVP export is built + formula-sanitised
 * server-side (`cire/api/src/services/rsvp-export.ts` → `sanitiseCsvCell`), so by
 * the time bytes reach here they are already safe; this helper only handles the
 * browser download mechanics.
 */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Download a code-authored CSV string (used by the import-template buttons). */
export function downloadCsv(filename: string, content: string): void {
  downloadBlob(filename, new Blob([content], { type: "text/csv;charset=utf-8" }));
}
