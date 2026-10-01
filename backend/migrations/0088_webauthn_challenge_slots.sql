-- compat: breaking
-- metadata_version: 1
--
-- WebAuthn challenges become a fixed set of 32 slots — issue #1026, decision
-- D55 (6).
--
-- D55 (6), the first constraint on the delete redesign: "A table that
-- unauthenticated requests write stays bounded with no `rm_owner` run.
-- WebAuthn challenges use a fixed set of 32 slots. A new challenge overwrites
-- the oldest slot under `CHALLENGE_ISSUE_LOCK`, and a single-use conditional
-- `UPDATE` consumes it. Gate: more than 32 unauthenticated option requests
-- leave the row count at 32."
--
-- WHY THE SHAPE, NOT THE CODE, BOUNDS IT. `GET /api/admin/webauthn/auth/options`
-- is public: it must issue a challenge before the caller has a session. Until
-- now the table stayed bounded only because the route DELETEd expired rows and
-- trimmed past a cap of 32 — a runtime DELETE that D55 (6) forbids, and one
-- rm_app never held on a snapshot-built database (grants.sql never granted it),
-- so issuance failed 42501 there. With the DELETE gone, a table that grew by
-- one row per anonymous request would grow without bound until someone ran a
-- prune. So the bound moves into the schema:
--   * `slot` is the primary key and CHECKed to 0..31: a 33rd row cannot exist;
--   * the 32 rows are written here (and by backend/schema/bootstrap-data.sql on
--     a blank database) and never again: rm_app holds SELECT and UPDATE on the
--     table and no INSERT, so the runtime cannot add a row even by mistake;
--   * an empty slot holds NULL in every ceremony column, and the state CHECK
--     keeps a slot either wholly empty or wholly a ceremony;
--   * each flow has its own slots, fixed by a CHECK: 0..7 registration,
--     8..31 authentication. Authentication options are public, registration
--     options need an admin credential. In one shared pool some 32
--     unauthenticated requests inside the five-minute lifetime would evict a
--     signed-in admin's pending passkey enrolment; with the split a public flood
--     only ever overwrites authentication slots. Eight registration slots are
--     ample: an enrolment is one privileged operator's ceremony at a time.
-- Issuing a challenge (src/api/routes/admin-webauthn.ts storeChallenge)
-- overwrites the slot of its own flow with the oldest `issued_at` — an empty
-- one first, since NULL sorts first — in place, under CHALLENGE_ISSUE_LOCK. Consuming it is
-- `UPDATE ... SET consumed_at = now() WHERE ... AND consumed_at IS NULL AND
-- expires_at > now() RETURNING`, so a challenge is accepted at most once. A
-- consumed or expired slot needs no prune: the next issuance overwrites it.
--
-- WHY `breaking` (spec §8.4). Code built before this file issues
-- `INSERT INTO admin_webauthn_challenge (flow, challenge, expires_at)` and
-- DELETEs to consume, clean up and cap. After it the INSERT has no slot (and no
-- privilege) and the DELETE no privilege, so every passkey ceremony that code
-- runs fails. The label closes that rollback: code that ignores the slots can
-- never boot beside them.
--
-- THE ROWS IT REMOVES. Every row in the table is a pending ceremony with a
-- five-minute lifetime (CHALLENGE_TTL), and a `breaking` migration runs with
-- the stack down (spec §8.5: `bun smoke:down`, then `bun run migrate`), so no
-- ceremony is in flight. They are removed here, by rm_owner inside the migrate
-- run, which is the one place D55 (6) lets a row be removed; an operator whose
-- sign-in straddled the upgrade asks for a new challenge. Nothing else reads
-- them: a challenge carries no audit value (the sign-in itself is audit_log's
-- `login_passkey` row).
--
-- IDEMPOTENT ON RE-APPLY (tests/prod-baseline.test.ts re-applies the newest
-- migration): every step checks the state it moves from.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'admin_webauthn_challenge' AND column_name = 'slot'
  ) THEN
    DELETE FROM admin_webauthn_challenge;
    ALTER TABLE admin_webauthn_challenge DROP CONSTRAINT admin_webauthn_challenge_pkey;
    ALTER TABLE admin_webauthn_challenge
      ALTER COLUMN flow DROP NOT NULL,
      ALTER COLUMN challenge DROP NOT NULL,
      ALTER COLUMN expires_at DROP NOT NULL,
      ADD COLUMN slot smallint,
      ADD COLUMN issued_at timestamptz;
    INSERT INTO admin_webauthn_challenge (slot) SELECT s FROM generate_series(0, 31) AS s;
    ALTER TABLE admin_webauthn_challenge ALTER COLUMN slot SET NOT NULL;
    ALTER TABLE admin_webauthn_challenge ADD CONSTRAINT admin_webauthn_challenge_pkey PRIMARY KEY (slot);
    ALTER TABLE admin_webauthn_challenge ADD CONSTRAINT admin_webauthn_challenge_challenge_key UNIQUE (challenge);
    ALTER TABLE admin_webauthn_challenge
      ADD CONSTRAINT admin_webauthn_challenge_slot_check CHECK (slot >= 0 AND slot < 32);
    ALTER TABLE admin_webauthn_challenge
      ADD CONSTRAINT admin_webauthn_challenge_slot_state_check CHECK (
        (flow IS NULL AND challenge IS NULL AND issued_at IS NULL AND expires_at IS NULL AND consumed_at IS NULL)
        OR (flow IS NOT NULL AND challenge IS NOT NULL AND issued_at IS NOT NULL AND expires_at IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.admin_webauthn_challenge'::regclass AND conname = 'admin_webauthn_challenge_slot_flow_check'
  ) THEN
    ALTER TABLE admin_webauthn_challenge
      ADD CONSTRAINT admin_webauthn_challenge_slot_flow_check CHECK (
        flow IS NULL OR flow = CASE WHEN slot < 8 THEN 'registration' ELSE 'authentication' END
      );
  END IF;
END
$$;

-- The runtime overwrites and consumes slots; it never adds or removes one.
-- backend/schema/grants.sql re-asserts exactly this on every migrate run.
REVOKE INSERT, DELETE, TRUNCATE ON admin_webauthn_challenge FROM rm_app, rm_worker;
GRANT SELECT, UPDATE ON admin_webauthn_challenge TO rm_app;

COMMENT ON TABLE admin_webauthn_challenge IS
  'The 32 WebAuthn challenge slots (D55 (6)): 0..7 registration, 8..31 authentication. Issuing a challenge overwrites the slot of its flow with the oldest issued_at under CHALLENGE_ISSUE_LOCK; consuming it is a single-use conditional UPDATE of consumed_at. The runtime holds no INSERT or DELETE, so the table always has exactly 32 rows and needs no prune.';
COMMENT ON COLUMN admin_webauthn_challenge.slot IS
  'The slot number, 0..31. The primary key: there are exactly 32 slots, written by migration 0088 or the blank bootstrap. Slots 0..7 hold registration ceremonies and 8..31 authentication ones, so a public flood of sign-in options never evicts a pending enrolment.';
COMMENT ON COLUMN admin_webauthn_challenge.issued_at IS
  'When the ceremony in this slot was issued. The next issuance overwrites the slot with the oldest issued_at (an empty slot, NULL, first). NULL = empty slot.';
