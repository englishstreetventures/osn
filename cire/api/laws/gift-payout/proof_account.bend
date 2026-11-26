# Proofs about the account: its generation, its records, and the retire.
# Each law here is about one step from any state, so each proof matches the
# state, then the account it names, then the event.

import Base
import ../../../../tools/bend/kit.bend as K
import ./payout.bend as M
import ./SPEC.bend as Spec
import ./proof_base.bend as PB
import ./proof_refl.bend as PR

# Generation
# ----------

def gen_step(+s: M.P, +e: M.Ev) -> K.T(Spec.gen_follows(s, M.step(s, e))):
  match s:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      match account:
        case None{}:
          match e:
            case M.Connect{by, a, g, c}:
              PB.connect_cases(x => K.T(Spec.gen_follows(M.P{live, ss, None{}, holder, charges, gifts, gen, recs}, x)), by, a, g, c, live, ss, holder, charges, gifts, gen, recs,
                q => K.eq_refl(gen), q => K.eq_refl(gen))
            case M.Join{by, a, c}:
              PB.join_cases(x => K.T(Spec.gen_follows(M.P{live, ss, None{}, holder, charges, gifts, gen, recs}, x)), by, a, c, live, ss, holder, charges, gifts, gen, recs,
                q => K.eq_refl(gen), q => K.eq_refl(gen))
            case M.Retire{by, hand, read, g}:
              K.eq_refl(gen)
            case M.Detach{a}:
              K.eq_refl(gen)
            case M.Update{a, c}:
              K.eq_refl(gen)
            case M.Gifts{on}:
              match on:
                case True{}:
                  K.eq_refl(gen)
                case False{}:
                  K.eq_refl(gen)
            case M.Add{q, r}:
              K.eq_refl(gen)
            case M.Remove{q}:
              K.eq_refl(gen)
            case M.SetRole{q, r}:
              K.eq_refl(gen)
            case M.Discard{by}:
              K.eq_refl(gen)
            case M.Revive{q}:
              K.eq_refl(gen)
            case M.Erase{ps}:
              K.eq_refl(gen)
        case Some{b}:
          match e:
            case M.Connect{by, a, g, c}:
              K.eq_refl(gen)
            case M.Join{by, a, c}:
              K.eq_refl(gen)
            case M.Retire{by, hand, read, g}:
              PB.retire_cases(x => K.T(Spec.gen_follows(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, x)), by, hand, read, g, live, ss, b, holder, charges, gifts, gen, recs,
                q => K.eq_refl(1n+gen), q => K.eq_refl(gen))
            case M.Detach{a}:
              PB.detach_cases(x => K.T(Spec.gen_follows(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, x)), a, live, ss, b, holder, charges, gifts, gen, recs,
                q => K.eq_refl(1n+gen), q => K.eq_refl(gen))
            case M.Update{a, c}:
              K.eq_refl(gen)
            case M.Gifts{on}:
              match on:
                case True{}:
                  K.eq_refl(gen)
                case False{}:
                  K.eq_refl(gen)
            case M.Add{q, r}:
              K.eq_refl(gen)
            case M.Remove{q}:
              K.eq_refl(gen)
            case M.SetRole{q, r}:
              K.eq_refl(gen)
            case M.Discard{by}:
              K.eq_refl(gen)
            case M.Revive{q}:
              K.eq_refl(gen)
            case M.Erase{ps}:
              K.eq_refl(gen)

# Never repointed
# ---------------

def keep_b(+b: Nat) -> K.T(Nat.is_eq(b, b) || False{}):
  K.or_l(Nat.is_eq(b, b), False{}, K.eq_refl(b))

def repoint_step(+s: M.P, +e: M.Ev) -> K.T(Spec.not_repointed(s, M.step(s, e))):
  match s:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      match account:
        case None{}:
          Unit{}
        case Some{b}:
          match e:
            case M.Connect{by, a, g, c}:
              keep_b(b)
            case M.Join{by, a, c}:
              keep_b(b)
            case M.Retire{by, hand, read, g}:
              PB.retire_cases(x => K.T(Spec.not_repointed(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, x)), by, hand, read, g, live, ss, b, holder, charges, gifts, gen, recs,
                q => Unit{}, q => keep_b(b))
            case M.Detach{a}:
              PB.detach_cases(x => K.T(Spec.not_repointed(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, x)), a, live, ss, b, holder, charges, gifts, gen, recs,
                q => Unit{}, q => keep_b(b))
            case M.Update{a, c}:
              keep_b(b)
            case M.Gifts{on}:
              match on:
                case True{}:
                  keep_b(b)
                case False{}:
                  keep_b(b)
            case M.Add{q, r}:
              keep_b(b)
            case M.Remove{q}:
              keep_b(b)
            case M.SetRole{q, r}:
              keep_b(b)
            case M.Discard{by}:
              keep_b(b)
            case M.Revive{q}:
              keep_b(b)
            case M.Erase{ps}:
              keep_b(b)

