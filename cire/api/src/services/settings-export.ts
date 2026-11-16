import { weddingFaqs, weddingInviteCustomisations, weddings } from "@cire/db";
import { asc, eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { serialiseCsv } from "../lib/csv";
import { minorToDecimal } from "../lib/money";
import { normaliseTier } from "./tiers";

/**
 * Row ceiling on `questions.csv`. The invite takes at most
 * `FAQ_LIMITS.maxEntries` (30) questions, so this is never reached by rows the
 * portal wrote; it bounds the read the way every export's ceiling does.
 */
export const MAX_QUESTION_EXPORT_ROWS = 100;

const FIELD_HEADER = ["Field", "Value"];

const yesNo = (value: boolean): string => (value ? "Yes" : "No");
const tierName = (tier: string): string => {
  const known = normaliseTier(tier);
  return known.charAt(0).toUpperCase() + known.slice(1);
};

/**
 * The wedding's own settings and the invite's words, for the whole-wedding
 * archive (`services/wedding-archive.ts`). Two files are one row each, so they
 * print as `Field,Value` pairs a person can read down; the questions print one
 * row each. Every cell goes through `serialiseCsv`'s formula guard.
 */
export const settingsExportService = {
  /** The wedding's settings: what the Settings page shows, and when it began. */
  weddingCsv(weddingId: string): Effect.Effect<string, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [row] = yield* dbQuery(() =>
        db
          .select({
            displayName: weddings.displayName,
            slug: weddings.slug,
            weddingDate: weddings.weddingDate,
            guestCountEstimate: weddings.guestCountEstimate,
            currency: weddings.currency,
            budgetTotalMinor: weddings.budgetTotalMinor,
            rsvpDeadline: weddings.rsvpDeadline,
            rsvpDeadlineTimezone: weddings.rsvpDeadlineTimezone,
            codeStyle: weddings.codeStyle,
            tier: weddings.tier,
            createdAt: weddings.createdAt,
          })
          .from(weddings)
          .where(eq(weddings.id, weddingId))
          .limit(1)
          .all(),
      );
      if (!row) return serialiseCsv(FIELD_HEADER, []);
      return serialiseCsv(FIELD_HEADER, [
        ["Name", row.displayName],
        ["Invite address", row.slug],
        ["Wedding date", row.weddingDate ?? ""],
        ["Guests expected", row.guestCountEstimate === null ? "" : String(row.guestCountEstimate)],
        ["Currency", row.currency],
        [
          "Budget total",
          row.budgetTotalMinor === null ? "" : minorToDecimal(row.budgetTotalMinor, row.currency),
        ],
        ["RSVP by", row.rsvpDeadline ?? ""],
        ["RSVP time zone", row.rsvpDeadlineTimezone ?? ""],
        ["Household codes", row.codeStyle === "simple" ? "Simple" : "Secure"],
        ["Plan", tierName(row.tier)],
        ["Created", row.createdAt.toISOString()],
      ]);
    }).pipe(Effect.withSpan("cire.settings-export.weddingCsv"));
  },

  /**
   * The invite's words and look: every section's text, which sections show,
   * the design, envelope, type and colours. Image keys and crops are left out:
   * the images themselves are in the archive's `files/invite/` folder.
   */
  inviteCsv(weddingId: string): Effect.Effect<string, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [row] = yield* dbQuery(() =>
        db
          .select()
          .from(weddingInviteCustomisations)
          .where(eq(weddingInviteCustomisations.weddingId, weddingId))
          .limit(1)
          .all(),
      );
      if (!row) return serialiseCsv(FIELD_HEADER, []);
      const text = (value: string | null): string => value ?? "";
      return serialiseCsv(FIELD_HEADER, [
        ["Design", row.designId],
        ["Envelope", text(row.envelopeId)],
        ["Hero title", text(row.heroTitle)],
        ["Hero subtitle", text(row.heroSubtitle)],
        ["Hero shown", yesNo(row.heroVisible)],
        ["Story eyebrow", text(row.storyEyebrow)],
        ["Story heading", text(row.storyHeading)],
        ["Story", text(row.storyBody)],
        ["Story shown", yesNo(row.storyVisible)],
        ["Details eyebrow", text(row.detailsEyebrow)],
        ["Details heading", text(row.detailsHeading)],
        ["Welcome message", text(row.welcomeMessage)],
        ["Gift list eyebrow", text(row.registryEyebrow)],
        ["Gift list heading", text(row.registryHeading)],
        ["Gift list text", text(row.registryBody)],
        ["Footer message", text(row.footerMessage)],
        ["Footer shown", yesNo(row.footerVisible)],
        ["Questions shown", yesNo(row.faqVisible)],
        ["Invite message", text(row.inviteMessage)],
        ["Heading font", text(row.themeHeadingFont)],
        ["Heading size", text(row.themeHeadingSize)],
        ["Heading weight", text(row.themeHeadingWeight)],
        ["Heading style", text(row.themeHeadingStyle)],
        ["Body font", text(row.themeBodyFont)],
        ["Body weight", text(row.themeBodyWeight)],
        ["Body style", text(row.themeBodyStyle)],
        ["Palette", text(row.palettePreset)],
        ["Ground colour", text(row.paletteGround)],
        ["Card colour", text(row.paletteCard)],
        ["Ink colour", text(row.paletteInk)],
        ["Gilt colour", text(row.paletteGilt)],
        ["Bloom colour", text(row.paletteBloom)],
      ]);
    }).pipe(Effect.withSpan("cire.settings-export.inviteCsv"));
  },

  /** The invite's questions and answers, in the couple's order, cut one past the ceiling in the read. */
  questionsCsv(weddingId: string): Effect.Effect<string, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db
          .select({ question: weddingFaqs.question, answer: weddingFaqs.answer })
          .from(weddingFaqs)
          .where(eq(weddingFaqs.weddingId, weddingId))
          .orderBy(asc(weddingFaqs.sortOrder), asc(weddingFaqs.id))
          .limit(MAX_QUESTION_EXPORT_ROWS + 1)
          .all(),
      );
      if (rows.length > MAX_QUESTION_EXPORT_ROWS) {
        yield* Effect.logWarning("questions.csv exceeds the export ceiling; cut").pipe(
          Effect.annotateLogs({ weddingId, exportCap: MAX_QUESTION_EXPORT_ROWS }),
        );
      }
      return serialiseCsv(
        ["Question", "Answer"],
        rows.slice(0, MAX_QUESTION_EXPORT_ROWS).map((row) => [row.question, row.answer]),
      );
    }).pipe(Effect.withSpan("cire.settings-export.questionsCsv"));
  },
};
