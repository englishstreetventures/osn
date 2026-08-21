import { LEGAL_ENTITY, draftPending, isPlaceholder } from "@shared/legal";
import type { JSX } from "solid-js";

/**
 * Pulse's own terms, at `/terms`. The account underneath is governed by the OSN
 * terms; these cover what you do with it here — hosting events, RSVP'ing, and
 * what you may put in an event listing.
 */
export default function TermsRoute(): JSX.Element {
  return (
    <article class="mx-auto w-full max-w-2xl px-6 py-12 leading-relaxed">
      {draftPending(LEGAL_ENTITY.governingLaw) && (
        <p class="mb-8 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <strong>Draft</strong> — this notice is not final. Some details of the operator are still
          to be confirmed, and this banner disappears once they are.
        </p>
      )}
      <h1 class="mb-1 text-2xl font-semibold">Terms of Service</h1>
      <p class="text-muted-foreground mb-8 text-sm">Last updated: 2026-08-20</p>

      <p>
        These terms cover Pulse, operated by{" "}
        <span class={isPlaceholder(LEGAL_ENTITY.name) ? "underline decoration-dotted" : undefined}>
          {LEGAL_ENTITY.name}
        </span>
        . Your account itself is governed by the{" "}
        <a class="underline" href="https://musubi.social/terms">
          OSN terms
        </a>
        , which you accepted when you created it.
      </p>

      <h2>Hosting an event</h2>
      <p>
        You are responsible for what you publish — the description, the imagery, the venue, the
        line-up, and for having the right to use all of it. Don't list an event you have no part in
        organising, and don't name a venue or a performer who has not agreed to appear.
      </p>
      <p>
        You are also responsible for the event itself. Pulse lists events; it does not run them, vet
        them, or stand behind them.
      </p>

      <h2>Attending an event</h2>
      <p>
        An RSVP is a signal to the host, not a ticket or a contract with us. What the host can see
        about your response depends on the visibility they set, which is shown to you before you
        respond.
      </p>

      <h2>Acceptable use</h2>
      <ul>
        <li>
          Nothing unlawful, and nothing that harasses, endangers or discriminates against anyone.
        </li>
        <li>No events that exist to mislead — fake listings, fake venues, fake line-ups.</li>
        <li>No scraping events, attendees or venues, by hand or by machine.</li>
        <li>
          No attempt to disrupt the service or reach it other than through the interfaces we
          provide.
        </li>
      </ul>

      <h2>Your content</h2>
      <p>
        Event listings stay yours. You grant us the licence needed to host and display them —
        including in discovery, in search, and on a public event page if you made the event public.
      </p>

      <h2>Moderation</h2>
      <p>
        We may remove an event or suspend an account that breaks these terms, and we will say why
        unless the law stops us. If you think we got it wrong, reply and tell us.
      </p>

      <h2>Your rights as a consumer</h2>
      <p>
        Our services come with guarantees that cannot be excluded under the Australian Consumer Law.
        Nothing here excludes, restricts or modifies any consumer guarantee, right or remedy you
        have under that law or any other law that cannot lawfully be excluded. If you are reading
        this elsewhere in the world, you keep the consumer protections of the place you live.
      </p>

      <h2>Liability</h2>
      <p>
        Subject to those guarantees and to the extent permitted by law, our liability is limited to
        re-supplying the service, and we are not liable for indirect or consequential loss —
        including anything that happens at an event you found here.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms. The date at the top changes when we do, and changes are not
        retroactive.
      </p>

      <h2>Governing law</h2>
      <p>
        These terms are governed by the laws of <strong>{LEGAL_ENTITY.governingLaw}</strong>. This
        does not take away the protections you have under the consumer laws of the place where you
        live.
      </p>

      <h2>Contact</h2>
      <p>
        <a class="underline" href={`mailto:${LEGAL_ENTITY.contactEmail}`}>
          {LEGAL_ENTITY.contactEmail}
        </a>
      </p>
    </article>
  );
}
