import { OSN_ACCOUNT_URL } from "../lib/osn";

/**
 * Security section for the organiser portal. It used to render `@shared/ui`'s
 * `PasskeysView` and `RecoveryCodesView` in place, driven by an OSN access
 * token the portal held itself.
 *
 * Neither half of that still holds. A WebAuthn credential can only be used on
 * an origin same-site with its RP ID, and passkeys are now bound to
 * `musubi.social`, so `host.cireweddings.com` cannot run the ceremony. And
 * under the OIDC flow the portal never sees an OSN token at all — cire/api
 * exchanges the code and keeps a cire session cookie, so there is nothing to
 * authenticate a passkey-management call with.
 *
 * So this points at the account itself. The link opens musubi's settings on
 * the Security tab, where both views already live.
 */
export default function SecurityPanel() {
  const settingsUrl = `${OSN_ACCOUNT_URL}/settings#security`;

  return (
    <div class="flex flex-col gap-6">
      <div class="flex flex-col gap-1">
        <p class="font-body text-gold text-ui-xs tracking-ui-widest uppercase">Security</p>
        <h2 class="font-display text-ui-lg">Your devices &amp; passkeys</h2>
        <p class="font-body text-text-muted text-ui-base">
          Passkeys and recovery codes belong to your musubi account, not to Cire. Manage them there
          and the change applies everywhere you sign in with it.
        </p>
      </div>

      <a
        href={settingsUrl}
        target="_blank"
        rel="noreferrer"
        class="border-gold font-body text-gold hover:bg-gold hover:text-bg text-ui-sm tracking-ui-wider self-start rounded-sm border px-5 py-2.5 uppercase transition-colors duration-200"
      >
        Manage on musubi
      </a>

      <p class="font-body text-text-muted text-ui-sm">
        Opens musubi in a new tab. Signing out of Cire leaves your musubi account signed in.
      </p>
    </div>
  );
}
