import { graphClient, orgClient, recommendationClient } from "./api";
import { connectionsClient } from "./authClients";
import { pageQuery } from "./page-cache";

// Every page read Musubi makes, on the one page cache (`page-cache.ts`). Each
// name is the page's, so its placeholder count is that page's last row count.
// This module holds the clients, so the entry chunk reaches it only through a
// dynamic import (`App.tsx`'s route preloads).

/** Connections → All. */
export const connectionsList = pageQuery(
  "connections.all",
  () => graphClient.listConnections(),
  (value) => value.connections.length,
);

/** Connections → Pending: requests waiting on this profile. */
export const pendingRequests = pageQuery(
  "connections.pending",
  () => graphClient.listPendingRequests(),
  (value) => value.pending.length,
);

/** Connections → Sent. */
export const sentRequests = pageQuery(
  "connections.sent",
  () => graphClient.listSentRequests(),
  (value) => value.sent.length,
);

/** Connections → Blocked. */
export const blockedProfiles = pageQuery(
  "connections.blocked",
  () => graphClient.listBlocks(),
  (value) => value.blocks.length,
);

/** Discover's suggestions. */
export const suggestions = pageQuery(
  "discover.suggestions",
  () => recommendationClient.suggestConnections({ limit: 20 }),
  (value) => value.suggestions.length,
);

/** The organisations this profile belongs to. */
export const myOrganisations = pageQuery(
  "organisations.mine",
  () => orgClient.listMyOrgs(),
  (value) => value.organisations.length,
);

/** One organisation, by handle. */
export const organisationDetail = pageQuery(
  "organisations.one",
  async (handle: string) => (await orgClient.getOrg(handle)).organisation,
  () => 1,
);

/** One organisation's roster, by handle; refused (403) to anyone not in it. */
export const organisationMembers = pageQuery(
  "organisations.members",
  (handle: string) => orgClient.listMembers(handle),
  (value) => value.members.length,
);

/** Settings → Connected apps. Its name is `SettingsPage`'s too, for the chunk's placeholder. */
export const connectedApps = pageQuery(
  "settings.apps",
  async () => (await connectionsClient.list()).connections,
  (value) => value.length,
);
