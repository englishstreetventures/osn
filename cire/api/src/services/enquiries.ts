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
 *   2. onVendorClaimed → best-effort flush each buffered enquiry into Zap.
 *
 * open() is idempotent on `(weddingId, directoryVendorId)` via the
 * `vendor_enquiries_wedding_directory_uniq` index: a repeat returns the existing
 * enquiry with no re-provision and no second email.
 */

import { directoryVendors, vendorEnquiries, vendors } from "@cire/db";
import type { SendEmailInput } from "@shared/email";
import { and, eq, isNull } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import type { ServiceCategory } from "../lib/service-categories";
import { budgetService } from "./budget";
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
  vendorEmail: string | null;
  leadForwardEmail: string | null;
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

export interface OnVendorClaimedInput {
  directoryVendorId: string;
  vendorProfileId: string;
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
        Effect.catchAllDefect(() =>
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
              return yield* Effect.dieMessage(
                "vendors.create failed and no existing row to fall back to",
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

        // Resolve the listing (name/email/phone for the CRM row + its claim state).
        const [listing] = yield* dbQuery(() =>
          db
            .select({
              name: directoryVendors.name,
              email: directoryVendors.email,
              phone: directoryVendors.phone,
              claimedByProfileId: directoryVendors.claimedByProfileId,
            })
            .from(directoryVendors)
            .where(eq(directoryVendors.id, input.directoryVendorId))
            .all(),
        );
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

        // A CLAIMED listing has no future onVendorClaimed flush (the claim already
        // happened), so if zap is disabled we must NOT buffer — that message would
        // strand forever. Fail ZapUnavailable up front, BEFORE any write (no CRM
        // vendors row, no enquiry INSERT), so nothing is orphaned; the route
        // surfaces it as 503 and the couple retries. Only genuinely UNCLAIMED
        // listings buffer.
        const claimedBy = (listing as { claimedByProfileId: string | null }).claimedByProfileId;
        if (claimedBy && !deps.zap) return yield* Effect.fail(new ZapUnavailable());

        // (1) Create-if-missing the CRM vendor row.
        const vendorId = yield* ensureVendorRow(
          input.weddingId,
          input.directoryVendorId,
          listing as { name: string; email: string | null; phone: string | null },
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
        if (input.vendorEmail) {
          yield* deps.sendEmail({
            template: "enquiry-new",
            to: input.vendorEmail,
            data: {
              vendorName: (listing as { name: string }).name,
              weddingName: input.weddingName,
              message: input.message,
              threadUrl: url,
              unclaimed,
              ...(unclaimed ? { claimUrl: input.claimUrl } : {}),
            },
          });
        }
        if (unclaimed && input.leadForwardEmail) {
          yield* deps.sendEmail({
            template: "enquiry-new",
            to: input.leadForwardEmail,
            data: {
              vendorName: (listing as { name: string }).name,
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
            .all(),
        );
        const items = (
          rows as Array<{ enquiry: EnquiryRow; vendorName: string; category: string }>
        ).map((r): EnquiryListItem => {
          const dto = toDto(r.enquiry);
          return Object.assign(dto, { vendorName: r.vendorName, category: r.category });
        });
        // Newest-first by last message.
        items.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
        return items;
      }).pipe(Effect.withSpan("cire.enquiries.list"));
    },

    /** Thread messages: real Zap history, or the single synthesized pending DTO. */
    getMessages(enquiry: EnquiryRow): Effect.Effect<MessageDto[], EnquiryError, DbService> {
      return Effect.gen(function* () {
        if (enquiry.zapChatId) {
          if (!deps.zap) return yield* Effect.fail(new ZapUnavailable());
          const zap = deps.zap;
          const chatId = enquiry.zapChatId;
          // Cap the fetch (P-W2): an unbounded thread could blow the Workers 6MB
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
        // Mirror the quote into vendor_enquiries (+ status) AND the linked vendors row.
        yield* dbQuery(() =>
          db
            .update(vendorEnquiries)
            .set({
              quotedMinor: input.amountMinor,
              status: "quoted",
              lastMessageAt: now,
              updatedAt: now,
            })
            .where(eq(vendorEnquiries.id, enquiry.id))
            .run(),
        );
        yield* dbQuery(() =>
          db
            .update(vendors)
            .set({ quotedMinor: input.amountMinor, updatedAt: now })
            .where(eq(vendors.id, enquiry.vendorId))
            .run(),
        );

        const amountFormatted = formatMinor(input.amountMinor, input.currency);
        const quoteBody = input.note
          ? `Quote: ${amountFormatted}\n${input.note}`
          : `Quote: ${amountFormatted}`;
        yield* Effect.promise(() =>
          zap.sendC2bMessage(chatId, { senderProfileId: input.senderProfileId, body: quoteBody }),
        );

        if (input.coupleEmail) {
          yield* deps.sendEmail({
            template: "enquiry-quote",
            to: input.coupleEmail,
            data: {
              vendorName: input.vendorName,
              amountFormatted,
              ...(input.note ? { note: input.note } : {}),
              threadUrl: threadUrl(deps.threadBaseUrl, enquiry.id),
            },
          });
        }

        // Re-read for the fresh DTO.
        const [updated] = yield* dbQuery(() =>
          db.select().from(vendorEnquiries).where(eq(vendorEnquiries.id, enquiry.id)).all(),
        );
        return toDto(updated as EnquiryRow);
      }).pipe(Effect.withSpan("cire.enquiries.quote"));
    },

    /** Push the enquiry's quote into the budget as a new item. */
    addToBudget(
      input: AddToBudgetInput,
    ): Effect.Effect<{ budgetItemId: string }, EnquiryError, DbService> {
      return Effect.gen(function* () {
        const { enquiry } = input;
        const item = yield* budgetService.createItem({
          weddingId: enquiry.weddingId,
          category: input.category,
          name: input.vendorName,
          estimateMinor: null,
          quotedMinor: enquiry.quotedMinor,
          actualMinor: null,
          notes: null,
        });
        return { budgetItemId: item.id };
      }).pipe(Effect.withSpan("cire.enquiries.addToBudget"));
    },

    /**
     * A vendor just claimed a listing — flush every buffered enquiry (open,
     * zapChatId null, pendingBody set) for it: provision the chat, send the
     * buffered body, null pendingBody, bump lastMessageAt. Best-effort per
     * enquiry: one failure is logged and skipped, never aborts the loop. If
     * `deps.zap` is null the whole call is an inert no-op (logged).
     */
    onVendorClaimed(input: OnVendorClaimedInput): Effect.Effect<void, never, DbService> {
      return Effect.gen(function* () {
        if (!deps.zap) {
          yield* Effect.logWarning(
            "[enquiries] onVendorClaimed with zap disabled — buffered enquiries left pending",
          ).pipe(Effect.annotateLogs({ directoryVendorId: input.directoryVendorId }));
          return;
        }
        const zap = deps.zap;
        const db = yield* DbService;

        const buffered = yield* dbQuery(() =>
          db
            .select()
            .from(vendorEnquiries)
            .where(
              and(
                eq(vendorEnquiries.directoryVendorId, input.directoryVendorId),
                eq(vendorEnquiries.status, "open"),
                isNull(vendorEnquiries.zapChatId),
              ),
            )
            .all(),
        );

        // Flush one buffered enquiry. Per-enquiry isolation: catchAll +
        // catchAllDefect collapse any failure to a logged no-op so one bad
        // enquiry never aborts the others — the effect's error channel is
        // `never`, which lets the bounded `Effect.all` below keep going.
        const flushOne = (enq: EnquiryRow): Effect.Effect<void, never, never> => {
          if (enq.pendingBody === null) return Effect.void;
          const body = enq.pendingBody;
          return Effect.gen(function* () {
            const { chatId } = yield* Effect.promise(() =>
              zap.provisionC2bChat({
                memberProfileIds: [enq.createdBy, input.vendorProfileId],
                createdByProfileId: enq.createdBy,
                title: undefined,
              }),
            );
            yield* Effect.promise(() =>
              zap.sendC2bMessage(chatId, { senderProfileId: enq.createdBy, body }),
            );
            const now = new Date();
            yield* dbQuery(() =>
              db
                .update(vendorEnquiries)
                .set({ zapChatId: chatId, pendingBody: null, lastMessageAt: now, updatedAt: now })
                .where(eq(vendorEnquiries.id, enq.id))
                .run(),
            );
          }).pipe(
            Effect.provideService(DbService, db),
            // Best-effort: a single enquiry's failure must not abort the claim.
            Effect.catchAll((cause) =>
              Effect.logError("[enquiries] flush-on-claim failed for one enquiry").pipe(
                Effect.annotateLogs({ enquiryId: enq.id, reason: String(cause) }),
              ),
            ),
            Effect.catchAllDefect((cause) =>
              Effect.logError("[enquiries] flush-on-claim defected for one enquiry").pipe(
                Effect.annotateLogs({ enquiryId: enq.id, reason: String(cause) }),
              ),
            ),
          );
        };

        // Bounded-concurrency flush (P-W3): don't block the claim response
        // linearly in N. Each flush is self-isolating (never-fails), so the pool
        // drains every buffered enquiry regardless of individual outcomes.
        yield* Effect.all((buffered as EnquiryRow[]).map(flushOne), { concurrency: 5 });
      }).pipe(Effect.withSpan("cire.enquiries.onVendorClaimed"));
    },
  };
}
