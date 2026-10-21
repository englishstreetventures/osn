import { RemovalPolicy } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";

import { removalFor } from "./removal";
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

export const apiWorker = (id: string, input: ApiWorkerInput) =>
  Cloudflare.Worker(id, apiWorkerProps(input)).pipe(
    RemovalPolicy.retain(removalFor("worker", input.stage) === "retain"),
  );

export const siteWorker = (id: string, input: SiteWorkerInput) =>
  Cloudflare.Worker(id, siteWorkerProps(input)).pipe(
    RemovalPolicy.retain(removalFor("worker", input.stage) === "retain"),
  );

export const retainedD1 = (id: string, input: RetainedD1Input) =>
  Cloudflare.D1.Database(id, retainedD1Props(input)).pipe(RemovalPolicy.retain());

export const retainedBucket = (id: string, input: RetainedBucketInput) =>
  Cloudflare.R2.Bucket(id, retainedBucketProps(input)).pipe(RemovalPolicy.retain());
