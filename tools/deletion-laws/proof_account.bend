# Proofs about one account's deletion.
#
# `good` holds in every reachable state: a pending job's id is below the next
# one, an unclaimed job has reached no app, and an erased account was erased
# at or after its window's end with every app finished. `step_good` shows a
# step keeps it; `reach` carries it down any list of events and hands the
# final state to a lemma about it.

import Base
import ./kit.bend as K
import ./account.bend as A
import ./choices.bend as C
import ./SPEC.bend as Spec
import ./proof_choices.bend as PC

def all_waiting(+p: A.Mark, +z: A.Mark, +c: A.Mark) -> Bool:
  (A.waiting(p) && A.waiting(z)) && A.waiting(c)

def good(s: A.Acct) -> Bool:
  match s:
    case A.Live{next}:
      True{}
    case A.Scheduled{job, due, claimed, p, z, c, ev, next}:
      Nat.is_lt(job, next) && (claimed || all_waiting(p, z, c))
    case A.Erased{job, due, at, p, z, c}:
      Nat.is_le(due, at) && ((A.finished(p) && A.finished(z)) && A.finished(c))

def step_good(+s: A.Acct, +e: A.Ev, +h: K.T(good(s))) -> K.T(good(A.step(s, e))):
  match s:
    case A.Live{next}:
      match e:
        case A.Ask{now, req}:
          K.pick_split(A.Acct, x => K.T(good(x)), C.is_ok(C.verdict(req)),
            A.Scheduled{next, Nat.add(now, A.window()), False{}, A.Pending{}, A.Pending{}, A.Pending{}, C.everything_of(req), 1n+next},
            A.Live{next},
            q => K.and_intro(Nat.is_lt(next, 1n+next), True{}, K.lt_succ(next), Unit{}),
            q => Unit{})
        case A.Keep{now, read}:
          Unit{}
        case A.FanOut{now, rp, rz, rc}:
          Unit{}
        case A.Sweep{now}:
          Unit{}
    case A.Scheduled{job, due, claimed, p, z, c, ev, next}:
      match e:
        case A.Ask{now, req}:
          h
        case A.Keep{now, read}:
          K.pick_split(A.Acct, x => K.T(good(x)),
            (Nat.is_eq(read, job) && Bool.not(claimed)) && Nat.is_lt(now, due),
            A.Live{next},
            A.Scheduled{job, due, claimed, p, z, c, ev, next},
            q => Unit{},
            q => h)
        case A.FanOut{now, rp, rz, rc}:
          K.pick_split(A.Acct, x => K.T(good(x)),
            Nat.is_le(due, now) && ((A.waiting(p) || A.waiting(z)) || A.waiting(c)),
            A.Scheduled{job, due, True{}, A.finish(p, rp), A.finish(z, rz), A.finish(c, rc), ev, next},
            A.Scheduled{job, due, claimed, p, z, c, ev, next},
            q => K.and_intro(Nat.is_lt(job, next), True{},
                   K.and_l(Nat.is_lt(job, next), claimed || all_waiting(p, z, c), h),
                   Unit{}),
            q => h)
        case A.Sweep{now}:
          K.pick_split(A.Acct, x => K.T(good(x)),
            Nat.is_le(due, now) && ((A.finished(p) && A.finished(z)) && A.finished(c)),
            A.Erased{job, due, now, p, z, c},
            A.Scheduled{job, due, claimed, p, z, c, ev, next},
            q => %q : K.T(_)
                 Unit{},
            q => h)
    case A.Erased{job, due, at, p, z, c}:
      h

def reach(es: List<A.Ev>, +s: A.Acct, +h: K.T(good(s)), -P: A.Acct -> Type,
  k: @x: A.Acct -> K.T(good(x)) -> P(x)) -> P(A.run(es, s)):
  match es:
    case Nil{}:
      k(s, h)
    case Con{+e, rest}:
      reach(rest, A.step(s, e), step_good(s, e, h), P, k)

# A1, A2
# ------

def good_on_time(+s: A.Acct, +h: K.T(good(s))) -> {Spec.on_time(s) == True{} : Bool}:
  match s:
    case A.Live{next}:
      {==}
    case A.Scheduled{job, due, claimed, p, z, c, ev, next}:
      {==}
    case A.Erased{job, due, at, p, z, c}:
      K.to_eq(Nat.is_le(due, at),
        K.and_l(Nat.is_le(due, at), (A.finished(p) && A.finished(z)) && A.finished(c), h))

