# Proofs about money gifts: when guests may give money, and when the switch
# may be turned on.

import Base
import ../../../../tools/bend/kit.bend as K
import ./payout.bend as M
import ./SPEC.bend as Spec
import ./proof_base.bend as PB

# Closed while the holder is absent
# ---------------------------------

def closed(+s: M.P) -> K.T(Spec.imp(M.absent(s), Bool.not(Spec.is_open(M.block(s))))):
  match s:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      K.bool_case(M.absent_of(account, holder, ss),
        y => K.T(Spec.imp(y, Bool.not(Spec.is_open(Bool.pick(M.Block, y, M.HolderGone{}, Bool.pick(M.Block, charges, Bool.pick(M.Block, gifts, M.Open{}, M.GiftsOff{}), M.NotReady{})))))),
        e => Unit{},
        e => Unit{})

# Closed after the holder's erasure
# ---------------------------------

def erased_closed(+s: M.P, +ps: +List<Nat>)
  -> K.T(Spec.imp(Spec.holder_in(s, ps), Bool.not(Spec.is_open(M.block(M.step(s, M.Erase{ps})))))):
  match s:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      match account:
        case None{}:
          Unit{}
        case Some{b}:
          match holder:
            case None{}:
              Unit{}
            case Some{+p}:
              K.bool_case(M.member(p, ps),
                y => K.T(Spec.imp(y, Bool.not(Spec.is_open(Bool.pick(M.Block,
                  Bool.not(M.seated_holder(Bool.pick(Maybe<&2, Nat>, y, None{}, Some{p}), M.erase_seats(ps, ss))),
                  M.HolderGone{}, Bool.pick(M.Block, charges, Bool.pick(M.Block, gifts, M.Open{}, M.GiftsOff{}), M.NotReady{})))))),
                e => Unit{},
                e => Unit{})

# The switch
# ----------

