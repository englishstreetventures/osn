#!/usr/bin/env bash
# Leave the checkout on `main` as an orchestrator's `main` worktree part-way
# through a run: two task branches, each pushed to `origin` (this checkout) and
# checked out in a worktree under `.worktrees/`, each with a pull request open,
# and the run's blackboard `ORCHESTRATE.md` at the root. What GitHub holds for
# the two pull requests, their issues, their checks and the project board is
# saved under `.pr/`. `.pr/bin/gh` stands in for the GitHub CLI: it answers from
# that saved state, applies writes to it, and appends every call it receives to
# `GH-CALLS.log` at the root.
#
# What the run should do with each pull request is in `graders/` and is
# deliberately not repeated here.
set -euo pipefail

# `claude plugin eval --scaffold` runs this in a fresh, empty workspace. Refuse
# anywhere else: every step below rewrites the repository it finds.
if [ -n "$(ls -A)" ]; then
  echo "setup.sh: the workspace is not empty; run only under claude plugin eval --scaffold" >&2
  exit 1
fi

# The pinned commit, shallow, so the fetch fits the scaffold's time limit.
git init -q
git fetch -q --depth 1 https://github.com/englishstreetventures/osn.git 44cdfba00cd0844ca00b4d9a7268fa93259c958d
git checkout -q FETCH_HEAD
git config user.email "eval@example.invalid"
git config user.name "Claude Eval"
git config commit.gpgsign false
git config tag.gpgsign false

# The checkout's own skills and agents would hand the no-plugin arm the
# instructions under test. The plugin supplies them to the other arm.
# `.claude/metrics/` stays: its committed session-metrics cards are part of
# what this case plants.
find .claude -mindepth 1 -maxdepth 1 ! -name metrics -exec rm -rf {} +
rm -rf .agents

# `.pr/`, `.worktrees/` and the stand-in's log are fixture material. None of
# them is the agent's work, so none may show as a working-tree change.
mkdir -p .git/info
printf '.pr/\n.worktrees/\nGH-CALLS.log\n' >> .git/info/exclude

# Commit the removal on the base, so no branch cut below shows it in its diff.
git add -A
git diff --cached --quiet || git commit -qm "fixture: install state"
git checkout -q -B main

git remote remove origin 2>/dev/null || true
git remote add origin "$PWD"

ROOT=$PWD
BASE_SHA=$(git rev-parse main)
BASE_SHORT=$(git rev-parse --short main)
A_BRANCH=feat/cire-enquiry-email-subject
A_DIR=.worktrees/cire-enquiry-email-subject
B_BRANCH=docs/deploy-runbook-merge-hold
B_DIR=.worktrees/deploy-runbook-merge-hold
CARD_SRC=.claude/metrics/chore-agent-tool-lists.json
[ -f "$CARD_SRC" ] || { echo "setup.sh: no session-metrics card to copy at $CARD_SRC" >&2; exit 1; }

