# Legacy → v1 data backport: gap analysis

**Date:** 2026-08-05
**Source:** `robotmoney-site` (legacy Next.js site, file-backed committee data)
**Target:** `robotmoney-frontend` backend Postgres, `swarm_*` tables (post `0025_swarm_rename.sql`)
**Governing constraint:** the v1 data model is authoritative. Legacy data is
coerced to fit it. No new columns, no archive tables, no provenance side-channels
are added to accommodate legacy shapes. Anything that cannot be expressed in the
clean model is dropped deliberately and recorded here.

---

## 0. Executive summary

Seven legacy datasets map to seven v1 destinations. Five map losslessly. Two
require decisions:

| Legacy dataset | v1 destination | Verdict |
|---|---|---|
| `data/committee/subjects/*.json` | `swarm_subjects` | 1 field dropped |
| `data/committee/members/*.json` + `*.voice.md` | `swarm_members` | 4 fields dropped, 2 derivable |
| `data/committee/allocation.json` | `allocation_framework` | lossless |
| `public/data/committee/sessions/*.json` (session envelope) | `swarm_sessions` | lossless, but identity column is generated |
| `public/data/committee/sessions/*.json` (`takes[]`) | `swarm_recommendations` | **decision required — see §4** |
| `public/data/committee/subjects/<id>/*.json` | `swarm_subject_snapshots` | lossless |
| `public/data/committee/briefs/*.json` | `swarm_briefs` | lossless |

The only genuine blocker is `takes[]`. Everything else is mechanical.

**Nothing currently performs this backport.** `seed()`
(`backend/src/db/seed.ts:253`) writes `jobs`, `job_schedules` and
`allocation_framework` only. `backend edgar-seed:bootstrap` loads EDGAR
analytics filings, unrelated to the swarm. `deploy/bootstrap.sh` is described in
`docs/technical/release-cycle.md:728` as a planned droplet bootstrap (k3s
install); `deploy/` does not exist in the repo. There is no `bun run bootstrap`
in either `package.json`. Session history, takes, and analysis are restored by
nothing today.

---

## 1. Subjects → `swarm_subjects`

Legacy type: `robotmoney-site/src/data/committee.ts:49-64`. Target DDL:
`backend/migrations/0001_backends.sql`.

| Legacy field | Column | Notes |
|---|---|---|
| `id` | `id` (PK) | |
| `status` | `status` | Legacy values are `active`; satisfies `CHECK (status IN ('active','inactive'))` (`0017:139`) |
| `name` | `name` | |
| `operator` | `operator` | |
| `homepage` | `homepage` | |
| `x_handle` | `x_handle` | |
| `thesis_blurb` | `thesis_blurb` | |
| `wallets` | `wallets` jsonb | |
| `nft_contracts` | `nft_contracts` jsonb | |
| `source` | `source` jsonb | |
| `recommendation_type` | `recommendation_type` | |
| `linked_member_id` | `linked_member_id` | Load-bearing — see §4.3 |
| `structural_notes` | `structural_notes` jsonb | |
| `last_reviewed` | `last_reviewed` | |
| **`finances_page`** | **none** | **DROPPED** |

### 1.1 `finances_page` — dropped

Present in the legacy type (`committee.ts:54`) and populated in `woon.json`
(`https://woon.peaq.xyz/finances`). `swarm_subjects` has no column for it and no
generic metadata column.

Under the governing constraint this is dropped rather than accommodated. It is a
single URL on a single subject, re-addable later as a real column if a surface
ever needs it. Note that the v1 *manifest files* under
`frontend/public/data/swarm/manifests/subjects/` still carry it — the field is
lost only at the DB layer, on the day the site reads subjects from Postgres
instead of static JSON.

Columns with no legacy source: `version`, `updated_at` (defaults apply).

---

## 2. Members → `swarm_members`

Legacy type: `committee.ts:15-47`, plus fields present in the JSON but absent
from the type (`status`, `self_advocacy_prompt`).

