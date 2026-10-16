-- compat: additive
-- metadata_version: 1
--
-- Revocation tombstones for the admin sessions and passkeys — issue #1026,
-- decision D55 (6).
--
-- D55 (6): "No runtime role (`rm_app`, `rm_worker`, `rm_readonly`) holds
-- `DELETE` or `TRUNCATE` on any table ... Security revocations stay
-- immediately effective. A revoked key, token or membership is refused on the
-- next request, because the revoking transaction writes the tombstone."
--
-- TODAY the password change and the recovery-code reset revoke every passkey
-- and every session by deleting them (`DELETE FROM admin_passkey` and
-- `DELETE FROM admin_session` in src/api/routes/admin.ts, in the same
-- transaction as the credential write). Under D55 (6) those statements become
-- `UPDATE ... SET revoked_at = now() WHERE revoked_at IS NULL` in that same
-- transaction, and every read that authenticates a session or a passkey
-- filters `revoked_at IS NULL`, so the revocation is as immediate as the
-- delete was. The code change lands in wave 5 (w5-owner-only-deletes) with the
-- migration that revokes rm_app's DELETE; this file only adds the columns it
-- writes.
--
-- ADDITIVE (spec §8.4): two nullable columns with no default. Every existing
-- row reads NULL, which means "not revoked" — exactly what it is today, since
-- a revoked row does not exist today. Code built before this file never names
-- the columns, so it keeps working: its INSERTs leave them NULL and its
-- DELETEs are unaffected.
--
-- GRANTS: none. rm_app already holds UPDATE on both tables (the ordinary sweep
-- in backend/schema/grants.sql grants it SELECT, INSERT, UPDATE on every
-- ordinary table, re-asserted on every migrate run), and a new column inherits
-- the table's privileges. No DELETE is granted anywhere.

ALTER TABLE admin_session ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE admin_passkey ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

COMMENT ON COLUMN admin_session.revoked_at IS
  'When this session was revoked (D55 (6)): set in the revoking transaction instead of deleting the row. Every session read filters revoked_at IS NULL, so a revoked session is refused on the next request. NULL = live.';
COMMENT ON COLUMN admin_passkey.revoked_at IS
  'When this passkey was revoked (D55 (6)): set in the revoking transaction instead of deleting the row. Every passkey read filters revoked_at IS NULL, so a revoked passkey is refused on the next ceremony. NULL = live.';