def turn_on(+s: M.P, +e: M.Ev) -> K.T(Spec.imp(Spec.turned_on(s, M.step(s, e)), Spec.ready(s))):
  match s:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      match account:
        case None{}:
          match gifts:
            case True{}:
              Unit{}
            case False{}:
              match e:
                case M.Connect{by, a, g, c}:
                  PB.connect_cases(x => K.T(Spec.imp(Spec.turned_on(M.P{live, ss, None{}, holder, charges, False{}, gen, recs}, x), Spec.ready(M.P{live, ss, None{}, holder, charges, False{}, gen, recs}))), by, a, g, c, live, ss, holder, charges, False{}, gen, recs,
                    q => Unit{}, q => Unit{})
                case M.Join{by, a, c}:
                  PB.join_cases(x => K.T(Spec.imp(Spec.turned_on(M.P{live, ss, None{}, holder, charges, False{}, gen, recs}, x), Spec.ready(M.P{live, ss, None{}, holder, charges, False{}, gen, recs}))), by, a, c, live, ss, holder, charges, False{}, gen, recs,
                    q => Unit{}, q => Unit{})
                case M.Retire{by, hand, read, g}:
                  Unit{}
                case M.Detach{a}:
                  Unit{}
                case M.Update{a, c}:
                  Unit{}
                case M.Gifts{on}:
                  match on:
                    case True{}:
                      K.pick_split(Bool, y => K.T(Spec.imp(y, Bool.not(M.absent_of(None{}, holder, ss)) && charges)),
                        live && (Bool.not(M.absent_of(None{}, holder, ss)) && charges), True{}, False{},
                        q => K.and_r(live, Bool.not(M.absent_of(None{}, holder, ss)) && charges, K.from_eq(live && (Bool.not(M.absent_of(None{}, holder, ss)) && charges), q)),
                        q => Unit{})
                    case False{}:
                      K.pick_split(Bool, y => K.T(Spec.imp(y, Bool.not(M.absent_of(None{}, holder, ss)) && charges)), live, False{}, False{},
                        q => Unit{}, q => Unit{})
                case M.Add{q, r}:
                  Unit{}
                case M.Remove{q}:
                  Unit{}
                case M.SetRole{q, r}:
                  Unit{}
                case M.Discard{by}:
                  Unit{}
                case M.Revive{q}:
                  Unit{}
                case M.Erase{ps}:
                  Unit{}
        case Some{b}:
          match gifts:
            case True{}:
              Unit{}
            case False{}:
              match e:
                case M.Connect{by, a, g, c}:
                  Unit{}
                case M.Join{by, a, c}:
                  Unit{}
                case M.Retire{by, hand, read, g}:
                  PB.retire_cases(x => K.T(Spec.imp(Spec.turned_on(M.P{live, ss, Some{b}, holder, charges, False{}, gen, recs}, x), Spec.ready(M.P{live, ss, Some{b}, holder, charges, False{}, gen, recs}))), by, hand, read, g, live, ss, b, holder, charges, False{}, gen, recs,
                    q => Unit{}, q => Unit{})
                case M.Detach{a}:
                  PB.detach_cases(x => K.T(Spec.imp(Spec.turned_on(M.P{live, ss, Some{b}, holder, charges, False{}, gen, recs}, x), Spec.ready(M.P{live, ss, Some{b}, holder, charges, False{}, gen, recs}))), a, live, ss, b, holder, charges, False{}, gen, recs,
                    q => Unit{}, q => Unit{})
                case M.Update{a, c}:
                  Unit{}
                case M.Gifts{on}:
                  match on:
                    case True{}:
                      K.pick_split(Bool, y => K.T(Spec.imp(y, Bool.not(M.absent_of(Some{b}, holder, ss)) && charges)),
                        live && (Bool.not(M.absent_of(Some{b}, holder, ss)) && charges), True{}, False{},
                        q => K.and_r(live, Bool.not(M.absent_of(Some{b}, holder, ss)) && charges, K.from_eq(live && (Bool.not(M.absent_of(Some{b}, holder, ss)) && charges), q)),
                        q => Unit{})
                    case False{}:
                      K.pick_split(Bool, y => K.T(Spec.imp(y, Bool.not(M.absent_of(Some{b}, holder, ss)) && charges)), live, False{}, False{},
                        q => Unit{}, q => Unit{})
                case M.Add{q, r}:
                  Unit{}
                case M.Remove{q}:
                  Unit{}
                case M.SetRole{q, r}:
                  Unit{}
                case M.Discard{by}:
                  Unit{}
                case M.Revive{q}:
                  Unit{}
                case M.Erase{ps}:
                  Unit{}

# Open only when backed
# ---------------------

# In every state a wedding reaches, Stripe's charges flag is on only while an
# account is named: every clear turns it off, and an update writes only a row
# naming its account.
def inv(+s: M.P) -> Bool:
  Spec.imp(Spec.charges_of(s), M.named(Spec.account_of(s)))

