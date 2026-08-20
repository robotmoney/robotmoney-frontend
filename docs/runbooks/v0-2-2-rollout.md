# v0.2.2 production rollout

Operator runbook for taking production from **v0.2.1** to **v0.2.2**. Written to
be executed top to bottom at 3am. Every command is copy-pasteable. Destructive
and irreversible steps are marked **DESTRUCTIVE** / **IRREVERSIBLE**.

Companion to [deployment.md](./deployment.md) — that document owns the
credential inventory (§3–§5), the compose topologies, and the handle/id
namespace guard's full behaviour (§2.1). **This runbook does not repeat it; it
cites it.** Where the two disagree, the contradiction is called out inline under
**CONTRADICTS deployment.md**.

> **Filename note.** This file is `v0-2-2-rollout.md`, not `v0.2.2-rollout.md`.
> `scripts/lint-docs.sh:32` enforces `^[a-z0-9]+(-[a-z0-9]+)*\.md$` on every
> `docs/runbooks/*.md`, and a dot in the stem fails that check.

---

## 0.0 Where am I? — run this before reading anything else

```bash
bun run rollout:where            # human-readable
bun run rollout:where -- --json  # same state, for an agent
```

**This document does not record your position. The probe derives it, every
time.** Nothing below is a status field, and you should not add one: §2 already
carries two dead status paragraphs, each of which was true for about a day, and
they are kept there only as a record of what stale looked like. A rollout that
spans sessions, hosts and release candidates cannot be tracked in prose.

What the probe derives, and from what:

| It tells you | Derived from | Never from |
|---|---|---|
| Which host you are on and what it can do | repo-root `.env` (§6.5), `.env.readonly` (§3) | a hostname you typed |
| Which release you are at | `git rev-parse HEAD`, `git tag --points-at HEAD` | a SHA written in this file |
| Which steps are done | one receipt per step, written by that step's own script | a checked box |
| Whether those still **count** | the three axes below | when it feels recent |

### The three axes — why "we cut a new rc" is not "start over"

A completed step stops counting for exactly three reasons, and they are
independent:

1. **Host** — §7–§12 need the writer `DATABASE_URL` that only lives in the
   repo-root `.env` file (§6.5). A box without that file cannot run them at
   all; the probe marks them ⛔ rather than letting you try.
2. **Code** — each step declares the paths it actually executes (`depends-on`
   in its step block). A commit invalidates a step only if it lands on that
   step's own inputs. This is what release-runbooks.md §4.4's *"the twin must
   use the same release candidate that is planned for production"* means in
   practice: a docs-only commit invalidates nothing, a change to `preflight.ts`
   invalidates Gate C **and** Gate B (Gate C runs preflight's checks —
   `restore-check.ts:33`), and a change to `backend/src/**` invalidates the
   boot rehearsal while leaving the gates alone.
3. **Clock** — Gate E goes stale by the minute (§2), the baseline and dump go
   stale as production moves. Expiry is amber, not red: an expired step was
   right when it ran. Code drift is red.

### Receipts

Every scripted step writes one JSON receipt to
`~/rm-backup-v022/receipts/<step>.json` when passed `--emit-receipt`, recording
its exit code, verdict, the SHA and rc tag it ran at, the host, the **database
identity** it actually connected to (§2.0's assertion, captured instead of read
and forgotten), and the SHA-256 of every artifact it produced. Steps a person
performs by hand are attested with
`bun run rollout:where -- --record <step> --note "..."`, and are displayed as
attested — somebody's word, not a program's exit code.

Receipts hold **no secrets**: database identity, never a credential. That is
why they can sit unencrypted beside an encrypted credential dump (§5.2).

**A receipt is evidence, not authority.** The probe re-hashes the artifacts,
re-runs the diff and re-derives the host before it believes one. If a receipt
and the filesystem disagree, the filesystem wins. Delete the receipts directory
and you have lost bookkeeping, not safety — every gate can be re-run, and a
step with no receipt is simply not done.

