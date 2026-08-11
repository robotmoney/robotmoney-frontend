-- Separate immutable database identity, public handle, and display name.
-- Existing member id values remain stable for signed historical submissions and
-- existing foreign-key rows. Public routes should use handle after this point.

ALTER TABLE swarm_members
  ADD COLUMN IF NOT EXISTS member_uuid uuid DEFAULT gen_random_uuid();

UPDATE swarm_members
   SET member_uuid = gen_random_uuid()
 WHERE member_uuid IS NULL;

ALTER TABLE swarm_members
  ALTER COLUMN member_uuid SET NOT NULL;

ALTER TABLE swarm_members
  ADD COLUMN IF NOT EXISTS handle text;

UPDATE swarm_members
   SET handle = id
 WHERE handle IS NULL;

ALTER TABLE swarm_members
  ALTER COLUMN handle SET NOT NULL;

-- Compatibility for existing seed/test/manual insert paths: when a caller has
-- not yet supplied an explicit handle, retain its legacy id as the initial
-- handle. The admin CRUD can subsequently change it once.
CREATE OR REPLACE FUNCTION swarm_members_fill_handle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.handle IS NULL OR NEW.handle = '' THEN NEW.handle := NEW.id; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS swarm_members_fill_handle_trigger ON swarm_members;
CREATE TRIGGER swarm_members_fill_handle_trigger
BEFORE INSERT ON swarm_members
FOR EACH ROW EXECUTE FUNCTION swarm_members_fill_handle();

CREATE UNIQUE INDEX IF NOT EXISTS swarm_members_member_uuid_uq
  ON swarm_members (member_uuid);
CREATE UNIQUE INDEX IF NOT EXISTS swarm_members_handle_uq
  ON swarm_members (handle);

-- The historical id remains the signed/database identity. Only the public
-- handle changes for the curated Woon persona.
UPDATE swarm_members
   SET handle = 'noop-analyst', updated_at = now()
 WHERE id = 'woon'
   AND handle = 'woon';

-- Make the generated identity the primary key. Keep the legacy id unique so
-- existing member_id foreign keys and signed payload identities remain valid.
-- PostgreSQL will not drop a primary key while foreign keys depend on it, so
-- detach and immediately recreate the existing constraints without changing
-- their columns or delete behavior.
ALTER TABLE swarm_agent_health_events DROP CONSTRAINT IF EXISTS committee_agent_health_events_member_id_fkey;
ALTER TABLE swarm_claim_challenges DROP CONSTRAINT IF EXISTS committee_claim_challenges_member_id_fkey;
ALTER TABLE swarm_member_keys DROP CONSTRAINT IF EXISTS committee_member_keys_member_id_fkey;
ALTER TABLE swarm_memos DROP CONSTRAINT IF EXISTS committee_memos_member_id_fkey;
ALTER TABLE swarm_notification_outbox DROP CONSTRAINT IF EXISTS committee_notification_outbox_member_id_fkey;
ALTER TABLE swarm_recommendations DROP CONSTRAINT IF EXISTS committee_recommendations_member_id_fkey;
ALTER TABLE swarm_session_members DROP CONSTRAINT IF EXISTS committee_session_members_member_id_fkey;

ALTER TABLE swarm_members ADD CONSTRAINT swarm_members_id_uq UNIQUE (id);
ALTER TABLE swarm_members DROP CONSTRAINT IF EXISTS swarm_members_pkey;
ALTER TABLE swarm_members ADD CONSTRAINT swarm_members_pkey PRIMARY KEY (member_uuid);

ALTER TABLE swarm_agent_health_events
  ADD CONSTRAINT committee_agent_health_events_member_id_fkey
  FOREIGN KEY (member_id) REFERENCES swarm_members(id);
ALTER TABLE swarm_claim_challenges
  ADD CONSTRAINT committee_claim_challenges_member_id_fkey
  FOREIGN KEY (member_id) REFERENCES swarm_members(id) ON DELETE CASCADE;
ALTER TABLE swarm_member_keys
  ADD CONSTRAINT committee_member_keys_member_id_fkey
  FOREIGN KEY (member_id) REFERENCES swarm_members(id) ON DELETE CASCADE;
ALTER TABLE swarm_memos
  ADD CONSTRAINT committee_memos_member_id_fkey
  FOREIGN KEY (member_id) REFERENCES swarm_members(id);
ALTER TABLE swarm_notification_outbox
  ADD CONSTRAINT committee_notification_outbox_member_id_fkey
  FOREIGN KEY (member_id) REFERENCES swarm_members(id) ON DELETE CASCADE;
ALTER TABLE swarm_recommendations
  ADD CONSTRAINT committee_recommendations_member_id_fkey
  FOREIGN KEY (member_id) REFERENCES swarm_members(id);
ALTER TABLE swarm_session_members
  ADD CONSTRAINT committee_session_members_member_id_fkey
  FOREIGN KEY (member_id) REFERENCES swarm_members(id);
