// Whether this checkout's origin is englishstreetventures/osn, worked out once
// per session from `git config --get remote.origin.url`.
export type RepoGate = "on" | "off";

export type GateStatus = "pass" | "fail" | "pending" | "info";

// One row of the `## Gates` section of NEW-FEAT.md.
export type Gate = { label: string; status: GateStatus };

export type ChangesetVerdict = "present" | "missing" | "not-needed" | "unknown";

// What one automatic refresh read from git and NEW-FEAT.md. A count or a ref
// git could not give is null, never zero.
export type Snapshot = {
  root: string;
  branch: string;
  head: string | null;
  // A digest of `git status --porcelain`, null when git status failed.
  statusMark: string | null;
  issue: string | null;
  complexity: string | null;
  hasPlan: boolean;
  gates: Gate[];
  ahead: number | null;
  changedFiles: number | null;
  dirtyFiles: number | null;
  changeset: ChangesetVerdict;
  refreshedAt: number;
};

export type CheckVerdict = "pass" | "fail" | "not-run" | "timed-out" | "could-not-start";

export type CheckRow = { name: string; verdict: CheckVerdict; detail: string | null };

// The last `/gates` run: the HEAD and working tree it ran on, when, and each
// check's verdict. Stale once a later tool call or measure says the tree moved.
export type Checks = {
  head: string | null;
  statusMark: string | null;
  at: number;
  isRunning: boolean;
  isStale: boolean;
  rows: CheckRow[];
};

export type CiVerdict = "passing" | "failing" | "pending";

export type ReviewVerdict = "approved" | "changes-requested" | "review-required";

export type PrState = "open" | "merged" | "closed";

// The branch's pull request as `gh` last answered, or why it could not.
export type PrView =
  | {
      kind: "found";
      number: number;
      state: PrState;
      ci: CiVerdict;
      review: ReviewVerdict | null;
      // Unresolved review threads, `100+` past one page; null when unread.
      threads: string | null;
      url: string;
    }
  | { kind: "gh-error"; line: string }
  | { kind: "gh-missing" }
  | { kind: "gh-timed-out" };

declare module "claude-code" {
  interface PluginState {
    "branch-gates": {
      // oxlint-disable anti-slop/no-shape-in-symbol-names -- `Shaped` is the engine's own name for a tagged state value
      repo: Shaped<RepoGate | null>;
      snapshot: Shaped<Snapshot | null>;
      checks: Shaped<Checks | null>;
      pr: Shaped<PrView | null>;
      // oxlint-enable anti-slop/no-shape-in-symbol-names
      fault: string | null;
    };
  }
}
