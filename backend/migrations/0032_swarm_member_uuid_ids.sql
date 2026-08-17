-- Every member id becomes a generated UUID.
--
-- WHY. `swarm_members.id` still holds human slugs for the members seeded or
-- imported before ids were generated ('athena', 'robotmoney', 'woon'), while
-- self-serve registration has always used crypto.randomUUID(). Two concrete
-- failures follow from the mixed namespace:
--
--   1. A slug id can never hold a matching handle. `handle = id` is migration
--      0030's "nobody chose a handle" sentinel, so a member whose correct
--      handle happens to equal its id reads as unset forever and is re-derived
--      on every acceptance. A UUID id is what makes a handle durable.
--
--   2. A slug id SQUATS the handle namespace. 0031 refuses a handle equal to
--      another member's id — correctly, since ids are public URL segments too.
--      With 'woon' sitting in the id column, the member actually NAMED Woon
--      cannot be given the handle `woon`; derivation avoids the collision and
--      hands it `woon-2` instead. That is the release's own objective failing
--      on production data.
--
-- WHAT THIS DOES. Re-identifies every member whose id is not already a UUID,
-- carrying all seven child foreign keys with it, and resets the handle of any
-- row still holding 0030's default so the handle backfill in seed() derives it
-- uniformly afterwards.
--
-- UPDATE ONLY — NOTHING IS DELETED. The obvious way to re-key a row is
-- insert-new / repoint-children / delete-old; this deliberately does not, both
-- because the historical tables are append-only and because copying a row
-- column-by-column silently drops any column added later.
--
-- SIGNATURES SURVIVE, and this is the property the whole migration rests on.
-- A take verifies as `payload` + `signature` against the public key reached
-- through `swarm_member_keys.member_id` — the id is never part of that check.
-- The signed bytes contain the HISTORICAL `memberId` (e.g. 'woon'), which is
-- correct provenance and is deliberately NOT rewritten: it records who authored
-- the take, and no private key exists to re-sign with. Verified empirically
-- against a restored production dump before this migration was written.
-- `swarm_member_keys` is in the FK list below for exactly this reason — miss it
-- and every take for the re-identified member reports unverified, with no error
-- anywhere.
--
-- FOREIGN KEYS. All seven are ON UPDATE NO ACTION, so neither order works with
-- immediate checking: updating the parent orphans the children, updating the
-- children references a parent that does not exist yet. They are therefore made
-- DEFERRABLE for the duration of this transaction and restored afterwards.
-- Their definitions (including the three ON DELETE CASCADEs) are never dropped
-- and re-added, so they cannot come back subtly different — #594's own test
-- asserts every FK name and definition is unchanged.

-- 1. Allow the parent and its children to move inside one transaction.
DO $$
DECLARE fk record;
BEGIN
  FOR fk IN
    SELECT conrelid::regclass::text AS tbl, conname
    FROM pg_constraint
    WHERE contype = 'f' AND confrelid = 'swarm_members'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE', fk.tbl, fk.conname);
  END LOOP;
END $$;

SET CONSTRAINTS ALL DEFERRED;

-- 2. One generated id per member that still has a slug. Recorded in a temp
--    table so every child update uses the SAME new id — calling
--    gen_random_uuid() per statement would scatter each member across tables.
CREATE TEMP TABLE member_id_remap ON COMMIT DROP AS
SELECT id AS old_id, gen_random_uuid()::text AS new_id
FROM swarm_members
WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- 3. The parent.
--
--    The handle moves to the new id ONLY when it was still 0030's untouched
--    default (handle = old id), which re-arms the "unset" sentinel so seed()'s
--    backfill derives it from the display name — one algorithm for everyone. A
--    handle somebody deliberately set is left exactly as it is (#562 decision
--    1: a chosen handle is a published URL and must not move unasked).
UPDATE swarm_members m
   SET id = r.new_id,
       handle = CASE WHEN m.handle = r.old_id THEN r.new_id ELSE m.handle END
  FROM member_id_remap r
 WHERE m.id = r.old_id;

-- 4. Every child. Listed explicitly rather than generated from pg_constraint:
--    a silent miss here is data loss by orphaning, so the set is auditable
--    against `\d swarm_members` rather than inferred at runtime.
UPDATE swarm_recommendations     c SET member_id = r.new_id FROM member_id_remap r WHERE c.member_id = r.old_id;
UPDATE swarm_memos               c SET member_id = r.new_id FROM member_id_remap r WHERE c.member_id = r.old_id;
UPDATE swarm_member_keys         c SET member_id = r.new_id FROM member_id_remap r WHERE c.member_id = r.old_id;
UPDATE swarm_session_members     c SET member_id = r.new_id FROM member_id_remap r WHERE c.member_id = r.old_id;
UPDATE swarm_agent_health_events c SET member_id = r.new_id FROM member_id_remap r WHERE c.member_id = r.old_id;
UPDATE swarm_claim_challenges    c SET member_id = r.new_id FROM member_id_remap r WHERE c.member_id = r.old_id;
UPDATE swarm_notification_outbox c SET member_id = r.new_id FROM member_id_remap r WHERE c.member_id = r.old_id;

-- 5. `swarm_subjects.linked_member_id` is NOT a foreign key (no constraint
--    references swarm_members from it), so it is invisible to step 1 and would
--    be left pointing at an id that no longer exists.
UPDATE swarm_subjects s
   SET linked_member_id = r.new_id
  FROM member_id_remap r
 WHERE s.linked_member_id = r.old_id;

-- 6. Force the deferred checks to run NOW, before touching the constraints
--    again. Without this, step 7's ALTER fails with "cannot ALTER TABLE ...
--    because it has pending trigger events": the checks are still queued for
--    commit time, and a constraint with pending events cannot be altered. This
--    is also the point where a missed child table would surface — as a loud FK
--    violation here rather than as silently orphaned rows.
SET CONSTRAINTS ALL IMMEDIATE;

-- 7. Restore the constraints' original strictness, so their definitions match
--    what they were before this migration ran.
DO $$
DECLARE fk record;
BEGIN
  FOR fk IN
    SELECT conrelid::regclass::text AS tbl, conname
    FROM pg_constraint
    WHERE contype = 'f' AND confrelid = 'swarm_members'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I NOT DEFERRABLE', fk.tbl, fk.conname);
  END LOOP;
END $$;
