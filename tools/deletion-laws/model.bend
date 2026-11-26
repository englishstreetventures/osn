# The deletion model, whole: `bend model.bend -o model.mjs` compiles every def
# below and in the five modules it imports into one ES module, each export
# named `<module>:<def>`. The agreement tests in osn/api/tests/laws and
# cire/api/tests/laws import that module.

import Base
import ./account.bend as Account
import ./choices.bend as Choices
import ./holds.bend as Holds
import ./succession.bend as Succession
import ./weddings.bend as Weddings
