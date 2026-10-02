# Postmortem: the v0.5.2 ledger repair ran on the production database

Date: 2026-09-29
Status: **Draft, updated after the cutover completed.** The 24-hour soak (R8) is still running; its result is not in this document.
Release: `v0.5.2-rc.2` (`becb6897`), from `releases-0.5.x`
Author: written with the release operator; blameless format

## Summary

v0.5.2 had to shrink the analytics ledger (issue 1035): 19-23 million duplicate
`source_value_versions` rows, 22 million vintage member rows and 3 million
overwrite events, 16 GB in all, growing 1.9 GB a day. The repair was written as a
one-time script that ran **inside the production database**, in one transaction,
holding five tables locked. It needed the whole stack (api, website, producer,
workers, session driver) stopped for the length of the run.

On the stage-2 rehearsal host the repair took 14 to 16 minutes. The cutover
announced a window of 25 to 30 minutes. On production it took **100 minutes**,
and the site was down for **1 hour 41 minutes**. Eighty of those minutes were one
SQL statement (the vintage re-point) that took 3 minutes on the twin, 25 times
longer. The other seven steps together took 20 minutes, between 0.7 and 3 times
the twin's time. The repair committed at 22:26:38 UTC and the stack was ready at
22:26:58. The database went from 16 GB to 963 MB.

The owner's judgement, which this postmortem adopts: **the approach was wrong.**
CPU- and disk-bound work was pushed onto a small production database and
serialised behind table locks. The work could have been done by batch workers
away from production, with production doing only a short load-and-swap.

## Impact

| | |
|---|---|
| Site | Down 2026-09-29 20:45:50 to 22:26:58 UTC: 1 hour 41 minutes (announced: 25 to 30 minutes) |
| Data loss | None. The repair commits only at its end. Aborting leaves the old ledger exactly as it was |
| Users affected | Everyone: website and api were both stopped |
| Sessions | The 4 sessions already stuck in `scheduled` since 09-27 stayed stuck during the window. The new driver adopted them after the boot |
| Cost | About 4 hours of rehearsal work, one 48-minute backup, and the window itself |

## Timeline (UTC)

| When | What |
|---|---|
| 09-28 22:09 | First full-dump rehearsal on stage-2. Migration `0080` (the repair as a migration) is cancelled at the api's 5-minute statement timeout |
| 09-29 early | Investigation shows 1.39M 'live'/'seed' relabel rows and 3.1M rows in 25k out-of-order chains. Decisions: ignore label-only changes, relink irregular chains, move the repair out of the migration into a script |
| 09-29 13:38-14:22 | First repair pass on the twin: 13.7 min. Parity shows 20 mismatches, traced to a tolerance too tight for ratio series. Tolerance moved to 5e-6, parity made tolerance-aware |
| 09-29 17:57, 18:24 | Two more twin runs fail at the very first step: the lock wait (30 s, then 6 min) loses to in-flight api reads that outlive the stopped api |
| 09-29 18:29-19:32 | "Fast path": freeze a template, repair a copy with nothing connected (15.5 min), dump it, boot the stack on it. The gate's session check then fails on a session inherited from production |
| 09-29 19:36 | Production baseline (R2). Two failures triaged: 4 stuck sessions, one unclassified error |
| 09-29 19:34-20:23 | Production backup from the replica: 1.6 GB in 48 minutes; verified "DUMP SAFE FOR 0.5.2"; copied off stage-2 |
| 09-29 19:55 | Reading `config.ts` finds that the repair would crash on production's `doadmin` login before touching data. Fixed, and `--apply-migration` added |
| 09-29 19:56-20:10 | Dress rehearsal of the exact production command, non-superuser owner-member login: passes in 14 minutes |
| 09-29 20:39 | Cutover script started. The driver's Ctrl-C leaves the containers running; the script stops safely, is fixed, and is rerun |
| 09-29 20:45:50 | Stack down |
| 09-29 20:46 | `0080` applied (26 s) and the repair starts. Lock wait: 0 s |
| 09-29 20:52 | Pre-repair mismatch count: 337 s (twin: 44 s) |
| 09-29 20:58 | Replay of 43 series done: 356 s (twin: 122 s) |
| 09-29 20:59 | Vintage re-point starts. Twin: 190 s. Production: still running at 21:50 (over 50 min) |
| 09-29 ~21:25 | Owner directs: do not cancel, keep the repair going |
| 09-29 22:19 | Vintage re-point finishes: 4,815 s (80 min) |
| 09-29 22:20-22:26 | Raw evidence replay 68 s, table rebuild 140 s, proofs 36 s, manifest rebuild 173 s (faster than the twin), final check 1.4 s |
| 09-29 22:26:38 | Repair commits. Versions 23.2M to 221,630; members 22.7M to 580,192; events 3.0M to 183,912. Database 16 GB to 963 MB |
| 09-29 22:26:58 | Stack ready, 131 frontend checks, 0 failed, 76 migrations recorded, `source_payloads` gone |
| 09-29 23:08 | Post-release gate exit 0; `verify:live` verified; the driver adopted the first stuck session |

## What went wrong

1. **The work was placed in the wrong process.** The repair reads and rewrites
   tens of millions of rows. It ran in the production database, so it competed
   for the production database's CPU and disk, and it needed exclusive table locks
   to be safe. Locks meant the site had to be down. A CPU- and disk-bound job
   inside the one shared, small, hard-to-scale machine is the failure the ledger
   itself had already caused (issue 1035 was exactly that: writes saturating the
   pool).

