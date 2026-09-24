-- compat: additive
-- metadata_version: 1
--
-- The API automation-token store — issue #1026 W4.5,
-- docs/technical/smoke-production-spec.md §3 and
-- docs/technical/system-scheduler-spec.md §7.
--
-- WHAT THE SPEC ASKS FOR, verbatim (smoke spec §3): "The token is issued by the
-- API's own automation-token store: a row holding the token's hash and its
-- rights (read subjects and sessions, perform lifecycle transitions), written
-- by the same authorized preparation that writes `deployment_identity`. The
-- API validates a presented token against that row; a file on disk establishes
-- nothing by itself ... Each instance holds its own token, so provisioning one
-- never invalidates another's. Rotation is a re-provision and a container
-- restart."
--
-- Every clause of that sentence is a column or a constraint here.
--
-- THE HASH, NEVER THE SECRET. `token_hash` is `sha256(token)` in lowercase hex
-- — the one hashing scheme this codebase already uses for every bearer
-- credential (`hashKey` in backend/src/lib/keys.ts, behind `admin_session`,
-- `admin_credential` and `swarm_member_keys`). A second scheme would mean a
-- second thing to get wrong, and this table is not more sensitive than the
-- admin credential beside it. The CHECK pins the shape so a caller cannot store
-- the plaintext here by mistake and have it silently work: a raw token would
-- have to be 64 lowercase hex characters to pass, and then it is a hash.
--
-- ONE ROW PER INSTANCE, and the instance name is the key. That is what makes
-- "provisioning one never invalidates another's" structural rather than a
-- convention: two CI instances write two rows, and neither statement can touch
-- the other. Rotation re-provisions the SAME instance, which replaces its one
-- row — the old hash is gone, so the old token stops validating, which is the
-- whole point of a rotation. `token_hash` is unique as well, so two instances
-- can never end up sharing one secret through a copy-paste.
--
-- RIGHTS ARE A SET, CONSTRAINED TO THE THREE THE SPEC NAMES. Not a boolean
-- `is_admin`, and not free text. `system-scheduler` holds exactly one
-- credential (scheduler spec §7) and that credential's authority is the whole
-- of what it may do; an unconstrained text array would let a typo
-- ('lifecycle_transition', singular) provision a token that authorizes nothing
-- and fails at 3am instead of at provisioning time.
--
-- WHAT THIS TABLE DOES NOT DO. It does not deliver the token. The boot places a
-- per-instance file in the instance's state directory (smoke spec §3/§5/§9.1),
-- and that is W1's work. This table is the other half of the pair, and it is
-- the half that decides: a file on disk that matches no row here authorizes
-- nothing at all.

CREATE TABLE IF NOT EXISTS automation_tokens (
  instance    text PRIMARY KEY,
  token_hash  text NOT NULL UNIQUE,
  rights      text[] NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL DEFAULT CURRENT_USER,
  note        text,
  CONSTRAINT automation_tokens_instance_check
    CHECK (instance ~ '^[a-z0-9][a-z0-9_-]{2,63}$'),
  CONSTRAINT automation_tokens_hash_shape_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT automation_tokens_rights_nonempty_check
    CHECK (cardinality(rights) > 0),
  CONSTRAINT automation_tokens_rights_known_check
    CHECK (rights <@ ARRAY['read_subjects', 'read_sessions', 'lifecycle_transitions']::text[])
);

-- The API reads this table on every authenticated automation request and never
-- writes it; provisioning is `rm_owner`'s, exactly like `deployment_identity`
-- (migration 0063), because it is part of authorized preparation rather than
-- part of serving traffic. REVOKE first: 0053 handed `rm_app` DELETE on ALL
-- TABLES, so a bare GRANT SELECT would leave the runtime role able to delete
-- its own credential store.
--
-- WHY EVERY READER ROLE KEEPS SELECT. `backend/tests/migration-0062-grants-
-- effective.test.ts` holds a standing invariant that every reader role can read
-- every table in `public`, and this table gives it no reason to make an
-- exception: a row is a sha256 hash and a rights list, never a secret, so
-- reading it is no wider a capability than reading `admin_credential` beside it.
-- What matters is that nobody but `rm_owner` may WRITE it, which is what the
-- REVOKE above and schema/grants.sql's reconciliation together guarantee.
REVOKE ALL ON automation_tokens FROM PUBLIC, rm_app, rm_worker, rm_readonly;
GRANT SELECT ON automation_tokens TO rm_app, rm_worker, rm_readonly;

COMMENT ON TABLE automation_tokens IS
  'API automation credentials: the hash of each instance''s bearer token and the rights it carries (smoke spec §3). The secret itself is never stored, and a token file on disk that matches no row here grants nothing.';
COMMENT ON COLUMN automation_tokens.instance IS
  'The deployment instance this token was provisioned for. One row per instance, so provisioning or rotating one never invalidates another''s.';
COMMENT ON COLUMN automation_tokens.rights IS
  'What the bearer may do: read_subjects, read_sessions, lifecycle_transitions. system-scheduler holds all three (scheduler spec §7).';