The step blocks that follow (```` ```yaml step ````) are the machine-readable
half of each section; `backend/scripts/upgrades/0.2.1-to-0.2.2/steps.ts` is
their single source, and `backend/tests/rollout-steps.test.ts` fails if the two
drift apart. Prose is still the authority on *how* and *why* — the blocks only
carry what a program has to know.

---

## 0. Read this first — three facts that change what "upgrade" means here

Each was first verified at `ccf983f` and re-verified on 2026-08-17 against
`origin/releases-0.2.x` (`d852329`) — every file cited below is unchanged
between the two — and each invalidates something an operator would otherwise
assume. Re-check them against the tip you pin in §1 before you rely on them.

1. **`bun smoke` boots a DEMO-shaped stack, not a production one.** It always
   appends `docker-compose.demo.yml` (`scripts/lib/demo-main.ts:284-288`, which
   never consults smoke mode), which sets `RM_ALLOW_INSECURE: "1"`
   (`docker-compose.demo.yml:35`) and pins `SWARM_SCHEDULES_ENABLED: "0"`
   (`:72`). deployment.md §3.3 says this out loud about the pinned-port origin:
   *"a pinned-port origin serves a **demo** stack (`RM_ALLOW_INSECURE=1`,
   explicit demo schedules…), not a production one."* You are running the demo
   composition against production data. Nothing below can change that — it is a
   property of the workflow, not a setting.
2. **Without `--external-pg`, `bun smoke` builds a brand-new empty database
   every single boot and your production data is not touched.** The compose
   project name is `rm_demo_stack_<10 hex>` where the hex is
   `shortHash(crypto.randomUUID())` (`scripts/stack/naming.ts:138`, `:149-151`)
   — **random per boot** outside GitHub Actions. A new project means a new
   `<project>_pgdata` volume. The previous boot's volume is orphaned, not
   deleted. **`--external-pg` is mandatory for this rollout.**
3. **You cannot set `AUTOMATION_TOKEN`, `ADMIN_TOKEN` or
   `SWARM_PUBLIC_BASE_URL` for a `bun smoke` boot.** See §6 — this is the single
   biggest departure from the established plan, and two of the three are code
   defects rather than operator steps.

---

## 1. Release identity

| | |
|---|---|
| Currently in production | tag **`v0.2.1`** = `5970f2d` |
| Target | branch **`releases-0.2.x`** — its tip at the moment you run |
| What you cut and deploy | **`v0.2.2-rc.N`** at that tip (§7.2). **Not `v0.2.2`** |
| `v0.2.2` | cut only after §8's postflight is clean, at the deployed rc's commit (§8, last step) |
| Delta | **resolve it yourself, below.** No count written in this file is authoritative |

**The bare `v0.2.2` tag does not exist while you are executing this runbook, and
cannot.** A version tag records what has been proven in production, so it is cut
after both preflight and postflight, never before —
[`docs/technical/release-runbooks.md` §3](../technical/release-runbooks.md)
("Version tags and release candidates") owns that policy end to end, including
what happens when preflight or postflight fails. Read it once before you start;
this runbook executes it and does not restate it.

Which `N`: `git tag -l 'v0.2.2*'` and `git ls-remote --tags origin | grep v0.2.2`
are both empty (checked 2026-08-17, this worktree and origin), so the next tag is
**`v0.2.2-rc.0`**. Re-run both before you cut — a previous attempt that failed
preflight or postflight will have consumed rc numbers, and yours is the highest
existing `N` plus one.

The target is a **branch, not a pinned SHA**. This section has already gone
stale twice by pinning one (first `main @ ccf983f` / "14 commits", then
`releases-0.2.x @ 7de3871` / "21 commits"), and it will go stale again — the
branch is still receiving commits from `main`. Resolve the tip and the delta
at execution time:

```bash
git fetch --tags origin
git rev-parse origin/releases-0.2.x                  # ← the tip you will tag as v0.2.2-rc.N
git rev-list --count v0.2.1..origin/releases-0.2.x   # ← the delta count
git log --oneline v0.2.1..origin/releases-0.2.x      # ← the delta itself
```

Write down the SHA `git rev-parse` printed and use **that one SHA** for the
whole rollout — every gate below, the `v0.2.2-rc.N` tag you cut in §7.2, the
`git rev-parse HEAD` check on the deployed checkout, and the `v0.2.2` tag you
cut in §8 once postflight is clean must all refer to it. If the branch moves
mid-rollout, you are gating one commit and shipping another. `v0.2.2` landing on
the same commit as the final rc is the expected outcome, not double-tagging to
clean up (release-runbooks.md §3).

### Branching model

Feature PRs are reviewed and merged against `main` — never opened directly
against `releases-0.2.x`. The standing convention
([`docs/technical/release-runbooks.md` §1](../technical/release-runbooks.md))
is that a release branch then carries only what the release needs:
cherry-picks from `main`, plus small nit-fix commits made directly on the
branch during rollout.

**What is actually true for v0.2.2:** `releases-0.2.x` was cut whole from
`main`, not assembled by cherry-pick — at the cut, the release scope *was*
everything on `main`. It is being kept in step with `main` by fast-forward
rather than by selective pick, so it currently carries no commit that is not
also on `main`. That stops being true the moment a fix lands directly on the
branch, so check rather than assume:

```bash
git log --oneline origin/main..origin/releases-0.2.x   # branch-only commits
```

Empty ⇒ the branch is a strict subset of `main`, and there is nothing owed to
`main` (release-runbooks.md §6, backporting). Anything listed is a fix that
exists only here and must be backported — **after `v0.2.2` is tagged, not
before.** This is informational context for §1, not one of §2's go/no-go
gates: an operator or agent running this rollout does not act on it, does not
let it block or delay preflight/cutover/postflight, and does not need to
re-check it mid-rollout. It is a TODO for whoever picks up `main` once this
release line is done.

`release/v0.2.2-rollout` is **retired** and is not this branch. It was the
head branch of PR #618, squash-merged into `main` as `7c6f659` and deleted
from origin on merge; no ref to it survives. If you find it named anywhere —
including in #660's header — the reference is stale, and `releases-0.2.x` is
what it means.

### What is in the delta — snapshot, 2026-08-17

> **Informational, not authoritative.** On 2026-08-17 `releases-0.2.x` was at
> `d852329`, 22 commits ahead of `v0.2.1`, and is expected to be
> fast-forwarded further before the tag is cut. Re-derive with
> `git log --oneline v0.2.1..origin/releases-0.2.x` above before trusting any
> count or assuming a commit below is the tip. The list is here so you can
> recognise *what kind* of release this is; the command tells you what you are
> actually shipping.

```
d852329 docs: document the release branch/runbook/tracking-issue process…      (#666)
7de3871 docs(technical): canonical design for analytics data self-healing…      (#664)
7b92a8c feat(pipeline): self-healing gap detection and backfill for every…      (#615)
b9cd90b fix(pipeline): floor-seed idempotency test times out at the 5s…         (#632)
7b1abbf fix(swarm): every notification email links to the retired…             (#628)
836c0ff docs: Document macro-index discrepancy root cause in v0                 (#620)
03a2b01 feat(analytics): full-universe purge regeneration of the regime…       (#630)
7c6f659 docs(deploy): v0.2.2 rollout runbook, a read-only pre-upgrade gate…    (#618)
ccf983f feat(swarm): derive a member's handle from its name at acceptance…      (#612)
56de8e9 fix(ops): the handle/id namespace re-check runs only on --external-pg…  (#610)
bc9f20f fix(seo): the new domain told every crawler its canonical identity…     (#603)
741f39d fix(contract): AdminMember understates what the admin members route…    (#609)
c754753 fix(seo): three stub routes served the home page's metadata…            (#592)
c29e523 fix(swarm): a renamed member that is later deactivated gets two…        (#605)
3a7163f fix(swarm): the handle-addresses-one-member invariant is application…   (#601)
6c78917 fix(swarm): addMemberAdmin/registerMember probe only the id namespace…  (#600)
8d14c88 fix(swarm): the member profile reads the static archive before the API… (#599)
0d7144e feat(swarm): separate member identity and public handle                 (#594)
fdfd9ee feat: admin auth: passkey integration                                   (#589)
f26dca6 feat: admin auth: password management and recovery                      (#590)
0c43a37 feat: admin auth: frontend claim and login surface                      (#591)
f51a8fe feat: admin auth: segregate automation and strict setup token           (#588)
```

### ⚠ THE VERSION NUMBER UNDERSTATES THIS RELEASE

`v0.2.1 → v0.2.2` reads as a patch. It is not.

- **BREAKING auth change.** Four commits (`f51a8fe`, `0c43a37`, `f26dca6`,
  `fdfd9ee`) replace the admin auth model. Once `admin_credential` holds a
  claimed row, `isPrivileged()` **stops honouring `ADMIN_TOKEN` entirely** —
  `backend/src/api/auth.ts:59-64` returns `false` from inside the claimed
  branch rather than falling through to the token check at `:66` — where
  `v0.2.1` returned the token comparison instead. Claiming the credential is a
  **mandatory human step of this release**, not an optional hardening pass.
  `v0.2.1` has a backend claim route but ships no claim UX — no UI, no
  documented way to call it — so nothing in this deployment's history has
  had a real path to exercise it; the frontend claim surface (`0c43a37`,
  #591) is what this release adds. See §2 for the pre-cutover state and §12
  for the two procedures that carry the claim out.
- **Domain change.** `bc9f20f` (#603) moved the canonical origin to
  `https://robotmoney.network` (`scripts/prerender.ts:5`,
  `frontend/public/assets/js/app/seo.js:16`). **At `ccf983f` the api did not
  follow**: `backend/src/config.ts:438` defaulted to the old
  `https://robotmoney.net`. That gap is now closed: `7b1abbf` (#628, merged
  onto this branch) moved the default to
  `SWARM_PUBLIC_BASE_URL_DEFAULT = "https://robotmoney.network"`
  (`backend/src/config.ts:448`, resolved at `:450-454`). §10.2 previously
  tracked this as known-broken; it is updated below to reflect the fix.
  **Verify empirically before you cut the tag anyway** — do not trust this
  paragraph over the checkout in front of you:
  `git show <tag>:backend/src/config.ts | grep -n 'robotmoney\.net"'` — keep the
  closing quote, or the pattern also matches `robotmoney.network` and always
  hits (the same half-match that once broke `scripts/prerender.ts:25-29`). No
  hit means the fix is present.
- **New identity column with a unique index and two new triggers** on
  `swarm_members` (`0030`, `0031`).

Treat this as a minor release with a manual auth migration attached.

### Policy alignment

The foundational release workflow is defined in
[`docs/technical/release-runbooks.md` §4](../technical/release-runbooks.md)
(gates §§4.1–4.9). The table below maps each policy gate to the section of
this runbook that executes it.

| Policy gate | What it requires | Runbook section |
|---|---|---|
| **§4.1** Pre-cutover backup | Encrypted dump + globals dump, verified restore | §5.1–§5.3 |
| **§4.2** Schema-migration preflight | All migrations idempotent and reversible | §4 (preflight) |
| **§4.3** Digital-twin rehearsal | Full runbook against restored twin; any failure blocks | §5.5 |
| **§4.4** Stage rehearsal report | Written report with acceptance criteria; gate before §7 | §5.6 |
| **§4.5** Go/no-go sign-off | Operator sign-off after stage rehearsal report passes | §2 |
| **§4.6** Cutover execution | Versioned RC tag, then migrate + boot | §7 |
| **§4.7** Postflight verification | All §8 checks + §8.1 acceptance criteria pass | §8 |
| **§4.8** Postflight failure → rollback | Default: restore pre-upgrade dump; override requires sign-off | §9 |
| **§4.9** Production rollout report | Filed before closing the tracking issue | §13 |

---

## 2. Go/no-go gates

```yaml step
id:          P1.phases-closed
phase:       P1 authorize
section:     §2
host-role:   any
actor:       agent
ttl:         24h
verify:      gh issue view 660 --json body -q .body   # then: where.ts --record P1.phases-closed
```

> ⛔ **RUN THIS ENTIRE RUNBOOK FROM THE DEDICATED STAGING HOST, NOT THE
> PRODUCTION API HOST.** §3, §4, and §5 — provisioning, live preflight, the
> backup, `restore-check.ts`, and especially `stage-rehearsal.ts` (a real
> Docker image build plus a full app boot) — are real compute and disk load.
> Running any of it on the box serving live production traffic is resource
> contention and blast-radius risk on a machine that cannot afford either.
> There is a separate staging host on the same private network as the read
> replica (§3) for exactly this — clone/pull the release branch there and run
> every command below from it. This was learned the hard way, 2026-08-17: an
> earlier session ran `stage-rehearsal.ts` directly on the production API
> host before this rule existed.
>
> ⛔ **PRECONDITION — do not enter these gates until every Phase for this
> release is closed.** Preflight (this section and §4's pre-flight script)
> may only *begin* once every Phase/feature issue linked from the release
> tracking issue **#660** is closed — i.e. #660's `## Phases` tasklist shows
> all boxes checked. #660 is the source of truth: before running any gate
> below, check it (`gh issue view 660 --json body -q .body`, or the rendered
> checklist on GitHub) and confirm every linked Phase issue's state is
> `CLOSED`. If any linked Phase is still open, preflight has not started and
> must not be started or suggested — stop here and go finish the Phase(s)
> instead.
>
> **As of 2026-08-17, this precondition IS satisfied.** #660 linked four
> Phase issues — #647, #652, #653, #654. #647 and #653 were descoped to
> v0.3.0 in the 2026-08-16 replan (out of this release's blocking scope); the
> remaining two, #652 and #654, are both confirmed `CLOSED` (verified live via
> the GitHub issue pages, not from a cached note — re-verify #660 yourself
> before trusting this line, since it decays the same way the note it
> replaces did). Preflight is authorized to begin. The paragraph below is kept
> for the record of what NOT satisfied looked like:
>
> **As of 2026-08-16, this precondition was NOT satisfied.** #660 links four
> Phase issues — #647, #652, #653, #654 — and per `gh issue view <N> --json
> state -q .state`, **all four are still `OPEN`**. Preflight for v0.2.2 is
> therefore **not yet authorized to begin**; #647, #652, #653, and #654 are
> the concrete blockers. Re-check #660 before proceeding past this point.

Four gates. **They are printed in execution order, and that order is not the
alphabet** — the letters are stable names the rest of this document cites,
nothing more. Each gate needs the section before it to have run.

**Production is checked LAST, not first.** Every preflight-shaped check runs
twice: once against a locally restored copy of the backup (§5.3, before any
live database — including the replica — is ever touched), and only once that
is clean does the SAME check run again against the live read replica (§4).
Nothing here ever runs preflight against the primary; the primary is not
even reachable from `.env.readonly` under this runbook's process (§3).

| Order | Gate | Cannot be answered until | Where the answer comes from |
|---|---|---|---|
| 1 | **Gate C** — backup taken, restored, and clean against the dump | §5.1/§5.2 (dump) and §5.3 (restore + dump-based preflight) | `restore-check.ts` exit code |
| 2 | **Gate B** — pre-flight verdict against the LIVE replica | Gate C clean, then §3 (the replica's read-only role) and §4 | `backend/scripts/upgrades/0.2.1-to-0.2.2/preflight.ts` exit code, run against the replica |
| 3 | **Gate D** — the `rm_worker` role exists | §4's live run | the pre-flight's `rm-worker-role` check |
| 4 | **Gate E** — no long-running transactions | §4's live run | the pre-flight's `blocking-xacts` check |

There is no admin-lockout gate here. An earlier revision of this runbook
carried one ("Gate A"), framed as a go/no-go decision with a destructive
pre-cutover remedy. That was fiction: `v0.2.1` (what production runs going
into this upgrade) has no claim UX, so `admin_credential` cannot be anything
but unclaimed pre-cutover — there is no decision to gate on, only a sanity
check that it is what it has to be. See the note after §2.0 and §12 for what
replaces it.

### 2.0 Establish `DATABASE_URL` before any `psql` in this document

⚠ **`DATABASE_URL` is not in your shell, and nothing in this workflow puts it
there.** `--external-pg` reads it out of the repo-root `.env` **file** —
`loadEnvFile()` is `readFileSync` (`scripts/lib/demo-external-pg.ts:163-165`),
called at `:294`, and the value is taken at `:303` — and `process.env` is never
consulted (§6.5).

So every `psql "$DATABASE_URL"` in this document — the admin-credential check
below, §5.4, §8 and §11 — expands to `psql ""` unless you load it yourself.
**`psql ""` is not an error.** libpq falls back to its own defaults (`PGHOST`
or the local socket, `PGUSER`, database named after the user), so on any host
that happens to run a local postgres it connects **successfully, to the wrong
database**. The admin-credential check then reports "unclaimed" about a
database that is not production, and every §8 check grades the wrong server.

Load it once, then **prove** what you loaded:

```bash
cd <checkout>
export DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)"
[ -n "$DATABASE_URL" ] || { echo "no DATABASE_URL in $PWD/.env — see §6.5"; exit 1; }

# Identity assertion. Run it, read it, do not skip it.
psql "$DATABASE_URL" -Atc \
  "SELECT current_database(), current_user, inet_server_addr(), inet_server_port();"
```

`cut -d= -f2-` keeps `=` characters inside the password. If your `.env` quotes
the value, strip the quotes — a literal `"` inside the URI breaks it.

The result must name the managed cluster from §3: database `defaultdb`, port
**25060**. A `127.0.0.1`/`::1` address, or port `5432`, is a local postgres — and
so is an **empty** address field, which is what `inet_server_addr()` returns over
a Unix socket, the single most likely wrong answer here. Any of those and **every
gate below is void**. `DATABASE_URL` does not survive into a new
terminal — re-export and re-assert in each one, including the shells you use
for §8 and §11.

### Gate B — pre-flight verdict against the live replica (order 2)

Run §3, then §4 — only after Gate C is green. **`VERDICT: BLOCKED` is a
no-go.** Warnings are a go with your eyes open. This is the same set of
checks Gate C already ran against the restored dump; running them again here
is what catches drift between when the dump was taken and right now, and it
is the only time any of this runs against a live database.

### Gate D — the `rm_worker` role exists (order 3)

```sql
SELECT rolname FROM pg_roles WHERE rolname = 'rm_worker';
```

Zero rows is a **no-go until repaired**. `0029_admin_passkey.sql:26-28` is three
unconditional `REVOKE ALL ON … FROM rm_worker` statements with no existence
guard, and `REVOKE` against a missing role raises `42704`. Because
`backend/src/db/migrate.ts:50-53` wraps each file in one transaction, that aborts
migration `0029_admin_passkey.sql` and the boot fails. Repair:

```sql
CREATE ROLE rm_worker LOGIN;
-- then re-apply 0016's grants verbatim (backend/migrations/0016_worker_role.sql:25-42)
GRANT USAGE ON SCHEMA public TO rm_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rm_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rm_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rm_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO rm_worker;
REVOKE INSERT, UPDATE, DELETE ON raw_indicator_history, regime_snapshots, research_signals FROM rm_worker;
```

These are **writes**: run them as `doadmin`, not as `rm_readonly` — this is a
change on the primary, since roles are cluster-wide and there is only one
`rm_worker` regardless of which node you query it from ([[no-agent-writes-to-primary-db]]
applies: run this yourself, do not ask an agent to). Then re-run §4 so Gate B
is green against the repaired cluster.

### Gate E — no long-running transactions (order 4)

Covered by the pre-flight's `blocking-xacts` check (§4). A transaction older than
60s queues in front of `0030`'s `ACCESS EXCLUSIVE` lock, and every reader
arriving after that queues behind **both**. This one goes stale: re-run §4's
pre-flight immediately before §7.3, not only at the top of the window. It is
only meaningful against the live replica — the dump-based run in §5.3
trivially passes it (a freshly restored local container has no concurrent
connections), which is correct, just uninformative there.

### Gate C — backup taken, restored, and clean against the dump (order 1, run FIRST)

Run §5. §5.1/§5.2 take and encrypt the dump; §5.3 (`restore-check.ts`)
restores it into a throwaway **local** Postgres container and then runs this
release's full preflight checks against that restored copy — the same checks
Gate B runs later, just against the dump instead of the replica, and before
any live database is touched at all. **A dump you have not restored is not a
backup**, and now neither is one you have not run preflight against. No-go
until `restore-check.ts` exits `0`.

### Admin credential — confirm unclaimed before cutover (not a gate)

An earlier revision of this runbook carried a "Gate A" here: a go/no-go
decision with a three-way branch and a destructive pre-cutover remedy for a
possible admin lockout. That was fiction. `v0.2.1` — what production runs
going into this upgrade — has a backend claim route but ships no claim UX, so
nothing in this deployment's history has had a way to reach it
(`git grep admin_credential v0.2.1 -- backend/src` finds the route at
`backend/src/api/routes/admin.ts:192`, but no frontend anywhere calls it).
Going into this upgrade `admin_credential` can only be unclaimed. There is no
decision to make here, only a sanity check on which database you are pointed
at:

```sql
SELECT count(*) AS rows FROM admin_credential;
```

Expect `0`. `admin_credential` **does** exist at `v0.2.1`:
`0028_admin_credential.sql` is not in this delta (§1). So `42P01: relation
"admin_credential" does not exist` here does **not** mean unclaimed — it means
you are pointed at the wrong database. Go back to §2.0. If this returns
nonzero, stop and investigate before proceeding — that is not a state this
deployment's history can produce through its normal flow, and this runbook
does not carry a remedy for it. This is not the expected path.

⚠ **Do not name `recovery_hash` in this query.** That column does not exist on
the database you are about to query: `0029_admin_auth_recovery.sql:4` adds it,
and that migration is **pending** — it applies during this upgrade (§7.4).
Against production at `v0.2.1` a query naming it fails with `42703: column
"recovery_hash" does not exist`. An earlier revision of this runbook printed
such a query *and* offered a table row that invited you to read the resulting
error as the "unclaimed" case, so the failure mode was to record **GO** when
the truth was **STOP**.

Claiming the credential is a **mandatory post-cutover step**, not a
pre-cutover one: **§12.1**, executed at §8 verification 10. Until it runs,
the one-time claim is open to whoever reaches the admin surface first.

---

## 3. Provision the read-only role — on the primary, used only via the replica

The pre-flight and the dump must both run as a role that **cannot write**.
Production has a dedicated **read-only replica node** (a separate DO Managed
Postgres resource, its own hostname, streaming from the primary) — that
replica, not the primary, is what `.env.readonly` points at and what every
`rm_readonly` connection in this runbook actually uses.

> 🔴 **`.env.readonly` must never name the primary's host.** This is enforced
> by policy, not by a technical block: Postgres roles are cluster-wide catalog
> objects, replicated from the primary to the replica byte-for-byte — there is
> only ONE `rm_readonly`, and it is created via the primary (below) because
> that is the only place `CREATE ROLE` can run at all (the replica is
> structurally read-only, at the WAL-replay level, for every write INCLUDING
> `CREATE ROLE` — this holds even for `doadmin`, which is not a true
> superuser on DO's replica either way). The same credentials therefore *would*
> still authenticate against the primary if you pointed them there. Nothing
> stops that technically; the process stops it by never doing it. Always take
> the replica's hostname from DO's dashboard/API for the read-only node
> specifically, and confirm the `target:` line `backend/scripts/upgrades/0.2.1-to-0.2.2/preflight.ts`
> prints (§4) names the replica before trusting anything downstream of it.

Provisioning is still a **write**, so it still runs as `doadmin` against the
primary, once ([[no-agent-writes-to-primary-db]] applies — this is an
operator action, not something to hand an agent execute-and-forget):

> 🔴 **Restrict the password's alphabet to `[A-Za-z0-9._~-]`** for the manual
> `psql` spot-check below and for §5's dump commands, both of which build or
> pass a connection string by hand. `@ : / ? # [ ] %` and space are reserved
> delimiters there, not password characters — a `@` truncates the userinfo and
> libpq reports a host that does not exist; a `%` starts a percent-escape and
> either mangles the password silently or errors; `#` and `?` silently
> truncate the rest of the URI. **§4 is the one exception**: the pre-flight
> script takes this password from a discrete `password=` key in
> `.env.readonly`, not a pasted URI, and URI-escapes it itself
> (`encodeURIComponent`) before building the connection string — so the
> restriction does not apply there. Take the length from a longer password,
> not from a wider alphabet, since you need one alphabet that works
> everywhere this password is used:
>
> ```bash
> LC_ALL=C tr -dc 'A-Za-z0-9._~-' </dev/urandom | head -c 40; echo
> ```

```sql
CREATE ROLE rm_readonly LOGIN PASSWORD '<generate a strong one>';

GRANT CONNECT ON DATABASE defaultdb TO rm_readonly;
GRANT USAGE ON SCHEMA public TO rm_readonly;

-- Belt: make every transaction on this role read-only at the server.
ALTER ROLE rm_readonly SET default_transaction_read_only = on;
```

> 🔴 **`GRANT pg_read_all_data TO rm_readonly;` does NOT work here — verified
> 2026-08-17.** That is the textbook PG14+ recipe (see the box below for why
> it would be preferable), but `doadmin` on DO Managed Postgres is not a true
> superuser and does not hold `ADMIN OPTION` on the predefined
> `pg_read_all_data` role, so granting it fails: `42501: permission denied to
> grant role "pg_read_all_data" — Only roles with the ADMIN option on role
> "pg_read_all_data" may grant this role.` Use the explicit-grant fallback
> instead, immediately after the block above:
>
> ```sql
> GRANT SELECT ON ALL TABLES IN SCHEMA public TO rm_readonly;
> GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rm_readonly;
> ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO rm_readonly;
> ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO rm_readonly;
> ```

> **Why `pg_read_all_data` would be preferable, if `doadmin` could grant it,
> and never `GRANT SELECT ON ALL TABLES IN SCHEMA public` alone.** `ON ALL
> TABLES` is a **one-shot expansion**: Postgres resolves it to the tables that
> exist at that instant and writes individual grants. Every table a future
> migration creates is invisible to that role — and it fails **silently**,
> because `pg_dump` simply omits what it cannot read. You get a dump that
> restores cleanly and is missing tables. `pg_read_all_data` is a role
> membership evaluated at query time, so it covers tables that do not exist
> yet; the `ALTER DEFAULT PRIVILEGES` pair above is the next-best substitute —
> it covers tables *this role's future self* would have created, which is not
> the same guarantee, but is the closest `doadmin` can actually grant. Re-run
> the grant block above after any migration that a normal role (not
> `doadmin`) creates new tables under, to be safe.

Verify the role is genuinely read-only before trusting it — against the
**replica's** hostname:

```bash
psql "postgres://rm_readonly:<pw>@<replica-host>:25060/defaultdb?sslmode=require" \
  -c "SHOW transaction_read_only;" \
  -c "SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = current_user;"
```

Expect `on`, then five `f`. Anything else and §4 will refuse to run anyway.
`transaction_read_only = on` here is doubly guaranteed on the replica — the
role's own `ALTER ROLE ... SET default_transaction_read_only = on` above, AND
the replica's structural inability to accept writes regardless of role. Belt
and suspenders: keep the role-level setting anyway, since §4's checks (and
this same role) may in principle be pointed at a non-replica target by
mistake, and the role-level belt is what catches that.

> **Port 25060, never 25061.** `25060` is DigitalOcean's direct session port.
> `25061` is PgBouncer in **transaction** pooling mode, which does not hold a
> session across statements — that breaks `pg_dump`'s repeatable-read snapshot
> and can produce a torn dump. Use `25060` for everything in §3, §4 and §5,
> on whichever node (primary for provisioning, replica for everything else).
>
> **CONTRADICTS deployment.md §4.3**, which says *"For the HA cluster, prefer the
> **connection-pool** URI (PgBouncer) if enabled. Migrations (D9) run with this
> credential."* For the application's own `DATABASE_URL` that preference is out
> of scope here — but do **not** follow it for the pre-flight or the dump.

---

## 4. Pre-flight against the live replica: `backend/scripts/upgrades/0.2.1-to-0.2.2/preflight.ts`

```yaml step
id:          P4.preflight-live
phase:       P4 live preflight
section:     §4
gate:        B
host-role:   stage
actor:       agent
expect-in-recovery: true
ttl:         4h
requires:
  - P3.gate-c
depends-on:
  - backend/scripts/upgrades/0.2.1-to-0.2.2/preflight.ts
  - backend/scripts/upgrades/0.2.1-to-0.2.2/steps.ts
  - backend/scripts/lib/preflight-utils.ts
  - backend/scripts/lib/checks.ts
  - backend/migrations/**
verify:      bun scripts/upgrades/0.2.1-to-0.2.2/preflight.ts --emit-receipt
```

⛔ **Do not run this section until Gate C (§5.3) is green.** This is the SAME
script `restore-check.ts` already ran against the restored dump — running it
again here, against the live replica, is what catches drift since the dump
was taken. It is the only step in this runbook that queries a live database
before cutover.

A read-only dry run against the **live read-only replica**, executed by
`rm_readonly`, before you pull anything. It refuses to run on a session it
cannot prove is read-only, and every query in it is a `SELECT` — doubly so
here, since the replica itself cannot accept a write regardless of role (§3).

### Run it

The script reads its connection details from **`.env.readonly`** at the repo
root — a file separate from `.env`, holding the `rm_readonly` role's
credentials as discrete keys, never a pasted URI. Create it once (see
`.env.readonly.example`):

```bash
cd <checkout>
cat > .env.readonly <<'EOF'
host=<host>
port=25060
username=rm_readonly
password=<pw>
database=defaultdb
EOF
chmod 600 .env.readonly     # it is a credential store
```

Then, from `backend/`:

```bash
cd backend
bun install                      # the script imports `postgres` from backend/package.json
bun scripts/upgrades/0.2.1-to-0.2.2/preflight.ts
```

The path resolves off `preflight.ts`'s own file location, not off your
current directory, so it finds `.env.readonly` whether you run the script
from `backend/` or from the repo root. The release-neutral mechanics
(env loading, connect, gate, verdict) live in
`backend/scripts/lib/preflight-utils.ts`; `preflight.ts` only adds the checks
specific to this release's migrations (`0029`-`0031`). A future release gets
its own `backend/scripts/upgrades/<from>-to-<to>/` directory rather than an
edit to this one, so what a past release's preflight actually checked stays
reconstructable from git history.

**Run it from a checkout at the release tip you pinned in §1** — the SHA
`git rev-parse origin/releases-0.2.x` printed, which is the commit you will tag
as `v0.2.2-rc.N` (§7.2). Verify before you run: `git rev-parse HEAD` in that checkout must
print it. The script compares
`backend/migrations/` on disk against `schema_migrations` in the database; run
from the wrong tag and the pending list is wrong.

`.env.readonly` is a deliberately separate file from `.env`. The script reads
`DATABASE_URL` for exactly one purpose — the equality guard at
`backend/scripts/lib/preflight-utils.ts:281`, `if (process.env.DATABASE_URL &&
process.env.DATABASE_URL === url)` → exit `2`, where `url` is what it just
assembled from `.env.readonly`. It reads `DATABASE_URL` nowhere else, opens no
pool on it, and never falls back to it (`:266-279` exits `2` when
`.env.readonly` is missing or missing required keys). What it does **not** do
is import anything from `src/` — that is the point of the file's standalone
shape (`preflight-utils.ts:9-26`).

> **The guard is live or dead depending on where you stand.** It only fires when
> `DATABASE_URL` is in the process environment. Two things put it there:
> §2.0's `export`, and **`bun` auto-loading `.env` from the cwd** — so running
> the script from the repo root rather than from `backend/` makes the guard
> active off the repo-root `.env` alone. That is the state you want: it is a
> real safety check. If it exits `2` with *"resolves to the same URL as
> DATABASE_URL"*, `.env.readonly` names the application's writer role — fix
> it, do not unset `DATABASE_URL` to silence it.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | `SAFE TO UPGRADE` (possibly with warnings — read them) |
| `1` | `BLOCKED` — at least one FAIL, or the session is not provably read-only |
| `2` | Could not run (`.env.readonly` missing/incomplete, cannot connect, a check threw) |

### Reading the output

Three gate checks run first and abort everything on failure:
`session-read-only`, `role-privileges`, `role-write-grants`. If you are running
as `doadmin` before `rm_readonly` exists, `PREFLIGHT_ALLOW_PRIVILEGED=1`
downgrades the last two to warnings — **do not make that the normal path.**

| Check | `FAIL` means | Do this |
|---|---|---|
| `session-read-only` | The connection can write. Nothing else was queried. | Use port `25060` and the `rm_readonly` URL. Never `PREFLIGHT_ALLOW_PRIVILEGED` for this one — it does not downgrade it. |
| `role-privileges` / `role-write-grants` | The role is a superuser, or holds write grants / table ownership. | Provision §3's role and re-run. |
| `server-version` | Server is < PG 11, where `0030`'s `ADD COLUMN` rewrites the table under `ACCESS EXCLUSIVE`. | Upgrade the cluster. (A **WARN** here just means "outside {17, 18}". Since issue #691 the backend suite and the restore twin both run **18**, production's major — pinned once in `backend/scripts/lib/postgres-image.ts`. 17 stays warning-free only because the demo / single-box stack still runs it.) |
| `extensions` | `pgcrypto` absent; `0001_backends.sql:4` needs `gen_random_uuid()`. | `CREATE EXTENSION IF NOT EXISTS pgcrypto;` as `doadmin`. |
| `schema-migrations` | Either no `schema_migrations` at all (wrong database), or **orphans**: files recorded in the database that are absent from `backend/migrations/`. | Orphans mean the **database is ahead of the checkout** — you are on the wrong tag. Stop and check out the §1 release tip. |
| `rm-worker-role` | `rm_worker` missing and `0029_admin_passkey.sql` pending. | Gate D above. |
| `handle-namespace` | One member's `handle` is another member's `id`. | Run **one printed statement per line, all of them**. Each moves the **HOLDER** — the member named *first* on the line. Updating the shadowed member reports `UPDATE 1` and fixes nothing (`backend/src/db/handle-namespace.ts:113-123`). A mutual collision prints two lines and needs two updates. |
| `blocking-xacts` | A transaction older than 60s is open. | `SELECT pg_terminate_backend(<pid>);` and re-run. Stop the worker first. |
| `admin-credential` | `recovery_hash` already exists but `0029_admin_auth_recovery.sql` is not recorded — its bare `ADD COLUMN` (no `IF NOT EXISTS`, `0029_admin_auth_recovery.sql:4`) will raise `42701`. | `INSERT INTO schema_migrations (name) VALUES ('0029_admin_auth_recovery.sql');` |

Warnings worth stopping to read even though they exit `0`:

- `admin-credential` **WARN** with `no_recovery > 0` — expected pre-cutover:
  `admin_credential` can only be unclaimed going in (§2). The pre-flight only
  warns here, it never blocks. Note this is the one safe way to ask about
  `recovery_hash` before the upgrade: the script checks
  `information_schema.columns` first and switches query shape on the answer
  (`backend/scripts/upgrades/0.2.1-to-0.2.2/preflight.ts:279-300`), so it never raises `42703`.
  Your own pre-cutover query (§2) must not name the column at all.
- `handle-shape` — member ids that are not valid handles. `0030` backfills
  `handle = id` with no `CHECK`, so those handles can never be saved again
  through the admin surface (validated against `MEMBER_HANDLE_RE`,
  `backend/src/api/validation.ts:446`, 80-char bound at `:482`). Fix after
  cutover, per §8.
- `swarm-members-size` — above 50 000 rows, `0030` is a stall, not a blip.
- `wedged-schedules` **WARN** — one or more enabled `job_schedules` rows have
  `next_run_at` more than 1 hour in the past, indicating a schedule that has
  not fired when expected. This does not block the upgrade, but an already-
  wedged schedule will not self-heal from deployment alone. Note whether any
  rows are flagged here; re-check in §8.2 after cutover. A schedule that
  fires normally during §8.2 can be marked resolved.

### On the reconciliation

The script was authored at `bc9f20f`. Its inlined namespace relation
(`backend/scripts/upgrades/0.2.1-to-0.2.2/preflight.ts:70-71`) is byte-identical to
`HANDLE_NAMESPACE_CONFLICT_RELATION` (`backend/src/db/handle-namespace.ts:63`),
and both agree with `0031`'s DO block
(`0031_swarm_member_handle_namespace.sql:91-92`, where the same relation is
wrapped across two lines).

**Verified today, guarded by nothing — re-grep before each use.** The script
keeps a **copy, not an import**, on purpose, and its own comment says so
(`preflight.ts:60-64`): importing the canonical module would drag in
`src/config.ts`'s module-load `required("DATABASE_URL")` and the shared pool,
destroying the standalone/zero-write-risk property this file exists for. The
executed parity test that does exist
(`backend/tests/handle-namespace-predicate-parity.test.ts`) parses `0031`'s DO
block and compares it to the exported constant — it **never reads**
**`preflight.ts`**. So the migration/runtime pair is guarded and the
pre-flight's copy is not: nothing in CI fails if it drifts.

```bash
# The two TypeScript copies must print the identical string.
grep -n 'FROM swarm_members a JOIN swarm_members b' \
  backend/src/db/handle-namespace.ts backend/scripts/upgrades/0.2.1-to-0.2.2/preflight.ts
# expect handle-namespace.ts:63 and preflight.ts:71, same predicate:
#   FROM swarm_members a JOIN swarm_members b ON b.id = a.handle AND b.id <> a.id
```

If those two ever disagree, §4's `handle-namespace` check is no longer telling
you what §7.5's refusal will decide, and a green pre-flight means nothing.

---

## 5. Backup

Production is DigitalOcean Managed Postgres, which has PITR. **PITR is not
sufficient here** — it recovers the cluster, not a file you can inspect, diff, or
restore into a scratch database to prove the release is reversible. Take a local
dump as well.

### 5.0 Record pre-upgrade baseline

```yaml step
id:          P3.baseline
phase:       P3 backup
section:     §5.0
host-role:   stage
actor:       agent
ttl:         48h
artifacts:
  - pre-upgrade-baseline-*.txt
verify:      §5.0's psql block, then: where.ts --record P3.baseline
```

Before taking the dump, capture a lightweight read-only baseline from the
replica (§3). This baseline is your reference for postflight comparison (§8)
and rollback verification (§9).

```bash
# Load read-only replica credentials from §3's .env.readonly
rokey() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" <checkout>/.env.readonly | head -1; }

export PGHOST="$(rokey host)"       PGPORT="$(rokey port)"
export PGUSER="$(rokey username)"   PGPASSWORD="$(rokey password)"
export PGDATABASE="$(rokey database)" PGSSLMODE=require

# Prove you are on the replica and the read-only role before capturing output.
psql -X -Atc "SELECT current_user, inet_server_addr(), current_database();"

BASELINE_FILE="pre-upgrade-baseline-$(date +%Y%m%dT%H%M%S).txt"
{
  echo "=== baseline captured at $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  echo ""
  echo "--- schema_migrations ---"
  psql -X -c "SELECT name, applied_at FROM schema_migrations ORDER BY name;"
  echo ""
  echo "--- member count ---"
  psql -X -Atc "SELECT count(*) AS member_count FROM swarm_members;"
  echo ""
  echo "--- member identity (AC1/AC2/AC3 reference) ---"
  psql -X -c "SELECT id, name FROM swarm_members ORDER BY name;"
  echo ""
  echo "--- swarm_recommendations count (§8 check 8 reference) ---"
  psql -X -Atc "SELECT count(*) AS swarm_recommendations FROM swarm_recommendations;"
} | tee "$BASELINE_FILE"
echo "baseline saved → $BASELINE_FILE"
```

This baseline is your reference for postflight comparison (§8) and rollback
verification (§9).

> **Corrected 2026-08-20 — the first revision of this section could not run.**
> As landed in #707 it selected `schema_migrations.id`,
> `swarm_members.handle_type` and `swarm_members.vault_address`. None of those
> columns exist: `schema_migrations` is `(name text PRIMARY KEY, applied_at)`
> (`backend/src/db/migrate.ts:33-36`), and `swarm_members` has neither
> `handle_type` nor `vault_address` at `v0.2.1` or after this release's
> migrations — `0030` adds `handle`, and `vault_address` lives on
> `agent_vaults`/`vault_share_price_history`. Three of the four queries raised
> `42703` against the replica, so the "baseline" file was three errors and a
> member count. That matters more than a typo would: §8 and §9 both treat this
> file as the reference for postflight comparison and rollback verification, and
> an empty baseline silently verifies nothing. The queries above are the
> corrected set, run against the replica on 2026-08-20.

### 5.1 The dump

```yaml step
id:          P3.backup
phase:       P3 backup
section:     §5.1
host-role:   stage
actor:       agent
ttl:         48h
artifacts:
  - rm-preupgrade-<STAMP>.dump.gpg
  - rm-globals-<STAMP>.sql.gpg
verify:      §5.1's pg_dump/pg_dumpall + §5.2's gpg, then: where.ts --record P3.backup
```

> 🔴 **`cd` out of the checkout first.** §4 left you in `<checkout>/backend`, and
> these commands write to the **current directory**. Writing a plaintext
> credential dump (§5.2) inside the git checkout puts it where §5.2 forbids: in
> the tree, and inside `./_static` / repo-root reach of a compose bind mount.
> Pick a directory outside the repo on a filesystem you control.

> **One role, one password, one host.** Both commands below run as
> `rm_readonly` against the replica (the globals dump too — see the ✅ box
> after them). An earlier revision needed `doadmin` against the primary for
> the second command and warned at length that `PGPASSWORD` does not follow
> `--username`; that hazard is gone with the second credential. Still scope
> the variable to each command (a per-command assignment, never `export`) or
> use `~/.pgpass`, so the password does not leak into unrelated child
> processes.

```bash
mkdir -p ~/rm-backup-v022 && cd ~/rm-backup-v022   # OUTSIDE the checkout (§5.2)
set -o pipefail                          # MANDATORY — see the box below
umask 077                                # the file is a credential store

STAMP="$(TZ=UTC date +%Y%m%dT%H%M%SZ)"
echo "$STAMP" > .last-stamp              # restore-check.ts (§5.3) reads this

# rm_readonly's password, scoped to THIS command only.
# <replica-host>: the read-only replica from §3, NEVER the primary — the dump
# is a read, and the replica is where every read in this runbook happens.
PGPASSWORD='<rm_readonly password>' pg_dump \
  --host=<replica-host> --port=25060 --username=rm_readonly --dbname=defaultdb \
  --format=custom --compress=9 --no-owner --no-privileges \
  --file="rm-preupgrade-${STAMP}.dump"
echo "pg_dump exit=$?"

# Roles are NOT in the dump above. This is a separate, required artifact.
# SAME role, SAME replica, SAME password as the pg_dump above — no doadmin,
# no primary. VERIFIED 2026-08-17 (see the box below): rm_readonly against
# the replica produces a complete globals dump, because --globals-only with
# --no-role-passwords is a pure catalog READ of pg_roles (NOT pg_authid,
# which is what would need superuser).
PGPASSWORD='<rm_readonly password>' pg_dumpall \
  --host=<replica-host> --port=25060 --username=rm_readonly --database=defaultdb \
  --globals-only --no-role-passwords \
  --file="rm-globals-${STAMP}.sql"
echo "pg_dumpall exit=$?"
```

> **`--database=defaultdb`, not the default `template1`.** DO Managed
> Postgres's `pg_hba.conf` rejects connections to `template1` from outside
> its own network path — verified 2026-08-17: omitting this flag fails with
> `FATAL: pg_hba.conf rejects connection for host ..., user "doadmin",
> database "template1"`. `pg_dumpall`'s `-l`/`--database` flag picks the
> database it connects through to enumerate globals; it does not change what
> gets dumped (globals are cluster-wide either way).
>
> ✅ **`rm_readonly` against the replica is enough for the globals dump —
> verified 2026-08-17, resolving what an earlier revision left open.** The
> run exited `0` and produced all 11 cluster roles, including the two
> anything downstream actually needs (`rm_readonly` and `rm_worker`, with
> their `ALTER ROLE` attribute lines), terminated by `PostgreSQL database
> cluster dump complete`. `restore-check.ts` then consumed it and reached
> `PASS rm-worker-role` off exactly this file. **So this runbook's entire
> backup path — data and roles — runs as one non-superuser role against the
> replica, and `doadmin` and the primary are not touched at all.**
>
> Why it works, so you can predict when it would stop: `--no-role-passwords`
> makes `pg_dumpall` read **`pg_roles`** (a world-readable catalog view)
> instead of **`pg_authid`** (superuser-only, because it holds the password
> hashes). Drop `--no-role-passwords` and it reverts to `pg_authid` and
> fails for a non-superuser — which is fine, because you do not want a
> plaintext-equivalent role-password dump in this artifact anyway (§5.2).
> **Verify the output rather than trusting the exit code**, since a role you
> cannot read is omitted silently, exactly as §3's box warns for tables:
>
> ```bash
> grep -cE '^CREATE ROLE' "rm-globals-${STAMP}.sql"          # expect the cluster's role count
> grep -E '^(CREATE|ALTER) ROLE (rm_readonly|rm_worker)\b' "rm-globals-${STAMP}.sql"
> tail -3 "rm-globals-${STAMP}.sql" | grep -c 'dump complete'  # must be 1 (PG 18 appends a trailing blank line)
> ```

The `~/.pgpass` alternative, if you prefer no secrets on the command line —
`chmod 600` it or libpq ignores the file silently:

```
<replica-host>:25060:defaultdb:rm_readonly:<rm_readonly password>
```

> **`--file=`, not `>`, and `set -o pipefail`.** `pg_dump … | gzip > out.gz`
> reports the exit status of `gzip`, not of `pg_dump`, so a dump that failed
> halfway produces a valid-looking compressed file and a `0` exit. `--file=`
> removes the pipe entirely; `set -o pipefail` covers any pipe you add anyway.
> Check the printed exit codes — both must be `0`.

> **`pg_dumpall --globals-only` is not optional.** `pg_dump` does **not** dump
> roles. A cluster rebuilt from the `.dump` alone has `schema_migrations`
> claiming `0016_worker_role.sql` is applied while `rm_worker` does not exist —
> and then `0029_admin_passkey.sql:26-28`'s unguarded `REVOKE`s abort migration
> `0029` with `42704` on the very first boot. This is exactly the trap Gate D
> checks for, arriving via your own restore.

> **Match the client major version to the server.** `pg_dump` refuses a server
> newer than itself. The pre-flight's `server-version` check prints the server
> version; use a `pg_dump` of at least that major.
>
> **Concretely: production is PostgreSQL 18 (18.6, confirmed by Gate B on
> 2026-08-17), and no current distro ships an 18 client by default** —
> Ubuntu 24.04's `postgresql-client` is 16, which fails here with
> `server version mismatch`. Installing the distro package and discovering
> that at 3am is a bad trade for two minutes now, so check first and add
> PGDG if needed:
>
> ```bash
> pg_dump --version        # must be >= the server major (18)
>
> # If it is older, add the PostgreSQL APT repo (Debian/Ubuntu):
> sudo install -d /usr/share/postgresql-common/pgdg
> sudo curl -sSf -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
>   https://www.postgresql.org/media/keys/ACCC4CF8.asc
> . /etc/os-release && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
>   https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
>   | sudo tee /etc/apt/sources.list.d/pgdg.list
> sudo apt-get update && sudo apt-get install -y postgresql-client-18
> pg_dump --version        # re-check: PGDG's postinst repoints /usr/bin
> ```
>
> `restore-check.ts` restores into `postgres:18` (`restore-container.ts`'s
> `IMAGE`) precisely so the restore target matches production's major — a
> client older than 18 cannot produce a dump that container will accept
> either, so this is one requirement, not two.

### 5.2 🔴 The dump is a credential store — encrypt it at rest

**IRREVERSIBLE if leaked.** The dump contains, in plaintext or trivially
reversible form:

- `admin_credential.pass_hash` and `recovery_hash` — **unsalted, single-round
  SHA-256 hex** (`backend/src/lib/keys.ts:5-7`), with a 12-character minimum
  password (`backend/src/api/routes/admin.ts:190`). That is offline-crackable
  with commodity hardware.
- `admin_session` tokens and `admin_passkey` credentials.
- `admin_webauthn_challenge` — live claim challenges.
- Swarm member access keys, and every stored email address.

**Use a passphrase FILE, not gpg's interactive prompt.** `restore-check.ts`
and `stage-rehearsal.ts` decrypt non-interactively with
`gpg --batch --passphrase-file <backupDir>/.backup-passphrase`
(`backend/scripts/lib/restore-container.ts`), and `resolveBackupFiles()`
refuses to start without that exact file. An earlier revision of this
section showed a bare `gpg --symmetric`, which prompts and writes no such
file — follow that literally and §5.3 exits `2` before it restores anything,
so **Gate C could not pass as written.** Generate the passphrase first and
hand it to both `gpg` calls:

```bash
umask 077
# The passphrase itself. Same alphabet rule as §3 — this one is also typed
# by hand during a recovery, so keep it shell-safe.
LC_ALL=C tr -dc 'A-Za-z0-9._~-' </dev/urandom | head -c 48 > .backup-passphrase
echo >> .backup-passphrase

gpg --batch --yes --passphrase-file .backup-passphrase \
    --symmetric --cipher-algo AES256 "rm-preupgrade-${STAMP}.dump"
shred -u "rm-preupgrade-${STAMP}.dump"       # or: rm -P on macOS
gpg --batch --yes --passphrase-file .backup-passphrase \
    --symmetric --cipher-algo AES256 "rm-globals-${STAMP}.sql"
shred -u "rm-globals-${STAMP}.sql"
```

> 🔴 **The passphrase file must not stay next to the dumps at rest.** The
> tooling requires it *inside* `backupDir` while it runs, which means that
> for the duration of §5.3/§5.3b the key and the ciphertext sit in one
> directory — copy that directory anywhere and the encryption has bought you
> nothing. That co-location is an execution-time requirement, not a storage
> layout. **When the Gate C run is done, move `.backup-passphrase` somewhere
> the dumps are not** (a password manager, a separate host), and restore it
> to `backupDir` only for the minutes a later run needs it. Verify what you
> are about to archive:
>
> ```bash
> ls -a ~/rm-backup-v022     # .backup-passphrase must NOT travel with the .gpg files
> ```

Do not put either file in the checkout, in `.agents/`, or anywhere a compose
bind mount can reach.

### 5.3 The verification that PROVES it restores — and that it is safe to upgrade

```yaml step
id:          P3.gate-c
phase:       P3 backup
section:     §5.3
gate:        C
host-role:   stage
actor:       agent
requires:
  - P3.backup
depends-on:
  - backend/scripts/upgrades/0.2.1-to-0.2.2/preflight.ts
  - backend/scripts/upgrades/0.2.1-to-0.2.2/steps.ts
  - backend/scripts/lib/preflight-utils.ts
  - backend/scripts/lib/checks.ts
  - backend/migrations/**
  - backend/scripts/lib/restore-container.ts
  - backend/scripts/lib/postgres-image.ts
  - backend/scripts/upgrades/0.2.1-to-0.2.2/restore-check.ts
verify:      bun scripts/upgrades/0.2.1-to-0.2.2/restore-check.ts ~/rm-backup-v022 --emit-receipt
```

A dump you have not restored is a hypothesis. And a dump that restores but
was never checked against this release's migrations is only half proven.

```bash
cd <checkout>/backend
bun scripts/upgrades/0.2.1-to-0.2.2/restore-check.ts ~/rm-backup-v022
```

This is `restore-check.ts` (docs above it in the file explain the full
mechanism). What it does, entirely with Docker and your own encrypted files —
**no `doadmin`, no primary, no production connection of any kind**:

1. Starts a throwaway local `postgres:18` container (matching production's
   major version) with its own freshly generated, local-only superuser —
   nothing borrowed from `.env`/`.env.readonly`, and no production credential
   anywhere in the path (§5.3b.2 T1, T4).
2. Decrypts and loads just the `rm_readonly`/`rm_worker` role definitions out
   of `rm-globals-<STAMP>.sql.gpg` (the rest of a real globals dump is DO
   Managed Postgres's own internal cluster role graph — `_doadmin_*`,
   `_dodb*`, `avn_*` GUCs — which a vanilla container can't replicate and
   which nothing here needs).
3. Decrypts and `pg_restore`s `rm-preupgrade-<STAMP>.dump.gpg`.
4. Prints row counts for the tables that matter (`swarm_recommendations` is
   the SIGNED take table — payload `jsonb NOT NULL`, signature `text NOT
   NULL`, `0004_committee.sql:38-40`, renamed `0025:70`) and the
   handle/id-namespace invariant, column-existence-checked first — a
   pre-cutover backup correctly reports `swarm_members.handle absent`
   (migration `0030` has not applied to this data yet) rather than throwing.
5. **Then runs this release's full preflight checks** (the same
   `runChecks` §4 runs, imported directly) **against the restored copy** —
   this is what makes Gate C a real preflight pass, not just a structural
   restore check.
6. Tears the container down (`docker rm -f`), win or lose.

Exit `0` means both the restore and the dump-based preflight are clean —
**only then is Gate C green**, and only then does §4 run against the live
replica. Exit `1` means a verification query or a preflight check found a
real problem; exit `2` means it could not run at all (missing files, Docker
failure). Nothing here is destructive and nothing needs manual cleanup — the
throwaway container is gone whether the run succeeds or fails.

### 5.3b The stage rehearsal — mandatory, not optional

```yaml step
id:          P5.rehearsal-boot
phase:       P5 twin rehearsal
section:     §5.3b
host-role:   stage
actor:       agent
requires:
  - P3.gate-c
depends-on:
  - backend/src/**
  - backend/migrations/**
  - backend/Dockerfile
  - frontend/**
  - scripts/**
  - docker-compose.yml
  - docker-compose.demo.yml
  - package.json
  - bun.lock
  - backend/scripts/lib/restore-container.ts
  - backend/scripts/lib/postgres-image.ts
  - backend/scripts/upgrades/0.2.1-to-0.2.2/stage-rehearsal.ts
verify:      bun scripts/upgrades/0.2.1-to-0.2.2/stage-rehearsal.ts ~/rm-backup-v022 --emit-receipt
```

> **Corrected 2026-08-20 — this section used to be headed "Optional but
> recommended".** It is not optional and never was: §5.5 opens *"⛔ This is a
> blocking gate. Do not proceed to §7 until the twin run exits 0"*, and
> release-runbooks.md §4.4 makes the digital-twin rehearsal part of the
> foundational workflow with *"any failure, warning, or unexpected state change
> discovered on the twin is a blocking issue."* Two places said required, one
> said optional, and the optional one was the heading an operator reads first.

`restore-check.ts` proves the dump restores and that static SQL checks pass
against it. It does **not** prove this release's actual migration code path
runs cleanly, or that the app boots and serves pages against production-shaped
data — a migration can pass every static check above and still fail for
reasons only a real run surfaces (lock timing under a live boot, a seed()
interaction, a route that 500s against real data shapes). `stage-rehearsal.ts`
closes that gap:

```bash
cd <checkout>/backend
bun scripts/upgrades/0.2.1-to-0.2.2/stage-rehearsal.ts ~/rm-backup-v022
```

⛔ **Staging host only (§2) — this does a real Docker image build.** Expect
several minutes: image build/pull, the real `migrate.ts` run against the
restored data, `seed()`, and a full health-wait.

> 💳 **This runs the production model on a funded key, and that is the
> point.** `OPENCODE_API_KEY` must be set — in your shell, or in the
> checkout's `.env` or `.env.readonly`, which the script checks in that
> order. It **refuses to start** without one rather than quietly downgrading.
>
> An earlier version pinned `AGENT_MODEL=free` to avoid the spend. That made
> the rehearsal cheaper and less meaningful: `scripts/lib/swarm/inference.ts`
> documents that **model choice is not neutral** for swarm authorship — some
> Zen families refuse the persona task outright or break format, so a green
> `free` run does not predict a production boot. A rehearsal that does not
> use production's model is not rehearsing production.
>
> If you genuinely want the cheap structural check instead, that is §5.3's
> `restore-check.ts`, which needs no inference at all. Do not reach for
> `AGENT_MODEL=free` here to make this step cheaper — it converts a
> production rehearsal into a different test while still reporting exit `0`.

What it does:

1. Restores the backup into a throwaway local Postgres (same mechanism as
   §5.3), bound to the Docker bridge gateway rather than `127.0.0.1` — the
   app containers it boots next need to reach it from inside their own
   network namespace, and the gateway address is reachable from sibling
   containers without being internet-routable the way `0.0.0.0` would be
   (Docker's own iptables rules can expose a `0.0.0.0` bind past a firewall
   that looks like it blocks the port — verified 2026-08-17, this is not
   hypothetical).
2. Checks out an **isolated `git worktree`** (detached `HEAD`) rather than
   using the checkout you are sitting in — `--external-pg` reads
   `DATABASE_URL` from repo-root `.env`, and overwriting the real `.env`,
   even temporarily, risks corrupting it or leaking the throwaway DB into a
   later boot run by hand. `node_modules` is symlinked in from the main
   checkout (same lockfile, same commit) instead of a slow reinstall.
3. Writes the worktree's own `.env`: `DATABASE_URL` pointing at the restored
   container, plus the funded **`OPENCODE_API_KEY`**. It deliberately sets
   **no `AGENT_MODEL`**, so the model resolves to `DEFAULT_AGENT_MODEL`
   (`opencode/deepseek-v4-flash`) — the one production runs. See the box
   below: this rehearsal spends real credit, on purpose.
4. Boots with the **exact command §7.3 runs for real cutover**:
   `bun scripts/demo.ts --smoke --external-pg --no-tui`, `CI` unset, a
   scoped `DEMO_PROJECT` (lowercased — Compose project names reject the
   uppercase `T`/`Z` in the backup's own timestamp).
5. **Supervises** that boot rather than waiting for it to exit (G2 — it never
   would), polling the worktree's `.agents/demo-state.json` for the api's
   published port and `GET /health` on it until both answer, against G3's
   deadline. A boot that exits at all fails the run immediately, since a
   healthy `CI`-unset boot runs forever.
6. Once ready, runs `scripts/demo-frontend-check.ts` against that port — the
   same route/content checks CI runs on every boot, not a bespoke probe.
7. Tears down on **every** exit path (G6): stops the supervised boot first,
   then `demo-down.ts` with an explicit `DEMO_PROJECT`, the `member_home_*`
   volumes `demo-down` deliberately keeps, `git worktree remove --force`, and
   the throwaway Postgres container.

Exit `0` means the migration ran for real, the stack came up healthy, and the
frontend checks passed against production-shaped data.

#### 5.3b.0 ⛔ The rehearsal runs preflight AND POSTFLIGHT against the twin

**A rehearsal that only proves the stack boots has not rehearsed the
release.** Run **both** halves against the digital twin, in the same order
production will see them, before production is touched at all:

1. **Preflight** — §5.3's `restore-check.ts` (Gate C), then §4's checks.
2. **Cutover** — §5.3b's boot, which applies this release's migrations to the
   restored production rows for real.
3. **Postflight** — **every §8 check, and every §8.1 acceptance criterion**,
   against the migrated twin.

Step 3 is the one that was missing, and its absence is exactly how a real
defect reached rc.5 while every script reported success: the boot exited `0`,
the frontend checks passed, and **two members still ended up with the wrong
public handle** (`robot-money` instead of `robotmoney`, `woon-2` instead of
`woon`) — §8.1. A green mechanism is not a met objective, and only §8.1
distinguishes them.

The twin is the right place for this and the only place it is free: it holds
real production rows, so the ACs are evaluated against the data that will
actually be migrated, and a failure costs a rerun rather than a rollback.
**Treat an AC failure on the twin exactly as an AC failure in production** —
patch, cut the next rc, rehearse again. Do not carry a known-failing AC into
a cutover on the theory that production will behave differently; it is the
same data.

#### 5.3b.1 Contract — what a correct rehearsal run does

This is the **specification**, written so the tool can be judged against it.
It is normative: where `stage-rehearsal.ts` and this section disagree, this
section states the intent and the script is what gets fixed.

| # | Guarantee | Why it is load-bearing |
|---|---|---|
| **G1** | **It terminates on its own, always.** A run reaches one of the exit codes below without an operator interrupting it. "Still going" after the deadline is a **failure**, not patience. | This is the last gate before a production cutover, often at 3am. A step that can hang indefinitely cannot be sequenced, cannot be timed, and silently converts "rehearsal passed" into "nobody waited long enough to find out." |
| **G2** | **It boots exactly what §7.3 boots** — `bun scripts/demo.ts --smoke --external-pg --no-tui`, `CI` unset — and **supervises** that boot rather than waiting for it to finish. | With `CI` unset the boot **never self-terminates by design**: it falls past demo-main's CI-gated exits (`scripts/lib/demo-main.ts:1175`, `:1212`) into the LIVE steady-state loop and cycles sessions forever. That is correct for §7.3, where the stack must stay up serving production. A rehearsal that `await`s that process therefore waits forever — the two requirements are only compatible if the rehearsal supervises. Setting `CI` to escape this is **not** an acceptable fix: a truthy `CI` tears the stack down regardless of exit code (§7.3), so the frontend checks would have nothing left to hit, and the boot would no longer be the one §7.3 runs. |
| **G3** | **Readiness is polled, with a deadline.** Ready ⇔ the worktree's `.agents/demo-state.json` exists **and** `/health` on its `apiPort` answers `200`. Not reached within the deadline ⇒ exit `1`. | Readiness is the only honest signal that migration + seed + serve all succeeded, and a deadline is what turns G1 from an intention into a property. Allow generously for a cold image build (a first build pulls base images and compiles); this is minutes, not seconds. |
| **G4** | **Verification runs against the booted stack**: `scripts/demo-frontend-check.ts` on the published port — the same route/content checks CI runs, never a bespoke probe. | A stack that boots but serves the home-page shell for every route is a failed cutover that `/health` alone reports as green (§8 check 11). |
| **G5** | **Spend is bounded.** The boot runs production's model on a **funded** key, and the steady-state loop authors real swarm takes on a timer. The rehearsal must stop the stack **as soon as G4 finishes** — pass or fail — and must not let the loop keep cycling. | Cost here is unbounded and grows with wall-clock, so a hang is not merely slow, it is expensive. Verified 2026-08-17: a hung run reached 5 analytics cycles and 3 live swarm sessions before it was killed by hand. |
| **G6** | **Cleanup is unconditional.** The compose stack, the git worktree, and the throwaway Postgres container are all removed on **every** exit path — success, assertion failure, readiness timeout, and an unhandled throw. | Leftovers from this script are not inert: a surviving container holds a full copy of production data (§5.3b.2), and a surviving stack keeps spending under G5. |
| **G7** | **Isolation is absolute.** Never the real repo-root `.env`; never a production connection; the twin's port bound to a non-routable address. | The rehearsal's whole claim is that it cannot touch production. See §5.3b.2. |

**Exit codes.**

| Code | Meaning |
|---|---|
| `0` | Migrations applied for real, the stack came up healthy, and the frontend checks passed against production-shaped data. |
| `1` | The rehearsal ran and the release failed it: the boot died, readiness was not reached within the deadline (G3), or a frontend check failed. |
| `2` | Could not run at all — missing/undecryptable backup files, no `OPENCODE_API_KEY` (§5.3b's box), Docker/git failure. Says nothing about the release. |

✅ **Conformant as of 2026-08-17, and executed end to end for the first
time.** The contract above was written against a script that could not
satisfy it: `stage-rehearsal.ts` `await`ed the boot instead of supervising it
(G2), so against a `CI`-unset boot it **hung forever** — never reaching its
`/health` check, its frontend checks, or its teardown, while the stack kept
cycling sessions on a funded key. Observed directly: 7+ minutes with no
progress past `booting:`, 5 analytics cycles, 3 live swarm sessions, killed
and torn down by hand. That is why §5.3b's own text used to say the rehearsal
had never completed — it could not have.

The script now supervises the boot and polls `demo-state.json` + `/health`
against G3's deadline, fails fast if the boot exits at all (with `CI` unset a
healthy boot never does), and tears down the stack, the leftover volumes,
the worktree and the container on every exit path. First clean run:

```
ready after 10s: project=… api=http://127.0.0.1:32771 (/health OK)
VERDICT: migrated and booted clean, frontend checks pass
EXIT=0
```

with zero containers, volumes, worktrees or processes surviving. All four
migrations applied to production-shaped data, and §8's checks 2/4/5/6/7/8 pass
against the resulting database (trigger `tgenabled = A`, zero null handles,
zero namespace violations, `swarm_recommendations` above its pre-upgrade
baseline).

> ⛔ **A clean `EXIT=0` here does NOT mean the release passed.** This contract
> is about the rehearsal *mechanism* — G1–G7 describe a run that terminates,
> verifies and cleans up. It says nothing about whether the release achieved
> its objective. On 2026-08-17 this script exited `0` with every check above
> green while **two members ended up with the wrong public handle** — the
> defect §8.1 exists to catch. Always follow a green run with §5.3b.0 step 3:
> §8's checks *and* §8.1's acceptance criteria, against the same twin.

> **Reading a run.** "Still running" is only ever legitimate *before*
> readiness, and only up to G3's deadline — a cold first build genuinely
> takes minutes. After `ready after …s` the remaining steps are fast. A run
> that prints nothing past `booting:` for longer than a cold build should
> take is hung, not working; that is now a bug to report, not a state to
> wait out.

#### 5.3b.2 Contract — the digital twin is production data, and must be treated that way

Both §5.3 and §5.3b restore the dump into a throwaway local Postgres. Nothing
about "throwaway" makes its **contents** low-value: the twin holds a complete
copy of production, including `admin_credential` hashes, `admin_session`
tokens, member access keys and every stored email address — the same inventory
§5.2 encrypts the dump for. The container is disposable; the data in it is not.

| # | Guarantee | Why |
|---|---|---|
| **T1** | **No production credential is used or needed.** The twin's superuser is created by the container from `POSTGRES_USER`, borrowed from nothing — not `.env`, not `.env.readonly`, not `doadmin`. | This is what lets migrations run *for real* with no production secret in play. It is also why `doadmin` is irrelevant to §5.3/§5.3b: the migrations apply to the twin, and at real cutover (§7) they apply as the application's writer from `DATABASE_URL` — `doadmin` applies migrations at no point in this runbook. |
| **T2** | **The twin's superuser is a true superuser, and that is fine.** It holds more Postgres privilege than `doadmin` does (DO withholds real superuser — §3's `pg_read_all_data` box is that limit in action), yet near-zero risk: it reaches one disposable container and dies with it. | Privilege and blast radius are independent. Do not reason about this credential by its power; reason about the state it can reach. |
| **T3** | **The published port must bind a non-routable address** — `127.0.0.1`, or the Docker bridge gateway when sibling containers must reach it (§5.3b). **Never `0.0.0.0`.** | Docker inserts its own iptables rules ahead of ufw/firewalld, so a `0.0.0.0` bind can be reachable from outside the host *even when the firewall looks closed* (verified 2026-08-17). Given T4, the bind address is the only thing standing between a production-data copy and the internet. |
| **T4** | **The twin's password must be generated per run, not a constant.** | A predictable password is acceptable *only* while T3 holds perfectly; making it unpredictable removes the dependence of one control on another and costs nothing. **Conformant as of 2026-08-17.** `restore-container.ts` previously hardcoded `LOCAL_PASSWORD = "throwaway-local-only"` while §5.3's prose claimed the superuser was "freshly generated" — it was not. It now is: generated per run, never logged, passed to callers on `RestoredContainer`. |

### 5.4 🔴 IRREVERSIBLE — capture the swarm schedule rows, which no restore returns

```yaml step
id:          P3.schedules
phase:       P3 backup
section:     §5.4
host-role:   stage
actor:       agent
artifacts:
  - rm-swarm-schedules-*.txt
verify:      §5.4's psql block, then: where.ts --record P3.schedules
```

The `.dump` restores them, but **nothing in §9's rollback does**, and the very
next boot overwrites them again. `seedSwarmSchedules()`
(`backend/src/db/seed.ts:137-152`) issues an unconditional `UPDATE
job_schedules SET cron, enabled, payload, timezone WHERE kind = …` for each of
the five `swarm.*` definitions, and `seed()` is called unconditionally from
`backend/src/db/migrate.ts:61` on **every** boot — v0.2.2's and, after §9,
v0.2.1's too. Any operator toggle you have made to those five rows is
**IRREVERSIBLE** through rollback: rolling the code back rewrites them a second
time (§9, §6.5).

The prior values are therefore an evidence artifact, not a curiosity. Take it
now, with the rest of the backup. This is a pure `SELECT`, so it runs as
`rm_readonly` against the **replica** like every other pre-cutover read in
this runbook — **not** as the application's writer. An earlier revision used
`psql "$DATABASE_URL"` here, which is the one production write credential,
reached for at the one point in preflight where nothing needs it; §2's rule
is that preflight never touches the primary and never uses the writer.

```bash
# Same connection §4 uses, read out of .env.readonly. One helper, so a
# password containing '=' survives (only the FIRST '=' separates key/value).
rokey() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" <checkout>/.env.readonly | head -1; }

export PGHOST="$(rokey host)"       PGPORT="$(rokey port)"
export PGUSER="$(rokey username)"   PGPASSWORD="$(rokey password)"
export PGDATABASE="$(rokey database)" PGSSLMODE=require

# Prove it is the replica and the read-only role before trusting the output.
psql -X -Atc "SELECT current_user, inet_server_addr(), current_database();"

psql -X -c \
  "SELECT kind, cron, enabled, timezone, payload, next_run_at, last_enqueued_at FROM job_schedules WHERE kind LIKE 'swarm.%' ORDER BY 1;" \
  | tee "rm-swarm-schedules-${STAMP}.txt"
```

Expect five rows. **Verified 2026-08-17** against the replica as `rm_readonly`:
five rows, all `enabled = f`, `payload` `{}` except
`swarm.publish_brief`'s `{"windowMinutes": 60}` — matching §8.0's check-12
baseline, which is the point of capturing it in both places. Also captures
`next_run_at` and `last_enqueued_at` per row — these are the wedge-detection
fields referenced in §4 and §8.2.

This file is the **only** record of what the boot is about to clobber;
restoring those values afterwards is a manual `UPDATE` per row, and you
cannot write it without this output. Keep it with the dump (it holds no
credentials, so it does not need §5.2's encryption).

### 5.5 Digital-twin rehearsal

```yaml step
id:          P5.postflight-twin
phase:       P5 twin rehearsal
section:     §5.5
host-role:   stage
actor:       agent
requires:
  - P5.rehearsal-boot
depends-on:
  - backend/scripts/upgrades/0.2.1-to-0.2.2/postflight.ts
  - backend/scripts/upgrades/0.2.1-to-0.2.2/steps.ts
  - backend/scripts/lib/postflight-utils.ts
  - backend/scripts/lib/checks.ts
  - backend/migrations/**
verify:      DATABASE_URL=<twin> bun scripts/upgrades/0.2.1-to-0.2.2/postflight.ts --base-url=<twin api> --emit-receipt=P5.postflight-twin
```

⛔ **This is a blocking gate.** Do not proceed to §7 until the twin run exits
`0` and every acceptance criterion in §5.6 is met.

Restore the backup (§5.3's `restore-check.ts`, then §5.3b's
`stage-rehearsal.ts`) into a local Postgres container and run the full runbook
against it in sequence:

1. **Preflight (§4)** — run `restore-check.ts` (Gate C) first, then §4's live
   checks against the restored twin. Any failure is blocking. Follow the fix
   loop: patch, cut the next rc, restore a fresh dump, rehearse again.
2. **Cutover (§7)** — run `stage-rehearsal.ts`, which executes the exact §7.3
   boot command (`bun scripts/demo.ts --smoke --external-pg --no-tui`, `CI`
   unset) against the migrated twin. Any failure is blocking.
3. **Postflight (§8)** — run every §8 check **and** every §8.1 acceptance
   criterion against the twin after the boot reaches readiness. Any failure is
   blocking — do not carry a known-failing AC into a production cutover on the
   theory that production will behave differently.

The twin holds real production rows. An AC failure on the twin is an AC failure
in production; it is the same data. Treat a failing twin the same as a failing
production cutover: diagnose, patch, cut the next rc, re-rehearse from step 1.

```bash
cd <checkout>/backend
# Step 1 — preflight against the twin
bun scripts/upgrades/0.2.1-to-0.2.2/restore-check.ts ~/rm-backup-v022

# Steps 2+3 — cutover + postflight against the twin
bun scripts/upgrades/0.2.1-to-0.2.2/stage-rehearsal.ts ~/rm-backup-v022
# After EXIT=0: run every §8 check and §8.1 ACs against the twin's published port
```

### 5.6 Stage rehearsal report

```yaml step
id:          P6.report
phase:       P6 go/no-go
section:     §5.6
host-role:   stage
actor:       operator
requires:
  - P4.preflight-live
  - P5.rehearsal-boot
  - P5.postflight-twin
artifacts:
  - rehearsal-report-*.md
  - stage-rehearsal-report-*.md
verify:      write the §5.6 report, then: where.ts --record P6.report --note GO
```

⛔ **Gate: do not proceed to §7 until this report exists and all criteria pass.**

Produce a written report covering the twin rehearsal just completed. Save it to
a file alongside the backup artifacts (e.g.
`stage-rehearsal-report-<STAMP>.md`). The report must include:

**1. Twin setup**
- RC tag and SHA deployed to the twin
- Backup stamp used (`rm-preupgrade-<STAMP>.dump.gpg`)
- `restore-check.ts` exit code and any notable output

**2. Preflight results (§4 on the twin)**
- All **Gate C, B, D, E** results (pass / fail / note) — §2's four gates, in
  execution order. There is no Gate A; an earlier revision of this line asked
  for "Gate A–D" after §2 had abolished it
- Exit code of `restore-check.ts`

**3. Cutover results (§7 on the twin)**
- `stage-rehearsal.ts` exit code
- Time to readiness (`ready after …s`)
- Frontend check verdict

**4. Postflight results (§8 on the twin)**
- Result for every §8 check (check 1–12)
- All §8.1 acceptance criteria explicitly ticked or failed

**5. Acceptance criteria** (mark each PASS or FAIL with evidence)
- All features in #660 Objective are present and working
- No unexpected schema drift — exactly the six migrations this release ships,
  and no others: `0029_admin_auth_recovery`, `0029_admin_passkey`,
  `0030_swarm_member_handle`, `0031_swarm_member_handle_namespace`,
  `0032_append_only_history`, `0033_swarm_member_uuid_ids`. (An earlier
  revision said "only migrations `0028`–`0031`": `0028` is not in this delta
  at all — §2 relies on it already existing at `v0.2.1` — and `0032`/`0033`
  were missing. The list has one home now:
  `THIS_RELEASE_MIGRATIONS` in `backend/scripts/upgrades/0.2.1-to-0.2.2/steps.ts`,
  which `preflight.ts`, `postflight.ts` and §8's check 2 all read)
- Member counts after migration match baseline (§5.0)
- Zero null or incorrect handles (§8.1)
- `swarm_recommendations` count ≥ baseline

**6. Issues found**
List any failures, unexpected output, or observations encountered during the
rehearsal. For each: description, disposition (fixed before proceed / carry to
§10 known-broken / blocking).

**7. Go/no-go**
State explicitly: **GO** or **NO-GO**, with reason.

**8. Operator sign-off**
> Rehearsal completed by: __________ Date: __________ Sign-off: __________

---

## 6. Config before cutover — and what you CANNOT configure

This section replaces the "set `AUTOMATION_TOKEN` and `SWARM_PUBLIC_BASE_URL`
before cutover" plan. **Both of those steps are impossible through the operator's
workflow.** Verified by tracing the spawn environment, not assumed — first at
`ccf983f`, re-verified 2026-08-17 against `origin/releases-0.2.x` (`d852329`),
where `scripts/stack/stack.ts`, `scripts/stack/config.ts`,
`scripts/lib/demo-main.ts` and `docker-compose.yml` are all byte-identical to
`ccf983f`. The mechanism is structural, not a commit-local accident.

### 6.1 Why: how environment reaches the api container under `bun smoke`

`bun smoke` boots through `scripts/stack/stack.ts`'s `up()`. That spawns
`docker compose` with `env: spawnEnv` — a **replacement** map, not a merge with
your shell (`scripts/stack/stack.ts:224-233`). `buildSpawnEnv`
(`scripts/stack/config.ts:264-271`) copies only `DOCKER_CLIENT_ENV_ALLOWLIST`
(`:241-259` — `PATH`, `DOCKER_HOST`, proxies, nothing application-shaped) from
your shell, then overlays `buildComposeEnv(cfg)` **last**, so a stack-owned name
can never be sourced from anywhere else.

Two consequences:

- Your exported shell variable is **dropped** unless it is in
  `DOCKER_CLIENT_ENV_ALLOWLIST` or in `DEMO_COMPOSE_PASSTHROUGH`
  (`scripts/lib/demo-main.ts:427-444`).
- A repo-root `.env` **is** auto-loaded by Compose for `${VAR}` interpolation
  (no `--env-file` or `--project-directory` is passed anywhere; the child's cwd
  is the repo root, `scripts/stack/stack.ts:216`) — but process env beats `.env`,
  so anything `buildComposeEnv` emits still wins.

### 6.2 ❌ `AUTOMATION_TOKEN` — cannot be set, and does not need to be

`buildComposeEnv` sets `AUTOMATION_TOKEN: cfg.credentials.automationToken`
(`scripts/stack/config.ts:220`), minted fresh **every boot** by
`generateStackCredentials()` (`:162-168`, called at
`scripts/lib/demo-main.ts:381-383`). Putting it in `.env` or exporting it in your
shell changes nothing — the generated value overrides both.

So the established finding that `AUTOMATION_TOKEN` is *"absent from `.env.example`
and fail-closed, therefore must be set"* **does not hold for this workflow.** It
is absent from `.env.example` (confirmed — zero occurrences), and
`backend/src/api/auth.ts:70-76` does fall through to `allowInsecure` rather than
`false` when unset — but under `bun smoke` it is never unset, because the stack
mints it. **No action required. Do not try to set it.**

### 6.3 ❌ `SWARM_PUBLIC_BASE_URL` — cannot reach the container at all

It appears in **no compose file**: not in `docker-compose.yml`'s api
`environment:` block (`:171-223`), not in `docker-compose.demo.yml`'s (`:34-72`),
not in `docker-compose.stage.yml`, not in the `x-worker-env` anchor
(`docker-compose.yml:109-137`). There is no `env_file:` in any compose file and
`backend/Dockerfile` sets no `ENV`, so an unlisted name is simply never
delivered — the same allowlist property deployment.md §2.1 documents for
`RM_ALLOW_HANDLE_NAMESPACE_VIOLATION`. Note the contrast, because it is easy to
read that cross-reference the wrong way: `RM_ALLOW_HANDLE_NAMESPACE_VIOLATION`
**is** named by the api `environment:` block (`docker-compose.yml:184`) and so
*can* be delivered — but on **this** workflow only out of the repo-root `.env`,
never out of your shell, and even then it cannot rescue the boot. See §7.5.

`.env.example:138` documents it as if it were configurable. It is not.

**Effect in v0.2.2:** the api always computes the **compiled-in default**,
whatever that is in the tag you deploy. At `ccf983f` that was
`backend/src/config.ts:438`'s `https://robotmoney.net` — the **old** domain
that `bc9f20f` (#603) just moved away from — so every swarm
application-receipt and activation email linked to the old host. `7b1abbf`
(#628) fixed this: the default is now
`SWARM_PUBLIC_BASE_URL_DEFAULT = "https://robotmoney.network"`
(`backend/src/config.ts:448`, resolved at `:450-454`), and that commit **is**
on this runbook's branch (`releases-0.2.x`) as of this revision. **Confirm
which one is in your tag anyway (§1); do not attempt to change it during the
rollout** — it is unreachable from `.env` and from your shell either way. See
§10.2.

### 6.4 ⚠ `ADMIN_TOKEN` is also minted per boot — read it from the container

Same mechanism: `buildComposeEnv` sets `ADMIN_TOKEN:
cfg.credentials.adminToken` (`scripts/stack/config.ts:219`), a fresh random
20-character value per launch (`:164`). It is **never logged, never written to
`.agents/demo-state.json`, and never printed in the plain non-TUI READY block**
(`scripts/lib/demo-main.ts:374-378`; the block itself is `:1407-1421`, whose
Admin line at `:1413` prints only `(password shown in the interactive TUI
only)`). The TUI renders it at `:964`, and only while the credential is
unclaimed.

> **There is no `--no-tui` trap.** An earlier revision of this runbook said
> `--no-tui` costs you the token and told you to give up the exit code for it.
> That was wrong, and it contradicted §7.3's own requirement. The value is an
> ordinary environment variable **inside the running api container** —
> `docker-compose.yml:192` delivers it as `ADMIN_TOKEN: ${ADMIN_TOKEN:-}` — so
> it is readable from a boot that has no TUI at all. **§12.0 is the command.**
> Keep `--no-tui`; you lose nothing.

### 6.5 ✅ What you actually set, and where

The only supported configuration surface for this workflow is the **repo-root
`.env` file** in the checkout you run `bun smoke` from. There is no deploy
pipeline and no droplet-env injection step here.

```bash
cd <checkout>
cat .env      # must contain, at minimum:
# DATABASE_URL=postgres://<app-user>:<pw>@<host>:25060/defaultdb?sslmode=require
```

`--external-pg` reads `DATABASE_URL` from **that file directly**
(`scripts/lib/demo-external-pg.ts:288-305`), not from `process.env`. A missing or
unreadable `.env` is a fatal exit 1 before anything starts.

Optional, and genuinely honoured because they are in `DEMO_COMPOSE_PASSTHROUGH`.
**`scripts/lib/demo-main.ts:427-444` is the authoritative list** — read it there,
not here, before concluding anything is unconfigurable. Reproduced verbatim at
`origin/releases-0.2.x` (`d852329`, 2026-08-17) — sixteen names, unchanged
since `ccf983f`. Re-derive on your tag rather than trusting this block:
`git show <the §1 tip>:scripts/lib/demo-main.ts | sed -n '427,444p'`.

```
BASE_RPC_URL
SWARM_AGGREGATE_CRON
SWARM_CLOSE_WINDOW_CRON
SWARM_NOTIFICATION_EMAIL_FROM
SWARM_NOTIFICATION_EMAIL_TRANSPORT_TOKEN
SWARM_NOTIFICATION_EMAIL_TRANSPORT_URL
SWARM_OPEN_SESSION_CRON
SWARM_PUBLISH_BRIEF_CRON
SWARM_PUBLISH_CRON
SWARM_SCHEDULES_ENABLED
SWARM_WINDOW_MINUTES
FETCH_CACHE_DIR
FLOOR_SEED_PATH
PROJECTS_SOURCE
RM_ENV
WORKER_DATABASE_URL
```

An earlier revision of this runbook listed six of these and glossed the crons as
`SWARM_*_CRON`. Read as exhaustive, that omission says swarm **mail transport is
unconfigurable** on this workflow — it is not: the three
`SWARM_NOTIFICATION_EMAIL_*` names pass through, and so do `FETCH_CACHE_DIR`,
`FLOOR_SEED_PATH` and `WORKER_DATABASE_URL`. Values `buildComposeEnv()` owns
(ports, credentials, `DATABASE_URL`, `POSTGRES_*`, `DEMO_PROJECT`) are
deliberately **not** on the list and cannot be shadowed (§6.1, §6.2, §6.4).
Passthrough reads your **shell** environment, and an empty string counts as
unset (`demoPassthroughEnv`, `:446-453`).

> ⚠ **`SWARM_SCHEDULES_ENABLED` is on the list and still loses.**
> `docker-compose.demo.yml:72` pins it to `"0"` in the overlay regardless of what
> you pass, and `seedSwarmSchedules()` (`backend/src/db/seed.ts:137-152`)
> rewrites all five `swarm.*` rows' `cron`/`enabled`/`payload`/`timezone` on
> **every** boot — `seed()` is called unconditionally from
> `backend/src/db/migrate.ts:61`. So every `bun smoke` boot **disables all five
> swarm schedules in production**, clobbering any operator toggle, and §9's
> rollback boot does it again. **IRREVERSIBLE** through rollback — §5.4 captures
> the prior values, and it is the only record of them. Plan for the swarm to be
> manually driven after cutover.

---

## 7. Cutover

> **IRREVERSIBLE from here.** The migrations have no down files (verified: 41
> `.sql` files under `backend/migrations/`, none matching
> `down|rollback|revert|undo`). Rollback is code-only — see §9.

### 7.1 Stop the current stack, cleanly

```bash
cd <checkout>
bun run demo:status          # prints project=<name>; confirm it is the live one
bun run demo:down            # keeps the data; does NOT delete volumes
docker compose ls            # confirm no rm_demo_stack_* project is still up
```

If `docker compose ls` shows leftovers from earlier boots, tear each down
explicitly, **naming the same compose files that boot used** — see the
`-f`-less-compose box under §11 step 6 for why a bare `docker compose -p …`
command resolves a different topology than the one running:

```bash
docker compose -p <that project> \
  -f docker-compose.yml -f docker-compose.demo.yml \
  down --remove-orphans
```

The stakes are lower here than at §11 step 6 — `down` removes by project label,
so it cannot start anything — but without the overlay Compose does not know the
demo-only services and leaves them behind as orphans, which is exactly the
leftover you came here to clear. `--remove-orphans` covers the gap. See
deployment.md §2.1, "FIRST: find the project name".

### 7.2 Cut `v0.2.2-rc.N` and check it out

```yaml step
id:          P2.rc-tag
phase:       P2 release identity
section:     §7.2
host-role:   any
actor:       operator
derived:     true
verify:      git tag -a v0.2.2-rc.<N> <sha> -m 'v0.2.2 release candidate <N>' && git push origin v0.2.2-rc.<N>
```

**You deploy a release candidate, not `v0.2.2`.** The bare version tag is cut
only after §8's postflight passes (release-runbooks.md §2). Nothing else in this
runbook creates a tag, so this is the step that makes the thing you are about to
check out exist.

```bash
cd <checkout>
git fetch --tags origin
git tag -l 'v0.2.2*'                          # local rcs;  N = highest + 1, else 0
git ls-remote --tags origin | grep v0.2.2     # the same question, asked of origin
```

Cut it on the release branch, at the SHA you wrote down in §1 — **never on
`main`** (release-runbooks.md §2, last paragraph). Confirm the SHA is on the
branch before you tag it:

```bash
SHA=<the SHA you wrote down in §1>
git merge-base --is-ancestor "$SHA" origin/releases-0.2.x && echo "on releases-0.2.x"

git tag -a v0.2.2-rc.<N> "$SHA" -m 'v0.2.2 release candidate <N>'
git push origin v0.2.2-rc.<N>
```

(`v0.2.1` and both its rcs are lightweight tags — `git cat-file -t v0.2.1` prints
`commit`. Annotated is the better record of who cut what when, and nothing in
this repo reads the object type.)

If §4's preflight already ran against an rc you cut then — which is how
release-runbooks.md §5 step 1 says preflight is supposed to run — the tag exists
already; skip the two commands above and go straight to the checkout. Cutting it
here instead changes nothing about what ships: the tag is a name for the commit
you already gated, and the `git rev-parse HEAD` check below is what proves that.

```bash
git checkout v0.2.2-rc.<N>
git rev-parse HEAD           # MUST print the SHA you wrote down in §1
```

Compare it against the SHA you recorded, not against any commit named in this
file — every SHA written here is a snapshot, and the release branch has already
moved past several of them:

```bash
test "$(git rev-parse HEAD)" = "<the SHA you wrote down in §1>" && echo OK
```

A mismatch means the rc was cut somewhere other than the commit you gated in §4
and §6, and you are shipping something you never ran those gates against. Stop.

### 7.3 The invocation

```yaml step
id:          P7.cutover
phase:       P7 cutover
section:     §7.3
host-role:   cutover
actor:       agent
requires:
  - P6.report
depends-on:
  - backend/src/**
  - backend/migrations/**
  - backend/Dockerfile
  - frontend/**
  - scripts/**
  - docker-compose.yml
  - docker-compose.demo.yml
  - package.json
  - bun.lock
verify:      DEMO_PROJECT=rm_prod bun smoke -- --external-pg --no-tui   # then: where.ts --record P7.cutover
```

> 🔴 **IRREVERSIBLE.** This command is not a dry run and there is no "boot and
> look first" mode. It writes to production three times before you can inspect
> anything: the six migrations (§7.4), `seed()` rewriting the five `swarm.*`
> schedule rows (§6.5, §5.4), and the **archive initializer** — `prod-bootstrap.ts`
> run as `docker compose run --rm … api bun run scripts/prod-bootstrap.ts
> --already-migrated` (`scripts/lib/demo-main.ts:1136-1140`) — which adopts and
> writes archive rows into the live database (§8 verification 8). None of it has
> a down migration (§7 header). Do not run this before Gates B, D, E, C and A
> are all green.

> ⏱ **Downtime budget for the scheduler.** Every job in `job_schedules` that
> is enabled records the last moment it was supposed to fire in `next_run_at`.
> If the stack is down for longer than the schedule's cadence, `next_run_at`
> falls behind wall-clock time and the schedule becomes wedged — it will not
> self-fire when the stack comes back up. The risk window by cadence:
>
> | Schedule cadence | Wedge threshold |
> |---|---|
> | Per-minute (`* * * * *`) | > ~1 minute of downtime |
> | Hourly (`0 * * * *`) | > ~1 hour of downtime |
> | Daily | > ~1 day of downtime |
>
> In practice, a worker down for > ~16h40m will wedge every per-minute
> schedule for the next ~41 days without a manual `UPDATE job_schedules SET
> next_run_at = now() WHERE ...`. Plan for a maintenance window shorter than
> the shortest enabled schedule's cadence, or run §8.2 immediately after boot
> to detect and repair any wedge.

```bash
cd <checkout>
DEMO_PROJECT=rm_prod bun smoke -- --external-pg --no-tui
BOOT_STATUS=$?                # capture it HERE — §8 verification 1 reads this
echo "boot exit=$BOOT_STATUS" # MUST be 0
```

⚠ **Capture the status on the same line-group as the boot.** `$?` holds only the
*previous* command's status, and §8 opens with two commands of its own
(`export RM_PROJECT=…`, `bun run demo:status`) before its first check. By then
`$?` reports `demo:status`, not the boot. `BOOT_STATUS` survives that; `$?` does
not.

**Each flag, justified:**

| Flag / var | Why it is here | What happens without it |
|---|---|---|
| `--external-pg` | **MANDATORY.** Starts no postgres container and points the stack at the managed server via `DATABASE_URL` from repo-root `.env` (`scripts/lib/demo-external-pg.ts:288-305`). | The stack boots its own empty postgres in a fresh volume. **Your production data is not touched and not served** — you get an empty site and think it worked. This is failure mode #2 in §0. |
| `DEMO_PROJECT=rm_prod` | **MANDATORY.** Pins the compose project name (`scripts/lib/demo-main.ts:261`). Without it the name is `rm_demo_stack_<random>` per boot (`scripts/stack/naming.ts:138`). | Every restart leaves an orphaned project. `docker compose -p …` commands in deployment.md address the wrong stack. Note: `--external-pg` does **not** by itself stabilise the project name — only `DEMO_PROJECT` does. |
| `--no-tui` | On a TTY a **failed boot renders a pane and never exits non-zero**; Ctrl-C then exits `0` (`scripts/lib/demo-main.ts:1911-1918`, which returns without `process.exit`). `--no-tui` gives a real `exit 1` (`:1920-1928`). | You cannot tell success from failure by exit code. **Always pass it.** Needing the per-boot `ADMIN_TOKEN` — the expected unclaimed case (§2) — is *not* a reason to omit it: read the token out of the container instead (§12.0). |
| **`CI` must be UNSET** | ⛔ With any truthy `CI` the boot runs a bounded scenario and then **tears the whole stack down**. Under smoke the branch taken is `CI && smokeMode` (`scripts/lib/demo-main.ts:1175`): it runs one live swarm session against production and then `scripts/smoke-e2e-assert.ts` (`:1206`). The swarm-session *driver* at `:1212` is the **other** branch, `CI && !smokeMode`, and never runs here. Either way control reaches `if (process.env.CI)` at `:1390`, which calls `cleanup()` — a full `compose down` (`:697`, `:711-715`) — then `cleanCiVolume()` (`:1393`) and `process.exit(0)` (`:1394`). `cleanCiVolume()` also runs on the failure path (`:1893`), issuing `docker volume rm <project>_pgdata` (`scripts/lib/demo-volumes.ts:105`). | The volume removal is harmless under `--external-pg` (no volume exists), but the teardown is not. Success exits `0` (`:1394`) and failure exits `1` (`:1894`) — the exit code still works — yet **either way the stack is torn down**, so the site does not stay up and there is nothing left to inspect or verify in §8. Check with `echo "CI=[$CI]"` before you start. It must print `CI=[]`. |

```bash
echo "CI=[$CI]"     # MUST be empty
```

### 7.4 What the boot does, in order

```
docker preflight → build → postgres → [db preflight, --external-pg only]
  → migrate (scripts/stack/stack.ts:388) → services (:394) → ports → /health → initialize
```

⚠ **The bracketed step is the one part of this diagram no test asserts.**
`scripts/tests/unit/stack-lifecycle-order.test.ts:83-93` asserts the order, but
the array it compares against is exactly eight elements —
`docker-preflight, build, postgres, migrate, services, ports, health,
initialize` — with **no `db preflight` step in it**. The test runs `up()` without
an `upOpts.preflight` callback, so the `--external-pg` classification hook at
`scripts/stack/stack.ts:386` is never invoked and its position is uncovered.
Read from source, not from the test: `up()` calls `preflight()` at `:386`,
between the postgres phase and `migrate()` at `:388`, with the comment *"Refuse
before the first write, not after it"*. Everything else in the diagram is
test-asserted; that element is asserted by reading.

**No service of the new stack starts if `migrate` fails** — services are step 6,
migrate is step 5. The six new migrations apply here:

| File | Effect | Why it cannot fail |
|---|---|---|
| `0029_admin_auth_recovery.sql` | `ADD COLUMN recovery_hash text` | Additive. Bare `ADD COLUMN` (`:4`) — only fails if the column already exists unrecorded (pre-flight checks this). |
| `0029_admin_passkey.sql` | passkey/session/challenge tables + 3 `REVOKE`s | Additive. **Requires `rm_worker`** — Gate D. |
| `0030_swarm_member_handle.sql` | `ADD COLUMN IF NOT EXISTS handle` (`:24`), backfill `handle = id` (`:28`), `SET NOT NULL` (`:30`), default-handle `BEFORE INSERT` trigger (`:47-49`), `CREATE UNIQUE INDEX` (`:53`) | The unique index **cannot** collide: the backfill sets `handle = id`, and `id` is the primary key. |
| `0031_swarm_member_handle_namespace.sql` | namespace `DO` block (`:84-98`) + `BEFORE INSERT OR UPDATE` trigger (`:182-184`), then `ENABLE ALWAYS` (`:195`) | On a clean v0.2.1 jump the `DO` block **cannot fire**: immediately after `0030` every row has `handle = id`, so `b.id = a.handle AND b.id <> a.id` is unsatisfiable. |
| `0032_append_only_history.sql` | `rm_append_only_guard()` trigger on the five historical tables (recommendations, briefs, sessions, memo_votes, member_keys) — prevents DELETE and TRUNCATE | Additive. Installs a trigger function and fires it on existing tables; no row rewriting, no column DDL. |
| `0033_swarm_member_uuid_ids.sql` | UPDATE-only re-keying of every non-UUID `swarm_members.id` plus seven child FKs; resets 0030's default handle; remaps `swarm_subjects.linked_member_id` | UPDATE-only — nothing deleted. Child FKs are made `DEFERRABLE` for the transaction and restored, never dropped/re-added, so their definitions (including three `ON DELETE CASCADE`s) cannot come back subtly different. Signatures survive: `payload` + `signature` verified empirically. |

**Both `0029` files apply.** The runner keys on the **full filename**
(`schema_migrations(name text PRIMARY KEY)`, `backend/src/db/migrate.ts:34`;
`applied.has(file)` at `:48`), not on a numeric high-water mark. Order is
filename-lexicographic (`:39-41`), so `…auth_recovery` runs before `…passkey`.

**Each file is one transaction together with its `schema_migrations` insert**
(`backend/src/db/migrate.ts:50-53`). There is no half-applied file, and
re-running after a failure resumes at the file that failed.

> Note: `seed()` at `backend/src/db/migrate.ts:61` runs **outside** any
> per-file transaction, after all migrations. It is the step that rewrites the
> five `swarm.*` schedules (§6.5).

### 7.5 The new refusal you may hit — #610

`56de8e9` (#610) moved the handle/id namespace re-check out of the
`--external-pg`-only path. It now runs from **two** places that matter here, in
this order:

1. **`backend/src/api/index.ts:59`, before `Bun.serve` binds a port.** On a
   violation the api prints `[api] REFUSING the boot: …` naming both members and
   calls `process.exit(1)`. Because `docker-compose.yml:265` sets `restart:
   unless-stopped` on the api — and `docker-compose.demo.yml`'s only `restart:
   "no"` is on the unrelated `member-agent` service (`:146`) — the container
   **restart-loops until the data is repaired.**
2. **`backend/scripts/prod-bootstrap.ts:86-113`, step 0, before it writes
   anything.** Under smoke this is the archive initializer, run as `docker
   compose run --rm … api bun run scripts/prod-bootstrap.ts --already-migrated`
   (`scripts/lib/demo-main.ts:1136-1140`). The precheck leads **both** step
   shapes, `--already-migrated` included (`stepsFor`, `:272-275`), and is the
   only step marked `haltOnFailure` (`:266-270`). It refuses and writes nothing.

#### ⛔ The §2.1 override CANNOT rescue a `bun smoke` boot

`RM_ALLOW_HANDLE_NAMESPACE_VIOLATION=1` is read in exactly one place:
`backend/src/db/handle-namespace.ts:476`, inside the **api** guard
(`HANDLE_NAMESPACE_OVERRIDE_ENV`, `:373`). `prod-bootstrap.ts`'s step 0 reads no
environment at all — it calls `checkHandleNamespace` and returns `failing` on any
violation. And a failing initializer is a failing boot: `composeAsync` throws on
a non-zero child (`scripts/stack/stack.ts:248-251`). **There is no value of any
variable that gets `bun smoke` to completion against a violating database.**
(Tracked as OPS-610-012 in issue #611.)

Two further traps if you try it anyway:

- **Exporting the variable in your shell is a no-op on this workflow.**
  `stack.up()` spawns compose with `env: spawnEnv` — a **replacement** map, not a
  merge (`scripts/stack/stack.ts:214-232`) — and `buildSpawnEnv` copies only
  `DOCKER_CLIENT_ENV_ALLOWLIST` before overlaying `buildComposeEnv`
  (`scripts/stack/config.ts:241-271`). Neither
  `RM_ALLOW_HANDLE_NAMESPACE_VIOLATION` nor `PG_NAMESPACE_GUARD_TIMEOUT_MS` is on
  that allowlist, in `buildComposeEnv`, or in `DEMO_COMPOSE_PASSTHROUGH`
  (`scripts/lib/demo-main.ts:427-444`), so the export is dropped before `docker`
  is invoked. This is the **opposite** of the droplet topology deployment.md §2.1
  describes, where CI runs `docker compose up -d` directly and the ambient
  environment *is* the interpolation source. Being in the api `environment:`
  allowlist (`docker-compose.yml:184-185`) is necessary but not sufficient: the
  value still has to reach the compose *process*.
- **The repo-root `.env` does deliver it — and still does not help.** Compose
  auto-loads `.env` from the project directory, the compose child's cwd is the
  repo root, and nothing passes `--env-file` or `--project-directory`
  (`scripts/stack/stack.ts:216`, `:226`; §6.1), so
  `${RM_ALLOW_HANDLE_NAMESPACE_VIOLATION:-}` at `docker-compose.yml:184` does
  resolve from it. What that buys is an api container that boots loudly and
  reports `handle_namespace: "overridden"` at `/health` — and a boot that still
  exits 1 at the archive initializer. With `CI` unset (which §7.3 requires) the
  failure path deliberately leaves the stack **up** for inspection
  (`scripts/lib/demo-main.ts:1897-1909`), so the site answers and looks alive.
  **That is not a completed cutover:** the archive/EDGAR initializer never ran,
  smoke's archive-continuity assertion never ran, and you have no evidence the
  release is good. Do not sign off on it, and do not leave it running as "the
  new production".

**The only remedy on this workflow is to repair the data.** §4's
`handle-namespace` check is what stops you reaching this at all; if you skipped
it, run it now against the same database. Then follow deployment.md §2.1's repair
— **one statement per printed line, all of them, each moving the HOLDER** — and
re-run §7.3. If you cannot repair inside your maintenance window, the exit is §9
rollback, not the override.

---

## 8. Post-cutover verification

```yaml step
id:          P8.postflight-prod
phase:       P8 postflight
section:     §8
host-role:   cutover
actor:       agent
expect-in-recovery: false
requires:
  - P7.cutover
depends-on:
  - backend/scripts/upgrades/0.2.1-to-0.2.2/postflight.ts
  - backend/scripts/upgrades/0.2.1-to-0.2.2/steps.ts
  - backend/scripts/lib/postflight-utils.ts
  - backend/scripts/lib/checks.ts
  - backend/migrations/**
verify:      bun scripts/upgrades/0.2.1-to-0.2.2/postflight.ts --base-url=<prod> --emit-receipt=P8.postflight-prod
```

### 8.0 Dry-run this section before cutover — prove the checks discriminate

**Do this once, read-only, against still-`v0.2.1` production, before §7 runs —
not a spot check, a self-test of the checks below.** The point is exactly what
the admin-credential check's own history already proves the hard way (§2): a
check that
*looks* like it answers the right question can instead throw an error that
gets misread as a pass, or silently return an empty result that means
nothing yet. Run every SQL-shaped check from §8's table now, as `rm_readonly`
(§3/§4's role — this is safe, it cannot write), and confirm what you see
matches what is documented here — verified 2026-08-17 against production:

| # | Check | Result running TODAY, pre-upgrade | What it means |
|---|---|---|---|
| 2 | migrations recorded | `0 rows` | Correct negative signal — none of the four are applied yet. |
| 4 | handle namespace violation | `ERROR: column a.handle does not exist` (`42703`) | **Expected.** `handle` does not exist until `0030` applies. This is not a bug in the query and not something to "fix" pre-upgrade — running it today MUST error this way. If it instead returns `0 rows` today, you are pointed at an already-migrated database (wrong tag, or production has already been cut over) — treat that the way §2.0 treats a `psql ""` false pass: stop and re-verify what you are connected to. |
| 5 | namespace trigger `ENABLE ALWAYS` | `0 rows` | Correct — the trigger does not exist until `0031`. A `pg_trigger` lookup by name degrades gracefully to empty, unlike a column reference. |
| 6 | members missing handle | `ERROR: column "handle" does not exist` (`42703`) | **Expected**, same reason as check 4. |
| 7 | unsaveable handles | `ERROR: column "handle" does not exist` (`42703`) | **Expected**, same reason as check 4. |
| 8 | `swarm_recommendations` baseline | `557` rows (2026-08-17, measured by `restore-check.ts` against that day's dump; it read `547` earlier the same day — the table grows continuously, so this is a point-in-time count, **not** a constant, and yours will differ) | This is the number check 8 compares against post-upgrade (`≥` this). Take it from **your own** Gate C run, which prints it: `restore-check.ts` logs `swarm_recommendations: <n>` off the dump you are actually shipping with. You cannot recover it from a rolled-back or already-upgraded database. |
| 9 | `admin_credential` untouched | `ERROR: column "recovery_hash" does not exist` (`42703`) | **Expected — and previously undocumented here.** This is the exact same landmine §2's admin-credential check already documents at length (*"Do not name `recovery_hash` in this query"*) — `0029_admin_auth_recovery.sql` has not applied yet, so the column does not exist. Check 9 as written names it directly and WILL throw pre-upgrade. Do not read this error as a release failure; it is the correct pre-upgrade state. Re-run check 9 verbatim only after §7.4's migrations have applied — post-upgrade it must return rows, not an error. |
| 12 | swarm schedules baseline | five rows, all `enabled = f` (2026-08-17) | This is exactly what §5.4 asks you to capture — do it here too, so you have it recorded in two places before the boot in §7 can clobber it. |

Checks 1, 3, 10, 11 are not dry-runnable this way: 1 depends on the boot's own
exit code, 3 and 11 hit the running api's HTTP surface (whose `/health` shape
and prerendered routes are §8's post-upgrade behavior, not something that
exists to check pre-upgrade), and 10 depends on the admin-credential check's
result, already established separately in §2.

**If any check above does not match its documented result** — in particular,
if check 4/6/7/9 do *not* error, or check 2 is not empty — stop. You are not
looking at the pre-upgrade database this runbook assumes, and every check
number in §8's table below needs re-deriving before you trust it after
cutover.

Discover the project first — you pinned it, so it is `rm_prod`. `DATABASE_URL`
must be loaded and asserted in **this** shell too, or every `psql` below grades
the wrong database (§2.0):

```bash
export RM_PROJECT=rm_prod
[ -n "${DATABASE_URL:-}" ] || { echo "re-do §2.0 in this shell"; exit 1; }
psql "$DATABASE_URL" -Atc "SELECT current_database(), inet_server_addr(), inet_server_port();"
bun run demo:status
```

⚠ Every command in that block overwrites `$?`. Check 1 therefore reads
`$BOOT_STATUS` — the variable §7.3 captured on the boot's own command line —
and never `$?`.

| # | Check | Command | Expected |
|---|---|---|---|
| 1 | Boot exited clean | `echo "$BOOT_STATUS"` — the variable captured on §7.3's own command line. **Not `echo $?`**: by the time you reach §8 that reports `demo:status`, not the boot, and it will read `0` after a failed cutover. | `0`. On a TTY without `--no-tui` this proves nothing (§7.3). If `BOOT_STATUS` is unset you did not capture it; you cannot recover it, so re-run §7.3 (it is idempotent — migrations resume, seed and adopt are idempotent) rather than assume. |
| 2 | All six migrations recorded | `psql "$DATABASE_URL" -c "SELECT name FROM schema_migrations WHERE name LIKE '0029%' OR name LIKE '003%' ORDER BY 1;"` | six rows: `0029_admin_auth_recovery.sql`, `0029_admin_passkey.sql`, `0030_swarm_member_handle.sql`, `0031_swarm_member_handle_namespace.sql`, `0032_append_only_history.sql`, `0033_swarm_member_uuid_ids.sql` |
| 3 | Namespace guard ran and was clean | `curl -s "http://127.0.0.1:$(docker compose -p "$RM_PROJECT" port api 8787 \| cut -d: -f2)/health"` | `"handle_namespace":"clean"`. **`"unchecked"` means the guard could not run — this boot proves nothing.** `"overridden"` means you are serving a violation. |
| 4 | No violation in the data | `psql "$DATABASE_URL" -c "SELECT a.id, a.handle, b.id FROM swarm_members a JOIN swarm_members b ON b.id = a.handle AND b.id <> a.id;"` | 0 rows |
| 5 | Namespace trigger is `ENABLE ALWAYS` | `psql "$DATABASE_URL" -c "SELECT tgenabled FROM pg_trigger WHERE tgname = 'swarm_members_handle_namespace_trigger';"` | `A`. `O` means a `DISABLE`/`ENABLE` cycle downgraded it and the replica-role bypass `0031` closes is open again. |
| 6 | Every member has a handle | `psql "$DATABASE_URL" -c "SELECT count(*) FROM swarm_members WHERE handle IS NULL;"` | `0` (`SET NOT NULL` guarantees it; this catches a partial apply) |
| 7 | Handles are saveable | `psql "$DATABASE_URL" -c "SELECT id, handle FROM swarm_members WHERE handle !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length(handle) > 80;"` | 0 rows. Any row here is a member the admin surface can never re-save (§4, `handle-shape`). Fix with `UPDATE swarm_members SET handle = '<kebab-case>' WHERE id = '<id>';` — **move the handle, never the id.** |
| 8 | Archive data was adopted, not overwritten | `psql "$DATABASE_URL" -c "SELECT count(*) FROM swarm_recommendations;"` | ≥ the pre-upgrade count from §5.3. The archive initializer **adopts**: `classifyDatabase` returns `mode: "adopt"` for the archive initializer on populated data (`backend/scripts/db-preflight.ts:158`) — insert-if-missing, fill only `NULL` columns, else report drift. Existing rows win; the signed `payload`/`signature` columns are never rewritten. |
| 9 | `admin_credential` untouched by the boot | `psql "$DATABASE_URL" -c "SELECT count(*) AS rows, count(*) FILTER (WHERE recovery_hash IS NOT NULL) AS with_recovery FROM admin_credential;"` | `rows = 0` and `with_recovery = 0`, matching §2's pre-cutover check. **Use this form, not `GROUP BY`** — see the box below. (This is the first point in the runbook where `recovery_hash` is a legal thing to select: the column exists only after `0029` applied.) **No seed path ever writes this table.** |
| 10 | Admin surface reachable, and claimed | This is the expected path: §2's pre-cutover check found `rows = 0`, so **run §12.1 now — prompt the operator to claim the credential.** This is a mandatory step, not a spot check: until it runs, the one-time claim is open to whoever reaches the surface first. (Unexpected path: if §2's check found `rows = 1` — it should not have — stop and investigate; this runbook does not carry a remedy for it.) | `/api/admin/is-claimed` returns `{"claimed":true}` and you hold both the password and a recovery code. |
| 11 | Site serves prerendered HTML | `curl -s http://127.0.0.1:<port>/swarm/ \| grep -o '<title>[^<]*'` | Not the home page's title. **"Assembly did not run" is not a possible cause here** — see the diagnosis below. |
| 12 | Swarm schedules state | `psql "$DATABASE_URL" -c "SELECT kind, enabled FROM job_schedules WHERE kind LIKE 'swarm.%' ORDER BY 1;"` | five rows, **all `enabled = f`** — expected under the demo composition (§6.5). Compare against §5.4's capture: the difference is what this boot clobbered, and it is not coming back on its own. Drive sessions manually. |

### 8.1 ⛔ Release acceptance criteria — member identity

```yaml step
id:          P8.acceptance
phase:       P8 postflight
section:     §8.1
host-role:   cutover
actor:       operator
requires:
  - P8.postflight-prod
verify:      §8.1's six ACs by hand, then: where.ts --record P8.acceptance
```

**These are the release's objective, not a spot check. `EXIT=0` from any
script above does not satisfy them; only these queries do.** v0.2.2 exists to
separate member identity from public handle, so a cutover that leaves a
member with the wrong handle has not delivered the release, however green
every other check is.

**ONE algorithm, no exceptions.** Every handle is
`slugifyMemberName(name)` — the same function every code path uses. No member
gets a hand-picked handle, and in particular the v0 archive's own slugs are
**not** handles: the importer derives from the display name like everything
else. Two mechanics make this work, and both are worth knowing before reading
the table:

- **A slug id can never hold a matching handle.** `0030` backfills
  `handle = id`, and that equality doubles as the *"nobody has set a handle
  yet"* sentinel — the column is `NOT NULL`, so there is no unset value to look
  for (`backend/src/swarm/handle.ts`, `handleIsUnset`). A handle equal to its
  own id therefore reads as unset and is re-derived forever. **A UUID id is
  what makes a handle durable**, which is why AC1 is a prerequisite for AC2
  rather than a tidiness goal.
- **A slug id also SQUATS the handle namespace.** `0031` rightly refuses a
  handle equal to another member's id. With `woon` sitting in the id column,
  the member actually *named* Woon cannot be given `woon`; derivation avoids
  the collision and hands it `woon-2`. So AC1 must land **before** the handles
  are derived — derived first, the collision is baked in.

**Consequence, stated plainly: some published URLs stop resolving.** Once
"Robot Money" holds handle `robot-money` and a UUID id,
`/swarm/members/robotmoney` matches neither column and 404s. That address is in
the shipped archive and in previously published links. Breaking it is the
accepted price of one uniform rule — the alternative was a per-member
exception, which is what let two subsystems disagree about the same member.
Where those references should land instead is tracked separately (#687).

| AC | Requirement | Verify |
|---|---|---|
| **AC1** | **Every member id is a UUID.** Members whose id was a human slug (`athena`, `robotmoney`, `woon`) are re-identified; `46bed5c1…` (Woon), `b4cc55fd…` (nat), `f7ee9a6a…` (Maximus) already comply and must be left alone. Note: the slug `woon` was Noop Analyst's id, not Woon's. | `SELECT id FROM swarm_members WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';` → **0 rows** |
| **AC2** | **Every handle is the derived one.** `slugifyMemberName(name)` for every member, with no exceptions: `Athena`→`athena`, `Robot Money`→`robot-money`, `Noop Analyst`→`noop-analyst`, `Woon`→`woon`, `Maximus`→`maximus`, `nat`→`nat`. | `SELECT name, handle FROM swarm_members ORDER BY name;` — every row must equal the derivation, and the six above are what a clean run produced against a production dump |
| **AC3** | **No member is left at `0030`'s default.** A handle still equal to its own id means the backfill never reached that member — the failure mode that would have left `Maximus`, `nat` and `Woon` at UUID handles, since the other derivation sites only fire on acceptance/registration events they had already passed. | `SELECT id, handle FROM swarm_members WHERE handle = id;` → **0 rows**. Manifest **filenames are not handles** and deliberately do not move (`robotmoney.json` stays), so do not compare handles against that directory |
| **AC4** | **No member carries a derived-suffix handle.** `woon-2` and anything shaped `<stem>-<n>` is a **failure**: it means derivation ran where an exact handle was required. | `SELECT id, handle FROM swarm_members WHERE handle ~ '-[0-9]+$';` → **0 rows** |
| **AC5** | **Demo/smoke tooling still works by handle.** A member is resolvable by handle through the API, and the demo/smoke path finds its member id by handle rather than a hardcoded literal — so no tooling depends on a slug id continuing to exist. | `curl -s "$API/api/swarm/members/robot-money"` returns that member (**not** `robotmoney` — the API returns HTTP 200 with a null body for non-existent members, standing behavior; the frontend URL `/swarm/members/robotmoney` may 404 — see above); `bun scripts/demo-frontend-check.ts` passes; a smoke boot seats its roster |
| **AC6** | **History stayed attached across the re-id.** Take, memo and key counts per member are unchanged, and signatures still verify — the re-id must carry every FK, **including `swarm_member_keys`**, or verification silently goes false. | per-member `count(*)` on `swarm_recommendations`/`swarm_memos` matches the pre-upgrade capture, and `/api/swarm/sessions/<id>` reports takes as `verified` |

> ⚠ **Check 9 must not use `GROUP BY`, and the reason is a false pass.** An
> earlier form was
> `SELECT count(*), (recovery_hash IS NULL) FROM admin_credential GROUP BY 2;`
> against an instruction to confirm "the count equals 0". On the **expected**
> state — an unclaimed credential, zero rows — a `GROUP BY` has no group to
> emit, so the query returns **`(0 rows)`**: no count at all, nothing to compare
> to `0`, and output an operator can reasonably read as an error or as the query
> having failed. The aggregate form above always returns exactly one row, so
> "expect 0" is a value you can actually see. This is the same class of trap as
> §8.0's checks 4/6/7/9, where the correct pre-upgrade answer is an error rather
> than a number — a check whose right answer looks like a malfunction is a check
> that gets misread at 3am.

> **AC6 is the one with a silent failure mode.** Verification is
> `payload` + `signature` + the pubkey reached through
> `swarm_member_keys.member_id`. The signed bytes contain the *historical*
> `memberId`, which is correct provenance and must not be rewritten — but if
> the key row is not repointed to the new id, every take for that member
> reports unverified with no error anywhere.

**If any AC fails, the release has not been achieved** — that is a postflight
failure in the §2 sense: patch, cut the next rc, and re-run preflight before
redeploying. Do not tag `v0.2.2`.

#### What delivers these, and what has been proven

Two changes land together, and **neither works alone** (branch
`issue-685-members-keyed-by-handle`):

| | delivers |
|---|---|
| Migration `0033_swarm_member_uuid_ids.sql` | AC1 — re-identifies every non-UUID member. `UPDATE` only: the seven child FKs are made `DEFERRABLE` for the transaction and restored, never dropped/re-added, so their definitions (including three `ON DELETE CASCADE`s) cannot come back subtly different |
| `backfillMemberHandles()`, called unconditionally from `seed()` | AC2/AC3 — derives a handle for every member still at `0030`'s default |

**Order is not optional.** Migrations run before `seed()`, which is the only
correct sequence: if `seed()` ran first while slug ids (including `woon`) are
still present, 0031's namespace trigger would refuse `woon` as a handle for the
member named Woon — it matches another member's id — and Woon would be
permanently handed `woon-2`. Running 0033 first removes the slug ids, so every
handle is derived cleanly from the member name.

Two things the implementation had to discover, recorded because a reimplementation
will hit both: `SET CONSTRAINTS ALL IMMEDIATE` is required before restoring the
constraints (otherwise the `ALTER` fails with *"cannot ALTER TABLE … because it
has pending trigger events"*), and `swarm_subjects.linked_member_id` must be
remapped **explicitly** — it is not a foreign key, so nothing in the deferral
loop can see it, and it would be left pointing at an id that no longer exists.

**Verified against a restored production dump on 2026-08-17**, not against
fixtures — the twin is where these ACs are cheap to evaluate and the data is
what will actually be migrated (§5.3b.0):

```
Athena athena | Maximus maximus | nat nat
Noop Analyst noop-analyst | Robot Money robot-money | Woon woon
```

all six ids UUIDs, no `-N` suffix anywhere, and a second pass wrote 0 changes
(idempotent). AC6 held completely: 29/167/168/26/167 takes and 95/96/95 memos
all still attached, zero orphans across all seven child tables,
`linked_member_id` remapped, **40/40 sampled signatures still verified**, no FK
left `DEFERRABLE`, all three `ON DELETE CASCADE`s preserved.

> **Name↔id note (verified 2026-08-19):** The slug id `woon` belonged to
> **Noop Analyst** (v0 archive import), not to the member named Woon — the real
> third party self-registered and already held UUID `46bed5c1…`. Migration 0033
> re-identified exactly the three slug-id members (Athena, Noop Analyst, Robot
> Money) and left the three UUID members (Woon, Maximus, nat) untouched. The
> AC1 list below names handles, not ids.

**Re-verified against the actual rc.6 twin on 2026-08-19:**

- 0033 remapped three slug ids (`athena`→`172155e5`, `woon`→`0ef3c38e`,
  `robotmoney`→`c5e402af`), left three UUID ids untouched
  (`f7ee9a6a`/`46bed5c1`/`b4cc55fd`).
- AC2: all six handles correct. AC3: no `-N` suffix, idempotent (0 changes).
- AC6: **every member's takes recomputed at read time** via the stored public
  key — athena 100/100, noop-analyst 100/100, robot-money 100/100, woon 34/34,
  maximus 37/37 — zero orphans, zero `DEFERRABLE` FKs, all three
  `ON DELETE CASCADE` preserved.
- `linked_member_id` remapped, `swarm_member_keys` orphan count 0.

⚠ **Merged to main.** The two branches (#685, #684) landed via commit
`9e29770`/`d0b0d1f`. The staging rehearsal against the actual rc.6 confirms
the ACs above hold on production data.

### Diagnosing check 11

The old remedy — *"`bun run static:assemble` did not run"* — is **unreachable on
this workflow.** `up()` calls `assembleStaticDir()` at
`scripts/stack/stack.ts:368`, before `build()` and long before any container
starts, and it **throws** on a non-zero `scripts/static-assembly.sh`
(`:287-288`), which aborts the bring-up. A boot that reached §8 at all ran
assembly successfully. Silently skipping it is not a state this stack has.

Work the real causes instead, in this order:

```bash
# a. Did the assembled tree actually get the route? (Empty = cause b or c.)
ls -l _static/swarm/index.html
docker compose -p "$RM_PROJECT" exec -T api ls -l /srv/frontend/swarm/index.html
```

- **The api is serving a different `_static`.** `docker-compose.yml:259` binds
  `./_static:/srv/frontend:ro`, resolved against the **compose project
  directory** — the repo root of the checkout the boot ran from
  (`scripts/stack/stack.ts:216`). Present on the host but absent in the
  container means the container was started from a different directory, or
  outside §7.3 entirely (§11 step 6 / a hand-run `docker compose up`, where
  nothing runs assembly and Docker will happily create an **empty** bind
  directory).
- **The route is not in the sitemap.** `scripts/prerender.ts:31-32` derives its
  entire route list from `frontend/public/sitemap.xml`'s `<loc>` entries that
  match `ORIGIN` (`prerender.ts:5`, `https://robotmoney.network`) and writes
  `<route>/index.html` for each. A route missing from the sitemap is silently
  never prerendered, assembly still exits `0`, and the api falls back to the
  home-page shell. Confirm with
  `grep -c '<loc>' frontend/public/sitemap.xml` — 37 on `origin/releases-0.2.x`
  (`d852329`, 2026-08-17), unchanged since `ccf983f`, but re-derive it on your
  tag (`git show <the §1 tip>:frontend/public/sitemap.xml | grep -c '<loc>'`)
  rather than treating 37 as a constant — and
  `grep -o '<loc>[^<]*' frontend/public/sitemap.xml | grep '/swarm'`.
- **A stale container.** The api container predates this checkout's assembly —
  `docker compose -p "$RM_PROJECT" ps` and compare `CREATED` against the boot.
  The fix is §7.3 again, never `docker compose restart` (§11 step 6's box).

### 8.2 Scheduler and producer liveness

> **This check addresses issue #644.** §8.1 confirms the schema and data are
> correct; this check confirms the scheduler fired and a producer wrote output
> after the new code booted. A green `/health`, a clean `/api/admin/overview`,
> and a continuous-looking `/performance` chart are **not** evidence these
> passed — they can all be green while every sampler is permanently frozen.

#### Check 13 — job_runs drained after boot

Wait at least 2 minutes after the boot exit, then:

```sql
-- Run against the read-only replica via rm_readonly
SELECT
  j.kind,
  j.next_run_at,
  j.last_enqueued_at,
  MAX(r.started_at) AS last_run_at,
  COUNT(r.*) AS run_count_last_10m
FROM job_schedules j
LEFT JOIN job_runs r
  ON r.kind = j.kind
  AND r.started_at > NOW() - INTERVAL '10 minutes'
WHERE j.enabled = true
GROUP BY j.kind, j.next_run_at, j.last_enqueued_at
ORDER BY j.kind;
```

**Expect:** every enabled `kind` shows `next_run_at` in the **future**. That,
not the 10-minute run count, is the liveness signal on this deployment.

> **Corrected 2026-08-20 — `run_count_last_10m` cannot be read as a pass/fail.**
> The first revision of this check expected *"every enabled `kind` row shows at
> least one `last_run_at` within the last 10 minutes."* Run against production,
> **all twelve** enabled schedules report `run_count_last_10m = 0`, including
> the ten that are perfectly healthy — because every schedule here is hourly or
> daily cron (`projects.discover` next fires 02:00 tomorrow), not per-minute.
> A 10-minute window is empty for almost all of them almost always, so the
> check as written fails a healthy system. Use `next_run_at` for the verdict
> and read `last_run_at`/`run_count_last_10m` as context.

A `next_run_at` in the past by more than the schedule's own cadence is the
wedge signal — the same condition §4's `wedged-schedules` check reports.

**Wedge detection:** if `next_run_at` is more than 1 minute in the past for a
per-minute schedule, it is already wedged. Repair:

```sql
-- As a privileged user (not rm_readonly) — this is a write
UPDATE job_schedules
SET next_run_at = NOW()
WHERE enabled = true
  AND next_run_at < NOW() - INTERVAL '5 minutes';
```

Re-run the detection query after 2 minutes and confirm all rows now show
`run_count_last_10m > 0`.

#### Check 14 — wallet_balance_samples written today

```sql
-- Run against the read-only replica via rm_readonly
SELECT
  MAX(sample_date) AS latest_sample,
  COUNT(*) FILTER (WHERE sample_date = CURRENT_DATE) AS samples_today,
  COUNT(*) FILTER (WHERE sample_date = CURRENT_DATE - 1) AS samples_yesterday
FROM wallet_balance_samples;
```

**Expect:** `latest_sample` = today's date, `samples_today > 0`. A
`samples_today = 0` with a `latest_sample` of yesterday or earlier means the
wallet balance sampler has not run since the new code booted — the sampler is
wedged or the worker container is not running.

If this is a fresh database (e.g. the twin), `samples_today` may legitimately be
`0` if the sampler has not fired yet. Wait the full schedule cadence and re-check.

> ⚠ **Check 14 ALREADY FAILS on production, and not because of this release.**
> Measured 2026-08-20 against the replica, pre-cutover: `latest_sample` =
> **2026-08-10**, `samples_today = 0`, `samples_yesterday = 0`. Both wallet
> samplers stopped ten days ago — `wallet.sample_balances` and
> `wallet.sample_sleeves` last succeeded on 2026-08-10 (`job_runs`) and their
> `next_run_at` has been frozen at `2026-08-09 16:32+00` ever since, which is
> exactly what §4's `wedged-schedules` WARN reports. Every other enabled
> schedule is healthy.
>
> So a post-cutover `samples_today = 0` here is the **pre-existing** wedge, not
> damage this upgrade did, and it must not be read as a postflight failure or a
> rollback trigger — the same treatment #660 already gives #649 and #648. Take
> the pre-cutover measurement above as the baseline, apply this section's repair
> `UPDATE` after the boot, and confirm the sampler recovers. If it does not, that
> is a separate production defect to file, not a reason to hold `v0.2.2`.

> **Note on §5.4's preflight wedge warning.** If §4's `wedged-schedules` WARN
> flagged any rows, cross-check them here: if those same rows now show
> `run_count_last_10m > 0`, the warning can be marked resolved. If they still
> show no runs, the wedge persisted through the upgrade and needs the repair
> `UPDATE` above.

### Only when all twelve checks are clean — tag `v0.2.2`

```yaml step
id:          P9.tag
phase:       P9 close out
section:     §8
host-role:   cutover
actor:       operator
derived:     true
requires:
  - P8.acceptance
verify:      git tag -a v0.2.2 <deployed sha> -m 'v0.2.2' && git push origin v0.2.2
```

This is the last step of the rollout. The version tag goes on the **exact commit
that is running and verified in production** — the rc you deployed in §7.2, which
is the SHA from §1. Take it from the running deployment, not from the branch,
which may have moved:

```bash
cd <checkout>
git rev-parse HEAD                       # the deployed commit; still the §1 SHA
git merge-base --is-ancestor "$(git rev-parse HEAD)" origin/releases-0.2.x \
  && echo "on releases-0.2.x"            # the tag goes on the release branch, never main

git tag -a v0.2.2 "$(git rev-parse HEAD)" -m 'v0.2.2 — verified in production'
git push origin v0.2.2
git rev-parse v0.2.2 v0.2.2-rc.<N>       # the two MUST print the same SHA
```

Those two tags naming one commit is the expected end state, not duplication to
clean up (release-runbooks.md §2).

⛔ **A failed check is not a reason to tag anyway.** Any check above that is not
clean means the release goes back around the loop: patch it on `releases-0.2.x`,
cut `v0.2.2-rc.<N+1>`, run **preflight again** against that rc, redeploy, and
re-run this whole section. `v0.2.2` cannot be cut at a commit that was never
deployed and verified, so a fix that lands after the deployed rc always costs
another rc — it cannot be "rolled into the final tag" (release-runbooks.md §2).
If the failure is bad enough to need production back on the old code first, that
is §9, and it is not an alternative to the patch-and-new-rc loop.

Then check every postflight box on the release tracking issue (#660), and check
`git log --oneline origin/main..origin/releases-0.2.x` for fixes made on the
branch during the rollout that are owed back to `main` (§1, "Branching model";
release-runbooks.md §6).

---

## 9. Rollback

> **Default rollback policy** (per `docs/technical/release-runbooks.md §4.8`):
> a postflight failure on production defaults to full rollback by restoring the
> pre-upgrade dump from §5.1. The operator makes the final call, but full
> rollback is the standard procedure. An operator may choose an alternate
> remediation only by recording the override reason, the alternate plan, and a
> second sign-off in the production rollout report (§13).

### Triggers — roll back if any of these are true

- Verification 3 reports `overridden`, or 4 returns rows you cannot repair now.
- Verification 2 shows fewer than four migrations **and** the boot is failing.
- The admin surface is unreachable post-cutover because `admin_credential` is
  claimed and nobody holds the password — most likely §12.1's claim window
  was raced, or the password was lost immediately after claiming. Roll back
  to regain access (`v0.2.1` still honours `ADMIN_TOKEN` against a claimed
  credential — see "What rollback does NOT undo" below), then resolve the
  credential before re-attempting cutover.
- The api is restart-looping (`docker compose -p rm_prod ps` shows repeated
  restarts) for any reason you cannot diagnose in 15 minutes.

### Procedure

**Code rollback is safe against the new schema.** `0030`'s `BEFORE INSERT`
trigger defaults `handle := id` (`0030_swarm_member_handle.sql:41`), and all six
`INSERT INTO swarm_members` sites omit `handle` — `backend/src/demo/e2e.ts:58`,
`backend/src/swarm/roster-seed.ts:117`, `backend/src/swarm/admin.ts:277`,
`backend/src/swarm/domain.ts:834` and `:1189`, and
`backend/scripts/v0-seed-bootstrap.ts:237`. So v0.2.1 code writing to a v0.2.2
schema produces valid rows, and the `NOT NULL` on `handle` cannot bite.

**Roll back to the last artifact that was actually deployed and running** — not
to "v0.2.2 minus the bug", which does not exist as a deployed thing. On a first
v0.2.2 attempt that is `v0.2.1`, and the commands below are literal. If an
earlier `v0.2.2-rc.<N-1>` was deployed and healthy before this attempt, that rc
is the last known-good artifact and is what you check out instead; substitute it
for `v0.2.1` in the two commands below and expect its own SHA from
`git rev-parse`. "What rollback does NOT undo" applies to either target — every
v0.2.2 rc carries the same four migrations — with **one exception**: an rc is
v0.2.2 code, so it does *not* restore `ADMIN_TOKEN` access to a claimed
credential. Only `v0.2.1` does (`auth.ts:64` is a bare `return false` on every
rc). If the trigger you are rolling back for is the admin lockout, the target is
`v0.2.1`. Rolling back never cuts or moves a tag; the way forward is still §8's
loop: patch, next rc, preflight again.

```bash
cd <checkout>
bun run demo:down
git checkout v0.2.1                    # or the last deployed, healthy v0.2.2-rc.<N-1>
git rev-parse HEAD                     # MUST print 5970f2d… (or that rc's SHA)
echo "CI=[$CI]"                        # MUST be empty
DEMO_PROJECT=rm_prod bun smoke -- --external-pg --no-tui
BOOT_STATUS=$?; echo "rollback boot exit=$BOOT_STATUS"   # capture it here (§7.3)
```

Re-run verification 3, 4 and 11.

### ⚠ What rollback does NOT undo

- **The schema stays at 0031.** There are no down migrations. `recovery_hash`,
  `admin_passkey`, `admin_session`, `admin_webauthn_challenge`,
  `swarm_members.handle`, its unique index and both triggers all remain.
- **`admin_credential` stays claimed** — but rolling back *does* restore
  `ADMIN_TOKEN` access to it, non-destructively. `v0.2.1`'s `isPrivileged()`
  falls back to the env token from inside the claimed branch
  (`git show v0.2.1:backend/src/api/auth.ts`, line 62); v0.2.2's is a bare
  `return false` (`auth.ts:64` — identical at `ccf983f` and at
  `origin/releases-0.2.x`, 2026-08-17). So a rollback is itself a remedy for an admin
  lockout discovered after cutover — read the new boot's token with §12.0 and
  sign in. It buys triage time; it does not give you a durable v0.2.2
  credential — resolving that is outside this runbook's scope.
- **The five `swarm.*` schedules stay disabled — IRREVERSIBLE.** `seed()`
  rewrote them on the v0.2.2 boot and rewrites them again on the v0.2.1 boot
  (`backend/src/db/seed.ts:137-152`, called from
  `backend/src/db/migrate.ts:61`, §6.5). Rollback restores **nothing** here.
  The only route back to the prior `cron`/`enabled`/`timezone`/`payload` values
  is a manual `UPDATE` per row, written from §5.4's capture — which is why §5.4
  is part of the backup evidence set and not an optional nicety.
- **Any handle you edited during triage stays edited** — and each edit repointed
  a published URL.
- **Data written while v0.2.2 was live stays.** Rolling the code back is not a
  point-in-time restore. If you need one, that is §5's dump or DO's PITR, and it
  is a separate, **DESTRUCTIVE** decision.

---

## 10. Known-broken in v0.2.2 — do not try to fix during the rollout

### 10.1 Passkeys cannot work behind the TLS tunnel 🔴

`backend/src/api/routes/admin-webauthn.ts:23-27` derives both the relying-party
id and the expected origin from the **request URL**:

```
const expectedOrigin = process.env.WEBAUTHN_ORIGIN || url.origin;
const rpID = process.env.WEBAUTHN_RP_ID || new URL(expectedOrigin).hostname;
```

`url` is `new URL(req.url)` (`backend/src/api/index.ts:64`), and the server is
plain HTTP — `Bun.serve` is configured with no `tls:` key (`:61-63`), and
`X-Forwarded-*` is consulted only for the client IP (`:76`), never for the
scheme. Behind the Cloudflare tunnel the browser is on `https://…` while the api
computes `http://…`, so registration and authentication both fail origin
verification (`admin-webauthn.ts:127-128`, `:197-199`).

The two override variables exist but are **in no compose file at all** — repo-wide
they appear only at `admin-webauthn.ts:24-25`. With no `env_file:` and no `ENV`
in `backend/Dockerfile`, they cannot be delivered.

**Use password auth for the admin surface in v0.2.2.** Passkeys are a
known-broken feature, not a rollout step.

### 10.2 The api advertised the old domain — **RESOLVED, #628 is merged**

Historical note, kept because §1 and §6.3 point here. At `ccf983f`,
`backend/src/config.ts:438` defaulted `SWARM_PUBLIC_BASE_URL` to
`https://robotmoney.net` while the canonical origin was already
`https://robotmoney.network` (`scripts/prerender.ts:5`,
`frontend/public/assets/js/app/seo.js:16`). Not overridable — §6.3. Swarm
emails linked to the old host.

**This is fixed.** `7b1abbf` (#628) landed the extraction to
`SWARM_PUBLIC_BASE_URL_DEFAULT = "https://robotmoney.network"`
(`backend/src/config.ts:448`, resolved at `:450-454`), pinned by an executed
test (`backend/tests/swarm-public-base-url.test.ts`). It is on
`releases-0.2.x` as of this revision — no longer conditional on "if you tag
at `ccf983f`," because the branch has moved past that point (§1). Still
verify empirically before cutover, since a fix landing on this branch today
does not guarantee it survives whatever else lands before you cut the tag:

```bash
git show <the tag you cut>:backend/src/config.ts | grep -n 'robotmoney\.net"'
# a hit  → the fix regressed; emails link to the retired host — stop and investigate
# no hit → the default is robotmoney.network; nothing to do
```

**Still CONTRADICTS deployment.md §2**, whose host table still lists
`robotmoney.net` / `swarm.robotmoney.net` / `app.robotmoney.net`, and
`cloudflared.config.example.yml:43`. #628 fixed only the api's compiled-in
default, not those docs/config — they remain stale as of this revision and
are not this runbook's to fix.

### 10.3 CSP headers — issue #607

Tracked separately. No rollout action; note it if a browser console shows
policy violations after cutover so it is not mistaken for a regression of this
release.

### 10.4 `bun smoke` has no CI coverage

Still true on `origin/releases-0.2.x` (`d852329`) as of 2026-08-17, not just at
`ccf983f`: no workflow under `.github/workflows/` invokes `bun smoke` or
`--smoke`. Re-check on your tag — it is one grep, and a green CI badge is
otherwise easy to mistake for coverage of this path:

```bash
git grep -nE '(bun +smoke|--smoke)' <the §1 tip> -- .github/workflows/
# no output → the cutover is still the first real execution of this path
```

The smoke boot path is exercised by unit tests
(`scripts/tests/unit/smoke-mode.test.ts`) but not end-to-end in CI. Treat the
cutover as the first real execution of this path for this release, and keep §9
within reach.

### 10.5 Scheduler verification cannot substitute for heartbeat/overview checks

A green `/health` endpoint and a clean `/api/admin/overview` response are not
evidence that §8.2's scheduler and sampler checks passed. The health endpoint
checks database connectivity and service startup, not whether scheduled jobs
are firing. The admin overview reflects the current database state, not whether
that state is being updated by running producers.

Similarly, a continuous-looking `/performance` chart is not evidence the wallet
balance samplers are alive — historical data from before the upgrade populates
the chart correctly even if no new samples are being written.

**Always run §8.2 explicitly.** Do not substitute heartbeat or UI checks for it.

### 10.6 `BUYBACK_FROM_BLOCK` effect on indexer — if #614/#615 does not ship

`BUYBACK_FROM_BLOCK` is a fixed mainnet block number. If the indexer fix in
#614/PR #615 (`fix(chain): BUYBACK_FROM_BLOCK is a fixed mainnet fact...`) does
not ship in this release, the buyback indexer starts from block 0 on every boot
and rescans the entire chain history before processing new blocks. This causes a
long startup delay and may cause `job_runs` to show no recent activity for the
buyback-adjacent jobs during §8.2's liveness window.

Check whether #614/#615 is in the `releases-0.2.x` delta:

```bash
git log --oneline v0.2.1..origin/releases-0.2.x | grep -i 'buyback\|BUYBACK_FROM_BLOCK'
```

If it is absent, expect a cold-start delay; extend §8.2's wait window before
concluding the sampler is wedged.

---

## 11. Post-restore checklist

Run this **only** if you restored from §5's dump (or DO PITR) rather than simply
rolling code back. A restored database is the one population path the schema
cannot stand in front of.

**Open a session against the restored database first, and prove which one it
is.** These steps are written as bare SQL, so they need a `psql` session — and
nothing in this workflow puts `DATABASE_URL` in your shell (§2.0). If you
restored into a *different* database than production, `.env`'s value is the
wrong one; use that database's own URI instead.

```bash
psql "$DATABASE_URL"      # or the explicit URI of the database you restored
```

Then, at the `psql` prompt, before anything else:

```
\conninfo
```

It must name the database you restored. If it names production, or a local
socket, stop — you are about to "repair" the wrong server.

1. **Roles first — before anything connects.** `pg_dump` does not carry them.
   ```sql
   SELECT rolname FROM pg_roles WHERE rolname IN ('rm_worker', 'rm_readonly');
   ```
   Missing `rm_worker` → apply the globals dump, or re-run Gate D's `CREATE
   ROLE` + `0016_worker_role.sql:25-42` grants. Without it, the next boot's
   `0029_admin_passkey.sql:26-28` aborts with `42704`.

2. **Trigger state — `ENABLE ALWAYS`, not plain `ENABLE`.**
   ```sql
   SELECT tgname, tgenabled FROM pg_trigger
   WHERE tgname IN ('swarm_members_handle_namespace_trigger',
                    'swarm_members_default_handle_trigger');
   ```
   `swarm_members_handle_namespace_trigger` **must** be `A`. A restore, or any
   `DISABLE`/`ENABLE` cycle, silently downgrades it to `O` — which reopens the
   `session_replication_role = replica` bypass `0031` exists to close
   (`0031_swarm_member_handle_namespace.sql:186-194`). Repair:
   ```sql
   ALTER TABLE swarm_members ENABLE ALWAYS TRIGGER swarm_members_handle_namespace_trigger;
   ```

3. **The namespace query — a restore loads rows behind the trigger's back.**
   `pg_restore` emits `CREATE TRIGGER` in the post-data section, so the `COPY`
   that loads the rows runs before the trigger exists; and a dump from a
   post-0031 database already carries `0031_swarm_member_handle_namespace.sql`
   in `schema_migrations`, so the migration is skipped and its `DO` block never
   re-runs.
   ```sql
   SELECT a.id AS holder, a.handle, b.id AS shadowed
   FROM swarm_members a JOIN swarm_members b ON b.id = a.handle AND b.id <> a.id
   ORDER BY a.id;
   ```
   Any row here will make the api refuse to boot. Repair each: **one statement
   per row, moving the HOLDER.**

4. **`ANALYZE`** — a restore leaves no statistics, and the first queries against
   `swarm_members` will pick bad plans.
   ```sql
   ANALYZE;
   ```
   Or, if the database is large and you only need the hot tables now:
   ```sql
   ANALYZE swarm_members; ANALYZE swarm_recommendations; ANALYZE swarm_sessions; ANALYZE job_schedules;
   ```

5. **`pgcrypto`.**
   ```sql
   SELECT extname FROM pg_extension WHERE extname = 'pgcrypto';
   ```
   Absent → `CREATE EXTENSION IF NOT EXISTS pgcrypto;` as `doadmin`.
   `0001_backends.sql:4` needs it for `gen_random_uuid()` defaults.

6. **Restart the api — with `up -d`, not `restart`.** The namespace guard is a
   boot-time snapshot; nothing re-checks a database that changed underneath a
   live process (`backend/src/db/handle-namespace.ts:450-458`).

   > 🔴 **Do NOT run a bare `docker compose -p rm_prod up -d api`.** An earlier
   > revision of this runbook printed exactly that, and on the post-restore path
   > it is the worst command in the document.
   >
   > A `bun smoke --external-pg` stack is **three** compose files, not one:
   > `docker-compose.yml` + `docker-compose.demo.yml`
   > (`scripts/lib/demo-main.ts:284-288`) + a **generated** overlay written to
   > `.agents/demo-<project>-external-pg.yml` (`:299-304`), which is what removes
   > the `postgres` service and drops every `depends_on: postgres` so a
   > dependency edge cannot pull the container back in. Compose learns that list
   > from `COMPOSE_FILE` in the boot's own environment (`:463`), never from the
   > project name.
   >
   > With no `-f` and no `COMPOSE_FILE`, Compose resolves `docker-compose.yml`
   > **alone** — where the api still declares `depends_on: postgres: condition:
   > service_healthy` (`docker-compose.yml:262-264`). So Compose starts a **new
   > `postgres` container and a fresh `rm_prod_pgdata` volume**, waits for it to
   > become healthy, and brings the api up against a stack that now contains an
   > empty database. On the one path in this document where you have just
   > restored production data and have not yet verified it, that is how you end
   > up serving an empty site and reporting a successful restore.

   **Re-run the boot.** It is the only form that reconstructs the full
   topology. It also matters for the admin claim: a hand-run api container
   gets **no** `ADMIN_TOKEN` (`docker-compose.yml:192`'s `${ADMIN_TOKEN:-}`
   resolves empty outside `buildComposeEnv`), which opens `/api/admin/claim`
   to anyone who can reach the port:

   ```bash
   cd <checkout>
   echo "CI=[$CI]"                       # MUST be empty
   DEMO_PROJECT=rm_prod bun smoke -- --external-pg --no-tui
   BOOT_STATUS=$?; echo "boot exit=$BOOT_STATUS"
   ```

   If you must drive Compose directly, pass the **exact** file list this boot
   used. `.agents/demo-state.json` does record a `composeFiles` field
   (`scripts/lib/demo-main.ts:778`) — but ⚠ **do not use it verbatim**: it
   stores `composeFilesBase`, deliberately **without** the generated
   `--external-pg` overlay, because `demo:down`/`demo:status` act by project and
   do not need it (`:752-756`). That value reintroduces the entire defect above.
   Append the overlay yourself. For this rollout (`DEMO_PROJECT=rm_prod`, no
   `--stage`) the full list is:

   ```bash
   cd <checkout>
   ls -l .agents/demo-rm_prod-external-pg.yml   # must exist — no file, no boot to repair
   COMPOSE_FILE="docker-compose.yml:docker-compose.demo.yml:.agents/demo-rm_prod-external-pg.yml" \
     docker compose -p rm_prod up -d api
   ```

   Cross-check the first two names against `.agents/demo-state.json`'s
   `composeFiles` before running it; if that field lists a third file
   (`docker-compose.stage.yml`), keep it and append the overlay after it.

   Then confirm `"handle_namespace":"clean"` at `/health` (verification 3), and
   `docker compose -p rm_prod ps` shows **no `postgres` service**. One appearing
   there means the overlay was not applied and the api is on an empty database —
   tear the stack down and re-run the boot.

7. **Re-run §4's pre-flight** against the restored database. It is the cheapest
   way to find out that something in this list was missed.

---

## 12. Admin credential

### 12.0 Reading the current boot's `ADMIN_TOKEN`

```bash
export RM_PROJECT=rm_prod
docker compose -p "$RM_PROJECT" exec -T api printenv ADMIN_TOKEN
```

Verified against Compose v2.40: exits `0`, prints the 20-character value on one
line, and resolves the container from the project label alone — the working
directory does not need a compose file. `-T` suppresses TTY allocation so the
output is clean enough to assign to a variable.

Why this works: `generateStackCredentials()` mints `adminToken` as
`crypto.randomUUID()` stripped to 20 characters
(`scripts/stack/config.ts:164`); `buildComposeEnv` emits it (`:219`);
`docker-compose.yml:192` declares `ADMIN_TOKEN: ${ADMIN_TOKEN:-}` on the api
service, and `backend/Dockerfile`'s `oven/bun:1.3.5` base carries `printenv`.
The same three facts hold at `v0.2.1` (`scripts/stack/config.ts:163`, `:217`;
`docker-compose.yml:179`), so this also works on a stack you rolled back (§9).

> ⚠ **The token dies at the next boot.** It is minted per launch, so a restart
> between reading it and using it mints a *different* one and the value you
> copied is dead. Read it, use it, and if anything restarts, read it again.
> This is also why an unclaimed credential cannot simply be left for tomorrow:
> tomorrow's token is not today's.

To use it in the commands below:

```bash
ADMIN_SETUP_TOKEN="$(docker compose -p "$RM_PROJECT" exec -T api printenv ADMIN_TOKEN | tr -d '\r\n')"
API_PORT="$(docker compose -p "$RM_PROJECT" port api 8787 | cut -d: -f2)"
```

### 12.1 Claim the credential

**Mandatory, immediately after cutover — run at §8 verification 10.**
`admin_credential` is unclaimed going into this upgrade (§2); the first party
to reach `/admin` after cutover takes the one-time claim. Prompt the operator
to open `/admin` and complete the claim now, using this boot's setup token
(§12.0). The claim UI itself walks through the rest — setup token, new
password, the one-time recovery code — nothing further about that flow
belongs in this runbook.

---

## 13. Production rollout report

```yaml step
id:          P9.report
phase:       P9 close out
section:     §13
host-role:   cutover
actor:       operator
requires:
  - P9.tag
artifacts:
  - rollout-report-*.md
verify:      fill in §13, then: where.ts --record P9.report
```

Produce a written report immediately after the production cutover completes —
pass or fail. Save it to a file in the same directory as the backup artifacts
(e.g. `production-rollout-report-<STAMP>.md`) and attach it to issue #660.

The report must include:

### RC deployed

```
Tag:    v0.2.2-rc.<N>
SHA:    <git rev-parse HEAD on the production host>
Branch: releases-0.2.x
```

### Timeline

| Step | Wall-clock time | Notes |
|---|---|---|
| Stage rehearsal gate passed (§5.6) | | |
| Go/no-go sign-off (§2) | | |
| Cutover started (§7.2 tag cut) | | |
| Stack live (§7.3 boot ready) | | |
| Postflight completed (§8) | | |
| `v0.2.2` tagged (§8, last step) OR rollback decision | | |

### Postflight result

State one of:
- **PASS** — all §8 checks and §8.1 acceptance criteria met. Final `v0.2.2`
  tag cut at `<SHA>`.
- **FAIL → rollback** — describe which check(s) failed, rollback procedure
  followed, and whether the restore was verified clean (§9 procedure steps
  completed).
- **FAIL → override** — ONLY if the operator chose an alternate remediation
  instead of full rollback. Must include: the override reason, the alternate
  plan, and the second sign-off (required by §9 and §4.8).

### Rollback details (if applicable)

- Dump restored: `rm-preupgrade-<STAMP>.dump.gpg`
- Restore verified clean: yes / no
- Schema state post-rollback (migrations applied):
- Admin access restored via `ADMIN_TOKEN`: yes / no / N/A

### Final version tag commands

If postflight passed, record the exact commands that were run to cut the final
`v0.2.2` tag and push it to origin:

```bash
git tag -a v0.2.2 <SHA> -m "v0.2.2"
git push origin v0.2.2
```

### Backport TODO

Run after the release is tagged and verified:

```bash
git log --oneline origin/main..origin/releases-0.2.x   # commits owed to main
# Cherry-pick each listed commit to main per the release-runbooks.md §6 backport procedure.
```

### Operator sign-off

> Production rollout completed by: __________ Date: __________ Sign-off: __________
>
> Final `v0.2.2` tag exists on `releases-0.2.x`: yes / no
> Issue #660 closed: yes / not yet

The release tracking issue (#660) is closed only after this report is filed
and the final `v0.2.2` tag exists on `releases-0.2.x`.
