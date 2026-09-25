# Log inventory — 2026-09-25

Every error-like and warning-like line, grouped by source, before any fix was
chosen. Collected with a scan of `docker logs --timestamps` for every
container, the restored twin database and the twin driver's log. Lines were
normalised (ids, numbers, timestamps collapsed) and counted.

- **Production** — `rm-frontend-prod-1`, all `rm_prod-*` containers, last 24 h
  (2026-09-24 17:25 → 2026-09-25 17:25 UTC), running `v0.5.0`.
- **Twin** — `rm-frontend-stage-2`, boot of commit `51181676`, since
  2026-09-25 17:08:51 UTC.

## Production

| # | Source | Count (24 h) | Message | Class | Cause |
|---|---|---|---|---|---|
| P1 | worker-analytics, worker-research, worker-swarm | ~650, continuing (27 in the last 10 min on worker-swarm) | `cannot execute UPDATE / SELECT FOR UPDATE in a read-only transaction` | **Critical, live** | Database intermittently read-only |
| P2 | api | 35 | `cannot execute INSERT in a read-only transaction` | Critical, live | same as P1 |
| P3 | api | 13 | `could not write to file "base/pgsql_tmp/…": No space left on device`; `could not extend file …: No space left on device` | **Critical, live** | Database disk full |
| P4 | api | 8 boots (11:22–15:26) | `REFUSING the boot: the append-only guard is NOT armed` … `cannot execute DELETE in a read-only transaction` | Critical | read-only window misread as a disarmed guard |
| P5 | api, all workers | ~100 | `CONNECTION_CLOSED`, `CONNECT_TIMEOUT` to the primary; `terminating connection due to administrator command` | Critical | cluster protecting itself (read-only switches) |
| P6 | analytics-producer | ~25 | `POST /api/analytics/source-acquisitions failed: HTTP 500 internal error`; `POST /api/analytics/vintages … database unavailable`; telemetry POST 500 | Critical | same database state |
| P7 | worker-analytics | 1,076 retries, 268 DEAD | `wallet.backfill_window … permission denied for table wallet_backfill_state` | Defect | rm_worker lacks the grant |
| P8 | worker-swarm | 12 retries, 3 DEAD | `swarm.judge … judge produced no judgement (model_unconfigured)` | Defect | judge model NULL |
| P9 | worker-analytics | 92 retries, 23 DEAD | `analytics.parity_sweep … The socket connection was closed unexpectedly` | Defect | sweep outlives the API's ~10 s idle timeout |
| P10 | api | 42 | `\u0000 cannot be converted to text` | Defect | NUL in parity evidence jsonb |
| P11 | worker-analytics | 76 retries, 18 DEAD | `ops.repair_gaps … CONNECT_TIMEOUT` | Consequence | database state (P1/P5) |
| P12 | website-server | ~100 | nginx `upstream prematurely closed connection`, `connect() failed (Connection refused)` | Consequence | api timeouts and refused boots |
| P13 | analytics-producer, api, worker-analytics | ~60 | yahoo `The operation timed out`; geckoterminal HTTP 429 (retry budget exhausted); `Base RPC HTTP` | External | third-party rate limits/timeouts; code degrades to persisted rows |
| P14 | website-server | 14 | `GET /skills/swarm-onboarding/this-path-cannot-exist.md` 404 | Benign | the live onboarding-skill test's own negative probe |
| P15 | website-server | 30 | nginx `[warn] an upstream response is buffered to a temporary file` | Benign | large response |

**Database size:** 6.1 GB (2026-09-24) → 6.5 GB (2026-09-25 morning) →
**8.2 GB** (2026-09-25 17:25). The growth is the analytics ledger (issue 1035).
P1–P6 and P11–P12 are one incident: the managed cluster running out of disk.

## Twin (`51181676`)

| # | Source | Count | Message | Class | Cause |
|---|---|---|---|---|---|
| T1 | worker-analytics | 4 retries, 1 DEAD | `analytics.parity_sweep … socket connection was closed unexpectedly` | Defect | = P9 |
| T2 | api | 1 | `[Bun.serve]: request timed out after 10 seconds` | Defect | = P9 (the sweep request) |
| T3 | driver log | 45 | compose `The "MIGRATE_DATABASE_URL" variable is not set. Defaulting to a blank string.` | Noise | compose references the variable with no default |
| T4 | driver log | 15 | geckoterminal HTTP 429, `NEW_TOKENS … using persisted rows` | External | = P13 |
| T5 | restore-db | 156 | `… is immutable / append-only: DELETE (UPDATE) is not permitted` | Expected | the boot guards' own probes: a refusal is the pass condition |
| T6 | driver log | 9 | `OK append-only-guard … delete refused`, `131 checks · 0 failed`, a Dockerfile `RUN … .invalid` line | False positive | success lines containing an error word |
| T7 | driver log | 1 | `WARN v0-seed:bootstrap … N drift` | Expected | adopted-database drift is reported, existing rows win |
| T8 | website-server | 2 | nginx buffered-response warning | Benign | = P15 |

## Already fixed on `qa/v0.5.1-website-picks`

P7 (`0061` grant), P8 (`0063` judge model), P10 (NUL in parity evidence), P4
(a read-only session is inconclusive, not a disarmed guard).

## Not yet fixed

P1–P3/P5/P6/P11 (database disk), P9/T1/T2 (sweep idle timeout), T3 (compose
default), and the gate report's handling of T5/T6.
