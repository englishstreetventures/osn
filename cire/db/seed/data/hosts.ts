// Co-hosts on the sample wedding. Consumed only by cire/db/seed/generate.ts.
//
// The OWNER is not a row here — ownership lives in `weddings.owner_osn_profile_id`
// (DEV_OWNER_PROFILE_ID). `wedding_hosts` holds the people the owner has SHARED
// the wedding with, and the app only ever writes `editor` or `viewer` to it.
// The live wedding has three; without them the organiser portal's sharing
// surface renders empty on dev and its permission split goes untested.
//
// The profile ids are fixed dev ids in the same `usr_*` shape OSN issues. No
// real OSN profile exists on the dev tier, so these never resolve to an account
// — that is fine: the portal reads them as opaque ids.

export type SeedHost = {
  readonly id: string;
  readonly osnProfileId: string;
  readonly role: "editor" | "viewer";
};

export const hosts = [
  {
    id: "whost_d1f0c4a2-0000-4000-8000-000000000001",
    osnProfileId: "usr_dev_cohost_partner",
    role: "editor",
  },
  {
    id: "whost_d1f0c4a2-0000-4000-8000-000000000002",
    osnProfileId: "usr_dev_cohost_planner",
    role: "editor",
  },
  {
    id: "whost_d1f0c4a2-0000-4000-8000-000000000003",
    osnProfileId: "usr_dev_cohost_viewer",
    role: "viewer",
  },
] as const satisfies readonly SeedHost[];