| Legacy field | Column | Notes |
|---|---|---|
| `id` | `id` (PK) | |
| `status` | `status` | Legacy `active`; satisfies `CHECK` (`0017:130`) |
| `name` | `name` | |
| `tagline` | `tagline` | |
| `lens` | `lens` | |
| `mandate` | `mandate` | |
| `biases` | `biases` jsonb | |
| `mode` | `mode` | `pull` / `hybrid` in legacy data |
| `submit` | `submit` jsonb | `null` for all three legacy members |
| `operator` | `operator` | |
| `avatar` | `avatar` jsonb | |
| `voice_doc` → file contents | `voice_md` | Read the sibling `*.voice.md` and inline it |
| **`voice_samples`** | **none** | **DROPPED** — see §2.1 |
| **`stake`** | **none** | **DROPPED** — `null` on all three members; free |
| **`wallet`** | **none** | **DROPPED as redundant** — see §2.2 |
| **`self_advocacy_prompt`** | **none** | **DROPPED** — generator input, not display state |

Columns with no legacy source: `contact_email`, `key_hash`, `public_key`,
`applied_at`, `activated_at`, `version`, `updated_at`. The first three are
onboarding state that legacy pull-mode personas never had; see §4.

### 2.1 `voice_samples` — dropped

Two sample paragraphs per member, used as few-shot style anchors by the legacy
generator. The v1 model keeps a single `voice_md` column. Samples are prose that
belongs in the voice document; if they matter, append them to `*.voice.md`
before import so they land in `voice_md`. No column is added for them.

### 2.2 `wallet` — dropped as redundant, not as loss

Legacy `member.wallet.subject_id` is the exact inverse of
`subject.linked_member_id`, verified across the full dataset:

```
member.wallet.subject_id:      robotmoney → robotmoney-treasury,  woon → woon
subject.linked_member_id:      robotmoney-treasury → robotmoney,  woon → woon
```

The v1 model stores this edge once, on the subject. Importing it a second time
on the member would denormalize the clean model to match a legacy shape — the
exact thing this backport refuses to do. Any consumer that needs
member → subject resolves it with a reverse lookup on
`swarm_subjects.linked_member_id`.

---

## 3. Sessions → `swarm_sessions`

Legacy type: `committee.ts:122-150`.

| Legacy field | Column | Notes |
|---|---|---|
| `date` | **`date` is `GENERATED ALWAYS … STORED`** | **Cannot be inserted** — see §3.1 |
| `subject_id` | `subject_id` | FK → `swarm_subjects` — see §3.2 |
| `subject_name` | `subject_name` | |
| `regime_summary` | `regime_summary` jsonb | Whole object, including `history[]` |
| `subject_snapshot_total_value_usd` | `subject_snapshot_total_value_usd` | |
| `synthesis` | `synthesis` | |
| `committee_recommendation` | **`swarm_recommendation`** jsonb | Column renamed at `0025:39` |
| `social_draft_id` | `social_draft_id` | |
| `generated_at` | `generated_at` | |
| — | `state` | Must be set — see §3.3 |
| — | `convened_at` | Must be set — see §3.1 |

The recommendation blob survives whole as jsonb: `type`, `weights`,
`within_bucket_weights`, `rationale`, `consensus`, `disagreements` (with
`topic` / `positions[]` / `what_settles`), and `actions[]` for
`position_actions` subjects. No field-level mapping is required inside it.

### 3.1 `date` is a generated column

`0022_committee_session_convened_at.sql:44` rebuilt `date` as:

```sql
ADD COLUMN date date GENERATED ALWAYS AS (((convened_at AT TIME ZONE 'UTC')::date)) STORED
```

An insert that names `date` fails. The backfill sets `convened_at` and lets
`date` derive. The migration's own backfill establishes the convention:

```sql
UPDATE committee_sessions SET convened_at = date::timestamptz WHERE convened_at IS NULL;
```

