import { LEGAL_ENTITY, draftPending, isPlaceholder } from "@shared/legal";
import type { JSX } from "solid-js";

import { LegalDocument } from "../components/LegalDocument";

/**
 * The identity service's own privacy notice, at `/privacy`.
 *
 * It exists because `@osn/landing`'s notice says in as many words that it
 * "covers visitors to this site only" and that "the OSN identity service and
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
    <a class="underline" href={`mailto:${LEGAL_ENTITY.contactEmail}`}>
      {LEGAL_ENTITY.contactEmail}
    </a>
  );

  return (
    <LegalDocument
      title="Privacy Notice"
      updated="2026-08-20"
      draft={draftPending(LEGAL_ENTITY.regulator)}
    >
      <p>
        This notice covers your OSN account — the identity you sign in with, the profiles you create
        under it, your connections, and the apps you have allowed to recognise you. It is published
        by {entity()}, who operates the service.
      </p>

      <h2>What we hold, and why</h2>
      <h3>Your account</h3>
      <p>
        An email address, which is how you sign in and where security notices and one-time codes go.
        One or more passkeys — we store the public key and a label you chose ("iPhone 15 Pro"),
        never a password and never anything that could be used to sign in as you elsewhere. We keep
        this because we cannot provide you an account without it.
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
        For each signed-in device: a coarse label ("Firefox on macOS"), when it was last used, and a{" "}
        <em>hash</em> of the IP address — keyed with a secret, so it can be compared against itself
        for anomaly detection but not turned back into an address. Sessions expire 30 days after
        last use. You can see and revoke every one of them in Settings.
      </p>
      <h3>Your social graph</h3>
      <p>
        Connections between profiles, and blocks. Connections are shared with other OSN apps when
        they need them — Pulse to show which of your connections are attending an event, Zap to
        honour a block, Cire to offer co-host suggestions from your own accepted connections. Blocks
        are enforced everywhere.
      </p>
      <h3>Security records</h3>
      <p>
        An audit trail of security-relevant actions on your account — a passkey added or removed,
        recovery codes generated, an email change — kept 12 months, and visible to you. Recovery
        codes are stored only as hashes; the codes themselves are shown once, to you, and never
        again. Email-change attempts are logged for 90 days to enforce the two-changes-per-week cap.
      </p>
      <h3>Apps you have connected</h3>
      <p>
        When you use your OSN account to sign in to another app, we record that you granted it —
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
        it — contract, in GDPR terms (Art. 6(1)(b)). The IP hash, the passkey metadata and the
        session timestamps rest on our legitimate interest in detecting abuse and showing you a
        useful device list (Art. 6(1)(f)). The security audit trail is partly a legal obligation
        (Art. 6(1)(c), read with Art. 32). Connecting another app to your account is consent (Art.
        6(1)(a)), and consent you can withdraw.
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
        data on our instructions — Cloudflare for hosting and databases, Resend for outbound email,
        Upstash for rate-limit and session state (all of it hashed or pseudonymised), and Grafana
        Cloud for technical telemetry. Beyond that, only where the law requires it.
      </p>

      <h2>Where it is stored</h2>
      <p>
        In <strong>Australia</strong>. The databases and the supporting infrastructure are hosted in
        Sydney and the service is operated from there; some technical records are processed by
        providers elsewhere. If you are in the EEA or the UK, this means your information is
        transferred outside that area. Ask us and we will tell you what protections apply.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Account and profile data while the account is live. Deleting an account leaves a tombstone
        for 30 days, which stops your handle being taken by someone else in the meantime, and is
        then purged. Sessions: 30 days from last use. Security events: 12 months. Email-change
        records: 90 days.
      </p>

      <h2>Your rights</h2>
      <p>
        You can ask for a copy of everything we hold about you, correct it, delete it, object to the
        processing that rests on legitimate interests, or withdraw a consent you gave. Much of it
        you can do yourself in Settings — revoke a session, disconnect an app, change your email,
        delete your account. For anything else, email {email()}. We answer within a month.
      </p>
      <p>
        If you are unhappy with how we have handled it, you can complain to the{" "}
        {LEGAL_ENTITY.regulator}, or — in the EEA or the UK — to your local data protection
        authority.
      </p>

      <h2>Changes</h2>
      <p>
        If this changes, the date at the top changes with it, and anything material is flagged in
        the app before it takes effect.
      </p>
    </LegalDocument>
  );
}