def step_inv(+s: M.P, +e: M.Ev, +h: K.T(inv(s))) -> K.T(inv(M.step(s, e))):
  match s:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      match account:
        case None{}:
          match e:
            case M.Connect{by, a, g, c}:
              PB.connect_cases(x => K.T(inv(x)), by, a, g, c, live, ss, holder, charges, gifts, gen, recs,
                q => K.or_r(Bool.not(c), True{}, Unit{}), q => h)
            case M.Join{by, a, c}:
              PB.join_cases(x => K.T(inv(x)), by, a, c, live, ss, holder, charges, gifts, gen, recs,
                q => K.or_r(Bool.not(c), True{}, Unit{}), q => h)
            case M.Retire{by, hand, read, g}:
              h
            case M.Detach{a}:
              h
            case M.Update{a, c}:
              h
            case M.Gifts{on}:
              match on:
                case True{}:
                  h
                case False{}:
                  h
            case M.Add{q, r}:
              h
            case M.Remove{q}:
              h
            case M.SetRole{q, r}:
              h
            case M.Discard{by}:
              h
            case M.Revive{q}:
              h
            case M.Erase{ps}:
              h
        case Some{b}:
          match e:
            case M.Connect{by, a, g, c}:
              K.or_r(Bool.not(charges), True{}, Unit{})
            case M.Join{by, a, c}:
              K.or_r(Bool.not(charges), True{}, Unit{})
            case M.Retire{by, hand, read, g}:
              PB.retire_cases(x => K.T(inv(x)), by, hand, read, g, live, ss, b, holder, charges, gifts, gen, recs,
                q => Unit{}, q => K.or_r(Bool.not(charges), True{}, Unit{}))
            case M.Detach{a}:
              PB.detach_cases(x => K.T(inv(x)), a, live, ss, b, holder, charges, gifts, gen, recs,
                q => Unit{}, q => K.or_r(Bool.not(charges), True{}, Unit{}))
            case M.Update{a, c}:
              K.or_r(Bool.not(Bool.pick(Bool, Nat.is_eq(b, a), c, charges)), True{}, Unit{})
            case M.Gifts{on}:
              match on:
                case True{}:
                  K.or_r(Bool.not(charges), True{}, Unit{})
                case False{}:
                  K.or_r(Bool.not(charges), True{}, Unit{})
            case M.Add{q, r}:
              K.or_r(Bool.not(charges), True{}, Unit{})
            case M.Remove{q}:
              K.or_r(Bool.not(charges), True{}, Unit{})
            case M.SetRole{q, r}:
              K.or_r(Bool.not(charges), True{}, Unit{})
            case M.Discard{by}:
              K.or_r(Bool.not(charges), True{}, Unit{})
            case M.Revive{q}:
              K.or_r(Bool.not(charges), True{}, Unit{})
            case M.Erase{ps}:
              K.or_r(Bool.not(charges), True{}, Unit{})

# Open, with an account named, means backed.
def open_named(+sh: Bool, +charges: Bool, +gifts: Bool,
  o: K.T(Spec.is_open(Bool.pick(M.Block, Bool.not(sh), M.HolderGone{}, Bool.pick(M.Block, charges, Bool.pick(M.Block, gifts, M.Open{}, M.GiftsOff{}), M.NotReady{})))))
  -> K.T(sh && (charges && gifts)):
  match sh:
    case True{}:
      match charges:
        case True{}:
          match gifts:
            case True{}:
              Unit{}
            case False{}:
              o
        case False{}:
          o
    case False{}:
      o

# With no account named, the invariant leaves Stripe's flag off, so it is
# never open.
def open_unnamed(+charges: Bool, +gifts: Bool, h: K.T(Bool.not(charges) || False{}),
  o: K.T(Spec.is_open(Bool.pick(M.Block, charges, Bool.pick(M.Block, gifts, M.Open{}, M.GiftsOff{}), M.NotReady{})))) -> Empty:
  match charges:
    case True{}:
      h
    case False{}:
      o

def open_backed(+t: M.P, h: K.T(inv(t)), o: K.T(Spec.is_open(M.block(t)))) -> K.T(Spec.backed(t)):
  match t:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      match account:
        case None{}:
          open_unnamed(charges, gifts, h, o)
        case Some{b}:
          open_named(M.seated_holder(holder, ss), charges, gifts, o)

def reach_open(es: List<M.Ev>, +s: M.P, +h: K.T(inv(s)))
  -> {Spec.imp(Spec.is_open(M.block(M.run(es, s))), Spec.backed(M.run(es, s))) == True{} : Bool}:
  match es:
    case Nil{}:
      K.to_eq(Spec.imp(Spec.is_open(M.block(s)), Spec.backed(s)),
        K.imp_intro(Spec.is_open(M.block(s)), Spec.backed(s), o => open_backed(s, h, o)))
    case Con{+e, rest}:
      reach_open(rest, M.step(s, e), step_inv(s, e, h))
