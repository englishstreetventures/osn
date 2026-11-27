# osn-api's deletion model: `bend model.bend -o model.mjs` compiles every def
# in the four modules it imports into one ES module, each export named
# `<module>:<def>`. The agreement tests in osn/api/tests/laws import it.

import Base
import ./account.bend as Account
import ./choices.bend as Choices
import ./holds.bend as Holds
import ./succession.bend as Succession