# Records
# -------

# The record a retire writes names the account, with the reason its standing
# gives, unreleased, on top of the records there were.
def newest(+by: Nat, +hand: Maybe<&2, Nat>, +live: Bool, +ss: +List<M.Seat>, +b: Nat, +holder: Maybe<&2, Nat>,
  +charges: Bool, +gifts: Bool, +gen: Nat, +recs: +List<M.Rec>)
  -> K.T(Spec.newest_is(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, by, hand, M.Rec{b, M.reason(by, hand, Some{b}, holder, ss), False{}} <> recs)):
  K.and_intro(
    (Nat.is_eq(b, b) && Spec.same_reason(M.reason(by, hand, Some{b}, holder, ss), Spec.standing(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, by, hand))) && True{},
    Nat.is_eq(List.length(&2, M.Rec, recs), List.length(&2, M.Rec, recs)),
    K.and_intro(
      Nat.is_eq(b, b) && Spec.same_reason(M.reason(by, hand, Some{b}, holder, ss), Spec.standing(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, by, hand)),
      True{},
      K.and_intro(Nat.is_eq(b, b), Spec.same_reason(M.reason(by, hand, Some{b}, holder, ss), Spec.standing(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, by, hand)),
        K.eq_refl(b), K.eq_refl(Spec.reason_code(M.reason(by, hand, Some{b}, holder, ss)))),
      Unit{}),
    K.eq_refl(List.length(&2, M.Rec, recs)))

def records_step(+s: M.P, +e: M.Ev) -> K.T(Spec.records_follow(s, e, M.step(s, e))):
  match s:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      match account:
        case None{}:
          match e:
            case M.Connect{by, a, g, c}:
              PB.connect_cases(x => K.T(Spec.records_follow(M.P{live, ss, None{}, holder, charges, gifts, gen, recs}, M.Connect{by, a, g, c}, x)), by, a, g, c, live, ss, holder, charges, gifts, gen, recs,
                q => K.eq_refl(List.length(&2, M.Rec, recs)), q => K.eq_refl(List.length(&2, M.Rec, recs)))
            case M.Join{by, a, c}:
              PB.join_cases(x => K.T(Spec.records_follow(M.P{live, ss, None{}, holder, charges, gifts, gen, recs}, M.Join{by, a, c}, x)), by, a, c, live, ss, holder, charges, gifts, gen, recs,
                q => K.eq_refl(List.length(&2, M.Rec, recs)), q => K.eq_refl(List.length(&2, M.Rec, recs)))
            case M.Retire{by, hand, read, g}:
              K.eq_refl(List.length(&2, M.Rec, recs))
            case M.Detach{a}:
              PR.len_release(a, recs)
            case M.Update{a, c}:
              K.eq_refl(List.length(&2, M.Rec, recs))
            case M.Gifts{on}:
              match on:
                case True{}:
                  K.eq_refl(List.length(&2, M.Rec, recs))
                case False{}:
                  K.eq_refl(List.length(&2, M.Rec, recs))
            case M.Add{q, r}:
              K.eq_refl(List.length(&2, M.Rec, recs))
            case M.Remove{q}:
              K.eq_refl(List.length(&2, M.Rec, recs))
            case M.SetRole{q, r}:
              K.eq_refl(List.length(&2, M.Rec, recs))
            case M.Discard{by}:
              K.eq_refl(List.length(&2, M.Rec, recs))
            case M.Revive{q}:
              K.eq_refl(List.length(&2, M.Rec, recs))
            case M.Erase{ps}:
              K.eq_refl(List.length(&2, M.Rec, recs))
        case Some{b}:
          match e:
            case M.Connect{by, a, g, c}:
              K.eq_refl(List.length(&2, M.Rec, recs))
            case M.Join{by, a, c}:
              K.eq_refl(List.length(&2, M.Rec, recs))
            case M.Retire{by, hand, read, g}:
              PB.retire_cases(x => K.T(Spec.records_follow(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, M.Retire{by, hand, read, g}, x)), by, hand, read, g, live, ss, b, holder, charges, gifts, gen, recs,
                q => newest(by, hand, live, ss, b, holder, charges, gifts, gen, recs), q => K.eq_refl(List.length(&2, M.Rec, recs)))
            case M.Detach{a}:
              PB.detach_cases(x => K.T(Spec.records_follow(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, M.Detach{a}, x)), a, live, ss, b, holder, charges, gifts, gen, recs,
                q => PR.len_release(a, recs), q => PR.len_release(a, recs))
            case M.Update{a, c}:
              K.eq_refl(List.length(&2, M.Rec, recs))
            case M.Gifts{on}:
              match on:
                case True{}:
                  K.eq_refl(List.length(&2, M.Rec, recs))
                case False{}:
                  K.eq_refl(List.length(&2, M.Rec, recs))
            case M.Add{q, r}:
              K.eq_refl(List.length(&2, M.Rec, recs))
            case M.Remove{q}:
              K.eq_refl(List.length(&2, M.Rec, recs))
            case M.SetRole{q, r}:
              K.eq_refl(List.length(&2, M.Rec, recs))
            case M.Discard{by}:
              K.eq_refl(List.length(&2, M.Rec, recs))
            case M.Revive{q}:
              K.eq_refl(List.length(&2, M.Rec, recs))
            case M.Erase{ps}:
              K.eq_refl(List.length(&2, M.Rec, recs))