def good_apps_finished(+s: A.Acct, +h: K.T(good(s))) -> {Spec.apps_finished(s) == True{} : Bool}:
  match s:
    case A.Live{next}:
      {==}
    case A.Scheduled{job, due, claimed, p, z, c, ev, next}:
      {==}
    case A.Erased{job, due, at, p, z, c}:
      K.to_eq((A.finished(p) && A.finished(z)) && A.finished(c),
        K.and_r(Nat.is_le(due, at), (A.finished(p) && A.finished(z)) && A.finished(c), h))

# A3
# --

# A job no sweep has claimed has reached no app.
def waiting_unreached(+p: A.Mark, +z: A.Mark, +c: A.Mark, +w: K.T(all_waiting(p, z, c)))
  -> K.T(Bool.not((A.finished(p) || A.finished(z)) || A.finished(c))):
  match p:
    case A.Pending{}:
      match z:
        case A.Pending{}:
          match c:
            case A.Pending{}:
              Unit{}
            case A.Confirmed{}:
              w
            case A.Skipped{}:
              w
        case A.Confirmed{}:
          w
        case A.Skipped{}:
          w
    case A.Confirmed{}:
      w
    case A.Skipped{}:
      w

def no_restore_keep(+claimed: Bool, +job: Nat, +due: Nat, +p: A.Mark, +z: A.Mark, +c: A.Mark, +ev: Bool, +next: Nat, +now: Nat, +read: Nat,
  +h: K.T(good(A.Scheduled{job, due, claimed, p, z, c, ev, next})))
  -> {Spec.imp(Spec.reached(A.Scheduled{job, due, claimed, p, z, c, ev, next}), Bool.not(Spec.is_live(A.step(A.Scheduled{job, due, claimed, p, z, c, ev, next}, A.Keep{now, read})))) == True{} : Bool}:
  match claimed:
    case True{}:
      K.pick_split(A.Acct,
        x => {Spec.imp(Spec.reached(A.Scheduled{job, due, True{}, p, z, c, ev, next}), Bool.not(Spec.is_live(x))) == True{} : Bool},
        (Nat.is_eq(read, job) && False{}) && Nat.is_lt(now, due),
        A.Live{next},
        A.Scheduled{job, due, True{}, p, z, c, ev, next},
        q => Empty.absurd(
          {Spec.imp(Spec.reached(A.Scheduled{job, due, True{}, p, z, c, ev, next}), Bool.not(Spec.is_live(A.Live{next}))) == True{} : Bool},
          K.and_r(Nat.is_eq(read, job), False{},
            K.and_l(Nat.is_eq(read, job) && False{}, Nat.is_lt(now, due),
              K.from_eq((Nat.is_eq(read, job) && False{}) && Nat.is_lt(now, due), q)))),
        q => K.imp_true(Spec.reached(A.Scheduled{job, due, True{}, p, z, c, ev, next})))
    case False{}:
      K.pick_split(A.Acct,
        x => {Spec.imp(Spec.reached(A.Scheduled{job, due, False{}, p, z, c, ev, next}), Bool.not(Spec.is_live(x))) == True{} : Bool},
        (Nat.is_eq(read, job) && True{}) && Nat.is_lt(now, due),
        A.Live{next},
        A.Scheduled{job, due, False{}, p, z, c, ev, next},
        q => K.to_eq(Bool.not((A.finished(p) || A.finished(z)) || A.finished(c)) || False{},
          K.or_l(Bool.not((A.finished(p) || A.finished(z)) || A.finished(c)), False{},
            waiting_unreached(p, z, c,
              K.and_r(Nat.is_lt(job, next), all_waiting(p, z, c), h)))),
        q => K.imp_true(Spec.reached(A.Scheduled{job, due, False{}, p, z, c, ev, next})))