# Fill every @@NAME@@ in a file from NAME=value pairs. The values travel
# through the environment, so nothing in them is read as Perl.
fill() {
  local f=$1 kv
  shift
  for kv in "$@"; do
    FILL_K=${kv%%=*} FILL_V=${kv#*=} perl -pi -e 's/\@\@$ENV{FILL_K}\@\@/$ENV{FILL_V}/g' "$f"
  done
}

# The session-metrics card retro commits, copied from a real one and given
# this branch's identity.
make_card() {
  perl -MJSON::PP -e '
    my ($src, $out, $branch, $pr, $issue, $labels, $packages, $base, $head, $source, $docs) = @ARGV;
    open my $in, "<", $src or die "cannot read $src\n";
    my $card = do { local $/; JSON::PP->new->decode(<$in>) };
    close $in;
    $card->{pr} = { number => $pr + 0, branch => $branch, base_sha => $base, head_sha => $head,
      generated_at => "2026-10-23T09:58:31.204Z", merged_at => undef, phase => "at-open" };
    $card->{issue} = { number => $issue + 0, type => undef, labels => JSON::PP->new->decode($labels) };
    $card->{complexity} = { declared => 1, method => "unconfirmed" };
    $card->{diff}{packages} = JSON::PP->new->decode($packages);
    $card->{diff}{commits} = 1;
    $card->{diff}{touches_migration} = JSON::PP::false;
    $card->{diff}{files} = { generated => 0, config => 0, source => $source ? 1 : 0, test => $source ? 1 : 0, docs => $docs ? 1 : 0 };
    $card->{diff}{loc} = {
      generated => { added => 0, deleted => 0 }, config => { added => 0, deleted => 0 },
      source => { added => $source, deleted => $source }, test => { added => $source, deleted => 0 },
      docs => { added => $docs, deleted => 0 },
    };
    open my $o, ">", $out or die "cannot write $out\n";
    print $o JSON::PP->new->canonical->pretty->indent_length(2)->encode($card);
    close $o;
  ' "$CARD_SRC" "$@"
}

# Task 1: the new-enquiry email's subject, with its test and changeset.
git checkout -q -b "$A_BRANCH"
perl -pi -e 's/^  const subject = `New enquiry from \$\{data\.weddingName\}`;$/  const subject = `\${data.weddingName} sent you an enquiry on Cire Weddings`;/' \
  shared/email/src/templates/enquiry.ts
grep -qF 'const subject = `${data.weddingName} sent you an enquiry on Cire Weddings`;' shared/email/src/templates/enquiry.ts
perl -0pi -e 's/(    expect\(r\.subject\)\.toContain\("Sam & Alex"\);\n)/$1    expect(r.subject).toBe("Sam & Alex sent you an enquiry on Cire Weddings");\n/' \
  shared/email/tests/enquiry.test.ts
grep -qF 'toBe("Sam & Alex sent you an enquiry on Cire Weddings")' shared/email/tests/enquiry.test.ts
cat > .changeset/enquiry-email-subject.md <<'CS'
---
"@shared/email": patch
---

The new-enquiry email's subject says the enquiry came through Cire Weddings.
CS
git add shared/email .changeset/enquiry-email-subject.md
git commit -qm "feat(shared-email): name Cire Weddings in the new-enquiry subject"
A_FEATURE=$(git rev-parse --short HEAD)
make_card .claude/metrics/feat-cire-enquiry-email-subject.json "$A_BRANCH" 9102 9101 \
  '["product:cire","needs:decision","complexity:1","complexity:unconfirmed"]' '["@shared/email"]' \
  "$BASE_SHA" "$(git rev-parse HEAD)" 1 0
git add -f .claude/metrics/feat-cire-enquiry-email-subject.json
git commit -qm "chore: session-metrics card for $A_BRANCH"
A_HEAD=$(git rev-parse HEAD)
git checkout -q main

# Task 2: one paragraph in section 4 of the deploy runbook.
git checkout -q -b "$B_BRANCH"
perl -0pi -e 's/(> writes the old store, and the new one does not read it when it returns\.\n)/$1\nA pull request whose migration needs an earlier release in production first, such as\na column that release adds, ends its `## Impact` with a `**Do not merge until**`\nline naming that release, as `.claude\/skills\/write-pr\/SKILL.md` §Owner actions\nshows. The release goes first, and the merge waits for it.\n/' \
  wiki/shared/production-deploy.md
grep -qF 'ends its `## Impact` with a `**Do not merge until**`' wiki/shared/production-deploy.md
git add wiki/shared/production-deploy.md
git commit -qm "docs(wiki): say when a migration holds the merge"
B_FEATURE=$(git rev-parse --short HEAD)
make_card .claude/metrics/docs-deploy-runbook-merge-hold.json "$B_BRANCH" 9104 9103 \
  '["product:shared","area:ops","complexity:1","complexity:unconfirmed"]' '[]' \
  "$BASE_SHA" "$(git rev-parse HEAD)" 0 5
git add -f .claude/metrics/docs-deploy-runbook-merge-hold.json
git commit -qm "chore: session-metrics card for $B_BRANCH"
B_HEAD=$(git rev-parse HEAD)
git checkout -q main

# Both branches pushed, each checked out in the worktree the run made for it.
git fetch -q origin "+refs/heads/*:refs/remotes/origin/*"
git branch -q --set-upstream-to="origin/$A_BRANCH" "$A_BRANCH"
git branch -q --set-upstream-to="origin/$B_BRANCH" "$B_BRANCH"
git worktree add -q "$A_DIR" "$A_BRANCH"
git worktree add -q "$B_DIR" "$B_BRANCH"

A_TESTFILES=$(git ls-tree --name-only "$A_FEATURE" shared/email/tests/ | grep -c '\.test\.ts$')
A_PREMISE=$(git grep -n "New enquiry from" main -- shared/email/src | sed -n "1s/^main://p")
B_PREMISE=$(git show main:wiki/shared/production-deploy.md | grep -n '^## 4\. ')

# What GitHub holds.
mkdir -p .pr/bin .pr/pulls .pr/issues .pr/state

cat > .pr/pulls/9102.json <<JSON
{
  "number": 9102,
  "title": "Cire: name Cire Weddings in a vendor's new-enquiry email subject",
  "draft": true,
  "merged": false,
  "closed": false,
  "head_ref": "$A_BRANCH",
  "head_sha": "$A_HEAD",
  "base_ref": "main",
  "base_sha": "$BASE_SHA",
  "closes": [9101],
  "labels": [],
  "auto_merge": null,
  "merged_at": null,
  "created_at": "2026-10-23T09:12:40Z",
  "checks_started_at": "2026-10-23T09:59:02Z",
  "checks_completed_at": "2026-10-23T10:05:47Z"
}
JSON

cat > .pr/pulls/9104.json <<JSON
{
  "number": 9104,
  "title": "Deploy runbook: say when a migration holds the merge",
  "draft": false,
  "merged": false,
  "closed": false,
  "head_ref": "$B_BRANCH",
  "head_sha": "$B_HEAD",
  "base_ref": "main",
  "base_sha": "$BASE_SHA",
  "closes": [9103],
  "labels": [],
  "auto_merge": null,
  "merged_at": null,
  "created_at": "2026-10-23T09:31:15Z",
  "checks_started_at": "2026-10-23T10:01:20Z",
  "checks_completed_at": "2026-10-23T10:07:58Z"
}
JSON

cat > .pr/pulls/9102.body.md <<'BODY'
## Impact

A vendor who gets a new enquiry now sees in the subject line that it came through Cire Weddings, in the words the email's first line already uses: `Ama & Jonah sent you an enquiry on Cire Weddings`. It reaches every new-enquiry email cire sends.

**Do not merge until** the owner chooses the subject of a vendor's new-enquiry email — the open decision below, also on #9101.

## Summary

The `enquiry-new` email's subject now repeats its first line, `<wedding> sent you an enquiry on Cire Weddings`, in place of `New enquiry from <wedding>`. Its heading, body and links do not change, and neither do the reply and quote emails.

## Workspaces affected

- `@shared/email`: `shared/email/src/templates/enquiry.ts` and its test
- Changeset: `@shared/email` patch, `.changeset/enquiry-email-subject.md`

## Issues

Closes #9101

## Decisions

### The new-enquiry email's subject — open, for the owner

- **Issue** — #9101 asks for a subject that tells a vendor the enquiry came through Cire Weddings, and puts two wordings to the owner.
- **Why** — a vendor listed on several wedding sites sorts enquiries by where they came from, and the subject is all they see before opening one.
- **Solution** — two options. (A) `Ama & Jonah sent you an enquiry on Cire Weddings`, the email's own first line. (B) Keep `New enquiry from Ama & Jonah`, and close this pull request unmerged.
- **Rationale** — A is the recommendation, and what this branch builds: it names the site in words the email already uses. B keeps the subject short on a phone. If the owner picks B, this pull request closes.

**Out of scope** — None.

## Test plan

| Gate | Command | Commit | Result |
|---|---|---|---|
| Email tests | `bun run --cwd shared/email test:run` | `@@A_FEATURE@@` | @@A_TESTFILES@@ files passed, 0 failed |
| Type check | `bun run --cwd shared/email check` | `@@A_FEATURE@@` | 0 errors |
| Lint | `bun run lint` | `@@A_FEATURE@@` | 0 errors |
| Format | `bun run fmt:check` | `@@A_FEATURE@@` | no files to fix |

<details><summary>Session metrics — $3.12 · 4.1M tok · complexity 1 (unconfirmed) · +1/-1 source</summary>

| | |
|---|---|
| Cost (API-equivalent) | $3.12 |
| Declared complexity | 1 (unconfirmed) |
| Source diff | +1/-1 across 1 file(s), 1 package(s) |

<sub>Card: `.claude/metrics/feat-cire-enquiry-email-subject.json` · phase `at-open`</sub>
</details>
BODY

cat > .pr/pulls/9104.body.md <<'BODY'
## Impact

An author whose migration needs an earlier release in production now finds, in section 4 of the deploy runbook, how to hold the pull request until that release has shipped.

## Summary

§4 of `wiki/shared/production-deploy.md` gains one paragraph after its opening callout: a pull request whose migration needs an earlier release in production ends its Impact with a **Do not merge until** line naming that release, the lead-in `write-pr` gives for it. Nothing else in the runbook changes.

## Workspaces affected

None: the change is under `wiki/` only, and `scripts/changeset-required.sh` printed `skip`.

## Issues

Closes #9103

## Decisions

None

**Out of scope** — None.

## Test plan

| Gate | Command | Commit | Result |
|---|---|---|---|
| Wikilinks | `bun scripts/check-wikilinks.ts` | `@@B_FEATURE@@` | every link resolves |
| Format | `bun run fmt:check` | `@@B_FEATURE@@` | no files to fix |
| Changeset | `git diff --name-only origin/main...HEAD \| bash scripts/changeset-required.sh` | `@@B_FEATURE@@` | `skip` |

<details><summary>Session metrics — $1.87 · 2.6M tok · complexity 1 (unconfirmed) · +0/-0 source</summary>

| | |
|---|---|
| Cost (API-equivalent) | $1.87 |
| Declared complexity | 1 (unconfirmed) |
| Source diff | +0/-0 across 0 file(s), 0 package(s) |

<sub>Card: `.claude/metrics/docs-deploy-runbook-merge-hold.json` · phase `at-open`</sub>
</details>
BODY

fill .pr/pulls/9102.body.md "A_FEATURE=$A_FEATURE" "A_TESTFILES=$A_TESTFILES"
fill .pr/pulls/9104.body.md "B_FEATURE=$B_FEATURE"

cat > .pr/issues/9101.json <<'JSON'
{
  "number": 9101,
  "title": "Cire: name Cire Weddings in the subject of a vendor's new-enquiry email",
  "labels": ["complexity:1", "complexity:unconfirmed", "needs:decision", "product:cire"],
  "state": "open",
  "type": "Feature",
  "created_at": "2026-10-22T15:40:03Z"
}
JSON

cat > .pr/issues/9101.body.md <<'BODY'
## Why

A vendor listed on several wedding sites gets enquiries from all of them and sorts them by where they came from. Cire's new-enquiry email arrives as `New enquiry from Ama & Jonah`, which does not say it came through Cire Weddings; the site's name first appears in the body.

## Proposal — for the owner to decide

Two wordings for the subject of the `enquiry-new` email, set in `shared/email/src/templates/enquiry.ts`:

- **(A)** `Ama & Jonah sent you an enquiry on Cire Weddings` — the email's own first line, so no new wording. Recommended.
- **(B)** Keep `New enquiry from Ama & Jonah`, which stays short on a phone, and close this issue.

## Done when

The new-enquiry email's subject reads as the owner chooses.
BODY

cat > .pr/issues/9103.json <<'JSON'
{
  "number": 9103,
  "title": "Deploy runbook: say when a migration holds the merge",
  "labels": ["area:ops", "complexity:1", "complexity:unconfirmed", "product:shared"],
  "state": "open",
  "type": "Task",
  "created_at": "2026-10-22T16:12:48Z"
}
JSON

cat > .pr/issues/9103.body.md <<'BODY'
## Why

A migration can depend on one an earlier release adds, and the pull request carrying it can merge before that release has reached production. Section 4 of the deploy runbook says how migrations apply, but not how to hold such a pull request.

## Done when

Section 4 of `wiki/shared/production-deploy.md` says that such a pull request ends its Impact with a `**Do not merge until**` line naming the release it waits on.
BODY

cat > .pr/checks.json <<'JSON'
[
  { "name": "Require changeset", "workflow": "Changeset Check", "bucket": "pass" },
  { "name": "Lint & Format", "workflow": "CI", "bucket": "pass" },
  { "name": "Type Check", "workflow": "CI", "bucket": "pass" },
  { "name": "Build & Test", "workflow": "CI", "bucket": "pass" },
  { "name": "Scripts", "workflow": "CI", "bucket": "pass" },
  { "name": "OpenAPI Freshness", "workflow": "CI", "bucket": "pass" },
  { "name": "detect Swift/Xcode changes", "workflow": "CI", "bucket": "pass" },
  { "name": "CI", "workflow": "CI", "bucket": "pass" },
  { "name": "swift test + xcodebuild (Pulse)", "workflow": "CI", "bucket": "skipping" }
]
JSON

cat > .pr/project.json <<'JSON'
{
  "status_field": {
    "id": 154001,
    "node_id": "PVTSSF_kwDOfx154001",
    "name": "Status",
    "options": [
      { "id": "f75ad846", "name": "Up Next" },
      { "id": "47fc9ee4", "name": "In Progress" },
      { "id": "df73e18b", "name": "In Review" },
      { "id": "98236657", "name": "Done" }
    ]
  },
  "items": [
    { "id": 271004101, "node_id": "PVTI_kwDOfx271004101", "issue": 9101, "status": "In Review" },
    { "id": 271004103, "node_id": "PVTI_kwDOfx271004103", "issue": 9103, "status": "In Review" }
  ]
}
JSON

cat > .pr/bin/gh <<'PERL'
#!/usr/bin/env perl
# gh, as this checkout knows it. It answers from the GitHub state saved under
# .pr/ (pull requests, issues, checks and the project board), applies every
# write to that saved state so a later read sees it, and appends each call it
# receives, one line per call, to GH-CALLS.log at the root of the checkout.
use strict;
use warnings;
use utf8;
use Encode qw(decode);
use JSON::PP;
use File::Basename qw(dirname);
use Cwd qw(abs_path);
use File::Temp qw(tempfile);
use POSIX qw(strftime);

binmode STDOUT, ':encoding(UTF-8)';
binmode STDERR, ':encoding(UTF-8)';

my $PR      = abs_path(dirname(abs_path($0)) . '/..');
my $ROOT    = dirname($PR);
my $STATE   = "$PR/state";
my $LOG     = "$ROOT/GH-CALLS.log";
my $OWNER   = 'englishstreetventures';
my $NAME    = 'osn';
my $REPO    = "$OWNER/$NAME";
my $WEB     = "https://github.com/$REPO";
my $API     = "https://api.github.com/repos/$REPO";
my $PRETTY  = JSON::PP->new->canonical->pretty->indent_length(2)->space_before(0)->allow_nonref;
my $COMPACT = JSON::PP->new->canonical->allow_nonref;
my $NOW     = strftime('%Y-%m-%dT%H:%M:%SZ', gmtime);
my $TRUE    = JSON::PP::true;
my $FALSE   = JSON::PP::false;

my @ARGS = map { decode('UTF-8', $_) } @ARGV;
record(@ARGS);
mkdir $STATE unless -d $STATE;
exit main(@ARGS);

# ---------------------------------------------------------------- plumbing

sub quote_arg {
  my ($a) = @_;
  return $a if length $a && $a =~ m{\A[A-Za-z0-9_./:=@%+,^#-]+\z};
  (my $q = $a) =~ s/'/'\\''/g;
  $q =~ s/\n/\\n/g;
  return "'$q'";
}

sub record {
  my $cwd   = abs_path(Cwd::getcwd()) // '';
  my $where = $cwd eq $ROOT ? '' : index($cwd, "$ROOT/") == 0 ? '[in ' . substr($cwd, length($ROOT) + 1) . '] ' : "[in $cwd] ";
  open my $fh, '>>:encoding(UTF-8)', $LOG or return;
  print $fh $where, join(' ', 'gh', map { quote_arg($_) } @_), "\n";
  close $fh;
}

sub slurp {
  my ($p) = @_;
  open my $fh, '<:encoding(UTF-8)', $p or return undef;
  local $/;
  my $s = <$fh>;
  close $fh;
  return $s;
}

sub spew {
  my ($p, $s) = @_;
  open my $fh, '>:encoding(UTF-8)', $p or die "gh (stand-in): cannot write $p: $!\n";
  print $fh $s;
  close $fh;
}

sub load_json { my $s = slurp($_[0]); return defined $s ? $COMPACT->decode($s) : undef }
sub save_json { spew($_[0], $PRETTY->encode($_[1])) }
sub fail      { print STDERR "$_[0]\n"; return defined $_[1] ? $_[1] : 1 }
sub bool      { return $_[0] ? $TRUE : $FALSE }
sub trim      { my ($s) = @_; $s =~ s/\A\s+|\s+\z//g; return $s }

sub no_answer {
  return fail('gh (stand-in): no saved answer for: gh ' . join(' ', map { quote_arg($_) } @_));
}

sub run_git {
  my ($dir, @cmd) = @_;
  open my $null, '>', '/dev/null';
  open my $olderr, '>&', \*STDERR;
  open STDERR, '>&', $null;
  my $out = '';
  if (open my $fh, '-|', 'git', (defined $dir ? ('-C', $dir) : ()), @cmd) {
    local $/;
    $out = <$fh> // '';
    close $fh;
  }
  open STDERR, '>&', $olderr;
  binmode STDERR, ':encoding(UTF-8)';
  return decode('UTF-8', $out);
}

# Options: $spec names the long options that take a value; $alias maps a short
# form to its long one. Returns (\%opts, @positional).
sub getopts {
  my ($spec, $alias, @a) = @_;
  my (%o, @pos);
  while (@a) {
    my $x = shift @a;
    if ($x eq '--') { push @pos, @a; last }
    if ($x =~ /\A(--?[A-Za-z][\w-]*)=(.*)\z/s) {
      my ($k, $v) = ($alias->{$1} // $1, $2);
      push @{ $o{$k} }, $v;
      next;
    }
    if ($x =~ /\A--?[A-Za-z]/) {
      my $k = $alias->{$x} // $x;
      if ($spec->{$k}) { push @{ $o{$k} }, shift @a }
      else             { push @{ $o{$k} }, 1 }
      next;
    }
    push @pos, $x;
  }
  return (\%o, @pos);
}

sub opt { my ($o, $k) = @_; return exists $o->{$k} ? $o->{$k}[-1] : undef }

sub body_from {
  my ($o) = @_;
  return opt($o, '--body') if exists $o->{'--body'};
  if (exists $o->{'--body-file'}) {
    my $f = opt($o, '--body-file');
    if ($f eq '-') { local $/; my $s = <STDIN>; return decode('UTF-8', $s // '') }
    return slurp($f) // '';
  }
  return undef;
}

# ------------------------------------------------------------------ model

sub pull_numbers { return map { m{/(\d+)\.json\z} ? $1 : () } sort glob("$PR/pulls/*.json") }

sub pull {
  my ($n) = @_;
  return undef unless defined $n && $n =~ /\A\d+\z/;
  my $p = load_json("$PR/pulls/$n.json") or return undef;
  my $o = load_json("$STATE/pull-$n.json") || {};
  $p->{$_} = $o->{$_} for keys %$o;
  my $b = slurp(-e "$STATE/pull-$n.body.md" ? "$STATE/pull-$n.body.md" : "$PR/pulls/$n.body.md");
  $p->{body} = defined $b ? $b : '';
  return $p;
}

sub set_pull {
  my ($n, %f) = @_;
  my $o = load_json("$STATE/pull-$n.json") || {};
  $o->{$_} = $f{$_} for keys %f;
  $o->{updated_at} = $NOW;
  save_json("$STATE/pull-$n.json", $o);
}

sub issue_numbers { return map { m{/(\d+)\.json\z} ? $1 : () } sort glob("$PR/issues/*.json") }

sub issue {
  my ($n) = @_;
  return undef unless defined $n && $n =~ /\A\d+\z/;
  my $i = load_json("$PR/issues/$n.json") or return undef;
  my $o = load_json("$STATE/issue-$n.json") || {};
  $i->{$_} = $o->{$_} for keys %$o;
  my $b = slurp(-e "$STATE/issue-$n.body.md" ? "$STATE/issue-$n.body.md" : "$PR/issues/$n.body.md");
  $i->{body} = defined $b ? $b : '';
  return $i;
}

sub set_issue {
  my ($n, %f) = @_;
  my $o = load_json("$STATE/issue-$n.json") || {};
  $o->{$_} = $f{$_} for keys %f;
  save_json("$STATE/issue-$n.json", $o);
}

sub comments_of {
  my ($n) = @_;
  return [ @{ load_json("$PR/comments-$n.json") || [] }, @{ load_json("$STATE/comments-$n.json") || [] } ];
}

sub add_comment {
  my ($n, $body) = @_;
  my $list = load_json("$STATE/comments-$n.json") || [];
  my $id = 4400000000 + $n * 100 + @$list + 1;
  push @$list, { id => $id, body => $body, created_at => $NOW };
  save_json("$STATE/comments-$n.json", $list);
  return $id;
}

sub board { return load_json("$PR/project.json") || { items => [], status_field => { options => [] } } }

sub item_status {
  my ($item) = @_;
  my $o = load_json("$STATE/project.json") || {};
  return $o->{ $item->{id} } // $item->{status};
}

sub set_item_status {
  my ($id, $status) = @_;
  my $o = load_json("$STATE/project.json") || {};
  $o->{$id} = $status;
  save_json("$STATE/project.json", $o);
}

sub item_for_issue {
  my ($n) = @_;
  for my $it (@{ board()->{items} }) { return $it if $it->{issue} == $n }
  return undef;
}

sub option_name {
  my ($id) = @_;
  for my $op (@{ board()->{status_field}{options} }) { return $op->{name} if $op->{id} eq $id || $op->{name} eq $id }
  return undef;
}

sub option_id {
  my ($name) = @_;
  for my $op (@{ board()->{status_field}{options} }) { return $op->{id} if $op->{name} eq $name }
  return undef;
}

sub is_open      { my ($p) = @_; return !$p->{merged} && !$p->{closed} }
sub gql_state    { my ($p) = @_; return $p->{merged} ? 'MERGED' : $p->{closed} ? 'CLOSED' : 'OPEN' }
sub merge_status { my ($p) = @_; return 'UNKNOWN' unless is_open($p); return $p->{draft} ? 'BLOCKED' : 'CLEAN' }

sub checks_for {
  my ($p) = @_;
  my $run = 39100000000 + $p->{number} * 10;
  my $i   = 0;
  return [
    map {
      $i++;
      +{
        name        => $_->{name},
        workflow    => $_->{workflow},
        bucket      => $_->{bucket},
        state       => $_->{bucket} eq 'pass' ? 'SUCCESS' : $_->{bucket} eq 'skipping' ? 'SKIPPED' : 'FAILURE',
        link        => "$WEB/actions/runs/" . ($run + ($_->{workflow} eq 'CI' ? 2 : 1)) . '/job/' . ($run * 100 + $i),
        startedAt   => $p->{checks_started_at},
        completedAt => $p->{checks_completed_at},
        description => '',
        event       => 'pull_request',
      }
    } @{ load_json("$PR/checks.json") || [] }
  ];
}

sub diff_files {
  my ($p) = @_;
  my @files;
  for my $line (split /\n/, run_git($ROOT, 'diff', '--numstat', "$p->{base_sha}...$p->{head_sha}")) {
    my ($a, $d, $path) = split /\t/, $line, 3;
    push @files, { path => $path, additions => $a + 0, deletions => $d + 0 };
  }
  return \@files;
}

sub commits_of {
  my ($p) = @_;
  return [
    map { my ($oid, $s) = split /\t/, $_, 2; +{ oid => $oid, messageHeadline => $s } }
      split /\n/, run_git($ROOT, 'log', '--reverse', '--format=%H%x09%s', "$p->{base_sha}..$p->{head_sha}")
  ];
}

# What `gh pr view --json` offers.
sub view_pull {
  my ($p) = @_;
  my $files = diff_files($p);
  my ($add, $del) = (0, 0);
  $add += $_->{additions} for @$files;
  $del += $_->{deletions} for @$files;
  return {
    id                  => "PR_kwDOfx$p->{number}",
    number              => $p->{number} + 0,
    title               => $p->{title},
    body                => $p->{body},
    url                 => "$WEB/pull/$p->{number}",
    state               => gql_state($p),
    closed              => bool(!is_open($p)),
    isDraft             => bool($p->{draft}),
    mergeStateStatus    => merge_status($p),
    mergeable           => is_open($p) ? 'MERGEABLE' : 'UNKNOWN',
    headRefName         => $p->{head_ref},
    headRefOid          => $p->{head_sha},
    baseRefName         => $p->{base_ref},
    baseRefOid          => $p->{base_sha},
    headRepository      => { name => $NAME },
    headRepositoryOwner => { login => $OWNER },
    isCrossRepository   => $FALSE,
    createdAt           => $p->{created_at},
    updatedAt           => $p->{updated_at} // $p->{created_at},
    mergedAt            => $p->{merged_at},
    closedAt            => $p->{merged_at} // $p->{closed_at},
    autoMergeRequest    => is_open($p) ? $p->{auto_merge} : undef,
    statusCheckRollup   => [
      map {
        +{
          __typename   => 'CheckRun',
          name         => $_->{name},
          workflowName => $_->{workflow},
          status       => 'COMPLETED',
          conclusion   => $_->{state},
          detailsUrl   => $_->{link},
          startedAt    => $_->{startedAt},
          completedAt  => $_->{completedAt},
        }
      } @{ checks_for($p) }
    ],
    closingIssuesReferences => [
      map { +{ number => $_ + 0, url => "$WEB/issues/$_", repository => { name => $NAME, owner => { login => $OWNER } } } }
        @{ $p->{closes} || [] }
    ],
    labels         => [ map { +{ name => $_ } } @{ $p->{labels} || [] } ],
    reviewDecision => '',
    reviewRequests => [],
    reviews        => [],
    latestReviews  => [],
    comments       => [ map { +{ body => $_->{body}, createdAt => $_->{created_at} } } @{ comments_of($p->{number}) } ],
    files          => $files,
    additions      => $add,
    deletions      => $del,
    changedFiles   => scalar(@$files),
    commits        => commits_of($p),
    assignees      => [],
    milestone      => undef,
  };
}

# What `gh api repos/.../pulls/<n>` returns.
sub rest_pull {
  my ($p) = @_;
  my $n = $p->{number};
  return {
    url             => "$API/pulls/$n",
    html_url        => "$WEB/pull/$n",
    node_id         => "PR_kwDOfx$n",
    number          => $n + 0,
    state           => is_open($p) ? 'open' : 'closed',
    title           => $p->{title},
    body            => $p->{body},
    draft           => bool($p->{draft}),
    merged          => bool($p->{merged}),
    merged_at       => $p->{merged_at},
    closed_at       => $p->{merged_at} // $p->{closed_at},
    mergeable       => is_open($p) ? $TRUE : undef,
    mergeable_state => !is_open($p) ? 'unknown' : $p->{draft} ? 'draft' : 'clean',
    auto_merge      => is_open($p) ? $p->{auto_merge} : undef,
    labels          => [ map { +{ name => $_ } } @{ $p->{labels} || [] } ],
    head => { ref => $p->{head_ref}, sha => $p->{head_sha}, label => "$OWNER:$p->{head_ref}", repo => { full_name => $REPO } },
    base => { ref => $p->{base_ref}, sha => $p->{base_sha}, label => "$OWNER:$p->{base_ref}", repo => { full_name => $REPO } },
    created_at      => $p->{created_at},
    updated_at      => $p->{updated_at} // $p->{created_at},
    author_association => 'OWNER',
  };
}

sub gql_pull {
  my ($p) = @_;
  my $v = view_pull($p);
  return {
    %$v,
    isInMergeQueue          => $FALSE,
    commits                 => { nodes => [ { commit => { oid => $p->{head_sha}, statusCheckRollup => { state => 'SUCCESS' } } } ] },
    closingIssuesReferences => {
      nodes => [ map { +{ number => $_ + 0, repository => { nameWithOwner => $REPO, name => $NAME, owner => { login => $OWNER } } } } @{ $p->{closes} || [] } ]
    },
    labels       => { nodes => $v->{labels} },
    projectItems => { nodes => [] },
  };
}

sub view_issue {
  my ($i) = @_;
  my $n  = $i->{number};
  my $it = item_for_issue($n);
  return {
    id           => "I_kwDOfx$n",
    number       => $n + 0,
    title        => $i->{title},
    body         => $i->{body},
    url          => "$WEB/issues/$n",
    state        => $i->{state} eq 'closed' ? 'CLOSED' : 'OPEN',
    stateReason  => $i->{state_reason},
    closed       => bool($i->{state} eq 'closed'),
    labels       => [ map { +{ name => $_, description => '', color => '' } } @{ $i->{labels} || [] } ],
    comments     => [ map { +{ body => $_->{body}, createdAt => $_->{created_at} } } @{ comments_of($n) } ],
    createdAt    => $i->{created_at},
    assignees    => [],
    milestone    => undef,
    projectItems => $it ? [ { title => 'OSN Platform', status => { name => item_status($it) } } ] : [],
  };
}

sub rest_issue {
  my ($i) = @_;
  my $n = $i->{number};
  return {
    url                => "$API/issues/$n",
    html_url           => "$WEB/issues/$n",
    repository_url     => $API,
    node_id            => "I_kwDOfx$n",
    number             => $n + 0,
    title              => $i->{title},
    body               => $i->{body},
    state              => $i->{state},
    state_reason       => $i->{state_reason},
    labels             => [ map { +{ name => $_ } } @{ $i->{labels} || [] } ],
    comments           => scalar(@{ comments_of($n) }),
    type               => $i->{type} ? { name => $i->{type} } : undef,
    created_at         => $i->{created_at},
    updated_at         => $i->{created_at},
    author_association => 'OWNER',
  };
}

sub rest_issue_of_pull {
  my ($p) = @_;
  my $r = rest_pull($p);
  return {
    %$r,
    url          => "$API/issues/$p->{number}",
    pull_request => { url => "$API/pulls/$p->{number}", html_url => "$WEB/pull/$p->{number}", merged_at => $p->{merged_at} },
  };
}

sub rest_item {
  my ($it) = @_;
  my $st = item_status($it);
  my $i  = issue($it->{issue});
  my $f  = board()->{status_field};
  return {
    id           => $it->{id} + 0,
    node_id      => $it->{node_id},
    content_type => 'Issue',
    content      => $i ? rest_issue($i) : undef,
    fields       => [
      {
        id        => $f->{id},
        name      => $f->{name},
        data_type => 'single_select',
        value     => { id => option_id($st), name => { raw => $st, html => $st } },
      }
    ],
  };
}

sub pull_by_node {
  my ($id) = @_;
  return undef unless defined $id && $id =~ /\APR_kwDOfx(\d+)\z/;
  return pull($1);
}

sub resolve_pull {
  my ($arg) = @_;
  if (!defined $arg) {
    my $b = trim(run_git(undef, 'rev-parse', '--abbrev-ref', 'HEAD'));
    for my $n (pull_numbers()) { my $p = pull($n); return $p if $p->{head_ref} eq $b }
    print STDERR "no pull requests found for branch \"$b\"\n";
    return undef;
  }
  $arg =~ s/\A#//;
  $arg = $1 if $arg =~ m{/pull/(\d+)};
  if ($arg =~ /\A\d+\z/) {
    my $p = pull($arg);
    return $p if $p;
    print STDERR "GraphQL: Could not resolve to a PullRequest with the number of $arg. (repository.pullRequest)\n";
    return undef;
  }
  for my $n (pull_numbers()) { my $p = pull($n); return $p if $p->{head_ref} eq $arg }
  print STDERR "no pull requests found for branch \"$arg\"\n";
  return undef;
}

sub resolve_issue {
  my ($arg) = @_;
  $arg //= '';
  $arg =~ s/\A#//;
  $arg = $1 if $arg =~ m{/issues/(\d+)};
  my $i = issue($arg);
  return $i if $i;
  print STDERR "GraphQL: Could not resolve to an issue or pull request with the number of $arg. (repository.issue)\n";
  return undef;
}

# ------------------------------------------------------------------- output

sub out_value {
  my ($v) = @_;
  return 'null' unless defined $v;
  return $v ? 'true' : 'false' if JSON::PP::is_bool($v);
  return $COMPACT->encode($v) if ref $v;
  return $v;
}

sub find_jq {
  for my $d (split /:/, $ENV{PATH} // '') { return "$d/jq" if length $d && -x "$d/jq" }
  return undef;
}

sub emit {
  my ($data, $jq) = @_;
  if (!defined $jq) { print $PRETTY->encode($data); return 0 }
  if (my $bin = find_jq()) {
    my ($fh, $tmp) = tempfile(UNLINK => 1);
    binmode $fh, ':encoding(UTF-8)';
    print $fh $COMPACT->encode($data);
    close $fh;
    open my $out, '-|', $bin, '-r', '-c', $jq, $tmp or return fail('gh (stand-in): cannot run jq');
    binmode $out, ':encoding(UTF-8)';
    local $/;
    my $s = <$out>;
    close $out;
    my $code = $? >> 8;
    print $s if defined $s;
    return $code ? 1 : 0;
  }
  my @vals = eval { jq_eval($jq, $data) };
  if ($@) {
    print STDERR "gh (stand-in): this --jq expression needs jq, which is not installed here; printing the whole document\n";
    print $PRETTY->encode($data);
    return 0;
  }
  print out_value($_), "\n" for @vals;
  return 0;
}

sub json_out {
  my ($obj, $o) = @_;
  my $fields = opt($o, '--json');
  my @avail = sort keys %{ ref $obj eq 'ARRAY' ? ($obj->[0] || {}) : $obj };
  if (!defined $fields || $fields eq '') {
    return fail("Specify one or more comma-separated fields for `--json`:\n" . join('', map { "  $_\n" } @avail));
  }
  my @want = split /,/, $fields;
  my %have = map { $_ => 1 } @avail;
  for my $w (@want) {
    next if $have{$w} || !@avail;
    return fail("Unknown JSON field: \"$w\"\nAvailable fields:\n" . join('', map { "  $_\n" } @avail));
  }
  my $pick = sub { my ($h) = @_; return { map { $_ => $h->{$_} } @want } };
  my $data = ref $obj eq 'ARRAY' ? [ map { $pick->($_) } @$obj ] : $pick->($obj);
  return emit($data, opt($o, '--jq'));
}

# A small part of jq, for a machine without it: paths, pipes, commas, string
# interpolation, object and array construction, //, == and !=, select, map,
# group_by, sort_by, join, length, keys, add and a few more.
sub skip_string {
  my ($s, $i) = @_;
  my $L = length $s;
  $i++;
  while ($i < $L) {
    my $c = substr($s, $i, 1);
    if ($c eq '\\') {
      if (substr($s, $i + 1, 1) eq '(') { $i = skip_group($s, $i + 1); next }
      $i += 2;
      next;
    }
    return $i + 1 if $c eq '"';
    $i++;
  }
  die "unterminated string\n";
}

sub skip_group {
  my ($s, $i) = @_;
  my $L     = length $s;
  my $depth = 0;
  while ($i < $L) {
    my $c = substr($s, $i, 1);
    if ($c eq '"') { $i = skip_string($s, $i); next }
    if ($c =~ /[\(\[\{]/) { $depth++ }
    elsif ($c =~ /[\)\]\}]/) { $depth--; return $i + 1 if $depth == 0 }
    $i++;
  }
  die "unbalanced brackets\n";
}

sub split_top {
  my ($s, $sep) = @_;
  my @parts;
  my ($start, $i, $L) = (0, 0, length $s);
  while ($i < $L) {
    my $c = substr($s, $i, 1);
    if ($c eq '"') { $i = skip_string($s, $i); next }
    if ($c =~ /[\(\[\{]/) { $i = skip_group($s, $i); next }
    if (substr($s, $i, length $sep) eq $sep) {
      push @parts, substr($s, $start, $i - $start);
      $i += length $sep;
      $start = $i;
      next;
    }
    $i++;
  }
  push @parts, substr($s, $start);
  return @parts;
}

sub truthy { my ($v) = @_; return 0 unless defined $v; return 0 if JSON::PP::is_bool($v) && !$v; return 1 }
sub as_array { my ($v) = @_; return ref $v eq 'ARRAY' ? $v : ref $v eq 'HASH' ? [ map { $v->{$_} } sort keys %$v ] : [] }

sub jq_eval {
  my ($expr, $in) = @_;
  my @vals = ($in);
  for my $stage (split_top($expr, '|')) {
    @vals = map { jq_term(trim($stage), $_) } @vals;
  }
  return @vals;
}

sub jq_first { my @v = jq_eval(@_); return $v[0] }

sub whole { my ($t, $from) = @_; return eval { skip_group($t, $from) == length $t } }

sub jq_term {
  my ($t, $v) = @_;
  die "empty expression\n" if $t eq '';
  my @comma = split_top($t, ',');
  return map { jq_eval(trim($_), $v) } @comma if @comma > 1;
  my @alt = split_top($t, '//');
  if (@alt > 1) {
    my @l = grep { truthy($_) } jq_eval(trim($alt[0]), $v);
    return @l ? @l : jq_eval(trim(join('//', @alt[ 1 .. $#alt ])), $v);
  }
  for my $op ('==', '!=') {
    my @cmp = split_top($t, $op);
    next unless @cmp == 2;
    my $eq = $COMPACT->encode(jq_first(trim($cmp[0]), $v)) eq $COMPACT->encode(jq_first(trim($cmp[1]), $v));
    return bool($op eq '==' ? $eq : !$eq);
  }
  return $v if $t eq '.';
  return $t + 0 if $t =~ /\A-?\d+(?:\.\d+)?\z/;
  return undef  if $t eq 'null';
  return $TRUE  if $t eq 'true';
  return $FALSE if $t eq 'false';
  return () if $t eq 'empty';
  return interpolate($t, $v) if substr($t, 0, 1) eq '"' && skip_string($t, 0) == length $t;
  if (substr($t, 0, 1) eq '[' && whole($t, 0)) {
    my $inner = trim(substr($t, 1, -1));
    return [ $inner eq '' ? () : jq_eval($inner, $v) ];
  }
  return build_object(substr($t, 1, -1), $v) if substr($t, 0, 1) eq '{' && whole($t, 0);
  return jq_eval(substr($t, 1, -1), $v) if substr($t, 0, 1) eq '(' && whole($t, 0);
  if ($t =~ /\A([a-z_]+)\(/ && whole($t, length $1)) {
    my ($f, $arg) = ($1, substr($t, length($1) + 1, -1));
    return truthy(jq_first($arg, $v)) ? ($v) : () if $f eq 'select';
    return [ map { jq_eval($arg, $_) } @{ as_array($v) } ] if $f eq 'map';
    if ($f eq 'group_by' || $f eq 'sort_by') {
      my (%g, @keys);
      for my $el (@{ as_array($v) }) {
        my $k = $COMPACT->encode(jq_first($arg, $el));
        push @keys, $k unless exists $g{$k};
        push @{ $g{$k} }, $el;
      }
      my @sorted = sort @keys;
      return $f eq 'group_by' ? [ map { $g{$_} } @sorted ] : [ map { @{ $g{$_} } } @sorted ];
    }
    if ($f eq 'join') {
      my $sep = jq_first($arg, $v);
      return join($sep, map { defined $_ && !ref $_ ? $_ : out_value($_) } @{ as_array($v) });
    }
    if ($f eq 'test') { my $re = jq_first($arg, $v); return bool(defined $v && $v =~ /$re/) }
    if ($f eq 'has') { my $k = jq_first($arg, $v); return bool(ref $v eq 'HASH' && exists $v->{$k}) }
    if ($f eq 'startswith') { my $s = jq_first($arg, $v); return bool(defined $v && index($v, $s) == 0) }
    if ($f eq 'endswith') { my $s = jq_first($arg, $v); return bool(defined $v && substr($v, -length $s) eq $s) }
    if ($f eq 'contains') { my $s = jq_first($arg, $v); return bool(defined $v && !ref $v && index($v, $s) >= 0) }
    if ($f eq 'split') { my $s = jq_first($arg, $v); return [ split /\Q$s\E/, $v // '' ] }
    die "unsupported function $f\n";
  }
  if ($t eq 'length') {
    return scalar(@$v) if ref $v eq 'ARRAY';
    return scalar(keys %$v) if ref $v eq 'HASH';
    return defined $v ? length $v : 0;
  }
  return [ sort keys %$v ] if $t eq 'keys' && ref $v eq 'HASH';
  if ($t eq 'add') {
    my @a = @{ as_array($v) };
    return undef unless @a;
    return [ map { @$_ } @a ] if ref $a[0] eq 'ARRAY';
    return join('', @a) if grep { /\D/ } grep { defined } @a;
    my $s = 0;
    $s += $_ // 0 for @a;
    return $s;
  }
  return bool(!truthy($v)) if $t eq 'not';
  return out_value($v) if $t eq 'tostring';
  return lc($v // '') if $t eq 'ascii_downcase';
  return as_array($v)->[0] if $t eq 'first';
  return as_array($v)->[-1] if $t eq 'last';
  return [ sort { $COMPACT->encode($a) cmp $COMPACT->encode($b) } @{ as_array($v) } ] if $t eq 'sort';
  if ($t eq 'unique') {
    my %seen;
    return [ grep { !$seen{ $COMPACT->encode($_) }++ } sort { $COMPACT->encode($a) cmp $COMPACT->encode($b) } @{ as_array($v) } ];
  }
  return path_eval($t, $v) if substr($t, 0, 1) eq '.';
  die "unsupported: $t\n";
}

sub path_eval {
  my ($t, $v) = @_;
  my @vals = ($v);
  my $i    = 0;
  while ($i < length $t) {
    my $rest = substr($t, $i);
    if ($rest =~ /\A\.([A-Za-z_][A-Za-z0-9_]*)\??/) {
      my $k = $1;
      @vals = map { ref $_ eq 'HASH' ? $_->{$k} : undef } @vals;
      $i += length $&;
      next;
    }
    if ($rest =~ /\A\.?"((?:[^"\\]|\\.)*)"/ || $rest =~ /\A\.?\["((?:[^"\\]|\\.)*)"\]/) {
      my $k = $1;
      @vals = map { ref $_ eq 'HASH' ? $_->{$k} : undef } @vals;
      $i += length $&;
      next;
    }
    if ($rest =~ /\A\.?\[\]\??/) {
      @vals = map { @{ as_array($_) } } @vals;
      $i += length $&;
      next;
    }
    if ($rest =~ /\A\.?\[(-?\d+)\]/) {
      my $n = $1;
      @vals = map { ref $_ eq 'ARRAY' ? $_->[$n] : undef } @vals;
      $i += length $&;
      next;
    }
    if ($rest =~ /\A\.?\[(-?\d*):(-?\d*)\]/) {
      my ($from, $to) = ($1, $2);
      @vals = map {
        my @a = @{ as_array($_) };
        my $f = $from eq '' ? 0 : $from < 0 ? @a + $from : $from;
        my $e = $to eq '' ? scalar(@a) : $to < 0 ? @a + $to : $to;
        $e = @a if $e > @a;
        [ $f < $e ? @a[ $f .. $e - 1 ] : () ]
      } @vals;
      $i += length $&;
      next;
    }
    last if $rest eq '.';
    die "unsupported path $t\n";
  }
  return @vals;
}

sub build_object {
  my ($inner, $v) = @_;
  my %o;
  for my $entry (map { trim($_) } split_top($inner, ',')) {
    next if $entry eq '';
    if ($entry =~ /\A([A-Za-z_]\w*)\z/) { $o{$1} = ref $v eq 'HASH' ? $v->{$1} : undef; next }
    if ($entry =~ /\A"([^"]*)"\z/) { $o{$1} = ref $v eq 'HASH' ? $v->{$1} : undef; next }
    if ($entry =~ /\A([A-Za-z_]\w*|"[^"]*")\s*:\s*(.+)\z/s) {
      (my $k = $1) =~ s/\A"|"\z//g;
      $o{$k} = jq_first($2, $v);
      next;
    }
    die "unsupported object entry $entry\n";
  }
  return \%o;
}

sub interpolate {
  my ($t, $v) = @_;
  my %esc = (n => "\n", t => "\t", r => "\r", '"' => '"', '\\' => '\\', '/' => '/');
  my $out = '';
  my $i   = 1;
  my $L   = length($t) - 1;
  while ($i < $L) {
    my $c = substr($t, $i, 1);
    if ($c eq '\\') {
      my $n = substr($t, $i + 1, 1);
      if ($n eq '(') {
        my $end = skip_group($t, $i + 1);
        my $val = jq_first(substr($t, $i + 2, $end - $i - 3), $v);
        $out .= defined $val && !ref $val ? $val : out_value($val);
        $i = $end;
        next;
      }
      $out .= exists $esc{$n} ? $esc{$n} : $n;
      $i += 2;
      next;
    }
    $out .= $c;
    $i++;
  }
  return $out;
}

# ----------------------------------------------------------------- commands

sub main {
  my @a = @_;
  my (@rest, $repo);
  while (@a) {
    my $x = shift @a;
    if ($x eq '-R' || $x eq '--repo') { $repo = shift @a; next }
    if ($x =~ /\A--repo=(.*)\z/) { $repo = $1; next }
    push @rest, $x;
  }
  if (defined $repo && $repo !~ m{\A(?:https://)?(?:github\.com/)?\Q$REPO\E/?\z}) {
    return fail("GraphQL: Could not resolve to a Repository with the name '$repo'. (repository)");
  }
  my $cmd = shift @rest // '';
  return cmd_pr(@rest)      if $cmd eq 'pr';
  return cmd_issue(@rest)   if $cmd eq 'issue';
  return cmd_api(@rest)     if $cmd eq 'api';
  return cmd_run(@rest)     if $cmd eq 'run';
  return cmd_project(@rest) if $cmd eq 'project';
  return cmd_auth(@rest)    if $cmd eq 'auth';
  return cmd_repo(@rest)    if $cmd eq 'repo';
  if ($cmd eq '--version' || $cmd eq 'version') { print "gh version 2.103.0 (stand-in)\n"; return 0 }
  return no_answer(@_);
}

sub human_pull {
  my ($p, $with_comments) = @_;
  my $state = is_open($p) && $p->{draft} ? 'DRAFT' : gql_state($p);
  my $v     = view_pull($p);
  my $s     = join('',
    "title:\t$p->{title}\n",
    "state:\t$state\n",
    "labels:\t", join(', ', @{ $p->{labels} || [] }), "\n",
    "assignees:\t\n",
    "reviewers:\t\n",
    "projects:\t\n",
    "milestone:\t\n",
    "number:\t$p->{number}\n",
    "url:\t$WEB/pull/$p->{number}\n",
    "additions:\t$v->{additions}\n",
    "deletions:\t$v->{deletions}\n",
    "auto-merge:\t", ($v->{autoMergeRequest} ? 'enabled' : 'disabled'), "\n",
    "--\n",
    $p->{body});
  $s .= "\n" unless $s =~ /\n\z/;
  if ($with_comments) { $s .= "--\n$_->{body}\n" for @{ comments_of($p->{number}) } }
  return $s;
}

sub cmd_pr {
  my $sub = shift // '';
  my %val = map { $_ => 1 } qw(--json --jq --template --body --body-file --title --subject --state --head --base
    --limit --search --label --add-label --remove-label --comment --match-head-commit --author-email --interval
    --author --color --reviewer --add-reviewer --assignee --milestone);
  my %alias_for = (
    view    => { '-q' => '--jq', '-t' => '--template', '-c' => '--comments', '-w' => '--web' },
    checks  => { '-q' => '--jq', '-t' => '--template', '-i' => '--interval', '-w' => '--web' },
    list    => { '-q' => '--jq', '-t' => '--template', '-s' => '--state', '-H' => '--head', '-B' => '--base', '-L' => '--limit', '-S' => '--search', '-l' => '--label', '-A' => '--author', '-d' => '--draft', '-w' => '--web' },
    merge   => { '-b' => '--body', '-F' => '--body-file', '-t' => '--subject', '-s' => '--squash', '-m' => '--merge', '-r' => '--rebase', '-d' => '--delete-branch' },
    comment => { '-b' => '--body', '-F' => '--body-file' },
    edit    => { '-b' => '--body', '-F' => '--body-file', '-t' => '--title', '-B' => '--base' },
    close   => { '-c' => '--comment', '-d' => '--delete-branch' },
    create  => { '-b' => '--body', '-F' => '--body-file', '-t' => '--title', '-B' => '--base', '-H' => '--head', '-d' => '--draft' },
  );
  my ($o, @pos) = getopts(\%val, $alias_for{$sub} || {}, @_);

  if ($sub eq 'view') {
    my $p = resolve_pull($pos[0]) or return 1;
    return json_out(view_pull($p), $o) if exists $o->{'--json'};
    print human_pull($p, $o->{'--comments'});
    return 0;
  }
  if ($sub eq 'checks') {
    my $p      = resolve_pull($pos[0]) or return 1;
    my $checks = checks_for($p);
    return json_out($checks, $o) if exists $o->{'--json'};
    print join("\t", $_->{name}, $_->{bucket}, $_->{bucket} eq 'skipping' ? '0' : '4m12s', $_->{link}, ''), "\n" for @$checks;
    return (grep { $_->{bucket} eq 'fail' } @$checks) ? 1 : (grep { $_->{bucket} eq 'pending' } @$checks) ? 8 : 0;
  }
  if ($sub eq 'list' || $sub eq 'status') {
    my $state = opt($o, '--state') // 'open';
    my @ps    = grep {
      my $p = $_;
      ($state eq 'all'
        || ($state eq 'open'   && is_open($p))
        || ($state eq 'merged' && $p->{merged})
        || ($state eq 'closed' && !is_open($p)))
        && (!defined opt($o, '--head') || $p->{head_ref} eq opt($o, '--head'))
        && (!$o->{'--draft'} || $p->{draft})
    } map { pull($_) } pull_numbers();
    return json_out([ map { view_pull($_) } @ps ], $o) if exists $o->{'--json'};
    print join("\t", $_->{number}, $_->{title}, $_->{head_ref}, (is_open($_) && $_->{draft} ? 'DRAFT' : gql_state($_)), $_->{created_at}), "\n"
      for reverse @ps;
    return 0;
  }
  if ($sub eq 'ready') {
    my $p = resolve_pull($pos[0]) or return 1;
    my $n = $p->{number};
    return fail("X Pull request $REPO#$n is closed. Only draft pull requests can be marked as \"ready for review\"") unless is_open($p);
    if ($o->{'--undo'}) {
      if ($p->{draft}) { print STDERR "! Pull request $REPO#$n is already a draft\n"; return 0 }
      set_pull($n, draft => $TRUE);
      print STDERR "✓ Pull request $REPO#$n is converted to \"draft\"\n";
      return 0;
    }
    if (!$p->{draft}) { print STDERR "! Pull request $REPO#$n is already \"ready for review\"\n"; return 0 }
    set_pull($n, draft => $FALSE);
    print STDERR "✓ Pull request $REPO#$n is marked as \"ready for review\"\n";
    return 0;
  }
  if ($sub eq 'merge') {
    my $p = resolve_pull($pos[0]) or return 1;
    my $n = $p->{number};
    return fail("X Pull request $REPO#$n was already merged") if $p->{merged};
    return fail("X Pull request $REPO#$n is closed") if $p->{closed};
    if ($o->{'--disable-auto'}) {
      set_pull($n, auto_merge => undef);
      print STDERR "✓ Auto-merge disabled for pull request $REPO#$n\n";
      return 0;
    }
    my $method = $o->{'--squash'} ? 'SQUASH' : $o->{'--merge'} ? 'MERGE' : $o->{'--rebase'} ? 'REBASE' : undef;
    return fail('--merge, --rebase, or --squash required when not running interactively') unless $method;
    return fail('GraphQL: Pull Request is still a draft (' . ($o->{'--auto'} ? 'enablePullRequestAutoMerge' : 'mergePullRequest') . ')')
      if $p->{draft};
    set_pull($n, merged => $TRUE, merged_at => $NOW, merge_method => $method, auto_merge => undef);
    print STDERR "✓ Pull request $REPO#$n will be added to the merge queue for main when ready\n";
    return 0;
  }
  if ($sub eq 'comment') {
    my $p    = resolve_pull($pos[0]) or return 1;
    my $body = body_from($o);
    return fail('gh (stand-in): a comment needs --body or --body-file') unless defined $body;
    my $id = add_comment($p->{number}, $body);
    print "$WEB/pull/$p->{number}#issuecomment-$id\n";
    return 0;
  }
  if ($sub eq 'edit') {
    my $p = resolve_pull($pos[0]) or return 1;
    my $n = $p->{number};
    my $body = body_from($o);
    spew("$STATE/pull-$n.body.md", $body) if defined $body;
    set_pull($n, title => opt($o, '--title')) if defined opt($o, '--title');
    if ($o->{'--add-label'} || $o->{'--remove-label'}) {
      my %l = map { $_ => 1 } @{ $p->{labels} || [] };
      $l{$_} = 1 for map { split /,/ } @{ $o->{'--add-label'} || [] };
      delete $l{$_} for map { split /,/ } @{ $o->{'--remove-label'} || [] };
      set_pull($n, labels => [ sort keys %l ]);
    }
    print "$WEB/pull/$n\n";
    return 0;
  }
  if ($sub eq 'close' || $sub eq 'reopen') {
    my $p = resolve_pull($pos[0]) or return 1;
    return fail("X Pull request $REPO#$p->{number} was already merged") if $p->{merged};
    add_comment($p->{number}, opt($o, '--comment')) if defined opt($o, '--comment');
    set_pull($p->{number}, closed => bool($sub eq 'close'), closed_at => ($sub eq 'close' ? $NOW : undef));
    print STDERR ($sub eq 'close' ? '✓ Closed' : '✓ Reopened') . " pull request $REPO#$p->{number} ($p->{title})\n";
    return 0;
  }
  if ($sub eq 'diff') {
    my $p = resolve_pull($pos[0]) or return 1;
    print run_git($ROOT, 'diff', ($o->{'--name-only'} ? '--name-only' : ()), "$p->{base_sha}...$p->{head_sha}");
    return 0;
  }
  if ($sub eq 'create') {
    my $head = opt($o, '--head') // trim(run_git(undef, 'rev-parse', '--abbrev-ref', 'HEAD'));
    for my $n (pull_numbers()) {
      my $p = pull($n);
      return fail("a pull request for branch \"$head\" into branch \"main\" already exists:\n$WEB/pull/$n") if $p->{head_ref} eq $head && is_open($p);
    }
    return no_answer('pr', 'create', @_);
  }
  return no_answer('pr', $sub, @_);
}

sub cmd_issue {
  my $sub = shift // '';
  my %val = map { $_ => 1 } qw(--json --jq --template --body --body-file --title --state --label --limit --search
    --add-label --remove-label --comment --reason --assignee --milestone --type);
  my %alias_for = (
    view    => { '-q' => '--jq', '-t' => '--template', '-c' => '--comments', '-w' => '--web' },
    list    => { '-q' => '--jq', '-t' => '--template', '-s' => '--state', '-l' => '--label', '-L' => '--limit', '-S' => '--search' },
    comment => { '-b' => '--body', '-F' => '--body-file' },
    edit    => { '-b' => '--body', '-F' => '--body-file', '-t' => '--title' },
    close   => { '-c' => '--comment', '-r' => '--reason' },
    create  => { '-b' => '--body', '-F' => '--body-file', '-t' => '--title', '-l' => '--label' },
  );
  my ($o, @pos) = getopts(\%val, $alias_for{$sub} || {}, @_);

  if ($sub eq 'view') {
    my $i = resolve_issue($pos[0]) or return 1;
    return json_out(view_issue($i), $o) if exists $o->{'--json'};
    my $it = item_for_issue($i->{number});
    my $s  = join('',
      "title:\t$i->{title}\n",
      "state:\t", ($i->{state} eq 'closed' ? 'CLOSED' : 'OPEN'), "\n",
      "labels:\t", join(', ', @{ $i->{labels} || [] }), "\n",
      "comments:\t", scalar(@{ comments_of($i->{number}) }), "\n",
      "assignees:\t\n",
      "projects:\t", ($it ? 'OSN Platform (' . item_status($it) . ')' : ''), "\n",
      "milestone:\t\n",
      "number:\t$i->{number}\n",
      "--\n",
      $i->{body});
    $s .= "\n" unless $s =~ /\n\z/;
    if ($o->{'--comments'}) { $s .= "--\n$_->{body}\n" for @{ comments_of($i->{number}) } }
    print $s;
    return 0;
  }
  if ($sub eq 'list') {
    my $state = opt($o, '--state') // 'open';
    my @is    = grep { $state eq 'all' || $_->{state} eq $state } map { issue($_) } issue_numbers();
    if (defined(my $label = opt($o, '--label'))) {
      @is = grep { my $i = $_; grep { $_ eq $label } @{ $i->{labels} || [] } } @is;
    }
    return json_out([ map { view_issue($_) } @is ], $o) if exists $o->{'--json'};
    print join("\t", $_->{number}, uc($_->{state}), $_->{title}, join(', ', @{ $_->{labels} || [] }), $_->{created_at}), "\n" for reverse @is;
    return 0;
  }
  if ($sub eq 'comment') {
    my $i    = resolve_issue($pos[0]) or return 1;
    my $body = body_from($o);
    return fail('gh (stand-in): a comment needs --body or --body-file') unless defined $body;
    my $id = add_comment($i->{number}, $body);
    print "$WEB/issues/$i->{number}#issuecomment-$id\n";
    return 0;
  }
  if ($sub eq 'edit') {
    my $i    = resolve_issue($pos[0]) or return 1;
    my $n    = $i->{number};
    my $body = body_from($o);
    spew("$STATE/issue-$n.body.md", $body) if defined $body;
    set_issue($n, title => opt($o, '--title')) if defined opt($o, '--title');
    if ($o->{'--add-label'} || $o->{'--remove-label'}) {
      my %l = map { $_ => 1 } @{ $i->{labels} || [] };
      $l{$_} = 1 for map { split /,/ } @{ $o->{'--add-label'} || [] };
      delete $l{$_} for map { split /,/ } @{ $o->{'--remove-label'} || [] };
      set_issue($n, labels => [ sort keys %l ]);
    }
    print "$WEB/issues/$n\n";
    return 0;
  }
  if ($sub eq 'close' || $sub eq 'reopen') {
    my $i = resolve_issue($pos[0]) or return 1;
    add_comment($i->{number}, opt($o, '--comment')) if defined opt($o, '--comment');
    set_issue($i->{number}, state => ($sub eq 'close' ? 'closed' : 'open'), state_reason => ($sub eq 'close' ? (opt($o, '--reason') // 'completed') : undef));
    print STDERR ($sub eq 'close' ? '✓ Closed' : '✓ Reopened') . " issue $REPO#$i->{number} ($i->{title})\n";
    return 0;
  }
  return no_answer('issue', $sub, @_);
}

sub field_value {
  my ($raw, $typed) = @_;
  return $raw unless $typed;
  if ($raw =~ /\A@(.+)\z/) { my $s = $1 eq '-' ? do { local $/; decode('UTF-8', <STDIN> // '') } : slurp($1); return $s // '' }
  return $TRUE  if $raw eq 'true';
  return $FALSE if $raw eq 'false';
  return undef  if $raw eq 'null';
  return $raw + 0 if $raw =~ /\A-?\d+\z/;
  return $raw;
}

sub cmd_api {
  my @a = @_;
  my ($method, $jq, $slurp, $input, $endpoint);
  my %params;
  while (@a) {
    my $x = shift @a;
    if ($x eq '-X' || $x eq '--method') { $method = uc(shift @a // ''); next }
    if ($x =~ /\A--method=(.*)\z/) { $method = uc $1; next }
    if ($x eq '-q' || $x eq '--jq') { $jq = shift @a; next }
    if ($x =~ /\A--jq=(.*)\z/s) { $jq = $1; next }
    if ($x eq '-f' || $x eq '--raw-field' || $x eq '-F' || $x eq '--field') {
      my $kv = shift @a // '';
      my ($k, $v) = split /=/, $kv, 2;
      push @{ $params{$k} }, field_value($v // '', $x eq '-F' || $x eq '--field');
      next;
    }
    if ($x eq '-H' || $x eq '--header' || $x eq '-t' || $x eq '--template' || $x eq '--hostname' || $x eq '--cache' || $x eq '-p' || $x eq '--preview') {
      shift @a;
      next;
    }
    if ($x eq '--input') { $input = shift @a; next }
    if ($x eq '--slurp') { $slurp = 1; next }
    next if $x =~ /\A--(?:paginate|include|silent|verbose)\z/ || $x eq '-i';
    $endpoint //= $x;
  }
  return fail('gh (stand-in): api needs an endpoint') unless defined $endpoint;
  if (defined $input) {
    my $d = eval { $COMPACT->decode($input eq '-' ? do { local $/; decode('UTF-8', <STDIN> // '') } : slurp($input) // '') };
    if (ref $d eq 'HASH') { push @{ $params{$_} }, $d->{$_} for keys %$d }
  }
  $method //= %params ? 'POST' : 'GET';
  my $path = $endpoint;
  $path =~ s{\Ahttps://api\.github\.com/}{};
  $path =~ s{\A/}{};
  $path =~ s/\{owner\}/$OWNER/g;
  $path =~ s/\{repo\}/$NAME/g;
  my $query = $path =~ s/\?(.*)\z// ? $1 : '';
  my %q = map { my ($k, $v) = split /=/, $_, 2; ($k => $v // '') } grep { length } split /&/, $query;
  if ($method eq 'GET') { for my $k (keys %params) { $q{$k} = $params{$k}[-1] } }

  my ($status, $data) = api_route($method, $path, \%params, \%q);
  my $errors = ref $data eq 'HASH' && $data->{errors} && $path eq 'graphql' ? $data->{errors} : undef;
  if ($status >= 400 || $errors) {
    if ($errors) {
      print STDERR join("\n", map { "GraphQL: $_->{message}" . ($_->{path} ? ' (' . join('.', @{ $_->{path} }) . ')' : '') } @$errors), "\n";
    }
    else {
      print $PRETTY->encode($data) unless defined $jq;
      print STDERR "gh: $data->{message} (HTTP $status)\n";
    }
    return 1;
  }
  $data = [$data] if $slurp;
  return emit($data, $jq);
}

sub one { my ($p, $k) = @_; return exists $p->{$k} ? $p->{$k}[-1] : undef }

sub not_found { return (404, { message => 'Not Found', documentation_url => 'https://docs.github.com/rest', status => '404' }) }

sub api_route {
  my ($m, $path, $p, $q) = @_;
  return graphql($p) if $path eq 'graphql';
  my $r = qr{repos/\Q$REPO\E};

  if ($path =~ m{\A$r/pulls\z}) {
    if ($m eq 'GET') {
      my $state = $q->{state} // 'open';
      my @ps    = grep { $state eq 'all' || ($state eq 'open' ? is_open($_) : !is_open($_)) } map { pull($_) } pull_numbers();
      if (my $h = $q->{head}) { $h =~ s/\A[^:]+://; @ps = grep { $_->{head_ref} eq $h } @ps }
      return (200, [ map { rest_pull($_) } reverse @ps ]);
    }
    my $head = one($p, 'head') // '';
    $head =~ s/\A[^:]+://;
    for my $n (pull_numbers()) {
      my $x = pull($n);
      return (422, { message => 'Validation Failed', errors => [ { resource => 'PullRequest', code => 'custom', message => "A pull request already exists for $OWNER:$head." } ] })
        if $x->{head_ref} eq $head && is_open($x);
    }
    return (422, { message => 'Validation Failed', errors => [ { message => 'gh (stand-in): this checkout cannot open a new pull request' } ] });
  }
  if (my ($pn) = $path =~ m{\A$r/pulls/(\d+)\z}) {
    my $x = pull($pn) or return not_found();
    if ($m eq 'PATCH' || $m eq 'POST') {
      spew("$STATE/pull-$pn.body.md", one($p, 'body')) if exists $p->{body};
      set_pull($pn, title => one($p, 'title')) if exists $p->{title};
      set_pull($pn, closed => bool(one($p, 'state') eq 'closed'), closed_at => (one($p, 'state') eq 'closed' ? $NOW : undef)) if exists $p->{state};
      $x = pull($pn);
    }
    return (200, rest_pull($x));
  }
  if (my ($pn) = $path =~ m{\A$r/pulls/(\d+)/merge\z}) {
    my $x = pull($pn) or return not_found();
    return (200, { merged => bool($x->{merged}), message => $x->{merged} ? 'Pull Request was merged' : 'Pull Request is not merged' }) if $m eq 'GET';
    return (405, { message => 'Pull Request is still a draft' }) if $x->{draft};
    return (405, { message => 'Pull Request is not mergeable' }) unless is_open($x);
    set_pull($pn, merged => $TRUE, merged_at => $NOW, merge_method => uc(one($p, 'merge_method') // 'MERGE'));
    return (200, { merged => $TRUE, message => 'Pull Request successfully merged', sha => $x->{head_sha} });
  }
  if (my ($pn) = $path =~ m{\A$r/pulls/(\d+)/files\z}) {
    my $x = pull($pn) or return not_found();
    return (200, [ map { +{ filename => $_->{path}, status => 'modified', additions => $_->{additions}, deletions => $_->{deletions} } } @{ diff_files($x) } ]);
  }
  if (my ($pn) = $path =~ m{\A$r/pulls/(\d+)/commits\z}) {
    my $x = pull($pn) or return not_found();
    return (200, [ map { +{ sha => $_->{oid}, commit => { message => $_->{messageHeadline} } } } @{ commits_of($x) } ]);
  }
  if (my ($pn) = $path =~ m{\A$r/pulls/(\d+)/(?:reviews|comments|requested_reviewers)\z}) {
    pull($pn) or return not_found();
    return (200, []);
  }
  if (my ($n) = $path =~ m{\A$r/issues/(\d+)\z}) {
    if (my $x = pull($n)) { return (200, rest_issue_of_pull($x)) }
    my $i = issue($n) or return not_found();
    if ($m eq 'PATCH' || $m eq 'POST') {
      spew("$STATE/issue-$n.body.md", one($p, 'body')) if exists $p->{body};
      set_issue($n, title => one($p, 'title')) if exists $p->{title};
      set_issue($n, state => one($p, 'state'), state_reason => one($p, 'state_reason')) if exists $p->{state};
      set_issue($n, labels => [ map { ref $_ eq 'HASH' ? $_->{name} : $_ } map { ref $_ eq 'ARRAY' ? @$_ : $_ } @{ $p->{'labels[]'} || $p->{labels} } ])
        if exists $p->{'labels[]'} || exists $p->{labels};
      $i = issue($n);
    }
    return (200, rest_issue($i));
  }
  if (my ($n) = $path =~ m{\A$r/issues/(\d+)/comments\z}) {
    pull($n) || issue($n) or return not_found();
    if ($m eq 'POST') {
      my $id = add_comment($n, one($p, 'body') // '');
      return (201, { id => $id, html_url => "$WEB/issues/$n#issuecomment-$id", body => one($p, 'body') });
    }
    return (200, [ map { +{ id => $_->{id}, body => $_->{body}, created_at => $_->{created_at}, html_url => "$WEB/issues/$n#issuecomment-$_->{id}" } } @{ comments_of($n) } ]);
  }
  if (my ($n, $one) = $path =~ m{\A$r/issues/(\d+)/labels(?:/(.+))?\z}) {
    my $i = issue($n) or return not_found();
    my %l = map { $_ => 1 } @{ $i->{labels} || [] };
    if ($m eq 'POST' || $m eq 'PUT') {
      %l = () if $m eq 'PUT';
      $l{$_} = 1 for map { ref $_ eq 'ARRAY' ? @$_ : $_ } @{ $p->{'labels[]'} || $p->{labels} || [] };
      set_issue($n, labels => [ sort keys %l ]);
    }
    elsif ($m eq 'DELETE' && defined $one) {
      (my $name = $one) =~ s/%([0-9A-Fa-f]{2})/chr hex $1/ge;
      delete $l{$name};
      set_issue($n, labels => [ sort keys %l ]);
    }
    return (200, [ map { +{ name => $_ } } sort keys %l ]);
  }
  if (my ($n) = $path =~ m{\A$r/issues/(\d+)/timeline\z}) {
    issue($n) or return not_found();
    my @events;
    for my $pn (pull_numbers()) {
      my $x = pull($pn);
      next unless grep { $_ == $n } @{ $x->{closes} || [] };
      push @events, { event => 'cross-referenced', source => { type => 'issue', issue => rest_issue_of_pull($x) } };
    }
    return (200, \@events);
  }
  if ($path =~ m{\A$r/issues/\d+/parent\z}) { return (404, { message => 'No parent issue found', status => '404' }) }
  if (my ($n) = $path =~ m{\A$r/issues/(\d+)/(?:sub_issues|dependencies/blocked_by|dependencies/blocking|events|reactions)\z}) {
    issue($n) || pull($n) or return not_found();
    return (200, []);
  }
  if ($path =~ m{\A$r/issues\z}) {
    return (200, [ map { rest_issue(issue($_)) } reverse issue_numbers() ]) if $m eq 'GET';
    return (422, { message => 'Validation Failed', errors => [ { message => 'gh (stand-in): this checkout cannot open a new issue' } ] });
  }
  if (my ($sha) = $path =~ m{\A$r/commits/([0-9a-fA-F]{7,40})/check-runs\z}) {
    for my $n (pull_numbers()) {
      my $x = pull($n);
      next unless index($x->{head_sha}, $sha) == 0;
      my $runs = [
        map {
          +{
            name         => $_->{name},
            status       => 'completed',
            conclusion   => lc($_->{state}) eq 'skipped' ? 'skipped' : lc($_->{state}),
            html_url     => $_->{link},
            head_sha     => $x->{head_sha},
            started_at   => $_->{startedAt},
            completed_at => $_->{completedAt},
          }
        } @{ checks_for($x) }
      ];
      return (200, { total_count => scalar(@$runs), check_runs => $runs });
    }
    return (200, { total_count => 0, check_runs => [] });
  }
  if ($path =~ m{\A$r/commits/([0-9a-fA-F]{7,40})/status\z}) { return (200, { state => 'success', statuses => [], total_count => 0 }) }
  if ($path =~ m{\A$r/actions/runs\z}) { return (200, { total_count => scalar(@{ runs() }), workflow_runs => [ map { rest_run($_) } @{ runs() } ] }) }
  if ($path =~ m{\A$r\z}) {
    return (200, { full_name => $REPO, name => $NAME, owner => { login => $OWNER }, private => $FALSE, visibility => 'public', default_branch => 'main', html_url => $WEB });
  }
  if ($path =~ m{\Aorgs/\Q$OWNER\E/projectsV2/1/fields\z}) {
    my $f = board()->{status_field};
    return (200, [ { id => $f->{id}, node_id => $f->{node_id}, name => $f->{name}, data_type => 'single_select', options => [ map { +{ id => $_->{id}, name => { raw => $_->{name}, html => $_->{name} } } } @{ $f->{options} } ] } ]);
  }
  if ($path =~ m{\Aorgs/\Q$OWNER\E/projectsV2/1/items\z}) { return (200, [ map { rest_item($_) } @{ board()->{items} } ]) }
  if (my ($id) = $path =~ m{\Aorgs/\Q$OWNER\E/projectsV2/1/items/(\d+)\z}) {
    my ($it) = grep { $_->{id} == $id } @{ board()->{items} };
    return not_found() unless $it;
    if ($m eq 'PATCH' || $m eq 'POST') {
      my @vals = @{ $p->{'fields[][value]'} || [] };
      if (!@vals && ref one($p, 'fields') eq 'ARRAY') { @vals = map { $_->{value} } @{ one($p, 'fields') } }
      for my $v (@vals) { my $name = option_name($v); set_item_status($id, $name) if defined $name }
    }
    return (200, rest_item($it));
  }
  return (200, { resources => { core => { limit => 5000, remaining => 4990, reset => time + 3600 }, graphql => { limit => 5000, remaining => 4990, reset => time + 3600 } } })
    if $path eq 'rate_limit';
  return not_found();
}

sub graphql {
  my ($p) = @_;
  my $query = one($p, 'query') // '';
  my %vars  = map { $_ => one($p, $_) } grep { $_ ne 'query' } keys %$p;
  my $flat  = $query;
  $flat =~ s/\s+/ /g;
  my $var = sub {
    my ($tok) = @_;
    return $tok unless defined $tok && $tok =~ /\A\$(\w+)\z/;
    return $vars{$1};
  };
  if ($flat =~ /\bmutation\b/) {
    my $id;
    if ($flat =~ /pullRequestId\s*:\s*"([^"]+)"/) { $id = $1 }
    elsif ($flat =~ /pullRequestId\s*:\s*(\$\w+)/) { $id = $var->($1) }
    else { ($id) = grep { defined && /\APR_/ } values %vars }
    for my $mu (qw(markPullRequestReadyForReview convertPullRequestToDraft enablePullRequestAutoMerge disablePullRequestAutoMerge mergePullRequest)) {
      next unless $flat =~ /\b$mu\b/;
      my $x = pull_by_node($id) or return (200, { errors => [ { type => 'NOT_FOUND', message => "Could not resolve to a node with the global id of '" . ($id // '') . "'" } ] });
      my $n = $x->{number};
      if ($mu eq 'markPullRequestReadyForReview') { set_pull($n, draft => $FALSE) }
      elsif ($mu eq 'convertPullRequestToDraft') { set_pull($n, draft => $TRUE) }
      elsif ($mu eq 'disablePullRequestAutoMerge') { set_pull($n, auto_merge => undef) }
      else {
        return (200, { errors => [ { message => "Pull Request is still a draft", path => [$mu] } ] }) if $x->{draft};
        return (200, { errors => [ { message => "Pull Request is not mergeable", path => [$mu] } ] }) unless is_open($x);
        set_pull($n, merged => $TRUE, merged_at => $NOW, merge_method => 'SQUASH');
      }
      return (200, { data => { $mu => { pullRequest => gql_pull(pull($n)) } } });
    }
    if ($flat =~ /\bupdateProjectV2ItemFieldValue\b/) {
      my ($item) = $flat =~ /itemId\s*:\s*"([^"]+)"/;
      my ($opt)  = $flat =~ /singleSelectOptionId\s*:\s*"([^"]+)"/;
      $item //= $vars{itemId};
      $opt  //= $vars{optionId} // $vars{singleSelectOptionId};
      my ($it) = grep { $_->{node_id} eq ($item // '') } @{ board()->{items} };
      set_item_status($it->{id}, option_name($opt)) if $it && defined option_name($opt // '');
      return (200, { data => { updateProjectV2ItemFieldValue => { projectV2Item => { id => $item } } } });
    }
    if ($flat =~ /\baddComment\b/) {
      my ($subject) = $flat =~ /subjectId\s*:\s*"([^"]+)"/;
      $subject //= $vars{subjectId} // '';
      my ($n) = $subject =~ /(\d+)\z/;
      my ($body) = $flat =~ /body\s*:\s*"((?:[^"\\]|\\.)*)"/;
      $body //= $vars{body} // '';
      add_comment($n, $body) if defined $n;
      return (200, { data => { addComment => { commentEdge => { node => { url => defined $n ? "$WEB/issues/$n" : $WEB } } } } });
    }
    return (200, { errors => [ { message => 'gh (stand-in): no saved answer for this mutation' } ] });
  }
  if ($flat =~ /pullRequest\s*\(\s*number\s*:\s*(\$\w+|\d+)/) {
    my $n = $var->($1);
    my $x = pull($n);
    return (200, { data => { repository => { pullRequest => undef } }, errors => [ { type => 'NOT_FOUND', path => [ 'repository', 'pullRequest' ], message => 'Could not resolve to a PullRequest with the number of ' . ($n // '') . '.' } ] })
      unless $x;
    return (200, { data => { repository => { pullRequest => gql_pull($x) } } });
  }
  if ($flat =~ /\bissue\s*\(\s*number\s*:\s*(\$\w+|\d+)/) {
    my $n = $var->($1);
    my $i = issue($n);
    return (200, { data => { repository => { issue => undef } }, errors => [ { type => 'NOT_FOUND', path => [ 'repository', 'issue' ], message => 'Could not resolve to an Issue with the number of ' . ($n // '') . '.' } ] })
      unless $i;
    my $it = item_for_issue($n);
    my $v  = view_issue($i);
    return (200, {
      data => {
        repository => {
          issue => {
            %$v,
            labels       => { nodes => $v->{labels} },
            comments     => { nodes => $v->{comments}, totalCount => scalar(@{ $v->{comments} }) },
            editor       => undef,
            lastEditedAt => undef,
            projectItems => { nodes => $it ? [ { id => $it->{node_id}, fullDatabaseId => "$it->{id}", project => { number => 1, title => 'OSN Platform' } } ] : [] },
          }
        }
      }
    });
  }
  return (200, { data => { rateLimit => { limit => 5000, remaining => 4990, used => 10, resetAt => $NOW } } }) if $flat =~ /\brateLimit\b/;
  return (200, { errors => [ { message => 'gh (stand-in): no saved answer for this query' } ] });
}

sub runs {
  my @r;
  for my $n (pull_numbers()) {
    my $x   = pull($n);
    my $run = 39100000000 + $n * 10;
    push @r, { id => $run + 2, workflow => 'CI', branch => $x->{head_ref}, sha => $x->{head_sha}, event => 'pull_request', title => $x->{title}, at => $x->{checks_started_at} };
    push @r, { id => $run + 1, workflow => 'Changeset Check', branch => $x->{head_ref}, sha => $x->{head_sha}, event => 'pull_request', title => $x->{title}, at => $x->{checks_started_at} };
  }
  return \@r;
}

sub rest_run {
  my ($r) = @_;
  return { id => $r->{id}, name => $r->{workflow}, display_title => $r->{title}, head_branch => $r->{branch}, head_sha => $r->{sha}, event => $r->{event}, status => 'completed', conclusion => 'success', created_at => $r->{at}, html_url => "$WEB/actions/runs/$r->{id}" };
}

sub gh_run {
  my ($r) = @_;
  return { databaseId => $r->{id}, workflowName => $r->{workflow}, displayTitle => $r->{title}, headBranch => $r->{branch}, headSha => $r->{sha}, event => $r->{event}, status => 'completed', conclusion => 'success', createdAt => $r->{at}, url => "$WEB/actions/runs/$r->{id}" };
}

sub cmd_run {
  my $sub = shift // '';
  my %val = map { $_ => 1 } qw(--json --jq --branch --limit --workflow --commit --job --template --status);
  my ($o, @pos) = getopts(\%val, { '-q' => '--jq', '-b' => '--branch', '-L' => '--limit', '-w' => '--workflow', '-c' => '--commit', '-j' => '--job', '-t' => '--template', '-s' => '--status' }, @_);
  my @runs = map { gh_run($_) } @{ runs() };
  if ($sub eq 'list') {
    @runs = grep { $_->{headBranch} eq opt($o, '--branch') } @runs if defined opt($o, '--branch');
    @runs = grep { index($_->{headSha}, opt($o, '--commit')) == 0 } @runs if defined opt($o, '--commit');
    return json_out(\@runs, $o) if exists $o->{'--json'};
    print join("\t", 'completed', 'success', $_->{displayTitle}, $_->{workflowName}, $_->{headBranch}, $_->{event}, $_->{databaseId}, '4m12s', $_->{createdAt}), "\n" for @runs;
    return 0;
  }
  my ($r) = grep { defined $pos[0] && $_->{databaseId} eq $pos[0] } @runs;
  if ($sub eq 'view') {
    return fail("could not find any workflow run with ID " . ($pos[0] // '')) unless $r;
    return json_out($r, $o) if exists $o->{'--json'};
    return 0 if $o->{'--log-failed'};
    print "✓ $r->{headBranch} $r->{workflowName} · $r->{databaseId}\nTriggered via pull_request\n\nJOBS\n✓ every job succeeded\n";
    return 0;
  }
  if ($sub eq 'watch') {
    return fail("could not find any workflow run with ID " . ($pos[0] // '')) unless $r;
    print "Run $r->{workflowName} ($r->{databaseId}) has already completed with 'success'\n";
    return 0;
  }
  return no_answer('run', $sub, @_);
}

sub cmd_project {
  my $sub = shift // '';
  my %val = map { $_ => 1 } qw(--owner --format --jq --limit --id --project-id --field-id --single-select-option-id --text --number --date --iteration-id --template);
  my ($o, @pos) = getopts(\%val, { '-q' => '--jq', '-L' => '--limit' }, @_);
  my $b = board();
  if ($sub eq 'item-list') {
    my @items = map {
      my $i = issue($_->{issue});
      +{ id => $_->{node_id}, title => $i ? $i->{title} : '', status => item_status($_), content => { type => 'Issue', number => $_->{issue} + 0, title => $i ? $i->{title} : '', body => $i ? $i->{body} : '', repository => $REPO, url => "$WEB/issues/$_->{issue}" } }
    } @{ $b->{items} };
    return emit({ items => \@items, totalCount => scalar(@items) }, opt($o, '--jq'));
  }
  if ($sub eq 'field-list') {
    my $f = $b->{status_field};
    return emit({ fields => [ { id => $f->{node_id}, name => $f->{name}, type => 'ProjectV2SingleSelectField', options => [ map { +{ id => $_->{id}, name => $_->{name} } } @{ $f->{options} } ] } ], totalCount => 1 }, opt($o, '--jq'));
  }
  if ($sub eq 'item-edit') {
    my $id = opt($o, '--id') // '';
    my ($it) = grep { $_->{node_id} eq $id || "$_->{id}" eq $id } @{ $b->{items} };
    return fail("gh (stand-in): no project item $id") unless $it;
    my $name = option_name(opt($o, '--single-select-option-id') // '');
    set_item_status($it->{id}, $name) if defined $name;
    return 0;
  }
  if ($sub eq 'view') {
    return emit({ id => 'PVT_kwDOfx1', number => 1, title => 'OSN Platform', url => "https://github.com/orgs/$OWNER/projects/1" }, opt($o, '--jq'));
  }
  return no_answer('project', $sub, @_);
}

sub cmd_auth {
  my $sub = shift // '';
  if ($sub eq 'status') { print "github.com\n  ✓ Logged in to github.com (the stand-in for this checkout)\n"; return 0 }
  if ($sub eq 'token')  { print "gho_standin\n"; return 0 }
  return no_answer('auth', $sub, @_);
}

sub cmd_repo {
  my $sub = shift // '';
  my ($o) = getopts({ '--json' => 1, '--jq' => 1 }, { '-q' => '--jq' }, @_);
  if ($sub eq 'view') {
    my $r = { name => $NAME, nameWithOwner => $REPO, owner => { login => $OWNER }, url => $WEB, isPrivate => $FALSE, visibility => 'PUBLIC', defaultBranchRef => { name => 'main' } };
    return json_out($r, $o) if exists $o->{'--json'};
    print "name:\t$REPO\ndescription:\t\n";
    return 0;
  }
  return no_answer('repo', $sub, @_);
}
PERL
chmod +x .pr/bin/gh

# The run's blackboard, as it stood when both CI waits ended.
cat > ORCHESTRATE.md <<'MD'
# ORCHESTRATE — 2026-10-23

## task 1 — new-enquiry email subject
issue:       englishstreetventures/osn#9101
claimed:     osn#9101 item 271004101
agent:       implementer — a copy change in one email template and its test; rating unconfirmed, chosen from the text
premises:    checked on origin/main @@BASE_SHORT@@
  - the subject is set in shared/email/src/templates/enquiry.ts
    `git grep -n 'New enquiry from' origin/main -- shared/email/src` → @@A_PREMISE@@
worktree:    @@ROOT@@/.worktrees/cire-enquiry-email-subject (made by this run)
branch:      feat/cire-enquiry-email-subject (base origin/main)
pr:          #9102
running:     none — `wait-pr.sh 9102 30` ended: terminal: no check pending — pr 9102: OPEN BLOCKED SUCCESS · checks: pass=8 skipping=1
gates:       check ok · lint ok · test:run ok (@shared/email) · fmt:check ok
findings:    plan 0 · brief 0 · worker 0
next:        Step 5 — retro done (card committed and pushed); act on the CI wait

## task 2 — deploy runbook: when a migration holds the merge
issue:       englishstreetventures/osn#9103
claimed:     osn#9103 item 271004103
agent:       mechanic — one paragraph the issue's Done when states; rating unconfirmed, chosen from the text
premises:    checked on origin/main @@BASE_SHORT@@
  - section 4 of the runbook is its migrations section
    `git show origin/main:wiki/shared/production-deploy.md | grep -n '^## 4\. '` → @@B_PREMISE@@
worktree:    @@ROOT@@/.worktrees/deploy-runbook-merge-hold (made by this run)
branch:      docs/deploy-runbook-merge-hold (base origin/main)
pr:          #9104
running:     none — `wait-pr.sh 9104 30` ended: terminal: no check pending — pr 9104: OPEN CLEAN SUCCESS · checks: pass=8 skipping=1
gates:       check-wikilinks ok · fmt:check ok · changeset-required skip
findings:    plan 0 · brief 0 · worker 0
next:        Step 5 — retro done (card committed and pushed); act on the CI wait
MD
fill ORCHESTRATE.md "ROOT=$ROOT" "BASE_SHORT=$BASE_SHORT" "A_PREMISE=$A_PREMISE" "B_PREMISE=$B_PREMISE"

# The fixture, checked here so a drift fails the setup rather than the score.
# A `!`-negated pipeline never trips `set -e`, so a negative check exits by
# hand.
fail() { echo "setup.sh: $*" >&2; exit 1; }
[ "$(git status --porcelain)" = "?? ORCHESTRATE.md" ] || fail "the main checkout carries more than the blackboard"
[ "$(git diff --name-only main..."$A_BRANCH" -- shared .changeset | sort | tr '\n' ' ')" = ".changeset/enquiry-email-subject.md shared/email/src/templates/enquiry.ts shared/email/tests/enquiry.test.ts " ] ||
  fail "task 1's branch drifted"
[ "$(git diff --name-only main..."$B_BRANCH" -- wiki)" = "wiki/shared/production-deploy.md" ] || fail "task 2's branch drifted"
for d in "$A_DIR" "$B_DIR"; do [ -z "$(git -C "$d" status --porcelain)" ] || fail "$d is not clean"; done
for b in "$A_BRANCH" "$B_BRANCH"; do
  [ "$(git rev-parse "$b")" = "$(git rev-parse "origin/$b")" ] || fail "$b is not pushed"
done
if grep -l "@@[A-Z_]*@@" ORCHESTRATE.md .pr/pulls/*.md >/dev/null; then fail "a placeholder was left unfilled"; fi
GH=.pr/bin/gh
for n in 9102 9104; do
  [ "$("$GH" api "repos/englishstreetventures/osn/pulls/$n" --jq .body)" = "$(cat ".pr/pulls/$n.body.md")" ] ||
    fail "the stand-in does not serve #$n as saved"
done
[ "$("$GH" pr view 9102 --json isDraft,mergeStateStatus --jq '"\(.isDraft) \(.mergeStateStatus)"')" = "true BLOCKED" ] ||
  fail "the stand-in's view of #9102 drifted"
[ "$("$GH" pr view 9104 --json isDraft,mergeStateStatus --jq '"\(.isDraft) \(.mergeStateStatus)"')" = "false CLEAN" ] ||
  fail "the stand-in's view of #9104 drifted"
rm -f GH-CALLS.log
rm -rf .pr/state
mkdir .pr/state
echo "fixture ready"
