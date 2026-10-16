import { Data } from "effect";

import { isLongLivedStage } from "./stage";

export type Removal = "retain" | "destroy";

/**
 * Storage is always retained. A Worker on a long-lived stage (dev, production) is retained, since
 * deleting it deletes its secrets too; an investigation stage's Workers are
 * destroyed with the stage.
 */
export function removalFor(kind: "storage" | "worker", stage: string): Removal {
  return kind === "storage" || isLongLivedStage(stage) ? "retain" : "destroy";
}

export class UnretainedResourceError extends Data.TaggedError("UnretainedResourceError")<{
  readonly logicalIds: readonly string[];
  readonly message: string;
}> {}

/** What `assertRetained` reads of a declared resource. */
export interface Retainable {
  readonly LogicalId: string;
  readonly RemovalPolicy: string;
}

/**
 * Throws unless every resource given will be retained on destroy and on
 * replacement. `assertStackRetained` calls it with every resource the stage
 * must keep, so a lost `retain()` fails the plan instead of a destroy.
 */
export function assertRetained(resources: readonly Retainable[]): void {
  const logicalIds = resources
    .filter((resource) => resource.RemovalPolicy !== "retain")
    .map((resource) => resource.LogicalId);
  if (logicalIds.length > 0) {
    throw new UnretainedResourceError({
      logicalIds,
      message: `These resources would be deleted on destroy or replacement: ${logicalIds.join(", ")}.`,
    });
  }
}

/**
 * The retention check every stack makes at the end of its body: its storage
 * on every stage, and its Workers wherever the stage keeps them. An
 * investigation stage's Workers are destroyed with it, so there only the
 * storage must be retained.
 */
export function assertStackRetained(input: {
  readonly stage: string;
  readonly storage: readonly Retainable[];
  readonly workers: readonly Retainable[];
}): void {
  assertRetained(
    removalFor("worker", input.stage) === "retain"
      ? [...input.storage, ...input.workers]
      : input.storage,
  );
}