def no_restore(+s: A.Acct, +e: A.Ev, +h: K.T(good(s)))
  -> {Spec.imp(Spec.reached(s), Bool.not(Spec.is_live(A.step(s, e)))) == True{} : Bool}:
  match s:
    case A.Live{next}:
      {==}
    case A.Scheduled{job, due, claimed, p, z, c, ev, next}:
      match e:
        case A.Ask{now, req}:
          K.imp_true(Spec.reached(A.Scheduled{job, due, claimed, p, z, c, ev, next}))
        case A.Keep{now, read}:
          no_restore_keep(claimed, job, due, p, z, c, ev, next, now, read, h)
        case A.FanOut{now, rp, rz, rc}:
          K.pick_split(A.Acct,
            x => {Spec.imp(Spec.reached(A.Scheduled{job, due, claimed, p, z, c, ev, next}), Bool.not(Spec.is_live(x))) == True{} : Bool},
            Nat.is_le(due, now) && ((A.waiting(p) || A.waiting(z)) || A.waiting(c)),
            A.Scheduled{job, due, True{}, A.finish(p, rp), A.finish(z, rz), A.finish(c, rc), ev, next},
            A.Scheduled{job, due, claimed, p, z, c, ev, next},
            q => K.imp_true(Spec.reached(A.Scheduled{job, due, claimed, p, z, c, ev, next})),
            q => K.imp_true(Spec.reached(A.Scheduled{job, due, claimed, p, z, c, ev, next})))
        case A.Sweep{now}:
          K.pick_split(A.Acct,
            x => {Spec.imp(Spec.reached(A.Scheduled{job, due, claimed, p, z, c, ev, next}), Bool.not(Spec.is_live(x))) == True{} : Bool},
            Nat.is_le(due, now) && ((A.finished(p) && A.finished(z)) && A.finished(c)),
            A.Erased{job, due, now, p, z, c},
            A.Scheduled{job, due, claimed, p, z, c, ev, next},
            q => K.imp_true(Spec.reached(A.Scheduled{job, due, claimed, p, z, c, ev, next})),
            q => K.imp_true(Spec.reached(A.Scheduled{job, due, claimed, p, z, c, ev, next})))
    case A.Erased{job, due, at, p, z, c}:
      {==}

# A4
# --

# Every job from here on is at least `n`.
def above(+n: Nat, +s: A.Acct) -> Bool:
  match s:
    case A.Live{m}:
      Nat.is_le(n, m)
    case A.Scheduled{job, due, claimed, p, z, c, ev, m}:
      Nat.is_le(n, job) && Nat.is_lt(job, m)
    case A.Erased{job, due, at, p, z, c}:
      Nat.is_le(n, job)

def step_above(+n: Nat, +s: A.Acct, +e: A.Ev, +h: K.T(above(n, s))) -> K.T(above(n, A.step(s, e))):
  match s:
    case A.Live{m}:
      match e:
        case A.Ask{now, req}:
          K.pick_split(A.Acct, x => K.T(above(n, x)), C.is_ok(C.verdict(req)),
            A.Scheduled{m, Nat.add(now, A.window()), False{}, A.Pending{}, A.Pending{}, A.Pending{}, C.everything_of(req), 1n+m},
            A.Live{m},
            q => K.and_intro(Nat.is_le(n, m), Nat.is_lt(m, 1n+m), h, K.lt_succ(m)),
            q => h)
        case A.Keep{now, read}:
          h
        case A.FanOut{now, rp, rz, rc}:
          h
        case A.Sweep{now}:
          h
    case A.Scheduled{job, due, claimed, p, z, c, ev, m}:
      match e:
        case A.Ask{now, req}:
          h
        case A.Keep{now, read}:
          K.pick_split(A.Acct, x => K.T(above(n, x)),
            (Nat.is_eq(read, job) && Bool.not(claimed)) && Nat.is_lt(now, due),
            A.Live{m},
            A.Scheduled{job, due, claimed, p, z, c, ev, m},
            q => K.le_lt_le(n, job, m,
                   K.and_l(Nat.is_le(n, job), Nat.is_lt(job, m), h),
                   K.and_r(Nat.is_le(n, job), Nat.is_lt(job, m), h)),
            q => h)
        case A.FanOut{now, rp, rz, rc}:
          K.pick_split(A.Acct, x => K.T(above(n, x)),
            Nat.is_le(due, now) && ((A.waiting(p) || A.waiting(z)) || A.waiting(c)),
            A.Scheduled{job, due, True{}, A.finish(p, rp), A.finish(z, rz), A.finish(c, rc), ev, m},
            A.Scheduled{job, due, claimed, p, z, c, ev, m},
            q => h,
            q => h)
        case A.Sweep{now}:
          K.pick_split(A.Acct, x => K.T(above(n, x)),
            Nat.is_le(due, now) && ((A.finished(p) && A.finished(z)) && A.finished(c)),
            A.Erased{job, due, now, p, z, c},
            A.Scheduled{job, due, claimed, p, z, c, ev, m},
            q => K.and_l(Nat.is_le(n, job), Nat.is_lt(job, m), h),
            q => h)
    case A.Erased{job, due, at, p, z, c}:
      h

