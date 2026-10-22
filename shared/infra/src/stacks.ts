import type { WorkerKey } from "./secrets/inventory";

/** One Alchemy stack per product directory: `musubi/infra`, `cire/infra`, `zap/infra`, `pulse/infra`. */
export type StackKey = "cire" | "musubi" | "zap" | "pulse";

/** One value per stack: `Readonly<Record<StackKey, T>>` under a name. */
export interface PerStack<T> {
  readonly cire: T;
  readonly musubi: T;
  readonly zap: T;
  readonly pulse: T;
}

/** Every stack, in deploy order. */
export const STACK_KEYS: readonly StackKey[] = ["musubi", "cire", "zap", "pulse"];

/** The inventory Workers each stack deploys. */
export const STACK_WORKERS: PerStack<readonly WorkerKey[]> = {
  musubi: ["osn-api"],
  cire: ["cire-api", "cire-invites"],
  zap: ["zap-api"],
  pulse: [],
};

/**
 * The step of a stack job that reads a secret for the stack itself, by id:
 * `deploy` runs Alchemy; `cire_seed` derives the musubi seed's values.
 */
export type StackStep = "deploy" | "cire_seed";

/** Secrets a stack's deploy job reads besides its Workers' own, with the step that reads each. */
export const STACK_STEP_SECRETS: PerStack<
  readonly { readonly name: string; readonly step: StackStep }[]
> = {
  // The musubi stack seeds osn-api's database with the cire OIDC client row,
  // which stores the client secret's hash, and with cire-api's ARC key id and
  // public key. The cire_seed step alone holds these three and derives the
  // hash and the public key (musubi/infra/scripts/derive-cire-seed.ts), so
  // the deploy step, and every package Alchemy loads, holds neither secret.
  musubi: [
    { name: "CIRE_OIDC_CLIENT_SECRET", step: "cire_seed" },
    { name: "CIRE_API_ARC_KEY_ID", step: "cire_seed" },
    { name: "CIRE_API_ARC_PRIVATE_KEY", step: "cire_seed" },
  ],
  cire: [],
  zap: [],
  pulse: [],
};
