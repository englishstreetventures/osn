import { eslintCompatPlugin } from "@oxlint/plugins";

import { noInOperatorKeyGuardRule } from "./rules/no-in-operator-key-guard.ts";
import { noNonSubscribingStoreReadRule } from "./rules/no-non-subscribing-store-read.ts";
import { noTrackerRefInCommentRule } from "./rules/no-tracker-ref-in-comment.ts";

/** House Oxlint rules — repo-specific rules, kept out of the vendored anti-slop tree. */
const housePlugin = eslintCompatPlugin({
  meta: { name: "house" },
  rules: {
    "no-in-operator-key-guard": noInOperatorKeyGuardRule,
    "no-non-subscribing-store-read": noNonSubscribingStoreReadRule,
    "no-tracker-ref-in-comment": noTrackerRefInCommentRule,
  },
});

export default housePlugin;
