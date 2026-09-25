-- compat: additive
-- metadata_version: 1
--
-- A consumption tombstone for WebAuthn challenges — issue #1026, decision
-- D55 (6).
--
-- TODAY src/api/routes/admin-webauthn.ts removes challenges three ways, each a
-- DELETE by rm_app: the single-use consume (`DELETE ... WHERE challenge = $1
-- AND flow = $2 AND expires_at > now() RETURNING`), the expired-row cleanup
-- before a new challenge is stored, and the cap trim that keeps the table
-- bounded. D55 (6) keeps each effect and removes the delete:
--   * the consume becomes a conditional
--     `UPDATE ... SET consumed_at = now() WHERE ... AND consumed_at IS NULL
--     RETURNING`, so a challenge is still accepted at most once — the second
--     consumer's UPDATE matches no row, exactly as its DELETE did;
--   * the cleanup and the cap become reads that filter expired and consumed
--     rows, with pruning left to an rm_owner run.
-- The code change lands in wave 5 (w5-owner-only-deletes); this file only adds
-- the column it writes.
--
-- ADDITIVE (spec §8.4): one nullable column with no default. Every existing
-- row reads NULL, "not consumed" — true of every row today, since a consumed
-- challenge is deleted. Code built before this file never names the column and
-- keeps working unchanged.
--
-- GRANTS: none. rm_app already holds UPDATE on the table (the ordinary sweep in
-- backend/schema/grants.sql). No DELETE is granted anywhere.

ALTER TABLE admin_webauthn_challenge ADD COLUMN consumed_at timestamptz;

COMMENT ON COLUMN admin_webauthn_challenge.consumed_at IS
  'When this challenge was consumed (D55 (6)): set by the single-use conditional UPDATE instead of deleting the row. A consumed or expired challenge is never accepted again. NULL = unconsumed.';
