import { LEGAL_ENTITY, LEGAL_DETAILS_PENDING } from "@shared/legal";
import type { JSX } from "solid-js";

/**
 * Pulse's own privacy notice, at `/privacy`.
 *
 * `@pulse/landing`'s notice says using the app "is governed by the OSN privacy
 * notice shown when you sign in" — true of your account, and not true of the
 * things Pulse holds that OSN never sees: which events you RSVP'd to, where
 * they were, and which platform you found them through. Those are described
 * here, and the account underneath is described in the OSN notice this page
 * links to.
 *
 * Claims below come from `wiki/compliance/data-map.md` § Pulse, which lists the
 * lawful basis and retention per field.
 */
export default function PrivacyRoute(): JSX.Element {
  return (
    <article class="mx-auto w-full max-w-2xl px-6 py-12 leading-relaxed">
      {LEGAL_DETAILS_PENDING && (
        <p class="mb-8 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <strong>Draft</strong> — this notice is not final. Some details of the operator are still
          to be confirmed, and this banner disappears once they are.
        </p>
      )}
      <h1 class="mb-1 text-2xl font-semibold">Privacy Notice</h1>
      <p class="text-muted-foreground mb-8 text-sm">Last updated: 2026-08-20</p>

      <p>
        This notice covers Pulse — events, RSVPs and venues. The account you sign in with belongs to
        OSN, and{" "}
        <a class="underline" href="https://musubi.social/privacy">
          its own notice
        </a>{" "}
        covers your email, passkeys, profiles and connections. Both are published by{" "}
        <span class={LEGAL_DETAILS_PENDING ? "underline decoration-dotted" : undefined}>
          {LEGAL_ENTITY.name}
        </span>
        .
      </p>

      <h2>What Pulse holds</h2>
      <h3>Events you create</h3>
      <p>
        Title, description, times, and a location — free text plus coordinates. Your profile is
        recorded as the host. You choose who can see the event and whether attendance is visible;
        that choice is yours to change.
      </p>
      <h3>Events you respond to</h3>
      <p>
        Whether you are going, interested, or not going. Who can see that depends on the host's
        visibility setting, not ours.
      </p>
      <h3>How you found an event</h3>
      <p>
        When you arrive at an event through a shared link, we record the <em>platform name</em> the
        link came from — Instagram, WhatsApp, a copied link, and so on — first time and most recent.
        It is a platform name and nothing else: no third-party identifier, no cookie, no cross-site
        token, and it is shown only to the organiser of that one event. You are not followed
        anywhere off Pulse. This rests on our legitimate interest in telling organisers where their
        audience came from; you can object, and we will remove it.
      </p>
      <h3>Venues and line-ups</h3>
      <p>
        Public venue listings — address, coordinates, website, social handle — and the billed names
        of performers. For a sole trader, a venue listing can identify a person; it is published
        because the business is publicly listed, and it is removed on request.
      </p>
      <h3>Close friends</h3>
      <p>
        A Pulse-only list, separate from your OSN connections, used to scope who sees what. Only
        Pulse sees it.
      </p>

      <h2>A note on what an RSVP can reveal</h2>
      <p>
        Some events say something about the people at them — a health event, a religious one, a
        political one, a Pride event. A host publishing such an event has chosen to; someone
        RSVP'ing to it has not made anything public about themselves.
      </p>
      <p>
        Today the control is the host's visibility setting, which we honour strictly, and your own
        choice of whether to respond at all. We do not yet ask you separately before recording an
        RSVP to an event of that kind, and we should — it is on our list. Until it exists: if you
        would rather not be listed, mark yourself interested rather than going, or ask us to remove
        the record and we will.
      </p>

      <h2>The legal bases</h2>
      <p>
        Creating and attending events is contract — you asked for the service (GDPR Art. 6(1)(b)).
        Share attribution and public venue listings rest on legitimate interest (Art. 6(1)(f)), and
        you can object to either. Attendance visibility and anything in the paragraph above rest on
        your explicit consent (Art. 6(1)(a)). Where an RSVP would reveal something protected about
        you, Art. 9(2)(a) is the basis we are building towards — see the note above for what stands
        in its place today.
      </p>

      <h2>Who else sees it</h2>
      <p>
        Behind the service, a small number of providers process data on our instructions: Cloudflare
        for hosting and databases, Upstash for rate-limit state (hashed), and Grafana Cloud for
        technical telemetry, which carries pseudonymised identifiers and no event content.
      </p>
      <p>Two third parties your browser contacts directly:</p>
      <ul class="my-4 list-disc space-y-2 pl-6">
        <li>
          <strong>OpenStreetMap</strong> — map tiles. Opening a page with a map sends your IP
          address to the OpenStreetMap Foundation's tile servers, because that is what fetching a
          tile is.
        </li>
        <li>
          <strong>Komoot (Photon)</strong> — address autocomplete. While you type an address into an
          event, what you have typed so far goes to Komoot's geocoder in Germany, with your IP. It
          fires as you type rather than when you submit, and it is not currently behind a consent
          gate. We are moving it behind our own server and a gate; until then it is stated here
          rather than left for you to find in a network log.
        </li>
      </ul>

      <h2>What we do not do</h2>
      <p>
        No advertising, no third-party trackers, no selling your information, and no following you
        around other sites.
      </p>

      <h2>Where it is stored, and for how long</h2>
      <p>
        In <strong>Australia</strong>. Events and their RSVPs are kept while the event is live and
        for 90 days after it ends, then removed; hosts can delete sooner. Host-to-attendee messages
        are logged for 90 days. If you are in the EEA or the UK, your information is transferred
        outside that area to Australia — ask us and we will tell you what protections apply.
      </p>

      <h2>Your rights</h2>
      <p>
        Access, correction, deletion, portability, objection to the two legitimate-interest uses
        above, and withdrawal of any consent you gave. Much of it is in the app; for the rest, email{" "}
        <a class="underline" href={`mailto:${LEGAL_ENTITY.contactEmail}`}>
          {LEGAL_ENTITY.contactEmail}
        </a>
        . We answer within a month. Complaints go to the {LEGAL_ENTITY.regulator}, or to your local
        data protection authority if you are in the EEA or the UK.
      </p>
    </article>
  );
}
