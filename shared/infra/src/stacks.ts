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

/** Secrets a stack's deploy job reads besides its Workers' own, with the step that reads each. */
export const STACK_STEP_SECRETS: PerStack<
  readonly { readonly name: string; readonly step: "deploy" }[]
> = {
  // The musubi stack seeds osn-api's database with the cire OIDC client row,
  // whose hash it computes from the client secret, and with cire-api's ARC
  // public key, which it derives from the private key.
  musubi: [
    { name: "CIRE_OIDC_CLIENT_SECRET", step: "deploy" },
    { name: "CIRE_API_ARC_KEY_ID", step: "deploy" },
    { name: "CIRE_API_ARC_PRIVATE_KEY", step: "deploy" },
  ],
  cire: [],
  zap: [],
  pulse: [],
};
