# Pre-identity remote twin: the one-off intervention

> **Authority.** [D55](../decisions.md#d55) (10), Lucas's call of 2026-09-28,
> and [smoke production spec](../technical/smoke-production-spec.md) §4.2.
> A production dump from before migration 0081 cannot become a remote twin
> through any tool. This runbook is the one hand step that makes it one.

## When to use it

Use it only when all of these hold:

- You restored a production `pg_dump` into a **remote** Postgres database
  yourself, and you want to use that database as a twin.
- The dump predates 0081, so the restored database has no
  `deployment_identity` table.
- A stage tool refused the database and named this runbook.

Use `bun smoke --local dump` instead whenever a local twin will do
(smoke spec §5). It prepares the same dump with no hand step.

Never run it against production. Production takes its own first pass
(`bun run migrate` under `RM_ENV=prod`, smoke spec §9.1). This step writes
`rehearsal`, and `rehearsal` on the production database would disarm every
production guard.

## What it does

One transaction, run as `rm_owner` with the password typed at the terminal,
fenced on the target-lock key (smoke spec §2):

1. checks that the ledger equals the 76-name production baseline
   ([D55](../decisions.md#d55) (8));
2. applies `backend/migrations/0081_deployment_identity.sql`;
3. records `0081_deployment_identity.sql` in `schema_migrations`;
4. writes `deployment_identity.kind = 'rehearsal'`.

It commits all four or none. The psql session log is the receipt. Afterwards
the database is in the state the normal migrate path accepts (smoke spec
§9.1). A stage `bun run migrate` then applies the five files below 0081 and the
rest.

## Before you start

- Work from the repository root of the checkout you will rehearse.
- `rm_owner` can log in to the restored database, and you know its password.
  Do not write it to a file, an env var, `~/.pgpass` or a URL (D47).
- You have a **direct** connection to the database. Do not use a
  transaction-mode pooler, which breaks the session lock.
- No other tool is running against the database. The session lock below
  makes any that start wait or refuse.
- `psql`, `jq` and `sha256sum` are on your path.

## Steps

### 1. Name the target and open the receipt

Fill in the four target values and the instance name you will give the twin.
The receipt lives in the instance's state directory, outside the checkout
(smoke spec §1.1).

```bash
TWIN_HOST=...          # the restored database's host, never production's
TWIN_PORT=...
TWIN_DB=...
TWIN_INSTANCE=...      # the stage instance name for this twin
DUMP_FILE=...          # the dump you restored

STATE_ROOT="${RM_SMOKE_STATE_ROOT:-$HOME/.local/state/robotmoney-smoke}"
export RECEIPT_DIR="$STATE_ROOT/$TWIN_INSTANCE/one-off"
mkdir -p -m 700 "$RECEIPT_DIR"
RECEIPT="$RECEIPT_DIR/pre-identity-twin-$(date -u +%Y%m%dT%H%M%SZ).log"

{
  echo "D55 (10) one-off pre-identity remote twin intervention"
  echo "operator: $(whoami)@$(hostname)"
  echo "started:  $(date -u +%FT%TZ)"
  echo "target:   host=$TWIN_HOST port=$TWIN_PORT dbname=$TWIN_DB"
  echo "checkout: $(git rev-parse HEAD)"
  echo "dump:     $DUMP_FILE $(sha256sum "$DUMP_FILE" | cut -d' ' -f1)"
  echo "0081:     $(sha256sum backend/migrations/0081_deployment_identity.sql | cut -d' ' -f1)"
} >> "$RECEIPT"

jq -r '.ledger[].file' \
  backend/tests/fixtures/releases/production-2026-10-01/baseline.json \
  | LC_ALL=C sort > "$RECEIPT_DIR/baseline-ledger.txt"
wc -l < "$RECEIPT_DIR/baseline-ledger.txt"   # must print 76
```

### 2. Connect as `rm_owner`

`-W` makes psql prompt for the password. `-L` appends every query and its
result to the receipt.

```bash
psql "host=$TWIN_HOST port=$TWIN_PORT dbname=$TWIN_DB user=rm_owner sslmode=require" \
  -W -v ON_ERROR_STOP=1 -L "$RECEIPT"
```

### 3. Take the session lock and check the target

Run these in the psql session. The two numbers are the high and low halves of
`TARGET_LOCK_KEY` (`backend/src/db/target-lock.ts`), the key every tool takes.

```sql
SELECT current_user, current_database(), inet_server_addr(), inet_server_port(), now();

SELECT pg_try_advisory_lock(1798924, -1843443199) AS target_lock;
```

**Stop** unless `current_user` is `rm_owner`, the server is the twin you named,
and `target_lock` is `t`. An `f` means another tool holds the database.

```sql
SELECT to_regclass('public.deployment_identity') AS identity_table;
```

**Stop** unless `identity_table` is empty (null). A value means the dump is
from after 0081, and this runbook does not apply: smoke spec §4.2's remote
restore procedure does.

Save the ledger beside the receipt and compare it with the baseline:

```sql
\copy (SELECT name FROM schema_migrations ORDER BY name COLLATE "C") TO program 'cat > "$RECEIPT_DIR/twin-ledger.txt"'
\! LC_ALL=C diff -u "$RECEIPT_DIR/baseline-ledger.txt" "$RECEIPT_DIR/twin-ledger.txt" && echo LEDGER-MATCH
```

`$RECEIPT_DIR` resolves because psql inherited it from the shell that exported
it. **Stop** unless it prints `LEDGER-MATCH`. Any other ledger is a dump this
intervention does not support.

### 4. The one transaction

Paste this block as one piece. It stops short of `COMMIT` on purpose.

```sql
BEGIN;
SELECT pg_advisory_xact_lock(7726322199513601);

DO $$
BEGIN
  IF to_regclass('public.deployment_identity') IS NOT NULL THEN
    RAISE EXCEPTION 'deployment_identity exists: this is not a pre-0081 database';
  END IF;
  IF (SELECT count(*) FROM schema_migrations) <> 76 THEN
    RAISE EXCEPTION 'the ledger is not the 76-name production baseline';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0081_deployment_identity.sql') THEN
    RAISE EXCEPTION '0081 is already recorded';
  END IF;
END $$;

\i backend/migrations/0081_deployment_identity.sql

INSERT INTO schema_migrations (name) VALUES ('0081_deployment_identity.sql');

INSERT INTO deployment_identity (kind, note)
VALUES ('rehearsal', 'D55 (10) one-off pre-identity remote twin intervention');

SELECT kind, written_at, written_by, note FROM deployment_identity;
SELECT count(*) AS ledger_rows FROM schema_migrations;
```

If any statement failed, Postgres has aborted the transaction. Type
`ROLLBACK;`, and nothing has changed. Otherwise check that `kind` is
`rehearsal`, `written_by` is `rm_owner` and `ledger_rows` is `77`. Then type:

```sql
COMMIT;
```

If anything looks wrong, type `ROLLBACK;` instead.

### 5. Release the lock and close the receipt

```sql
SELECT pg_advisory_unlock(1798924, -1843443199);
\q
```

```bash
echo "finished: $(date -u +%FT%TZ)" >> "$RECEIPT"
chmod 600 "$RECEIPT"
```

Keep the receipt. It records the pre-identity state, the ledger match, the
0081 bytes and the committed row.

### 6. Finish with the normal path

Run this on the host whose `$HOME/.env` names this twin, never on a host
whose `$HOME/.env` names production. `bun run migrate` reads the target from
that file, and it prompts for `rm_owner` and a `y`.

```bash
RM_ENV=stage bun run migrate --instance "$TWIN_INSTANCE"
```

It applies `0056_swarm_judge_requires_model`, `0057_swarm_judge_policy_stamp`,
`0058_swarm_judge_fault_injection`, `0059_swarm_judgement_completion_usage`,
`0062_rm_worker_analytics_ledger_read_grant` and every later file, then
publishes the first manifest. Stage tools may connect only after it succeeds.

## If it is interrupted

- **Before `COMMIT`.** The transaction rolls back when the connection closes.
  The ledger is still the baseline, and there is still no table. Start again
  from step 2.
- **After `COMMIT`, before step 6.** The row and 0081 are in place. Do not
  repeat step 4, whose checks refuse. Go to step 6.
- **During step 6.** Rerun step 6. It resumes from the first unapplied
  migration (smoke spec §8.3).
