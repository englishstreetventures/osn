/**
 * The whole-wedding archive: one ZIP of everything cire holds for a wedding,
 * for its owners to take away (`routes/wedding-archive.ts`).
 *
 * **Two phases.** {@link weddingArchiveService.read} runs every database read
 * — each file's export and the list of files to fetch — before the response
 * starts, so a failed read is the route's clean 500, never an archive cut
 * short. {@link weddingArchiveService.stream} then writes the archive one entry
 * per pull, fetching each R2 object as its turn comes, so the Worker holds one
 * file at a time. A file it cannot fetch, or that a limit keeps out, is left
 * out and named in `manifest.json`, written last; nothing is ever half
 * written, since each object is read whole before its entry starts.
 *
 * **Limits** ({@link ARCHIVE_LIMITS}). Each R2 object is one read, and one
 * Worker invocation may make 1,000 calls to Cloudflare services, D1's
 * statements included, so the archive reads at most 900 objects. It holds at
 * most 256 MiB of them: the portal keeps the archive in memory as one Blob
 * before saving it, and the ZIP fflate writes has no ZIP64 records. The count
 * is checked before a read; the byte total after it, on the bytes read, since
 * neither bucket's binding reports a size up front here. Uploads are capped at
 * 5 MiB an image (`MAX_IMAGE_BYTES`), so no single file needs a cap of its own.
 *
 * **CPU.** Every entry is stored with a native CRC-32 (`lib/stored-zip.ts`), so
 * the CPU goes where the single CSV downloads spend it: serialising rows.
 * Workers Free allows 10 ms a request and each CSV's ceiling is sized to use
 * most of that alone, so on Free (the dev tier) an archive of a wedding with
 * much in it can be stopped; Workers Paid allows 30 s.
 */
import {
  budgetItems,
  events,
  families,
  imports,
  payments,
  registryItems,
  seatingAssignments,
  seatingPlans,
  seatingTables,
  tasks,
  vendors,
  weddingFaqs,
  weddingInviteCustomisations,
  weddings,
} from "@cire/db";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, dbQuery } from "../db";
import type { EffectDbService } from "../db/effect-handle";
import { StoredZip } from "../lib/stored-zip";
import { metricWeddingArchiveDownload, metricWeddingArchiveFile } from "../metrics";
import type { WeddingArchiveFileStatus } from "../metrics";
import { runCire } from "../observability";
import { INVITE_IMAGE_SLOTS } from "../schemas/invite";
import { giftCountSql, giftExportService, MAX_GIFT_EXPORT_ROWS } from "./gift-export";
import { SLOT_COLUMNS } from "./invite";
import { detectImageType } from "./invite-assets";
import { MAX_PLANNING_EXPORT_ROWS, planningExportService } from "./planning-export";
import { MAX_REGISTRY_EXPORT_ROWS, registryExportService } from "./registry-export";
import { MAX_HOUSEHOLD_EXPORT_ROWS, rosterExportService } from "./roster-export";
import { rsvpExportService, toCsv } from "./rsvp-export";
import { MAX_SEATING_EXPORT_ROWS, seatingExportService } from "./seating-export";
import { MAX_QUESTION_EXPORT_ROWS, settingsExportService } from "./settings-export";
import { stateExportService } from "./state-export";
import { tableExportService } from "./table-export";
import { MAX_VENDOR_EXPORT_ROWS, vendorExportService } from "./vendor-export";

/** How much of a wedding's R2 objects one archive holds. */
export interface ArchiveLimits {
  /** Objects read from R2, each one call to a Cloudflare service. */
  readonly files: number;
  /** Bytes of those objects in all. */
  readonly bytes: number;
}

export const ARCHIVE_LIMITS: ArchiveLimits = { files: 900, bytes: 256 * 1024 * 1024 };

/** Uploads an archive lists: two sheets each, so the count limit is reached first. */
const MAX_UPLOAD_ROWS = Math.ceil(ARCHIVE_LIMITS.files / 2);

/** The image bucket as the archive reads it. `AssetsBucket` satisfies it. */
export interface ArchiveAssetsSource {
  get(key: string):
    | Promise<{
        arrayBuffer(): Promise<ArrayBuffer>;
        readonly httpMetadata?: { contentType?: string };
      } | null>
    | {
        arrayBuffer(): Promise<ArrayBuffer>;
        readonly httpMetadata?: { contentType?: string };
      }
    | null;
}