# What clears
# -----------

def clear_step(+s: M.P, +e: M.Ev)
  -> K.T(Spec.imp(Spec.cleared(s, M.step(s, e)), Spec.is_retire(e) || Spec.detaches(Spec.account_of(s), e))):
  match s:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      match account:
        case None{}:
          Unit{}
        case Some{b}:
          match e:
            case M.Connect{by, a, g, c}:
              Unit{}
            case M.Join{by, a, c}:
              Unit{}
            case M.Retire{by, hand, read, g}:
              PB.retire_cases(x => K.T(Spec.imp(Spec.cleared(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, x), Spec.is_retire(M.Retire{by, hand, read, g}) || Spec.detaches(Some{b}, M.Retire{by, hand, read, g}))),
                by, hand, read, g, live, ss, b, holder, charges, gifts, gen, recs,
                q => Unit{}, q => Unit{})
            case M.Detach{a}:
              PB.detach_cases(x => K.T(Spec.imp(Spec.cleared(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, x), Spec.is_retire(M.Detach{a}) || Spec.detaches(Some{b}, M.Detach{a}))),
                a, live, ss, b, holder, charges, gifts, gen, recs,
                q => K.from_eq(Nat.is_eq(b, a), q), q => Unit{})
            case M.Update{a, c}:
              Unit{}
            case M.Gifts{on}:
              match on:
                case True{}:
                  Unit{}
                case False{}:
                  Unit{}
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

# Stale writes
# ------------

# What the retire's condition says of the read, as `read_fresh` says it.
def fresh_of(+read: Maybe<&2, Nat>, +b: Nat, +g: Nat, +gen: Nat, w: K.T(M.read_is(read, b) && Nat.is_eq(g, gen)))
  -> K.T((M.named(read) && Spec.same_nat(Some{b}, read)) && Nat.is_eq(g, gen)):
  match read:
    case None{}:
      w
    case Some{a}:
      w

def stale_retire(+s: M.P, +by: Nat, +hand: Maybe<&2, Nat>, +read: Maybe<&2, Nat>, +g: Nat)
  -> K.T(Spec.imp(Bool.not(Spec.read_fresh(s, read, g)), Spec.payout_same(s, M.step(s, M.Retire{by, hand, read, g})))):
  match s:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      match account:
        case None{}:
          K.or_r(Bool.not(Bool.not(Spec.read_fresh(M.P{live, ss, None{}, holder, charges, gifts, gen, recs}, read, g))), Spec.payout_same(M.P{live, ss, None{}, holder, charges, gifts, gen, recs}, M.P{live, ss, None{}, holder, charges, gifts, gen, recs}),
            PR.same_refl(live, ss, None{}, holder, charges, gifts, gen, recs))
        case Some{b}:
          PB.retire_cases(x => K.T(Spec.imp(Bool.not(Spec.read_fresh(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, read, g)), Spec.payout_same(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, x))),
            by, hand, read, g, live, ss, b, holder, charges, gifts, gen, recs,
            q => K.or_l(Bool.not(Bool.not(Spec.read_fresh(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, read, g))), Spec.payout_same(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, M.P{live, ss, None{}, None{}, False{}, gifts, 1n+gen, M.Rec{b, M.reason(by, hand, Some{b}, holder, ss), False{}} <> recs}),
              K.nn_intro(Spec.read_fresh(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, read, g),
                fresh_of(read, b, g, gen, PB.retire_fresh(by, hand, read, g, live, ss, b, holder, gen, q)))),
            q => K.or_r(Bool.not(Bool.not(Spec.read_fresh(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, read, g))), Spec.payout_same(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}),
              PR.same_refl(live, ss, Some{b}, holder, charges, gifts, gen, recs)))

