-- Issue #597: make the database enforce the invariant 0030 only CLAIMED.
--
-- WHAT 0030 SAID vs WHAT IT DID. 0030 ends with the comment "a handle is a
-- public URL segment: it must address exactly one member" and then installs
-- `CREATE UNIQUE INDEX swarm_members_handle_key ON swarm_members (handle)`.
-- That index constrains handle against handle. It says nothing about the OTHER
-- half of the same sentence: `id` is a public URL segment too (getMember and
-- getMemberTakes both resolve `handle = $ref OR id = $ref`, which is what keeps
-- every pre-rename link alive), so a reference is ambiguous the moment one
-- member's handle equals a DIFFERENT member's id. Nothing in the schema
-- forbade that. The only thing that did was an application probe in
-- swarm/admin.ts, reading other rows unlocked at READ COMMITTED.
--
-- WHAT IT COSTS WHEN IT HAPPENS. With A(id='a1', handle='woon') and
-- B(id='woon', handle='b1'), /swarm/members/woon renders A's identity, name and
-- lens over takes that include B's — signed content attributed to the wrong
-- signer, on a page whose whole premise is verifiable attribution.
--
-- WHAT THIS DOES. A BEFORE INSERT OR UPDATE row trigger that refuses any row
-- which would make a public reference address two members, in EITHER direction:
--
--   * this row's handle equals another member's id  (the case 0030's index misses)
--   * this row's id     equals another member's handle
--
-- Both directions are needed. With only the first, the collision is still
-- creatable by writing A(handle='woon') first and B(id='woon') second: the
-- insert of B never looks at anyone else's handle. The check is symmetric so
-- that whichever row arrives second is the one refused.
--
-- SOURCE-ONLY, LIKE 0030. No row's `id`, no child table's `member_id`, and no
-- signed payload or signature byte is read or written here. The only DDL is a
-- function and a trigger on swarm_members.
--
-- WHAT THIS IS NOT. It is not atomic against a concurrent writer. The trigger
-- body is a plain SELECT at READ COMMITTED, so two transactions can each pass
-- their check against a snapshot that does not yet contain the other's
-- uncommitted row and both commit, producing exactly the pair this forbids.
-- Closing that window needs a lock ordered over the whole namespace (an
-- advisory lock keyed on the reference, or a single unique index over a union
-- of both names, which would mean writing a second table or a generated
-- column). What this trigger buys is that the invariant no longer depends on
-- one call site in swarm/admin.ts remembering to probe: every writer that goes
-- through an ordinary client session — a migration, an operator's manual
-- UPDATE, a future writer that names `handle` explicitly — is now refused by
-- the database. See issue #597.
--
-- WHAT A RESTORE IS AND IS NOT COVERED BY. `pg_restore --disable-triggers` and
-- a logical-replication apply worker both run under
-- `session_replication_role = replica`, which skips ORIGIN triggers entirely —
-- observed, not assumed: the forbidden pair installed with `INSERT 0 1` and no
-- refusal. The `ALTER TABLE ... ENABLE ALWAYS TRIGGER` at the bottom of this
-- file is what closes that, and it is why the trigger is created and then
-- altered rather than created enabled-always in one statement (there is no such
-- CREATE TRIGGER syntax).
--
-- It does NOT cover an ordinary full `pg_dump`/`pg_restore`: that emits
-- CREATE TRIGGER in the post-data section, so the COPY that loads the rows runs
-- before this trigger exists and no trigger state can help. Nor does the
-- pre-flight DO block below cover it — a dump taken from a post-0031 database
-- already carries this file's name in `schema_migrations`, so src/db/migrate.ts
-- skips it and the block never re-runs. The thing that catches a RESTORED
-- violation is therefore not in this file at all: the same detection query
-- lives in backend/scripts/db-preflight.ts, which runs on every external-pg
-- boot, before the boot's first write, and refuses one that is already in
-- violation. Keep the two queries in agreement.

-- ── Existing data ───────────────────────────────────────────────────────────
-- A trigger only inspects rows that are written after it exists, so a database
-- that ALREADY holds a colliding pair would deploy clean and then start
-- refusing unrelated edits to those rows, weeks later and far from the cause.
-- Fail here instead, loudly and with the offending pair named, so an operator
-- fixes it at deploy time. Repairing it automatically is NOT an option: the fix
-- is to change one of the two public names, and picking which one — and what to
-- change it to — silently repoints a published URL.
DO $$
DECLARE conflicts text;
BEGIN
  SELECT string_agg(
           format('member %L has handle %L, which is member %L''s id', a.id, a.handle, b.id),
           '; ' ORDER BY a.id)
    INTO conflicts
    FROM swarm_members a
    JOIN swarm_members b ON b.id = a.handle AND b.id <> a.id;
  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION
      'swarm_members already violates the handle/id namespace invariant, so migration 0031 cannot install it: %. Change one of the two public names (UPDATE swarm_members SET handle = ... ) and re-run.',
      conflicts;
  END IF;
END $$;

-- Both RAISEs below use 23505 WITH a constraint name, i.e. the same shape
-- swarm_members_handle_key raises, so swarm/domain.ts isHandleUniqueViolation
-- recognises it and the API answers 409 rather than 500. A distinct name
-- because this is a distinct rule, and an operator reading a log should be able
-- to tell which one refused the write — and each message names the OTHER member
-- id, because "which two rows" is the only question the log has to answer.
CREATE OR REPLACE FUNCTION swarm_members_assert_handle_namespace() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- Is this write PLACING an id? True on INSERT, and on the (never used by this
  -- application, but expressible) UPDATE that moves a primary key. See
  -- direction 2 for why the distinction is load-bearing.
  id_arrives boolean := true;
  colliding text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- An UPDATE that moves neither public name cannot create a collision, and
    -- must not be refused because of one that already exists on the row (see
    -- the deploy note above): status flips, version bumps and profile edits
    -- stay writable either way.
    IF NEW.handle IS NOT DISTINCT FROM OLD.handle
       AND NEW.id IS NOT DISTINCT FROM OLD.id THEN
      RETURN NEW;
    END IF;
    id_arrives := NEW.id IS DISTINCT FROM OLD.id;
  END IF;

  -- DIRECTION 1 — the handle this write places is already another member's id.
  -- Checked on every write that moves either name. This is the ONLY direction a
  -- handle-only rename can create: a forbidden pair exists exactly when some
  -- row's handle equals some other row's id, so the write that MOVES that
  -- handle is refused here, whichever of the two rows is written second and
  -- however many rows one UPDATE statement touches.
  SELECT m.id INTO colliding
    FROM swarm_members m
    WHERE m.id <> NEW.id AND m.id = NEW.handle
    LIMIT 1;
  IF colliding IS NOT NULL THEN
    RAISE EXCEPTION
      'handle % is already member %''s id, so it would address more than one swarm member',
      NEW.handle, colliding
      USING ERRCODE = '23505', CONSTRAINT = 'swarm_members_handle_namespace';
  END IF;

  -- DIRECTION 2 — the id this write places is already another member's handle.
  -- This is what makes the check symmetric on INSERT: without it, the pair is
  -- creatable by publishing A(handle='woon') first and inserting B(id='woon')
  -- second, because that INSERT never looks at anyone else's handle.
  --
  -- Gated on `id_arrives` deliberately. `NEW.id` does not move on a rename, and
  -- neither does any other row's handle, so on a handle-only UPDATE this clause
  -- can only ever report a collision the write did not create — the same reason
  -- the early return above exists. Ungated it froze the HIJACKED member out of
  -- the handle namespace entirely: with A(id='a1', handle='woon') and
  -- B(id='woon', handle='b1'), every rename B attempted was refused, including
  -- to names nobody held, and the admin surface reported that as
  -- "handle already taken" — false, and pointing at the wrong row. The repair
  -- is to move A's handle, and B's own edits must stay writable meanwhile.
  IF id_arrives THEN
    SELECT m.id INTO colliding
      FROM swarm_members m
      WHERE m.id <> NEW.id AND m.handle = NEW.id
      LIMIT 1;
    IF colliding IS NOT NULL THEN
      RAISE EXCEPTION
        'id % is already member %''s handle, so it would address more than one swarm member',
        NEW.id, colliding
        USING ERRCODE = '23505', CONSTRAINT = 'swarm_members_handle_namespace';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- NAME ORDER IS LOAD-BEARING. Postgres fires BEFORE row triggers in alphabetical
-- order by trigger name, and 0030's swarm_members_default_handle_trigger is the
-- one that fills in `NEW.handle := NEW.id` for the six writers that insert no
-- handle. 'swarm_members_d...' < 'swarm_members_h...', so the default runs first
-- and this check always sees the FINAL handle rather than a NULL. Asserted from
-- pg_trigger in tests/swarm-member-handle-namespace-migration.test.ts rather
-- than assumed.
DROP TRIGGER IF EXISTS swarm_members_handle_namespace_trigger ON swarm_members;
CREATE TRIGGER swarm_members_handle_namespace_trigger
BEFORE INSERT OR UPDATE ON swarm_members
FOR EACH ROW EXECUTE FUNCTION swarm_members_assert_handle_namespace();

-- ALWAYS, not the default ORIGIN. A trigger created the ordinary way has
-- pg_trigger.tgenabled = 'O' and is skipped whenever the session sets
-- `session_replication_role = replica` — which is precisely what
-- `pg_restore --disable-triggers` and a logical-replication apply worker do.
-- Observed on a real server before this line existed: the forbidden pair went
-- in with `INSERT 0 1` and no refusal. 'A' makes it fire under both roles.
-- Idempotent, so the runner may replay this file on any boot; and a
-- DISABLE/ENABLE cycle in a test must restore it with ENABLE ALWAYS, since a
-- plain ENABLE silently downgrades it back to 'O'.
ALTER TABLE swarm_members ENABLE ALWAYS TRIGGER swarm_members_handle_namespace_trigger;