— i.e. midnight UTC of the legacy date. Use exactly that, so imported sessions
file under the same day they have always been published under.

Identity is `UNIQUE (subject_id, convened_at)` (`0022:52`). Legacy has at most
one session per subject per date, so midnight-UTC `convened_at` is collision-free.
(Two sessions share `2026-06-21` — `robotmoney-allocation` and `woon` — but they
are different subjects, so the constraint is unaffected.)

### 3.2 Subject FK ordering

`swarm_sessions.subject_id` has a FK to `swarm_subjects` (`0017:174`). Subjects
must be imported before sessions. `0017:157` documents the established pattern
for orphans — insert an inactive placeholder subject for any unmatched id before
adding the constraint. The backfill should not need it if §1 runs first; if it
does, that is a signal the legacy set contains a subject the v1 manifests dropped,
and should fail loudly rather than auto-placeholder.

### 3.3 `state`

`CHECK (state IN ('scheduled','collecting','window_closed','aggregated','published','cancelled'))`
(`0017:152`). Historical legacy sessions are finished and public: import as
`'published'`.

Columns with no legacy source, left NULL: `brief_opens_at`, `publish_at`,
`window_closes_at`, `published_at`, `cancelled_at`. Legacy sessions had no
collection window — they were generated in one pass, not convened and collected.
This is a real semantic difference and NULL states it honestly.

---

## 4. Takes → `swarm_recommendations` — **the decision**

### 4.1 The mismatch

`committee_takes` — the table whose columns matched the legacy take shape
one-for-one — was **dropped** in `0006_committee_reconcile.sql:7` as a
"vestigial prototype remnant". The only surviving take store is
`swarm_recommendations`, described in `0001_backends.sql` as *"Append-only
signed recommendations (the canonical take store)"*:

```
nonce      text NOT NULL
payload    jsonb NOT NULL
signature  text NOT NULL
verified   boolean NOT NULL DEFAULT false
UNIQUE (session_id, member_id)
UNIQUE (member_id, nonce)
```

Legacy takes are LLM-generated prose. They have no nonce, no payload, and no
signature. Every legacy take violates three NOT NULL constraints.

The live insert path (`backend/src/swarm/domain.ts:448`) additionally verifies
the signature against the member's registered public key *before* inserting, and
gates the insert on `s.state = 'collecting'`. A backfill cannot use that path —
it writes directly.

### 4.2 Options considered

**A. Add an archive table or a `provenance`/`legacy` column.** Rejected: this
is precisely the pollution the constraint forbids. It would also fork every
read path into "signed takes" and "legacy takes" forever.

**B. Fabricate a signature value** (`'legacy'`, empty string, a hash). Rejected:
it satisfies NOT NULL by lying. The column's meaning is "this content was signed
by the member"; a placeholder makes that claim false for 96 rows and makes
`verified` unauditable.

**C. Genuinely sign the legacy takes at import time.** Recommended. Produce a
real canonical payload with `canonicalizeSubmission()`
(`contract/src/signing.js:5`) and a real signature, then set `verified`
according to whose key actually signed it. No schema change, no fabricated
values, and the honesty of each row is preserved in the `verified` flag.

**D. Do not import takes at all** — keep only sessions and synthesis.
Rejected: the takes are the substance. A session page with no member positions
is not a restored archive.

### 4.3 Recommended shape (option C)

For each legacy take, build the canonical submission:

```
memberId    = take.member_id
date        = session.date
subjectId   = session.subject_id
nonce       = "legacy-" + session.date + "-" + session.subject_id
stance      = take.stance
confidence  = take.confidence
body        = take.body
memoUrl     = ""
```

`nonce` is deterministic, making the whole import idempotent under
`UNIQUE (member_id, nonce)`: re-running cannot double-insert. Legacy has exactly
one take per member per session, so it is unique per member.

