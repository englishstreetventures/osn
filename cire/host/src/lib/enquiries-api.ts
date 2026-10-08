import { apiUrl, weddingPath } from "./api";
import type { EnquiryListItem, EnquiryMessage, EnquiryPage } from "./enquiries-store";

export type AuthFetch = (input: string, init?: RequestInit) => Promise<Response>;

const base = (weddingId: string) => weddingPath(weddingId, "/enquiries");

export class EnquiryApiError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
    this.name = "EnquiryApiError";
  }
}

async function ensureOk(res: Response): Promise<void> {
  if (res.ok) return;
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new EnquiryApiError(body?.error ?? `http_${res.status}`, res.status);
}

/**
 * One page of the inbox, newest first: page one without a cursor, the page
 * after it with the `nextCursor` it returned. An API that predates paging
 * sends no `nextCursor`, which reads as the last page.
 */
export async function fetchEnquiries(
  authFetch: AuthFetch,
  weddingId: string,
  cursor?: string,
): Promise<EnquiryPage> {
  const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  const res = await authFetch(apiUrl(`${base(weddingId)}${query}`));
  await ensureOk(res);
  const body = (await res.json()) as { enquiries?: EnquiryListItem[]; nextCursor?: unknown };
  return {
    enquiries: body.enquiries ?? [],
    nextCursor: typeof body.nextCursor === "string" ? body.nextCursor : null,
  };
}

export async function fetchMessages(
  authFetch: AuthFetch,
  weddingId: string,
  enquiryId: string,
): Promise<EnquiryMessage[]> {
  const res = await authFetch(
    apiUrl(`${base(weddingId)}/${encodeURIComponent(enquiryId)}/messages`),
  );
  await ensureOk(res);
  const body = (await res.json()) as { messages: EnquiryMessage[] };
  return body.messages ?? [];
}

export async function openEnquiry(
  authFetch: AuthFetch,
  weddingId: string,
  input: {
    directoryVendorId: string;
    category: string;
    message: string;
    vendorName: string;
  },
): Promise<EnquiryListItem> {
  const res = await authFetch(apiUrl(base(weddingId)), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      directoryVendorId: input.directoryVendorId,
      category: input.category,
      message: input.message,
    }),
  });
  await ensureOk(res);
  const body = (await res.json()) as {
    enquiry: Omit<EnquiryListItem, "vendorName" | "category">;
  };
  return { ...body.enquiry, vendorName: input.vendorName, category: input.category };
}

export async function replyEnquiry(
  authFetch: AuthFetch,
  weddingId: string,
  enquiryId: string,
  message: string,
): Promise<EnquiryMessage> {
  const res = await authFetch(
    apiUrl(`${base(weddingId)}/${encodeURIComponent(enquiryId)}/messages`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    },
  );
  await ensureOk(res);
  const body = (await res.json()) as { message: EnquiryMessage };
  return body.message;
}

export async function addEnquiryToBudget(
  authFetch: AuthFetch,
  weddingId: string,
  enquiryId: string,
): Promise<{ budgetItemId: string }> {
  const res = await authFetch(
    apiUrl(`${base(weddingId)}/${encodeURIComponent(enquiryId)}/add-to-budget`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
  );
  await ensureOk(res);
  return (await res.json()) as { budgetItemId: string };
}

export function enquiryErrorMessage(err: unknown): string {
  const code = err instanceof EnquiryApiError ? err.code : "";
  if (code === "awaiting_vendor")
    return "This vendor hasn't joined yet — they'll get your first message when they claim their listing.";
  if (code === "vendor_chat_unavailable")
    return "Messaging is temporarily unavailable. Please try again shortly.";
  if (code === "read_only_role") return "You have view-only access to this wedding.";
  return "Something went wrong. Please try again.";
}
