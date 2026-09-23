# Data model

Part of the [architecture](README.md). Split out of the former single `docs/architecture.md` on 2026-09-23; section numbering inside is unchanged so old citations still resolve.

## 6. Data model

One Postgres database consolidates everything previously split across committed
CSV/JSON, Upstash Redis (comments), and GitHub-as-DB (swarm). Full schema in
`backend/migrations/`; the groups:

- **Backends** (`0001_backends.sql`): `comments`; the swarm tables
  (`swarm_members`, `swarm_subjects`, `swarm_sessions`,
  `swarm_takes`, `swarm_briefs`, `swarm_subject_snapshots`,
  `swarm_applications`, `swarm_submissions`); and the single-row
  `allocation_framework` (shared by the allocation dashboard and the IC). The IC
  tables are detailed in §9.4 and get reconciled toward an append-only
  `swarm_recommendations` store in Phase 5.
- **Dashboard time-series** (`0002_dashboards.sql`): `vault_tvl`,
  `wallet_balances`, `prices`, `vault_apy`, `regime_snapshots`,
  `regime_indicators`, `research_signals`. The worker upserts on natural unique
  keys (e.g. `(ts, …)`, `(date)`) so reruns overwrite rather than duplicate; the
  API reads these.
- **Task queue** (`0003_task_queue.sql`): `jobs`, `job_schedules`, `job_runs`.
  These serve the vault, wallet, buyback and project pipelines (§7). Under the
  adopted design the swarm session lifecycle has no rows here: a subject's
  epoch duration is a column on `swarm_subjects`, set by bootstrap data and
  changed only through the admin API
  ([system-scheduler-spec §2.3](../technical/system-scheduler-spec.md#23-where-it-lives-and-who-sets-it);
  [smoke-production-spec §8.1](../technical/smoke-production-spec.md#81-snapshot)).

---
