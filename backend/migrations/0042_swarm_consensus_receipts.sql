-- The published consensus receipt (issue #754).
--
-- WHAT THIS TABLE IS. One row per session: the assembled Project Fusion
-- consensus receipt (schema 1.0, contract/src/__fixtures__/consensus-receipt.schema.json)
-- together with THE EXACT CANONICAL BYTES it canonicalizes to. Both are stored,
-- and storing both is the point: `robotmoney-core` anchors keccak256 over the
-- bytes, so the bytes — not a re-serialization of the jsonb — are the artifact.
-- Postgres does not preserve jsonb key order, so re-canonicalizing the stored
-- document is a RECOMPUTATION that has to agree with the stored string; it is
-- the read path's tamper check, never the source of the anchored bytes.
--
-- ONE RECEIPT PER SESSION PER SUBJECT, enforced by the primary key. A session
-- carries exactly one subject, so `session_id` is that key. It is the same
-- uniqueness the chain side gets from `receipt_id` =
-- keccak256("robotmoney:consensus-receipt-id:v1\n" + session_id + "\n" + subject_id),
-- stated here so a second receipt for a session cannot be written in the first
-- place rather than being rejected later by a contract nobody has called yet.
--
-- IMMUTABLE ONCE PUBLISHED, and that needs TWO different mechanisms. Migration
-- 0032's `rm_append_only_guard()` refuses DELETE and TRUNCATE; it does not
-- refuse UPDATE, and 0032's own header says so explicitly ("protects against
-- erasure, not modification"). For every other protected table that is the
-- right boundary — a take's `verified` flag is recomputed, a session's state
-- advances. Here it is not: the digest anchored on chain commits to these exact
-- bytes, so an UPDATE that changes them does not amend the receipt, it makes
-- the anchor point at something that no longer exists. So this table gets a
-- second trigger pair refusing UPDATE outright.
CREATE TABLE IF NOT EXISTS swarm_consensus_receipts (
  session_id      uuid PRIMARY KEY REFERENCES swarm_sessions(id),
  subject_id      text NOT NULL,
  -- Echoed out of the payload so a reader can select receipts by the schema
  -- version that governs them without parsing the jsonb. version_policy#selection:
  -- a verifier picks its schema by the receipt's OWN version, never by "latest".
  schema_version  text NOT NULL,
  -- The judgement the `judge` block was copied from. An append-only row
  -- (migrations 0039/0040) carrying prompt_hash + inputs_digest, so "this
  -- receipt says what that judge said over exactly those takes" is a join, not
  -- a claim.
  judgement_id    bigint NOT NULL REFERENCES swarm_session_judgements(id),
  -- THE SESSION REVISION THIS RECEIPT ATTESTS TO. `swarm_sessions.version` is
  -- bumped by every guarded state transition, so recording it makes a later
  -- divergence a DETECTABLE FACT rather than an invisible one: a receipt whose
  -- session has since moved is a row whose session_version no longer matches.
  -- Assembly refuses a session that is not already terminal (`published`), so
  -- today no such move is legal — this column is what keeps that checkable
  -- afterwards rather than merely argued about now.
  --
  -- THE PER-MEMBER TAKE REVISIONS ARE NOT HERE ON PURPOSE. They ride inside the
  -- signed payload, at receipt->'analyst_signatures'->N->>'revision', which is
  -- strictly stronger than a side column: the anchored digest covers them, and
  -- a stranger holding only the receipt can read them.
  session_version integer NOT NULL,
  receipt         jsonb NOT NULL,
  -- The canonical bytes, verbatim, INCLUDING the domain prefix and the trailing
  -- newline. `text` and not `bytea` because the canonicalization is UTF-8 by
  -- definition and Postgres stores this database's text as UTF-8; a bytea round
  -- trip would add an encoding step on every read for no additional guarantee.
  canonical_bytes text NOT NULL,
  published_at    timestamptz NOT NULL DEFAULT now(),
  -- The bytes must be the bytes of THIS document's version and THIS session.
  -- Cheap, and it catches the one class of write the code cannot: a row
  -- inserted by hand.
  CONSTRAINT swarm_consensus_receipts_bytes_prefix_check
    CHECK (canonical_bytes LIKE 'robotmoney:consensus-receipt:v1' || chr(10) || '%'),
  CONSTRAINT swarm_consensus_receipts_session_matches_check
    CHECK (receipt->>'session_id' = session_id::text AND receipt->>'subject_id' = subject_id
           AND receipt->>'schema_version' = schema_version)
);

CREATE INDEX IF NOT EXISTS swarm_consensus_receipts_subject_idx
  ON swarm_consensus_receipts (subject_id, published_at DESC);

-- ── Immutability: UPDATE is refused, not merely audited ─────────────────────
CREATE OR REPLACE FUNCTION rm_consensus_receipt_immutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION
    'swarm_consensus_receipts is immutable once published: % refused (issue #754). A consensus receipt''s canonical bytes are what an on-chain digest commits to; publish a corrected receipt under a new session rather than editing this one.',
    TG_OP
    USING ERRCODE = 'raise_exception';
END;
$fn$;

DROP TRIGGER IF EXISTS swarm_consensus_receipts_immutable ON swarm_consensus_receipts;
CREATE TRIGGER swarm_consensus_receipts_immutable
  BEFORE UPDATE ON swarm_consensus_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION rm_consensus_receipt_immutable();
ALTER TABLE swarm_consensus_receipts ENABLE ALWAYS TRIGGER swarm_consensus_receipts_immutable;

-- Row level too, for the same reason 0032 installs both: a statement-level
-- trigger never fires for an UPDATE with no statement behind it (a
-- logical-replication apply).
DROP TRIGGER IF EXISTS swarm_consensus_receipts_immutable_row ON swarm_consensus_receipts;
CREATE TRIGGER swarm_consensus_receipts_immutable_row
  BEFORE UPDATE ON swarm_consensus_receipts
  FOR EACH ROW EXECUTE FUNCTION rm_consensus_receipt_immutable();
ALTER TABLE swarm_consensus_receipts ENABLE ALWAYS TRIGGER swarm_consensus_receipts_immutable_row;

-- ── Append-only: DELETE and TRUNCATE are refused ────────────────────────────
-- Same shape as 0040, and the same reason a new migration rather than an edit
-- to 0032: an applied migration is a frozen artefact.
DO $$
DECLARE
  t text;
  protected text[] := ARRAY[
    'swarm_consensus_receipts'
  ];
BEGIN
  FOREACH t IN ARRAY protected LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'append-only guard: table % does not exist, skipping', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I ON %I', t || '_append_only', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION rm_append_only_guard()',
      t || '_append_only', t);
    EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER %I', t, t || '_append_only');

    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I ON %I', t || '_append_only_row', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION rm_append_only_guard()',
      t || '_append_only_row', t);
    EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER %I', t, t || '_append_only_row');
  END LOOP;
END;
$$;

COMMENT ON TABLE swarm_consensus_receipts IS
  'The published Project Fusion consensus receipt, one row per session (issue #754). Append-only via rm_append_only_guard() and additionally UPDATE-refusing via rm_consensus_receipt_immutable(): the canonical bytes are what an on-chain digest commits to.';

-- Least privilege for the restricted worker role, exactly as 0040 does for the
-- judgements table: the receipt is assembled in the api process over
-- src/db/client.ts's DATABASE_URL pool, never under rm_worker.
REVOKE INSERT, UPDATE, DELETE ON swarm_consensus_receipts FROM rm_worker;