/** The sheets bucket as the archive reads it. `R2Bucket` (`r2-imports.ts`) satisfies it. */
export interface ArchiveSheetsSource {
  get(
    key: string,
  ): Promise<{ text(): Promise<string> } | null> | { text(): Promise<string> } | null;
}

export interface ArchiveSources {
  readonly assets?: ArchiveAssetsSource;
  readonly sheets?: ArchiveSheetsSource;
}

/** One CSV in the archive, and whether its export's ceiling cut it. */
interface DataFile {
  readonly path: string;
  readonly text: string;
  readonly complete: boolean;
  readonly rowsInWedding?: number;
  readonly rowsInFile?: number;
}

/** One R2 object the archive will try to fetch. */
interface PlannedFile {
  /** What it is, in words a person reads in the manifest. */
  readonly what: string;
  /** Its path in the archive without an extension; an image's comes from its type. */
  readonly stem: string;
  readonly bucket: "assets" | "sheets";
  readonly key: string;
  /** A sheet's extension, from its upload's format. */
  readonly extension?: string;
}

export interface ArchivePlan {
  /** The archive's one top folder, `cire-wedding-<slug>/`. */
  readonly folder: string;
  readonly wedding: { readonly id: string; readonly name: string; readonly slug: string };
  readonly createdAt: Date;
  readonly data: readonly DataFile[];
  readonly files: readonly PlannedFile[];
}

/**
 * The extension a stored picture is saved under, by its content type: the
 * three types an upload or a copied gift picture may be (`ALLOWED_IMAGE_TYPES`
 * in `services/invite-assets.ts`).
 */
const IMAGE_EXTENSIONS = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

/**
 * `name` as one path segment: ASCII letters and digits joined by hyphens, at
 * most 40 characters, or `fallback` when nothing is left. No separator, dot or
 * other character from the wedding's own text reaches a path.
 */
export function pathSegment(name: string, fallback: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || fallback;
}

/** A 1-based position, three digits wide: up to 999 sorts in order. */
const position = (index: number): string => String(index + 1).padStart(3, "0");

/** A day as `YYYY-MM-DD`, in UTC. */
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Whether a data file is whole, with both counts when its ceiling cut it. */
function dataFile(path: string, text: string, rows?: { count: number; ceiling: number }): DataFile {
  if (!rows || rows.count <= rows.ceiling) return { path, text, complete: true };
  return { path, text, complete: false, rowsInWedding: rows.count, rowsInFile: rows.ceiling };
}

/** How many rows each capped file would hold uncut, and the wedding's name, in one statement. */
function readCounts(weddingId: string) {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const budgetIds = db
      .select({ id: budgetItems.id })
      .from(budgetItems)
      .where(eq(budgetItems.weddingId, weddingId));
    const selectedPlanIds = db
      .select({ id: seatingPlans.id })
      .from(seatingPlans)
      .where(and(eq(seatingPlans.weddingId, weddingId), eq(seatingPlans.selected, true)));
    const [row] = yield* dbQuery(() =>
      db
        .select({
          name: weddings.displayName,
          slug: weddings.slug,
          budget: sql<number>`(${db.$count(budgetItems, eq(budgetItems.weddingId, weddingId))} + ${db.$count(payments, inArray(payments.budgetItemId, budgetIds))})`,
          tasks: db.$count(tasks, eq(tasks.weddingId, weddingId)),
          gifts: giftCountSql(db, weddingId),
          seats: db.$count(seatingAssignments, inArray(seatingAssignments.planId, selectedPlanIds)),
          planRows: sql<number>`(SELECT count(*) FROM ${seatingTables} LEFT JOIN ${seatingAssignments} ON ${seatingAssignments.tableId} = ${seatingTables.id} WHERE ${seatingTables.weddingId} = ${weddingId})`,
          households: db.$count(
            families,
            and(eq(families.weddingId, weddingId), ne(families.kind, "host")),
          ),
          vendors: db.$count(vendors, eq(vendors.weddingId, weddingId)),
          registry: db.$count(registryItems, eq(registryItems.weddingId, weddingId)),
          questions: db.$count(weddingFaqs, eq(weddingFaqs.weddingId, weddingId)),
        })
        .from(weddings)
        .where(eq(weddings.id, weddingId))
        .all(),
    );
    if (!row) return yield* Effect.die(new Error("wedding archive: the wedding is gone"));
    const n = (value: unknown) => Number(value ?? 0);
    return {
      name: row.name,
      slug: row.slug,
      budget: n(row.budget),
      tasks: n(row.tasks),
      gifts: n(row.gifts),
      seats: n(row.seats),
      planRows: n(row.planRows),
      households: n(row.households),
      vendors: n(row.vendors),
      registry: n(row.registry),
      questions: n(row.questions),
    };
  });
}

