import { describe, expect, it } from "vitest";

import { renderTemplate } from "../src/templates";

describe("r2-reconcile-alert", () => {
  it("names a held bucket, both counts, the runs left and the stop command", () => {
    const out = renderTemplate("r2-reconcile-alert", {
      kind: "held",
      env: "production",
      bucket: "cire-sheets",
      referencingRows: 40,
      previousRows: 100,
      heldRuns: 2,
      runsLeft: 5,
    });
    expect(out.subject).toBe(
      "Cire: cire-sheets orphan deletion held — referencing rows fell from 100 to 40",
    );
    expect(out.text).toContain("held for 2 runs");
    expect(out.text).toContain("5 more runs");
    expect(out.text).toContain(
      "bunx wrangler r2 object put cire-sheets/reconcile/stop --pipe --remote",
    );
    expect(out.text).toContain("wiki/compliance/backup-dr.md");
    expect(out.html).toContain("cire-sheets/reconcile/stop");
  });

  it("says when a hold has ended and deleting resumes", () => {
    const out = renderTemplate("r2-reconcile-alert", {
      kind: "released",
      env: "production",
      bucket: "cire-assets",
      referencingRows: 30,
      previousRows: 100,
    });
    expect(out.subject).toBe("Cire: cire-assets orphan deletion resumed after its hold");
    expect(out.text).toContain("30");
    expect(out.text).toContain("100");
  });

  it("reports how long a stop object has been in place, and how to lift it", () => {
    const out = renderTemplate("r2-reconcile-alert", {
      kind: "stopped",
      env: "dev",
      bucket: "cire-sheets-dev",
      stoppedDays: 3,
    });
    expect(out.subject).toBe("Cire (dev): cire-sheets-dev orphan deletion stopped for 3 days");
    expect(out.text).toContain(
      "bunx wrangler r2 object delete cire-sheets-dev/reconcile/stop --remote",
    );
    expect(out.text).toContain("14 days");
  });

  it("uses the singular for one day and one run", () => {
    const stopped = renderTemplate("r2-reconcile-alert", {
      kind: "stopped",
      env: "production",
      bucket: "cire-assets",
      stoppedDays: 1,
    });
    expect(stopped.subject).toBe("Cire: cire-assets orphan deletion stopped for 1 day");
    const held = renderTemplate("r2-reconcile-alert", {
      kind: "held",
      env: "production",
      bucket: "cire-assets",
      referencingRows: 1,
      previousRows: 3,
      heldRuns: 1,
      runsLeft: 1,
    });
    expect(held.text).toContain("held for 1 run");
    expect(held.text).toContain("1 more run");
  });

  it("points a tier-wide stop at wrangler.toml", () => {
    const out = renderTemplate("r2-reconcile-alert", { kind: "disabled", env: "production" });
    expect(out.subject).toBe("Cire: R2 orphan deletion disabled for this tier");
    expect(out.text).toContain("CIRE_R2_RECONCILE_DISABLED");
    expect(out.text).toContain("cire/api/wrangler.toml");
  });
});
