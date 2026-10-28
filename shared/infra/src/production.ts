import { Data } from "effect";

import { PRODUCTION_ADOPTIONS } from "./production-sites";
import { tierOf } from "./stage";

export class ProductionNotAdoptedError extends Data.TaggedError("ProductionNotAdoptedError")<{
  /** The Worker, database or bucket name. */
  readonly resource: string;
  readonly message: string;
}> {}

export class ProductionScopeError extends Data.TaggedError("ProductionScopeError")<{
  readonly stage: string;
  /** The logical ids the stack declared outside its allowed set. */
  readonly logicalIds: readonly string[];
  readonly message: string;
}> {}

/**
 * Throws ProductionNotAdoptedError for a production resource whose name is
 * not in `adoptions`. A production API Worker, database or bucket already
 * exists, so declaring one adopts it, and each adoption is its own step of
 * phase P3 (englishstreetventures/osn#1490), reviewed through its own plan.
 */
export function refuseUnadopted(
  resource: string,
  stage: string,
  adoptions: readonly string[] = PRODUCTION_ADOPTIONS,
): void {
  if (tierOf(stage) === "production" && !adoptions.includes(resource)) {
    throw new ProductionNotAdoptedError({
      resource,
      message: `${resource} is a production resource no step has adopted: add it to PRODUCTION_ADOPTIONS in the change that adopts it.`,
    });
  }
}

/** What `assertProductionScope` reads of a declared resource. */
export interface Scoped {
  readonly LogicalId: string;
}

/**
 * The scope check a stack makes at the end of its production body: throws
 * ProductionScopeError, naming them, when the stage is production and any
 * resource's logical id is not in `allowed` (the stack's
 * PRODUCTION_RESOURCE_KINDS). Dev and investigation stages pass.
 */
export function assertProductionScope(input: {
  readonly stage: string;
  readonly resources: readonly Scoped[];
  readonly allowed: readonly string[];
}): void {
  if (tierOf(input.stage) !== "production") return;
  const logicalIds = input.resources
    .map((resource) => resource.LogicalId)
    .filter((logicalId) => !input.allowed.includes(logicalId));
  if (logicalIds.length > 0) {
    throw new ProductionScopeError({
      stage: input.stage,
      logicalIds,
      message: `The production stack declares resources outside its scope: ${logicalIds.join(", ")}.`,
    });
  }
}
