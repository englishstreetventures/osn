// The downloads a locked module still offers its owner.
//
// The budget and the checklist are Gold modules, reads included, so a wedding
// below Gold cannot open them. It keeps the rows it entered before, and the API
// hands them back as CSV whatever the tier (`GET …/budget.csv`, `GET
// …/tasks.csv`, owner only). The locked nav row's card offers the file when
// `GET …/planning-rows` says there is something in it.
//
// `authFetch` is a PARAMETER, never an import, as in `upgrade-api.ts`: it lives
// in the AuthProvider context so the session cookie rides along.
import { apiUrl, weddingPath } from "./api";
import type { Module } from "./dashboard-route";
import { downloadBlob } from "./download";

export type AuthFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** How many rows each file would carry, as `GET …/planning-rows` answers. */
export interface PlanningRows {
  budgetLines: number;
  tasks: number;
}

/** One locked module's download. */
export interface LockedExport {
  /** The file's path under the wedding, as `weddingPath` takes it. */
  path: "/budget.csv" | "/tasks.csv";
  /** The saved file is `cire-<stem>-<wedding slug>.csv`, the name the API's
   *  Content-Disposition gives it. */
  stem: "budget" | "tasks";
  /** Which count says the file has rows. */
  count: keyof PlanningRows;
  /** What the file is, for the toast that says it saved. */
  label: string;
  /** The rows, named for the card's sentence. */
  noun: { one: string; many: string };
}

/** The modules whose card offers a download while locked. The registry is not
 *  one: only a wedding that has been on Gold can hold gifts, and the gift log
 *  has its own ungated `gifts.csv`. Vendors offers no export. */
export const LOCKED_EXPORTS = {
  budget: {
    path: "/budget.csv",
    stem: "budget",
    count: "budgetLines",
    label: "Budget",
    noun: { one: "budget line", many: "budget lines" },
  },
  checklist: {
    path: "/tasks.csv",
    stem: "tasks",
    count: "tasks",
    label: "Checklist",
    noun: { one: "task", many: "tasks" },
  },
} as const satisfies Partial<Record<Module, LockedExport>>;

/** The download a locked module's card offers, or `undefined` for a module
 *  with none. */
export function lockedExportFor(module: Module): LockedExport | undefined {
  return Object.hasOwn(LOCKED_EXPORTS, module)
    ? LOCKED_EXPORTS[module as keyof typeof LOCKED_EXPORTS]
    : undefined;
}

/** A refused or failed request, with the status the API answered. */
export class LockedExportError extends Error {
  constructor(public status: number) {
    super(`http_${status}`);
    this.name = "LockedExportError";
  }
}

const asCount = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;

/** How many budget lines and tasks the wedding holds. Owner only. */
export async function fetchPlanningRows(
  authFetch: AuthFetch,
  weddingId: string,
): Promise<PlanningRows> {
  const res = await authFetch(apiUrl(weddingPath(weddingId, "/planning-rows")));
  if (!res.ok) throw new LockedExportError(res.status);
  const body = (await res.json()) as { budgetLines?: unknown; tasks?: unknown };
  return { budgetLines: asCount(body.budgetLines), tasks: asCount(body.tasks) };
}

/** Download one locked module's file and save it under its usual name. */
export async function downloadLockedExport(
  authFetch: AuthFetch,
  weddingId: string,
  weddingSlug: string,
  spec: LockedExport,
): Promise<void> {
  const res = await authFetch(apiUrl(weddingPath(weddingId, spec.path)));
  if (!res.ok) throw new LockedExportError(res.status);
  downloadBlob(`cire-${spec.stem}-${weddingSlug}.csv`, await res.blob());
}
