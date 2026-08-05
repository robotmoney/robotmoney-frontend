# Legacy data backport: implementation plan

Companion to [`gap-analysis.md`](./gap-analysis.md). Same governing constraint:
**the v1 data model is authoritative; legacy data is coerced to fit it.** No
migration in this plan adds a column, a table, or a flag to accommodate a legacy
shape.

---

## Phase 0 — Decisions to settle before any code

These are the only open questions. Everything downstream is mechanical.

| # | Decision | Recommendation |
|---|---|---|
| D1 | How legacy takes satisfy `signature NOT NULL` | Genuinely sign at import (gap-analysis §4.3). `verified = true` where we hold the member key, `false` where we do not. |
| D2 | Whose key signs `woon`'s 26 takes | Operator archival key, `verified = false`. Alternative: ask peaq to re-sign; do not block the backport on it. |
| D3 | Drop `finances_page` | Yes. Re-add as a real column later if a surface needs it. |
| D4 | Drop `voice_samples` | Yes — fold into `*.voice.md` before import if the content matters. |
| D5 | Drop `model` | Yes. One constant string, no v1 surface for it. |
| D6 | Source of truth for the allocation framework | The v1 `ALLOCATION_FRAMEWORK_SEED`. Legacy `allocation.json` is a cross-check, not an input. |

D1 is the only one that changes the shape of the work. D2–D6 are confirmations.

---

## Phase 1 — Freeze and stage the legacy corpus

**Goal:** one immutable input directory, so the import is reproducible and
re-runnable against identical bytes.

1. Snapshot from `robotmoney-site` at a pinned commit:
   - `data/committee/members/*.json` + `*.voice.md`
   - `data/committee/subjects/*.json`
   - `data/committee/allocation.json`
   - `public/data/committee/sessions/*.json`
   - `public/data/committee/briefs/*.json`
   - `public/data/committee/subjects/<id>/*.json`
2. Record the source commit SHA in a manifest alongside the corpus.
3. **Confirm coverage.** The copy already under
   `frontend/public/data/swarm/` stops at `2026-06-25` (32 sessions), while the
   live legacy site is publishing past `2026-08-03`. The staged corpus must come
   from legacy `main`, not from the stale in-repo copy. Count sessions and
   compare against the live archive before proceeding.

**Exit criteria:** file counts and date ranges for all six datasets recorded and
matching the live legacy site.

---

## Phase 2 — Validator (runs before any write)

**Goal:** every rejection the DB would raise is surfaced up front, against the
whole corpus, with no partial writes.

A read-only script that parses the staged corpus and asserts:

- Every `session.subject_id` and every take's `member_id` resolves to a staged
  manifest.
- Every take's `stance` is in the v1 stance vocabulary; `confidence` in `[0,1]`.
- Every session `state` target is legal against the `0017:152` CHECK.
- Every member/subject `status` is legal against the `0017:130`/`:139` CHECKs.
- `(subject_id, midnight-UTC convened_at)` is unique across all sessions.
- `(member_id, nonce)` is unique across all derived nonces.
- One take per `(session, member)` — the `UNIQUE (session_id, member_id)` pair.
- Derived `mode` matches legacy `mode` for every take (currently 96/96; if a new
  session breaks this, the derivation assumption in gap-analysis §4.4 is wrong
  and must be revisited, not patched around).
- Staged `allocation.json` agrees with `ALLOCATION_FRAMEWORK_SEED` on bucket ids,
  item ids and target weights (gap-analysis §7).

**Exit criteria:** validator exits 0 on the full corpus. Any failure is fixed at
the source or explicitly waived in writing — never by loosening the validator.

---

## Phase 3 — Importer

**Goal:** an idempotent, ordered, transactional load.

Order is forced by foreign keys:

```
1. swarm_members            (from member manifests + voice_md inlined)
2. swarm_subjects           (from subject manifests; finances_page dropped)
3. allocation_framework     (verify-only; already seeded)
4. swarm_sessions           (convened_at = date at midnight UTC; state='published')
5. swarm_recommendations    (signed per D1/D2)
6. swarm_subject_snapshots
7. swarm_briefs
```

Requirements:

- **Never inserts `date` on `swarm_sessions`** — it is a generated column
  (gap-analysis §3.1). Set `convened_at`.
- **Idempotent.** Deterministic nonces plus the natural unique constraints mean a
  re-run inserts nothing new. Use `ON CONFLICT DO NOTHING`, not upsert — this
  corpus is historical and immutable.
- **One transaction per dataset**, so a failure in sessions cannot leave takes
  orphaned.
- **Does not use the live submit path.** `domain.ts:448` requires
  `state = 'collecting'` and verifies against a registered key; the importer
  writes directly, with its own signing step.
- **No `TRUNCATE`.** `0022`'s header calls out history-wiping at boot as the
  original sin this schema was fixed to prevent.

---

## Phase 4 — Verification

Green exit code is not evidence the data loaded
(`CLAUDE.md` test-coverage invariant #2). Assert executed behaviour:

- Row counts per table match corpus counts exactly.
- Spot-diff N random sessions field-by-field: staged JSON vs. DB row, including
  the full `swarm_recommendation` jsonb blob.
- Every imported session renders: fetch each `(date, subject)` through the real
  session read path and assert the panels the data should produce — regime
  sparkline where `history.length >= 2`, bucket bars for `bucket_weights`
  subjects, action rows for `position_actions`, consensus/disagreements where
  populated, synthesis present and not echo-suppressed.
- `verified` counts match D1/D2 expectations exactly (e.g. 70 true / 26 false),
  so a silent all-false or all-true load is caught.
- Re-run the importer; assert zero new rows.

**Exit criteria:** all of the above executed in CI, not locally-only, per the
loud-skip invariant. If the corpus is too large for CI, run a fixture subset in
CI and the full load in a gated job — but the CI job must execute real inserts
against a real Postgres, not mock them.

---

## Phase 5 — Cutover

1. Run against a staging database first; render the full archive and compare
   against the live legacy site page-by-page for a sample of dates.
2. Resolve the separate session-view wiring gap (`allocation_framework` is not
   read by the session view, so Target/Gap/deviation are missing) **before**
   cutover, or accept that imported allocation sessions render thinner than
   their legacy equivalents.
3. Production import, then flip the site's subject/member/session reads from
   static JSON to the DB.
4. Keep the legacy site serving until step 3 is verified in production.

---

## Sequencing note

Phases 1–2 are independent of D1 and can start immediately. Phase 3 cannot start
until D1 is settled, since the signing decision determines the shape of every
`swarm_recommendations` row.

## Explicitly out of scope

- Any schema change to `swarm_*` tables.
- Backfilling `brief_opens_at` / `window_closes_at` / `published_at` — legacy
  sessions had no collection window and NULL states that honestly.
- Re-generating legacy synthesis or takes under the v1 aggregator. The archive
  is imported as published, not re-derived.
