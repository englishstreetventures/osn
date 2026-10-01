// Everyone seated on the sample wedding. Consumed by cire/db/seed/generate.ts.
//
// The first row is the OWNER: ownership is a seat with role `owner`, held by
// DEV_OWNER_PROFILE_ID under the fixed id DEV_OWNER_SEAT_ID, which
// `scripts/cire-db-seed.sh` repoints at a real account. The rest are the people
// the owner shared the wedding with. The live wedding has three; without them
// the organiser portal's sharing surface renders empty on dev and its
// permission split goes untested.
//
// The profile ids are fixed dev ids in the same `usr_*` shape OSN issues. No
// real OSN profile exists on the dev tier, so these never resolve to an account
// — that is fine: the portal reads them as opaque ids.

import { DEV_OWNER_PROFILE_ID, DEV_OWNER_SEAT_ID } from "./wedding";

export type SeedHost = {
  readonly id: string;
  readonly osnProfileId: string;
  readonly role: "owner" | "editor" | "viewer";
};

export const hosts = [
  {
    id: DEV_OWNER_SEAT_ID,
    osnProfileId: DEV_OWNER_PROFILE_ID,
    role: "owner",
  },
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
