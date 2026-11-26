# What the laws in LAWS.bend mean. Change this file only with LAWS.bend: a
# law must not lean on a helper the model or the proofs may rewrite.

import Base
import ./account.bend as Account
import ./choices.bend as Choices
import ./holds.bend as Holds
import ./succession.bend as Succession
import ./weddings.bend as Weddings

def imp(a: Bool, b: Bool) -> Bool:
  Bool.not(a) || b

# Account
# -------

# An erased account was erased at or after the end of its window.
def on_time(s: Account.Acct) -> Bool:
  match s:
    case Account.Live{next}:
      True{}
    case Account.Scheduled{job, due, claimed, p, z, c, ev, next}:
      True{}
    case Account.Erased{job, due, at, p, z, c}:
      Nat.is_le(due, at)

# An erased account's every app either confirmed its erasure or was skipped
# as an app the tier does not run.
def apps_finished(s: Account.Acct) -> Bool:
  match s:
    case Account.Live{next}:
      True{}
    case Account.Scheduled{job, due, claimed, p, z, c, ev, next}:
      True{}
    case Account.Erased{job, due, at, p, z, c}:
      (Account.finished(p) && Account.finished(z)) && Account.finished(c)

# Some app has been reached for the account's erasure.
def reached(s: Account.Acct) -> Bool:
  match s:
    case Account.Live{next}:
      False{}
    case Account.Scheduled{job, due, claimed, p, z, c, ev, next}:
      (Account.finished(p) || Account.finished(z)) || Account.finished(c)
    case Account.Erased{job, due, at, p, z, c}:
      True{}

def is_live(s: Account.Acct) -> Bool:
  match s:
    case Account.Live{next}:
      True{}
    case Account.Scheduled{job, due, claimed, p, z, c, ev, next}:
      False{}
    case Account.Erased{job, due, at, p, z, c}:
      False{}

# A step from a pending deletion back to a live account.
def restored(s: Account.Acct, t: Account.Acct) -> Bool:
  match s:
    case Account.Live{next}:
      False{}
    case Account.Scheduled{job, due, claimed, p, z, c, ev, next}:
      is_live(t)
    case Account.Erased{job, due, at, p, z, c}:
      False{}

# A step from a live account to a pending deletion.
def scheduled(s: Account.Acct, t: Account.Acct) -> Bool:
  match s:
    case Account.Live{next}:
      Bool.not(is_live(t))
    case Account.Scheduled{job, due, claimed, p, z, c, ev, next}:
      False{}
    case Account.Erased{job, due, at, p, z, c}:
      False{}

# A cancel that names the account's pending job, unclaimed, inside its window.
def keeps_in_window(s: Account.Acct, e: Account.Ev) -> Bool:
  match s:
    case Account.Live{next}:
      False{}
    case Account.Scheduled{job, due, claimed, p, z, c, ev, next}:
      match e:
        case Account.Ask{now, req}:
          False{}
        case Account.Keep{now, read}:
          (Nat.is_eq(read, job) && Bool.not(claimed)) && Nat.is_lt(now, due)
        case Account.FanOut{now, rp, rz, rc}:
          False{}
        case Account.Sweep{now}:
          False{}
    case Account.Erased{job, due, at, p, z, c}:
      False{}

def names_job(+read: Nat, s: Account.Acct) -> Bool:
  match s:
    case Account.Live{next}:
      False{}
    case Account.Scheduled{job, due, claimed, p, z, c, ev, next}:
      Nat.is_eq(read, job)
    case Account.Erased{job, due, at, p, z, c}:
      Nat.is_eq(read, job)

# The job a step withdrew: the pending job, when the step left the account live.
def withdrawn(s: Account.Acct, t: Account.Acct) -> Maybe<&2, Nat>:
  match s:
    case Account.Live{next}:
      None{}
    case Account.Scheduled{job, due, claimed, p, z, c, ev, next}:
      match t:
        case Account.Live{n}:
          Some{job}
        case Account.Scheduled{j, d, cl, p2, z2, c2, ev2, n}:
          None{}
        case Account.Erased{j, d, at, p2, z2, c2}:
          None{}
    case Account.Erased{job, due, at, p, z, c}:
      None{}

