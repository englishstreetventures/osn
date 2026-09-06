import { eslintCompatPlugin } from "@oxlint/plugins";

import { noInOperatorKeyGuardRule } from "./rules/no-in-operator-key-guard.ts";
import { noNonSubscribingStoreReadRule } from "./rules/no-non-subscribing-store-read.ts";

/** House Oxlint rules — repo-specific rules, kept out of the vendored anti-slop tree. */
const housePlugin = eslintCompatPlugin({
  meta: { name: "house" },
  rules: {
    "no-in-operator-key-guard": noInOperatorKeyGuardRule,
    "no-non-subscribing-store-read": noNonSubscribingStoreReadRule,
  },
});

export default housePlugin;
