/**
 * Enquiry BFF service (Vendors S4) — the orchestration layer behind the couple's
 * vendor-enquiry threads. It ties three subsystems together per enquiry:
 *   - the wedding-scoped `vendors` CRM row (create-if-missing on open),
 *   - the Zap c2b chat (provisioned eagerly for a CLAIMED listing, deferred to
 *     claim time for an UNCLAIMED one — the first message buffers in
 *     `pendingBody` until then),
 *   - transactional email to the vendor / couple.
 *
 * INJECTED DEPS, NOT SINGLETONS. `createEnquiryService(deps)` takes its
 * `ZapChatClient | null`, an already-wrapped `sendEmail` (error channel `never`
 * — the route swallows `EmailError` so a broken transport never fails an
 * enquiry), and `threadBaseUrl`. Tests stub all three. The service NEVER imports
 * a module-level zap/email singleton.
 *
 * TWO LOCKED DECISIONS this file implements:
 *   1. Claimed → provision + send now; unclaimed → buffer `pendingBody`, null
 *      `zapChatId`.
 *   2. An operator-confirmed claim → each buffered enquiry is handed into Zap
 *      (`flushBufferedEnquiry`, run by the daily cron).
 *
 * open() is idempotent on `(weddingId, directoryVendorId)` via the
 * `vendor_enquiries_wedding_directory_uniq` index: a repeat returns the existing
 * enquiry with no re-provision and no second email.
 */

import { vendorEnquiries, vendors } from "@cire/db";
import { rowsChanged } from "@shared/db-utils";
import type { EmailTemplateData, SendEmailInput } from "@shared/email";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Data, Effect, type Types } from "effect";

import { commitBatch, DbService, dbQuery } from "../db";
import type { ServiceCategory } from "../lib/service-categories";
import { budgetService } from "./budget";
import type { DirectoryVendorRow } from "./directory";
import { vendorsService } from "./vendors";
import type { ZapChatClient } from "./zap-bridge";

// ---------------------------------------------------------------------------
// Tagged errors
// ---------------------------------------------------------------------------

/** No enquiry with this id (missing or another wedding's). 404-class. */
export class EnquiryNotFound extends Data.TaggedError("EnquiryNotFound") {}
/** Reply/quote attempted before the vendor claimed + the chat was provisioned. 409 `awaiting_vendor`. */
export class EnquiryAwaitingVendor extends Data.TaggedError("EnquiryAwaitingVendor") {}
/** `deps.zap` is null — the vendor-chat feature is disabled (missing/corrupt config). 503-class. */
export class ZapUnavailable extends Data.TaggedError("ZapUnavailable") {}

export type EnquiryError = EnquiryNotFound | EnquiryAwaitingVendor | ZapUnavailable;

// ---------------------------------------------------------------------------
// Row + DTO shapes
// ---------------------------------------------------------------------------

