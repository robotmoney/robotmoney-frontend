-- Admin-uploaded avatar bytes, stored in the database rather than on
-- STATIC_DIR (issue #626, revised). scripts/static-assembly.sh wipes and
-- re-copies STATIC_DIR's contents on every `docker compose up`/redeploy, so a
-- file-on-disk upload does not survive a redeploy. Postgres does; this table
-- is the durable store, and the serving route reads straight out of it.
--
-- One row per member (PRIMARY KEY member_id), so a re-upload is a plain
-- UPSERT with no orphaned prior version to clean up. ON DELETE CASCADE: a
-- deleted member's uploaded image has no reason to outlive the row it was
-- for.
CREATE TABLE IF NOT EXISTS swarm_member_avatars (
  -- text, not uuid: swarm_members.id is text (migration 0033 minted new
  -- members' ids as UUID-shaped strings, but pre-existing members like
  -- "woon" keep their legacy handle-shaped id in the same column).
  member_id    text PRIMARY KEY REFERENCES swarm_members(id) ON DELETE CASCADE,
  content_type text NOT NULL,
  bytes        bytea NOT NULL,
  byte_size    integer NOT NULL,
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);
