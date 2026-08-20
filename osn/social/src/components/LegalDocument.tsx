import { LEGAL_DETAILS_PENDING } from "@shared/legal";
import type { JSX } from "solid-js";

/**
 * Shell for the two legal routes. They are the only pages in this app that are
 * long-form prose rather than UI, so they own their own measure and rhythm
 * instead of inheriting the app shell's density.
 *
 * These routes are deliberately reachable without signing in: a privacy notice
 * a person can only read once they have already handed over their data is not
 * a notice. The router serves them to anyone with the URL.
 */
export function LegalDocument(props: {
  title: string;
  updated: string;
  children?: JSX.Element;
}): JSX.Element {
  return (
    <article class="prose-legal mx-auto w-full max-w-2xl px-6 py-12">
      {LEGAL_DETAILS_PENDING && (
        <p class="mb-8 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <strong>Draft</strong> — this notice is not final. Some details of the operator are still
          to be confirmed, and this banner disappears once they are.
        </p>
      )}
      <h1 class="mb-1 text-2xl font-semibold">{props.title}</h1>
      <p class="text-muted-foreground mb-8 text-sm">Last updated: {props.updated}</p>
      {props.children}
    </article>
  );
}
