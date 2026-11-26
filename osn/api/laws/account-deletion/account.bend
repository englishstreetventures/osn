# One account's deletion in osn-api, from the request to the hard delete.
#
#   Live --Ask, verdict Ok--> Scheduled --Keep, inside the window--> Live
#   Scheduled --FanOut, window passed--> Scheduled, claimed, apps marked
#   Scheduled --Sweep, window passed, every app finished--> Erased
#
# The code: requestErasure, cancelErasure, runFanOutRetrySweep and
# runHardDeleteSweep in osn/api/src/services/account-erasure.ts; the verdict in
# routes/account-erasure.ts and choices.bend. Each event is one service call,
# taken whole: what happens between the statements of one call is not
# modelled. Times are unix seconds. A job's id is the account's count of
# requests, standing for the random `job_id` the code gives every job.

import Base
import ./choices.bend as Choices

# An app's mark on the job (`pulse_done_at`, `zap_done_at`, `cire_done_at`):
# pending (NULL), or finished with the app's answer, or skipped because the
# tier does not run the app.
type Mark is Data:
  Pending{}
  Confirmed{}
  Skipped{}

# What an app does with one erasure call: answers within the contract, fails
# (no answer, an error, an answer outside the contract, or no URL on a
# deployed tier), or is declared absent on this tier.
type Reply is Data:
  Answers{}
  Fails{}
  Absent{}

type Acct is Data:
  Live{next: Nat}
  Scheduled{job: Nat, due: Nat, claimed: Bool, pulse: Mark, zap: Mark, cire: Mark, everything: Bool, next: Nat}
  Erased{job: Nat, due: Nat, at: Nat, pulse: Mark, zap: Mark, cire: Mark}

# `Keep` is a cancel that read the job `read`; `FanOut` is one fan-out pass
# with each app's reply; `Sweep` is one hard-delete pass.
type Ev is Data:
  Ask{now: Nat, req: Choices.Req}
  Keep{now: Nat, read: Nat}
  FanOut{now: Nat, pulse: Reply, zap: Reply, cire: Reply}
  Sweep{now: Nat}

# Seven days (account-erasure.ts:82).
def window() -> Nat:
  604800n

def init() -> Acct:
  Live{0n}

def waiting(m: Mark) -> Bool:
  match m:
    case Pending{}:
      True{}
    case Confirmed{}:
      False{}
    case Skipped{}:
      False{}

def finished(m: Mark) -> Bool:
  Bool.not(waiting(m))

# A mark is written only while it reads pending (account-erasure.ts:1138), and
# a failure leaves it pending for the next pass (:1324).
def finish(m: Mark, r: Reply) -> Mark:
  match m:
    case Pending{}:
      match r:
        case Answers{}:
          Confirmed{}
        case Fails{}:
          Pending{}
        case Absent{}:
          Skipped{}
    case Confirmed{}:
      Confirmed{}
    case Skipped{}:
      Skipped{}

# requestErasure (:277-505) behind the route's verdict: a new job, every mark
# pending, the hard delete seven days on.
def ask(+now: Nat, +req: Choices.Req, +next: Nat) -> Acct:
  Bool.pick(Acct, Choices.is_ok(Choices.verdict(req)),
    Scheduled{next, Nat.add(now, window()), False{}, Pending{}, Pending{}, Pending{}, Choices.everything_of(req), 1n+next},
    Live{next})

# cancelErasure (:540-693): the job it read, while no sweep has claimed it and
# the window is open.
def keep(+now: Nat, +read: Nat, +job: Nat, +due: Nat, +claimed: Bool, +p: Mark, +z: Mark, +c: Mark, +ev: Bool, +next: Nat) -> Acct:
  Bool.pick(Acct, (Nat.is_eq(read, job) && Bool.not(claimed)) && Nat.is_lt(now, due),
    Live{next},
    Scheduled{job, due, claimed, p, z, c, ev, next})

# runFanOut (:1301-1325) on a job whose window has passed and that some app
# has not finished (:2053): the claim first (:1314-1316), then every pending
# app at once. The apps are independent and alike, so they are one parallel
# call.
def fan_out(+now: Nat, rp: Reply, rz: Reply, rc: Reply, +job: Nat, +due: Nat, +claimed: Bool, +p: Mark, +z: Mark, +c: Mark, +ev: Bool, +next: Nat) -> Acct:
  p2 z2 c2 = finish(p, rp) finish(z, rz) finish(c, rc)
  Bool.pick(Acct, Nat.is_le(due, now) && ((waiting(p) || waiting(z)) || waiting(c)),
    Scheduled{job, due, True{}, p2, z2, c2, ev, next},
    Scheduled{job, due, claimed, p, z, c, ev, next})

# The hard delete (:1618-1694, :1738-1950): only a job whose window has passed
# and whose every app reads finished (:1650, :1205, :1880).
def sweep(+now: Nat, +job: Nat, +due: Nat, +claimed: Bool, +p: Mark, +z: Mark, +c: Mark, +ev: Bool, +next: Nat) -> Acct:
  Bool.pick(Acct, Nat.is_le(due, now) && ((finished(p) && finished(z)) && finished(c)),
    Erased{job, due, now, p, z, c},
    Scheduled{job, due, claimed, p, z, c, ev, next})

def step(s: Acct, e: Ev) -> Acct:
  match s:
    case Live{next}:
      match e:
        case Ask{now, req}:
          ask(now, req, next)
        case Keep{now, read}:
          Live{next}
        case FanOut{now, rp, rz, rc}:
          Live{next}
        case Sweep{now}:
          Live{next}
    case Scheduled{job, due, claimed, p, z, c, ev, next}:
      match e:
        case Ask{now, req}:
          Scheduled{job, due, claimed, p, z, c, ev, next}
        case Keep{now, read}:
          keep(now, read, job, due, claimed, p, z, c, ev, next)
        case FanOut{now, rp, rz, rc}:
          fan_out(now, rp, rz, rc, job, due, claimed, p, z, c, ev, next)
        case Sweep{now}:
          sweep(now, job, due, claimed, p, z, c, ev, next)
    case Erased{job, due, at, p, z, c}:
      Erased{job, due, at, p, z, c}

def run(es: List<Ev>, s: Acct) -> Acct:
  match es:
    case Nil{}:
      s
    case e <> rest:
      run(rest, step(s, e))
