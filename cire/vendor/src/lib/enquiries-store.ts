// Data layer for vendor-side enquiries. Pure async helpers over `authFetch`
// (from useAuth()) — no module-level state. Mirrors vendor-store.ts idioms:
// local ensureOk + safeJson, apiUrl from ./api, functions take authFetch first.
import { apiUrl, friendlyError } from "./api";

type AuthFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface VendorEnquiryListItem {
  id: string;
  weddingId: string;
  directoryVendorId: string;
  vendorId: string;
  zapChatId: string | null;
  status: "open" | "quoted" | "closed";
  createdBy: string;
  quotedMinor: number | null;
  lastMessageAt: number;
  createdAt: number;
  updatedAt: number;
  // Joined fields (added by API, Task 1)
  vendorName: string;
  category: string;
  weddingName: string;
}

export interface VendorEnquiryMessage {
  id: string;
  senderProfileId: string;
  body: string;
  createdAt: number;
}

/** Read the response as JSON, or null if the body isn't JSON. */
async function safeJson<T>(res: Response): Promise<(T & { error?: string }) | null> {
  try {
    return (await res.json()) as T & { error?: string };
  } catch {
    return null;
  }
}

/** Throw a trimmed server error message on non-2xx. */
async function ensureOk(res: Response): Promise<void> {
  if (res.ok) return;
  const body = await safeJson<{ error?: string }>(res);
  const msg =
    typeof body?.error === "string" && body.error.length > 0
      ? body.error
      : `Request failed: ${res.status}`;
  throw new Error(msg.length > 200 ? `${msg.slice(0, 200)}…` : msg);
}

export async function listEnquiries(authFetch: AuthFetch): Promise<VendorEnquiryListItem[]> {
  const res = await authFetch(apiUrl("/api/vendor/enquiries"));
  await ensureOk(res);
  const body = await safeJson<{ enquiries: VendorEnquiryListItem[] }>(res);
  return body?.enquiries ?? [];
}

export async function getEnquiryMessages(
  authFetch: AuthFetch,
  id: string,
): Promise<VendorEnquiryMessage[]> {
  const res = await authFetch(apiUrl(`/api/vendor/enquiries/${encodeURIComponent(id)}/messages`));
  await ensureOk(res);
  const body = await safeJson<{ messages: VendorEnquiryMessage[] }>(res);
  return body?.messages ?? [];
}

export async function replyToEnquiry(
  authFetch: AuthFetch,
  id: string,
  message: string,
): Promise<VendorEnquiryMessage> {
  const res = await authFetch(apiUrl(`/api/vendor/enquiries/${encodeURIComponent(id)}/messages`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  await ensureOk(res);
  const body = await safeJson<{ message: VendorEnquiryMessage }>(res);
  if (!body?.message) throw new Error("Invalid response replying to enquiry");
  return body.message;
}

export async function submitQuote(
  authFetch: AuthFetch,
  id: string,
  amountMinor: number,
  note?: string,
): Promise<VendorEnquiryListItem> {
  const res = await authFetch(apiUrl(`/api/vendor/enquiries/${encodeURIComponent(id)}/quote`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(note !== undefined ? { amountMinor, note } : { amountMinor }),
  });
  await ensureOk(res);
  const body = await safeJson<{ enquiry: VendorEnquiryListItem }>(res);
  if (!body?.enquiry) throw new Error("Invalid response submitting quote");
  return body.enquiry;
}

/** Friendly error codes specific to enquiries, with fallback to the shared friendlyError. */
const ENQUIRY_FRIENDLY: Record<string, string> = {
  enquiry_closed: "This enquiry is closed and can no longer receive messages.",
  enquiry_not_found: "This enquiry could not be found.",
  quote_already_submitted: "A quote has already been submitted for this enquiry.",
};

export function friendlyEnquiryError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return ENQUIRY_FRIENDLY[msg] ?? friendlyError(err);
}
