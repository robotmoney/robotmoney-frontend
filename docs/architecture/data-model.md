# Data model

Part of the [architecture](README.md). Split out of the former single `docs/architecture.md` on 2026-09-23; section numbering inside is unchanged so old citations still resolve.

## 6. Data model

One Postgres database consolidates everything previously split across committed
CSV/JSON, Upstash Redis (comments), and GitHub-as-DB (swarm). Full schema in
`backend/migrations/`; the groups:

- **Backends**: `comments`; the single-row `allocation_framework` (shared by
  the allocation dashboard and the IC); and the swarm tables, which the schema
  snapshot (`backend/schema/snapshot.sql`) declares as `swarm_members`,
  `swarm_member_keys`, `swarm_member_avatars`, `swarm_applications`,
  `swarm_claim_challenges`, `swarm_waitlist`, `swarm_subjects`,
  `swarm_sessions`, `swarm_session_members`, `swarm_session_events`,
  `swarm_briefs`, `swarm_brief_revisions`, `swarm_recommendations` (the
  append-only take store, D51), `swarm_memos`, `swarm_subject_snapshots`,
  `swarm_session_judgements`, `swarm_consensus_receipts`, `swarm_judge_config`,
  `swarm_judge_fault_injection`, `swarm_agent_health_events` and
  `swarm_stream_events` (the scheduler's event log). The early `swarm_takes`
  and `swarm_submissions` tables of `0001_backends.sql` are history. §9.4
  details the swarm tables.
- **Dashboard time-series** (`0002_dashboards.sql`): `vault_tvl`,
  `wallet_balances`, `prices`, `vault_apy`, `regime_snapshots`,
  `regime_indicators`, `research_signals`. The worker upserts on natural unique
  keys (e.g. `(ts, …)`, `(date)`) so reruns overwrite rather than duplicate; the
  API reads these.
- **Task queue** (`0003_task_queue.sql`): `jobs`, `job_schedules`, `job_runs`.
  These serve the vault, wallet, buyback and project pipelines (§7). Under the
  adopted design the swarm session lifecycle has no rows here: a subject's
  scheduling columns (epoch duration, epoch anchor, judging duration) live on
  `swarm_subjects`, set by bootstrap data and changed only through the admin
  API
  ([system-scheduler-spec §2.3](../technical/system-scheduler-spec.md#23-where-it-lives-and-who-sets-it);
  [smoke-production-spec §8.1](../technical/smoke-production-spec.md#81-snapshot)).

---
