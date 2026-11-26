# cire-api's gift-payout model: `bend model.bend -o model.mjs` compiles every
# def in payout.bend into one ES module, exports named `payout:<def>`. The
# agreement test in cire/api/tests/laws imports it.

import Base
import ./payout.bend as Payout
