/**
 * `GET /oidc/connections` answers each connected app's "manage your data"
 * link only while it passes the read rule (`services/auth/client-links.ts`):
 * a stored value that fails it is `null`, never sent, so Musubi's Connected
 * apps never shows it. The rule's refusals are the point of this file; each
 * row below is one way a stored link can be wrong, and the two answered rows
 * show the rule is not "always null".
 *
 * The values are written straight into `oauth_clients`, as the seeds and the
 * owner's production statement write them: no route takes the column.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayerWithSqlite } from "../helpers/db";
// Wrapped factory (trust XFF under app.handle). See helpers/routes.
import { registeredResponse } from "../helpers/registration";
import { createAuthRoutes } from "../helpers/routes";

/** The origin osn-api's deployment pins to `cid_portal`, as `CIRE_ORGANISER_ORIGIN` pins cire's. */
const PORTAL = "https://portal.example.com";

interface Case {
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  readonly link: string | null;
  readonly disabled?: boolean;
  /** No `oauth_clients` row at all: the consent outlived its client. */
  readonly noClientRow?: boolean;
}

const RP = "https://rp.example.com/callback";

/** Each refused row: why it is refused, and the row. */
const REFUSED: readonly (readonly [string, Case])[] = [
  [
    "a link on an origin no redirect URI has",
    { clientId: "cid_other_origin", redirectUris: [RP], link: "https://evil.example.net/leave" },
  ],
  [
    "a link on the pinned app origin, from a client the pin does not name",
    {
      clientId: "cid_not_pinned",
      redirectUris: ["https://api.example.com/callback"],
      link: `${PORTAL}/#/remove-data`,
    },
  ],
  [
    "an http: link on a public host, even beside an http: redirect URI there",
    {
      clientId: "cid_http_public",
      redirectUris: ["http://rp.example.com/callback"],
      link: "http://rp.example.com/leave",
    },
  ],
  [
    "a link on the redirect URI's host at another port",
    { clientId: "cid_port", redirectUris: [RP], link: "https://rp.example.com:8443/leave" },
  ],
  [
    "a link on the redirect URI's host with a trailing dot",
    { clientId: "cid_trailing_dot", redirectUris: [RP], link: "https://rp.example.com./leave" },
  ],
  [
    "a link carrying a user name and password",
    { clientId: "cid_userinfo", redirectUris: [RP], link: "https://user:pw@rp.example.com/leave" },
  ],
  [
    "a link whose user name spells the redirect URI's host",
    {
      clientId: "cid_userinfo_host",
      redirectUris: [RP],
      link: "https://rp.example.com@evil.example.net/leave",
    },
  ],
  [
    "a link not in its canonical form",
    { clientId: "cid_not_canonical", redirectUris: [RP], link: "HTTPS://RP.EXAMPLE.COM/leave" },
  ],
  [
    "a link with a backslash a browser reads as a slash",
    { clientId: "cid_backslash", redirectUris: [RP], link: "https:\\\\rp.example.com\\leave" },
  ],
  [
    "a link longer than 512 characters",
    {
      clientId: "cid_too_long",
      redirectUris: [RP],
      link: `https://rp.example.com/${"a".repeat(512)}`,
    },
  ],
  [
    "a javascript: link",
    { clientId: "cid_javascript", redirectUris: [RP], link: "javascript:alert(1)" },
  ],
  [
    "a blob: link whose origin is the redirect URI's",
    { clientId: "cid_blob", redirectUris: [RP], link: "blob:https://rp.example.com/leave" },
  ],
  [
    "a link that is no URL",
    { clientId: "cid_unparsable", redirectUris: [RP], link: "rp.example.com/leave" },
  ],
  [
    "a link of a disabled client",
    {
      clientId: "cid_disabled",
      redirectUris: [RP],
      link: "https://rp.example.com/leave",
      disabled: true,
    },
  ],
  [
    "a consent whose client row is gone",
    { clientId: "cid_gone", redirectUris: [RP], link: null, noClientRow: true },
  ],
  ["a client with no link", { clientId: "cid_none", redirectUris: [RP], link: null }],
];