/** The `vendor_enquiries` row as Drizzle returns it (timestamps are `Date`). */
export interface EnquiryRow {
  id: string;
  weddingId: string;
  directoryVendorId: string;
  vendorId: string;
  zapChatId: string | null;
  pendingBody: string | null;
  /** Hand-off staging only; never a sign that a thread exists. */
  handoffChatId: string | null;
  status: "open" | "quoted" | "closed";
  createdBy: string;
  quotedMinor: number | null;
  lastMessageAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnquiryDto {
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
}

export interface EnquiryListItem extends EnquiryDto {
  vendorName: string;
  category: string;
}

export interface MessageDto {
  id: string;
  senderProfileId: string;
  body: string;
  createdAt: number;
}

const toDto = (r: EnquiryRow): EnquiryDto => ({
  id: r.id,
  weddingId: r.weddingId,
  directoryVendorId: r.directoryVendorId,
  vendorId: r.vendorId,
  zapChatId: r.zapChatId,
  status: r.status,
  createdBy: r.createdBy,
  quotedMinor: r.quotedMinor,
  lastMessageAt: r.lastMessageAt.getTime(),
  createdAt: r.createdAt.getTime(),
  updatedAt: r.updatedAt.getTime(),
});

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface EnquiryServiceDeps {
  /** Zap c2b chat client, or null when the feature is disabled (missing config). */
  readonly zap: ZapChatClient | null;
  /**
   * Pre-wrapped email sender — error channel is `never` so a broken transport
   * cannot fail an enquiry. The route builds this from `EmailService` and
   * swallows `EmailError` (logging a warning).
   */
  readonly sendEmail: (msg: SendEmailInput) => Effect.Effect<void, never, never>;
  /** Base URL for thread deep-links in emails (host-agnostic; supplied by env). */
  readonly threadBaseUrl: string;
}

export interface OpenEnquiryInput {
  weddingId: string;
  weddingName: string;
  directoryVendorId: string;
  category: string;
  message: string;
  createdBy: string;
  listing: DirectoryVendorRow | null;
  claimUrl: string;
}

export interface ReplyEnquiryInput {
  enquiry: EnquiryRow;
  senderProfileId: string;
  senderName: string;
  recipientEmail: string | null;
  recipientName: string;
  message: string;
}

export interface QuoteEnquiryInput {
  enquiry: EnquiryRow;
  senderProfileId: string;
  amountMinor: number;
  note?: string;
  coupleEmail: string | null;
  vendorName: string;
  currency: string;
}

export interface AddToBudgetInput {
  enquiry: EnquiryRow;
  vendorName: string;
  category: ServiceCategory;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a minor-unit integer as a currency string for emails / chat bodies. */
export function formatMinor(minor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100);
}

const threadUrl = (base: string, enquiryId: string): string =>
  `${base.replace(/\/+$/, "")}/${enquiryId}`;

/**
 * Hand one buffered enquiry (open, no chat, `pendingBody` set) to the vendor
 * who now owns its listing. Answers whether the enquiry was handed over; any
 * failure is logged and answers false, never fails, so one bad enquiry cannot
 * stop the others.
 *
 *  1. Chat. A chat an earlier attempt provisioned (`handoffChatId`) is reused;
 *     otherwise one is provisioned.
 *  2. Send the buffered body, unless the reused chat already holds a message.
 *     Nothing reaches that chat but this send (every reply path refuses while
 *     `zap_chat_id` is null), so a message there means an earlier attempt sent
 *     it and failed to record it.
 *  3. Record delivery: `zap_chat_id` set, `pending_body` and `handoff_chat_id`
 *     cleared, in one UPDATE that matches only while the enquiry is open with
 *     `zap_chat_id IS NULL`, so a second runner cannot overwrite the first's
 *     chat and a thread the couple closed meanwhile is not marked delivered.
 *
 * A failure after provisioning writes the new chat to `handoff_chat_id` in the
 * same UPDATE that bumps `updated_at` (which moves the enquiry to the back of
 * the sweep's queue), so the retry reuses it rather than provisioning another.
 * A failure on a reused chat clears it, so a chat zap no longer accepts costs
 * one more chat rather than blocking the enquiry for good.
 * The success path stays one D1 write. `zap_chat_id` alone tells readers a
 * thread exists, and it is set only once the body is delivered, so an open
 * enquiry never shows a chat while its first message waits.
 *
 * The daily cron calls this (`claimReviewService.sweep`) for listings an
 * operator has confirmed; nothing in the request path does.
 */
export function flushBufferedEnquiry(
  zap: ZapChatClient,
  enq: Pick<EnquiryRow, "id" | "createdBy" | "pendingBody" | "handoffChatId">,
  vendorProfileId: string,
): Effect.Effect<boolean, never, DbService> {
  return Effect.suspend(() => flushOnce(zap, enq, vendorProfileId));
}

function flushOnce(
  zap: ZapChatClient,
  enq: Pick<EnquiryRow, "id" | "createdBy" | "pendingBody" | "handoffChatId">,
  vendorProfileId: string,
): Effect.Effect<boolean, never, DbService> {
  // The chat this attempt provisioned, for the failure path to keep. A reused
  // chat that fails is dropped instead (see the catch below).
  let chatId: string | null = enq.handoffChatId;
  let provisionedNow = false;
  return Effect.gen(function* () {
    if (enq.pendingBody === null) return false;
    const body = enq.pendingBody;
    const db = yield* DbService;

    let alreadySent = false;
    if (chatId === null) {
      const provisioned = yield* Effect.promise(() =>
        zap.provisionC2bChat({
          memberProfileIds: [enq.createdBy, vendorProfileId],
          createdByProfileId: enq.createdBy,
          title: undefined,
        }),
      );
      chatId = provisioned.chatId;
      provisionedNow = true;
    } else {
      const reused = chatId;
      const { messages } = yield* Effect.promise(() => zap.listC2bMessages(reused, { limit: 1 }));
      alreadySent = messages.length > 0;
    }

    const deliverTo = chatId;
    if (!alreadySent) {
      yield* Effect.promise(() =>
        zap.sendC2bMessage(deliverTo, { senderProfileId: enq.createdBy, body }),
      );
    }
    const now = new Date();
    const result = yield* dbQuery(() =>
      db
        .update(vendorEnquiries)
        .set({
          zapChatId: deliverTo,
          handoffChatId: null,
          pendingBody: null,
          lastMessageAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(vendorEnquiries.id, enq.id),
            eq(vendorEnquiries.status, "open"),
            isNull(vendorEnquiries.zapChatId),
          ),
        )
        .run(),
    );
    return rowsChanged(result) === 1;
  }).pipe(
    Effect.catchDefect((cause) =>
      Effect.gen(function* () {
        yield* Effect.logError("[enquiries] buffered enquiry hand-off failed").pipe(
          Effect.annotateLogs({ enquiryId: enq.id, reason: String(cause) }),
        );
        // Move the enquiry to the back of the sweep's queue (ordered by
        // `updated_at`) so one that keeps failing cannot hold every run's
        // slots. Keep a chat this attempt provisioned, for the retry. Drop a
        // reused chat that failed: zap may have lost or refused it for good,
        // and keeping it would fail every retry the same way.
        const db = yield* DbService;
        const kept = provisionedNow ? chatId : null;
        yield* dbQuery(() =>
          db
            .update(vendorEnquiries)
            .set({
              updatedAt: new Date(),
              handoffChatId: sql`CASE WHEN ${vendorEnquiries.zapChatId} IS NULL THEN ${kept} ELSE NULL END`,
            })
            .where(eq(vendorEnquiries.id, enq.id))
            .run(),
        ).pipe(Effect.catchDefect(() => Effect.void));
        return false;
      }),
    ),
    Effect.withSpan("cire.enquiries.flushBuffered"),
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEnquiryService(deps: EnquiryServiceDeps) {
  /**
   * Create-if-missing the wedding-scoped `vendors` CRM row for a listing.
   * `vendorsService.create` INSERTs unconditionally; the
   * `vendors_wedding_directory_uniq` partial index makes a repeat throw — caught
   * as a defect, we SELECT the existing row instead. So a listing already in the
   * S1 Vendors module (with no enquiry yet) is reused rather than duplicated.
   */
  const ensureVendorRow = (
    weddingId: string,
    directoryVendorId: string,
    listing: { name: string; email: string | null; phone: string | null },
    category: string,
  ): Effect.Effect<string, never, DbService> =>
    vendorsService
      .create({
        weddingId,
        name: listing.name,
        category,
        status: "researching",
        contactName: null,
        email: listing.email,
        phone: listing.phone,
        notes: null,
        quotedMinor: null,
        directoryVendorId,
      })
      .pipe(
        Effect.map((v) => v.id),
        Effect.catchDefect(() =>
          Effect.gen(function* () {
            const db = yield* DbService;
            const [existing] = yield* dbQuery(() =>
              db
                .select({ id: vendors.id })
                .from(vendors)
                .where(
                  and(
                    eq(vendors.weddingId, weddingId),
                    eq(vendors.directoryVendorId, directoryVendorId),
                  ),
                )
                .all(),
            );
            if (!existing) {
              // The insert failed for a reason other than the dedup index —
              // re-raise as a defect so it surfaces rather than silently vanishing.
              return yield* Effect.die(
                new Error("vendors.create failed and no existing row to fall back to"),
              );
            }
            return (existing as { id: string }).id;
          }),
        ),
      );

  return {
    /** Open (or reuse) the enquiry thread for a (wedding, listing) pair — spec §5. */
    open(input: OpenEnquiryInput): Effect.Effect<EnquiryDto, EnquiryError, DbService> {
      return Effect.gen(function* () {
        const db = yield* DbService;

        // Listing (name/email/phone for the CRM row + its claim state) is
        // resolved once by the caller and passed down.
        const listing = input.listing;
        if (!listing) return yield* Effect.fail(new EnquiryNotFound());

        // (2) Idempotency: an existing thread for (wedding, listing) is returned
        // as-is — no re-provision, no second email.
        const [existing] = yield* dbQuery(() =>
          db
            .select()
            .from(vendorEnquiries)
            .where(
              and(
                eq(vendorEnquiries.weddingId, input.weddingId),
                eq(vendorEnquiries.directoryVendorId, input.directoryVendorId),
              ),
            )
            .all(),
        );
        if (existing) return toDto(existing as EnquiryRow);

        // A CLAIMED listing has no future buffered-enquiry flush (the claim already
        // happened), so if zap is disabled we must NOT buffer — that message would
        // strand forever. Fail ZapUnavailable up front, BEFORE any write (no CRM
        // vendors row, no enquiry INSERT), so nothing is orphaned; the route
        // surfaces it as 503 and the couple retries. Only genuinely UNCLAIMED
        // listings buffer.
        const claimedBy = listing.claimedByProfileId;
        if (claimedBy && !deps.zap) return yield* Effect.fail(new ZapUnavailable());

        // (1) Create-if-missing the CRM vendor row.
        const vendorId = yield* ensureVendorRow(
          input.weddingId,
          input.directoryVendorId,
          listing,
          input.category,
        );

        // (3) Claimed → provision + send now; unclaimed → buffer pendingBody.
        let zapChatId: string | null = null;
        let pendingBody: string | null = null;
        if (claimedBy) {
          const zap = deps.zap!;
          const { chatId } = yield* Effect.promise(() =>
            zap.provisionC2bChat({
              memberProfileIds: [input.createdBy, claimedBy],
              createdByProfileId: input.createdBy,
              title: input.weddingName,
            }),
          );
          yield* Effect.promise(() =>
            zap.sendC2bMessage(chatId, {
              senderProfileId: input.createdBy,
              body: input.message,
            }),
          );
          zapChatId = chatId;
        } else {
          pendingBody = input.message;
        }

        // (4) INSERT the enquiry.
        const now = new Date();
        const row: EnquiryRow = {
          id: `enq_${crypto.randomUUID()}`,
          weddingId: input.weddingId,
          directoryVendorId: input.directoryVendorId,
          vendorId,
          zapChatId,
          pendingBody,
          handoffChatId: null,
          status: "open",
          createdBy: input.createdBy,
          quotedMinor: null,
          lastMessageAt: now,
          createdAt: now,
          updatedAt: now,
        };
        yield* dbQuery(() => db.insert(vendorEnquiries).values(row).run());

        // (5) Email the vendor (enquiry-new). Unclaimed → claim CTA + a separate
        // copy to the lead-forward address if set.
        const unclaimed = !claimedBy;
        const url = threadUrl(deps.threadBaseUrl, row.id);
        if (listing.email) {
          const data: Types.Mutable<EmailTemplateData<"enquiry-new">> = {
            vendorName: listing.name,
            weddingName: input.weddingName,
            message: input.message,
            threadUrl: url,
            unclaimed,
          };
          if (unclaimed) data.claimUrl = input.claimUrl;
          yield* deps.sendEmail({ template: "enquiry-new", to: listing.email, data });
        }
        if (unclaimed && listing.leadForwardEmail) {
          yield* deps.sendEmail({
            template: "enquiry-new",
            to: listing.leadForwardEmail,
            data: {
              vendorName: listing.name,
              weddingName: input.weddingName,
              message: input.message,
              threadUrl: url,
              unclaimed: true,
              claimUrl: input.claimUrl,
            },
          });
        }

        return toDto(row);
      }).pipe(Effect.withSpan("cire.enquiries.open"));
    },

    /** Couple inbox: newest-first enquiries for a wedding, with vendor name + category. */
    list(weddingId: string): Effect.Effect<EnquiryListItem[], never, DbService> {
      return Effect.gen(function* () {
        const db = yield* DbService;
        const rows = yield* dbQuery(() =>
          db
            .select({
              enquiry: vendorEnquiries,
              vendorName: vendors.name,
              category: vendors.category,
            })
            .from(vendorEnquiries)
            .innerJoin(vendors, eq(vendorEnquiries.vendorId, vendors.id))
            .where(eq(vendorEnquiries.weddingId, weddingId))
            // Newest-first by last message, in SQL — this is what the second
            // column of vendor_enquiries_wedding_last_msg_idx exists for (a JS
            // sort here left it earning nothing).
            .orderBy(desc(vendorEnquiries.lastMessageAt))
            .all(),
        );
        return (rows as Array<{ enquiry: EnquiryRow; vendorName: string; category: string }>).map(
          (r): EnquiryListItem => {
            const dto = toDto(r.enquiry);
            return Object.assign(dto, { vendorName: r.vendorName, category: r.category });
          },
        );
      }).pipe(Effect.withSpan("cire.enquiries.list"));
    },

    /** Thread messages: real Zap history, or the single synthesized pending DTO. */
    getMessages(enquiry: EnquiryRow): Effect.Effect<MessageDto[], EnquiryError, DbService> {
      return Effect.gen(function* () {
        if (enquiry.zapChatId) {
          if (!deps.zap) return yield* Effect.fail(new ZapUnavailable());
          const zap = deps.zap;
          const chatId = enquiry.zapChatId;
          // Cap the fetch: an unbounded thread could blow the Workers 6MB
          // response wall. v1 has no cursor UI — just the ceiling.
          const { messages } = yield* Effect.promise(() =>
            zap.listC2bMessages(chatId, { limit: 50 }),
          );
          return messages.map((m) => ({
            id: m.id,
            senderProfileId: m.senderProfileId,
            body: m.body,
            createdAt: m.createdAt,
          }));
        }
        // Unprovisioned: surface the couple's buffered first message so they see
        // what's waiting to reach the vendor.
        if (enquiry.pendingBody !== null) {
          return [
            {
              id: "pending",
              senderProfileId: enquiry.createdBy,
              body: enquiry.pendingBody,
              createdAt: enquiry.createdAt.getTime(),
            },
          ];
        }
        return [];
      }).pipe(Effect.withSpan("cire.enquiries.getMessages"));
    },

    /** Post a reply into a provisioned thread + email the other party. */
    reply(input: ReplyEnquiryInput): Effect.Effect<MessageDto, EnquiryError, DbService> {
      return Effect.gen(function* () {
        const db = yield* DbService;
        const { enquiry } = input;
        if (!enquiry.zapChatId) return yield* Effect.fail(new EnquiryAwaitingVendor());
        if (!deps.zap) return yield* Effect.fail(new ZapUnavailable());
        const zap = deps.zap;
        const chatId = enquiry.zapChatId;

        const sent = yield* Effect.promise(() =>
          zap.sendC2bMessage(chatId, {
            senderProfileId: input.senderProfileId,
            body: input.message,
          }),
        );

        const now = new Date();
        yield* dbQuery(() =>
          db
            .update(vendorEnquiries)
            .set({ lastMessageAt: now, updatedAt: now })
            .where(eq(vendorEnquiries.id, enquiry.id))
            .run(),
        );

        if (input.recipientEmail) {
          yield* deps.sendEmail({
            template: "enquiry-reply",
            to: input.recipientEmail,
            data: {
              recipientName: input.recipientName,
              senderName: input.senderName,
              message: input.message,
              threadUrl: threadUrl(deps.threadBaseUrl, enquiry.id),
            },
          });
        }

        return {
          id: sent.messageId,
          senderProfileId: input.senderProfileId,
          body: input.message,
          createdAt: sent.createdAt,
        };
      }).pipe(Effect.withSpan("cire.enquiries.reply"));
    },

    /** Attach a quote: mirror it into both tables, message Zap, email the couple. */
    quote(input: QuoteEnquiryInput): Effect.Effect<EnquiryDto, EnquiryError, DbService> {
      return Effect.gen(function* () {
        const db = yield* DbService;
        const { enquiry } = input;
        // A quote presupposes a claimed vendor (chat provisioned) — guard anyway.
        if (!enquiry.zapChatId) return yield* Effect.fail(new EnquiryAwaitingVendor());
        if (!deps.zap) return yield* Effect.fail(new ZapUnavailable());
        const zap = deps.zap;
        const chatId = enquiry.zapChatId;

        const now = new Date();
        // Mirror the quote into vendor_enquiries (+ status) AND the linked
        // vendors row — one atomic batch, since the two quoted_minor columns
        // must agree (a failure between two separate updates silently diverged
        // them).
        yield* dbQuery(() =>
          commitBatch(db, [
            db
              .update(vendorEnquiries)
              .set({
                quotedMinor: input.amountMinor,
                status: "quoted",
                lastMessageAt: now,
                updatedAt: now,
              })
              .where(eq(vendorEnquiries.id, enquiry.id)),
            db
              .update(vendors)
              .set({ quotedMinor: input.amountMinor, updatedAt: now })
              .where(eq(vendors.id, enquiry.vendorId)),
          ]),
        );

        const amountFormatted = formatMinor(input.amountMinor, input.currency);
        const quoteBody = input.note
          ? `Quote: ${amountFormatted}\n${input.note}`
          : `Quote: ${amountFormatted}`;
        yield* Effect.promise(() =>
          zap.sendC2bMessage(chatId, { senderProfileId: input.senderProfileId, body: quoteBody }),
        );

        if (input.coupleEmail) {
          const data: Types.Mutable<EmailTemplateData<"enquiry-quote">> = {
            vendorName: input.vendorName,
            amountFormatted,
            threadUrl: threadUrl(deps.threadBaseUrl, enquiry.id),
          };
          if (input.note) data.note = input.note;
          yield* deps.sendEmail({ template: "enquiry-quote", to: input.coupleEmail, data });
        }

        // Build the DTO from known values rather than re-reading.
        const updated: EnquiryRow = {
          ...enquiry,
          quotedMinor: input.amountMinor,
          status: "quoted",
          lastMessageAt: now,
          updatedAt: now,
        };
        return toDto(updated);
      }).pipe(Effect.withSpan("cire.enquiries.quote"));
    },

    /** Push the enquiry's quote into the budget as a new item. */
    addToBudget(
      input: AddToBudgetInput,
    ): Effect.Effect<{ budgetItemId: string }, EnquiryError, DbService> {
      return Effect.gen(function* () {
        const { enquiry } = input;
        const item = yield* budgetService
          .createItem({
            weddingId: enquiry.weddingId,
            category: input.category,
            name: input.vendorName,
            estimateMinor: null,
            quotedMinor: enquiry.quotedMinor,
            actualMinor: null,
            notes: null,
          })
          .pipe(
            // Unreachable: a fixed line names no events, so there is nothing to
            // check against the wedding. A defect rather than an EnquiryError, so
            // it surfaces instead of being mapped to a reason shown to the couple.
            Effect.catchTag("EventNotInWedding", (error) => Effect.die(error)),
          );
        return { budgetItemId: item.id };
      }).pipe(Effect.withSpan("cire.enquiries.addToBudget"));
    },
  };
}
