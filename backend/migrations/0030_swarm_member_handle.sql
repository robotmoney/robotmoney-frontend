-- Issue #593: separate the immutable member identity from its PUBLIC handle.
--
-- WHY. `swarm_members.id` had been doing four jobs at once: primary key, the
-- target of every child table's `member_id` foreign key, the signing identity
-- embedded in already-signed `swarm_recommendations.payload` bytes, and the
-- public URL segment of /swarm/members/:id. The fourth job is the only one
-- anybody wants to change ('woon' → a new public name), and it was welded to
-- the three that must never move: rewriting the id would break child rows and
-- invalidate every historical signature made over a payload naming it.
--
-- WHAT THIS DOES. Adds a second, editable name. `id` keeps its PRIMARY KEY and
-- every meaning it already had; `handle` becomes the public one. Public routes
-- resolve either (swarm/domain.ts getMember/getMemberTakes), so no URL that has
-- ever been published stops working, and the admin edit surface writes only the
-- handle.
--
-- SOURCE-ONLY, DELIBERATELY. Every statement below names `swarm_members` and
-- nothing else: no child table is read or written, no foreign key is dropped or
-- recreated, no signed payload or signature byte is rewritten, and the primary
-- key does not move. That is the acceptance criterion, and it is asserted
-- against a genuine pre-0030 database in
-- tests/swarm-member-handle-migration.test.ts.

ALTER TABLE swarm_members ADD COLUMN IF NOT EXISTS handle text;

-- Backfill: every existing member's public handle IS its legacy id, so every
-- link ever published keeps addressing the same member with no redirect.
UPDATE swarm_members SET handle = id WHERE handle IS NULL;

ALTER TABLE swarm_members ALTER COLUMN handle SET NOT NULL;

-- Six writers INSERT into swarm_members with an explicit column list (apply,
-- claim, admin manual add, roster seed, the v0 archive backfill, demo/e2e) and
-- none of them has any business choosing a public handle. Rather than teach six
-- call sites to repeat `handle = id`, default it here: a row inserted without a
-- handle is published under its own id, which is the pre-0030 behaviour exactly.
-- A handle only ever diverges from the id when an administrator changes it.
CREATE OR REPLACE FUNCTION swarm_members_default_handle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.handle IS NULL OR NEW.handle = '' THEN NEW.handle := NEW.id; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS swarm_members_default_handle_trigger ON swarm_members;
CREATE TRIGGER swarm_members_default_handle_trigger
BEFORE INSERT ON swarm_members
FOR EACH ROW EXECUTE FUNCTION swarm_members_default_handle();

-- A handle is a public URL segment: it must address exactly one member. The id
-- keeps its own PRIMARY KEY, so a member stays reachable by BOTH names.
CREATE UNIQUE INDEX IF NOT EXISTS swarm_members_handle_key ON swarm_members (handle);