def above_not_named(+j: Nat, +n: Nat, +s: A.Acct, +lt: K.T(Nat.is_lt(j, n)), +h: K.T(above(n, s)))
  -> {Spec.names_job(j, s) == False{} : Bool}:
  match s:
    case A.Live{m}:
      {==}
    case A.Scheduled{job, due, claimed, p, z, c, ev, m}:
      K.to_false(Nat.is_eq(j, job),
        K.lt_le_ne(j, n, job, lt, K.and_l(Nat.is_le(n, job), Nat.is_lt(job, m), h)))
    case A.Erased{job, due, at, p, z, c}:
      K.to_false(Nat.is_eq(j, job), K.lt_le_ne(j, n, job, lt, h))

# After a cancel of job `j` leaves the account live at `n`, any later events
# keep every job at `n` or above, so none is `j`.
def after_cancel(later: List<A.Ev>, +s: A.Acct, +j: Nat, +n: Nat, +lt: K.T(Nat.is_lt(j, n)), +h: K.T(above(n, s)))
  -> {Spec.names_job(j, A.run(later, s)) == False{} : Bool}:
  match later:
    case Nil{}:
      above_not_named(j, n, s, lt, h)
    case Con{+e, rest}:
      after_cancel(rest, A.step(s, e), j, n, lt, step_above(n, s, e, h))

def withdrawn_lemma(+s: A.Acct, +e: A.Ev, later: List<A.Ev>, +h: K.T(good(s)))
  -> {Spec.revived(Spec.withdrawn(s, A.step(s, e)), A.run(later, A.step(s, e))) == False{} : Bool}:
  match s:
    case A.Live{next}:
      {==}
    case A.Scheduled{job, due, claimed, p, z, c, ev, next}:
      match e:
        case A.Ask{now, req}:
          {==}
        case A.Keep{now, read}:
          K.pick_split(A.Acct,
            x => {Spec.revived(Spec.withdrawn(A.Scheduled{job, due, claimed, p, z, c, ev, next}, x), A.run(later, x)) == False{} : Bool},
            (Nat.is_eq(read, job) && Bool.not(claimed)) && Nat.is_lt(now, due),
            A.Live{next},
            A.Scheduled{job, due, claimed, p, z, c, ev, next},
            q => after_cancel(later, A.Live{next}, job, next,
                   K.and_l(Nat.is_lt(job, next), claimed || all_waiting(p, z, c), h),
                   K.le_refl(next)),
            q => {==})
        case A.FanOut{now, rp, rz, rc}:
          K.pick_split(A.Acct,
            x => {Spec.revived(Spec.withdrawn(A.Scheduled{job, due, claimed, p, z, c, ev, next}, x), A.run(later, x)) == False{} : Bool},
            Nat.is_le(due, now) && ((A.waiting(p) || A.waiting(z)) || A.waiting(c)),
            A.Scheduled{job, due, True{}, A.finish(p, rp), A.finish(z, rz), A.finish(c, rc), ev, next},
            A.Scheduled{job, due, claimed, p, z, c, ev, next},
            q => {==},
            q => {==})
        case A.Sweep{now}:
          K.pick_split(A.Acct,
            x => {Spec.revived(Spec.withdrawn(A.Scheduled{job, due, claimed, p, z, c, ev, next}, x), A.run(later, x)) == False{} : Bool},
            Nat.is_le(due, now) && ((A.finished(p) && A.finished(z)) && A.finished(c)),
            A.Erased{job, due, now, p, z, c},
            A.Scheduled{job, due, claimed, p, z, c, ev, next},
            q => {==},
            q => {==})
    case A.Erased{job, due, at, p, z, c}:
      {==}

# A5
# --