# The account's job, pending or erased, is `j`.
def revived(m: Maybe<&2, Nat>, s: Account.Acct) -> Bool:
  match m:
    case None{}:
      False{}
    case Some{j}:
      names_job(j, s)

# A request that chose "delete everything" or answered every open action.
def answered(r: Choices.Req) -> Bool:
  match r:
    case Choices.Req{+os, +as, +ps, everything, unchecked}:
      everything || Bool.not(Choices.is_open(os, as, ps))

def asked_answered(e: Account.Ev) -> Bool:
  match e:
    case Account.Ask{now, req}:
      answered(req)
    case Account.Keep{now, read}:
      False{}
    case Account.FanOut{now, rp, rz, rc}:
      False{}
    case Account.Sweep{now}:
      False{}

# Choices
# -------

def offered_org(h: Maybe<&2, Choices.Heir>, +c: Choices.OrgChoice, m: Bool) -> Bool:
  match h:
    case None{}:
      True{}
    case Some{x}:
      Choices.org_offers(x, c) && imp(Choices.is_successor(c), m)

def offered_app(o: Maybe<&2, +List<Nat>>, +c: Nat) -> Bool:
  match o:
    case None{}:
      True{}
    case Some{offers}:
      Choices.has_nat(c, offers)

# Every answer to a listed action names a choice it offers, and a named
# successor is a member from another account.
def offered(p: Choices.Pick, +os: +List<Choices.OrgAct>, +as: +List<Choices.AppAct>) -> Bool:
  match p:
    case Choices.OrgPick{+id, +c, m}:
      offered_org(Choices.find_org(id, os), c, m)
    case Choices.AppPick{+id, +c}:
      offered_app(Choices.find_app(id, as), c)
    case Choices.OtherPick{}:
      True{}

def all_offered(+os: +List<Choices.OrgAct>, +as: +List<Choices.AppAct>, ps: +List<Choices.Pick>) -> Bool:
  match ps:
    case Nil{}:
      True{}
    case p <> rest:
      offered(p, os, as) && all_offered(os, as, rest)

def offered_req(r: Choices.Req) -> Bool:
  match r:
    case Choices.Req{+os, +as, ps, everything, unchecked}:
      everything || all_offered(os, as, ps)

# Holds
# -----

# A handle under a live hold has no owner.
def unclaimed_while_held(s: Holds.H) -> Bool:
  match s:
    case Holds.H{o, h, c}:
      Holds.unowned(o) || Bool.not(Holds.live(h, c))

def hold_of(s: Holds.H) -> Holds.Hold:
  match s:
    case Holds.H{o, h, c}:
      h

def owner_of(s: Holds.H) -> Maybe<&2, Nat>:
  match s:
    case Holds.H{o, h, c}:
      o

def clock_of(s: Holds.H) -> Nat:
  match s:
    case Holds.H{o, h, c}:
      c

# Succession
# ----------

# No heir, or a member from another account.
def fits(m: Maybe<&2, Nat>, +gone: Nat, +ms: +List<Succession.Mem>) -> Bool:
  match m:
    case None{}:
      True{}
    case Some{p}:
      Succession.eligible(p, gone, ms)

def is_heir(m: Maybe<&2, Nat>, +q: Nat) -> Bool:
  match m:
    case None{}:
      False{}
    case Some{p}:
      Nat.is_eq(p, q)

def is_none(m: Maybe<&2, Nat>) -> Bool:
  match m:
    case None{}:
      True{}
    case Some{p}:
      False{}

def is_remove(a: Succession.Answer) -> Bool:
  match a:
    case Succession.Transfer{}:
      False{}
    case Succession.Named{q}:
      False{}
    case Succession.Remove{}:
      True{}
    case Succession.Unanswered{}:
      False{}

# Some member from another account than `gone`.
def any_other(+gone: Nat, ms: +List<Succession.Mem>) -> Bool:
  match ms:
    case Nil{}:
      False{}
    case Succession.Mem{p, a, r} <> rest:
      Bool.not(Nat.is_eq(a, gone)) || any_other(gone, rest)

# Weddings
# --------

# A live wedding has an owner.
def owner_if_live(w: Weddings.W) -> Bool:
  match w:
    case Weddings.W{live, ss}:
      Bool.not(live) || Weddings.has_owner(ss)
