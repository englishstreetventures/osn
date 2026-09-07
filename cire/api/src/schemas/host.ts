import { Effect, Schema } from "effect";

/** A co-host's assignable role — mirrors `HostRole` in `services/hosts.ts`.
 *  `owner` is not assignable (the owner is never rowed into `wedding_hosts`)
 *  and the legacy `host` value is not accepted from clients. */
export const HostRoleSchema = Schema.Literals(["editor", "viewer"]);
export type HostRoleSchema = Schema.Schema.Type<typeof HostRoleSchema>;

/**
 * Body for `POST /api/organiser/weddings/:weddingId/hosts`. The wedding comes
 * from the route + ownership gate; the inputs are the OSN handle to add as a
 * co-host and the role to grant. osn-api owns handle normalisation (strips `@`,
 * lowercases), so this just trims and bounds the length — a handle is ≤30
 * chars, plus a possible `@`, so 64 is a generous ceiling that caps the query
 * param. `role` defaults to `editor` — the pre-roles behaviour every existing
 * co-host had (full module writes) — so older portal builds that don't send it
 * keep working unchanged.
 */
export const AddHostBody = Schema.Struct({
  handle: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  role: HostRoleSchema.pipe(Schema.withDecodingDefaultType(Effect.succeed("editor" as const))),
});
export type AddHostBody = Schema.Schema.Type<typeof AddHostBody>;

/** Body for `PUT /api/organiser/weddings/:weddingId/hosts/:osnProfileId/role`. */
export const UpdateHostRoleBody = Schema.Struct({
  role: HostRoleSchema,
});
export type UpdateHostRoleBody = Schema.Schema.Type<typeof UpdateHostRoleBody>;
