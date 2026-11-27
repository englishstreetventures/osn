import { LEGAL_ENTITY, draftPending, isPlaceholder } from "@shared/legal";
import { buttonVariants } from "@shared/ui/ui/button";
import type { JSX } from "solid-js";

import { LegalDocument } from "../components/LegalDocument";

/**
 * The identity service's own privacy notice, at `/privacy`.
 *
 * It exists because `@musubi/landing`'s notice says in as many words that it
 * "covers visitors to this site only" and that "the Musubi identity service and
 * each connected app publish their own, separate privacy notices" — and then
 * no such notice existed. The account, the passkeys, the social graph and the
 * OIDC connections all live here, and this is where they are described.
 *
 * Every claim below is taken from `wiki/compliance/data-map.md`, which lists
 * the lawful basis and retention per field. If a field changes there and not
 * here, the two have drifted and this page is the one that is wrong.
 */
export function PrivacyPage(): JSX.Element {
  const entity = () => (
    <span class={isPlaceholder(LEGAL_ENTITY.name) ? "underline decoration-dotted" : undefined}>
      {LEGAL_ENTITY.name}
    </span>
  );
  const email = () => (
    <a
      class={buttonVariants({ variant: "link", size: "inline" })}
      href={`mailto:${LEGAL_ENTITY.privacyEmail}`}
    >
      {LEGAL_ENTITY.privacyEmail}
    </a>
  );

  return (
    <LegalDocument
      title="Privacy Notice"
      updated="2026-11-27"
      draft={draftPending(LEGAL_ENTITY.regulator)}
    >
      <p>
        This notice covers your Musubi account — the identity you sign in with, the profiles you
        create under it, your connections, and the apps you have allowed to recognise you. It is
        published by {entity()}, who operates the service.
      </p>

      <h2>What we hold, and why</h2>
      <h3>Your account</h3>
      <p>
        An email address, which is how you sign in and where security notices and one-time codes go.
        One or more passkeys — we store the public key and a label you chose ("iPhone 15 Pro"),
        never a password and never anything that could be used to sign in as you elsewhere. We keep
        this because we cannot provide you an account without it.
      </p>
      <p>
        When you sign up we ask for your date of birth, to check you are 13 or older. We use it for
        that check only, and we do not store it.
      </p>
      <p>
        Some email providers, such as Gmail, can vouch for your address when you sign up in a
        browser that supports it, including some versions of Chrome, so you do not have to open a
        link we email you. To do that, your browser asks your email provider for a signed token,
        over your own connection, under your provider&rsquo;s terms. To check the token, we look up
        your address&rsquo;s domain — the part after the @ — through Cloudflare&rsquo;s public DNS
        resolver, and fetch your provider&rsquo;s public keys. On a personal domain the domain alone
        can identify you. We send neither of them the rest of your address or your IP address.
      </p>
      <h3>Your profiles</h3>
      <p>
        A handle, a display name and an avatar, per profile. These are public by design — they are
        how other people find and recognise you. An account can hold more than one profile, and the
        identifier a passkey is bound to is deliberately opaque so two of your profiles cannot be
        linked back to one account by anyone but us.
      </p>
      <h3>Your sessions</h3>
      <p>
        For each signed-in device: a coarse label ("Firefox on macOS") and when it was last used.
        Sessions expire 30 days after last use.
      </p>
      <h3>Your social graph</h3>
      <p>
        Connections between profiles, and blocks. Connections are shared with our other apps when
        they need them — Pulse to show which of your connections are attending an event, Zap to
        honour a block, Cire to offer co-host suggestions from your own accepted connections. Blocks
        are enforced everywhere.
      </p>
      <h3>Security records</h3>
      <p>
        An audit trail of security-relevant actions on your account — a passkey added or removed,
        recovery codes generated, an email change — kept 12 months, and visible to you. Each entry
        keeps a coarse label for the device and a <em>hash</em> of the IP address it came from,
        keyed with a secret so it cannot be turned back into an address. Recovery codes are stored
        only as hashes; the codes themselves are shown once, to you, and never again. Email-change
        attempts are logged for 90 days to enforce the two-changes-per-week cap.
      </p>
      <h3>Apps you have connected</h3>
      <p>
        When you use your Musubi account to sign in to another app, we record that you granted it —
        which app, which profile, what it may see, and when. That record <em>is</em> your consent,
        and withdrawing it in Settings under Connected apps stops the app receiving anything more
        and kills any authorisation still in flight. The row itself stays, marked withdrawn, as the
        record that you withdrew — and goes when your account does. The identifier each app receives
        for you is derived per-app, so two apps that compare notes cannot tell they are looking at
        the same person.
      </p>

      <h2>The legal bases</h2>
      <p>
        Most of the above is processed because we cannot give you the account you asked for without
        it — contract, in GDPR terms (Art. 6(1)(b)). The IP hash and device label on each security
        record, the passkey metadata and the session timestamps rest on our legitimate interest in
        detecting abuse and showing you which passkeys you hold (Art. 6(1)(f)). The security audit
        trail is partly a legal obligation (Art. 6(1)(c), read with Art. 32). Connecting another app
        to your account is consent (Art. 6(1)(a)), and consent you can withdraw.
      </p>

      <h2>What we do not do</h2>
      <p>
        We do not sell your information, run advertising, or profile you for it. There is no
        third-party analytics on this app. We do not store your passwords, because there are none.
      </p>

      <h2>Who else sees it</h2>
      <p>
        Other people see what you make public: your handle, display name and avatar, and whatever a
        given app shows about you within it. Behind the service, a small number of providers process
        data on our instructions — Cloudflare for hosting, databases, and rate-limit and session
        state, Resend for outbound email, and Grafana Cloud for technical telemetry. Beyond that,
        only where the law requires it.
      </p>

      <h2>Where it is stored</h2>
      <p>
        In <strong>Oceania</strong>. The databases are hosted by Cloudflare in its Oceania region.
        Cloudflare keeps the short-lived state behind sign-in and rate limiting there too where it
        can, and counts per-minute rate limits wherever in its network a request arrives. The
        service is operated from Australia, and some technical records are processed by providers
        elsewhere. If you are in the EEA or the UK, this means your information is transferred
        outside that area. Ask us and we will tell you what protections apply.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Account and profile data while the account is live. When you delete your account, we keep it
        for 7 days in case you change your mind, then delete it, usually within a day of the date we
        show you. After that, no one can take your handles for 30 days: to hold them we keep a{" "}
        <em>hash</em> of each handle, keyed with a secret, not the handle itself. Each app deletes
        what it holds about you at the same time, except what other people still rely on — an
        upcoming event you host in Pulse can stay 14 days for its guests, and an encrypted message
        you sent to a chat others are still in stays there without your name. A Cire wedding deleted
        with your account is hidden at once and erased once any payment or gift for it has settled.
        Sessions: 30 days from last use. Security events: 12 months, and email-change records: 90
        days, including after the account is deleted. Deleted data can stay in our database
        provider&rsquo;s restore copies for up to 30 days.
      </p>

      <h2>Your rights</h2>
      <p>
        You can ask for a copy of everything we hold about you, correct it, delete it, object to the
        processing that rests on legitimate interests, or withdraw a consent you gave. Some of it
        you can do yourself in Settings — download a copy of your data, disconnect an app, delete
        your account. Before an account is deleted, we show you what happens to each organisation
        you own and anything in another app that needs your answer, such as a Cire wedding you are
        the only owner of; until the 7 days are up, you can sign in and choose Keep my account. For
        anything else, email {email()}. We answer within a month.
      </p>
      <p>
        If you are unhappy with how we have handled it, you can complain to the{" "}
        {LEGAL_ENTITY.regulator}, or — in the EEA or the UK — to your local data protection
        authority.
      </p>

      <h2>Who can have an account</h2>
      <p>
        You must be 13 or older to have a Musubi account, or older where the law of your country
        sets a higher age. Sign-up checks the age of 13 only. If you think a child under 13 has an
        account, tell us at {email()}.
      </p>

      <h2>Changes</h2>
      <p>
        If this changes, the date at the top changes with it. If a change matters, we also email the
        address on your account before it takes effect, saying what changes and from what day.
      </p>
    </LegalDocument>
  );
}
