import type { RpSession } from "@shared/rp-auth";

import type { OrgSummary, Listing } from "../../src/lib/vendor-store";

/**
 * A signed-in vendor's dashboard, as cire-api would answer it: one account,
 * the organisations it belongs to, and the listing one of them publishes.
 * `dashboardFetch` stands in for `authFetch`, answering the three paths the
 * dashboard reads by their real shapes, so the stores parse them as they
 * would in the portal.
 */

export const SESSION: RpSession = {
  osnProfileId: "usr_rosewood",
  email: "hello@rosewood.test",
  handle: "rosewood",
  displayName: "Rosewood Events",
  avatarUrl: null,
  expiresAt: "2099-01-01T00:00:00.000Z",
};

export const ORGS: OrgSummary[] = [
  {
    id: "org_rosewood",
    handle: "rosewood-barn",
    name: "Rosewood Barn",
    description: null,
    avatarUrl: null,
    ownerId: "usr_rosewood",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "org_hunter",
    handle: "hunter-florals",
    name: "Hunter Florals",
    description: null,
    avatarUrl: null,
    ownerId: "usr_rosewood",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

export const LISTING: Listing = {
  id: "dv_rosewood",
  ownerOrgId: "org_rosewood",
  name: "Rosewood Barn",
  description: "A restored 1890s barn among the vines, for up to 160 guests.",
  email: "hello@rosewood.test",
  phone: "0400 000 000",
  website: "https://rosewood.test",
  instagram: "rosewoodbarn",
  locationText: "Pokolbin, Hunter Valley",
  priceBand: "$$$",
  priceMinMinor: null,
  priceMaxMinor: null,
  listed: "live",
  categories: ["venue", "catering"],
  createdAt: 1,
  updatedAt: 2,
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

export async function dashboardFetch(input: RequestInfo | URL): Promise<Response> {
  const { pathname } = new URL(String(input));
  if (pathname === "/api/vendor/orgs") return json({ organisations: ORGS });
  if (pathname === `/api/vendor/orgs/${ORGS[0]!.id}/listing`) return json({ listing: LISTING });
  if (pathname === "/api/vendor/enquiries") return json({ enquiries: [], nextCursor: null });
  return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
}

/** One open enquiry from a couple, as the vendor inbox lists it. */
export const ENQUIRY = {
  id: "enq_harbour",
  weddingId: "wed_harbour",
  directoryVendorId: "dv_rosewood",
  vendorId: ORGS[0]!.id,
  zapChatId: null,
  status: "open",
  createdBy: "usr_couple",
  quotedMinor: null,
  lastMessageAt: 3,
  createdAt: 1,
  updatedAt: 3,
  vendorName: ORGS[0]!.name,
  category: "venue",
  weddingName: "Harbour Wedding",
} as const;

/**
 * The same dashboard with one enquiry in the inbox and a message in its
 * thread, for the inbox row and the quote form. Its own stand-in, so the
 * dashboard's other pictures keep their empty inbox.
 */
export async function surfacesFetch(input: RequestInfo | URL): Promise<Response> {
  const { pathname } = new URL(String(input));
  if (pathname === "/api/vendor/enquiries") return json({ enquiries: [ENQUIRY], nextCursor: null });
  if (pathname === `/api/vendor/enquiries/${ENQUIRY.id}/messages`) {
    return json({
      messages: [
        {
          id: "msg_harbour",
          senderProfileId: "usr_couple",
          body: "Is the barn free on the first Saturday of March?",
          createdAt: 2,
        },
      ],
    });
  }
  return dashboardFetch(input);
}