def stale_connect(+s: M.P, +by: Nat, +a: Nat, +g: Nat, +c: Bool)
  -> K.T(Spec.imp(Bool.not(Nat.is_eq(g, Spec.gen_of(s))), Spec.payout_same(s, M.step(s, M.Connect{by, a, g, c})))):
  match s:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      match account:
        case None{}:
          PB.connect_cases(x => K.T(Spec.imp(Bool.not(Nat.is_eq(g, gen)), Spec.payout_same(M.P{live, ss, None{}, holder, charges, gifts, gen, recs}, x))),
            by, a, g, c, live, ss, holder, charges, gifts, gen, recs,
            q => K.or_l(Bool.not(Bool.not(Nat.is_eq(g, gen))), Spec.payout_same(M.P{live, ss, None{}, holder, charges, gifts, gen, recs}, M.P{live, ss, Some{a}, Some{by}, c, gifts, gen, recs}),
              K.nn_intro(Nat.is_eq(g, gen),
                K.and_r(live && M.owns(by, ss), Nat.is_eq(g, gen), K.from_eq((live && M.owns(by, ss)) && Nat.is_eq(g, gen), q)))),
            q => K.or_r(Bool.not(Bool.not(Nat.is_eq(g, gen))), Spec.payout_same(M.P{live, ss, None{}, holder, charges, gifts, gen, recs}, M.P{live, ss, None{}, holder, charges, gifts, gen, recs}),
              PR.same_refl(live, ss, None{}, holder, charges, gifts, gen, recs)))
        case Some{b}:
          K.or_r(Bool.not(Bool.not(Nat.is_eq(g, gen))), Spec.payout_same(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}),
            PR.same_refl(live, ss, Some{b}, holder, charges, gifts, gen, recs))

# Who retires
# -----------

def retire_owner(+s: M.P, +by: Nat, +hand: Maybe<&2, Nat>, +read: Maybe<&2, Nat>, +g: Nat)
  -> K.T(Spec.imp(Spec.cleared(s, M.step(s, M.Retire{by, hand, read, g})), Spec.owns_live(s, by))):
  match s:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      match account:
        case None{}:
          Unit{}
        case Some{b}:
          PB.retire_cases(x => K.T(Spec.imp(Spec.cleared(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, x), Spec.owns_live(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, by))),
            by, hand, read, g, live, ss, b, holder, charges, gifts, gen, recs,
            q => PB.retire_owner(by, hand, read, g, live, ss, b, holder, gen, q),
            q => Unit{})

def retire_hand(+s: M.P, +by: Nat, +h: Nat, +read: Maybe<&2, Nat>, +g: Nat)
  -> K.T(Spec.imp(Spec.cleared(s, M.step(s, M.Retire{by, Some{h}, read, g})), Spec.hand_fits(s, by, h))):
  match s:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      match account:
        case None{}:
          Unit{}
        case Some{b}:
          PB.retire_cases(x => K.T(Spec.imp(Spec.cleared(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, x), Spec.hand_fits(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, by, h))),
            by, Some{h}, read, g, live, ss, b, holder, charges, gifts, gen, recs,
            q => PB.retire_hand(by, Some{h}, read, g, live, ss, b, holder, gen, q),
            q => Unit{})

# Erasure
# -------

def erase_keeps(+s: M.P, +ps: +List<Nat>)
  -> K.T(Spec.same_nat(Spec.account_of(s), Spec.account_of(M.step(s, M.Erase{ps})))):
  match s:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      PR.same_nat_refl(account)
