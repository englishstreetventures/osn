import { LEGAL_ENTITY, LEGAL_DETAILS_PENDING } from "@shared/legal";
import type { JSX } from "solid-js";

import { LegalDocument } from "../components/LegalDocument";

/**
 * Terms for the identity service itself, at `/terms`.
 *
 * `@osn/landing`'s site terms say that "creating an OSN identity and using the
 * connected apps is governed by separate terms entered into when you sign up",
 * and that those site terms grant no right to the service. This is the separate
 * agreement that sentence points at.
 */
export function TermsPage(): JSX.Element {
  const entity = () => (
    <span class={LEGAL_DETAILS_PENDING ? "underline decoration-dotted" : undefined}>
      {LEGAL_ENTITY.name}
    </span>
  );

  return (
    <LegalDocument title="Terms of Service" updated="2026-08-20">
      <p>
        These terms govern your OSN account and the identity service run by {entity()} ("we", "us").
        Each app you use your account with may add its own terms; those cover that app, and these
        cover the account underneath it.
      </p>

      <h2>Your account</h2>
      <p>
        You sign in with a passkey. Keep the device and the passkey secure — anyone holding them can
        act as you, and we cannot tell the difference. Recovery codes exist for when you lose the
        device; store them somewhere other than the device. You are responsible for what happens
        under your account.
      </p>
      <p>
        You may hold more than one profile under one account. Impersonating someone else, or
        creating profiles to evade a block or a suspension, is not allowed.
      </p>

      <h2>Acceptable use</h2>
      <ul>
        <li>Nothing unlawful, and nothing that harasses, abuses or endangers another person.</li>
        <li>
          No attempt to disrupt the service, probe it, or reach it other than through the interfaces
          we provide.
        </li>
        <li>No scraping profiles or the social graph, whether by hand or by machine.</li>
        <li>No use of the service to send unsolicited bulk messages.</li>
      </ul>

      <h2>Connecting other apps</h2>
      <p>
        You can let another app recognise you through your OSN account. What it receives is shown to
        you before you agree, and you can withdraw it at any time in Settings under Connected apps.
        Once an app holds information about you, its own privacy notice governs what it does with it
        — we can stop it receiving more, not make it forget.
      </p>

      <h2>Your content</h2>
      <p>
        Your handle, display name, avatar and anything else you publish stays yours. You grant us
        only the licence needed to host and show it as part of running the service.
      </p>

      <h2>Ending it</h2>
      <p>
        You can delete your account at any time from Settings. We may suspend or close an account
        that seriously or repeatedly breaks these terms, and we will tell you why unless the law
        stops us. If we discontinue the service we will give reasonable notice and a way to take
        your data with you.
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
        Subject to those guarantees and to the extent permitted by law, our liability in connection
        with the service is limited to re-supplying it, and we are not liable for indirect or
        consequential loss. We provide the service with due care and skill, but we do not promise it
        will be uninterrupted or error-free.
      </p>

      <h2>Changes to these terms</h2>
      <p>
        We may update these terms. The date at the top changes when we do, anything material is
        flagged in the app before it takes effect, and changes are not retroactive.
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
    </LegalDocument>
  );
}