2. **The rehearsal host was not a model of production, and one step showed it
   badly.** Stage-2 has 7 GB of memory, local disk, and a freshly restored, fully
   cached copy of the data. Production's database has shared buffers of 190 MB, a
   cache estimate of 570 MB, two parallel workers per query, and reads from
   network storage. Most steps were 1.5 to 3 times slower there, and one (the
   vintage re-point, which joins 22.7 million member rows against a 15 million
   row scratch table) was 25 times slower. **The cause of that 25x is not
   proven.** One hypothesis: scratch tables use a tiny private buffer, not shared
   buffers, so on a machine without a large file cache every probe of the scratch
   table goes to disk. Another: the planner chose a different plan on production.
   We did not capture the plan, and the hosting provider's log was not readable.
   Our runbook sized the window "from R4.3's measured time on the full dump" and
   checked disk space, never database compute or memory.

3. **The window was announced as a fact.** "25 to 30 minutes" was an extrapolation
   from a different machine, stated without a range or an abort rule.

4. **No progress signal.** The heavy statement (the vintage re-point) is one SQL
   statement, and Postgres has no progress view for it. For 80 minutes the only
   observable facts were "alive" and "on the CPU, no waits", so there was no basis
   for deciding to wait or abort.

5. **Late discoveries in the final hours.** The `RM_ENV`/`doadmin` crash and the
   "Ctrl-C does not tear the stack down" behaviour were found only in the last
   hour before, and during, the window. Both fail safe, but they are the kind of
   thing a rehearsal on production-shaped access should have found days earlier.

6. **The rehearsal harness ate the time.** A stray checkout by another session on
   stage-2, a template frozen mid-session, a gate that counts an inherited stuck
   session as failed, and a 15-minute restore between attempts turned each
   iteration into 1 to 2 hours. Real defects (the tolerance, the label churn, the
   lock wait) were found this way, but slowly.

## What went well

- The first rehearsal caught that the original migration could not finish inside
  the 5-minute statement timeout, before any production change.
- The repair is atomic. Every failure so far, in rehearsal and in production,
  rolled back with nothing changed, and abort is safe at every moment.
- The production backup was verified by restoring it, and copied off the host with
  matching checksums.
- The dress rehearsal used the exact production command with a non-superuser login,
  which found a crash that a superuser rehearsal could not.
- The data analysis found real causes (label churn between the live fetch and the
  gap catch-up, a tolerance too tight for ratio series, out-of-order chains) and
  fixed the writers, so the ledger stops growing regardless of how the cleanup goes.

## The better design

Do the heavy computation on a batch worker, and give production only a small,
fast job.

1. **Read from a replica or a dump, not the primary.** The replay (which rows
   stay, how they chain, how vintage members re-point) is a pure function of the
   ledger. It needs no locks. A worker box reads a consistent snapshot.
2. **Compute in independent batches.** The replay is per series (43 of them), the
   member re-point is per vintage (133). Each batch is a small job that can be
   retried, timed, and reported on separately. Progress is visible.
3. **Ship a small plan.** The result is about 216 thousand kept versions, 580
   thousand member rows, 178 thousand kept events and 133 recomputed manifests.
   That is a few hundred thousand rows, not tens of millions.
4. **Production loads and swaps.** Load the plan into new tables next to the old
   ones, while the site keeps running. Then, in one short transaction, verify the
   plan against the live tables (nothing written since the snapshot, or replay the
   delta) and swap. The exclusive lock lasts seconds.
5. **Rehearse on the same hardware class.** Use a point-in-time fork of the
   managed cluster at the production plan size to time the load-and-swap. The
   heavy part no longer depends on production hardware at all.

Expected result: the site is down for the swap only, and the timing risk moves
from "unknown, disk-bound, on production" to "known, batch-sized, on a worker".

## Action items

| # | Action | Owner | Status |
|---|---|---|---|
| 1 | Watch the 24-hour soak (R8: gates at +6, +12, +18 and +24 h) and record its result here | Release operator | Open, running |
| 2 | Finish the runbook: tag `v0.5.2` on the rc that passes R8, merge `releases-0.5.x` into `main` with a real merge commit, write the rollout report | Release operator | Open, after R8 |
| 3 | Rebuild the repair as plan-on-a-worker, load-and-swap-on-production (design above) | TBD | Open |
| 4 | Runbook: size every window from a run on production-class hardware; record the database's memory, cache and parallelism next to the timing; state the window as a range with an abort time | TBD | Open |
| 5 | Give every long statement a progress signal (chunk it, or log rows done) | TBD | Open |
| 6 | Make the driver's stop tear the stack down, or make the runbook say to run `smoke:down` after Ctrl-C | TBD | Open |
| 7 | Rehearsal harness: a pristine template, a pristine restore per attempt, no shared-host use, and a gate that does not count inherited sessions as failures | TBD | Open |
| 8 | Add a check that the repair script runs under the production login (`doadmin`) to the rehearsal, so the `RM_ENV` class of crash is found on day one | TBD | Open |

## Open questions

- Why was the re-point 25 times slower on production? Capture the plan
  (`EXPLAIN (ANALYZE, BUFFERS)` on a fork of the production cluster) before
  redesigning around a guess.
- Should v0.5.2 have shipped with the writers fixed and the repair deferred to its
  own release? The writers alone stop the growth of the ledger. Only the cleanup
  of the existing 16 GB needed the risky operation.