def restore_in_window(+s: A.Acct, +e: A.Ev)
  -> {Spec.imp(Spec.restored(s, A.step(s, e)), Spec.keeps_in_window(s, e)) == True{} : Bool}:
  match s:
    case A.Live{next}:
      {==}
    case A.Scheduled{job, due, claimed, p, z, c, ev, next}:
      match e:
        case A.Ask{now, req}:
          {==}
        case A.Keep{now, read}:
          K.pick_split(A.Acct,
            x => {Spec.imp(Spec.is_live(x), (Nat.is_eq(read, job) && Bool.not(claimed)) && Nat.is_lt(now, due)) == True{} : Bool},
            (Nat.is_eq(read, job) && Bool.not(claimed)) && Nat.is_lt(now, due),
            A.Live{next},
            A.Scheduled{job, due, claimed, p, z, c, ev, next},
            q => Equal.sym(Bool, True{}, (Nat.is_eq(read, job) && Bool.not(claimed)) && Nat.is_lt(now, due), q),
            q => {==})
        case A.FanOut{now, rp, rz, rc}:
          K.pick_split(A.Acct,
            x => {Spec.imp(Spec.is_live(x), False{}) == True{} : Bool},
            Nat.is_le(due, now) && ((A.waiting(p) || A.waiting(z)) || A.waiting(c)),
            A.Scheduled{job, due, True{}, A.finish(p, rp), A.finish(z, rz), A.finish(c, rc), ev, next},
            A.Scheduled{job, due, claimed, p, z, c, ev, next},
            q => {==},
            q => {==})
        case A.Sweep{now}:
          K.pick_split(A.Acct,
            x => {Spec.imp(Spec.is_live(x), False{}) == True{} : Bool},
            Nat.is_le(due, now) && ((A.finished(p) && A.finished(z)) && A.finished(c)),
            A.Erased{job, due, now, p, z, c},
            A.Scheduled{job, due, claimed, p, z, c, ev, next},
            q => {==},
            q => {==})
    case A.Erased{job, due, at, p, z, c}:
      {==}

# A6
# --

def stale_cancel(+s: A.Acct, +now: Nat, +read: Nat)
  -> {Spec.imp(Bool.not(Spec.names_job(read, s)), Bool.not(Spec.restored(s, A.step(s, A.Keep{now, read})))) == True{} : Bool}:
  match s:
    case A.Live{next}:
      {==}
    case A.Scheduled{job, due, claimed, p, z, c, ev, next}:
      K.pick_split(A.Acct,
        x => {Spec.imp(Bool.not(Nat.is_eq(read, job)), Bool.not(Spec.is_live(x))) == True{} : Bool},
        (Nat.is_eq(read, job) && Bool.not(claimed)) && Nat.is_lt(now, due),
        A.Live{next},
        A.Scheduled{job, due, claimed, p, z, c, ev, next},
        q => K.to_eq(Bool.not(Bool.not(Nat.is_eq(read, job))) || False{},
               K.or_l(Bool.not(Bool.not(Nat.is_eq(read, job))), False{},
                 K.nn_intro(Nat.is_eq(read, job),
                   K.and_l(Nat.is_eq(read, job), Bool.not(claimed),
                     K.and_l(Nat.is_eq(read, job) && Bool.not(claimed), Nat.is_lt(now, due),
                       K.from_eq((Nat.is_eq(read, job) && Bool.not(claimed)) && Nat.is_lt(now, due), q)))))),
        q => K.imp_true(Bool.not(Nat.is_eq(read, job))))
    case A.Erased{job, due, at, p, z, c}:
      K.imp_true(Bool.not(Nat.is_eq(read, job)))

# A7
# --

def scheduled_answered(+s: A.Acct, +e: A.Ev)
  -> {Spec.imp(Spec.scheduled(s, A.step(s, e)), Spec.asked_answered(e)) == True{} : Bool}:
  match s:
    case A.Live{next}:
      match e:
        case A.Ask{now, req}:
          K.pick_split(A.Acct,
            x => {Spec.imp(Bool.not(Spec.is_live(x)), Spec.answered(req)) == True{} : Bool},
            C.is_ok(C.verdict(req)),
            A.Scheduled{next, Nat.add(now, A.window()), False{}, A.Pending{}, A.Pending{}, A.Pending{}, C.everything_of(req), 1n+next},
            A.Live{next},
            q => K.to_eq(Spec.answered(req),
                   K.imp_elim(C.is_ok(C.verdict(req)), Spec.answered(req),
                     PC.verdict_answered(req),
                     K.from_eq(C.is_ok(C.verdict(req)), q))),
            q => {==})
        case A.Keep{now, read}:
          {==}
        case A.FanOut{now, rp, rz, rc}:
          {==}
        case A.Sweep{now}:
          {==}
    case A.Scheduled{job, due, claimed, p, z, c, ev, next}:
      {==}
    case A.Erased{job, due, at, p, z, c}:
      {==}