/** Every R2 object the wedding names, in the order the archive writes them. */
function readFilePlan(weddingId: string) {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const [slots, eventRows, itemRows, uploadRows] = yield* Effect.all(
      [
        dbQuery(() =>
          db
            .select()
            .from(weddingInviteCustomisations)
            .where(eq(weddingInviteCustomisations.weddingId, weddingId))
            .limit(1)
            .all(),
        ),
        dbQuery(() =>
          db
            .select({ name: events.name, key: events.eventImageKey })
            .from(events)
            .where(eq(events.weddingId, weddingId))
            .orderBy(asc(events.sortOrder), asc(events.id))
            .all(),
        ),
        dbQuery(() =>
          db
            .select({ title: registryItems.title, key: registryItems.imageKey })
            .from(registryItems)
            .where(eq(registryItems.weddingId, weddingId))
            .orderBy(asc(registryItems.sortOrder), asc(registryItems.id))
            .limit(MAX_REGISTRY_EXPORT_ROWS)
            .all(),
        ),
        dbQuery(() =>
          db
            .select({
              uploadedAt: imports.uploadedAt,
              format: imports.format,
              eventsKey: imports.eventsR2Key,
              guestsKey: imports.guestsR2Key,
            })
            .from(imports)
            .where(
              and(
                eq(imports.weddingId, weddingId),
                eq(imports.kind, "import"),
                inArray(imports.status, ["applied", "reverted"]),
              ),
            )
            .orderBy(desc(imports.uploadedAt), asc(imports.id))
            .limit(MAX_UPLOAD_ROWS)
            .all(),
        ),
      ],
      { concurrency: "unbounded" },
    );

    const files: PlannedFile[] = [];
    const customisation = slots[0];
    for (const slot of INVITE_IMAGE_SLOTS) {
      const key = customisation?.[SLOT_COLUMNS[slot].key];
      if (key) {
        files.push({
          what: `Invite image: ${slot}`,
          stem: `files/invite/${slot}`,
          bucket: "assets",
          key,
        });
      }
    }
    eventRows.forEach((event, i) => {
      if (!event.key) return;
      files.push({
        what: `Event image: ${event.name}`,
        stem: `files/events/${position(i)}-${pathSegment(event.name, "event")}`,
        bucket: "assets",
        key: event.key,
      });
    });
    itemRows.forEach((item, i) => {
      if (!item.key) return;
      files.push({
        what: `Gift image: ${item.title}`,
        stem: `files/registry/${position(i)}-${pathSegment(item.title, "gift")}`,
        bucket: "assets",
        key: item.key,
      });
    });
    uploadRows.forEach((upload, i) => {
      const stem = `files/uploads/${day(upload.uploadedAt)}-${position(i)}`;
      files.push({
        what: `Uploaded events sheet, ${day(upload.uploadedAt)}`,
        stem: `${stem}-events`,
        bucket: "sheets",
        key: upload.eventsKey,
        extension: upload.format,
      });
      files.push({
        what: `Uploaded guest sheet, ${day(upload.uploadedAt)}`,
        stem: `${stem}-guests`,
        bucket: "sheets",
        key: upload.guestsKey,
        extension: upload.format,
      });
    });
    return files;
  });
}

const README = (name: string, createdAt: Date): string =>
  [
    `${name}: everything Cire holds for this wedding`,
    `Downloaded ${createdAt.toISOString()}`,
    "",
    "The .csv files open in Excel, Numbers or Google Sheets.",
    "",
    "wedding.csv        the wedding's settings",
    "guests.csv         every guest, with their household's code and invitations",
    "households.csv     every household, with its code",
    "events.csv         the schedule",
    "rsvps.csv          every guest's reply to each event",
    "seating.csv        the seating plans in use, for the venue",
    "seating-plans.csv  every seating plan, in use or not",
    "registry.csv       the gift list",
    "gifts.csv          what guests gave",
    "budget.csv         the budget and its payments",
    "tasks.csv          the checklist",
    "vendors.csv        the vendor list",
    "invite.csv         the invitation's words and look",
    "questions.csv      the invitation's questions and answers",
    "for-import/        the schedule and guest list as Cire imports them, to set the wedding up again",
    "files/             the pictures on the invitation, the schedule and the gift list,",
    "                   and the spreadsheets you uploaded",
    "",
    "manifest.json lists every file. Where a file is not complete, or a picture or",
    "spreadsheet was left out, it says why.",
    "",
  ].join("\r\n");