/** Each answered row: why it is answered, the row, and the link it answers. */
const ANSWERED: readonly (readonly [string, Case])[] = [
  [
    "an https: link on a redirect URI's origin",
    {
      clientId: "cid_ok",
      redirectUris: ["https://other.example.com/cb", RP],
      link: "https://rp.example.com/settings/leave?from=musubi#remove",
    },
  ],
  [
    "a link on the app origin osn-api's deployment pins to the client",
    {
      clientId: "cid_portal",
      redirectUris: ["https://api.example.com/callback"],
      link: `${PORTAL}/#/remove-data`,
    },
  ],
  [
    "an http: link on a loopback redirect URI's origin",
    {
      clientId: "cid_loopback",
      redirectUris: ["http://localhost:8787/callback"],
      link: "http://localhost:8787/leave",
    },
  ],
];

interface Connection {
  readonly clientId: string;
  readonly clientName: string | null;
  readonly manageDataUrl: string | null;
}

let connections: ReadonlyMap<string, Connection>;

beforeAll(async () => {
  const config = await makeTestAuthConfig();
  const { layer, sqlite, email } = createTestLayerWithSqlite();
  const app = createAuthRoutes(
    { ...config, clientAppOrigins: new Map([["cid_portal", PORTAL]]) },
    layer,
  );
  const res = await registeredResponse(app, () => email.recorded(), "leaver@example.com", "leaver");
  const { session } = (await res.json()) as { session: { access_token: string } };
  const profile = sqlite
    .query<{ id: string; account_id: string }, [string]>(
      "SELECT id, account_id FROM users WHERE handle = ?",
    )
    .get("leaver");
  if (!profile) throw new Error("no profile");

  for (const [, c] of [...REFUSED, ...ANSWERED]) {
    if (!c.noClientRow) {
      sqlite.run(
        `INSERT INTO oauth_clients
           (id, client_id, name, logo_url, redirect_uris, client_secret_hash, sector_identifier,
            allowed_scopes, is_first_party, owner_account_id, created_at, disabled_at, manage_data_url)
         VALUES (?, ?, ?, NULL, ?, NULL, ?, 'openid profile', 0, NULL, 1000, ?, ?)`,
        [
          `oc_${c.clientId}`,
          c.clientId,
          `App ${c.clientId}`,
          JSON.stringify(c.redirectUris),
          c.clientId,
          c.disabled ? 2000 : null,
          c.link,
        ],
      );
    }
    sqlite.run(
      `INSERT INTO oauth_consents (id, account_id, client_id, profile_id, scope, granted_at, revoked_at)
       VALUES (?, ?, ?, ?, 'openid profile', 1000, NULL)`,
      [`ocs_${c.clientId}`, profile.account_id, c.clientId, profile.id],
    );
  }

  const list = await app.handle(
    new Request("http://localhost/oidc/connections", {
      headers: { authorization: `Bearer ${session.access_token}` },
    }),
  );
  if (list.status !== 200) throw new Error(`GET /oidc/connections answered ${list.status}`);
  const body = (await list.json()) as { connections: Connection[] };
  connections = new Map(body.connections.map((c) => [c.clientId, c]));
});

describe("GET /oidc/connections: an app's manage-your-data link", () => {
  it("lists every connection, so each row below is read", () => {
    expect(connections.size).toBe(REFUSED.length + ANSWERED.length);
  });

  it.each(REFUSED)("answers null for %s", (_why, c) => {
    expect(connections.get(c.clientId)?.manageDataUrl).toBeNull();
  });

  it.each(ANSWERED)("answers %s", (_why, c) => {
    expect(connections.get(c.clientId)?.manageDataUrl).toBe(c.link);
  });

  it("names no app for a consent whose client row is gone", () => {
    expect(connections.get("cid_gone")?.clientName).toBeNull();
  });
});
