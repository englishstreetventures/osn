# cire-api's deletion model: `bend model.bend -o model.mjs` compiles every def
# in weddings.bend into one ES module, exports named `weddings:<def>`, beside
# the osn-api choices defs weddings.bend imports, named by their path. The
# agreement test in cire/api/tests/laws imports it.

import Base
import ./weddings.bend as Weddings