export const weddingArchiveService = {
  /**
   * Every database read the archive needs: each file's CSV, the counts that
   * say whether a ceiling cut one, and the R2 objects to fetch. A failed read
   * dies, and the route answers 500 before any byte of the archive.
   */
  read(
    weddingId: string,
    now: Date = new Date(),
  ): Effect.Effect<ArchivePlan, never, DbService | EffectDbService> {
    return Effect.gen(function* () {
      const [
        counts,
        files,
        weddingCsv,
        guestsCsv,
        householdsCsv,
        eventsCsv,
        rsvps,
        seatingCsv,
        seatingPlansCsv,
        registryCsv,
        giftsCsv,
        budgetCsv,
        tasksCsv,
        vendorsCsv,
        inviteCsv,
        questionsCsv,
        importEventsCsv,
        importGuestsCsv,
      ] = yield* Effect.all(
        [
          readCounts(weddingId),
          readFilePlan(weddingId),
          settingsExportService.weddingCsv(weddingId),
          tableExportService.guestsCsv(weddingId),
          rosterExportService.householdsCsv(weddingId),
          tableExportService.eventsCsv(weddingId),
          rsvpExportService.build(weddingId),
          seatingExportService.seatingCsv(weddingId),
          seatingExportService.allPlansCsv(weddingId),
          registryExportService.itemsCsv(weddingId),
          giftExportService.giftsCsv(weddingId),
          planningExportService.budgetCsv(weddingId),
          planningExportService.tasksCsv(weddingId),
          vendorExportService.vendorsCsv(weddingId),
          settingsExportService.inviteCsv(weddingId),
          settingsExportService.questionsCsv(weddingId),
          stateExportService.downloadEventsCsv(weddingId, "import"),
          stateExportService.downloadGuestsCsv(weddingId, "import"),
        ],
        // A few at a time: each is one or more round trips to D1, and the
        // Worker holds every file's rows until the archive is written.
        { concurrency: 4 },
      );
      const data = [
        dataFile("wedding.csv", weddingCsv),
        dataFile("guests.csv", guestsCsv),
        dataFile("households.csv", householdsCsv, {
          count: counts.households,
          ceiling: MAX_HOUSEHOLD_EXPORT_ROWS,
        }),
        dataFile("events.csv", eventsCsv),
        dataFile("rsvps.csv", toCsv(rsvps)),
        dataFile("seating.csv", seatingCsv, {
          count: counts.seats,
          ceiling: MAX_SEATING_EXPORT_ROWS,
        }),
        dataFile("seating-plans.csv", seatingPlansCsv, {
          count: counts.planRows,
          ceiling: MAX_SEATING_EXPORT_ROWS,
        }),
        dataFile("registry.csv", registryCsv, {
          count: counts.registry,
          ceiling: MAX_REGISTRY_EXPORT_ROWS,
        }),
        dataFile("gifts.csv", giftsCsv, { count: counts.gifts, ceiling: MAX_GIFT_EXPORT_ROWS }),
        dataFile("budget.csv", budgetCsv, {
          count: counts.budget,
          ceiling: MAX_PLANNING_EXPORT_ROWS,
        }),
        dataFile("tasks.csv", tasksCsv, { count: counts.tasks, ceiling: MAX_PLANNING_EXPORT_ROWS }),
        dataFile("vendors.csv", vendorsCsv, {
          count: counts.vendors,
          ceiling: MAX_VENDOR_EXPORT_ROWS,
        }),
        dataFile("invite.csv", inviteCsv),
        dataFile("questions.csv", questionsCsv, {
          count: counts.questions,
          ceiling: MAX_QUESTION_EXPORT_ROWS,
        }),
        dataFile("for-import/events.csv", importEventsCsv),
        dataFile("for-import/guests.csv", importGuestsCsv),
      ];
      return {
        folder: `cire-wedding-${counts.slug}/`,
        wedding: { id: weddingId, name: counts.name, slug: counts.slug },
        createdAt: now,
        data,
        files,
      };
    }).pipe(Effect.withSpan("cire.wedding.archive.read"));
  },

  /**
   * The archive as a byte stream, one entry per pull (a high-water mark of
   * zero, so nothing is fetched before the reader asks): the README, each CSV,
   * each R2 object the limits admit, then the manifest and the ZIP's central
   * directory. A failure the entries cannot absorb errors the stream, so the
   * download ends without the central directory and no reader takes it for a
   * whole archive.
   */
  stream(
    plan: ArchivePlan,
    sources: ArchiveSources,
    limits: ArchiveLimits = ARCHIVE_LIMITS,
  ): ReadableStream<Uint8Array> {
    const zip = new StoredZip();
    const listed: { what: string; path: string | null; status: WeddingArchiveFileStatus }[] = [];
    const encoder = new TextEncoder();
    const entry = (path: string, bytes: Uint8Array) =>
      zip.add(`${plan.folder}${path}`, bytes, plan.createdAt);
    const record = (file: PlannedFile, status: WeddingArchiveFileStatus, path: string | null) => {
      listed.push({ what: file.what, path, status });
      metricWeddingArchiveFile(status);
    };

    let reads = 0;
    let bytesIn = 0;
    /** Fetches one planned object, if the limits and the bucket allow; null when left out. */
    const fetchFile = async (
      file: PlannedFile,
    ): Promise<{ path: string; bytes: Uint8Array } | null> => {
      const leftOut = (status: WeddingArchiveFileStatus) => {
        record(file, status, null);
        return null;
      };
      const source = file.bucket === "assets" ? sources.assets : sources.sheets;
      if (!source) return leftOut("unavailable");
      if (reads >= limits.files) return leftOut("over_limit");
      reads += 1;
      let bytes: Uint8Array;
      let extension = file.extension ?? "bin";
      try {
        if (file.bucket === "assets") {
          const object = await (source as ArchiveAssetsSource).get(file.key);
          if (!object) return leftOut("missing");
          const buffer = await object.arrayBuffer();
          bytes = new Uint8Array(buffer);
          const type = object.httpMetadata?.contentType ?? detectImageType(buffer) ?? "";
          extension = IMAGE_EXTENSIONS.get(type) ?? "bin";
        } else {
          const object = await (source as ArchiveSheetsSource).get(file.key);
          if (!object) return leftOut("missing");
          bytes = encoder.encode(await object.text());
        }
      } catch {
        return leftOut("unreadable");
      }
      if (bytesIn + bytes.byteLength > limits.bytes) return leftOut("over_limit");
      bytesIn += bytes.byteLength;
      const path = `${file.stem}.${extension}`;
      record(file, "included", path);
      return { path, bytes };
    };

    async function* entries(): AsyncGenerator<Uint8Array[]> {
      yield entry("README.txt", encoder.encode(README(plan.wedding.name, plan.createdAt)));
      for (const file of plan.data) yield entry(file.path, encoder.encode(file.text));
      for (const file of plan.files) {
        // oxlint-disable-next-line no-await-in-loop -- one object at a time keeps one in memory
        const fetched = await fetchFile(file);
        if (fetched) yield entry(fetched.path, fetched.bytes);
      }
      const manifest = {
        format: "cire-wedding-archive",
        version: 1,
        wedding: plan.wedding,
        createdAt: plan.createdAt.toISOString(),
        data: plan.data.map(({ text: _text, ...file }) => file),
        files: listed,
        limits,
      };
      yield entry("manifest.json", encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`));
      yield zip.end();
    }

    const steps = entries();
    const weddingId = plan.wedding.id;
    return new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            for (;;) {
              // oxlint-disable-next-line no-await-in-loop -- steps are inherently sequential
              const step = await steps.next();
              if (step.done) {
                metricWeddingArchiveDownload("ok");
                controller.close();
                return;
              }
              for (const chunk of step.value) controller.enqueue(chunk);
              return;
            }
          } catch (cause) {
            metricWeddingArchiveDownload("error");
            await runCire(
              Effect.logError("wedding archive stream failed").pipe(
                Effect.annotateLogs({ weddingId }),
              ),
            );
            controller.error(cause);
          }
        },
        async cancel() {
          await steps.return(undefined);
        },
      },
      { highWaterMark: 0 },
    );
  },
};
