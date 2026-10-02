// The downloads a locked module still offers its owner.
//
// The budget, the checklist and the registry are Gold modules, reads included,
// so a wedding below Gold cannot open them. It keeps the rows it entered
// before, and the API hands them back as CSV whatever the tier (`GET
// …/budget.csv`, `GET …/tasks.csv`, `GET …/gifts.csv`, owner only). The locked
// nav row's card offers the file when `GET …/module-rows` says there is
// something in it.
//
// `authFetch` is a PARAMETER, never an import, as in `upgrade-api.ts`: it lives
// in the AuthProvider context so the session cookie rides along.
import { apiUrl, weddingPath } from "./api";
import type { Module } from "./dashboard-route";
import { downloadBlob } from "./download";

export type AuthFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** How many rows each file would carry, as `GET …/module-rows` answers. */
export interface ModuleRows {
  budgetLines: number;
  tasks: number;
  gifts: number;
}

/** One locked module's download. */
export interface LockedExport {
  /** The file's path under the wedding, as `weddingPath` takes it. */
  path: "/budget.csv" | "/tasks.csv" | "/gifts.csv";
  /** The saved file is `cire-<stem>-<wedding slug>.csv`, the name the API's
   *  Content-Disposition gives it. */
  stem: "budget" | "tasks" | "gifts";
  /** Which count says the file has rows. */
  count: keyof ModuleRows;
  /** What the file is, for the toast that says it saved. */
  label: string;
  /** The rows, named for the card's sentence. */
  noun: { one: string; many: string };
}

/** The modules whose card offers a download while locked. A wedding can hold
 *  gifts only once it has been on Gold, so the Registry card offers one only
 *  after an operator has moved a wedding back down. Vendors offers no export. */
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
  registry: {
    path: "/gifts.csv",
    stem: "gifts",
    count: "gifts",
    label: "Gift log",
    noun: { one: "gift", many: "gifts" },
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
export async function fetchModuleRows(
  authFetch: AuthFetch,
  weddingId: string,
): Promise<ModuleRows> {
  const res = await authFetch(apiUrl(weddingPath(weddingId, "/module-rows")));
  if (!res.ok) throw new LockedExportError(res.status);
  const body = (await res.json()) as { budgetLines?: unknown; tasks?: unknown; gifts?: unknown };
  return {
    budgetLines: asCount(body.budgetLines),
    tasks: asCount(body.tasks),
    gifts: asCount(body.gifts),
  };
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
