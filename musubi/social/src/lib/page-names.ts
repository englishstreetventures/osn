/**
 * The page cache's query names (`page-data.ts`). Each is its page's, so the
 * placeholder count it keeps is that page's. Its own module so the shell and
 * Settings can name a query without loading the clients behind it.
 */
export const PAGE_DATA = {
  connections: "connections.all",
  pendingRequests: "connections.pending",
  sentRequests: "connections.sent",
  blockedProfiles: "connections.blocked",
  suggestions: "discover.suggestions",
  myOrganisations: "organisations.mine",
  organisation: "organisations.one",
  organisationMembers: "organisations.members",
  connectedApps: "settings.apps",
} as const;
