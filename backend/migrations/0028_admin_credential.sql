-- Claimed admin credential (issue #553 / D32).
--
-- At most one row (id = 1): the one-time claim is enforced by the primary key,
-- so a repeat/concurrent claim fails with a unique violation and the API maps
-- it to 409. Stores ONLY the sha256 hex of the claimed password (the same
-- hashKey() posture as swarm member access keys, backend/src/lib/keys.ts) —
-- never the plaintext. While this row exists, api/auth.ts's isPrivileged()
-- treats it as the durable operator credential: restarts stop rotating the
-- operator out, and RM_ALLOW_INSECURE no longer opens the admin gate.
--
-- Recovery from a lost claimed password is an explicit operator action against
-- the database (re-arms the first-boot one-time claim):
--   DELETE FROM admin_credential;
-- Forward-only and idempotent (safe when executed again by the migration test).
CREATE TABLE IF NOT EXISTS admin_credential (
  id         integer PRIMARY KEY CHECK (id = 1),
  pass_hash  text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now()
);

-- The queue worker role never checks admin auth. Without this, 0016's
-- ALTER DEFAULT PRIVILEGES would let a worker-role compromise read the
-- credential hash for offline cracking.
REVOKE ALL ON admin_credential FROM rm_worker;
