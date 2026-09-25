-- compat: breaking
-- metadata_version: 1
--
-- One counter row numbers the event stream — issue #1026 W4, criterion 93,
-- docs/technical/system-scheduler-spec.md §6.3 as amended on 2026-09-24 (D52).
--
-- §6.3: "Gapless, in commit order. Each event takes its number by incrementing
-- one counter row inside the transaction that makes the change. The row lock
-- serializes event-writing transactions, so numbers are assigned in commit
-- order and a rolled-back transaction leaves no hole ... The full read takes
-- its cursor from the counter value visible in its own snapshot."
--
-- WHY THE MAX + 1 SCHEME IT REPLACES IS NOT ENOUGH. 0068 numbered each event
-- as MAX(seq) + 1 under a transaction-scoped advisory lock. While the log is
-- never pruned the two are equivalent: the lock serializes writers exactly as a
-- row lock does, and a rolled-back insert leaves MAX unchanged. D52 lets
-- rm_owner prune rows below the oldest servable cursor (migration 0080), and
-- there the equivalence breaks: prune the newest row, or every row, and
-- MAX(seq) + 1 hands out a number some subscriber already holds as its cursor.
-- That subscriber then drops the new event as a duplicate — the silent skip
-- §6.3 forbids. A counter that only ever moves forward cannot do that.
--
-- THE ROW. `swarm_stream_head` holds one row, `seq` = the last number handed
-- out. `appendStreamEvent` (src/swarm/domain.ts) runs
-- `UPDATE swarm_stream_head SET seq = seq + 1 RETURNING seq` inside the
-- transition's own transaction: the row lock is held to COMMIT, so the next
-- writer blocks until this one's number is either visible or rolled back
-- (restoring the old value). The full read and the keepalive read the same row,
-- so a cursor is always "the last number committed".
--
-- SEEDED FROM THE LOG. The row starts at MAX(seq) of what is already there, so
-- every cursor issued before this migration stays valid and the next event
-- continues the numbering. The log is locked against writers while it is read,
-- so an event committed during the seeding cannot be counted twice or missed.
-- A blank bootstrap gets the same row, at 0, from backend/schema/
-- bootstrap-data.sql.
--
-- FORWARD ONLY. A trigger refuses any UPDATE that lowers `seq`, so no runtime
-- role can rewind the numbering either. There is no DELETE or TRUNCATE for the
-- runtime roles: the row is the stream's identity, not data.
--
-- WHY `breaking`. §8.4: additive means old code's supported behaviour is
-- preserved. Code built for 0068-0080 numbers events as MAX(seq) + 1 and never
-- touches this row. Run beside this code, the two schemes hand out the same
-- number — the old writer's MAX + 1 is the counter's next value — and one of
-- the two transitions fails on the primary key. Old code booted alone against
-- this database would number past the counter and leave it behind, so the
-- next new-code event would collide. Either way a code-only rollback past this
-- file is unsafe, and it is refused rather than discovered.

LOCK TABLE swarm_stream_events IN SHARE MODE;

CREATE TABLE IF NOT EXISTS swarm_stream_head (
  id  boolean PRIMARY KEY DEFAULT true,
  seq bigint NOT NULL,
  CONSTRAINT swarm_stream_head_singleton_check CHECK (id),
  CONSTRAINT swarm_stream_head_seq_check CHECK (seq >= 0)
);

INSERT INTO swarm_stream_head (id, seq)
SELECT true, COALESCE(MAX(seq), 0) FROM swarm_stream_events
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION rm_stream_head_forward_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.seq < OLD.seq THEN
    RAISE EXCEPTION 'swarm_stream_head only moves forward: % -> % refused', OLD.seq, NEW.seq
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS swarm_stream_head_forward_only ON swarm_stream_head;
CREATE TRIGGER swarm_stream_head_forward_only BEFORE UPDATE ON swarm_stream_head
  FOR EACH ROW EXECUTE FUNCTION rm_stream_head_forward_only();

-- Everything first, whoever runs this and whatever default privileges that
-- login carries (0016 set rm_worker DML defaults for the provisioning login),
-- then exactly the grants the row needs: rm_app numbers events, the rest read.
REVOKE ALL ON swarm_stream_head FROM PUBLIC, rm_app, rm_worker, rm_readonly;
GRANT SELECT, UPDATE ON swarm_stream_head TO rm_app;
GRANT SELECT ON swarm_stream_head TO rm_worker, rm_readonly;

COMMENT ON TABLE swarm_stream_head IS
  'The event stream''s one counter row (spec §6.3): seq is the last number handed out. Incremented by UPDATE ... RETURNING inside each event-writing transaction, so numbers are gapless and in commit order. Never moves back.';
COMMENT ON COLUMN swarm_stream_events.seq IS
  'Global monotonic sequence, gapless and in commit order: taken from swarm_stream_head inside the writing transaction, never from a sequence and never from MAX(seq) (migration 0081).';
