import * as Cloudflare from "@alchemy.run/cloudflare";
import { AdoptPolicy, RemovalPolicy } from "alchemy";

import { removalFor } from "./removal";
import { tierOf } from "./stage";
import {
  retainedBucketProps,
  retainedD1Props,
  type RetainedBucketInput,
  type RetainedD1Input,
} from "./storage";
import {
  apiWorkerProps,
  siteWorkerProps,
  type ApiWorkerInput,
  type SiteWorkerInput,
} from "./worker";

/**
 * An API Worker. On production the Worker already exists, deployed outside
 * Alchemy, so it is declared to be adopted: the plan or, when its props wait
 * on storage with no state row yet, the deploy takes it over under its
 * existing name instead of refusing it as someone else's. Nothing else is
 * adopted this way: a D1 database or R2 bucket reads as Alchemy's own, and a
 * site Worker is in state already.
 */
export const apiWorker = (id: string, input: ApiWorkerInput) => {
  const worker = Cloudflare.Worker(id, apiWorkerProps(input)).pipe(
    RemovalPolicy.retain(removalFor("worker", input.stage) === "retain"),
  );
  return tierOf(input.stage) === "production" ? worker.pipe(AdoptPolicy.adopt(true)) : worker;
};

export const siteWorker = (id: string, input: SiteWorkerInput) =>
  Cloudflare.Worker(id, siteWorkerProps(input)).pipe(
    RemovalPolicy.retain(removalFor("worker", input.stage) === "retain"),
  );

export const retainedD1 = (id: string, input: RetainedD1Input) =>
  Cloudflare.D1.Database(id, retainedD1Props(input)).pipe(RemovalPolicy.retain());

export const retainedBucket = (id: string, input: RetainedBucketInput) =>
  Cloudflare.R2.Bucket(id, retainedBucketProps(input)).pipe(RemovalPolicy.retain());
