/**
 * The lab's pure helpers.
 *
 * Stories themselves carry no gate — nothing in CI renders one, by design. But
 * `titleFromPath` names every row in the sidebar and `inferControl` picks every
 * editor in the args panel, and both fail quietly: a wrong title still renders,
 * a wrong control still accepts input. Those are worth pinning.
 */
import { describe, expect, it } from "vitest";

import { inferControl } from "../src/lab/infer-control.ts";
import { titleFromPath } from "../src/lab/registry.ts";

describe("titleFromPath", () => {
  it("strips the climb out of tools/lab and the .story extension", () => {
    expect(titleFromPath("../../../../osn/ui/src/components/ui/button.story.tsx")).toBe(
      "osn/ui/components/ui/button",
    );
  });

  it("files a local scratch story under lab/", () => {
    expect(titleFromPath("../stories/three-cube.story.tsx")).toBe("lab/three-cube");
  });

  it("keeps nesting below the stories directory", () => {
    expect(titleFromPath("../stories/osn-ui/overview.story.tsx")).toBe("lab/osn-ui/overview");
  });

  it("accepts every extension the glob can match", () => {
    for (const ext of ["ts", "tsx", "js", "jsx"]) {
      expect(titleFromPath(`../stories/thing.story.${ext}`)).toBe("lab/thing");
    }
  });

  it("drops only the first /src/, so a component directory called src survives", () => {
    expect(titleFromPath("../../../../pulse/web/src/components/src/thing.story.tsx")).toBe(
      "pulse/web/components/src/thing",
    );
  });
});

describe("inferControl", () => {
  it("reads the editor off the value's type", () => {
    expect(inferControl(true)).toEqual({ kind: "boolean" });
    expect(inferControl(12)).toEqual({ kind: "number" });
    expect(inferControl("Continue")).toEqual({ kind: "text" });
  });

  it("treats a hex string as a colour", () => {
    expect(inferControl("#7c5cff")).toEqual({ kind: "color" });
    expect(inferControl("#fff")).toEqual({ kind: "color" });
  });

  it("gives a long string room to breathe", () => {
    expect(inferControl("x".repeat(41))).toEqual({ kind: "textarea" });
    expect(inferControl("x".repeat(40))).toEqual({ kind: "text" });
  });
});