**Signing key, and what `verified` means.** Two of the three members
(`athena`, `robotmoney`) are operated by `robotmoney` — us. `woon` is operated by
`peaq`. Where we hold the member's key, sign with it and set `verified = true`;
the row then satisfies the same test as any live submission. Where we do not
(`woon`), sign with the operator's archival key and set **`verified = false`**.
That is the column doing its job: the content is durable and attributable, and
the flag states truthfully that it was not signed by the member. No schema change
is needed to express either case.

### 4.4 Take fields with no column

| Legacy field | Disposition |
|---|---|
| `member_name` | **Derivable.** Join `swarm_members.name` on `member_id`. |
| `mode` | **Derivable — verified.** `self_advocacy` iff `subject.linked_member_id == take.member_id`. Checked against all 96 archived takes across 32 sessions: **0 mismatches** (78 `pull`, 18 `self_advocacy`). Not a loss. |
| `model` | **DROPPED.** Constant `claude-opus-4-7` across all 96 takes. It is generator provenance, not part of the v1 submission protocol, which has no concept of the model behind a take. |
| `generated_at` | Maps to `received_at`. Semantically different — when the text was produced vs. when the server accepted it — but for a backfill of already-published takes it is the only honest timestamp available. |

`model` is the only genuine information loss in the entire take dataset, and it
is one constant string.

---

## 5. Snapshots → `swarm_subject_snapshots`

Lossless. `subject_id`, `date`, `total_value_usd`, `positions` jsonb, `wallets`
jsonb, `notable` jsonb, `UNIQUE (subject_id, date)`. Legacy files at
`public/data/committee/subjects/<id>/<date>.json` carry exactly these.

Framework subjects (`robotmoney-allocation`, `source.type == "framework"`) have
no snapshots by design and contribute no rows.

---

## 6. Briefs → `swarm_briefs`

Lossless. `date`, `subject_id`, `body` jsonb, `UNIQUE (date, subject_id)`.

---

## 7. Allocation framework → `allocation_framework`

Lossless. Singleton row (`id int PRIMARY KEY DEFAULT 1 CHECK (id = 1)`) with
`asof`, `vault_contract`, `buckets` jsonb. Already seeded from
`ALLOCATION_FRAMEWORK_SEED` (`backend/src/chain/allocation-framework.ts`,
inserted at `seed.ts:301`).

**Consistency check required.** The seeded framework and the legacy
`data/committee/allocation.json` must agree on bucket ids, names, item ids and
target weights, because imported sessions' `within_bucket_weights` reference
those item ids. If they disagree, imported allocation sessions will render
weights against buckets that do not match the framework. Diff them before
importing, and treat any difference as a bug in one of the two sources rather
than something to reconcile at import time.

---

## 8. Consequences for the rendered page

Two effects worth stating, both independent of this backport but visible the day
it lands:

1. **`finances_page` disappears from any DB-backed subject surface** (§1.1).
2. **`model` disappears** (§4.4) — no current surface displays it.

Separately, and *not* caused by the backport: the v1 session view does not read
`allocation_framework` at all, so bucket **Target**, **Gap**, and the
"deviates from target" indicator are absent regardless of what is imported.
That is a wiring gap in the session view, tracked separately from this document.

---

## 9. Verification performed for this analysis

- All 32 archived session files under `frontend/public/data/swarm/sessions/`
  parsed; 96 takes examined.
- `mode` derivation from `linked_member_id` checked against all 96 takes: 0
  mismatches.
- `model` distribution across all 96 takes: single value.
- `stake` / `wallet` values read from all three legacy member manifests.
- Legacy and v1 subject manifest key sets compared: identical, including
  `finances_page` (present in both file layers; absent only in the DB).
- Session recommendation payload shape read from
  `2026-06-24-robotmoney-allocation.json`: `type`, `weights`, `rationale`,
  `consensus`, `disagreements`, `within_bucket_weights` — no `buckets[]`.
