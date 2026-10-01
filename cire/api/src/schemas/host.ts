import { Effect, Schema } from "effect";

/** A seat's assignable role — mirrors `AssignableHostRole` in
 *  `services/hosts.ts`, which the route proves by passing a decoded `role`
 *  straight into `hostsService.add()`. `owner` is accepted: every route that
 *  takes this is `weddingOwner()`, and only an owner makes an owner. The
 *  legacy `host` value is not accepted from clients. */
export const HostRoleSchema = Schema.Literals(["owner", "editor", "viewer", "helper"]);
export type HostRoleSchema = Schema.Schema.Type<typeof HostRoleSchema>;

/**
 * Body for `POST /api/organiser/weddings/:weddingId/hosts`. The wedding comes
 * from the route + owner gate; the inputs are the OSN handle to seat and the
 * role to grant — `owner` included, which is how a second owner is invited.
 * osn-api owns handle normalisation (strips `@`, lowercases), so this just
 * trims and bounds the length — a handle is ≤30 chars, plus a possible `@`, so
 * 64 is a generous ceiling that caps the query param. `role` defaults to
 * `viewer`: a seat is created at the level that can
 * read the dashboard and change nothing, and is raised afterwards by an owner
 * through `PUT …/role`. A body that names no role is asking for the least the
 * portal can give someone, not the most.
 */
export const AddHostBody = Schema.Struct({
  handle: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  role: HostRoleSchema.pipe(Schema.withDecodingDefaultType(Effect.succeed("viewer" as const))),
});
export type AddHostBody = Schema.Schema.Type<typeof AddHostBody>;

/** Body for `PUT /api/organiser/weddings/:weddingId/hosts/:osnProfileId/role`. */
export const UpdateHostRoleBody = Schema.Struct({
  role: HostRoleSchema,
});
export type UpdateHostRoleBody = Schema.Schema.Type<typeof UpdateHostRoleBody>;
