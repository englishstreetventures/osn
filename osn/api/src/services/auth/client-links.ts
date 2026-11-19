/**
 * The addresses a relying party's registration holds, and the rule a stored
 * "manage your data" link must pass before anyone sees it.
 *
 * The link (`oauth_clients.manage_data_url`) is where a person removes their
 * data from one app; Musubi's Connected apps shows it as "Remove my data from
 * <name>". Only an operator writes it: the musubi stack's dev seed, the E2E
 * seed, or the owner's statement in production. No route takes it. The rule
 * below is checked on every read, so a value that fails it is absent, never
 * shown, whoever wrote it.
 *
 * See [[wiki/osn/oidc-provider]].
 */

import type { AppStepUpReturnConfig } from "./app-step-up";
import { OIDC_CLIENT_URI_MAX_LENGTH } from "./constants";

/**
 * Whether a relying party's address may use `url`'s scheme: `https:`, or
 * `http:` to this machine for local development. The one rule for redirect
 * URIs at registration and for a stored manage-your-data link.
 */
export function isClientUrlScheme(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

/** Why a stored link is not answered. A metric attribute: every value is listed here. */
export type ManageDataRefusal =
  | "too_long"
  | "unparsable"
  | "not_canonical"
  | "credentials"
  | "scheme"
  | "origin";

/** A client's link as the connections list reads it. */
export interface ManageDataRow {
  readonly manageDataUrl: string | null;
  /** Null when the consent's client row is gone. */
  readonly redirectUris: readonly string[] | null;
  readonly disabledAt: number | null;
}

/**
 * The link to answer for a client, why a stored one is refused, or `null`
 * when there is nothing to answer: no link, a disabled client, or a consent
 * whose client row is gone.
 *
 * A stored link is answered only when it is at most 512 characters; parses;
 * is exactly its own serialisation (`href`), so the string sent is the string
 * checked and no spelling the parser would rewrite — case, a backslash,
 * whitespace, a default port, a Unicode host — gets through; carries no user
 * name or password; passes {@link isClientUrlScheme}; and has the origin of
 * one of the client's redirect URIs or `appOrigin`, the origin osn-api's own
 * deployment pins to this client. The scheme is checked before the origin,
 * since a `blob:` URL reports the origin of the URL inside it. The rule bounds
 * the origin and not the path: the operator who writes the link is trusted
 * for the page on that origin.
 */
export function manageDataLink(
  row: ManageDataRow,
  appOrigin: string | undefined,
): { readonly url: string } | { readonly refused: ManageDataRefusal } | null {
  const raw = row.manageDataUrl;
  if (raw === null || row.disabledAt !== null || row.redirectUris === null) return null;
  if (raw.length > OIDC_CLIENT_URI_MAX_LENGTH) return { refused: "too_long" };
  if (!URL.canParse(raw)) return { refused: "unparsable" };
  const url = new URL(raw);
  if (url.href !== raw) return { refused: "not_canonical" };
  if (url.username !== "" || url.password !== "") return { refused: "credentials" };
  if (!isClientUrlScheme(url)) return { refused: "scheme" };
  const registered = row.redirectUris.some(
    (uri) => URL.canParse(uri) && new URL(uri).origin === url.origin,
  );
  return registered || url.origin === appOrigin ? { url: raw } : { refused: "origin" };
}

/**
 * The app origin osn-api's deployment pins to each client id. Today one:
 * cire's organiser portal (`CIRE_ORGANISER_ORIGIN`, already the one place a
 * cire step-up request may return to, `appStepUpReturnConfig`) for cire's
 * client (`CIRE_OIDC_CLIENT_ID`). Either unset leaves the map empty, and a
 * link must then sit on a redirect URI's origin.
 */
export function clientAppOrigins(
  cireClientId: string | undefined,
  stepUpReturn: AppStepUpReturnConfig,
): ReadonlyMap<string, string> {
  const portal = stepUpReturn.origins.cire_app_delete;
  const clientId = cireClientId?.trim();
  return clientId && portal ? new Map([[clientId, portal]]) : new Map();
}
